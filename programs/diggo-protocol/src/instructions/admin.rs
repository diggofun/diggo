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
    /// Fixed crank-tip destination.
    #[account(seeds = [CRANK_POOL_SEED], bump)]
    pub crank_pool: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
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
    pub protocol: Account<'info, ProtocolConfig>,
    #[account(
        init_if_needed,
        payer = authority,
        space = CurveTable::SIZE,
        seeds = [CURVE_TABLE_SEED],
        bump,
    )]
    pub curve_table: Account<'info, CurveTable>,
    pub system_program: Program<'info, System>,
}

pub fn initialize_protocol(_ctx: Context<InitializeProtocol>, _config: ProtocolConfigArgs) -> Result<()> {
    err!(DiggoError::NotImplemented)
}

/// Bounded by MAX_TRADING_FEE_BPS, and the three shares must sum to at most it.
pub fn update_fee_config(
    _ctx: Context<AdminConfig>,
    _creator_fee_bps: u16,
    _platform_fee_bps: u16,
    _crank_pool_fee_bps: u16,
) -> Result<()> {
    err!(DiggoError::NotImplemented)
}

/// Every cap is in lamports of SOL, never in USD (design 4.3).
pub fn update_discovery_limits(
    _ctx: Context<AdminConfig>,
    _discovery_max_bps: u16,
    _discovery_epoch_budget_bps: u16,
    _daily_cap_lamports: u64,
    _weekly_cap_lamports: u64,
    _global_daily_cap_lamports: u64,
    _epoch_budget_lamports: u64,
) -> Result<()> {
    err!(DiggoError::NotImplemented)
}

/// At most MAX_RARITY_TIERS tiers, cumulative, the last live one at exactly BPS.
pub fn set_rarity_table(_ctx: Context<AdminConfig>, _tiers: Vec<RarityTier>) -> Result<()> {
    err!(DiggoError::NotImplemented)
}

/// Writes the optional curve-table override. While no override exists every instruction falls
/// back to the compiled-in tables in math/power.rs.
pub fn set_curve_table(
    _ctx: Context<SetCurveTable>,
    _power: Vec<u32>,
    _upgrade_ore_cost: Vec<Vec<u32>>,
) -> Result<()> {
    err!(DiggoError::NotImplemented)
}

/// A pause must expire within MAX_PAUSE_SECONDS; extending past that needs the timelock.
pub fn schedule_pause(_ctx: Context<AdminConfig>, _flag: u8, _paused_until: i64) -> Result<()> {
    err!(DiggoError::NotImplemented)
}

/// Permissionless once paused_until has passed. No pause can block a bond withdrawal or a
/// reward claim.
pub fn unpause(_ctx: Context<AdminConfig>, _flag: u8) -> Result<()> {
    err!(DiggoError::NotImplemented)
}

