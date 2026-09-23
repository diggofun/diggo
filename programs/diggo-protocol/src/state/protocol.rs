//! state::protocol.rs (phase 0a mechanical split of lib.rs).

use crate::*;



#[account]
#[derive(InitSpace)]
pub struct ProtocolConfig {
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
