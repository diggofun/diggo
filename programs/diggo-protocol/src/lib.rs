use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer as SolTransfer};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::spl_token_2022::instruction::AuthorityType;
use anchor_spl::token_interface::{
    self, Mint, MintTo, SetAuthority, TokenAccount, TokenInterface, TransferChecked,
};

declare_id!("48WgfSPnEPitiasXV5B3aLpeAWtUisSt6YSR6djDZebC");

pub const BPS: u128 = 10_000;
pub const INDEX_SCALE: u128 = 1_000_000_000_000;
pub const DEFAULT_RESERVE_BPS: u16 = 500;
pub const DEFAULT_DISCOVERY_RESERVE_BPS: u16 = 50;
pub const DEFAULT_REDUCTION_BPS: u16 = 2_500;
pub const DEFAULT_BLOCK_INTERVAL: i64 = 300;
pub const DEFAULT_EPOCH_LENGTH: i64 = 604_800;
pub const MAX_NAME_LEN: usize = 32;
pub const MAX_SYMBOL_LEN: usize = 10;
pub const MAX_URI_LEN: usize = 200;
/// Per-call budget of the mining ledger walk, in segments. One segment is at most one run
/// of blocks plus at most one epoch rollover, so this is a hard compute bound per call.
/// A mine that is further behind than the budget allows is not stuck: every call persists
/// its progress in the mine's own cursors and the next call resumes from there.
pub const MAX_SYNC_SEGMENTS: usize = 64;
pub const STARTER_POWER: u64 = 100;

/// Default bound on the Crew Power the keeper may push for one player. The off-chain
/// curve tops out in the low thousands (see shared/crew.ts), so this sits above it and
/// only ever constrains a compromised keeper key — it is not an economic parameter.
pub const DEFAULT_MAX_CREW_POWER: u64 = 50_000;
/// Absolute ceiling for the guardian-configurable max_crew_power. Replaces the old,
/// effectively unbounded MAX_KEEPER_POWER = 10_000_000.
pub const MAX_CREW_POWER_HARD_CAP: u64 = 200_000;
/// Per-call power increase ceiling, in bps of the previous value (10_000 = at most
/// double), plus the always-allowed MIN_POWER_STEP.
pub const DEFAULT_MAX_POWER_INCREASE_BPS: u16 = 10_000;
pub const MAX_POWER_INCREASE_BPS: u16 = 10_000;
/// Always-allowed absolute step inside validate_power_update, so legitimate Crew
/// progression converges in a handful of keeper syncs instead of stalling.
pub const MIN_POWER_STEP: u64 = 1_000;

/// Hard cap on any single trading fee (creator or platform), in bps.
pub const MAX_TRADING_FEE_BPS: u16 = 100;
pub const DEFAULT_CREATOR_FEE_BPS: u16 = 50;
pub const DEFAULT_PLATFORM_FEE_BPS: u16 = 50;

/// Per-call discovery payout ceiling, in bps of a mine's total Discovery Reserve.
pub const DEFAULT_DISCOVERY_MAX_BPS: u16 = 100;
pub const MAX_DISCOVERY_MAX_BPS: u16 = 1_000;
/// Per-mine per-epoch discovery budget, in bps of the total Discovery Reserve.
pub const DEFAULT_DISCOVERY_EPOCH_BUDGET_BPS: u16 = 500;
pub const MAX_DISCOVERY_EPOCH_BUDGET_BPS: u16 = 2_000;

/// Seed prefix of the DiscoveryReceipt PDA: [b"discovery", mine, discovery_id].
pub const DISCOVERY_RECEIPT_SEED: &[u8] = b"discovery";

/// Layout version stamped into every migratable account. Accounts written before the
/// trailing version byte existed read as 0 and are upgraded in place by migrate_account.
pub const ACCOUNT_VERSION: u8 = 1;

/// Seed prefixes of the post-graduation liquidity pool and of its two vaults.
pub const POOL_SEED: &[u8] = b"pool";
pub const POOL_VAULT_SEED: &[u8] = b"pool-vault";
pub const POOL_SOL_SEED: &[u8] = b"pool-sol";

/// Account kinds accepted by migrate_account.
pub const ACCOUNT_KIND_PROTOCOL: u8 = 0;
pub const ACCOUNT_KIND_MINE: u8 = 1;
pub const ACCOUNT_KIND_MARKET: u8 = 2;

/// Byte offset of ProtocolConfig.guardian in the raw account data: the 8-byte
/// discriminator, then treasury, then keeper. The protocol account is the one account
/// whose own layout gates every other instruction — while it is still awaiting migration
/// it cannot be loaded as a typed Account<ProtocolConfig>, so migrate_account reads this
/// single field out of the raw bytes instead of trusting a deserialized struct. The
/// protocol_guardian_offset_matches_the_layout test pins it against the real layout.
pub const PROTOCOL_GUARDIAN_OFFSET: usize = 8 + 32 + 32;

