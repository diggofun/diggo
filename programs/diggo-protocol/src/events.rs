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
