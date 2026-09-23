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
    /// Retired: every player mines at full efficiency, so nothing reads this. The field stays
    /// because the layout is frozen.
    pub starter_efficiency_bps: u16,
    /// Ceiling on the starter tranche's share of one block's reward, in bps. Still live, but
    /// only for a position armed before the bond was retired: every new position is the full
    /// tranche.
    pub starter_tranche_bps: u16,
    /// Retired: no new bond may be posted, no tranche, power or eligibility reads one, and the
    /// legacy withdrawal returns whatever is already parked. Nothing reads this, so it carries
    /// no threshold. The field stays because the layout is frozen.
    pub bond_lamports: u64,
    /// Cooldown between request_unbond and withdraw_bond. Still enforced, because it is the only
    /// thing standing between a bond posted before the retirement and its withdrawal.
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

/// One durable marker for a (referrer, referee) referral credit.
#[account]
pub struct ReferralCredit {
    pub amount: u64,
    pub bump: u8,
}

impl ReferralCredit {
    pub const SIZE: usize = 8 + 8 + 1;
}

/// The current on-chain referral credit count for one referrer.
#[account]
pub struct ReferralWeek {
    pub week_index: i64,
    pub count: u8,
    pub bump: u8,
}

impl ReferralWeek {
    pub const SIZE: usize = 8 + 8 + 1 + 1;
}

/// Optional override of the compiled-in curve tables, behind the timelock.
///
/// The tables ship as constant data (design section 7), so reading power and upgrade cost
/// costs no account and no compute unit. This account exists only so `set_curve_table` has
/// somewhere to write the day a balance pass needs new numbers; while it is absent, every
/// instruction falls back to the constants in math/power.rs.
#[account]
pub struct CurveTable {
    // Keep fixed arrays on the heap during Borsh decoding. Box serializes exactly as its
    // contents, preserving the account layout while staying below the SBF frame limit.
    /// crew_power contribution of one component at level 1..=MAX_CREW_LEVEL.
    pub power: Box<[u32; CURVE_TABLE_POWER_LEN]>,
    /// Upgrade cost in ORE of component c from level l to l + 1, indexed [c][l - 1].
    pub upgrade_ore_cost: [Box<[u32; CURVE_TABLE_POWER_LEN]>; CREW_COMPONENTS],
    pub bump: u8,
    pub version: u8,
}

impl Default for CurveTable {
    fn default() -> Self {
        Self {
            power: Box::new([0; CURVE_TABLE_POWER_LEN]),
            upgrade_ore_cost: std::array::from_fn(|_| Box::new([0; CURVE_TABLE_POWER_LEN])),
            bump: 0,
            version: 0,
        }
    }
}

impl CurveTable {
    pub const LEN: usize = 4 * CURVE_TABLE_POWER_LEN * (1 + CREW_COMPONENTS) + 1 + 1;
    pub const SIZE: usize = 8 + Self::LEN;
}

// ---- the pause surface (design 6) ----------------------------------------------------------
//
// Every pause is narrow, self-expiring and unable to move value. There is no flag that blocks a
// bond withdrawal or a reward claim: the only thing a pause may stop is a discovery, which is
// the one surface a compromised operator could otherwise drain.

/// Stops create_discovery_roll and settle_discovery. Trading, claims and bond withdrawals are
/// deliberately unaffected.
pub const PAUSE_FLAG_DISCOVERY: u8 = 1 << 0;

/// Every flag the program knows. schedule_pause accepts exactly one of these at a time, so a
/// flag can never be set that no instruction consults.
pub const PAUSE_FLAGS_ALL: u8 = PAUSE_FLAG_DISCOVERY;

impl ProtocolConfig {
    /// True while the given flag is set and has not yet expired.
    ///
    /// The expiry is part of the flag rather than a separate state: a pause that has run out is
    /// simply over, whether or not anyone has called the permissionless unpause, so a pause can
    /// never outlive its window even if the whole cluster stops cranking.
    pub fn is_paused(&self, flag: u8, now: i64) -> bool {
        self.paused_flags & flag != 0 && now < self.paused_until
    }