#[program]
pub mod diggo_protocol {
    use super::*;

    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        treasury: Pubkey,
        keeper: Pubkey,
    ) -> Result<()> {
        require!(treasury != Pubkey::default(), DiggoError::InvalidTreasury);
        require!(keeper != Pubkey::default(), DiggoError::InvalidKeeper);
        let protocol = &mut ctx.accounts.protocol;
        protocol.treasury = treasury;
        protocol.keeper = keeper;
        // The deployer (program upgrade authority) is the initial circuit-breaker
        // guardian and can hand the role over with rotate_guardian.
        protocol.guardian = ctx.accounts.payer.key();
        protocol.reserve_bps = DEFAULT_RESERVE_BPS;
        protocol.discovery_reserve_bps = DEFAULT_DISCOVERY_RESERVE_BPS;
        protocol.creator_fee_bps = DEFAULT_CREATOR_FEE_BPS;
        protocol.platform_fee_bps = DEFAULT_PLATFORM_FEE_BPS;
        protocol.max_crew_power = DEFAULT_MAX_CREW_POWER;
        protocol.max_power_increase_bps = DEFAULT_MAX_POWER_INCREASE_BPS;
        protocol.discovery_max_bps = DEFAULT_DISCOVERY_MAX_BPS;
        protocol.discovery_epoch_budget_bps = DEFAULT_DISCOVERY_EPOCH_BUDGET_BPS;
        protocol.discovery_payouts_paused = false;
        protocol.reward_claims_paused = false;
        protocol.bump = ctx.bumps.protocol;
        protocol.version = ACCOUNT_VERSION;
        Ok(())
    }

    /// Rotates the backend keeper key without touching treasury, reserves or any
    /// player balance. Only the current keeper can hand off to a new one.
    pub fn rotate_keeper(ctx: Context<RotateKeeper>, new_keeper: Pubkey) -> Result<()> {
        require!(new_keeper != Pubkey::default(), DiggoError::InvalidKeeper);
        ctx.accounts.protocol.keeper = new_keeper;
        Ok(())
    }

    /// Hands the circuit-breaker role to another key. Only the current guardian may do
    /// this, and GuardianRotated keeps every hand-off auditable on-chain.
    pub fn rotate_guardian(ctx: Context<RotateGuardian>, new_guardian: Pubkey) -> Result<()> {
        require!(new_guardian != Pubkey::default(), DiggoError::InvalidGuardian);
        let protocol = &mut ctx.accounts.protocol;
        let previous_guardian = protocol.guardian;
        protocol.guardian = new_guardian;
        emit!(GuardianRotated {
            previous_guardian,
            guardian: new_guardian,
        });
        Ok(())
    }

    /// Protocol-wide circuit breaker (spec 65): stops every discovery payout while
    /// paused is true. Trading is untouched. The handler assigns one boolean and
    /// nothing else — its account set holds no mint, token account or vault, so no
    /// instruction built on it can ever move a reserve token.
    pub fn pause_discovery_payouts(ctx: Context<GuardianConfig>, paused: bool) -> Result<()> {
        let protocol = &mut ctx.accounts.protocol;
        set_discovery_payouts_paused(protocol, paused);
        emit!(PauseFlagsUpdated {
            guardian: protocol.guardian,
            discovery_payouts_paused: protocol.discovery_payouts_paused,
            reward_claims_paused: protocol.reward_claims_paused,
        });
        Ok(())
    }

    /// Protocol-wide circuit breaker (spec 65): stops every claim_rewards while paused
    /// is true. Trading is untouched.
    pub fn pause_reward_claims(ctx: Context<GuardianConfig>, paused: bool) -> Result<()> {
        let protocol = &mut ctx.accounts.protocol;
        set_reward_claims_paused(protocol, paused);
        emit!(PauseFlagsUpdated {
            guardian: protocol.guardian,
            discovery_payouts_paused: protocol.discovery_payouts_paused,
            reward_claims_paused: protocol.reward_claims_paused,
        });
        Ok(())
    }

    /// Circuit breaker scoped to a single mine's Discovery Reserve (spec 65).
    pub fn pause_mine_discovery(ctx: Context<GuardianMineConfig>, paused: bool) -> Result<()> {
        let mine = &mut ctx.accounts.mine;
        set_mine_discovery_paused(mine, paused);
        emit!(MineDiscoveryPauseUpdated {
            guardian: ctx.accounts.guardian.key(),
            mint: mine.mint,
            discovery_paused: mine.discovery_paused,
        });
        Ok(())
    }

    /// Sets the bounded keeper power rule: a ceiling on Crew Power the keeper may ever
    /// push, plus a per-call increase bound. Both are clamped to protocol constants, so
    /// neither can be configured away.
    pub fn update_power_bounds(
        ctx: Context<GuardianConfig>,
        max_crew_power: u64,
        max_power_increase_bps: u16,
    ) -> Result<()> {
        require!(
            max_crew_power > 0 && max_crew_power <= MAX_CREW_POWER_HARD_CAP,
            DiggoError::InvalidPowerBounds
        );
        require!(
            max_power_increase_bps > 0 && max_power_increase_bps <= MAX_POWER_INCREASE_BPS,
            DiggoError::InvalidPowerBounds
        );
        let protocol = &mut ctx.accounts.protocol;
        protocol.max_crew_power = max_crew_power;
        protocol.max_power_increase_bps = max_power_increase_bps;
        emit!(PowerBoundsUpdated {
            guardian: protocol.guardian,
            max_crew_power,
            max_power_increase_bps,
        });
        Ok(())
    }

    /// Sets the default trading fee schedule. Existing markets keep the schedule they
    /// snapshotted at launch, so a change here can never retroactively alter a live
    /// market, and both fees stay capped at MAX_TRADING_FEE_BPS.
    pub fn update_fee_config(
        ctx: Context<GuardianConfig>,
        creator_fee_bps: u16,
        platform_fee_bps: u16,
    ) -> Result<()> {
        require!(
            creator_fee_bps <= MAX_TRADING_FEE_BPS && platform_fee_bps <= MAX_TRADING_FEE_BPS,
            DiggoError::FeeTooHigh
        );
        let protocol = &mut ctx.accounts.protocol;
        protocol.creator_fee_bps = creator_fee_bps;
        protocol.platform_fee_bps = platform_fee_bps;
        emit!(FeeConfigUpdated {
            guardian: protocol.guardian,
            creator_fee_bps,
            platform_fee_bps,
        });
        Ok(())
    }

    /// Tunes the discovery spend limits used by mines launched from now on. Existing
    /// mines keep the budget they snapshotted at launch; the guardian can always stop
    /// them outright with pause_mine_discovery.
    pub fn update_discovery_limits(
        ctx: Context<GuardianConfig>,
        discovery_max_bps: u16,
        discovery_epoch_budget_bps: u16,
    ) -> Result<()> {
        require!(
            discovery_max_bps > 0 && discovery_max_bps <= MAX_DISCOVERY_MAX_BPS,
            DiggoError::DiscoveryLimitsOutOfRange
        );
        require!(
            discovery_epoch_budget_bps > 0
                && discovery_epoch_budget_bps <= MAX_DISCOVERY_EPOCH_BUDGET_BPS,
            DiggoError::DiscoveryLimitsOutOfRange
        );
        require!(
            discovery_max_bps <= discovery_epoch_budget_bps,
            DiggoError::DiscoveryLimitsOutOfRange
        );
        let protocol = &mut ctx.accounts.protocol;
        protocol.discovery_max_bps = discovery_max_bps;
        protocol.discovery_epoch_budget_bps = discovery_epoch_budget_bps;
        emit!(DiscoveryLimitsUpdated {
            guardian: protocol.guardian,
            discovery_max_bps,
            discovery_epoch_budget_bps,
        });
        Ok(())
    }

    /// Guardian-only layout upgrade for one program-owned config, mine or market account.
    ///
    /// It reallocates the account to the current size and stamps the trailing version
    /// byte; every byte that already existed is copied verbatim, so no balance, reserve,
    /// fee bucket or timestamp can move. The account must already hold enough lamports for
    /// its new rent-exempt minimum — top it up with a plain system transfer first, because
    /// this instruction deliberately never touches lamports at all.
    pub fn migrate_account(ctx: Context<MigrateAccount>, kind: u8) -> Result<()> {
        let (discriminator, new_len) = account_layout(kind)?;
        // Guardian-only, and read out of the raw protocol bytes rather than deserialized: the
        // protocol account is the one account that may itself be awaiting migration, so it
        // cannot be loaded as a typed Account<ProtocolConfig> while it is still short.
        {
            let protocol = ctx.accounts.protocol.to_account_info();
            let data = protocol.try_borrow_data()?;
            require!(
                guardian_from_raw_protocol(&data)? == ctx.accounts.guardian.key(),
                DiggoError::InvalidGuardian
            );
        }
        let target = ctx.accounts.target.to_account_info();
        require!(target.owner == &crate::ID, DiggoError::InvalidAccountLayout);
        let old_len = target.data_len();
        require!(old_len >= 8, DiggoError::InvalidAccountLayout);
        {
            let data = target.try_borrow_data()?;
            require!(&data[..8] == discriminator, DiggoError::InvalidAccountLayout);
        }
        require!(old_len < new_len, DiggoError::AccountAlreadyCurrent);
        require!(
            target.lamports() >= Rent::get()?.minimum_balance(new_len),
            DiggoError::MigrationNeedsFunding
        );

        // Snapshot the old payload, reallocate, then rewrite the whole buffer from the tested
        // transform: the account's own values re-serialized, with only the appended version
        // byte new and the tail beyond the payload zero-filled.
        let snapshot = target.try_borrow_data()?.to_vec();
        // resize zero-extends the account in place, which is exactly the append-only shape
        // this migration needs.
        target.resize(new_len)?;
        let upgraded = upgraded_account_data(kind, &snapshot, new_len)?;
        target.try_borrow_mut_data()?.copy_from_slice(&upgraded);

        emit!(AccountMigrated {
            account: target.key(),
            kind,
            from_len: old_len as u32,
            to_len: new_len as u32,
            version: ACCOUNT_VERSION,
        });
        Ok(())
    }

    pub fn launch_token(ctx: Context<LaunchToken>, args: LaunchTokenArgs) -> Result<()> {
        validate_launch_args(&args, &ctx.accounts.protocol)?;

        let reserve_amount = mul_bps(args.total_supply, args.reserve_bps)?;
        let discovery_amount = mul_bps(args.total_supply, args.discovery_reserve_bps)?;
        let market_amount = args
            .total_supply
            .checked_sub(reserve_amount)
            .and_then(|value| value.checked_sub(discovery_amount))
            .ok_or(DiggoError::MathOverflow)?;
        // The mint is a PDA derived from (creator, nonce), so its address cannot be
        // ground for a vanity suffix — hitting 5 fixed base58 characters is ~1 in 656M.
        // Vanity mints need the pump.fun approach (mint as an off-chain ground keypair
        // passed in as a signer), which is a separate change.
        let mint_key = ctx.accounts.mint.key();
        let mine_bump = ctx.bumps.mine;
        let signer_seeds: &[&[&[u8]]] = &[&[b"mine", mint_key.as_ref(), &[mine_bump]]];

        mint_to(
            &ctx.accounts.token_program,
            &ctx.accounts.mint,
            &ctx.accounts.market_vault,
            &ctx.accounts.mine,
            signer_seeds,
            market_amount,
        )?;
        mint_to(
            &ctx.accounts.token_program,
            &ctx.accounts.mint,
            &ctx.accounts.reserve_vault,
            &ctx.accounts.mine,
            signer_seeds,
            reserve_amount,
        )?;
        mint_to(
            &ctx.accounts.token_program,
            &ctx.accounts.mint,
            &ctx.accounts.discovery_vault,
            &ctx.accounts.mine,
            signer_seeds,
            discovery_amount,
        )?;

        revoke_authority(
            &ctx.accounts.token_program,
            &ctx.accounts.mint,
            &ctx.accounts.mine,
            signer_seeds,
            AuthorityType::MintTokens,
        )?;
        revoke_authority(
            &ctx.accounts.token_program,
            &ctx.accounts.mint,
            &ctx.accounts.mine,
            signer_seeds,
            AuthorityType::FreezeAccount,
        )?;

        let now = Clock::get()?.unix_timestamp;
        let mine = &mut ctx.accounts.mine;
        mine.mint = mint_key;
        mine.creator = ctx.accounts.creator.key();
        mine.reserve_vault = ctx.accounts.reserve_vault.key();
        mine.discovery_vault = ctx.accounts.discovery_vault.key();
        mine.market_vault = ctx.accounts.market_vault.key();
        mine.fee_vault = ctx.accounts.fee_vault.key();
        mine.total_supply = args.total_supply;
        mine.remaining_reserve = reserve_amount;
        mine.remaining_discovery_reserve = discovery_amount;
        mine.cumulative_distributed = 0;
        mine.total_power = 0;
        mine.reward_index = 0;
        mine.current_block_reward = args.initial_block_reward;
        mine.block_interval = args.block_interval;
        mine.next_block_at = now
            .checked_add(args.block_interval)
            .ok_or(DiggoError::MathOverflow)?;
        mine.epoch = 0;
        mine.epoch_length = args.epoch_length;
        mine.epoch_ends_at = now
            .checked_add(args.epoch_length)
            .ok_or(DiggoError::MathOverflow)?;
        mine.reduction_bps = args.reduction_bps;
        mine.minimum_reward = args.minimum_reward;
        mine.status = MineStatus::Launching;
        mine.name = args.name;
        mine.symbol = args.symbol;
        mine.uri = args.uri;
        // Discovery spend limits are measured against the reserve as allocated, so they
        // stay stable as it drains, and are snapshotted per mine at launch.
        mine.discovery_reserve_total = discovery_amount;
        mine.discovery_epoch_budget = mul_bps(
            discovery_amount,
            ctx.accounts.protocol.discovery_epoch_budget_bps,
        )?;
        mine.discovery_epoch_spent = 0;
        mine.discovery_epoch_ends_at = mine.epoch_ends_at;
        mine.discovery_paused = false;
        mine.bump = mine_bump;
        mine.version = ACCOUNT_VERSION;

        let market = &mut ctx.accounts.market;
        market.mine = mine.key();
        market.token_reserve = market_amount;
        market.sol_reserve = 0;
        market.virtual_sol_reserve = args.virtual_sol_reserve;
        market.graduation_target = args.graduation_target;
        market.graduated = false;
        market.creator_fee_claimable = 0;
        market.platform_fee_claimable = 0;
        market.creator_fee_bps = ctx.accounts.protocol.creator_fee_bps;
        market.platform_fee_bps = ctx.accounts.protocol.platform_fee_bps;
        market.bump = ctx.bumps.market;
        market.version = ACCOUNT_VERSION;

        emit!(TokenLaunched {
            mint: mint_key,
            creator: mine.creator,
            total_supply: args.total_supply,
            mining_reserve: reserve_amount,
            discovery_reserve: discovery_amount,
            market_supply: market_amount,
        });
        Ok(())
    }

    /// Trading is deliberately outside every circuit breaker: this instruction never
    /// reads a pause flag, so pausing discoveries or claims can never stop the market.
    pub fn buy(ctx: Context<Buy>, sol_in: u64, min_tokens_out: u64) -> Result<()> {
        require!(sol_in > 0, DiggoError::InvalidAmount);
        // Once a market has graduated its curve reserves are zero and the liquidity lives
        // in the pool, so the curve is closed. pool_buy is the post-graduation venue.
        require!(!ctx.accounts.market.graduated, DiggoError::MarketGraduated);
        // Explicit fees come off the top of the gross SOL: the curve only ever sees the
        // net input, and the two fee buckets are credited in the same step.
        let (net_sol, creator_fee, platform_fee) = net_after_fees(
            sol_in,
            ctx.accounts.market.creator_fee_bps,
            ctx.accounts.market.platform_fee_bps,
        )?;
        require!(net_sol > 0, DiggoError::InvalidAmount);
        let tokens_out = quote_buy(
            ctx.accounts.market.token_reserve,
            ctx.accounts.market.sol_reserve,
            ctx.accounts.market.virtual_sol_reserve,
            net_sol,
        )?;
        require!(
            tokens_out >= min_tokens_out && tokens_out > 0,
            DiggoError::SlippageExceeded
        );

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                SolTransfer {
                    from: ctx.accounts.buyer.to_account_info(),
                    to: ctx.accounts.market.to_account_info(),
                },
            ),
            sol_in,
        )?;

        transfer_from_mine(
            &ctx.accounts.token_program,
            &ctx.accounts.mint,
            &ctx.accounts.market_vault,
            &ctx.accounts.buyer_tokens,
            &ctx.accounts.mine,
            tokens_out,
        )?;

        let market = &mut ctx.accounts.market;
        market.sol_reserve = market
            .sol_reserve
            .checked_add(net_sol)
            .ok_or(DiggoError::MathOverflow)?;
        market.token_reserve = market
            .token_reserve
            .checked_sub(tokens_out)
            .ok_or(DiggoError::MathOverflow)?;
        accrue_fees(market, creator_fee, platform_fee)?;
        // Graduation is deliberately not decided here. A market that has reached its
        // target keeps trading on the curve until graduate_market atomically creates the
        // pool and moves the reserves into it; flipping the flag on its own would strand
        // the market between two venues with the liquidity in neither.
        emit!(TradeExecuted {
            mint: ctx.accounts.mint.key(),
            trader: ctx.accounts.buyer.key(),
            side: 0,
            token_amount: tokens_out,
            sol_amount: sol_in,
            creator_fee,
            platform_fee,
        });
        Ok(())
    }

    /// Trading is deliberately outside every circuit breaker: like buy, this never
    /// reads a pause flag.
    pub fn sell(ctx: Context<Sell>, tokens_in: u64, min_sol_out: u64) -> Result<()> {
        require!(tokens_in > 0, DiggoError::InvalidAmount);
        // See buy: a graduated market trades through pool_sell only.
        require!(!ctx.accounts.market.graduated, DiggoError::MarketGraduated);
        let gross_sol = quote_sell(
            ctx.accounts.market.token_reserve,
            ctx.accounts.market.sol_reserve,
            ctx.accounts.market.virtual_sol_reserve,
            tokens_in,
        )?;
        require!(gross_sol > 0, DiggoError::SlippageExceeded);
        require!(
            gross_sol <= ctx.accounts.market.sol_reserve,
            DiggoError::InsufficientLiquidity
        );
        // The seller receives the gross curve output minus the explicit fees; the curve
        // reserve is debited by the gross amount in the same step.
        let (sol_out, creator_fee, platform_fee) = net_after_fees(
            gross_sol,
            ctx.accounts.market.creator_fee_bps,
            ctx.accounts.market.platform_fee_bps,
        )?;
        require!(sol_out >= min_sol_out, DiggoError::SlippageExceeded);

        transfer_from_user(
            &ctx.accounts.token_program,
            &ctx.accounts.mint,
            &ctx.accounts.seller_tokens,
            &ctx.accounts.market_vault,
            &ctx.accounts.seller,
            tokens_in,
        )?;

        let market_info = ctx.accounts.market.to_account_info();
        let seller_info = ctx.accounts.seller.to_account_info();
        let rent_floor = Rent::get()?.minimum_balance(market_info.data_len());
        let available = market_info.lamports().saturating_sub(rent_floor);
        // Defensive: the market must still hold its rent floor, the whole curve reserve
        // and both fee buckets after the seller's net proceeds leave.
        let fees_after = ctx
            .accounts
            .market
            .creator_fee_claimable
            .checked_add(ctx.accounts.market.platform_fee_claimable)
            .and_then(|value| value.checked_add(creator_fee))
            .and_then(|value| value.checked_add(platform_fee))
            .ok_or(DiggoError::MathOverflow)?;
        require!(
            available >= sol_out.checked_add(fees_after).ok_or(DiggoError::MathOverflow)?,
            DiggoError::InsufficientLiquidity
        );
        **market_info.try_borrow_mut_lamports()? = market_info
            .lamports()
            .checked_sub(sol_out)
            .ok_or(DiggoError::MathOverflow)?;
        **seller_info.try_borrow_mut_lamports()? = seller_info
            .lamports()
            .checked_add(sol_out)
            .ok_or(DiggoError::MathOverflow)?;

        let market = &mut ctx.accounts.market;
        market.sol_reserve = market
            .sol_reserve
            .checked_sub(gross_sol)
            .ok_or(DiggoError::MathOverflow)?;
        market.token_reserve = market
            .token_reserve
            .checked_add(tokens_in)
            .ok_or(DiggoError::MathOverflow)?;
        accrue_fees(market, creator_fee, platform_fee)?;
        emit!(TradeExecuted {
            mint: ctx.accounts.mint.key(),
            trader: ctx.accounts.seller.key(),
            side: 1,
            token_amount: tokens_in,
            sol_amount: sol_out,
            creator_fee,
            platform_fee,
        });
        Ok(())
    }

    /// Moves a graduated market's entire curve liquidity into the program-owned
    /// constant-product pool (spec 36). Permissionless on purpose: once a market has
    /// genuinely reached its graduation target, anyone may pay for the pool accounts.
    ///
    /// The pool is created here and only here. It mints no LP token, its token vault is
    /// owned by the pool PDA, and no instruction anywhere can take its liquidity back out
    /// again — see apply_pool_swap. After this call the market holds nothing but accrued
    /// fees and every trade routes through the pool.
    pub fn graduate_market(ctx: Context<GraduateMarket>) -> Result<()> {
        let plan = plan_graduation(&ctx.accounts.market)?;
        let mine_key = ctx.accounts.mine.key();
        let mint_key = ctx.accounts.mint.key();

        // Tokens first: exactly the market's curve reserve, base unit for base unit.
        transfer_from_mine(
            &ctx.accounts.token_program,
            &ctx.accounts.mint,
            &ctx.accounts.market_vault,
            &ctx.accounts.pool_token_vault,
            &ctx.accounts.mine,
            plan.tokens,
        )?;

        // Then the SOL side: exactly the market's curve reserve, leaving behind both the
        // rent floor and every accrued fee lamport.
        {
            let market_info = ctx.accounts.market.to_account_info();
            let pool_sol_info = ctx.accounts.pool_sol_vault.to_account_info();
            let rent_floor = Rent::get()?.minimum_balance(market_info.data_len());
            let fees = ctx
                .accounts
                .market
                .creator_fee_claimable
                .checked_add(ctx.accounts.market.platform_fee_claimable)
                .ok_or(DiggoError::MathOverflow)?;
            require!(
                market_info.lamports().saturating_sub(rent_floor)
                    >= plan.sol.saturating_add(fees),
                DiggoError::InsufficientLiquidity
            );
            **market_info.try_borrow_mut_lamports()? = market_info
                .lamports()
                .checked_sub(plan.sol)
                .ok_or(DiggoError::MathOverflow)?;
            **pool_sol_info.try_borrow_mut_lamports()? = pool_sol_info
                .lamports()
                .checked_add(plan.sol)
                .ok_or(DiggoError::MathOverflow)?;
        }

        let pool_key = ctx.accounts.pool.key();
        let pool_bump = ctx.bumps.pool;
        let pool_token_vault_key = ctx.accounts.pool_token_vault.key();
        let pool_sol_vault_key = ctx.accounts.pool_sol_vault.key();
        let sol_vault_bump = ctx.bumps.pool_sol_vault;
        let graduated_at = Clock::get()?.unix_timestamp;

        let pool = &mut ctx.accounts.pool;
        pool.mine = mine_key;
        pool.mint = mint_key;
        pool.token_vault = pool_token_vault_key;
        pool.sol_vault = pool_sol_vault_key;
        pool.graduated_at = graduated_at;
        pool.bump = pool_bump;
        apply_graduation(&mut ctx.accounts.market, pool, plan)?;

        let sol_vault = &mut ctx.accounts.pool_sol_vault;
        sol_vault.pool = pool_key;
        sol_vault.bump = sol_vault_bump;

        ctx.accounts.mine.status = MineStatus::MiningActive;

        emit!(MarketGraduated {
            mint: mint_key,
            sol_reserve: plan.sol,
            pool: pool_key,
            token_reserve: plan.tokens,
        });
        Ok(())
    }

    /// Constant-product buy against the graduated pool: the same explicit fee schedule
    /// and the same slippage floor as the curve, but against reserves that live in the
    /// pool's own vaults and that no instruction can drain (spec 35, 36).
    pub fn pool_buy(ctx: Context<PoolBuy>, sol_in: u64, min_tokens_out: u64) -> Result<()> {
        require!(sol_in > 0, DiggoError::InvalidAmount);
        require!(ctx.accounts.market.graduated, DiggoError::MarketNotGraduated);
        let (net_sol, creator_fee, platform_fee) = net_after_fees(
            sol_in,
            ctx.accounts.market.creator_fee_bps,
            ctx.accounts.market.platform_fee_bps,
        )?;
        require!(net_sol > 0, DiggoError::InvalidAmount);
        let tokens_out = pool_quote_buy(
            ctx.accounts.pool.token_reserve,
            ctx.accounts.pool.sol_reserve,
            net_sol,
        )?;
        require!(
            tokens_out >= min_tokens_out && tokens_out > 0,
            DiggoError::SlippageExceeded
        );

        // Only the net input reaches the pool: the two explicit fees are paid straight
        // into the market's fee buckets, so the vault's lamports always equal its rent
        // floor plus pool.sol_reserve and nothing else.
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                SolTransfer {
                    from: ctx.accounts.buyer.to_account_info(),
                    to: ctx.accounts.sol_vault.to_account_info(),
                },
            ),
            net_sol,
        )?;
        let fees = creator_fee
            .checked_add(platform_fee)
            .ok_or(DiggoError::MathOverflow)?;
        if fees > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.key(),
                    SolTransfer {
                        from: ctx.accounts.buyer.to_account_info(),
                        to: ctx.accounts.market.to_account_info(),
                    },
                ),
                fees,
            )?;
        }

        transfer_from_pool(
            &ctx.accounts.token_program,
            &ctx.accounts.mint,
            &ctx.accounts.token_vault,
            &ctx.accounts.buyer_tokens,
            &ctx.accounts.pool,
            tokens_out,
        )?;

        apply_pool_swap(
            &mut ctx.accounts.pool,
            PoolDebit::Swap,
            net_sol,
            0,
            0,
            tokens_out,
        )?;
        accrue_fees(&mut ctx.accounts.market, creator_fee, platform_fee)?;
        emit!(TradeExecuted {
            mint: ctx.accounts.mint.key(),
            trader: ctx.accounts.buyer.key(),
            side: 0,
            token_amount: tokens_out,
            sol_amount: sol_in,
            creator_fee,
            platform_fee,
        });
        Ok(())
    }

    /// Constant-product sell against the graduated pool. The payout comes out of the
    /// pool's SOL vault, never exceeds the reserve the pool tracks, and honours the same
    /// explicit slippage floor.
    pub fn pool_sell(ctx: Context<PoolSell>, tokens_in: u64, min_sol_out: u64) -> Result<()> {
        require!(tokens_in > 0, DiggoError::InvalidAmount);
        require!(ctx.accounts.market.graduated, DiggoError::MarketNotGraduated);
        let gross_sol = pool_quote_sell(
            ctx.accounts.pool.token_reserve,
            ctx.accounts.pool.sol_reserve,
            tokens_in,
        )?;
        require!(gross_sol > 0, DiggoError::SlippageExceeded);
        let (sol_out, creator_fee, platform_fee) = net_after_fees(
            gross_sol,
            ctx.accounts.market.creator_fee_bps,
            ctx.accounts.market.platform_fee_bps,
        )?;
        require!(sol_out >= min_sol_out, DiggoError::SlippageExceeded);

        transfer_from_user(
            &ctx.accounts.token_program,
            &ctx.accounts.mint,
            &ctx.accounts.seller_tokens,
            &ctx.accounts.token_vault,
            &ctx.accounts.seller,
            tokens_in,
        )?;

        // Gross SOL leaves the vault: the seller's proceeds plus the two explicit fees,
        // which are moved on to the market's fee buckets in the same step.
        let fees = creator_fee
            .checked_add(platform_fee)
            .ok_or(DiggoError::MathOverflow)?;
        let leaving = sol_out.checked_add(fees).ok_or(DiggoError::MathOverflow)?;
        let vault_info = ctx.accounts.sol_vault.to_account_info();
        let market_info = ctx.accounts.market.to_account_info();
        let seller_info = ctx.accounts.seller.to_account_info();
        let rent_floor = Rent::get()?.minimum_balance(vault_info.data_len());
        require!(
            vault_info.lamports().saturating_sub(rent_floor) >= leaving,
            DiggoError::InsufficientLiquidity
        );
        **vault_info.try_borrow_mut_lamports()? = vault_info
            .lamports()
            .checked_sub(leaving)
            .ok_or(DiggoError::MathOverflow)?;
        **seller_info.try_borrow_mut_lamports()? = seller_info
            .lamports()
            .checked_add(sol_out)
            .ok_or(DiggoError::MathOverflow)?;
        **market_info.try_borrow_mut_lamports()? = market_info
            .lamports()
            .checked_add(fees)
            .ok_or(DiggoError::MathOverflow)?;

        apply_pool_swap(
            &mut ctx.accounts.pool,
            PoolDebit::Swap,
            0,
            tokens_in,
            gross_sol,
            0,
        )?;
        accrue_fees(&mut ctx.accounts.market, creator_fee, platform_fee)?;
        emit!(TradeExecuted {
            mint: ctx.accounts.mint.key(),
            trader: ctx.accounts.seller.key(),
            side: 1,
            token_amount: tokens_in,
            sol_amount: sol_out,
            creator_fee,
            platform_fee,
        });
        Ok(())
    }

    pub fn initialize_player(ctx: Context<InitializePlayer>) -> Result<()> {
        let player = &mut ctx.accounts.player;
        player.owner = ctx.accounts.owner.key();
        player.power = STARTER_POWER;
        player.active_mine = Pubkey::default();
        player.bump = ctx.bumps.player;
        Ok(())
    }

    pub fn assign_power(ctx: Context<AssignPower>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        sync_mine_to_now(&mut ctx.accounts.mine, now)?;
        settle_position(&mut ctx.accounts.position, &ctx.accounts.mine)?;

        let player = &mut ctx.accounts.player;
        require!(
            player.active_mine == Pubkey::default()
                || player.active_mine == ctx.accounts.mine.key(),
            DiggoError::PowerAlreadyAssigned
        );
        let old_power = ctx.accounts.position.assigned_power;
        let new_power = player.power;
        ctx.accounts.mine.total_power = ctx
            .accounts
            .mine
            .total_power
            .checked_sub(old_power)
            .and_then(|value| value.checked_add(new_power))
            .ok_or(DiggoError::MathOverflow)?;
        ctx.accounts.position.owner = ctx.accounts.owner.key();
        ctx.accounts.position.mine = ctx.accounts.mine.key();
        ctx.accounts.position.assigned_power = new_power;
        ctx.accounts.position.last_reward_index = ctx.accounts.mine.reward_index;
        ctx.accounts.position.bump = ctx.bumps.position;
        player.active_mine = ctx.accounts.mine.key();
        Ok(())
    }

    pub fn remove_power(ctx: Context<AssignPower>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        sync_mine_to_now(&mut ctx.accounts.mine, now)?;
        settle_position(&mut ctx.accounts.position, &ctx.accounts.mine)?;
        let assigned = ctx.accounts.position.assigned_power;
        require!(assigned > 0, DiggoError::NoPowerAssigned);
        ctx.accounts.mine.total_power = ctx
            .accounts
            .mine
            .total_power
            .checked_sub(assigned)
            .ok_or(DiggoError::MathOverflow)?;
        ctx.accounts.position.assigned_power = 0;
        ctx.accounts.position.last_reward_index = ctx.accounts.mine.reward_index;
        ctx.accounts.player.active_mine = Pubkey::default();
        Ok(())
    }

    /// Walks this mine's mining ledger forward by at most MAX_SYNC_SEGMENTS segments and
    /// commits the progress. Permissionless by design: a mine that has been idle longer
    /// than one call can afford is caught up by calling this repeatedly, which is also how
    /// a caller that received SyncBehind from claim_rewards or assign_power unblocks
    /// itself. Each call is a deterministic continuation of the previous one, so the
    /// ledger it finally lands on is the same one a single unbounded pass would have
    /// produced.
    pub fn advance_mine(ctx: Context<AdvanceMine>) -> Result<()> {
        sync_mine(&mut ctx.accounts.mine, Clock::get()?.unix_timestamp).map(|_| ())
    }

    /// Pays out accrued mining rewards. Blocked while the protocol-wide
    /// reward-claims circuit breaker is on; buying and selling are never affected.
    ///
    /// The Mining Reserve itself is not debited here: sync_mine already debited it
    /// through apply_reserve_debit(ReserveDebit::MiningClaim, ..) when the reward index
    /// moved, and pending_reward is this position's claim on what the ledger already
    /// accounted for. This instruction therefore moves no reserve token that the mining
    /// ledger did not first authorise.
    pub fn claim_rewards(ctx: Context<ClaimRewards>) -> Result<()> {
        require!(
            !ctx.accounts.protocol.reward_claims_paused,
            DiggoError::RewardClaimsPaused
        );
        let now = Clock::get()?.unix_timestamp;
        sync_mine_to_now(&mut ctx.accounts.mine, now)?;
        settle_position(&mut ctx.accounts.position, &ctx.accounts.mine)?;
        let amount = ctx.accounts.position.pending_reward;
        require!(amount > 0, DiggoError::NothingToClaim);
        ctx.accounts.position.pending_reward = 0;
        transfer_from_mine(
            &ctx.accounts.token_program,
            &ctx.accounts.mint,
            &ctx.accounts.reserve_vault,
            &ctx.accounts.owner_tokens,
            &ctx.accounts.mine,
            amount,
        )?;
        emit!(RewardsClaimed {
            mint: ctx.accounts.mint.key(),
            owner: ctx.accounts.owner.key(),
            amount
        });
        Ok(())
    }

    /// Pushes a player's off-chain, ORE-funded Crew power on-chain. Only the
    /// protocol keeper may call this — real tokens or SOL never buy power;
    /// power only ever comes from the backend's Crew progression accounting.
    pub fn sync_crew_power(ctx: Context<SyncCrewPower>, new_power: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        sync_mine_to_now(&mut ctx.accounts.mine, now)?;
        settle_position(&mut ctx.accounts.position, &ctx.accounts.mine)?;

        let mine = &mut ctx.accounts.mine;
        let player = &mut ctx.accounts.player;
        let previous_power = player.power;
        // Never above the configured ceiling, and never more than the configured
        // per-call increase bound above the previous value. Both bounds live in
        // ProtocolConfig and are hard-clamped by protocol constants.
        validate_power_update(&ctx.accounts.protocol, previous_power, new_power)?;
        player.power = new_power;
        if player.active_mine == mine.key() {
            mine.total_power = mine
                .total_power
                .checked_sub(previous_power)
                .and_then(|value| value.checked_add(new_power))
                .ok_or(DiggoError::MathOverflow)?;
            ctx.accounts.position.assigned_power = new_power;
            ctx.accounts.position.last_reward_index = mine.reward_index;
        }
        emit!(CrewPowerSynced {
            owner: player.owner,
            mint: ctx.accounts.mint.key(),
            previous_power,
            power: new_power,
            max_crew_power: ctx.accounts.protocol.max_crew_power,
        });
        Ok(())
    }

    /// Pays out a server-authoritative random memecoin discovery from the
    /// Discovery Reserve. Only the protocol keeper may call this, and only
    /// after the backend's eligibility, budget and anti-abuse checks pass —
    /// this instruction performs no RNG or eligibility logic itself.
    ///
    /// Idempotency is enforced on-chain: discovery_id seeds a DiscoveryReceipt PDA that
    /// is created with init, so replaying an id fails instead of paying twice. The scoped
    /// circuit breakers, the per-call ceiling, the per-mine per-epoch budget and reserve
    /// sufficiency all live in approve_discovery_payout, and the Discovery Reserve is
    /// debited through the shared reserve ledger.
    pub fn claim_discovery(
        ctx: Context<ClaimDiscovery>,
        discovery_id: u64,
        amount: u64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let mine = &mut ctx.accounts.mine;
        let approval = approve_discovery_payout(&ctx.accounts.protocol, mine, amount, now)?;
        mine.discovery_epoch_spent = approval.epoch_spent;
        mine.discovery_epoch_ends_at = approval.epoch_ends_at;
        apply_reserve_debit(mine, ReserveDebit::DiscoveryClaim, amount)?;

        let receipt = &mut ctx.accounts.receipt;
        receipt.mine = mine.key();
        receipt.discovery_id = discovery_id;
        receipt.recipient = ctx.accounts.recipient.key();
        receipt.amount = amount;
        receipt.claimed_at = now;
        receipt.bump = ctx.bumps.receipt;

        transfer_from_mine(
            &ctx.accounts.token_program,
            &ctx.accounts.mint,
            &ctx.accounts.discovery_vault,
            &ctx.accounts.recipient_tokens,
            mine,
            amount,
        )?;
        emit!(DiscoveryClaimed {
            mint: mine.mint,
            recipient: ctx.accounts.recipient.key(),
            discovery_id,
            amount,
            epoch_spent: approval.epoch_spent,
            epoch_budget: approval.epoch_budget,
        });
        Ok(())
    }

    /// Claims the mine creator's explicitly accrued trading fee. The creator can claim
    /// only their own fee bucket: withdrawable_fee refuses to move anything unless the
    /// market still holds its rent floor, the whole curve reserve (LP SOL) and the other
    /// fee bucket afterwards. There is no path from here to a program reserve.
    pub fn claim_creator_fees(ctx: Context<ClaimCreatorFees>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.creator.key(),
            ctx.accounts.mine.creator,
            DiggoError::UnauthorizedCreator
        );
        let market_info = ctx.accounts.market.to_account_info();
        let rent_floor = Rent::get()?.minimum_balance(market_info.data_len());
        let amount = withdrawable_fee(
            &ctx.accounts.market,
            market_info.lamports(),
            rent_floor,
            FeeBucket::Creator,
        )?;
        ctx.accounts.market.creator_fee_claimable = 0;
        **market_info.try_borrow_mut_lamports()? = market_info
            .lamports()
            .checked_sub(amount)
            .ok_or(DiggoError::MathOverflow)?;
        let creator_info = ctx.accounts.creator.to_account_info();
        **creator_info.try_borrow_mut_lamports()? = creator_info
            .lamports()
            .checked_add(amount)
            .ok_or(DiggoError::MathOverflow)?;
        emit!(FeesClaimed {
            mint: ctx.accounts.mint.key(),
            claimant: ctx.accounts.creator.key(),
            kind: 0,
            amount,
        });
        Ok(())
    }

    /// Claims the platform trading fee accrued on one market, paid to the treasury wallet
    /// stored in ProtocolConfig. Same guard as the creator claim: the curve reserve and
    /// the other fee bucket are untouchable.
    pub fn claim_platform_fees(ctx: Context<ClaimPlatformFees>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.treasury.key(),
            ctx.accounts.protocol.treasury,
            DiggoError::InvalidTreasury
        );
        let market_info = ctx.accounts.market.to_account_info();
        let rent_floor = Rent::get()?.minimum_balance(market_info.data_len());
        let amount = withdrawable_fee(
            &ctx.accounts.market,
            market_info.lamports(),
            rent_floor,
            FeeBucket::Platform,
        )?;
        ctx.accounts.market.platform_fee_claimable = 0;
        **market_info.try_borrow_mut_lamports()? = market_info
            .lamports()
            .checked_sub(amount)
            .ok_or(DiggoError::MathOverflow)?;
        let treasury_info = ctx.accounts.treasury.to_account_info();
        **treasury_info.try_borrow_mut_lamports()? = treasury_info
            .lamports()
            .checked_add(amount)
            .ok_or(DiggoError::MathOverflow)?;
        emit!(FeesClaimed {
            mint: ctx.accounts.mint.key(),
            claimant: ctx.accounts.treasury.key(),
            kind: 1,
            amount,
        });
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct LaunchTokenArgs {
    pub nonce: u64,
    pub name: String,
    pub symbol: String,
    pub uri: String,
    pub decimals: u8,
    pub total_supply: u64,
    pub reserve_bps: u16,
    pub initial_block_reward: u64,
    pub minimum_reward: u64,
    pub block_interval: i64,
    pub epoch_length: i64,
    pub reduction_bps: u16,
    pub virtual_sol_reserve: u64,
    pub graduation_target: u64,
    pub discovery_reserve_bps: u16,
}

