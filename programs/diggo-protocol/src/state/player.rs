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
pub struct MiningPosition {
    pub owner: Pubkey,
    pub mine: Pubkey,
    pub assigned_power: u64,
    pub last_reward_index: u128,
    pub pending_reward: u64,
    pub bump: u8,
}
