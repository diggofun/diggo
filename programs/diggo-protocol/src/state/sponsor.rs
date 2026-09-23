//! Sponsor vault, event and grant accounts (v2, docs/ONCHAIN_V2_DESIGN.md 1.7 and 8.2).
//!
//! Sponsorship can pay rent and fees and nothing else: it can never change power, rewards,
//! discovery odds, rarity, caps or eligibility. WS-G pins that with the invariance test the
//! design promises (the same coin, the same seed, with and without an active event, must
//! produce identical power and identical discovery outcomes).

use crate::*;

/// One PDA per sponsor wallet under [b"sponsor-vault", sponsor_owner]. Holds lamports only,
/// in the PDA balance, and must stay above its own rent-exempt minimum at all times.
#[account]
#[derive(Default)]
pub struct SponsorVault {
    pub sponsor_owner: Pubkey,
    pub event_count: u32,
    pub total_funded: u64,
    pub total_spent: u64,
    pub total_withdrawn: u64,
    pub bump: u8,
    pub version: u8,
}

impl SponsorVault {
    pub const LEN: usize = 32 + 4 + 8 * 3 + 2;
    pub const SIZE: usize = 8 + Self::LEN;
}

/// One PDA per (vault, event_id) under [b"sponsor-event", sponsor_vault, event_id u32 le].
#[account]
#[derive(Default)]
pub struct SponsorEvent {
    pub vault: Pubkey,
    pub kind: u8,
    pub start_at: i64,
    pub end_at: i64,
    pub budget_lamports: u64,
    pub spent_lamports: u64,
    pub per_coin_limit_lamports: u64,
    pub per_wallet_limit_lamports: u64,
    pub paused: u8,
    pub bump: u8,
    pub version: u8,
}

impl SponsorEvent {
    pub const LEN: usize = 32 + 1 + 8 * 6 + 3;
    pub const SIZE: usize = 8 + Self::LEN;
}

/// One PDA per (event, subject) under [b"sponsor-grant", sponsor_event, subject], created at
/// most once per pair so re-launching cannot reset a limit.
///
/// For LaunchRentSubsidy and PlatformTradeFeeWaiver the subject is the coin; for
/// PlayerAccountSubsidy and PlayerBondSubsidy it is the player's wallet. That is what makes
/// `per_coin_limit_lamports` and `per_wallet_limit_lamports` both enforceable against one
/// grant shape.
#[account]
#[derive(Default)]
pub struct SponsorGrant {
    pub spent_lamports: u64,
    pub waived_fee_lamports: u64,
    /// The part of `spent_lamports` charged against the event's per-wallet limit.
    pub wallet_spent_lamports: u64,
    pub created_slot: u64,
    pub bump: u8,
    pub version: u8,
}

impl SponsorGrant {
    pub const LEN: usize = 8 * 4 + 2;
    pub const SIZE: usize = 8 + Self::LEN;
}

/// Event kinds. LaunchRentSubsidy pays the mint, Coin and vault rent at launch_token;
/// PlatformTradeFeeWaiver pays the platform share of the trading fee at accrual;
/// PlayerAccountSubsidy pays a player's PlayerAccount rent; PlayerBondSubsidy posts a
/// player's bond from the vault. Adding a fifth kind is a program upgrade.
pub const SPONSOR_KIND_LAUNCH_RENT_SUBSIDY: u8 = 0;
pub const SPONSOR_KIND_PLATFORM_TRADE_FEE_WAIVER: u8 = 1;
pub const SPONSOR_KIND_PLAYER_ACCOUNT_SUBSIDY: u8 = 2;
pub const SPONSOR_KIND_PLAYER_BOND_SUBSIDY: u8 = 3;