#[derive(Accounts)]
pub struct InitializeProtocol<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: constrained to this executable program's address.
    #[account(address = crate::ID)]
    pub program: UncheckedAccount<'info>,
    #[account(
        constraint = program_data.key() == Pubkey::find_program_address(
            &[crate::ID.as_ref()],
            &anchor_lang::solana_program::bpf_loader_upgradeable::ID,
        ).0 @ DiggoError::InvalidProgramData,
        constraint = program_data.upgrade_authority_address == Some(payer.key()) @ DiggoError::UnauthorizedInitializer,
    )]
    pub program_data: Account<'info, ProgramData>,
    #[account(init, payer = payer, space = 8 + ProtocolConfig::INIT_SPACE, seeds = [b"protocol"], bump)]
    pub protocol: Account<'info, ProtocolConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RotateKeeper<'info> {
    pub keeper: Signer<'info>,
    #[account(mut, seeds = [b"protocol"], bump = protocol.bump, has_one = keeper)]
    pub protocol: Account<'info, ProtocolConfig>,
}

#[derive(Accounts)]
#[instruction(args: LaunchTokenArgs)]
pub struct LaunchToken<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(seeds = [b"protocol"], bump = protocol.bump)]
    pub protocol: Account<'info, ProtocolConfig>,
    /// CHECK: constrained to the immutable treasury stored in protocol configuration.
    #[account(address = protocol.treasury)]
    pub treasury: UncheckedAccount<'info>,
    #[account(
        init,
        payer = creator,
        mint::decimals = args.decimals,
        mint::authority = mine,
        mint::freeze_authority = mine,
        seeds = [b"mint", creator.key().as_ref(), &args.nonce.to_le_bytes()],
        bump,
    )]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(init, payer = creator, space = 8 + Mine::INIT_SPACE, seeds = [b"mine", mint.key().as_ref()], bump)]
    pub mine: Account<'info, Mine>,
    #[account(init, payer = creator, space = 8 + LaunchMarket::INIT_SPACE, seeds = [b"market", mint.key().as_ref()], bump)]
    pub market: Account<'info, LaunchMarket>,
    #[account(
        init,
        payer = creator,
        token::mint = mint,
        token::authority = mine,
        token::token_program = token_program,
        seeds = [b"market-vault", mint.key().as_ref()],
        bump,
    )]
    pub market_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init,
        payer = creator,
        token::mint = mint,
        token::authority = mine,
        token::token_program = token_program,
        seeds = [b"reserve-vault", mint.key().as_ref()],
        bump,
    )]
    pub reserve_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init,
        payer = creator,
        token::mint = mint,
        token::authority = mine,
        token::token_program = token_program,
        seeds = [b"discovery-vault", mint.key().as_ref()],
        bump,
    )]
    pub discovery_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init,
        payer = creator,
        associated_token::mint = mint,
        associated_token::authority = treasury,
        associated_token::token_program = token_program,
    )]
    pub fee_vault: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Buy<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(mut, has_one = mint, has_one = market_vault)]
    pub mine: Account<'info, Mine>,
    #[account(mut, seeds = [b"market", mint.key().as_ref()], bump = market.bump, has_one = mine)]
    pub market: Account<'info, LaunchMarket>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, address = mine.market_vault)]
    pub market_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = buyer,
        associated_token::mint = mint,
        associated_token::authority = buyer,
        associated_token::token_program = token_program,
    )]
    pub buyer_tokens: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Sell<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    #[account(has_one = mint, has_one = market_vault)]
    pub mine: Account<'info, Mine>,
    #[account(mut, seeds = [b"market", mint.key().as_ref()], bump = market.bump, has_one = mine)]
    pub market: Account<'info, LaunchMarket>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, address = mine.market_vault)]
    pub market_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = seller)]
    pub seller_tokens: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct InitializePlayer<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(init, payer = owner, space = 8 + Player::INIT_SPACE, seeds = [b"player", owner.key().as_ref()], bump)]
    pub player: Account<'info, Player>,
    pub system_program: Program<'info, System>,
}

/// Graduation, the one instruction that creates the liquidity pool (spec 36).
///
/// The pool, its token vault and its SOL vault are all PDAs created here. Nothing in
/// this account set can reach a mining reserve, a discovery reserve, a player balance or
/// the treasury: it only reads the market's own curve reserves and moves exactly those.
#[derive(Accounts)]
pub struct GraduateMarket<'info> {
    /// Anyone may call graduation; the caller only pays for the pool's rent.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, has_one = mint, has_one = market_vault)]
    pub mine: Account<'info, Mine>,
    #[account(mut, seeds = [b"market", mint.key().as_ref()], bump = market.bump, has_one = mine)]
    pub market: Account<'info, LaunchMarket>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, address = mine.market_vault)]
    pub market_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init,
        payer = payer,
        space = 8 + LiquidityPool::INIT_SPACE,
        seeds = [POOL_SEED, mint.key().as_ref()],
        bump,
    )]
    pub pool: Account<'info, LiquidityPool>,
    #[account(
        init,
        payer = payer,
        token::mint = mint,
        token::authority = pool,
        token::token_program = token_program,
        seeds = [POOL_VAULT_SEED, mint.key().as_ref()],
        bump,
    )]
    pub pool_token_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init,
        payer = payer,
        space = 8 + PoolSolVault::INIT_SPACE,
        seeds = [POOL_SOL_SEED, mint.key().as_ref()],
        bump,
    )]
    pub pool_sol_vault: Account<'info, PoolSolVault>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// Post-graduation buy. Every pool reference is pinned to the pool PDA, and the pool
/// itself is pinned to the market and the mine, so a trade can only ever touch the
/// liquidity of the market it names.
#[derive(Accounts)]
pub struct PoolBuy<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(has_one = mint)]
    pub mine: Account<'info, Mine>,
    #[account(mut, seeds = [b"market", mint.key().as_ref()], bump = market.bump, has_one = mine)]
    pub market: Account<'info, LaunchMarket>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        seeds = [POOL_SEED, mint.key().as_ref()],
        bump = pool.bump,
        has_one = mine,
        has_one = token_vault,
        has_one = sol_vault,
    )]
    pub pool: Account<'info, LiquidityPool>,
    #[account(mut, address = pool.token_vault, token::authority = pool, token::mint = mint)]
    pub token_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, address = pool.sol_vault, constraint = sol_vault.pool == pool.key() @ DiggoError::InvalidPool)]
    pub sol_vault: Account<'info, PoolSolVault>,
    #[account(
        init_if_needed,
        payer = buyer,
        associated_token::mint = mint,
        associated_token::authority = buyer,
        associated_token::token_program = token_program,
    )]
    pub buyer_tokens: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Post-graduation sell. Same pinning as PoolBuy; the SOL that leaves the vault is
/// bounded by pool.sol_reserve inside the handler, never by the vault's raw balance.
#[derive(Accounts)]
pub struct PoolSell<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    #[account(has_one = mint)]
    pub mine: Account<'info, Mine>,
    #[account(mut, seeds = [b"market", mint.key().as_ref()], bump = market.bump, has_one = mine)]
    pub market: Account<'info, LaunchMarket>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        seeds = [POOL_SEED, mint.key().as_ref()],
        bump = pool.bump,
        has_one = mine,
        has_one = token_vault,
        has_one = sol_vault,
    )]
    pub pool: Account<'info, LiquidityPool>,
    #[account(mut, address = pool.token_vault, token::authority = pool, token::mint = mint)]
    pub token_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, address = pool.sol_vault, constraint = sol_vault.pool == pool.key() @ DiggoError::InvalidPool)]
    pub sol_vault: Account<'info, PoolSolVault>,
    #[account(mut, token::mint = mint, token::authority = seller)]
    pub seller_tokens: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

/// Guardian-only layout migration. Like GuardianConfig, this account set holds no mint,
/// token account or vault — and unlike every other instruction it never even touches
/// lamports, so no balance or reserve can move through it.
#[derive(Accounts)]
pub struct MigrateAccount<'info> {
    pub guardian: Signer<'info>,
    /// CHECK: read out of the raw bytes rather than deserialized — the protocol account
    /// is exactly the account that may be awaiting migration. See migrate_account.
    #[account(
        address = Pubkey::find_program_address(&[b"protocol"], &crate::ID).0 @ DiggoError::InvalidAccountLayout,
    )]
    pub protocol: UncheckedAccount<'info>,
    /// CHECK: validated in the handler against the declared kind's discriminator, the
    /// program's own ownership and the current layout size. Its existing bytes are copied
    /// verbatim, so nothing but the trailing version byte can change.
    #[account(mut)]
    pub target: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct AssignPower<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"player", owner.key().as_ref()], bump = player.bump, has_one = owner)]
    pub player: Account<'info, Player>,
    #[account(mut)]
    pub mine: Account<'info, Mine>,
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + MiningPosition::INIT_SPACE,
        seeds = [b"position", mine.key().as_ref(), owner.key().as_ref()],
        bump,
    )]
    pub position: Account<'info, MiningPosition>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdvanceMine<'info> {
    #[account(mut)]
    pub mine: Account<'info, Mine>,
}

#[derive(Accounts)]
pub struct ClaimRewards<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    /// Read-only: carries the protocol-wide reward-claims circuit breaker.
    #[account(seeds = [b"protocol"], bump = protocol.bump)]
    pub protocol: Account<'info, ProtocolConfig>,
    #[account(mut, has_one = mint, has_one = reserve_vault)]
    pub mine: Account<'info, Mine>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, address = mine.reserve_vault)]
    pub reserve_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = owner,
        associated_token::mint = mint,
        associated_token::authority = owner,
        associated_token::token_program = token_program,
    )]
    pub owner_tokens: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, seeds = [b"position", mine.key().as_ref(), owner.key().as_ref()], bump = position.bump, has_one = owner, has_one = mine)]
    pub position: Account<'info, MiningPosition>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SyncCrewPower<'info> {
    pub keeper: Signer<'info>,
    #[account(seeds = [b"protocol"], bump = protocol.bump, has_one = keeper)]
    pub protocol: Account<'info, ProtocolConfig>,
    /// CHECK: the player's wallet; only used to derive PDAs, never signs here.
    pub owner: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"player", owner.key().as_ref()], bump = player.bump, has_one = owner)]
    pub player: Account<'info, Player>,
    #[account(mut, has_one = mint)]
    pub mine: Account<'info, Mine>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, seeds = [b"position", mine.key().as_ref(), owner.key().as_ref()], bump = position.bump, has_one = mine)]
    pub position: Account<'info, MiningPosition>,
}

#[derive(Accounts)]
#[instruction(discovery_id: u64, amount: u64)]
pub struct ClaimDiscovery<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(seeds = [b"protocol"], bump = protocol.bump, has_one = keeper)]
    pub protocol: Account<'info, ProtocolConfig>,
    #[account(mut, has_one = mint, has_one = discovery_vault)]
    pub mine: Account<'info, Mine>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, address = mine.discovery_vault)]
    pub discovery_vault: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: reward recipient wallet; only used to derive/own the destination ATA.
    pub recipient: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = keeper,
        associated_token::mint = mint,
        associated_token::authority = recipient,
        associated_token::token_program = token_program,
    )]
    pub recipient_tokens: InterfaceAccount<'info, TokenAccount>,
    /// One receipt per (mine, discovery_id), created with init: replaying the same
    /// discovery_id fails the transaction instead of paying the same discovery twice.
    #[account(
        init,
        payer = keeper,
        space = 8 + DiscoveryReceipt::INIT_SPACE,
        seeds = [DISCOVERY_RECEIPT_SEED, mine.key().as_ref(), &discovery_id.to_le_bytes()],
        bump,
    )]
    pub receipt: Account<'info, DiscoveryReceipt>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Account set for every guardian-only protocol action (pause flags and bounded
/// parameter updates).
///
/// It holds exactly two accounts: the guardian signer and the config it may edit.
/// There is no mint, token account, vault or lamport-bearing state here, so no
/// instruction built on this struct can ever move a reserve token, LP SOL, or any
/// user balance — the handlers can only assign the flags and bounds below.
#[derive(Accounts)]
pub struct GuardianConfig<'info> {
    pub guardian: Signer<'info>,
    #[account(mut, seeds = [b"protocol"], bump = protocol.bump, has_one = guardian)]
    pub protocol: Account<'info, ProtocolConfig>,
}

/// Guardian-only, single-mine circuit breaker. Same reasoning as GuardianConfig: the
/// scoped pause can only assign one boolean on one Mine account.
#[derive(Accounts)]
pub struct GuardianMineConfig<'info> {
    pub guardian: Signer<'info>,
    #[account(seeds = [b"protocol"], bump = protocol.bump, has_one = guardian)]
    pub protocol: Account<'info, ProtocolConfig>,
    #[account(mut, seeds = [b"mine", mint.key().as_ref()], bump = mine.bump, has_one = mint)]
    pub mine: Account<'info, Mine>,
    pub mint: InterfaceAccount<'info, Mint>,
}

/// Guardian-only guardian rotation (spec 65: scoped, auditable emergency controls).
#[derive(Accounts)]
pub struct RotateGuardian<'info> {
    pub guardian: Signer<'info>,
    #[account(mut, seeds = [b"protocol"], bump = protocol.bump, has_one = guardian)]
    pub protocol: Account<'info, ProtocolConfig>,
}

/// Creator trading-fee claim. Pays out only the creator's accrued fee bucket and can
/// never touch the curve's LP SOL or either program reserve; see withdrawable_fee.
#[derive(Accounts)]
pub struct ClaimCreatorFees<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(seeds = [b"mine", mint.key().as_ref()], bump = mine.bump, has_one = mint)]
    pub mine: Account<'info, Mine>,
    #[account(mut, seeds = [b"market", mint.key().as_ref()], bump = market.bump, has_one = mine)]
    pub market: Account<'info, LaunchMarket>,
}

/// Platform trading-fee claim, signed by the treasury wallet stored in ProtocolConfig.
#[derive(Accounts)]
pub struct ClaimPlatformFees<'info> {
    #[account(mut)]
    pub treasury: Signer<'info>,
    #[account(seeds = [b"protocol"], bump = protocol.bump)]
    pub protocol: Account<'info, ProtocolConfig>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(seeds = [b"mine", mint.key().as_ref()], bump = mine.bump, has_one = mint)]
    pub mine: Account<'info, Mine>,
    #[account(mut, seeds = [b"market", mint.key().as_ref()], bump = market.bump, has_one = mine)]
    pub market: Account<'info, LaunchMarket>,
}

