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

// ---- v2: the fee split, the crank tip and the waiver (design 6, 1.7) ----------------------
//
// v2 keeps exactly two lamport buckets on the coin, because a coin's whole SOL ledger lives in
// one account: the creator's share and the protocol's share. The crank-pool PDA and the
// treasury are both paid out of the protocol bucket at sweep time, and a crank tip is paid out
// of the same bucket, so no cranker is ever paid out of a creator's fees. The split itself
// never changes when a sponsor waives the platform share: only who funds it does.

/// The two destinations of one trade's fee, in lamports.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TradeFees {
    /// The coin creator's share, claimable by claim_creator_fees or paid by sweep_fees.
    pub creator: u64,
    /// The protocol's share, held for the treasury and the crank pool.
    pub platform: u64,
}

impl TradeFees {
    pub fn total(&self) -> Result<u64> {
        self.creator
            .checked_add(self.platform)
            .ok_or_else(|| error!(DiggoError::MathOverflow))
    }
}

/// Splits a trade's gross lamports into the creator's share and the protocol's share.
///
/// Both shares round down, so the net amount the curve or the pool receives is the remainder
/// and the lamports always add up: the protocol never over-distributes and never loses a
/// lamport to rounding. The two shares together may never exceed MAX_TRADING_FEE_BPS, which is
/// what stops a governance mistake from turning a trade into a fee.
pub fn split_trade_fees(gross: u64, creator_bps: u16, platform_bps: u16) -> Result<TradeFees> {
    require!(
        creator_bps <= MAX_TRADING_FEE_BPS && platform_bps <= MAX_TRADING_FEE_BPS,
        DiggoError::FeeTooHigh
    );
    require!(
        creator_bps as u32 + platform_bps as u32 <= MAX_TRADING_FEE_BPS as u32,
        DiggoError::FeeSplitOverflow
    );
    Ok(TradeFees {
        creator: mul_bps(gross, creator_bps)?,
        platform: mul_bps(gross, platform_bps)?,
    })
}

/// What the curve or the pool receives after the fees: the gross amount minus both shares.
pub fn net_after_trade_fees(gross: u64, fees: TradeFees) -> Result<u64> {
    gross
        .checked_sub(fees.total()?)
        .ok_or_else(|| error!(DiggoError::FeeSplitOverflow))
}

/// The share of the protocol bucket the crank-pool PDA receives at sweep time.
///
/// The parameter is a share of the protocol's own bucket rather than of the trade, because a
/// coin carries exactly two buckets: a third accrual would need a third field, and the frozen
/// layout has two. The rest of the bucket goes to the treasury, so the split is exact and no
/// lamport is ever stranded in the coin account.
pub fn crank_pool_share(platform_lamports: u64, crank_pool_fee_bps: u16) -> Result<u64> {
    require!(crank_pool_fee_bps <= BPS as u16, DiggoError::FeeSplitOverflow);
    mul_bps(platform_lamports, crank_pool_fee_bps)
}

/// The largest tip one crank_tip may pay: CRANK_TIP_BPS of the protocol bucket.
///
/// A tip is paid out of accrued fees only - never out of a reserve, never out of the curve's
/// SOL, never out of the locked pool - and out of the protocol's own bucket rather than out of
/// the creator's share, so a public crank is funded by the fee the protocol was already taking.
pub fn max_crank_tip(platform_lamports: u64) -> Result<u64> {
    mul_bps(platform_lamports, CRANK_TIP_BPS)
}

/// The platform share a PlatformTradeFeeWaiver event funds for one trade.
///
/// The amount is the same platform fee the trader would otherwise have paid, so the treasury is
/// kept whole and the trader pays the creator's share only. It is charged against the event
/// before a lamport moves, which is what stops a waiver from ever exceeding its budget.
pub fn waived_platform_fee(gross: u64, platform_bps: u16) -> Result<u64> {
    require!(platform_bps <= MAX_TRADING_FEE_BPS, DiggoError::FeeTooHigh);
    mul_bps(gross, platform_bps)
}

/// Credits a settled trade's fees on the coin's two buckets. Kept next to the split so the
/// lamport invariant stays visible: coin lamports minus its rent floor equals
/// sol_reserve + creator_fee_claimable + platform_fee_claimable.
pub fn accrue_coin_fees(coin: &mut Coin, fees: TradeFees) -> Result<()> {
    coin.creator_fee_claimable = coin
        .creator_fee_claimable
        .checked_add(fees.creator)
        .ok_or(DiggoError::MathOverflow)?;
    coin.platform_fee_claimable = coin
        .platform_fee_claimable
        .checked_add(fees.platform)
        .ok_or(DiggoError::MathOverflow)?;
    Ok(())
}

/// Splits the coin's protocol bucket into the crank-pool share and the treasury's remainder.
/// The two always add up to the bucket, so a sweep can never leave a lamport behind.
pub fn split_platform_bucket(
    platform_lamports: u64,
    crank_pool_fee_bps: u16,
) -> Result<(u64, u64)> {
    let crank = crank_pool_share(platform_lamports, crank_pool_fee_bps)?;
    let treasury = platform_lamports
        .checked_sub(crank)
        .ok_or(DiggoError::FeeSplitOverflow)?;
    Ok((crank, treasury))
}