    /// The live part of the rarity table, as the number of tiers actually written says.
    pub fn live_rarity_tiers(&self) -> &[RarityTier] {
        let count = (self.rarity_tier_count as usize).min(MAX_RARITY_TIERS);
        &self.rarity_tiers[..count]
    }

    /// Bounds every value-bearing parameter. Called by initialize_protocol and by every admin
    /// setter, so an out-of-range value can never reach a live config: the timelock is the only
    /// path to a change, and this is what a change has to satisfy to take it.
    pub fn validate(&self) -> Result<()> {
        require!(
            self.creator_fee_bps <= MAX_TRADING_FEE_BPS
                && self.platform_fee_bps <= MAX_TRADING_FEE_BPS
                && self.creator_fee_bps as u32 + self.platform_fee_bps as u32
                    <= MAX_TRADING_FEE_BPS as u32,
            DiggoError::ConfigOutOfBounds
        );
        require!(
            self.crank_pool_fee_bps <= BPS as u16,
            DiggoError::ConfigOutOfBounds
        );
        require!(
            self.discovery_max_bps > 0 && self.discovery_max_bps <= MAX_DISCOVERY_MAX_BPS,
            DiggoError::ConfigOutOfBounds
        );
        require!(
            self.discovery_epoch_budget_bps > 0
                && self.discovery_epoch_budget_bps <= MAX_DISCOVERY_EPOCH_BUDGET_BPS,
            DiggoError::ConfigOutOfBounds
        );
        require!(
            self.starter_efficiency_bps > 0
                && self.starter_efficiency_bps <= BPS as u16
                && self.starter_tranche_bps > 0
                && self.starter_tranche_bps <= BPS as u16,
            DiggoError::ConfigOutOfBounds
        );
        // bond_lamports is deliberately unbounded now that it is retired: nothing reads it, so
        // there is no bond size a config has to assert and no threshold left to satisfy.
        require!(self.bond_cooldown_seconds > 0, DiggoError::ConfigOutOfBounds);
        require!(
            self.epoch_seed_delay_slots > 0
                && self.epoch_seed_max_lateness_slots > 0
                && self.epoch_seed_max_lateness_slots <= SLOT_HASHES_WINDOW,
            DiggoError::ConfigOutOfBounds
        );
        require!(
            self.min_curve_mining_blocks >= MIN_CURVE_MINING_BLOCKS,
            DiggoError::ConfigOutOfBounds
        );
        // The caps nest: a day is inside a week, and a week is inside the protocol's own day.
        require!(
            self.discovery_daily_cap_lamports > 0
                && self.discovery_daily_cap_lamports <= self.discovery_weekly_cap_lamports
                && self.discovery_weekly_cap_lamports
                    <= self.discovery_global_daily_cap_lamports,
            DiggoError::ConfigOutOfBounds
        );
        require!(
            self.discovery_epoch_budget_lamports > 0,
            DiggoError::ConfigOutOfBounds
        );
        require!(self.timelock_seconds >= 0, DiggoError::ConfigOutOfBounds);
        validate_rarity_table(self.live_rarity_tiers())
    }
}

/// Bounds a rarity table: at most MAX_RARITY_TIERS tiers, cumulative and strictly increasing,
/// with the last live tier at exactly BPS and every tier worth something.
///
/// A table whose last tier is below BPS would leave a slice of every roll with no tier to land
/// in, and one above it would make the tail unreachable; both are refused rather than clamped,
/// because either would silently change what a discovery is worth.
pub fn validate_rarity_table(tiers: &[RarityTier]) -> Result<()> {
    require!(
        !tiers.is_empty() && tiers.len() <= MAX_RARITY_TIERS,
        DiggoError::InvalidRarityTable
    );
    let mut previous = 0u16;
    for tier in tiers {
        require!(
            tier.cumulative_chance_bps > previous,
            DiggoError::InvalidRarityTable
        );
        require!(tier.value_lamports > 0, DiggoError::InvalidRarityTable);
        previous = tier.cumulative_chance_bps;
    }
    require!(previous == BPS as u16, DiggoError::InvalidRarityTable);
    Ok(())
}

