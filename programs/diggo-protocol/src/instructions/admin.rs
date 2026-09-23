//! Protocol configuration and the timelocked admin surface (design 6, 8.2). WS-B owns this file.

use crate::*;

/// Everything initialize_protocol seeds. All of it becomes a ProtocolConfig field, so a
/// reviewer reads the whole economic surface out of one account and the timelock is the only
/// path to a change.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ProtocolConfigArgs {
    pub creator_fee_bps: u16,
    pub platform_fee_bps: u16,
    pub crank_pool_fee_bps: u16,
    pub discovery_max_bps: u16,
    pub discovery_epoch_budget_bps: u16,
    pub starter_efficiency_bps: u16,
    pub starter_tranche_bps: u16,
    pub bond_lamports: u64,
    pub bond_cooldown_seconds: i64,
    pub epoch_seed_delay_slots: u64,
    pub epoch_seed_max_lateness_slots: u64,
    pub min_curve_mining_blocks: u64,
    pub discovery_daily_cap_lamports: u64,
    pub discovery_weekly_cap_lamports: u64,
    pub discovery_global_daily_cap_lamports: u64,
    pub discovery_epoch_budget_lamports: u64,
    pub rarity_tiers: Vec<RarityTier>,
    pub timelock_seconds: i64,
}

#[derive(Accounts)]
pub struct InitializeProtocol<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, space = ProtocolConfig::SIZE, seeds = [PROTOCOL_SEED], bump)]
    pub protocol: Account<'info, ProtocolConfig>,
    /// Fixed treasury destination. No instruction anywhere takes a destination argument.
    #[account(seeds = [TREASURY_SEED], bump)]
    pub treasury: SystemAccount<'info>,
    /// Automated keeper key. The referral instruction requires this exact signer; the crank
    /// tip still settles to the fixed crank-pool PDA in sweep_fees.
    /// CHECK: stored as a keeper identity and constrained by the referral handler when used.
    pub crank_pool: UncheckedAccount<'info>,
    /// The program account itself.
    ///
    /// The pair (program, program_data) is how this instruction proves its signer is the
    /// program's upgrade authority. Without it the first caller to reach a fresh deployment
    /// would become the protocol authority, which is total control of every parameter in the
    /// account: the deployment order therefore has to be "create the multisig, hand it the
    /// program upgrade authority, then initialize", and not the other way round.
    /// CHECK: constrained to exactly this program's address.
    #[account(address = crate::ID)]
    pub program: AccountInfo<'info>,
    #[account(constraint = program_data.key() == program_data_address()?)]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

/// The ProgramData account of this program, under the upgradeable loader.
pub fn program_data_address() -> Result<Pubkey> {
    let (address, _) = Pubkey::find_program_address(&[crate::ID.as_ref()], &ProgramData::owner());
    Ok(address)
}

/// The only signer any admin instruction accepts: the protocol authority (Squads 2-of-3).
#[derive(Accounts)]
pub struct AdminConfig<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [PROTOCOL_SEED], bump = protocol.bump, has_one = authority)]
    pub protocol: Account<'info, ProtocolConfig>,
}

#[derive(Accounts)]
pub struct SetCurveTable<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [PROTOCOL_SEED], bump = protocol.bump, has_one = authority)]
    /// Boxed for the same frame reason as `curve_table` below (WS-A, frame fix).
    pub protocol: Box<Account<'info, ProtocolConfig>>,
    #[account(
        init_if_needed,
        payer = authority,
        space = CurveTable::SIZE,
        seeds = [CURVE_TABLE_SEED],
        bump,
    )]
    /// Boxed: `Account` holds its value inline, so a 2,410-byte account would sit inside this
    /// struct's stack frame and push `try_accounts` past the SBF frame limit (WS-A, frame fix).
    pub curve_table: Box<Account<'info, CurveTable>>,
    pub system_program: Program<'info, System>,
}

