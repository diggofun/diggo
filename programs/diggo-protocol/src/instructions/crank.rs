//! instructions::crank.rs (phase 0a mechanical split of lib.rs).

use crate::*;



/// How far one bounded ledger walk got.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SyncProgress {
    /// Every block and epoch due at `now` has been accounted for.
    CaughtUp,
    /// The per-call segment budget ran out and the mine is still behind `now`.
    Behind,
}


/// The production ledger walk: MAX_SYNC_SEGMENTS per call.
pub fn sync_mine(
    mine: &mut Mine,
    market: Option<&mut LaunchMarket>,
    now: i64,
) -> Result<SyncProgress> {
    sync_mine_with_budget(mine, market, now, MAX_SYNC_SEGMENTS)
}


/// Walks the ledger to `now`, or refuses with SyncBehind.
///
/// The instructions that settle a position against `mine.reward_index` may only run on a
/// ledger that has accounted for every due block. Settling against a half-walked index
/// would credit the elapsed epochs the walk got through and then hide the rest behind
/// `last_reward_index`, permanently forfeiting them — so a partially synced index is never
/// spendable. The refusal locks nothing: `advance_mine` is permissionless, so anyone can
/// walk the mine forward MAX_SYNC_SEGMENTS at a time until this call succeeds.
pub fn sync_mine_to_now(
    mine: &mut Mine,
    market: Option<&mut LaunchMarket>,
    now: i64,
) -> Result<()> {
    match sync_mine(mine, market, now)? {
        SyncProgress::CaughtUp => Ok(()),
        SyncProgress::Behind => Err(error!(DiggoError::SyncBehind)),
    }
}


/// The ledger half of graduation: walks the mine to `now` while its market is still on the
/// curve, so every block that landed before graduation is paid by the side that was open when
/// it landed - the curve's token inventory - and refuses with SyncBehind when the mine is
/// further behind than one bounded walk can cover.
///
/// graduate_market may not flip the phase without this. The walk derives the emission source
/// from the phase at walk time, so a market that graduated with an un-walked stretch behind it
/// would pay that whole stretch out of the Mining Reserve the first time anybody walked it:
/// tokens the curve never gave up, at the reserve's own far larger rate, with
/// `curve_mining_mined` still reading zero and the cap unspent. The refusal is the retryable
/// answer - `advance_mine` is permissionless, so the caller catches the mine up and calls
/// again - and the walk's progress is committed either way, which makes the retry cheaper than
/// the call that was refused.
pub fn sync_mine_for_graduation(
    mine: &mut Mine,
    market: &mut LaunchMarket,
    now: i64,
) -> Result<()> {
    sync_mine_phase(mine, market);
    match sync_mine(mine, Some(market), now)? {
        SyncProgress::CaughtUp => Ok(()),
        SyncProgress::Behind => Err(error!(DiggoError::SyncBehind)),
    }
}

// ---- v2: what a public crank can do for one coin (design 6) ------------------------------

/// The work a permissionless crank can do for one v2 coin right now.
///
/// The crank is a client-side decision, not a program one: every one of these is a
/// permissionless instruction whose condition the program re-derives, so a plan that is
/// stale by the time the transaction lands fails loudly rather than paying anything wrong.
/// The plan exists so a cranker can find the work without indexing every account, and so the
/// conditions live in one place that can be unit-tested.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CoinCrankPlan {
    /// The ledger is behind now, so advance_mine has blocks or epochs to account for.
    pub advance: bool,
    /// A seed target has passed and this epoch's seed is not recorded yet.
    pub reveal_seed: bool,
    /// A seed is recorded, so pending opportunities for this coin can be settled.
    pub settle_discovery: bool,
    /// The curve has reached its graduation target and has not graduated.
    pub graduate: bool,
}

impl CoinCrankPlan {
    /// True when there is nothing worth a transaction.
    pub fn is_idle(&self) -> bool {
        !self.advance && !self.reveal_seed && !self.settle_discovery && !self.graduate
    }
}

