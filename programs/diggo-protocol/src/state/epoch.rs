//! state::epoch.rs (phase 0a mechanical split of lib.rs).

use crate::*;



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

// ---- v2 (docs/ONCHAIN_V2_DESIGN.md 4.2, 4.3, 8.2) ----------------------------------------

/// One PDA per (coin, owner, window) under [b"opportunity", coin, owner, window_index u16 le].
///
/// It exists so a reroll is impossible by construction rather than by a guarded update, and it
/// is closed on settlement so its rent is transient and returns to whoever settles it. The
/// budget is charged when the roll is created, while the epoch seed is still unknown, and an
/// expired opportunity pays nothing and refunds no budget.
#[account]
#[derive(Default)]
pub struct DiscoveryOpportunity {
    pub coin: Pubkey,
    pub owner: Pubkey,
    pub window_index: u16,
    pub day_index: u16,
    /// The epoch whose seed settles this opportunity. Frozen: written at creation, read by
    /// settle_discovery, never rewritten.
    pub epoch_index: u32,
    /// The lamports of day and week budget charged at creation.
    pub budget_lamports: u64,
    pub created_at: i64,
    pub created_slot: u64,
    pub expires_at: i64,
    /// 0 pending, 1 settled, 2 expired.
    pub status: u8,
    /// Rarity tier the seed derived at settlement; zero while pending.
    pub rarity: u8,
    pub bump: u8,
    pub version: u8,
}

impl DiscoveryOpportunity {
    pub const LEN: usize = 32 * 2 + 2 * 2 + 4 + 8 + 8 + 8 + 8 + 4;
    pub const SIZE: usize = 8 + Self::LEN;
}

pub const OPPORTUNITY_PENDING: u8 = 0;
pub const OPPORTUNITY_SETTLED: u8 = 1;
pub const OPPORTUNITY_EXPIRED: u8 = 2;

/// One PDA per day index under [b"global-budget", day_index u16 le]: the protocol-wide daily
/// discovery cap. Created by the first roll of the day and closed by a crank once the day
/// passes, so its rent is transient.
#[account]
#[derive(Default)]
pub struct GlobalBudget {
    pub day_index: u16,
    pub cap_lamports: u64,
    pub spent_lamports: u64,
    pub roll_count: u32,
    pub settled_count: u32,
    pub opened_at: i64,
    pub opened_slot: u64,
    pub closed: u8,
    pub bump: u8,
    pub version: u8,
}

impl GlobalBudget {
    pub const LEN: usize = 2 + 8 + 8 + 4 + 4 + 8 + 8 + 3;
    pub const SIZE: usize = 8 + Self::LEN;
}