#[account]
#[derive(InitSpace)]
pub struct ProtocolConfig {
    pub treasury: Pubkey,
    /// Backend authority permitted to push off-chain Crew power on-chain and
    /// pay out server-approved discoveries. It can never move the launch
    /// market, the treasury, or a player's claimable mining rewards.
    pub keeper: Pubkey,
    /// Circuit-breaker authority (spec 65). It may only flip the scoped pause flags and
    /// tune the bounded parameters below; it can never move reserve tokens, LP SOL, the
    /// treasury or any player balance — see GuardianConfig.
    pub guardian: Pubkey,
    pub reserve_bps: u16,
    pub discovery_reserve_bps: u16,
    /// Default creator trading fee, snapshotted into each new market at launch.
    pub creator_fee_bps: u16,
    /// Default platform trading fee, snapshotted into each new market at launch.
    pub platform_fee_bps: u16,
    /// Per-call discovery payout ceiling, in bps of a mine's total Discovery Reserve.
    pub discovery_max_bps: u16,
    /// Per-mine per-epoch discovery budget, in bps of the total Discovery Reserve.
    pub discovery_epoch_budget_bps: u16,
    /// Bounded Crew Power rule: ceiling for one player, and the per-call increase bound.
    pub max_crew_power: u64,
    pub max_power_increase_bps: u16,
    /// Protocol-wide breaker: stops every discovery payout. Trading is unaffected.
    pub discovery_payouts_paused: bool,
    /// Protocol-wide breaker: stops every reward claim. Trading is unaffected.
    pub reward_claims_paused: bool,
    pub bump: u8,
    /// Appended layout version (ACCOUNT_VERSION). Kept last on purpose: every field above
    /// keeps its offset, so an account written before this byte existed still decodes for
    /// every field except this one, and migrate_account can upgrade it in place.
    pub version: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Mine {
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub reserve_vault: Pubkey,
    pub discovery_vault: Pubkey,
    pub market_vault: Pubkey,
    pub fee_vault: Pubkey,
    pub total_supply: u64,
    pub remaining_reserve: u64,
    pub remaining_discovery_reserve: u64,
    pub cumulative_distributed: u64,
    pub total_power: u64,
    pub reward_index: u128,
    pub current_block_reward: u64,
    pub block_interval: i64,
    pub next_block_at: i64,
    pub epoch: u64,
    pub epoch_length: i64,
    pub epoch_ends_at: i64,
    pub reduction_bps: u16,
    pub minimum_reward: u64,
    pub status: MineStatus,
    #[max_len(MAX_NAME_LEN)]
    pub name: String,
    #[max_len(MAX_SYMBOL_LEN)]
    pub symbol: String,
    #[max_len(MAX_URI_LEN)]
    pub uri: String,
    /// Total Discovery Reserve allocated at launch — the denominator of the per-call
    /// and per-epoch caps, so the spend limits stay stable as the reserve drains.
    pub discovery_reserve_total: u64,
    /// Maximum discovery payout for this mine in one discovery epoch, snapshotted at
    /// launch from ProtocolConfig.
    pub discovery_epoch_budget: u64,
    pub discovery_epoch_spent: u64,
    pub discovery_epoch_ends_at: i64,
    /// Scoped circuit breaker for this mine's Discovery Reserve only.
    pub discovery_paused: bool,
    pub bump: u8,
    /// Appended layout version (ACCOUNT_VERSION); see ProtocolConfig.version.
    pub version: u8,
}

#[account]
#[derive(InitSpace)]
pub struct LaunchMarket {
    pub mine: Pubkey,
    pub token_reserve: u64,
    pub sol_reserve: u64,
    pub virtual_sol_reserve: u64,
    pub graduation_target: u64,
    pub graduated: bool,
    /// Trading fees accrued to the mine's creator, in lamports. Only claim_creator_fees
    /// may pay these out, and never out of sol_reserve (the LP SOL).
    pub creator_fee_claimable: u64,
    /// Trading fees accrued to the protocol treasury, in lamports.
    pub platform_fee_claimable: u64,
    /// Fee schedule snapshotted at launch, so a later config change can never
    /// retroactively alter an existing market.
    pub creator_fee_bps: u16,
    pub platform_fee_bps: u16,
    pub bump: u8,
    /// Appended layout version (ACCOUNT_VERSION); see ProtocolConfig.version.
    pub version: u8,
}

/// The program-owned, permanently locked liquidity pool a market graduates into
/// (spec 36).
///
/// There is deliberately no LP mint and no LP token: the pool's token vault is owned by
/// this PDA and its SOL lives in a PDA vault owned by the program, so the only way either
/// can shrink is a real swap through apply_pool_swap. No creator, admin, guardian or
/// keeper instruction can withdraw from it.
#[account]
#[derive(InitSpace)]
pub struct LiquidityPool {
    pub mine: Pubkey,
    pub mint: Pubkey,
    /// Token vault PDA (POOL_VAULT_SEED), authority = this pool.
    pub token_vault: Pubkey,
    /// SOL vault PDA (POOL_SOL_SEED), lamports = rent floor + sol_reserve.
    pub sol_vault: Pubkey,
    pub token_reserve: u64,
    pub sol_reserve: u64,
    pub graduated_at: i64,
    pub bump: u8,
}

/// The pool's SOL vault. It carries no authority of its own: the pool PDA is the only
/// thing that may spend these lamports, and only through a swap.
#[account]
#[derive(InitSpace)]
pub struct PoolSolVault {
    pub pool: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Player {
    pub owner: Pubkey,
    /// Mining Power derived off-chain from Crew progression and pushed here
    /// exclusively by `sync_crew_power`. Never purchasable with real tokens.
    pub power: u64,
    pub active_mine: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace, Default)]
pub struct MiningPosition {
    pub owner: Pubkey,
    pub mine: Pubkey,
    pub assigned_power: u64,
    pub last_reward_index: u128,
    pub pending_reward: u64,
    pub bump: u8,
}

/// Proof that exactly one (mine, discovery_id) discovery was paid out. Created with
/// init under seeds [b"discovery", mine, discovery_id], so a replay fails the
/// transaction instead of paying a second time (spec 47, 57).
#[account]
#[derive(InitSpace)]
pub struct DiscoveryReceipt {
    pub mine: Pubkey,
    pub discovery_id: u64,
    pub recipient: Pubkey,
    pub amount: u64,
    pub claimed_at: i64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, PartialEq, Eq)]
pub enum MineStatus {
    Launching,
    MiningActive,
    FullyMined,
}

#[event]
pub struct TokenLaunched {
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub total_supply: u64,
    pub mining_reserve: u64,
    pub discovery_reserve: u64,
    pub market_supply: u64,
}
#[event]
pub struct MarketGraduated {
    pub mint: Pubkey,
    pub sol_reserve: u64,
    /// The pool the market's curve liquidity was moved into.
    pub pool: Pubkey,
    pub token_reserve: u64,
}
#[event]
pub struct TradeExecuted {
    pub mint: Pubkey,
    pub trader: Pubkey,
    pub side: u8,
    pub token_amount: u64,
    pub sol_amount: u64,
    pub creator_fee: u64,
    pub platform_fee: u64,
}
#[event]
pub struct RewardsClaimed {
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
}
#[event]
pub struct CrewPowerSynced {
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub previous_power: u64,
    pub power: u64,
    pub max_crew_power: u64,
}
#[event]
pub struct DiscoveryClaimed {
    pub mint: Pubkey,
    pub recipient: Pubkey,
    pub discovery_id: u64,
    pub amount: u64,
    /// Per-mine epoch spend after this payout, for off-chain budget monitoring.
    pub epoch_spent: u64,
    pub epoch_budget: u64,
}
/// Audit trail for every circuit-breaker change (spec 65), emitted by both
/// pause_discovery_payouts and pause_reward_claims.
#[event]
pub struct PauseFlagsUpdated {
    pub guardian: Pubkey,
    pub discovery_payouts_paused: bool,
    pub reward_claims_paused: bool,
}
#[event]
pub struct MineDiscoveryPauseUpdated {
    pub guardian: Pubkey,
    pub mint: Pubkey,
    pub discovery_paused: bool,
}
#[event]
pub struct GuardianRotated {
    pub previous_guardian: Pubkey,
    pub guardian: Pubkey,
}
#[event]
pub struct PowerBoundsUpdated {
    pub guardian: Pubkey,
    pub max_crew_power: u64,
    pub max_power_increase_bps: u16,
}
#[event]
pub struct FeeConfigUpdated {
    pub guardian: Pubkey,
    pub creator_fee_bps: u16,
    pub platform_fee_bps: u16,
}
#[event]
pub struct DiscoveryLimitsUpdated {
    pub guardian: Pubkey,
    pub discovery_max_bps: u16,
    pub discovery_epoch_budget_bps: u16,
}
#[event]
pub struct FeesClaimed {
    pub mint: Pubkey,
    pub claimant: Pubkey,
    /// 0 = creator trading fee, 1 = platform trading fee.
    pub kind: u8,
    pub amount: u64,
}
/// Audit trail for every in-place layout upgrade (see migrate_account).
#[event]
pub struct AccountMigrated {
    pub account: Pubkey,
    pub kind: u8,
    pub from_len: u32,
    pub to_len: u32,
    pub version: u8,
}

fn validate_launch_args(args: &LaunchTokenArgs, protocol: &ProtocolConfig) -> Result<()> {
    require!(
        !args.name.is_empty() && args.name.len() <= MAX_NAME_LEN,
        DiggoError::InvalidMetadata
    );
    require!(
        !args.symbol.is_empty() && args.symbol.len() <= MAX_SYMBOL_LEN,
        DiggoError::InvalidMetadata
    );
    require!(args.uri.len() <= MAX_URI_LEN, DiggoError::InvalidMetadata);
    require!(args.decimals <= 9, DiggoError::InvalidDecimals);
    require!(args.total_supply > 0, DiggoError::InvalidAmount);
    require!(
        args.reserve_bps == protocol.reserve_bps,
        DiggoError::InvalidReserveSplit
    );
    require!(
        args.discovery_reserve_bps == protocol.discovery_reserve_bps,
        DiggoError::InvalidReserveSplit
    );
    require!(
        (args.reserve_bps as u32) + (args.discovery_reserve_bps as u32) < BPS as u32,
        DiggoError::InvalidReserveSplit
    );
    require!(
        args.initial_block_reward > 0 && args.minimum_reward > 0,
        DiggoError::InvalidReward
    );
    require!(
        args.minimum_reward <= args.initial_block_reward,
        DiggoError::InvalidReward
    );
    require!(
        args.block_interval >= 60 && args.block_interval <= 86_400,
        DiggoError::InvalidSchedule
    );
    require!(
        args.epoch_length >= args.block_interval && args.epoch_length <= 31_536_000,
        DiggoError::InvalidSchedule
    );
    require!(
        args.reduction_bps > 0 && args.reduction_bps < 10_000,
        DiggoError::InvalidReward
    );
    require!(
        args.virtual_sol_reserve > 0 && args.graduation_target > 0,
        DiggoError::InvalidMarket
    );
    require!(
        protocol.creator_fee_bps <= MAX_TRADING_FEE_BPS
            && protocol.platform_fee_bps <= MAX_TRADING_FEE_BPS,
        DiggoError::FeeTooHigh
    );
    require!(
        protocol.discovery_max_bps > 0
            && protocol.discovery_max_bps <= protocol.discovery_epoch_budget_bps
            && protocol.discovery_epoch_budget_bps <= MAX_DISCOVERY_EPOCH_BUDGET_BPS,
        DiggoError::DiscoveryLimitsOutOfRange
    );
    Ok(())
}

fn mint_to<'info>(
    program: &Interface<'info, TokenInterface>,
    mint: &InterfaceAccount<'info, Mint>,
    to: &InterfaceAccount<'info, TokenAccount>,
    authority: &Account<'info, Mine>,
    seeds: &[&[&[u8]]],
    amount: u64,
) -> Result<()> {
    token_interface::mint_to(
        CpiContext::new(
            program.key(),
            MintTo {
                mint: mint.to_account_info(),
                to: to.to_account_info(),
                authority: authority.to_account_info(),
            },
        )
        .with_signer(seeds),
        amount,
    )
}

fn revoke_authority<'info>(
    program: &Interface<'info, TokenInterface>,
    mint: &InterfaceAccount<'info, Mint>,
    authority: &Account<'info, Mine>,
    seeds: &[&[&[u8]]],
    authority_type: AuthorityType,
) -> Result<()> {
    token_interface::set_authority(
        CpiContext::new(
            program.key(),
            SetAuthority {
                current_authority: authority.to_account_info(),
                account_or_mint: mint.to_account_info(),
            },
        )
        .with_signer(seeds),
        authority_type,
        None,
    )
}

fn transfer_from_mine<'info>(
    program: &Interface<'info, TokenInterface>,
    mint: &InterfaceAccount<'info, Mint>,
    from: &InterfaceAccount<'info, TokenAccount>,
    to: &InterfaceAccount<'info, TokenAccount>,
    mine: &Account<'info, Mine>,
    amount: u64,
) -> Result<()> {
    let mint_key = mint.key();
    let seeds: &[&[&[u8]]] = &[&[b"mine", mint_key.as_ref(), &[mine.bump]]];
    token_interface::transfer_checked(
        CpiContext::new(
            program.key(),
            TransferChecked {
                mint: mint.to_account_info(),
                from: from.to_account_info(),
                to: to.to_account_info(),
                authority: mine.to_account_info(),
            },
        )
        .with_signer(seeds),
        amount,
        mint.decimals,
    )
}

fn transfer_from_user<'info>(
    program: &Interface<'info, TokenInterface>,
    mint: &InterfaceAccount<'info, Mint>,
    from: &InterfaceAccount<'info, TokenAccount>,
    to: &InterfaceAccount<'info, TokenAccount>,
    authority: &Signer<'info>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    token_interface::transfer_checked(
        CpiContext::new(
            program.key(),
            TransferChecked {
                mint: mint.to_account_info(),
                from: from.to_account_info(),
                to: to.to_account_info(),
                authority: authority.to_account_info(),
            },
        ),
        amount,
        mint.decimals,
    )
}

/// Token movement out of the pool's vault. The pool PDA is the vault's authority and this
/// is the only place that ever signs for it, for an amount the swap math already capped.
fn transfer_from_pool<'info>(
    program: &Interface<'info, TokenInterface>,
    mint: &InterfaceAccount<'info, Mint>,
    from: &InterfaceAccount<'info, TokenAccount>,
    to: &InterfaceAccount<'info, TokenAccount>,
    pool: &Account<'info, LiquidityPool>,
    amount: u64,
) -> Result<()> {
    let mint_key = mint.key();
    let seeds: &[&[&[u8]]] = &[&[POOL_SEED, mint_key.as_ref(), &[pool.bump]]];
    token_interface::transfer_checked(
        CpiContext::new(
            program.key(),
            TransferChecked {
                mint: mint.to_account_info(),
                from: from.to_account_info(),
                to: to.to_account_info(),
                authority: pool.to_account_info(),
            },
        )
        .with_signer(seeds),
        amount,
        mint.decimals,
    )
}

pub fn mul_bps(amount: u64, bps: u16) -> Result<u64> {
    u64::try_from(
        (amount as u128)
            .checked_mul(bps as u128)
            .ok_or(DiggoError::MathOverflow)?
            / BPS,
    )
    .map_err(|_| error!(DiggoError::MathOverflow))
}

pub fn quote_buy(
    token_reserve: u64,
    sol_reserve: u64,
    virtual_sol_reserve: u64,
    sol_in: u64,
) -> Result<u64> {
    let denominator = (sol_reserve as u128)
        .checked_add(virtual_sol_reserve as u128)
        .and_then(|v| v.checked_add(sol_in as u128))
        .ok_or(DiggoError::MathOverflow)?;
    let out = (token_reserve as u128)
        .checked_mul(sol_in as u128)
        .ok_or(DiggoError::MathOverflow)?
        / denominator;
    u64::try_from(out).map_err(|_| error!(DiggoError::MathOverflow))
}

pub fn quote_sell(
    token_reserve: u64,
    sol_reserve: u64,
    virtual_sol_reserve: u64,
    tokens_in: u64,
) -> Result<u64> {
    let effective_sol = (sol_reserve as u128)
        .checked_add(virtual_sol_reserve as u128)
        .ok_or(DiggoError::MathOverflow)?;
    let denominator = (token_reserve as u128)
        .checked_add(tokens_in as u128)
        .ok_or(DiggoError::MathOverflow)?;
    let raw = effective_sol
        .checked_mul(tokens_in as u128)
        .ok_or(DiggoError::MathOverflow)?
        / denominator;
    u64::try_from(raw.min(sol_reserve as u128)).map_err(|_| error!(DiggoError::MathOverflow))
}

pub fn reduced_reward(current: u64, reduction_bps: u16, minimum: u64) -> Result<u64> {
    let reduction = mul_bps(current, reduction_bps)?;
    Ok(current.saturating_sub(reduction).max(minimum))
}

// --- post-graduation constant-product pool (spec 36) ------------------------------------

/// x*y before a swap, as a u128 so the product of two u64 reserves can never overflow.
pub fn pool_invariant(pool: &LiquidityPool) -> Result<u128> {
    (pool.sol_reserve as u128)
        .checked_mul(pool.token_reserve as u128)
        .ok_or_else(|| error!(DiggoError::MathOverflow))
}

/// Tokens out of the pool for a net SOL input: k = x*y with the input added to the SOL
/// side. Integer division rounds in the pool's favour, so k can only grow.
pub fn pool_quote_buy(token_reserve: u64, sol_reserve: u64, net_sol: u64) -> Result<u64> {
    require!(net_sol > 0, DiggoError::InvalidAmount);
    require!(
        token_reserve > 0 && sol_reserve > 0,
        DiggoError::InsufficientLiquidity
    );
    let denominator = (sol_reserve as u128)
        .checked_add(net_sol as u128)
        .ok_or(DiggoError::MathOverflow)?;
    let out = (token_reserve as u128)
        .checked_mul(net_sol as u128)
        .ok_or(DiggoError::MathOverflow)?
        / denominator;
    let out = u64::try_from(out).map_err(|_| error!(DiggoError::MathOverflow))?;
    // A single buy can never take the whole token side: the pool must stay a pool.
    require!(out < token_reserve, DiggoError::InsufficientLiquidity);
    Ok(out)
}

/// SOL out of the pool for a token input, before the explicit fees. Capped at the pool's
/// tracked SOL reserve, so the payout can never exceed what the pool actually holds.
pub fn pool_quote_sell(token_reserve: u64, sol_reserve: u64, tokens_in: u64) -> Result<u64> {
    require!(tokens_in > 0, DiggoError::InvalidAmount);
    require!(
        token_reserve > 0 && sol_reserve > 0,
        DiggoError::InsufficientLiquidity
    );
    let denominator = (token_reserve as u128)
        .checked_add(tokens_in as u128)
        .ok_or(DiggoError::MathOverflow)?;
    let raw = (sol_reserve as u128)
        .checked_mul(tokens_in as u128)
        .ok_or(DiggoError::MathOverflow)?
        / denominator;
    u64::try_from(raw.min(sol_reserve as u128)).map_err(|_| error!(DiggoError::MathOverflow))
}

/// Why the pool's liquidity is being debited.
///
/// A swap is the only legitimate reason, ever. PoolWithdraw exists so the ledger rejects
/// the idea of an LP withdrawal explicitly instead of merely happening to have no
/// instruction that reaches it: the LP is permanently program-controlled, no LP token is
/// minted to anyone, and creator, admin and guardian all have no path to it (spec 35, 36).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum PoolDebit {
    /// A constant-product swap through pool_buy or pool_sell.
    Swap,
    /// Any admin, guardian, creator or keeper withdrawal. Always rejected.
    AdminWithdraw,
}

/// The single place where pool liquidity changes, and the only place it may ever shrink.
///
/// A whole swap is applied at once so the invariant is checked across the trade rather
/// than between its two halves: k after the swap may only be >= k before it. There is no
/// other caller and no other arm that permits a debit — AdminWithdraw exists so an LP
/// withdrawal is rejected explicitly rather than merely unreachable (spec 35, 36).
pub fn apply_pool_swap(
    pool: &mut LiquidityPool,
    debit: PoolDebit,
    sol_in: u64,
    tokens_in: u64,
    sol_out: u64,
    tokens_out: u64,
) -> Result<()> {
    if debit == PoolDebit::AdminWithdraw {
        return Err(error!(DiggoError::PoolWithdrawForbidden));
    }
    let before = pool_invariant(pool)?;
    pool.sol_reserve = pool
        .sol_reserve
        .checked_add(sol_in)
        .and_then(|value| value.checked_sub(sol_out))
        .ok_or(DiggoError::InsufficientLiquidity)?;
    pool.token_reserve = pool
        .token_reserve
        .checked_add(tokens_in)
        .and_then(|value| value.checked_sub(tokens_out))
        .ok_or(DiggoError::InsufficientLiquidity)?;
    require!(
        pool_invariant(pool)? >= before,
        DiggoError::PoolInvariantViolated
    );
    Ok(())
}

