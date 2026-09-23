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