pub fn initialize_protocol(ctx: Context<InitializeProtocol>, config: ProtocolConfigArgs) -> Result<()> {
    let authority = ctx.accounts.authority.key();
    // Only the upgrade authority may seed the protocol, and only once: the PDA is created here
    // and never again.
    require!(
        ctx.accounts.program_data.upgrade_authority_address == Some(authority),
        DiggoError::UnauthorizedInitializer
    );
    let config = config;
    require!(
        config.rarity_tiers.len() <= MAX_RARITY_TIERS,
        DiggoError::InvalidRarityTable
    );
    validate_rarity_table(&config.rarity_tiers)?;

    let protocol = &mut ctx.accounts.protocol;
    protocol.authority = authority;
    protocol.treasury = ctx.accounts.treasury.key();
    protocol.crank_pool = ctx.accounts.crank_pool.key();
    protocol.creator_fee_bps = config.creator_fee_bps;
    protocol.platform_fee_bps = config.platform_fee_bps;
    protocol.crank_pool_fee_bps = config.crank_pool_fee_bps;
    protocol.discovery_max_bps = config.discovery_max_bps;
    protocol.discovery_epoch_budget_bps = config.discovery_epoch_budget_bps;
    protocol.starter_efficiency_bps = config.starter_efficiency_bps;
    protocol.starter_tranche_bps = config.starter_tranche_bps;
    protocol.bond_lamports = config.bond_lamports;
    protocol.bond_cooldown_seconds = config.bond_cooldown_seconds;
    protocol.epoch_seed_delay_slots = config.epoch_seed_delay_slots;
    protocol.epoch_seed_max_lateness_slots = config.epoch_seed_max_lateness_slots;
    protocol.min_curve_mining_blocks = config.min_curve_mining_blocks;
    protocol.discovery_daily_cap_lamports = config.discovery_daily_cap_lamports;
    protocol.discovery_weekly_cap_lamports = config.discovery_weekly_cap_lamports;
    protocol.discovery_global_daily_cap_lamports = config.discovery_global_daily_cap_lamports;
    protocol.discovery_epoch_budget_lamports = config.discovery_epoch_budget_lamports;
    let tier_count = config.rarity_tiers.len();
    for (slot, tier) in protocol
        .rarity_tiers
        .iter_mut()
        .zip(config.rarity_tiers.iter().copied())
    {
        *slot = tier;
    }
    protocol.rarity_tier_count = tier_count as u8;
    protocol.timelock_seconds = config.timelock_seconds;
    protocol.paused_flags = 0;
    protocol.paused_until = 0;
    protocol.bump = ctx.bumps.protocol;
    protocol.version = ACCOUNT_VERSION;
    protocol.validate()?;

    emit!(ProtocolInitialized {
        authority,
        treasury: protocol.treasury,
        crank_pool: protocol.crank_pool,
        version: protocol.version,
    });
    Ok(())
}

/// Bounded by MAX_TRADING_FEE_BPS, and the three shares must sum to at most it.
pub fn update_fee_config(
    ctx: Context<AdminConfig>,
    creator_fee_bps: u16,
    platform_fee_bps: u16,
    crank_pool_fee_bps: u16,
) -> Result<()> {
    let protocol = &mut ctx.accounts.protocol;
    protocol.creator_fee_bps = creator_fee_bps;
    protocol.platform_fee_bps = platform_fee_bps;
    protocol.crank_pool_fee_bps = crank_pool_fee_bps;
    protocol.validate()
}

/// Every cap is in lamports of SOL, never in USD (design 4.3).
pub fn update_discovery_limits(
    ctx: Context<AdminConfig>,
    discovery_max_bps: u16,
    discovery_epoch_budget_bps: u16,
    daily_cap_lamports: u64,
    weekly_cap_lamports: u64,
    global_daily_cap_lamports: u64,
    epoch_budget_lamports: u64,
) -> Result<()> {
    let protocol = &mut ctx.accounts.protocol;
    protocol.discovery_max_bps = discovery_max_bps;
    protocol.discovery_epoch_budget_bps = discovery_epoch_budget_bps;
    protocol.discovery_daily_cap_lamports = daily_cap_lamports;
    protocol.discovery_weekly_cap_lamports = weekly_cap_lamports;
    protocol.discovery_global_daily_cap_lamports = global_daily_cap_lamports;
    protocol.discovery_epoch_budget_lamports = epoch_budget_lamports;
    protocol.validate()
}

/// At most MAX_RARITY_TIERS tiers, cumulative, the last live one at exactly BPS.
pub fn set_rarity_table(ctx: Context<AdminConfig>, tiers: Vec<RarityTier>) -> Result<()> {
    require!(
        tiers.len() <= MAX_RARITY_TIERS,
        DiggoError::InvalidRarityTable
    );
    validate_rarity_table(&tiers)?;
    let protocol = &mut ctx.accounts.protocol;
    for slot in protocol.rarity_tiers.iter_mut() {
        *slot = RarityTier::default();
    }
    for (slot, tier) in protocol.rarity_tiers.iter_mut().zip(tiers.iter()) {
        *slot = *tier;
    }
    protocol.rarity_tier_count = tiers.len() as u8;
    Ok(())
}