/// The table a fresh protocol starts with: the tiers the product already publishes, with the
/// cumulative chances in bps and the dollar values converted once to lamports at a reference
/// price. It is a starting point, not a constant: set_rarity_table replaces it.
pub fn default_rarity_tiers() -> Vec<RarityTier> {
    const LAMPORTS_PER_CENT: u64 = 66_667;
    let value = |cents: u64| cents.saturating_mul(LAMPORTS_PER_CENT);
    let tier = |chance: u16, cents: u64, score: u16, liquidity: u64, volume: u64| RarityTier {
        cumulative_chance_bps: chance,
        value_lamports: value(cents),
        min_eligibility_score: score,
        min_liquidity_lamports: liquidity,
        min_volume_lamports: volume,
    };
    vec![
        tier(7_000, 5, 0, 0, 0),
        tier(9_000, 25, 100, 1_000_000_000, 100_000_000),
        tier(9_700, 100, 250, 5_000_000_000, 500_000_000),
        tier(9_950, 400, 400, 20_000_000_000, 2_000_000_000),
        tier(9_995, 2_000, 600, 50_000_000_000, 5_000_000_000),
        tier(10_000, 2_000, 800, 100_000_000_000, 10_000_000_000),
    ]
}

#[cfg(test)]
mod v2_tests {
    use super::*;

    /// A config seeded the way initialize_protocol seeds one: every value-bearing parameter at
    /// its documented default.
    fn config() -> ProtocolConfig {
        let mut config = ProtocolConfig {
            creator_fee_bps: DEFAULT_CREATOR_FEE_BPS,
            platform_fee_bps: DEFAULT_PLATFORM_FEE_BPS,
            crank_pool_fee_bps: DEFAULT_CRANK_POOL_FEE_BPS,
            discovery_max_bps: DEFAULT_DISCOVERY_MAX_BPS,
            discovery_epoch_budget_bps: DEFAULT_DISCOVERY_EPOCH_BUDGET_BPS,
            starter_efficiency_bps: STARTER_EFFICIENCY_BPS,
            starter_tranche_bps: STARTER_TRANCHE_BPS,
            bond_lamports: BOND_LAMPORTS,
            bond_cooldown_seconds: BOND_COOLDOWN_SECONDS,
            epoch_seed_delay_slots: EPOCH_SEED_DELAY_SLOTS,
            epoch_seed_max_lateness_slots: EPOCH_SEED_MAX_LATENESS_SLOTS,
            min_curve_mining_blocks: MIN_CURVE_MINING_BLOCKS,
            discovery_daily_cap_lamports: DEFAULT_DISCOVERY_DAILY_CAP_LAMPORTS,
            discovery_weekly_cap_lamports: DEFAULT_DISCOVERY_WEEKLY_CAP_LAMPORTS,
            discovery_global_daily_cap_lamports: DEFAULT_DISCOVERY_GLOBAL_DAILY_CAP_LAMPORTS,
            discovery_epoch_budget_lamports: DEFAULT_DISCOVERY_EPOCH_BUDGET_LAMPORTS,
            timelock_seconds: 172_800,
            ..ProtocolConfig::default()
        };
        for (slot, tier) in config.rarity_tiers.iter_mut().zip(default_rarity_tiers()) {
            *slot = tier;
        }
        config.rarity_tier_count = 6;
        config
    }

