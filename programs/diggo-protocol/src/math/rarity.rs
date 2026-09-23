//! math::rarity.rs (phase 0a mechanical split of lib.rs).

use crate::*;



/// Outcome of the pre-flight checks for one discovery payout. Returned instead of
/// mutating the mine so the whole rule set stays unit-testable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DiscoveryApproval {
    pub epoch_spent: u64,
    pub epoch_ends_at: i64,
    pub epoch_budget: u64,
}


/// The complete on-chain rule set for a discovery payout: scoped circuit breakers,
/// per-call ceiling, per-mine per-epoch budget, and reserve sufficiency. Idempotency is
/// enforced separately by the DiscoveryReceipt PDA.
pub fn approve_discovery_payout(
    protocol: &ProtocolConfigV4,
    mine: &Mine,
    amount: u64,
    now: i64,
) -> Result<DiscoveryApproval> {
    require!(
        !protocol.discovery_payouts_paused,
        DiggoError::DiscoveryPayoutsPaused
    );
    require!(!mine.discovery_paused, DiggoError::MineDiscoveryPaused);
    require!(amount > 0, DiggoError::InvalidAmount);
    require!(
        amount <= mine.remaining_discovery_reserve,
        DiggoError::InsufficientDiscoveryReserve
    );
    let max_per_call = mul_bps(mine.discovery_reserve_total, protocol.discovery_max_bps)?;
    require!(
        max_per_call > 0 && amount <= max_per_call,
        DiggoError::DiscoveryAmountTooLarge
    );
    let (epoch_spent, epoch_ends_at) = roll_discovery_epoch(mine, now)?;
    let spent = epoch_spent
        .checked_add(amount)
        .ok_or(DiggoError::MathOverflow)?;
    require!(
        spent <= mine.discovery_epoch_budget,
        DiggoError::DiscoveryEpochBudgetExceeded
    );
    Ok(DiscoveryApproval {
        epoch_spent: spent,
        epoch_ends_at,
        epoch_budget: mine.discovery_epoch_budget,
    })
}


/// Rolls the per-mine discovery epoch forwards past now in one step (no loop), resetting
/// the spent counter for every elapsed epoch.
pub fn roll_discovery_epoch(mine: &Mine, now: i64) -> Result<(u64, i64)> {
    if now < mine.discovery_epoch_ends_at {
        return Ok((mine.discovery_epoch_spent, mine.discovery_epoch_ends_at));
    }
    let length = mine.epoch_length.max(1);
    let elapsed = now.saturating_sub(mine.discovery_epoch_ends_at);
    let skipped = (elapsed / length)
        .checked_add(1)
        .ok_or(DiggoError::MathOverflow)?;
    let advance = skipped.checked_mul(length).ok_or(DiggoError::MathOverflow)?;
    let ends_at = mine
        .discovery_epoch_ends_at
        .checked_add(advance)
        .ok_or(DiggoError::MathOverflow)?;
    Ok((0, ends_at))
}