/// What one graduation moves.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GraduationPlan {
    pub sol: u64,
    pub tokens: u64,
}

/// The complete pre-flight rule set for graduation: the market must not be graduated
/// already, must genuinely have reached its target, and must have something to move.
/// The plan is exactly the market's curve reserves — never a fee bucket, never rent.
pub fn plan_graduation(market: &LaunchMarket) -> Result<GraduationPlan> {
    require!(!market.graduated, DiggoError::MarketAlreadyGraduated);
    require!(
        market.sol_reserve >= market.graduation_target,
        DiggoError::GraduationTargetNotMet
    );
    require!(
        market.sol_reserve > 0 && market.token_reserve > 0,
        DiggoError::InvalidMarket
    );
    Ok(GraduationPlan {
        sol: market.sol_reserve,
        tokens: market.token_reserve,
    })
}

/// Applies a plan to the market and to the freshly created pool.
///
/// The pool must still be empty, which is what makes graduation single-shot, and the
/// market's curve reserves end at exactly zero: both assets are conserved, so the SOL and
/// the tokens the pool holds are provably the ones the curve held a moment earlier.
pub fn apply_graduation(
    market: &mut LaunchMarket,
    pool: &mut LiquidityPool,
    plan: GraduationPlan,
) -> Result<()> {
    require!(
        pool.sol_reserve == 0 && pool.token_reserve == 0,
        DiggoError::InvalidPool
    );
    pool.sol_reserve = plan.sol;
    pool.token_reserve = plan.tokens;
    market.sol_reserve = 0;
    market.token_reserve = 0;
    market.graduated = true;
    Ok(())
}

/// Why a reserve is being debited. The mining and discovery reserves are
/// program-controlled (spec 19, 23, 35): creator, admin and guardian have no path to
/// them, and AdminWithdraw exists so the ledger rejects that idea explicitly rather than
/// merely happening to have no instruction that reaches it.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum ReserveDebit {
    /// Accrued block rewards flowing through the mining reward index.
    MiningClaim,
    /// A server-approved discovery payout.
    DiscoveryClaim,
    /// Any admin, guardian or creator withdrawal. Always rejected.
    AdminWithdraw,
}

/// The single place where a program reserve is allowed to shrink.
pub fn apply_reserve_debit(mine: &mut Mine, debit: ReserveDebit, amount: u64) -> Result<()> {
    match debit {
        ReserveDebit::MiningClaim => {
            mine.remaining_reserve = mine
                .remaining_reserve
                .checked_sub(amount)
                .ok_or(DiggoError::InsufficientReserve)?;
            mine.cumulative_distributed = mine
                .cumulative_distributed
                .checked_add(amount)
                .ok_or(DiggoError::MathOverflow)?;
        }
        ReserveDebit::DiscoveryClaim => {
            mine.remaining_discovery_reserve = mine
                .remaining_discovery_reserve
                .checked_sub(amount)
                .ok_or(DiggoError::InsufficientDiscoveryReserve)?;
        }
        ReserveDebit::AdminWithdraw => return Err(error!(DiggoError::ReserveWithdrawForbidden)),
    }
    Ok(())
}

/// The only state change a protocol pause instruction may perform.
pub fn set_discovery_payouts_paused(protocol: &mut ProtocolConfig, paused: bool) {
    protocol.discovery_payouts_paused = paused;
}

/// The only state change the reward-claims pause instruction may perform.
pub fn set_reward_claims_paused(protocol: &mut ProtocolConfig, paused: bool) {
    protocol.reward_claims_paused = paused;
}

/// The only state change the per-mine pause instruction may perform.
pub fn set_mine_discovery_paused(mine: &mut Mine, paused: bool) {
    mine.discovery_paused = paused;
}

/// Which accrued fee bucket a claim instruction is allowed to pay out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FeeBucket {
    Creator,
    Platform,
}

/// How many lamports may leave a market account for one fee claim, and nothing else.
///
/// This is what keeps a creator (or the treasury) from ever taking LP SOL or an unearned
/// fee: after the payout the market must still hold its rent floor, the whole curve
/// reserve, and the other fee bucket.
pub fn withdrawable_fee(
    market: &LaunchMarket,
    lamports: u64,
    rent_floor: u64,
    bucket: FeeBucket,
) -> Result<u64> {
    let (amount, other_bucket) = match bucket {
        FeeBucket::Creator => (market.creator_fee_claimable, market.platform_fee_claimable),
        FeeBucket::Platform => (market.platform_fee_claimable, market.creator_fee_claimable),
    };
    require!(amount > 0, DiggoError::NothingToClaim);
    let available = lamports.saturating_sub(rent_floor);
    let protected = market
        .sol_reserve
        .checked_add(other_bucket)
        .and_then(|value| value.checked_add(amount))
        .ok_or(DiggoError::MathOverflow)?;
    require!(available >= protected, DiggoError::InsufficientLiquidity);
    Ok(amount)
}

/// Splits a trade's gross SOL into the curve's net amount and the two explicit fees.
/// Both fees are capped, so they can never consume the whole trade.
pub fn net_after_fees(
    amount: u64,
    creator_fee_bps: u16,
    platform_fee_bps: u16,
) -> Result<(u64, u64, u64)> {
    require!(
        creator_fee_bps <= MAX_TRADING_FEE_BPS && platform_fee_bps <= MAX_TRADING_FEE_BPS,
        DiggoError::FeeTooHigh
    );
    let creator_fee = mul_bps(amount, creator_fee_bps)?;
    let platform_fee = mul_bps(amount, platform_fee_bps)?;
    let net = amount
        .checked_sub(creator_fee)
        .and_then(|value| value.checked_sub(platform_fee))
        .ok_or(DiggoError::MathOverflow)?;
    Ok((net, creator_fee, platform_fee))
}

/// Credits accrued trading fees on a market. Kept next to net_after_fees so the lamport
/// invariant stays visible: market lamports minus rent floor equals
/// sol_reserve + creator_fee_claimable + platform_fee_claimable.
pub fn accrue_fees(market: &mut LaunchMarket, creator_fee: u64, platform_fee: u64) -> Result<()> {
    market.creator_fee_claimable = market
        .creator_fee_claimable
        .checked_add(creator_fee)
        .ok_or(DiggoError::MathOverflow)?;
    market.platform_fee_claimable = market
        .platform_fee_claimable
        .checked_add(platform_fee)
        .ok_or(DiggoError::MathOverflow)?;
    Ok(())
}

/// Bounded keeper power rule: never above ProtocolConfig.max_crew_power (itself clamped
/// by MAX_CREW_POWER_HARD_CAP), and never more than max_power_increase_bps plus the
/// always-allowed MIN_POWER_STEP above the previous value. Decreases are intentionally
/// unbounded so abuse handling can still reduce a player's power.
pub fn validate_power_update(
    protocol: &ProtocolConfig,
    previous_power: u64,
    new_power: u64,
) -> Result<()> {
    require!(
        new_power <= protocol.max_crew_power && new_power <= MAX_CREW_POWER_HARD_CAP,
        DiggoError::PowerOutOfRange
    );
    let allowed = previous_power
        .saturating_add(mul_bps(previous_power, protocol.max_power_increase_bps)?)
        .saturating_add(MIN_POWER_STEP);
    require!(new_power <= allowed, DiggoError::PowerIncreaseTooLarge);
    Ok(())
}

/// Outcome of the pre-flight checks for one discovery payout. Returned instead of
/// mutating the mine so the whole rule set stays unit-testable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DiscoveryApproval {
    pub epoch_spent: u64,
    pub epoch_ends_at: i64,
    pub epoch_budget: u64,
}

/// The complete on-chain rule set for a discovery payout: scoped circuit breakers,
/// per-call ceiling, per-mine per-epoch budget, and reserve sufficiency. Idempotency is
/// enforced separately by the DiscoveryReceipt PDA.
pub fn approve_discovery_payout(
    protocol: &ProtocolConfig,
    mine: &Mine,
    amount: u64,
    now: i64,
) -> Result<DiscoveryApproval> {
    require!(
        !protocol.discovery_payouts_paused,
        DiggoError::DiscoveryPayoutsPaused
    );
    require!(!mine.discovery_paused, DiggoError::MineDiscoveryPaused);
    require!(amount > 0, DiggoError::InvalidAmount);
    require!(
        amount <= mine.remaining_discovery_reserve,
        DiggoError::InsufficientDiscoveryReserve
    );
    let max_per_call = mul_bps(mine.discovery_reserve_total, protocol.discovery_max_bps)?;
    require!(
        max_per_call > 0 && amount <= max_per_call,
        DiggoError::DiscoveryAmountTooLarge
    );
    let (epoch_spent, epoch_ends_at) = roll_discovery_epoch(mine, now)?;
    let spent = epoch_spent
        .checked_add(amount)
        .ok_or(DiggoError::MathOverflow)?;
    require!(
        spent <= mine.discovery_epoch_budget,
        DiggoError::DiscoveryEpochBudgetExceeded
    );
    Ok(DiscoveryApproval {
        epoch_spent: spent,
        epoch_ends_at,
        epoch_budget: mine.discovery_epoch_budget,
    })
}

/// Rolls the per-mine discovery epoch forwards past now in one step (no loop), resetting
/// the spent counter for every elapsed epoch.
pub fn roll_discovery_epoch(mine: &Mine, now: i64) -> Result<(u64, i64)> {
    if now < mine.discovery_epoch_ends_at {
        return Ok((mine.discovery_epoch_spent, mine.discovery_epoch_ends_at));
    }
    let length = mine.epoch_length.max(1);
    let elapsed = now.saturating_sub(mine.discovery_epoch_ends_at);
    let skipped = (elapsed / length)
        .checked_add(1)
        .ok_or(DiggoError::MathOverflow)?;
    let advance = skipped.checked_mul(length).ok_or(DiggoError::MathOverflow)?;
    let ends_at = mine
        .discovery_epoch_ends_at
        .checked_add(advance)
        .ok_or(DiggoError::MathOverflow)?;
    Ok((0, ends_at))
}

/// Seeds of the DiscoveryReceipt PDA: [b"discovery", mine, discovery_id]. Kept next to
/// the account constraint so the uniqueness rule (one receipt per id, per mine) can be
/// unit-tested against the same prefix constant the constraint uses.
#[cfg(test)]
pub fn discovery_receipt_seeds(mine: &Pubkey, discovery_id: u64) -> Vec<u8> {
    let mut seeds = Vec::with_capacity(DISCOVERY_RECEIPT_SEED.len() + 32 + 8);
    seeds.extend_from_slice(DISCOVERY_RECEIPT_SEED);
    seeds.extend_from_slice(mine.as_ref());
    seeds.extend_from_slice(&discovery_id.to_le_bytes());
    seeds
}

/// How far one bounded ledger walk got.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SyncProgress {
    /// Every block and epoch due at `now` has been accounted for.
    CaughtUp,
    /// The per-call segment budget ran out and the mine is still behind `now`.
    Behind,
}

/// True when this mine owes no further ledger work at `now`: it is not mining, has no
/// power to divide a block reward by, has nothing left to distribute, or has already been
/// walked past `now`. This is exactly the guard the walk opens with, exposed so callers can
/// ask whether a `reward_index` may be settled against without mutating anything.
fn sync_is_complete(mine: &Mine, now: i64) -> bool {
    mine.status != MineStatus::MiningActive
        || mine.remaining_reserve == 0
        || mine.total_power == 0
        || now < mine.next_block_at
}

/// Walks the mining ledger forward from its persisted cursors, doing at most
/// `max_segments` segments of work, and reports whether it reached `now`.
///
/// All of the progress lives in the mine account itself — `next_block_at`, `epoch`,
/// `epoch_ends_at`, `current_block_reward`, `reward_index` and `remaining_reserve` — so a
/// caller that is further behind than one transaction can afford simply calls again: the
/// walk resumes where it stopped and folds to the identical ledger a single unbounded pass
/// would have produced, no matter how many calls that takes. Every segment strictly
/// advances `next_block_at`, so each call that reports `Behind` has made real progress and
/// the walk always terminates.
///
/// The cost of one segment is bounded because launch validation forces
/// `epoch_length >= block_interval` (see `validate_launch_args`): the cursor can overshoot
/// an epoch boundary by less than one epoch, so the rollover loop runs at most once per
/// segment. Without that invariant a single segment could roll an unbounded number of
/// epochs.
fn sync_mine_with_budget(mine: &mut Mine, now: i64, max_segments: usize) -> Result<SyncProgress> {
    if sync_is_complete(mine, now) {
        return Ok(SyncProgress::CaughtUp);
    }
    // A non-positive schedule length would stop one of the two loops below from advancing,
    // so a corrupted or legacy account fails here instead of spinning until the compute
    // budget kills the transaction.
    require!(
        mine.block_interval > 0 && mine.epoch_length > 0,
        DiggoError::InvalidSchedule
    );
    let mut segments = 0usize;
    while now >= mine.next_block_at && mine.remaining_reserve > 0 {
        if segments >= max_segments {
            // Budget spent: leave every cursor exactly where it is, so the next call
            // continues from here instead of losing the work.
            return Ok(SyncProgress::Behind);
        }
        while mine.next_block_at >= mine.epoch_ends_at {
            mine.current_block_reward = reduced_reward(
                mine.current_block_reward,
                mine.reduction_bps,
                mine.minimum_reward,
            )?;
            mine.epoch = mine.epoch.checked_add(1).ok_or(DiggoError::MathOverflow)?;
            mine.epoch_ends_at = mine
                .epoch_ends_at
                .checked_add(mine.epoch_length)
                .ok_or(DiggoError::MathOverflow)?;
        }
        let blocks_due = ((now - mine.next_block_at) / mine.block_interval + 1) as u64;
        let blocks_until_epoch = (((mine.epoch_ends_at - mine.next_block_at - 1).max(0))
            / mine.block_interval
            + 1) as u64;
        let blocks = blocks_due.min(blocks_until_epoch.max(1));
        let requested = (mine.current_block_reward as u128)
            .checked_mul(blocks as u128)
            .ok_or(DiggoError::MathOverflow)?;
        let distributed = requested.min(mine.remaining_reserve as u128) as u64;
        let index_delta = (distributed as u128)
            .checked_mul(INDEX_SCALE)
            .ok_or(DiggoError::MathOverflow)?
            / mine.total_power as u128;
        mine.reward_index = mine
            .reward_index
            .checked_add(index_delta)
            .ok_or(DiggoError::MathOverflow)?;
        // The Mining Reserve is only ever debited through this ledger, which refuses
        // every source other than a real mining claim.
        apply_reserve_debit(mine, ReserveDebit::MiningClaim, distributed)?;
        mine.next_block_at = mine
            .next_block_at
            .checked_add(
                mine.block_interval
                    .checked_mul(blocks as i64)
                    .ok_or(DiggoError::MathOverflow)?,
            )
            .ok_or(DiggoError::MathOverflow)?;
        segments += 1;
    }
    if mine.remaining_reserve == 0 {
        mine.status = MineStatus::FullyMined;
    }
    Ok(SyncProgress::CaughtUp)
}

/// The production ledger walk: MAX_SYNC_SEGMENTS per call.
fn sync_mine(mine: &mut Mine, now: i64) -> Result<SyncProgress> {
    sync_mine_with_budget(mine, now, MAX_SYNC_SEGMENTS)
}

/// Walks the ledger to `now`, or refuses with SyncBehind.
///
/// The instructions that settle a position against `mine.reward_index` may only run on a
/// ledger that has accounted for every due block. Settling against a half-walked index
/// would credit the elapsed epochs the walk got through and then hide the rest behind
/// `last_reward_index`, permanently forfeiting them — so a partially synced index is never
/// spendable. The refusal locks nothing: `advance_mine` is permissionless, so anyone can
/// walk the mine forward MAX_SYNC_SEGMENTS at a time until this call succeeds.
fn sync_mine_to_now(mine: &mut Mine, now: i64) -> Result<()> {
    match sync_mine(mine, now)? {
        SyncProgress::CaughtUp => Ok(()),
        SyncProgress::Behind => Err(error!(DiggoError::SyncBehind)),
    }
}

fn settle_position(position: &mut MiningPosition, mine: &Mine) -> Result<()> {
    if position.assigned_power == 0 {
        position.last_reward_index = mine.reward_index;
        return Ok(());
    }
    let delta = mine
        .reward_index
        .checked_sub(position.last_reward_index)
        .ok_or(DiggoError::MathOverflow)?;
    let earned = (position.assigned_power as u128)
        .checked_mul(delta)
        .ok_or(DiggoError::MathOverflow)?
        / INDEX_SCALE;
    let earned = u64::try_from(earned).map_err(|_| error!(DiggoError::MathOverflow))?;
    position.pending_reward = position
        .pending_reward
        .checked_add(earned)
        .ok_or(DiggoError::MathOverflow)?;
    position.last_reward_index = mine.reward_index;
    Ok(())
}

/// Reads ProtocolConfig.guardian out of raw account bytes.
///
/// migrate_account cannot load the protocol account as a typed Account<ProtocolConfig>,
/// because the protocol account is exactly the account that may itself be awaiting migration
/// and is therefore one byte short. This reads the single field the instruction needs, and
/// validates the discriminator on the way so the bytes cannot be from another account type.
pub fn guardian_from_raw_protocol(data: &[u8]) -> Result<Pubkey> {
    require!(
        data.len() >= PROTOCOL_GUARDIAN_OFFSET + 32,
        DiggoError::InvalidAccountLayout
    );
    require!(
        &data[..8] == ProtocolConfig::DISCRIMINATOR,
        DiggoError::InvalidAccountLayout
    );
    let bytes: [u8; 32] = data[PROTOCOL_GUARDIAN_OFFSET..PROTOCOL_GUARDIAN_OFFSET + 32]
        .try_into()
        .map_err(|_| error!(DiggoError::InvalidAccountLayout))?;
    Ok(Pubkey::new_from_array(bytes))
}

/// (discriminator, current on-chain size) for one migratable account kind. Deriving the
/// expected size here rather than taking it from the caller is what stops a migration
/// from being pointed at a layout the program does not actually know.
pub fn account_layout(kind: u8) -> Result<(&'static [u8], usize)> {
    match kind {
        ACCOUNT_KIND_PROTOCOL => Ok((ProtocolConfig::DISCRIMINATOR, 8 + ProtocolConfig::INIT_SPACE)),
        ACCOUNT_KIND_MINE => Ok((Mine::DISCRIMINATOR, 8 + Mine::INIT_SPACE)),
        ACCOUNT_KIND_MARKET => Ok((LaunchMarket::DISCRIMINATOR, 8 + LaunchMarket::INIT_SPACE)),
        _ => Err(error!(DiggoError::UnsupportedAccountKind)),
    }
}