    #[test]
    fn the_default_config_validates_and_every_bound_is_load_bearing() {
        assert!(config().validate().is_ok());

        // The two trading shares together are capped, and the crank-pool share is a share of
        // the protocol's own bucket rather than a third charge on the trade.
        let mut wide = config();
        wide.creator_fee_bps = 60;
        wide.platform_fee_bps = 60;
        assert!(wide.validate().is_err());
        let mut crank = config();
        crank.crank_pool_fee_bps = BPS as u16 + 1;
        assert!(crank.validate().is_err());

        // The starter tranche and the starter efficiency are both bounds, and neither may be
        // traded for the other.
        let mut tranche = config();
        tranche.starter_tranche_bps = BPS as u16 + 1;
        assert!(tranche.validate().is_err());
        let mut efficiency = config();
        efficiency.starter_efficiency_bps = 0;
        assert!(efficiency.validate().is_err());

        // The bond is retired and its field carries no threshold: zero is as valid as any other
        // value, because nothing reads it.
        let mut bond = config();
        bond.bond_lamports = 0;
        assert!(bond.validate().is_ok());
        // The cooldown still bounds the legacy withdraw path, so it stays a real bound.
        let mut cooldown = config();
        cooldown.bond_cooldown_seconds = 0;
        assert!(cooldown.validate().is_err());

        // The reveal has to land inside the slot-hash window, or the fallback is meaningless.
        let mut lateness = config();
        lateness.epoch_seed_max_lateness_slots = SLOT_HASHES_WINDOW + 1;
        assert!(lateness.validate().is_err());
        let mut delay = config();
        delay.epoch_seed_delay_slots = 0;
        assert!(delay.validate().is_err());

        // A curve-mining budget may not be a single block.
        let mut runway = config();
        runway.min_curve_mining_blocks = MIN_CURVE_MINING_BLOCKS - 1;
        assert!(runway.validate().is_err());

        // The discovery caps nest: a day inside a week, a week inside the protocol's own day.
        let mut nested = config();
        nested.discovery_daily_cap_lamports = nested.discovery_weekly_cap_lamports + 1;
        assert!(nested.validate().is_err());
        let mut weekly = config();
        weekly.discovery_weekly_cap_lamports = weekly.discovery_global_daily_cap_lamports + 1;
        assert!(weekly.validate().is_err());

        // And the rarity table is part of the same validation.
        let mut rarity = config();
        rarity.rarity_tiers[5].cumulative_chance_bps = 9_000;
        assert!(rarity.validate().is_err());
    }

    #[test]
    fn the_rarity_table_is_cumulative_strictly_rising_and_ends_at_bps() {
        let tiers = default_rarity_tiers();
        assert_eq!(tiers.len(), 6);
        assert!(validate_rarity_table(&tiers).is_ok());
        assert_eq!(tiers[0].cumulative_chance_bps, 7_000);
        assert_eq!(tiers[5].cumulative_chance_bps, BPS as u16);
        // Value rises with rarity, which is the whole point of a rarity table.
        for pair in tiers.windows(2) {
            assert!(pair[1].value_lamports >= pair[0].value_lamports);
            assert!(pair[1].min_eligibility_score >= pair[0].min_eligibility_score);
        }

        assert!(validate_rarity_table(&[]).is_err());
        assert!(validate_rarity_table(&vec![RarityTier::default(); MAX_RARITY_TIERS + 1]).is_err());

        // A table that does not reach BPS leaves a slice of every roll with nowhere to land.
        let mut short = default_rarity_tiers();
        short[5].cumulative_chance_bps = 9_999;
        assert!(validate_rarity_table(&short).is_err());

        // A tier that does not rise is not a tier: the walk could never reach it.
        let mut flat = default_rarity_tiers();
        flat[3].cumulative_chance_bps = flat[2].cumulative_chance_bps;
        assert!(validate_rarity_table(&flat).is_err());

        // A tier worth nothing is not a prize.
        let mut empty = default_rarity_tiers();
        empty[2].value_lamports = 0;
        assert!(validate_rarity_table(&empty).is_err());
    }

    #[test]
    fn a_pause_expires_on_its_own() {
        let mut config = config();
        config.paused_flags = PAUSE_FLAG_DISCOVERY;
        config.paused_until = 1_000;

        assert!(config.is_paused(PAUSE_FLAG_DISCOVERY, 999));
        // The expiry is part of the flag: a pause that has run out is over whether or not
        // anyone clears the bit, which is why unpause is only a formality.
        assert!(!config.is_paused(PAUSE_FLAG_DISCOVERY, 1_000));
        assert!(!config.is_paused(PAUSE_FLAG_DISCOVERY, 1_001));
        // No flag is set that no instruction consults.
        assert_eq!(PAUSE_FLAGS_ALL, PAUSE_FLAG_DISCOVERY);
        assert!(!config.is_paused(0, 999));
    }

    #[test]
    fn the_curve_table_override_is_the_size_the_constants_describe() {
        assert_eq!(CurveTable::SIZE, 8 + 4 * CURVE_TABLE_POWER_LEN * (1 + CREW_COMPONENTS) + 2);
        assert_eq!(CurveTable::SIZE, 2410);
        assert_eq!(ProtocolConfig::SIZE, 434);
        assert_eq!(RarityTier::LEN, 28);
    }
}
