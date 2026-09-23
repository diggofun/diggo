//! state::player.rs (phase 0a mechanical split of lib.rs).

use crate::*;



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
pub struct MiningPositionV4 {
    pub owner: Pubkey,
    pub mine: Pubkey,
    pub assigned_power: u64,
    pub last_reward_index: u128,
    pub pending_reward: u64,
    pub bump: u8,
}

// ---- v2 (docs/ONCHAIN_V2_DESIGN.md 3.1, 3.2, 8.2) ----------------------------------------

/// One PDA per wallet under [b"player", owner]. The owner is never stored: it is the seed.
///
/// Allocated at its full size on the first `initialize_player`, so posting or withdrawing a
/// bond never reallocs it. The bond lamports themselves sit in this PDA's balance above its
/// rent-exempt minimum and therefore need no account of their own.
#[account]
#[derive(Default)]
pub struct PlayerAccount {
    /// Maturity anchors, fixed at PDA creation and never reset by a bond.
    pub created_slot: u64,
    pub created_at: i64,
    pub active_until: i64,
    pub last_activation_at: i64,
    pub streak: u16,
    pub longest_streak: u16,
    pub valid_activations: u16,
    pub active_days: u16,
    pub last_active_day: u16,
    pub streak_freezes: u8,
    /// miners, drills, carts, foreman, storage.
    pub crew_levels: [u16; CREW_COMPONENTS],
    /// ORE is non-transferable game state, never an SPL token.
    pub ore_balance: u64,
    pub ore_earned: u64,
    pub ore_spent: u64,
    pub ore_accrued_at: i64,
    pub active_mine: Pubkey,
    /// Discovery budget windows. u16 is 179 years of days.
    pub day_index: u16,
    pub week_index: u16,
    pub spent_day_lamports: u64,
    pub spent_week_lamports: u64,
    /// Last window a roll was created in: a repeat in the same window is a no-op, never a
    /// reroll, because the opportunity PDA already exists.
    pub roll_window: u16,
    pub roll_count: u16,
    pub last_roll_at: i64,
    /// Lamports locked in this PDA's balance above its rent-exempt minimum.
    pub bond_lamports: u64,
    pub bond_locked_at: i64,
    pub unbond_available_at: i64,
    /// 0 = the player's own lamports, 1 = a sponsor vault.
    pub bond_source: u8,
    /// The vault a sponsor-funded bond returns to; zero when self-funded.
    pub bond_sponsor_vault: Pubkey,
    pub bump: u8,
    pub version: u8,
}

impl PlayerAccount {
    pub const LEN: usize = 8 * 4
        + 2 * 5
        + 1
        + 2 * CREW_COMPONENTS
        + 8 * 3
        + 8
        + 32
        + 2 * 2
        + 8 * 2
        + 2 * 2
        + 8
        + 8 * 3
        + 1
        + 32
        + 2;
    pub const SIZE: usize = 8 + Self::LEN;
}

/// One PDA per (coin, owner) under [b"position", coin, owner]. Owner and coin are the seeds,
/// so neither is stored, and the reward-index math is the v4 math unchanged.
#[account]
#[derive(Default)]
pub struct MiningPosition {
    pub assigned_power: u64,
    pub last_reward_index: u128,
    pub pending_reward: u64,
    /// The reward index this position accrues in: 0 bonded, 1 starter.
    pub tranche: u8,
    pub created_slot: u64,
    pub bump: u8,
    pub version: u8,
}

impl MiningPosition {
    pub const LEN: usize = 8 + 16 + 8 + 1 + 8 + 1 + 1;
    pub const SIZE: usize = 8 + Self::LEN;
}

/// A bond is either the player's own lamports or a sponsor vault's.
pub const BOND_SOURCE_SELF: u8 = 0;
pub const BOND_SOURCE_SPONSOR: u8 = 1;

/// The reward index a position accrues in.
pub const TRANCHE_BONDED: u8 = 0;
pub const TRANCHE_STARTER: u8 = 1;
