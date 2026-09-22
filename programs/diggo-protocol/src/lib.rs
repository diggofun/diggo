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
        if !market.graduated && market.sol_reserve >= market.graduation_target {
            market.graduated = true;
            ctx.accounts.mine.status = MineStatus::MiningActive;
            emit!(MarketGraduated {
                mint: ctx.accounts.mint.key(),
                sol_reserve: market.sol_reserve
            });
        }
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
        sync_mine(&mut ctx.accounts.mine, now)?;
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
        sync_mine(&mut ctx.accounts.mine, now)?;
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

    pub fn advance_mine(ctx: Context<AdvanceMine>) -> Result<()> {
        sync_mine(&mut ctx.accounts.mine, Clock::get()?.unix_timestamp)
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
        sync_mine(&mut ctx.accounts.mine, now)?;
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
        sync_mine(&mut ctx.accounts.mine, now)?;
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

fn sync_mine(mine: &mut Mine, now: i64) -> Result<()> {
    if mine.status != MineStatus::MiningActive
        || now < mine.next_block_at
        || mine.remaining_reserve == 0
        || mine.total_power == 0
    {
        return Ok(());
    }
    let mut segments = 0usize;
    while now >= mine.next_block_at && mine.remaining_reserve > 0 {
        require!(segments < MAX_SYNC_SEGMENTS, DiggoError::SyncWindowTooLarge);
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
    Ok(())
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

    /// The source of one instruction handler, from its signature to the next one. Used
    /// below to pin the fact that the trading paths never consult a circuit breaker.
    fn instruction_source(name: &str) -> &'static str {
        let src = include_str!("lib.rs");
        let start = src
            .find(&format!("pub fn {name}("))
            .expect("instruction handler exists");
        let rest = &src[start..];
        let end = rest[1..]
            .find("\n    pub fn ")
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
}