/// Byte-exact account upgrade.
///
/// The account's own values are read back out of its data and re-serialized, with only the
/// fields an upgrade appended set to the safe default. Borsh is deterministic, so every
/// field that already existed keeps its exact bytes and nothing derived from a lamport
/// balance, a reserve or a fee bucket is ever recomputed — the only new byte is the
/// appended version.
///
/// Re-serializing rather than writing a fixed offset matters: Mine has variable-length
/// name, symbol and uri fields, so its account is allocated for the maximum lengths and the
/// serialized payload is usually shorter than the buffer. A fixed tail write would land in
/// padding and the version would still read as 0. The data is padded for reading because the
/// appended field lives past the end of what the account currently holds.
pub fn upgraded_account_data(kind: u8, old: &[u8], new_len: usize) -> Result<Vec<u8>> {
    let (discriminator, expected_len) = account_layout(kind)?;
    require!(new_len == expected_len, DiggoError::InvalidAccountLayout);
    require!(old.len() >= 8, DiggoError::InvalidAccountLayout);
    require!(&old[..8] == discriminator, DiggoError::InvalidAccountLayout);
    require!(old.len() < new_len, DiggoError::AccountAlreadyCurrent);

    let mut padded = old.to_vec();
    padded.resize(old.len() + 8, 0);
    let payload = match kind {
        ACCOUNT_KIND_PROTOCOL => {
            let mut value = ProtocolConfig::try_deserialize(&mut &padded[..])?;
            value.version = ACCOUNT_VERSION;
            borsh::to_vec(&value).map_err(|_| error!(DiggoError::InvalidAccountLayout))?
        }
        ACCOUNT_KIND_MINE => {
            let mut value = Mine::try_deserialize(&mut &padded[..])?;
            value.version = ACCOUNT_VERSION;
            borsh::to_vec(&value).map_err(|_| error!(DiggoError::InvalidAccountLayout))?
        }
        ACCOUNT_KIND_MARKET => {
            let mut value = LaunchMarket::try_deserialize(&mut &padded[..])?;
            value.version = ACCOUNT_VERSION;
            borsh::to_vec(&value).map_err(|_| error!(DiggoError::InvalidAccountLayout))?
        }
        _ => return Err(error!(DiggoError::UnsupportedAccountKind)),
    };

    require!(
        8 + payload.len() <= new_len,
        DiggoError::InvalidAccountLayout
    );
    let mut out = vec![0u8; new_len];
    out[..8].copy_from_slice(discriminator);
    out[8..8 + payload.len()].copy_from_slice(&payload);
    Ok(out)
}

#[error_code]
pub enum DiggoError {
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Invalid treasury")]
    InvalidTreasury,
    #[msg("Protocol may only be initialized by the program upgrade authority")]
    UnauthorizedInitializer,
    #[msg("Invalid program data account")]
    InvalidProgramData,
    #[msg("Invalid metadata")]
    InvalidMetadata,
    #[msg("Invalid decimals")]
    InvalidDecimals,
    #[msg("Invalid reserve split")]
    InvalidReserveSplit,
    #[msg("Invalid reward parameters")]
    InvalidReward,
    #[msg("Invalid schedule")]
    InvalidSchedule,
    #[msg("Invalid market parameters")]
    InvalidMarket,
    #[msg("Slippage limit exceeded")]
    SlippageExceeded,
    #[msg("Insufficient launch liquidity")]
    InsufficientLiquidity,
    #[msg("Power is already assigned to another mine")]
    PowerAlreadyAssigned,
    #[msg("No mining power is assigned")]
    NoPowerAssigned,
    #[msg("No rewards are available")]
    NothingToClaim,
    /// Retained so no other error code moves; the ledger walk no longer returns it.
    /// A mine that is more calls behind than the walk can cover now reports SyncBehind
    /// from the settling instructions and is advanced by advance_mine instead.
    #[msg("Mine synchronization requires multiple calls")]
    SyncWindowTooLarge,
    #[msg("Invalid keeper authority")]
    InvalidKeeper,
    #[msg("Keeper-supplied power exceeds the protocol safety bound")]
    PowerOutOfRange,
    #[msg("Discovery reserve does not have enough balance for this claim")]
    InsufficientDiscoveryReserve,
    #[msg("Invalid guardian authority")]
    InvalidGuardian,
    #[msg("Discovery payouts are paused by the protocol circuit breaker")]
    DiscoveryPayoutsPaused,
    #[msg("Reward claims are paused by the protocol circuit breaker")]
    RewardClaimsPaused,
    #[msg("Discovery is paused for this mine")]
    MineDiscoveryPaused,
    #[msg("Discovery amount exceeds the per-call ceiling")]
    DiscoveryAmountTooLarge,
    #[msg("Discovery epoch budget is exhausted for this mine")]
    DiscoveryEpochBudgetExceeded,
    #[msg("Mining reserve does not have enough balance")]
    InsufficientReserve,
    #[msg("Reserve tokens may only leave through a valid mining or discovery claim")]
    ReserveWithdrawForbidden,
    #[msg("Crew power increase exceeds the per-call bound")]
    PowerIncreaseTooLarge,
    #[msg("Trading fee exceeds the protocol cap")]
    FeeTooHigh,
    #[msg("Invalid power bounds")]
    InvalidPowerBounds,
    #[msg("Invalid discovery limits")]
    DiscoveryLimitsOutOfRange,
    #[msg("Only the mine creator may claim creator fees")]
    UnauthorizedCreator,
    #[msg("This market has graduated; trade through the liquidity pool instead")]
    MarketGraduated,
    #[msg("This market has not graduated yet; trade on the bonding curve instead")]
    MarketNotGraduated,
    #[msg("This market has already graduated")]
    MarketAlreadyGraduated,
    #[msg("The market has not reached its graduation target")]
    GraduationTargetNotMet,
    #[msg("Invalid liquidity pool")]
    InvalidPool,
    #[msg("Pool liquidity is permanently locked and may only leave through a swap")]
    PoolWithdrawForbidden,
    #[msg("The swap would have reduced the pool invariant")]
    PoolInvariantViolated,
    #[msg("The account already has the current layout")]
    AccountAlreadyCurrent,
    #[msg("The account is not a migratable program account of the declared kind")]
    InvalidAccountLayout,
    #[msg("Fund the account for its new rent-exempt minimum before migrating it")]
    MigrationNeedsFunding,
    #[msg("Unsupported account kind")]
    UnsupportedAccountKind,
    /// The settling instructions refuse to read a ledger that is still behind now,
    /// because a partially walked reward_index would under-credit the elapsed epochs it
    /// hid behind last_reward_index. Permissionless: call advance_mine repeatedly (each
    /// call walks MAX_SYNC_SEGMENTS segments) and then retry.
    #[msg("This mine is behind and must be advanced with advance_mine before its positions can settle")]
    SyncBehind,
}

#[cfg(test)]
mod tests {
    use super::*;

    const OFFSET: u32 = ERROR_CODE_OFFSET;

    fn test_protocol() -> ProtocolConfig {
        ProtocolConfig {
            treasury: Pubkey::new_unique(),
            keeper: Pubkey::new_unique(),
            guardian: Pubkey::new_unique(),
            reserve_bps: DEFAULT_RESERVE_BPS,
            discovery_reserve_bps: DEFAULT_DISCOVERY_RESERVE_BPS,
            creator_fee_bps: DEFAULT_CREATOR_FEE_BPS,
            platform_fee_bps: DEFAULT_PLATFORM_FEE_BPS,
            discovery_max_bps: DEFAULT_DISCOVERY_MAX_BPS,
            discovery_epoch_budget_bps: DEFAULT_DISCOVERY_EPOCH_BUDGET_BPS,
            max_crew_power: DEFAULT_MAX_CREW_POWER,
            max_power_increase_bps: DEFAULT_MAX_POWER_INCREASE_BPS,
            discovery_payouts_paused: false,
            reward_claims_paused: false,
            bump: 0,
            version: ACCOUNT_VERSION,
        }
    }

    fn test_mine(remaining_reserve: u64) -> Mine {
        Mine {
            mint: Pubkey::new_unique(),
            creator: Pubkey::new_unique(),
            reserve_vault: Pubkey::default(),
            discovery_vault: Pubkey::default(),
            market_vault: Pubkey::default(),
            fee_vault: Pubkey::default(),
            total_supply: 1_000_000,
            remaining_reserve,
            remaining_discovery_reserve: 0,
            cumulative_distributed: 0,
            total_power: 1_000,
            reward_index: 0,
            current_block_reward: 100,
            block_interval: 300,
            next_block_at: 300,
            epoch: 0,
            epoch_length: 604_800,
            epoch_ends_at: 604_800,
            reduction_bps: 2_500,
            minimum_reward: 1,
            status: MineStatus::MiningActive,
            name: "Test".into(),
            symbol: "TEST".into(),
            uri: String::new(),
            discovery_reserve_total: 0,
            discovery_epoch_budget: 0,
            discovery_epoch_spent: 0,
            discovery_epoch_ends_at: 604_800,
            discovery_paused: false,
            bump: 0,
            version: ACCOUNT_VERSION,
        }
    }

    /// A mine with a 1_000_000 discovery allocation, a 500 bps epoch budget (50_000)
    /// and the default 100 bps per-call ceiling (10_000).
    fn test_mine_with_discovery() -> Mine {
        let mut mine = test_mine(1_000_000);
        mine.remaining_discovery_reserve = 1_000_000;
        mine.discovery_reserve_total = 1_000_000;
        mine.discovery_epoch_budget = 50_000;
        mine
    }

    fn test_market() -> LaunchMarket {
        LaunchMarket {
            mine: Pubkey::new_unique(),
            token_reserve: 950_000,
            sol_reserve: 50_000,
            virtual_sol_reserve: 10_000,
            graduation_target: 100_000,
            graduated: false,
            creator_fee_claimable: 0,
            platform_fee_claimable: 0,
            creator_fee_bps: DEFAULT_CREATOR_FEE_BPS,
            platform_fee_bps: DEFAULT_PLATFORM_FEE_BPS,
            bump: 0,
            version: ACCOUNT_VERSION,
        }
    }

    fn test_pool(sol_reserve: u64, token_reserve: u64) -> LiquidityPool {
        LiquidityPool {
            mine: Pubkey::new_unique(),
            mint: Pubkey::new_unique(),
            token_vault: Pubkey::new_unique(),
            sol_vault: Pubkey::new_unique(),
            token_reserve,
            sol_reserve,
            graduated_at: 0,
            bump: 0,
        }
    }

    fn err_code(err: anchor_lang::error::Error) -> u32 {
        match err {
            anchor_lang::error::Error::AnchorError(inner) => inner.error_code_number,
            anchor_lang::error::Error::ProgramError(_) => 0,
        }
    }

    fn assert_err(result: Result<()>, expected: DiggoError) {
        assert_eq!(err_code(result.unwrap_err()), OFFSET + expected as u32);
    }

    /// A valid launch schedule, used to pin the bounds that keep the ledger walk cheap.
    fn test_launch_args() -> LaunchTokenArgs {
        LaunchTokenArgs {
            nonce: 1,
            name: "Test".into(),
            symbol: "TEST".into(),
            uri: String::new(),
            decimals: 6,
            total_supply: 1_000_000_000,
            reserve_bps: DEFAULT_RESERVE_BPS,
            initial_block_reward: 100,
            minimum_reward: 1,
            block_interval: 300,
            epoch_length: 604_800,
            reduction_bps: DEFAULT_REDUCTION_BPS,
            virtual_sol_reserve: 10_000,
            graduation_target: 100_000,
            discovery_reserve_bps: DEFAULT_DISCOVERY_RESERVE_BPS,
        }
    }

    /// A mine left unsynced for `epochs` whole epochs, and the timestamp that far ahead.
    /// The reserve is far larger than the walk will ever distribute, so the mine stays
    /// MiningActive and every segment is bounded by the epoch boundary rather than by the
    /// reserve running out.
    fn test_mine_unsynced_for(epochs: i64) -> (Mine, i64) {
        let mine = test_mine(1_000_000_000);
        let now = mine.next_block_at + epochs * mine.epoch_length;
        (mine, now)
    }

    fn test_position(assigned_power: u64) -> MiningPosition {
        MiningPosition {
            owner: Pubkey::new_unique(),
            mine: Pubkey::new_unique(),
            assigned_power,
            last_reward_index: 0,
            pending_reward: 0,
            bump: 0,
        }
    }

