//! PDA seed prefixes and seed helpers.

use crate::*;



/// Seed prefix of the DiscoveryReceipt PDA: [b"discovery", mine, discovery_id].
pub const DISCOVERY_RECEIPT_SEED: &[u8] = b"discovery";


/// Seed prefixes of the post-graduation liquidity pool and of its two vaults.
pub const POOL_SEED: &[u8] = b"pool";

pub const POOL_VAULT_SEED: &[u8] = b"pool-vault";

pub const POOL_SOL_SEED: &[u8] = b"pool-sol";


/// Seeds of the DiscoveryReceipt PDA: [b"discovery", mine, discovery_id]. Kept next to
/// the account constraint so the uniqueness rule (one receipt per id, per mine) can be
/// unit-tested against the same prefix constant the constraint uses.
#[cfg(test)]
pub fn discovery_receipt_seeds(mine: &Pubkey, discovery_id: u64) -> Vec<u8> {
    let mut seeds = Vec::with_capacity(DISCOVERY_RECEIPT_SEED.len() + 32 + 8);
    seeds.extend_from_slice(DISCOVERY_RECEIPT_SEED);
    seeds.extend_from_slice(mine.as_ref());
    seeds.extend_from_slice(&discovery_id.to_le_bytes());
    seeds
}

// ---- v2 seeds (docs/ONCHAIN_V2_DESIGN.md 8.2) --------------------------------------------

/// ProtocolConfig: [b"protocol"].
pub const PROTOCOL_SEED: &[u8] = b"protocol";
/// Treasury PDA: [b"treasury"].
pub const TREASURY_SEED: &[u8] = b"treasury";
/// Crank-tip pool PDA: [b"crank-pool"].
pub const CRANK_POOL_SEED: &[u8] = b"crank-pool";
/// Optional curve-table override: [b"curve-table"].
pub const CURVE_TABLE_SEED: &[u8] = b"curve-table";
/// Coin: [b"coin", mint].
pub const COIN_SEED: &[u8] = b"coin";
/// The coin's single token vault: [b"vault", mint].
pub const VAULT_SEED: &[u8] = b"vault";
/// PlayerAccount: [b"player", owner].
pub const PLAYER_SEED: &[u8] = b"player";
/// MiningPosition: [b"position", coin, owner].
pub const POSITION_SEED: &[u8] = b"position";
/// DiscoveryOpportunity: [b"opportunity", coin, owner, window_index u16 le].
pub const OPPORTUNITY_SEED: &[u8] = b"opportunity";
/// GlobalBudget: [b"global-budget", day_index u16 le].
pub const GLOBAL_BUDGET_SEED: &[u8] = b"global-budget";
/// SponsorVault: [b"sponsor-vault", sponsor_owner].
pub const SPONSOR_VAULT_SEED: &[u8] = b"sponsor-vault";
/// SponsorEvent: [b"sponsor-event", sponsor_vault, event_id u32 le].
pub const SPONSOR_EVENT_SEED: &[u8] = b"sponsor-event";
/// SponsorGrant: [b"sponsor-grant", sponsor_event, subject].
pub const SPONSOR_GRANT_SEED: &[u8] = b"sponsor-grant";
/// The launch mint: [b"mint", creator, nonce u8].
pub const MINT_SEED: &[u8] = b"mint";
/// Referral credit marker: [b"referral", referrer, referee].
pub const REFERRAL_CREDIT_SEED: &[u8] = b"referral";
/// Referral weekly counter: [b"referral_week", referrer].
pub const REFERRAL_WEEK_SEED: &[u8] = b"referral_week";

/// Seeds of the DiscoveryOpportunity PDA. The window index is little-endian and u16, so the
/// PDA is unique per (coin, owner, window) and a reroll is impossible by construction.
pub fn opportunity_seeds(coin: &Pubkey, owner: &Pubkey, window_index: u16) -> Vec<u8> {
    let mut seeds = Vec::with_capacity(OPPORTUNITY_SEED.len() + 64 + 2);
    seeds.extend_from_slice(OPPORTUNITY_SEED);
    seeds.extend_from_slice(coin.as_ref());
    seeds.extend_from_slice(owner.as_ref());
    seeds.extend_from_slice(&window_index.to_le_bytes());
    seeds
}

/// Seeds of the GlobalBudget PDA, keyed by the day index it bounds.
pub fn global_budget_seeds(day_index: u16) -> Vec<u8> {
    let mut seeds = Vec::with_capacity(GLOBAL_BUDGET_SEED.len() + 2);
    seeds.extend_from_slice(GLOBAL_BUDGET_SEED);
    seeds.extend_from_slice(&day_index.to_le_bytes());
    seeds
}
