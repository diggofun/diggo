//! math::fees.rs (phase 0a mechanical split of lib.rs).

use crate::*;



/// Which accrued fee bucket a claim instruction is allowed to pay out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FeeBucket {
    Creator,
    Platform,
}


/// How many lamports may leave a market account for one fee claim, and nothing else.
///
/// This is what keeps a creator (or the treasury) from ever taking LP SOL or an unearned
/// fee: after the payout the market must still hold its rent floor, the whole curve
/// reserve, and the other fee bucket.
pub fn withdrawable_fee(
    market: &LaunchMarket,
    lamports: u64,
    rent_floor: u64,
    bucket: FeeBucket,
) -> Result<u64> {
    let (amount, other_bucket) = match bucket {
        FeeBucket::Creator => (market.creator_fee_claimable, market.platform_fee_claimable),
        FeeBucket::Platform => (market.platform_fee_claimable, market.creator_fee_claimable),
    };
    require!(amount > 0, DiggoError::NothingToClaim);
    let available = lamports.saturating_sub(rent_floor);
    let protected = market
        .sol_reserve
        .checked_add(other_bucket)
        .and_then(|value| value.checked_add(amount))
        .ok_or(DiggoError::MathOverflow)?;
    require!(available >= protected, DiggoError::InsufficientLiquidity);
    Ok(amount)
}


/// Splits a trade's gross SOL into the curve's net amount and the two explicit fees.
/// Both fees are capped, so they can never consume the whole trade.
pub fn net_after_fees(
    amount: u64,
    creator_fee_bps: u16,
    platform_fee_bps: u16,
) -> Result<(u64, u64, u64)> {
    require!(
        creator_fee_bps <= MAX_TRADING_FEE_BPS && platform_fee_bps <= MAX_TRADING_FEE_BPS,
        DiggoError::FeeTooHigh
    );
    let creator_fee = mul_bps(amount, creator_fee_bps)?;
    let platform_fee = mul_bps(amount, platform_fee_bps)?;
    let net = amount
        .checked_sub(creator_fee)
        .and_then(|value| value.checked_sub(platform_fee))
        .ok_or(DiggoError::MathOverflow)?;
    Ok((net, creator_fee, platform_fee))
}


/// Credits accrued trading fees on a market. Kept next to net_after_fees so the lamport
/// invariant stays visible: market lamports minus rent floor equals
/// sol_reserve + creator_fee_claimable + platform_fee_claimable.
pub fn accrue_fees(market: &mut LaunchMarket, creator_fee: u64, platform_fee: u64) -> Result<()> {
    market.creator_fee_claimable = market
        .creator_fee_claimable
        .checked_add(creator_fee)
        .ok_or(DiggoError::MathOverflow)?;
    market.platform_fee_claimable = market
        .platform_fee_claimable
        .checked_add(platform_fee)
        .ok_or(DiggoError::MathOverflow)?;
    Ok(())
}