/// Writes the optional curve-table override. While no override exists every instruction falls
/// back to the compiled-in tables in math/power.rs.
pub fn set_curve_table(
    ctx: Context<SetCurveTable>,
    power: Vec<u32>,
    upgrade_ore_cost: Vec<Vec<u32>>,
) -> Result<()> {
    validate_curve_table(&power, &upgrade_ore_cost)?;
    write_curve_table(
        &mut ctx.accounts.curve_table,
        &power,
        &upgrade_ore_cost,
        ctx.bumps.curve_table,
    );
    Ok(())
}

/// Bounds the two tables a governance balance pass may publish.
pub fn validate_curve_table(power: &[u32], upgrade_ore_cost: &[Vec<u32>]) -> Result<()> {
    require!(
        power.len() == CURVE_TABLE_POWER_LEN,
        DiggoError::InvalidCurveTable
    );
    require!(
        upgrade_ore_cost.len() == CREW_COMPONENTS
            && upgrade_ore_cost
                .iter()
                .all(|row| row.len() == CURVE_TABLE_POWER_LEN),
        DiggoError::InvalidCurveTable
    );
    // Power is monotonic in level: a table that fell as a component levelled up would pay a
    // player less for playing more, which is the one shape a curve table may never have.
    require!(
        power.windows(2).all(|pair| pair[1] >= pair[0]),
        DiggoError::InvalidCurveTable
    );
    Ok(())
}

/// Copies the tables into the account.
///
/// It lives in its own frame, marked so the compiler keeps it out of the handler's: the account
/// is 2,402 bytes and the SBF stack checker reports a copy whose destination sits in the
/// caller's own frame as one that "overwrites values in the frame".
#[inline(never)]
fn write_curve_table(
    table: &mut CurveTable,
    power: &[u32],
    upgrade_ore_cost: &[Vec<u32>],
    bump: u8,
) {
    for (slot, value) in table.power.iter_mut().zip(power.iter()) {
        *slot = *value;
    }
    for (component, row) in upgrade_ore_cost.iter().enumerate() {
        for (level, value) in row.iter().enumerate() {
            table.upgrade_ore_cost[component][level] = *value;
        }
    }
    table.bump = bump;
    table.version = ACCOUNT_VERSION;
}

/// A pause must expire within MAX_PAUSE_SECONDS; extending past that needs the timelock.
pub fn schedule_pause(ctx: Context<AdminConfig>, flag: u8, paused_until: i64) -> Result<()> {
    require!(
        flag != 0 && flag & !PAUSE_FLAGS_ALL == 0,
        DiggoError::ConfigOutOfBounds
    );
    let now = Clock::get()?.unix_timestamp;
    require!(paused_until > now, DiggoError::InvalidPauseWindow);
    // A pause may never be scheduled further out than the protocol bound. Extending one past it
    // is a change to the bound itself, which is a governance parameter like any other.
    require!(
        paused_until <= now.saturating_add(MAX_PAUSE_SECONDS),
        DiggoError::InvalidPauseWindow
    );
    let protocol = &mut ctx.accounts.protocol;
    protocol.paused_flags |= flag;
    protocol.paused_until = paused_until;
    Ok(())
}

/// Permissionless once paused_until has passed. No pause can block a bond withdrawal or a
/// reward claim.
pub fn unpause(ctx: Context<AdminConfig>, flag: u8) -> Result<()> {
    require!(
        flag != 0 && flag & !PAUSE_FLAGS_ALL == 0,
        DiggoError::ConfigOutOfBounds
    );
    let now = Clock::get()?.unix_timestamp;
    let protocol = &mut ctx.accounts.protocol;
    // The expiry is what actually ends a pause, so clearing the flag early is refused and
    // clearing it late is a formality. That is what makes a pause self-expiring: no instruction
    // anywhere treats a flag past its window as set, whether or not anyone clears the bit.
    require!(now >= protocol.paused_until, DiggoError::NotTimelocked);
    protocol.paused_flags &= !flag;
    if protocol.paused_flags == 0 {
        protocol.paused_until = 0;
    }
    Ok(())
}