/// Plans the crank for one coin. Pure: it reads the coin, the protocol and the clock, and
/// mutates nothing, so it can be asked as often as a client likes.
pub fn plan_coin_crank(
    coin: &Coin,
    protocol: &ProtocolConfig,
    now: i64,
    slot: u64,
) -> CoinCrankPlan {
    let _ = protocol;
    let advance = !coin_sync_is_complete(coin, now);
    // The reveal is due once the armed target slot has passed, and only until this epoch's
    // seed is in. A late crank is not a stuck crank: commit_epoch_seed re-arms instead of
    // committing once it is past the lateness bound.
    let reveal_seed = coin.epoch_seed_target_slot > 0
        && coin.epoch_seed_target_slot <= slot
        && (coin.epoch_seed_recorded_slot == 0 || coin.epoch_seed_epoch < coin.epoch_index);
    // Settlement is impossible without a seed, which is why a missed reveal delays payouts
    // rather than making them predictable.
    let settle_discovery = coin.epoch_seed_recorded_slot > 0;
    // graduate_market is WS-B's instruction; the condition is the coin's own reserves.
    let graduate = coin.graduated == 0
        && coin.graduation_target > 0
        && coin.sol_reserve >= coin.graduation_target;
    CoinCrankPlan {
        advance,
        reveal_seed,
        settle_discovery,
        graduate,
    }
}

/// The most a crank_tip may pay for one coin: CRANK_TIP_BPS of the coin's accrued fees,
/// bounded by the caller's own ceiling and never more than the accrual itself. Accrual only,
/// so a tip can never come out of a reserve or out of the locked LP.
pub fn bounded_crank_tip(accrued_lamports: u64, max_tip: u64) -> Result<u64> {
    Ok(mul_bps(accrued_lamports, CRANK_TIP_BPS)?.min(max_tip))
}

#[cfg(test)]
mod v2_crank_tests {
    use super::*;

    fn protocol() -> ProtocolConfig {
        ProtocolConfig::default()
    }

    fn idle_coin() -> Coin {
        Coin {
            total_power: 100,
            bonded_power: 100,
            current_block_reward: 1_000,
            block_interval: 300,
            epoch_length: 604_800,
            epoch_ends_at: 604_800,
            next_block_at: 10_000,
            reserve_remaining: 1_000,
            graduation_target: 1_000_000,
            sol_reserve: 10,
            status: COIN_STATUS_MINING_ACTIVE,
            graduated: 1,
            ..Default::default()
        }
    }

    #[test]
    fn a_caught_up_coin_with_nothing_pending_is_idle() {
        let plan = plan_coin_crank(&idle_coin(), &protocol(), 5_000, 100);
        assert!(plan.is_idle(), "unexpected work planned");
    }

    #[test]
    fn a_ledger_behind_now_asks_for_advance() {
        let plan = plan_coin_crank(&idle_coin(), &protocol(), 20_000, 100);
        assert!(plan.advance);
        assert!(!plan.is_idle());
    }

    #[test]
    fn a_passed_target_asks_for_the_reveal_until_the_seed_is_in() {
        let mut coin = idle_coin();
        coin.epoch_seed_target_slot = 500;
        assert!(!plan_coin_crank(&coin, &protocol(), 5_000, 499).reveal_seed);
        assert!(plan_coin_crank(&coin, &protocol(), 5_000, 500).reveal_seed);
        coin.epoch_seed_recorded_slot = 500;
        coin.epoch_seed_epoch = coin.epoch_index;
        assert!(!plan_coin_crank(&coin, &protocol(), 5_000, 900).reveal_seed);
        coin.epoch_index += 1;
        assert!(plan_coin_crank(&coin, &protocol(), 5_000, 900).reveal_seed);
    }

    #[test]
    fn settlement_is_only_planned_once_a_seed_exists() {
        let mut coin = idle_coin();
        assert!(!plan_coin_crank(&coin, &protocol(), 5_000, 100).settle_discovery);
        coin.epoch_seed_recorded_slot = 42;
        assert!(plan_coin_crank(&coin, &protocol(), 5_000, 100).settle_discovery);
    }

    #[test]
    fn graduation_is_planned_when_the_target_is_reached_and_not_before() {
        let mut coin = idle_coin();
        coin.graduated = 0;
        coin.graduation_target = 1_000_000;
        coin.sol_reserve = 999_999;
        assert!(!plan_coin_crank(&coin, &protocol(), 5_000, 100).graduate);
        coin.sol_reserve = 1_000_000;
        assert!(plan_coin_crank(&coin, &protocol(), 5_000, 100).graduate);
        coin.graduated = 1;
        assert!(!plan_coin_crank(&coin, &protocol(), 5_000, 100).graduate);
    }

    #[test]
    fn a_tip_is_bounded_by_the_accrual_and_by_the_callers_ceiling() {
        // CRANK_TIP_BPS is 200, so 2% of the accrual.
        assert_eq!(bounded_crank_tip(1_000_000, u64::MAX).unwrap(), 20_000);
        assert_eq!(bounded_crank_tip(1_000_000, 5).unwrap(), 5);
        assert_eq!(bounded_crank_tip(0, 5).unwrap(), 0);
        assert!(bounded_crank_tip(10, u64::MAX).unwrap() <= 10);
    }
}
