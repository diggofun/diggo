//! instructions::launch.rs (phase 0a mechanical split of lib.rs).

use crate::*;



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
    /// Share of the curve's initial token inventory that pre-graduation mining may emit,
    /// in bps. Snapshotted into the market's immutable curve-mining cap at launch.
    pub curve_mining_bps: u16,
    /// Runway, in whole days, over which that budget is spread. Without a runway a small
    /// cap would be drained in hours and stop being a reward schedule.
    pub curve_mining_runway_days: u16,
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


pub fn validate_launch_args(args: &LaunchTokenArgs, protocol: &ProtocolConfig) -> Result<()> {
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
    // The curve-mining share is the pre-graduation emission budget, in bps of the curve's
    // own initial token inventory. Zero is legal and means the pre-curve behaviour — a
    // mine that only starts paying block rewards once it has graduated — while the ceiling
    // is what keeps a launch from handing the curve phase a share of the inventory that
    // would stop it being a bonding curve at all. The runway is validated here too: a zero
    // runway has no blocks to spread the budget over, and a sprawling one is a typo.
    require!(
        args.curve_mining_bps <= MAX_CURVE_MINING_BPS,
        DiggoError::InvalidCurveMining
    );
    require!(
        args.curve_mining_runway_days >= 1
            && args.curve_mining_runway_days <= MAX_CURVE_MINING_RUNWAY_DAYS,
        DiggoError::InvalidCurveMining
    );
    // A runway is only a schedule if it holds enough blocks to be one. The flat rate is
    // cap / runway_blocks, so a day-long block interval with a day-long runway emits the whole
    // budget at block one: no spread, no price path, and a single-block cliff in the curve's
    // inventory. A launch that asks for a curve share therefore has to give it at least
    // MIN_CURVE_MINING_BLOCKS of runway; asking for no share (0 bps) has no runway to bound.
    if args.curve_mining_bps > 0 {
        require!(
            curve_mining_runway_blocks(args.block_interval, args.curve_mining_runway_days)?
                >= MIN_CURVE_MINING_BLOCKS,
            DiggoError::InvalidCurveMining
        );
    }
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

pub fn launch_token(ctx: Context<LaunchToken>, args: LaunchTokenArgs) -> Result<()> {
    validate_launch_args(&args, &ctx.accounts.protocol)?;

    let reserve_amount = mul_bps(args.total_supply, args.reserve_bps)?;
    let discovery_amount = mul_bps(args.total_supply, args.discovery_reserve_bps)?;
    let market_amount = args
        .total_supply
        .checked_sub(reserve_amount)
        .and_then(|value| value.checked_sub(discovery_amount))
        .ok_or(DiggoError::MathOverflow)?;
    // The curve phase's whole budget, taken as a share of the inventory the curve
    // actually starts with and frozen here for the market's lifetime. Nothing else in
    // the program ever writes curve_mining_cap, and migrate_account can only default it
    // to zero, so the cap a launch publishes is the cap the market is stuck with.
    let curve_mining_cap = mul_bps(market_amount, args.curve_mining_bps)?;
    let curve_mining_block_reward =
        curve_mining_rate(curve_mining_cap, args.block_interval, args.curve_mining_runway_days)?;
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
    // Mining is live from the launch block, not from graduation: while the market is
    // still on its curve the block rewards come out of that curve's own token
    // inventory, so a mined token moves the price exactly where a bought one would.
    // MineStatus::Launching is retained for accounts written before this change, which
    // keep the pre-curve behaviour of a mine that only emits once it has graduated.
    mine.status = MineStatus::MiningActive;
    mine.curve_mining_open = curve_mining_cap > 0;
    // Launch always happens on the curve: the market is created ungraduated in the same
    // instruction, and the walk reads this flag rather than an optional account to decide
    // which side pays.
    mine.graduated = false;
    // No graduation has happened yet, so there is no cursor for the walk to classify
    // against: the whole ledger is curve-phase until graduate_market ends it.
    mine.curve_phase_ends_at = 0;
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
    market.curve_mining_cap = curve_mining_cap;
    market.curve_mining_mined = 0;
    market.curve_mining_unpaid = 0;
    market.curve_mining_block_reward = curve_mining_block_reward;

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
