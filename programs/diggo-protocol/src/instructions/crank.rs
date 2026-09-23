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
