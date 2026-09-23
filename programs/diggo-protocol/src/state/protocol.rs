//! state::protocol.rs (phase 0a mechanical split of lib.rs).

use crate::*;



#[account]
#[derive(InitSpace)]
pub struct ProtocolConfigV4 {
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

// ---- v2 (docs/ONCHAIN_V2_DESIGN.md 3.1, 4.3, 8.2) ----------------------------------------

/// One rarity tier. Cumulative, so tier selection is a single walk of the table and the
/// last live tier's cumulative chance must be BPS.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, PartialEq, Eq, Debug)]
pub struct RarityTier {
    pub cumulative_chance_bps: u16,
    pub value_lamports: u64,
    pub min_eligibility_score: u16,
    pub min_liquidity_lamports: u64,
    pub min_volume_lamports: u64,
}

impl RarityTier {
    /// Borsh body length of one tier.
    pub const LEN: usize = 2 + 8 + 2 + 8 + 8;
}

/// The one protocol account: a PDA under [b"protocol"], holding every parameter that used to
/// be a constant an operator could only change by redeploying.
///
/// Every value-bearing parameter is a field here rather than a hard-coded constant, so the
/// timelock is the only path to a change and a reviewer can read the whole economic surface of
/// the program out of one account.
#[account]
#[derive(Default)]
pub struct ProtocolConfig {
    /// Squads 2-of-3 multisig: the program upgrade authority and the only signer the
    /// timelocked admin instructions accept.
    pub authority: Pubkey,
    /// Fixed destination of the platform share. No instruction takes a destination argument.
    pub treasury: Pubkey,
    /// Fixed destination of the crank-tip share.
    pub crank_pool: Pubkey,
    pub creator_fee_bps: u16,
    pub platform_fee_bps: u16,
    pub crank_pool_fee_bps: u16,
    /// Per-call discovery ceiling, in bps of a coin's total Discovery Reserve.
    pub discovery_max_bps: u16,
    /// Per-coin per-epoch discovery budget, in bps of the total Discovery Reserve.
    pub discovery_epoch_budget_bps: u16,
    /// Mining efficiency of an unbonded player, in bps of the same maturity-adjusted power.
    pub starter_efficiency_bps: u16,
    /// Ceiling on the starter tranche's share of one block's reward, in bps.
    pub starter_tranche_bps: u16,
    pub bond_lamports: u64,
    pub bond_cooldown_seconds: i64,
    pub epoch_seed_delay_slots: u64,
    pub epoch_seed_max_lateness_slots: u64,
    pub min_curve_mining_blocks: u64,
    /// Discovery caps in lamports of SOL, never in USD (design 4.3).
    pub discovery_daily_cap_lamports: u64,
    pub discovery_weekly_cap_lamports: u64,
    pub discovery_global_daily_cap_lamports: u64,
    pub discovery_epoch_budget_lamports: u64,
    /// At most MAX_RARITY_TIERS tiers; `rarity_tier_count` says how many are live.
    pub rarity_tiers: [RarityTier; MAX_RARITY_TIERS],
    pub rarity_tier_count: u8,
    /// Timelock a governance transaction must wait out before it may execute.
    pub timelock_seconds: i64,
    /// Bitfield of the narrow, self-expiring pause flags. No pause may block a bond
    /// withdrawal or a reward claim.
    pub paused_flags: u8,
    pub paused_until: i64,
    pub bump: u8,
    pub version: u8,
}

impl ProtocolConfig {
    pub const LEN: usize = 32 * 3
        + 2 * 7
        + 8 * 9
        + RarityTier::LEN * MAX_RARITY_TIERS
        + 1
        + 8
        + 1
        + 8
        + 1
        + 1;
    /// Whole account space, discriminator included.
    pub const SIZE: usize = 8 + Self::LEN;
}

/// Optional override of the compiled-in curve tables, behind the timelock.
///
/// The tables ship as constant data (design section 7), so reading power and upgrade cost
/// costs no account and no compute unit. This account exists only so `set_curve_table` has
/// somewhere to write the day a balance pass needs new numbers; while it is absent, every
/// instruction falls back to the constants in math/power.rs.
#[account]
pub struct CurveTable {
    /// crew_power contribution of one component at level 1..=MAX_CREW_LEVEL.
    pub power: [u32; CURVE_TABLE_POWER_LEN],
    /// Upgrade cost in ORE of component c from level l to l + 1, indexed [c][l - 1].
    pub upgrade_ore_cost: [[u32; CURVE_TABLE_POWER_LEN]; CREW_COMPONENTS],
    pub bump: u8,
    pub version: u8,
}

impl Default for CurveTable {
    fn default() -> Self {
        Self {
            power: [0; CURVE_TABLE_POWER_LEN],
            upgrade_ore_cost: [[0; CURVE_TABLE_POWER_LEN]; CREW_COMPONENTS],
            bump: 0,
            version: 0,
        }
    }
}

impl CurveTable {
    pub const LEN: usize = 4 * CURVE_TABLE_POWER_LEN * (1 + CREW_COMPONENTS) + 1 + 1;
    pub const SIZE: usize = 8 + Self::LEN;
}
