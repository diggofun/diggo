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
/// Upper bound on power the keeper may push for a single player. Power comes from
/// off-chain Crew progression that is funded only by ORE (a non-transferable game
/// resource) — this cap limits the blast radius of a compromised keeper key rather
/// than expressing any real economic curve.
pub const MAX_KEEPER_POWER: u64 = 10_000_000;

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
        protocol.reserve_bps = DEFAULT_RESERVE_BPS;
        protocol.discovery_reserve_bps = DEFAULT_DISCOVERY_RESERVE_BPS;
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
        mine.bump = mine_bump;

        let market = &mut ctx.accounts.market;
        market.mine = mine.key();
        market.token_reserve = market_amount;
        market.sol_reserve = 0;
        market.virtual_sol_reserve = args.virtual_sol_reserve;
        market.graduation_target = args.graduation_target;
        market.graduated = false;
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

    pub fn buy(ctx: Context<Buy>, sol_in: u64, min_tokens_out: u64) -> Result<()> {
        require!(sol_in > 0, DiggoError::InvalidAmount);
        let tokens_out = quote_buy(
            ctx.accounts.market.token_reserve,
            ctx.accounts.market.sol_reserve,
            ctx.accounts.market.virtual_sol_reserve,
            sol_in,
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
            .checked_add(sol_in)
            .ok_or(DiggoError::MathOverflow)?;
        market.token_reserve = market
            .token_reserve
            .checked_sub(tokens_out)
            .ok_or(DiggoError::MathOverflow)?;
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
        });
        Ok(())
    }

    pub fn sell(ctx: Context<Sell>, tokens_in: u64, min_sol_out: u64) -> Result<()> {
        require!(tokens_in > 0, DiggoError::InvalidAmount);
        let sol_out = quote_sell(
            ctx.accounts.market.token_reserve,
            ctx.accounts.market.sol_reserve,
            ctx.accounts.market.virtual_sol_reserve,
            tokens_in,
        )?;
        require!(
            sol_out >= min_sol_out && sol_out > 0,
            DiggoError::SlippageExceeded
        );
        require!(
            sol_out <= ctx.accounts.market.sol_reserve,
            DiggoError::InsufficientLiquidity
        );

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
        require!(available >= sol_out, DiggoError::InsufficientLiquidity);
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
            .checked_sub(sol_out)
            .ok_or(DiggoError::MathOverflow)?;
        market.token_reserve = market
            .token_reserve
            .checked_add(tokens_in)
            .ok_or(DiggoError::MathOverflow)?;
        emit!(TradeExecuted {
            mint: ctx.accounts.mint.key(),
            trader: ctx.accounts.seller.key(),
            side: 1,
            token_amount: tokens_in,
            sol_amount: sol_out,
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

    pub fn claim_rewards(ctx: Context<ClaimRewards>) -> Result<()> {
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
        require!(new_power <= MAX_KEEPER_POWER, DiggoError::PowerOutOfRange);
        let now = Clock::get()?.unix_timestamp;
        sync_mine(&mut ctx.accounts.mine, now)?;
        settle_position(&mut ctx.accounts.position, &ctx.accounts.mine)?;

        let mine = &mut ctx.accounts.mine;
        let player = &mut ctx.accounts.player;
        let old_power = player.power;
        player.power = new_power;
        if player.active_mine == mine.key() {
            mine.total_power = mine
                .total_power
                .checked_sub(old_power)
                .and_then(|value| value.checked_add(new_power))
                .ok_or(DiggoError::MathOverflow)?;
            ctx.accounts.position.assigned_power = new_power;
            ctx.accounts.position.last_reward_index = mine.reward_index;
        }
        emit!(CrewPowerSynced {
            owner: ctx.accounts.player.owner,
            mint: ctx.accounts.mint.key(),
            power: new_power,
        });
        Ok(())
    }

    /// Pays out a server-authoritative random memecoin discovery from the
    /// Discovery Reserve. Only the protocol keeper may call this, and only
    /// after the backend's eligibility, budget and anti-abuse checks pass —
    /// this instruction performs no RNG or eligibility logic itself.
    pub fn claim_discovery(ctx: Context<ClaimDiscovery>, amount: u64) -> Result<()> {
        require!(amount > 0, DiggoError::InvalidAmount);
        let mine = &mut ctx.accounts.mine;
        mine.remaining_discovery_reserve = mine
            .remaining_discovery_reserve
            .checked_sub(amount)
            .ok_or(DiggoError::InsufficientDiscoveryReserve)?;
        transfer_from_mine(
            &ctx.accounts.token_program,
            &ctx.accounts.mint,
            &ctx.accounts.discovery_vault,
            &ctx.accounts.recipient_tokens,
            mine,
            amount,
        )?;
        emit!(DiscoveryClaimed {
            mint: ctx.accounts.mint.key(),
            recipient: ctx.accounts.recipient.key(),
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
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[account]
#[derive(InitSpace)]
pub struct ProtocolConfig {
    pub treasury: Pubkey,
    /// Backend authority permitted to push off-chain Crew power on-chain and
    /// pay out server-approved discoveries. It can never move the launch
    /// market, the treasury, or a player's claimable mining rewards.
    pub keeper: Pubkey,
    pub reserve_bps: u16,
    pub discovery_reserve_bps: u16,
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
    pub power: u64,
}
#[event]
pub struct DiscoveryClaimed {
    pub mint: Pubkey,
    pub recipient: Pubkey,
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
        mine.remaining_reserve = mine
            .remaining_reserve
            .checked_sub(distributed)
            .ok_or(DiggoError::MathOverflow)?;
        mine.cumulative_distributed = mine
            .cumulative_distributed
            .checked_add(distributed)
            .ok_or(DiggoError::MathOverflow)?;
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
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_mine(remaining_reserve: u64) -> Mine {
        Mine {
            mint: Pubkey::default(),
            creator: Pubkey::default(),
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
            bump: 0,
        }
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
    fn keeper_power_sync_is_bounded() {
        assert!(MAX_KEEPER_POWER > STARTER_POWER);
    }

    #[test]
    fn mine_never_accounts_more_than_the_reserve() {
        let mut mine = test_mine(250);
        sync_mine(&mut mine, 1_500).unwrap();
        assert_eq!(mine.cumulative_distributed, 250);
        assert_eq!(mine.remaining_reserve, 0);
        assert!(mine.status == MineStatus::FullyMined);
    }
}