    /// The source of one instruction handler: its signature up to whichever comes first,
    /// the next handler or the next doc comment (which belongs to that handler, so it must
    /// not be attributed to this one). Used below to pin the fact that the trading paths
    /// never consult a circuit breaker and that only the pool's own swaps move its LP.
    fn instruction_source(name: &str) -> &'static str {
        let src = include_str!("lib.rs");
        let start = src
            .find(&format!("pub fn {name}("))
            .expect("instruction handler exists");
        let rest = &src[start..];
        let next_fn = rest[1..].find("\n    pub fn ");
        let next_doc = rest[1..].find("\n    ///");
        let end = match (next_fn, next_doc) {
            (Some(a), Some(b)) => a.min(b) + 1,
            (Some(offset), None) | (None, Some(offset)) => offset + 1,
            (None, None) => rest.len(),
        };
        &rest[..end]
    }

    /// The source of one Accounts struct, up to the next one.
    fn accounts_struct_source(name: &str) -> &'static str {
        let src = include_str!("lib.rs");
        let start = src
            .find(&format!("pub struct {name}<'info> {{"))
            .expect("accounts struct exists");
        let rest = &src[start..];
        let end = rest[1..]
            .find("\npub struct ")
            .map(|offset| offset + 1)
            .unwrap_or(rest.len());
        &rest[..end]
    }

    #[test]
    fn reserve_and_discovery_split_never_exceed_supply() {
        let total_supply = 1_000_000_000u64;
        let reserve = mul_bps(total_supply, DEFAULT_RESERVE_BPS).unwrap();
        let discovery = mul_bps(total_supply, DEFAULT_DISCOVERY_RESERVE_BPS).unwrap();
        assert_eq!(reserve, 50_000_000);
        assert_eq!(discovery, 5_000_000);
        assert!(reserve + discovery < total_supply);
        assert!(mul_bps(u64::MAX, 10_000).is_ok());
    }

    #[test]
    fn reward_reduction_never_drops_below_minimum() {
        assert_eq!(reduced_reward(10_000, 2_500, 1).unwrap(), 7_500);
        assert_eq!(reduced_reward(1, 2_500, 1).unwrap(), 1);
    }

    #[test]
    fn buy_quote_has_slippage_and_cannot_empty_vault() {
        let small = quote_buy(950_000_000, 0, 10_000_000_000, 1_000_000_000).unwrap();
        let large = quote_buy(950_000_000, 0, 10_000_000_000, 2_000_000_000).unwrap();
        assert!(large > small);
        assert!(large < small * 2);
        assert!(large < 950_000_000);
    }

    #[test]
    fn sell_quote_never_exceeds_real_sol_reserve() {
        let out = quote_sell(500_000_000, 50_000_000_000, 10_000_000_000, u64::MAX).unwrap();
        assert!(out <= 50_000_000_000);
    }

    #[test]
    fn mine_never_accounts_more_than_the_reserve() {
        let mut mine = test_mine(250);
        sync_mine(&mut mine, 1_500).unwrap();
        assert_eq!(mine.cumulative_distributed, 250);
        assert_eq!(mine.remaining_reserve, 0);
        assert!(mine.status == MineStatus::FullyMined);
    }

    /// A mine left unsynced for 200 epochs is not a dead mine. Repeated bounded calls walk
    /// it to exactly the ledger one unbounded pass produces, whichever per-call budget is
    /// used, and every call that reports Behind has strictly advanced the cursors.
    #[test]
    fn mine_sync_is_resumable_and_matches_a_single_pass() {
        let (_, now) = test_mine_unsynced_for(200);
        let (mut reference, _) = test_mine_unsynced_for(200);
        assert_eq!(
            sync_mine_with_budget(&mut reference, now, usize::MAX).unwrap(),
            SyncProgress::CaughtUp
        );

        let (mut production, _) = test_mine_unsynced_for(200);
        let mut calls = 0usize;
        let mut previous = (
            production.next_block_at,
            production.epoch,
            production.reward_index,
            production.cumulative_distributed,
        );
        let production_calls = loop {
            calls += 1;
            assert!(calls <= 16, "200 epochs must converge in a handful of calls");
            if sync_mine(&mut production, now).unwrap() == SyncProgress::CaughtUp {
                break calls;
            }
            let current = (
                production.next_block_at,
                production.epoch,
                production.reward_index,
                production.cumulative_distributed,
            );
            assert!(current.0 > previous.0, "next_block_at must strictly advance");
            assert!(
                current.1 >= previous.1,
                "the epoch cursor must never go backwards"
            );
            assert!(
                current.2 >= previous.2,
                "the reward index must never go backwards"
            );
            assert!(
                current.3 >= previous.3,
                "distributed rewards must never go backwards"
            );
            previous = current;
        };
        assert!(
            production_calls > 1,
            "a 200-epoch gap cannot fit into one call"
        );

        for budget in [1usize, 7, MAX_SYNC_SEGMENTS, usize::MAX] {
            let (mut mine, _) = test_mine_unsynced_for(200);
            loop {
                if sync_mine_with_budget(&mut mine, now, budget).unwrap() == SyncProgress::CaughtUp
                {
                    break;
                }
            }
            assert_eq!(mine.next_block_at, reference.next_block_at);
            assert_eq!(mine.epoch, reference.epoch);
            assert_eq!(mine.epoch_ends_at, reference.epoch_ends_at);
            assert_eq!(mine.current_block_reward, reference.current_block_reward);
            assert_eq!(mine.reward_index, reference.reward_index);
            assert_eq!(mine.remaining_reserve, reference.remaining_reserve);
            assert_eq!(
                mine.cumulative_distributed,
                reference.cumulative_distributed
            );
            assert!(mine.status == reference.status);
            assert!(mine.status == MineStatus::MiningActive);
        }
    }

    /// The walk stops on an exhausted reserve however many calls it took, and never hands
    /// out a token more than the reserve held.
    #[test]
    fn a_resumable_walk_never_distributes_more_than_the_reserve() {
        let (mut mine, now) = test_mine_unsynced_for(200);
        mine.remaining_reserve = 250;
        let mut calls = 0usize;
        loop {
            calls += 1;
            assert!(calls <= 8, "an exhausted reserve must end the walk");
            if sync_mine(&mut mine, now).unwrap() == SyncProgress::CaughtUp {
                break;
            }
        }
        assert_eq!(mine.cumulative_distributed, 250);
        assert_eq!(mine.remaining_reserve, 0);
        assert!(mine.status == MineStatus::FullyMined);
        assert!(sync_mine_to_now(&mut mine, now).is_ok());
    }

    /// No position may settle against a half-walked index. While the mine is behind,
    /// sync_mine_to_now refuses with SyncBehind, and the index it refused to settle against
    /// is strictly behind the truth, so a settling caller that skipped the gate would
    /// credit only part of what the position earned and forfeit the rest behind
    /// last_reward_index. Finishing the walk opens the gate.
    #[test]
    fn a_partially_synced_mine_can_never_settle_a_position() {
        let (mut mine, now) = test_mine_unsynced_for(200);
        assert_err(sync_mine_to_now(&mut mine, now), DiggoError::SyncBehind);
        assert!(!sync_is_complete(&mine, now));

        let mut position = test_position(1_000);
        let partial_index = mine.reward_index;
        settle_position(&mut position, &mine).unwrap();
        let partial_credit = position.pending_reward;

        let (mut reference, _) = test_mine_unsynced_for(200);
        sync_mine_with_budget(&mut reference, now, usize::MAX).unwrap();
        assert!(partial_index < reference.reward_index);
        let mut settled = test_position(1_000);
        settle_position(&mut settled, &reference).unwrap();
        assert!(partial_credit > 0 && partial_credit < settled.pending_reward);

        // The walk is a deterministic continuation of the persisted cursors, so finishing
        // it — by anyone, through the permissionless advance_mine — opens the gate.
        loop {
            if sync_mine(&mut mine, now).unwrap() == SyncProgress::CaughtUp {
                break;
            }
        }
        assert!(sync_is_complete(&mine, now));
        assert_eq!(mine.reward_index, reference.reward_index);
        assert!(sync_mine_to_now(&mut mine, now).is_ok());
    }

    /// Only advance_mine, which settles nothing, may run against a ledger that is still
    /// behind. Every instruction that settles a position must go through the caught-up
    /// gate, so a future edit cannot quietly settle against a partial index.
    #[test]
    fn only_advance_mine_may_touch_a_behind_ledger() {
        for name in [
            "claim_rewards",
            "assign_power",
            "remove_power",
            "sync_crew_power",
        ] {
            let body = instruction_source(name);
            assert!(
                body.contains("sync_mine_to_now(&mut ctx.accounts.mine, now)"),
                "{name} must settle only against a caught-up ledger"
            );
            assert!(
                body.contains("settle_position"),
                "{name} settles a position, so it must be gated"
            );
        }
        let advance = instruction_source("advance_mine");
        assert!(advance.contains("sync_mine(&mut ctx.accounts.mine"));
        assert!(!advance.contains("settle_position"));
    }

    /// The walk cannot spin: a schedule that cannot advance a cursor is refused instead of
    /// looping until the compute budget aborts the transaction.
    #[test]
    fn a_mine_with_an_unusable_schedule_fails_instead_of_spinning() {
        let (mut mine, now) = test_mine_unsynced_for(200);
        mine.epoch_length = 0;
        assert_err(
            sync_mine(&mut mine, now).map(|_| ()),
            DiggoError::InvalidSchedule,
        );
        let (mut mine, now) = test_mine_unsynced_for(200);
        mine.block_interval = 0;
        assert_err(
            sync_mine(&mut mine, now).map(|_| ()),
            DiggoError::InvalidSchedule,
        );
    }

    /// The per-call cost of a segment is bounded only because launch validation forces
    /// epoch_length >= block_interval: that is what lets the epoch rollover loop run at
    /// most once per segment, so a single segment can never roll an unbounded number of
    /// epochs.
    #[test]
    fn launch_schedule_keeps_one_sync_segment_bounded() {
        let protocol = test_protocol();
        assert!(validate_launch_args(&test_launch_args(), &protocol).is_ok());

        let mut args = test_launch_args();
        args.block_interval = 86_400;
        args.epoch_length = 86_400;
        assert!(validate_launch_args(&args, &protocol).is_ok());

        args.epoch_length = 86_399;
        assert_err(
            validate_launch_args(&args, &protocol),
            DiggoError::InvalidSchedule,
        );

        for (block_interval, epoch_length) in [(0i64, 0i64), (300, 0), (300, -1), (-60, 300)] {
            let mut args = test_launch_args();
            args.block_interval = block_interval;
            args.epoch_length = epoch_length;
            assert_err(
                validate_launch_args(&args, &protocol),
                DiggoError::InvalidSchedule,
            );
        }
    }

    /// Spec 19, 23, 35: neither the admin (upgrade authority) nor the guardian can ever
    /// withdraw a Mining or Discovery Reserve. The ledger that every reserve debit goes
    /// through has no arm that permits it.
    #[test]
    fn admin_and_guardian_can_never_debit_either_reserve() {
        let mut mine = test_mine(1_000);
        mine.remaining_discovery_reserve = 500;

        for amount in [1u64, 500, 1_000, u64::MAX] {
            assert_err(
                apply_reserve_debit(&mut mine, ReserveDebit::AdminWithdraw, amount),
                DiggoError::ReserveWithdrawForbidden,
            );
        }

        assert_eq!(mine.remaining_reserve, 1_000);
        assert_eq!(mine.remaining_discovery_reserve, 500);
        assert_eq!(mine.cumulative_distributed, 0);
    }

    /// The two legitimate claim paths, and only those two, may shrink a reserve, and each
    /// one can only touch its own reserve.
    #[test]
    fn only_a_matching_claim_source_may_debit_a_reserve() {
        let mut mine = test_mine(1_000);
        mine.remaining_discovery_reserve = 500;

        assert_err(
            apply_reserve_debit(&mut mine, ReserveDebit::DiscoveryClaim, 501),
            DiggoError::InsufficientDiscoveryReserve,
        );
        assert_err(
            apply_reserve_debit(&mut mine, ReserveDebit::MiningClaim, 1_001),
            DiggoError::InsufficientReserve,
        );
        assert_eq!(mine.remaining_reserve, 1_000);
        assert_eq!(mine.remaining_discovery_reserve, 500);

        apply_reserve_debit(&mut mine, ReserveDebit::MiningClaim, 1_000).unwrap();
        assert_eq!(mine.remaining_reserve, 0);
        assert_eq!(mine.cumulative_distributed, 1_000);
        assert_eq!(mine.remaining_discovery_reserve, 500);

        apply_reserve_debit(&mut mine, ReserveDebit::DiscoveryClaim, 500).unwrap();
        assert_eq!(mine.remaining_discovery_reserve, 0);
        assert_eq!(mine.cumulative_distributed, 1_000);
    }

    /// Spec 35, 37: a creator can claim their own trading fee and nothing else — never
    /// LP SOL, never the other fee bucket, never a program reserve.
    #[test]
    fn creator_fee_claim_can_never_take_lp_sol() {
        const RENT: u64 = 1_000;
        let mut market = test_market();
        market.sol_reserve = 50_000;
        market.creator_fee_claimable = 300;
        market.platform_fee_claimable = 200;
        // the lamport invariant the buy/sell paths maintain
        let lamports =
            RENT + market.sol_reserve + market.creator_fee_claimable + market.platform_fee_claimable;

        assert_eq!(
            withdrawable_fee(&market, lamports, RENT, FeeBucket::Creator).unwrap(),
            market.creator_fee_claimable
        );
        assert_eq!(
            withdrawable_fee(&market, lamports, RENT, FeeBucket::Platform).unwrap(),
            market.platform_fee_claimable
        );

        // a market holding only LP SOL cannot pay the claimable fee out of it
        assert_err(
            withdrawable_fee(&market, RENT + market.sol_reserve, RENT, FeeBucket::Creator).map(|_| ()),
            DiggoError::InsufficientLiquidity,
        );

        // an empty bucket has nothing to claim, whatever the market holds
        let empty = test_market();
        assert_err(
            withdrawable_fee(
                &empty,
                RENT + empty.sol_reserve + 500,
                RENT,
                FeeBucket::Creator,
            )
            .map(|_| ()),
            DiggoError::NothingToClaim,
        );
    }

    /// Spec 47, 57: a discovery id can only ever be paid once. The receipt PDA is seeded
    /// by (mine, discovery_id), so a replay collides with the existing account.
    #[test]
    fn discovery_receipt_seeds_make_replays_impossible() {
        use std::collections::HashSet;
        let mine = Pubkey::new_unique();
        let other_mine = Pubkey::new_unique();
        let mut issued: HashSet<Vec<u8>> = HashSet::new();

        assert!(issued.insert(discovery_receipt_seeds(&mine, 7)));
        assert!(!issued.insert(discovery_receipt_seeds(&mine, 7)));
        assert!(issued.insert(discovery_receipt_seeds(&mine, 8)));
        assert!(issued.insert(discovery_receipt_seeds(&other_mine, 7)));

        let seeds = discovery_receipt_seeds(&mine, 7);
        let prefix = DISCOVERY_RECEIPT_SEED.len();
        assert_eq!(seeds.len(), prefix + 32 + 8);
        assert_eq!(&seeds[..prefix], DISCOVERY_RECEIPT_SEED);
        assert_eq!(&seeds[prefix..prefix + 32], mine.as_ref());
        assert_eq!(&seeds[prefix + 32..], &7u64.to_le_bytes());
    }

    /// Spec 65: both scoped breakers stop discovery payouts, and neither of them can be
    /// bypassed by a keeper call.
    #[test]
    fn discovery_payout_is_blocked_by_either_pause_flag() {
        let mine = test_mine_with_discovery();
        let mut protocol = test_protocol();
        assert!(approve_discovery_payout(&protocol, &mine, 1_000, 0).is_ok());

        protocol.discovery_payouts_paused = true;
        assert_err(
            approve_discovery_payout(&protocol, &mine, 1_000, 0).map(|_| ()),
            DiggoError::DiscoveryPayoutsPaused,
        );
        protocol.discovery_payouts_paused = false;

        let mut paused_mine = test_mine_with_discovery();
        paused_mine.discovery_paused = true;
        assert_err(
            approve_discovery_payout(&protocol, &paused_mine, 1_000, 0).map(|_| ()),
            DiggoError::MineDiscoveryPaused,
        );
    }

    /// Spec 45, 65: per-call ceiling, per-mine per-epoch budget, epoch rollover and
    /// reserve sufficiency all bind on-chain, not just in the backend.
    #[test]
    fn discovery_per_call_cap_epoch_budget_and_reserve_are_enforced() {
        let protocol = test_protocol();
        let mine = test_mine_with_discovery();
        let max_per_call = mul_bps(mine.discovery_reserve_total, protocol.discovery_max_bps).unwrap();
        assert_eq!(max_per_call, 10_000);
        assert_eq!(mine.discovery_epoch_budget, 50_000);

        assert!(approve_discovery_payout(&protocol, &mine, max_per_call, 0).is_ok());
        assert_err(
            approve_discovery_payout(&protocol, &mine, max_per_call + 1, 0).map(|_| ()),
            DiggoError::DiscoveryAmountTooLarge,
        );
        assert_err(
            approve_discovery_payout(&protocol, &mine, 0, 0).map(|_| ()),
            DiggoError::InvalidAmount,
        );

        let mut spent = test_mine_with_discovery();
        spent.discovery_epoch_spent = mine.discovery_epoch_budget;
        assert_err(
            approve_discovery_payout(&protocol, &spent, 1, 0).map(|_| ()),
            DiggoError::DiscoveryEpochBudgetExceeded,
        );

        // the next epoch resets the counter
        let rolled =
            approve_discovery_payout(&protocol, &spent, 1_000, spent.discovery_epoch_ends_at).unwrap();
        assert_eq!(rolled.epoch_spent, 1_000);
        assert!(rolled.epoch_ends_at > spent.discovery_epoch_ends_at);
        assert_eq!(rolled.epoch_budget, spent.discovery_epoch_budget);

        let mut drained = test_mine_with_discovery();
        drained.remaining_discovery_reserve = 999;
        assert_err(
            approve_discovery_payout(&protocol, &drained, 1_000, 0).map(|_| ()),
            DiggoError::InsufficientDiscoveryReserve,
        );
    }

    /// Spec 65: emergency controls must be scoped. Trading must keep working while
    /// discoveries and claims are paused.
    #[test]
    fn trading_quotes_are_independent_of_circuit_breakers() {
        let market = test_market();
        let mut protocol = test_protocol();
        let mine = test_mine_with_discovery();

        let buy = quote_buy(
            market.token_reserve,
            market.sol_reserve,
            market.virtual_sol_reserve,
            1_000_000,
        )
        .unwrap();
        let sell = quote_sell(
            market.token_reserve,
            market.sol_reserve,
            market.virtual_sol_reserve,
            1_000_000,
        )
        .unwrap();
        let fees = net_after_fees(1_000_000, market.creator_fee_bps, market.platform_fee_bps).unwrap();

        protocol.discovery_payouts_paused = true;
        protocol.reward_claims_paused = true;
        assert_eq!(
            buy,
            quote_buy(
                market.token_reserve,
                market.sol_reserve,
                market.virtual_sol_reserve,
                1_000_000
            )
            .unwrap()
        );
        assert_eq!(
            sell,
            quote_sell(
                market.token_reserve,
                market.sol_reserve,
                market.virtual_sol_reserve,
                1_000_000
            )
            .unwrap()
        );
        assert_eq!(
            fees,
            net_after_fees(1_000_000, market.creator_fee_bps, market.platform_fee_bps).unwrap()
        );
        // the discovery gate is the only thing the flags change
        assert_err(
            approve_discovery_payout(&protocol, &mine, 1_000, 0).map(|_| ()),
            DiggoError::DiscoveryPayoutsPaused,
        );
    }

    /// A structural guard: neither trading handler may ever consult a pause flag, so a
    /// future edit cannot quietly couple the market to the circuit breakers.
    #[test]
    fn trading_paths_never_read_a_pause_flag() {
        for name in ["buy", "sell"] {
            let body = instruction_source(name);
            assert!(
                !body.contains("_paused"),
                "{name} must stay outside every circuit breaker"
            );
            assert!(
                !body.contains("ProtocolConfig"),
                "{name} must not depend on protocol pause state"
            );
        }
        assert!(instruction_source("claim_rewards").contains("reward_claims_paused"));
        assert!(instruction_source("claim_discovery").contains("approve_discovery_payout"));
    }

    /// Spec 65: a pause instruction may only flip a flag. Both helpers take the state
    /// struct and a boolean, and touch nothing else.
    #[test]
    fn pause_helpers_only_toggle_flags() {
        let mut protocol = test_protocol();
        let mut mine = test_mine(1_000);
        mine.remaining_discovery_reserve = 500;

        let protocol_before = (
            protocol.max_crew_power,
            protocol.max_power_increase_bps,
            protocol.creator_fee_bps,
            protocol.platform_fee_bps,
            protocol.treasury,
            protocol.keeper,
            protocol.guardian,
        );
        let mine_before = (
            mine.remaining_reserve,
            mine.remaining_discovery_reserve,
            mine.total_supply,
            mine.discovery_epoch_budget,
            mine.creator,
        );

        set_discovery_payouts_paused(&mut protocol, true);
        set_reward_claims_paused(&mut protocol, true);
        set_mine_discovery_paused(&mut mine, true);
        assert!(protocol.discovery_payouts_paused);
        assert!(protocol.reward_claims_paused);
        assert!(mine.discovery_paused);

        assert_eq!(
            protocol_before,
            (
                protocol.max_crew_power,
                protocol.max_power_increase_bps,
                protocol.creator_fee_bps,
                protocol.platform_fee_bps,
                protocol.treasury,
                protocol.keeper,
                protocol.guardian,
            )
        );
        assert_eq!(
            mine_before,
            (
                mine.remaining_reserve,
                mine.remaining_discovery_reserve,
                mine.total_supply,
                mine.discovery_epoch_budget,
                mine.creator,
            )
        );

        set_discovery_payouts_paused(&mut protocol, false);
        set_reward_claims_paused(&mut protocol, false);
        set_mine_discovery_paused(&mut mine, false);
        assert!(!protocol.discovery_payouts_paused);
        assert!(!protocol.reward_claims_paused);
        assert!(!mine.discovery_paused);
    }

    /// Spec 35, 37: both fees are explicit, capped, floored, and conserve lamports.
    #[test]
    fn fee_math_is_capped_and_conserves_lamports() {
        let (net, creator, platform) = net_after_fees(10_000, 100, 100).unwrap();
        assert_eq!((net, creator, platform), (9_800, 100, 100));
        assert_eq!(net + creator + platform, 10_000);
        assert_eq!(net_after_fees(10_000, 0, 0).unwrap(), (10_000, 0, 0));

        assert_err(
            net_after_fees(10_000, MAX_TRADING_FEE_BPS + 1, 0).map(|_| ()),
            DiggoError::FeeTooHigh,
        );
        assert_err(
            net_after_fees(10_000, 0, MAX_TRADING_FEE_BPS + 1).map(|_| ()),
            DiggoError::FeeTooHigh,
        );

        // rounding never mints or burns a lamport
        let (net, creator, platform) = net_after_fees(3, 100, 100).unwrap();
        assert_eq!(net + creator + platform, 3);

        // accrual only ever adds to the two buckets
        let mut market = test_market();
        accrue_fees(&mut market, creator, platform).unwrap();
        assert_eq!(market.creator_fee_claimable, creator);
        assert_eq!(market.platform_fee_claimable, platform);
        assert_eq!(market.sol_reserve, test_market().sol_reserve);
    }

    /// Spec 12: the keeper can never push unbounded Crew Power.
    #[test]
    fn keeper_power_is_bounded_by_config_and_per_call_increase() {
        let protocol = test_protocol();
        assert_eq!(protocol.max_crew_power, DEFAULT_MAX_CREW_POWER);
        assert!(protocol.max_crew_power < MAX_CREW_POWER_HARD_CAP);
        assert!(MAX_CREW_POWER_HARD_CAP < 10_000_000);

        // an ordinary sync, inside both bounds
        assert!(validate_power_update(
            &protocol,
            STARTER_POWER,
            STARTER_POWER + MIN_POWER_STEP
        )
        .is_ok());

        // above the configured ceiling
        assert_err(
            validate_power_update(&protocol, STARTER_POWER, protocol.max_crew_power + 1),
            DiggoError::PowerOutOfRange,
        );

        // a single jump beyond the per-call increase bound
        let allowed = 10_000 + mul_bps(10_000, protocol.max_power_increase_bps).unwrap() + MIN_POWER_STEP;
        assert!(validate_power_update(&protocol, 10_000, allowed).is_ok());
        assert_err(
            validate_power_update(&protocol, 10_000, allowed + 1),
            DiggoError::PowerIncreaseTooLarge,
        );

        // decreases stay possible, so abuse handling can still reduce power
        assert!(validate_power_update(&protocol, 10_000, 0).is_ok());

        // even a maximally permissive config cannot exceed the protocol hard cap
        let mut loose = test_protocol();
        loose.max_crew_power = MAX_CREW_POWER_HARD_CAP;
        assert_err(
            validate_power_update(&loose, 0, MAX_CREW_POWER_HARD_CAP + 1),
            DiggoError::PowerOutOfRange,
        );
    }

    // --- post-graduation liquidity pool (spec 35, 36) -----------------------------------

    /// Spec 36: the pool is a real constant-product market. Across any sequence of swaps
    /// the invariant k = x*y may only grow, so the locked liquidity can be traded against
    /// but never diluted away.
    #[test]
    fn pool_swaps_never_reduce_the_invariant() {
        let mut pool = test_pool(30_000_000_000, 700_000_000);
        let mut k = pool_invariant(&pool).unwrap();
        assert!(k > 0);

        for step in 0..8u64 {
            let sol_in = 100_000_000 * (step + 1);
            let (net, _, _) =
                net_after_fees(sol_in, DEFAULT_CREATOR_FEE_BPS, DEFAULT_PLATFORM_FEE_BPS).unwrap();
            let tokens_out = pool_quote_buy(pool.token_reserve, pool.sol_reserve, net).unwrap();
            assert!(tokens_out > 0 && tokens_out < pool.token_reserve);

            apply_pool_swap(&mut pool, PoolDebit::Swap, net, 0, 0, tokens_out).unwrap();
            let after = pool_invariant(&pool).unwrap();
            assert!(after >= k, "buy step {step} reduced the pool invariant");
            k = after;

            let tokens_in = tokens_out / 2;
            let gross = pool_quote_sell(pool.token_reserve, pool.sol_reserve, tokens_in).unwrap();
            assert!(gross > 0 && gross < pool.sol_reserve);

            apply_pool_swap(&mut pool, PoolDebit::Swap, 0, tokens_in, gross, 0).unwrap();
            let after = pool_invariant(&pool).unwrap();
            assert!(after >= k, "sell step {step} reduced the pool invariant");
            k = after;
        }

        // the pool still holds a real, non-empty market on both sides
        assert!(pool.sol_reserve > 0 && pool.token_reserve > 0);
    }

    /// Neither side of the pool can be emptied by a single trade, whatever the size.
    #[test]
    fn pool_quotes_never_drain_a_side() {
        let tokens = 1_000_000_000_000_000u64;
        let sol = 1_000_000_000_000u64;

        let out = pool_quote_buy(tokens, sol, u64::MAX).unwrap();
        assert!(out > 0 && out < tokens);

        let gross = pool_quote_sell(tokens, sol, u64::MAX).unwrap();
        assert!(gross > 0 && gross <= sol);

        assert_err(
            pool_quote_buy(tokens, sol, 0).map(|_| ()),
            DiggoError::InvalidAmount,
        );
        assert_err(
            pool_quote_sell(tokens, sol, 0).map(|_| ()),
            DiggoError::InvalidAmount,
        );
        assert_err(
            pool_quote_buy(0, sol, 1).map(|_| ()),
            DiggoError::InsufficientLiquidity,
        );
        assert_err(
            pool_quote_buy(tokens, 0, 1).map(|_| ()),
            DiggoError::InsufficientLiquidity,
        );
        assert_err(
            pool_quote_sell(0, sol, 1).map(|_| ()),
            DiggoError::InsufficientLiquidity,
        );
        assert_err(
            pool_quote_sell(tokens, 0, 1).map(|_| ()),
            DiggoError::InsufficientLiquidity,
        );
    }

    /// Spec 37: pool trades use exactly the same capped, explicit fee schedule as the
    /// curve, so the pool is not a way around the fee cap.
    #[test]
    fn pool_trades_use_the_capped_fee_schedule() {
        let mut market = test_market();
        market.creator_fee_bps = MAX_TRADING_FEE_BPS + 1;
        assert_err(
            net_after_fees(10_000, market.creator_fee_bps, market.platform_fee_bps).map(|_| ()),
            DiggoError::FeeTooHigh,
        );
        assert!(instruction_source("pool_buy").contains("net_after_fees"));
        assert!(instruction_source("pool_sell").contains("net_after_fees"));
        assert_eq!(
            net_after_fees(10_000, DEFAULT_CREATOR_FEE_BPS, DEFAULT_PLATFORM_FEE_BPS).unwrap(),
            (9_900, 50, 50)
        );
    }

    /// Spec 35, 36: the LP is permanently program-controlled. The pool ledger has no arm
    /// that permits a withdrawal, and the only two instructions that ever debit it are the
    /// two swaps.
    #[test]
    fn no_instruction_can_withdraw_pool_liquidity() {
        let mut pool = test_pool(30_000_000_000, 700_000_000);
        let before = (pool.sol_reserve, pool.token_reserve);

        for amount in [1u64, 1_000, 30_000_000_000, u64::MAX] {
            assert_err(
                apply_pool_swap(&mut pool, PoolDebit::AdminWithdraw, 0, 0, amount, amount),
                DiggoError::PoolWithdrawForbidden,
            );
            assert_err(
                apply_pool_swap(&mut pool, PoolDebit::AdminWithdraw, amount, amount, 0, 0),
                DiggoError::PoolWithdrawForbidden,
            );
        }
        assert_eq!((pool.sol_reserve, pool.token_reserve), before);

        // a swap can never pay out more than the pool tracks on either side
        assert_err(
            apply_pool_swap(&mut pool, PoolDebit::Swap, 0, 0, before.0 + 1, 0),
            DiggoError::InsufficientLiquidity,
        );
        assert_err(
            apply_pool_swap(&mut pool, PoolDebit::Swap, 0, 0, 0, before.1 + 1),
            DiggoError::InsufficientLiquidity,
        );
        assert_eq!((pool.sol_reserve, pool.token_reserve), before);

        // structurally: only the two swap handlers debit the pool, and only pool_buy ever
        // signs for the pool's token vault
        assert!(instruction_source("pool_buy").contains("apply_pool_swap"));
        assert!(instruction_source("pool_sell").contains("apply_pool_swap"));
        assert!(instruction_source("pool_buy").contains("transfer_from_pool"));
        for name in [
            "graduate_market",
            "buy",
            "sell",
            "claim_creator_fees",
            "claim_platform_fees",
            "claim_rewards",
            "claim_discovery",
        ] {
            let body = instruction_source(name);
            assert!(
                !body.contains("apply_pool_swap") && !body.contains("transfer_from_pool"),
                "{name} must not be able to move pool liquidity"
            );
        }
    }

    // --- graduation ----------------------------------------------------------------------

    /// Spec 36: graduation moves exactly the market's curve reserves into the pool, and
    /// nothing else — not the fee buckets, not rent. Both assets are conserved.
    #[test]
    fn graduation_moves_exactly_the_reserve_amounts() {
        let mut market = test_market();
        market.sol_reserve = 120_000;
        market.token_reserve = 830_000;
        market.creator_fee_claimable = 700;
        market.platform_fee_claimable = 300;

        let plan = plan_graduation(&market).unwrap();
        assert_eq!(plan.sol, 120_000);
        assert_eq!(plan.tokens, 830_000);

        let mut pool = test_pool(0, 0);
        let tokens_before = market.token_reserve;
        let sol_before = market.sol_reserve;
        apply_graduation(&mut market, &mut pool, plan).unwrap();

        assert_eq!(pool.sol_reserve, sol_before);
        assert_eq!(pool.token_reserve, tokens_before);
        assert_eq!(market.sol_reserve, 0);
        assert_eq!(market.token_reserve, 0);
        assert!(market.graduated);
        // the fee buckets are untouched by graduation
        assert_eq!(market.creator_fee_claimable, 700);
        assert_eq!(market.platform_fee_claimable, 300);
        // and the invariant of the pool is exactly the market's old k
        assert_eq!(
            pool_invariant(&pool).unwrap(),
            (sol_before as u128) * (tokens_before as u128)
        );
    }

    /// Graduation requires a genuinely funded market, happens once, and cannot be replayed
    /// onto a pool that already holds liquidity.
    #[test]
    fn graduation_is_gated_and_single_shot() {
        let mut market = test_market();
        market.graduation_target = 100_000;
        market.sol_reserve = 99_999;
        assert_err(
            plan_graduation(&market).map(|_| ()),
            DiggoError::GraduationTargetNotMet,
        );

        market.sol_reserve = market.graduation_target;
        assert!(plan_graduation(&market).is_ok());

        market.graduated = true;
        assert_err(
            plan_graduation(&market).map(|_| ()),
            DiggoError::MarketAlreadyGraduated,
        );

        // a funded market with no tokens left has nothing to lock
        let mut empty = test_market();
        empty.sol_reserve = empty.graduation_target;
        empty.token_reserve = 0;
        assert_err(plan_graduation(&empty).map(|_| ()), DiggoError::InvalidMarket);

        // a pool that already holds liquidity cannot be graduated into again
        let mut funded = test_market();
        funded.sol_reserve = funded.graduation_target;
        let plan = plan_graduation(&funded).unwrap();
        let mut pool = test_pool(1, 1);
        assert_err(
            apply_graduation(&mut funded, &mut pool, plan).map(|_| ()),
            DiggoError::InvalidPool,
        );
        assert!(!funded.graduated);
    }

    /// Spec 36: after graduation the curve is closed and the pool is the only venue. The
    /// curve handlers no longer decide graduation themselves — the flag and the pool are
    /// created together, so a market can never be graduated with its liquidity stranded.
    #[test]
    fn graduation_switches_venues_atomically() {
        let curve_buy = instruction_source("buy");
        let curve_sell = instruction_source("sell");
        assert!(curve_buy.contains("MarketGraduated"));
        assert!(curve_sell.contains("MarketGraduated"));
        assert!(!curve_buy.contains("graduation_target"));
        assert!(!curve_sell.contains("graduation_target"));

        assert!(instruction_source("pool_buy").contains("MarketNotGraduated"));
        assert!(instruction_source("pool_sell").contains("MarketNotGraduated"));
        assert!(instruction_source("graduate_market").contains("plan_graduation"));
        assert!(instruction_source("graduate_market").contains("apply_graduation"));
        // graduation is the only place a pool is ever created
        assert!(accounts_struct_source("GraduateMarket").contains("LiquidityPool::INIT_SPACE"));
        assert!(accounts_struct_source("GraduateMarket").contains("POOL_VAULT_SEED"));
        assert!(accounts_struct_source("GraduateMarket").contains("POOL_SOL_SEED"));
        for name in ["PoolBuy", "PoolSell", "Buy", "Sell", "MigrateAccount", "GuardianConfig"] {
            assert!(
                !accounts_struct_source(name).contains("INIT_SPACE"),
                "{name} must not create a pool"
            );
        }
    }

    // --- account versioning and migration -------------------------------------------------

    /// The exact bytes a legacy account holds: the payload as it was written before the
    /// version field existed, inside the space the old layout reserved for it.
    fn legacy_account_bytes<T: AnchorSerialize>(
        discriminator: &[u8],
        value: &T,
        total_len: usize,
    ) -> Vec<u8> {
        let mut payload = borsh::to_vec(value).unwrap();
        payload.pop(); // the appended version byte did not exist yet
        assert!(8 + payload.len() <= total_len, "legacy layout is too small");
        let mut data = vec![0u8; total_len];
        data[..8].copy_from_slice(discriminator);
        data[8..8 + payload.len()].copy_from_slice(&payload);
        data
    }

    /// migrate_account may only ever append: every byte that already existed keeps its
    /// exact value, so no reserve, balance or fee bucket can move through a migration.
    #[test]
    fn migration_preserves_every_existing_byte() {
        let mut mine = test_mine(1_234_567);
        mine.remaining_discovery_reserve = 765_432;
        mine.cumulative_distributed = 42;
        mine.version = 0;
        let payload_len = borsh::to_vec(&mine).unwrap().len();
        let old_space = 8 + Mine::INIT_SPACE - 1;
        let old = legacy_account_bytes(Mine::DISCRIMINATOR, &mine, old_space);
        assert!(
            8 + payload_len - 1 < old.len(),
            "this legacy account is meant to have slack"
        );

        let new_len = 8 + Mine::INIT_SPACE;
        let upgraded = upgraded_account_data(ACCOUNT_KIND_MINE, &old, new_len).unwrap();
        assert_eq!(upgraded.len(), new_len);
        assert_eq!(&upgraded[..8], Mine::DISCRIMINATOR);
        // every byte the account already carried is untouched ...
        assert_eq!(&upgraded[..8 + payload_len - 1], &old[..8 + payload_len - 1]);
        // ... and the only byte that changed is the version, where the account ended
        assert_eq!(upgraded[8 + payload_len - 1], ACCOUNT_VERSION);
        assert!(upgraded[8 + payload_len..].iter().all(|byte| *byte == 0));

        let migrated = Mine::try_deserialize(&mut &upgraded[..]).unwrap();
        assert_eq!(migrated.remaining_reserve, 1_234_567);
        assert_eq!(migrated.remaining_discovery_reserve, 765_432);
        assert_eq!(migrated.cumulative_distributed, 42);
        assert_eq!(migrated.total_supply, mine.total_supply);
        assert_eq!(migrated.creator, mine.creator);
        assert_eq!(migrated.name, mine.name);
        assert_eq!(migrated.version, ACCOUNT_VERSION);

        // an account already on the current layout is a no-op, never a resize
        assert_err(
            upgraded_account_data(ACCOUNT_KIND_MINE, &upgraded, new_len).map(|_| ()),
            DiggoError::AccountAlreadyCurrent,
        );
        // and a migration cannot be aimed at a size the program does not know
        assert_err(
            upgraded_account_data(ACCOUNT_KIND_MINE, &old, old_space).map(|_| ()),
            DiggoError::InvalidAccountLayout,
        );
        assert_err(
            upgraded_account_data(ACCOUNT_KIND_MINE, &[0u8; 4], new_len).map(|_| ()),
            DiggoError::InvalidAccountLayout,
        );
    }

    /// A mine whose variable-length fields are at their maximum leaves no slack at all in
    /// its account, which is the case a naive tail write would miss.
    #[test]
    fn migration_handles_an_account_with_no_spare_bytes() {
        let mut mine = test_mine(999);
        mine.name = "N".repeat(MAX_NAME_LEN);
        mine.symbol = "S".repeat(MAX_SYMBOL_LEN);
        mine.uri = "u".repeat(MAX_URI_LEN);
        mine.version = 0;
        let payload_len = borsh::to_vec(&mine).unwrap().len();
        let old_space = 8 + Mine::INIT_SPACE - 1;
        let old = legacy_account_bytes(Mine::DISCRIMINATOR, &mine, old_space);
        assert_eq!(8 + payload_len - 1, old.len(), "this account is full");

        let upgraded = upgraded_account_data(ACCOUNT_KIND_MINE, &old, 8 + Mine::INIT_SPACE).unwrap();
        let migrated = Mine::try_deserialize(&mut &upgraded[..]).unwrap();
        assert_eq!(migrated.remaining_reserve, 999);
        assert_eq!(migrated.version, ACCOUNT_VERSION);
        assert_eq!(migrated.name.len(), MAX_NAME_LEN);
        assert_eq!(migrated.uri, mine.uri);
    }

    /// The protocol config itself migrates the same way, which is what lets the guardian
    /// bootstrap the rest of the deployment from the raw guardian field.
    #[test]
    fn protocol_config_migrates_without_losing_configuration() {
        let mut protocol = test_protocol();
        protocol.treasury = Pubkey::new_unique();
        protocol.keeper = Pubkey::new_unique();
        protocol.guardian = Pubkey::new_unique();
        protocol.creator_fee_bps = 77;
        protocol.discovery_payouts_paused = true;
        protocol.version = 0;
        let old = legacy_account_bytes(
            ProtocolConfig::DISCRIMINATOR,
            &protocol,
            8 + ProtocolConfig::INIT_SPACE - 1,
        );

        let upgraded =
            upgraded_account_data(ACCOUNT_KIND_PROTOCOL, &old, 8 + ProtocolConfig::INIT_SPACE)
                .unwrap();
        let after = ProtocolConfig::try_deserialize(&mut &upgraded[..]).unwrap();
        assert_eq!(after.treasury, protocol.treasury);
        assert_eq!(after.keeper, protocol.keeper);
        assert_eq!(after.guardian, protocol.guardian);
        assert_eq!(after.creator_fee_bps, 77);
        assert!(after.discovery_payouts_paused);
        assert_eq!(after.bump, protocol.bump);
        assert_eq!(after.version, ACCOUNT_VERSION);
    }

    /// A market's fee buckets and curve reserves survive a migration untouched, and the
    /// migrated account is readable by the current struct.
    #[test]
    fn migration_cannot_change_reserves_or_fee_buckets() {
        let mut market = test_market();
        market.creator_fee_claimable = 111;
        market.platform_fee_claimable = 222;
        market.sol_reserve = 333;
        market.token_reserve = 444;
        market.version = 0;
        let old = legacy_account_bytes(
            LaunchMarket::DISCRIMINATOR,
            &market,
            8 + LaunchMarket::INIT_SPACE - 1,
        );

        let upgraded =
            upgraded_account_data(ACCOUNT_KIND_MARKET, &old, 8 + LaunchMarket::INIT_SPACE).unwrap();
        let after = LaunchMarket::try_deserialize(&mut &upgraded[..]).unwrap();
        assert_eq!(after.sol_reserve, 333);
        assert_eq!(after.token_reserve, 444);
        assert_eq!(after.creator_fee_claimable, 111);
        assert_eq!(after.platform_fee_claimable, 222);
        assert!(!after.graduated);
        assert_eq!(after.version, ACCOUNT_VERSION);

        // a migration can never be pointed at a layout the account does not have
        assert_err(
            upgraded_account_data(ACCOUNT_KIND_MINE, &old, 8 + Mine::INIT_SPACE).map(|_| ()),
            DiggoError::InvalidAccountLayout,
        );
    }

    /// migrate_account reads the guardian straight out of the raw protocol bytes, because
    /// the protocol account is the one account that may itself be awaiting migration. This
    /// pins that offset to the real serialized layout.
    #[test]
    fn protocol_guardian_offset_matches_the_layout() {
        let mut protocol = test_protocol();
        protocol.treasury = Pubkey::new_unique();
        protocol.keeper = Pubkey::new_unique();
        protocol.guardian = Pubkey::new_unique();
        let mut bytes = ProtocolConfig::DISCRIMINATOR.to_vec();
        bytes.extend_from_slice(&borsh::to_vec(&protocol).unwrap());

        assert_eq!(&bytes[..8], ProtocolConfig::DISCRIMINATOR);
        assert_eq!(&bytes[8..40], protocol.treasury.as_ref());
        assert_eq!(&bytes[40..72], protocol.keeper.as_ref());
        assert_eq!(
            &bytes[PROTOCOL_GUARDIAN_OFFSET..PROTOCOL_GUARDIAN_OFFSET + 32],
            protocol.guardian.as_ref()
        );
        assert_eq!(PROTOCOL_GUARDIAN_OFFSET, 8 + 32 + 32);

        // and migrate_account's guardian gate reads exactly that field
        assert_eq!(guardian_from_raw_protocol(&bytes).unwrap(), protocol.guardian);

        let mut tampered = bytes.clone();
        tampered[PROTOCOL_GUARDIAN_OFFSET] ^= 0xff;
        assert_ne!(guardian_from_raw_protocol(&tampered).unwrap(), protocol.guardian);

        let mut truncated = bytes.clone();
        truncated.truncate(PROTOCOL_GUARDIAN_OFFSET + 31);
        assert_err(
            guardian_from_raw_protocol(&truncated).map(|_| ()),
            DiggoError::InvalidAccountLayout,
        );

        let mut other_type = bytes.clone();
        other_type[..8].copy_from_slice(Mine::DISCRIMINATOR);
        assert_err(
            guardian_from_raw_protocol(&other_type).map(|_| ()),
            DiggoError::InvalidAccountLayout,
        );
    }

    /// migrate_account is guardian-only: the only authority it accepts is the one stored in
    /// the protocol account, and its account set holds nothing that could move a balance.
    #[test]
    fn migrate_account_is_guardian_only_and_holds_nothing_spendable() {
        let body = instruction_source("migrate_account");
        assert!(body.contains("guardian_from_raw_protocol"));
        assert!(body.contains("InvalidGuardian"));
        assert!(body.contains("MigrationNeedsFunding"));
        assert!(body.contains("resize"));
        // the handler reallocates and rewrites bytes; it never moves value
        assert!(!body.contains("try_borrow_mut_lamports"));
        assert!(!body.contains("transfer_checked"));
        assert!(!body.contains("system_program::transfer"));

        let accounts = accounts_struct_source("MigrateAccount");
        assert!(accounts.contains("Signer"));
        assert!(!accounts.contains("InterfaceAccount"));
        assert!(!accounts.contains("TokenAccount"));
        assert!(!accounts.contains("system_program"));
        assert!(!accounts.contains("LiquidityPool"));
    }

    /// Every migratable kind resolves to a real discriminator and the current layout size,
    /// and an unknown kind is rejected instead of guessed at.
    #[test]
    fn account_layouts_are_explicit_and_unknown_kinds_are_rejected() {
        let (protocol_disc, protocol_len) = account_layout(ACCOUNT_KIND_PROTOCOL).unwrap();
        assert_eq!(protocol_disc, ProtocolConfig::DISCRIMINATOR);
        assert_eq!(protocol_len, 8 + ProtocolConfig::INIT_SPACE);

        let (mine_disc, mine_len) = account_layout(ACCOUNT_KIND_MINE).unwrap();
        assert_eq!(mine_disc, Mine::DISCRIMINATOR);
        assert_eq!(mine_len, 8 + Mine::INIT_SPACE);

        let (market_disc, market_len) = account_layout(ACCOUNT_KIND_MARKET).unwrap();
        assert_eq!(market_disc, LaunchMarket::DISCRIMINATOR);
        assert_eq!(market_len, 8 + LaunchMarket::INIT_SPACE);

        assert_ne!(protocol_disc, mine_disc);
        assert_ne!(mine_disc, market_disc);
        assert_ne!(protocol_disc, market_disc);

        // every layout is large enough for the values it can actually hold
        assert!(8 + borsh::to_vec(&test_protocol()).unwrap().len() <= protocol_len);
        assert!(8 + borsh::to_vec(&test_mine(0)).unwrap().len() <= mine_len);
        assert!(8 + borsh::to_vec(&test_market()).unwrap().len() <= market_len);

        assert_err(
            account_layout(ACCOUNT_KIND_MARKET + 1).map(|_| ()),
            DiggoError::UnsupportedAccountKind,
        );
    }

    /// The version byte is the last field of every migratable account, which is what makes
    /// the append-only migration possible in the first place.
    #[test]
    fn version_is_appended_after_every_existing_field() {
        let mine = borsh::to_vec(&test_mine(0)).unwrap();
        assert_eq!(*mine.last().unwrap(), ACCOUNT_VERSION);
        let market = borsh::to_vec(&test_market()).unwrap();
        assert_eq!(*market.last().unwrap(), ACCOUNT_VERSION);
        let protocol = borsh::to_vec(&test_protocol()).unwrap();
        assert_eq!(*protocol.last().unwrap(), ACCOUNT_VERSION);
    }

    /// Spec 36: the pool's own layout is fixed and every account it references is a field,
    /// so there is nothing for an upgrade to add to it silently.
    #[test]
    fn pool_layout_is_fixed_size_and_self_describing() {
        assert_eq!(
            LiquidityPool::INIT_SPACE,
            32 * 4 + 8 + 8 + 8 + 1,
            "mine, mint, token_vault, sol_vault, both reserves, graduated_at, bump"
        );
        assert_eq!(PoolSolVault::INIT_SPACE, 32 + 1);
        assert_eq!(POOL_SEED, b"pool");
        assert_eq!(POOL_VAULT_SEED, b"pool-vault");
        assert_eq!(POOL_SOL_SEED, b"pool-sol");
    }

}
