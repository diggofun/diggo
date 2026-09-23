//! Program events.

use crate::*;



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
pub struct MarketGraduatedV4 {
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
pub struct RewardsClaimedV4 {
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

// ---- v2 events (docs/ONCHAIN_V2_DESIGN.md 8.2) -------------------------------------------

#[event]
pub struct ProtocolInitialized {
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub crank_pool: Pubkey,
    pub version: u8,
}

#[event]
pub struct CoinLaunched {
    pub coin: Pubkey,
    pub mint: Pubkey,
    pub creator: Pubkey,
    /// The sponsor event that paid the launch rent, or the default pubkey.
    pub sponsor_event: Pubkey,
}

#[event]
pub struct EpochAdvanced {
    pub coin: Pubkey,
    pub epoch_index: u32,
    pub epoch_ends_at: i64,
    pub epoch_ends_slot: u64,
}

#[event]
pub struct EpochSeedTargetArmed {
    pub coin: Pubkey,
    pub epoch_index: u32,
    pub target_slot: u64,
}

#[event]
pub struct EpochSeedCommitted {
    pub coin: Pubkey,
    pub epoch_index: u32,
    pub target_slot: u64,
    pub recorded_slot: u64,
    pub seed: [u8; 32],
}

#[event]
pub struct EpochSeedRearmed {
    pub coin: Pubkey,
    pub epoch_index: u32,
    pub target_slot: u64,
}

#[event]
pub struct PlayerInitialized {
    pub player: Pubkey,
    pub owner: Pubkey,
    /// The sponsor event that paid the rent, or the default pubkey.
    pub sponsor_event: Pubkey,
}

#[event]
pub struct Activated {
    pub player: Pubkey,
    pub active_until: i64,
    pub streak: u16,
    pub valid_activations: u16,
}

#[event]
pub struct OreCollected {
    pub player: Pubkey,
    pub amount: u64,
    pub balance: u64,
    /// Accrued ORE the storage capacity could not hold: reported, never silently kept.
    pub overflow: u64,
}

#[event]
pub struct CrewUpgraded {
    pub player: Pubkey,
    pub component: u8,
    pub level: u16,
    pub ore_spent: u64,
}

#[event]
pub struct BondPosted {
    pub player: Pubkey,
    pub lamports: u64,
    /// 0 = the player's own lamports, 1 = a sponsor vault.
    pub source: u8,
    pub sponsor_vault: Pubkey,
}

#[event]
pub struct UnbondRequested {
    pub player: Pubkey,
    pub unbond_available_at: i64,
}

#[event]
pub struct BondWithdrawn {
    pub player: Pubkey,
    pub lamports: u64,
    pub recipient: Pubkey,
}

#[event]
pub struct PowerAssigned {
    pub coin: Pubkey,
    pub owner: Pubkey,
    pub power: u64,
    /// The reward index this position accrues in: 0 bonded, 1 starter.
    pub tranche: u8,
}

#[event]
pub struct PowerRemoved {
    pub coin: Pubkey,
    pub owner: Pubkey,
    pub pending_reward: u64,
}

#[event]
pub struct MineSwitched {
    pub owner: Pubkey,
    pub from_coin: Pubkey,
    pub to_coin: Pubkey,
}

#[event]
pub struct RewardsClaimed {
    pub coin: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
}

#[event]
pub struct DiscoveryRollCreated {
    pub opportunity: Pubkey,
    pub coin: Pubkey,
    pub owner: Pubkey,
    pub window_index: u16,
    pub day_index: u16,
}

#[event]
pub struct DiscoverySettled {
    pub opportunity: Pubkey,
    pub coin: Pubkey,
    pub owner: Pubkey,
    pub rarity: u8,
    pub units: u64,
    pub value_lamports: u64,
}

#[event]
pub struct DiscoveryExpired {
    pub opportunity: Pubkey,
    pub coin: Pubkey,
    pub owner: Pubkey,
}

#[event]
pub struct MarketGraduated {
    pub coin: Pubkey,
    pub pool: Pubkey,
    pub token_reserve: u64,
    pub sol_reserve: u64,
}

#[event]
pub struct FeesSwept {
    pub coin: Pubkey,
    pub treasury_lamports: u64,
    pub creator_lamports: u64,
    pub crank_pool_lamports: u64,
}

#[event]
pub struct CrankTipPaid {
    pub coin: Pubkey,
    pub payer: Pubkey,
    pub lamports: u64,
}

#[event]
pub struct SponsorVaultInitialized {
    pub vault: Pubkey,
    pub sponsor_owner: Pubkey,
}

#[event]
pub struct SponsorEventCreated {
    pub event: Pubkey,
    pub vault: Pubkey,
    pub kind: u8,
    pub start_at: i64,
    pub end_at: i64,
    pub budget_lamports: u64,
    pub per_coin_limit_lamports: u64,
    pub per_wallet_limit_lamports: u64,
}

#[event]
pub struct SponsorSpend {
    pub grant: Pubkey,
    pub kind: u8,
    pub lamports: u64,
}