#[cfg(test)]
mod v2_tests {
    use super::*;

    #[test]
    fn the_v2_split_conserves_every_lamport() {
        let fees = split_trade_fees(10_000, 50, 50).unwrap();
        assert_eq!(fees.creator, 50);
        assert_eq!(fees.platform, 50);
        assert_eq!(net_after_trade_fees(10_000, fees).unwrap(), 9_900);
        assert_eq!(
            net_after_trade_fees(10_000, fees).unwrap() + fees.total().unwrap(),
            10_000
        );

        // Rounding down on both shares hands the remainder to the trade, never to a fee.
        let odd = split_trade_fees(101, 33, 33).unwrap();
        assert_eq!(odd.creator, 0);
        assert_eq!(odd.platform, 0);
        assert_eq!(net_after_trade_fees(101, odd).unwrap(), 101);

        // Two shares of the same cap: the pair may not exceed MAX_TRADING_FEE_BPS between them,
        // so 50/50 is the widest even split a trade can carry.
        let odd = split_trade_fees(1_999, 50, 50).unwrap();
        assert_eq!(odd.creator, 9);
        assert_eq!(odd.platform, 9);
        assert_eq!(net_after_trade_fees(1_999, odd).unwrap(), 1_981);
    }

    #[test]
    fn a_fee_split_may_never_exceed_the_protocol_cap() {
        assert!(split_trade_fees(10_000, MAX_TRADING_FEE_BPS, 0).is_ok());
        assert!(split_trade_fees(10_000, MAX_TRADING_FEE_BPS + 1, 0).is_err());
        assert!(split_trade_fees(10_000, 0, MAX_TRADING_FEE_BPS + 1).is_err());
        // The two together are capped, so a trade can never be all fee.
        assert!(split_trade_fees(10_000, 60, 60).is_err());
        assert!(split_trade_fees(10_000, 50, 50).is_ok());
    }

    #[test]
    fn the_platform_bucket_splits_exactly_between_treasury_and_crank_pool() {
        let cases = [(0u64, 0u16), (10_000, 0), (10_000, 200), (999, 333), (7, 10_000)];
        for (bucket, bps) in cases {
            let (crank, treasury) = split_platform_bucket(bucket, bps).unwrap();
            assert_eq!(crank + treasury, bucket, "bucket {bucket} bps {bps}");
            assert!(crank <= bucket);
        }
        // The default is zero: the crank pool is opt-in, and until it is funded the treasury
        // takes the whole protocol share.
        assert_eq!(
            split_platform_bucket(10_000, DEFAULT_CRANK_POOL_FEE_BPS).unwrap(),
            (0, 10_000)
        );
        assert!(split_platform_bucket(10_000, BPS as u16 + 1).is_err());
    }

    #[test]
    fn a_crank_tip_is_bounded_by_accrued_fees_and_never_by_a_reserve() {
        assert_eq!(max_crank_tip(0).unwrap(), 0);
        assert_eq!(max_crank_tip(10_000).unwrap(), 200);
        // The bound is the protocol bucket, so a tip can never reach the creator's share.
        let fees = split_trade_fees(1_000_000, 50, 50).unwrap();
        assert!(max_crank_tip(fees.platform).unwrap() <= fees.platform);
    }

    #[test]
    fn a_waiver_funds_exactly_the_platform_share() {
        let fees = split_trade_fees(1_000_000, 50, 50).unwrap();
        assert_eq!(waived_platform_fee(1_000_000, 50).unwrap(), fees.platform);
        // The trader's net on a waived trade is the gross minus the creator's share only.
        let waived = TradeFees {
            creator: fees.creator,
            platform: 0,
        };
        assert_eq!(
            net_after_trade_fees(1_000_000, waived).unwrap(),
            1_000_000 - fees.creator
        );
        assert!(waived_platform_fee(1_000_000, MAX_TRADING_FEE_BPS + 1).is_err());
    }

    #[test]
    fn accrued_fees_land_in_the_two_buckets_the_coin_has() {
        let mut coin = Coin::default();
        accrue_coin_fees(&mut coin, split_trade_fees(1_000, 50, 50).unwrap()).unwrap();
        assert_eq!(coin.creator_fee_claimable, 5);
        assert_eq!(coin.platform_fee_claimable, 5);
        accrue_coin_fees(
            &mut coin,
            TradeFees {
                creator: 1,
                platform: 2,
            },
        )
        .unwrap();
        assert_eq!(coin.creator_fee_claimable, 6);
        assert_eq!(coin.platform_fee_claimable, 7);

        // A bucket at the u64 ceiling is a hard error rather than a wrap.
        let mut full = Coin::default();
        full.creator_fee_claimable = u64::MAX;
        assert!(accrue_coin_fees(
            &mut full,
            TradeFees {
                creator: 1,
                platform: 0
            }
        )
        .is_err());
    }
}
