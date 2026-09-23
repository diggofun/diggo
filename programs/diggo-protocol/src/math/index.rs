//! math::index.rs (phase 0a mechanical split of lib.rs).

use crate::*;



/// Why a reserve is being debited. The mining and discovery reserves are
/// program-controlled (spec 19, 23, 35): creator, admin and guardian have no path to
/// them, and AdminWithdraw exists so the ledger rejects that idea explicitly rather than
/// merely happening to have no instruction that reaches it.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum ReserveDebit {
    /// Accrued block rewards flowing through the mining reward index.
    MiningClaim,
    /// A server-approved discovery payout.
    DiscoveryClaim,
    /// Any admin, guardian or creator withdrawal. Always rejected.
    AdminWithdraw,
}


/// The single place where a program reserve is allowed to shrink.
pub fn apply_reserve_debit(mine: &mut Mine, debit: ReserveDebit, amount: u64) -> Result<()> {
    match debit {
        ReserveDebit::MiningClaim => {
            mine.remaining_reserve = mine
                .remaining_reserve
                .checked_sub(amount)
                .ok_or(DiggoError::InsufficientReserve)?;
            mine.cumulative_distributed = mine
                .cumulative_distributed
                .checked_add(amount)
                .ok_or(DiggoError::MathOverflow)?;
        }
        ReserveDebit::DiscoveryClaim => {
            mine.remaining_discovery_reserve = mine
                .remaining_discovery_reserve
                .checked_sub(amount)
                .ok_or(DiggoError::InsufficientDiscoveryReserve)?;
        }
        ReserveDebit::AdminWithdraw => return Err(error!(DiggoError::ReserveWithdrawForbidden)),
    }
    Ok(())
}


/// True when this mine owes no further ledger work at `now`: it is not mining, has no
/// power to divide a block reward by, has nothing left to distribute, or has already been
/// walked past `now`. This is exactly the guard the walk opens with, exposed so callers can
/// ask whether a `reward_index` may be settled against without mutating anything.
///
/// Which side can still emit decides whether anything is due, and that is a phase fact about
/// the mine: before graduation only the curve's token inventory may pay a block, after it
/// only the Mining Reserve may. The market, when it is held, is the authority for that phase;
/// a caller that does not hold it (assign_power, remove_power) reads the mine's own mirror of
/// it. Nothing here is decided by whether an optional account was passed.
pub fn sync_is_complete(mine: &Mine, market: Option<&LaunchMarket>, now: i64) -> bool {
    if mine.total_power == 0 || now < mine.next_block_at {
        return true;
    }
    if mine.status == MineStatus::FullyMined {
        return true;
    }
    match market {
        // FullyMined is the only terminal state once the reserve has been the source: the
        // curve is closed at graduation for good, so an empty reserve ends the ledger and an
        // unspent one is still owed blocks. A stretch that ends at the graduation cursor is
        // owed too, even with an empty reserve: those blocks are curve-phase for good, so the
        // walk still has to consume them rather than declaring the ledger settled behind them.
        Some(market) if market.graduated => mine.remaining_reserve == 0 && !curve_phase_pending(mine),
        // Pre-graduation nothing but the curve's inventory may pay a block, and the cursor is
        // never current until it has been walked past every block that landed - a segment with
        // no room left still consumes its blocks, and pays nothing for them. That is what stops
        // a spent curve cap from leaving a pending stretch that the Mining Reserve would pay out
        // in one go the moment the market graduated.
        Some(_) => false,
        // Without the market the walk cannot source the curve's payout, so the only phase it can
        // settle is the reserve one. A non-graduated mine is therefore never complete here: the
        // walk proceeds and refuses with SyncBehind (retryable) rather than declaring the ledger
        // settled. Reading a spent cap as settled was the old answer, and it is exactly the
        // mistake to keep out - "the curve is closed" is a phase fact only the market can report,
        // and the mine's own mirror of it is what a walk must not decide from. No instruction can
        // reach this shape any more either: every instruction that settles a position takes the
        // market as a required account.
        None => mine.graduated && mine.remaining_reserve == 0 && !curve_phase_pending(mine),
    }
}


/// Which side of a mine's ledger pays for the next segment of the walk.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum EmissionSource {
    /// The market's curve token inventory, while the curve phase is open. The payload is
    /// the room left under the launch-time cap.
    Curve(u64),
    /// The mine's own Mining Reserve, which pays from graduation onwards. The payload is
    /// what is left of it.
    Reserve(u64),
}


/// What a cumulative reward index owes a mine's whole power, in base units: the most any
/// position can ever claim from that index, because settling one divides the index delta by
/// `INDEX_SCALE` and every position's power is a share of this total.
///
/// Truncating here and taking the difference between two indexes is what keeps a curve-phase
/// debit exact. The integer index carries its own remainders forward, so a segment that makes
/// the index owe nothing yet debits nothing, and a later segment that finally carries the
/// remainder over debits it - the ledger follows the index instead of approximating it.
pub fn index_owed(index: u128, total_power: u64) -> Result<u64> {
    let owed = index
        .checked_mul(total_power as u128)
        .ok_or(DiggoError::MathOverflow)?
        / INDEX_SCALE;
    u64::try_from(owed).map_err(|_| error!(DiggoError::MathOverflow))
}


impl EmissionSource {
    /// Tokens this side may still emit, which is what a segment is clamped to.
    fn room(self) -> u64 {
        match self {
            EmissionSource::Curve(room) | EmissionSource::Reserve(room) => room,
        }
    }
}


/// Walks the mining ledger forward from its persisted cursors, doing at most
/// `max_segments` segments of work, and reports whether it reached `now`.
///
/// All of the progress lives in the mine account itself — `next_block_at`, `epoch`,
/// `epoch_ends_at`, `current_block_reward`, `reward_index` and `remaining_reserve` — so a
/// caller that is further behind than one transaction can afford simply calls again: the
/// walk resumes where it stopped and folds to the identical ledger a single unbounded pass
/// would have produced, no matter how many calls that takes. Every segment strictly
/// advances `next_block_at`, so each call that reports `Behind` has made real progress and
/// the walk always terminates.
///
/// The cost of one segment is bounded because launch validation forces
/// `epoch_length >= block_interval` (see `validate_launch_args`): the cursor can overshoot
/// an epoch boundary by less than one epoch, so the rollover loop runs at most once per
/// segment. Without that invariant a single segment could roll an unbounded number of
/// epochs.
pub fn sync_mine_with_budget(
    mine: &mut Mine,
    mut market: Option<&mut LaunchMarket>,
    now: i64,
    max_segments: usize,
) -> Result<SyncProgress> {
    // Which side pays is a phase fact, read from the market when the caller holds it and
    // otherwise from the mine's own mirror of it — never from whether the optional account
    // happened to be passed. That distinction is the whole point: a spent curve cap used to
    // look exactly like a graduated market to a caller without the market, and the walk then
    // paid curve-phase blocks out of the Mining Reserve. Refreshing the mirror first means the
    // single read below is the market's own answer whenever the market is held, and that a
    // caller which holds the market always leaves the mirror current - even when the ledger was
    // already caught up and nothing else changed.
    if let Some(active) = market.as_deref() {
        sync_mine_phase(mine, active);
    }
    let graduated = mine.graduated;
    if sync_is_complete(mine, market.as_deref(), now) {
        return Ok(SyncProgress::CaughtUp);
    }
    // A non-positive schedule length would stop one of the two loops below from advancing,
    // so a corrupted or legacy account fails here instead of spinning until the compute
    // budget kills the transaction.
    require!(
        mine.block_interval > 0 && mine.epoch_length > 0,
        DiggoError::InvalidSchedule
    );
    // Pre-graduation emission may only ever come out of the curve's own token inventory, and
    // only the market carries that ledger. Paying from the Mining Reserve instead would create
    // tokens the curve never gave up and leave the price where it was, so a caller that did not
    // hand the market over is told to retry rather than handed a reserve payout it is not owed.
    require!(market.is_some() || graduated, DiggoError::SyncBehind);
    let mut segments = 0usize;
    while now >= mine.next_block_at {
        if segments >= max_segments {
            // Budget spent: leave every cursor exactly where it is, so the next call
            // continues from here instead of losing the work.
            return Ok(SyncProgress::Behind);
        }
        // Which side pays for this segment, and how much room it has left. Before
        // graduation that is only ever the curve's token inventory, bounded by the
        // launch-time cap; a spent cap pays nothing at all rather than moving the walk onto
        // the Mining Reserve, which is only ever paid out after graduation.
        //
        // The graduation cursor is read first, because a block that landed before it is
        // curve-phase whatever the flag says now: graduate_market walks the ledger to that
        // instant before it flips anything (see sync_mine_for_graduation), so the two only
        // disagree on an account whose flag was set without the walk. Those blocks pay nothing -
        // the curve's inventory has moved into the pool by then and its cap is frozen at
        // graduation - rather than draining the reserve with emission the curve phase never
        // made. A segment is classified by the block it starts on, and because the cursor and
        // the walk's own position coincide in the ordinary path, no segment straddles it there.
        let source = if mine.next_block_at < mine.curve_phase_ends_at || !graduated {
            EmissionSource::Curve(match market.as_deref() {
                Some(active) if !active.graduated => curve_mining_room(active),
                _ => 0,
            })
        } else {
            EmissionSource::Reserve(mine.remaining_reserve)
        };
        while mine.next_block_at >= mine.epoch_ends_at {
            mine.current_block_reward = reduced_reward(
                mine.current_block_reward,
                mine.reduction_bps,
                mine.minimum_reward,
            )?;
            mine.epoch = mine.epoch.checked_add(1).ok_or(DiggoError::MathOverflow)?;
            mine.epoch_ends_at = mine
                .epoch_ends_at
                .checked_add(mine.epoch_length)
                .ok_or(DiggoError::MathOverflow)?;
        }
        let blocks_due = ((now - mine.next_block_at) / mine.block_interval + 1) as u64;
        let blocks_until_epoch = (((mine.epoch_ends_at - mine.next_block_at - 1).max(0))
            / mine.block_interval
            + 1) as u64;
        let blocks = blocks_due.min(blocks_until_epoch.max(1));
        // A segment with no room left on its side is still consumed: the cursor moves past the
        // blocks that landed while nothing could pay them, and they accrue nothing. That is
        // what keeps a spent curve cap idle rather than pending — if the cursor stayed put, the
        // whole idle stretch would be paid out of the Mining Reserve the moment the market
        // graduated, which is the same wrong-side payout in a slower shape.
        if source.room() > 0 {
            // The curve phase pays a flat rate — the cap spread over the launch runway — and
            // deliberately not the mine's own reserve schedule. That schedule keeps stepping
            // down on every epoch rollover so that the whole Mining Reserve stays distributable
            // once the market graduates, and it is far too large to spread a 5% curve budget
            // over anything but hours.
            let rate = match source {
                EmissionSource::Curve(_) => market
                    .as_deref()
                    .map(|active| active.curve_mining_block_reward)
                    .unwrap_or(0),
                EmissionSource::Reserve(_) => mine.current_block_reward,
            };
            let requested = (rate as u128)
                .checked_mul(blocks as u128)
                .ok_or(DiggoError::MathOverflow)?;
            let distributed = requested.min(source.room() as u128) as u64;
            let index_delta = (distributed as u128)
                .checked_mul(INDEX_SCALE)
                .ok_or(DiggoError::MathOverflow)?
                / mine.total_power as u128;
            // What the index owed this mine's power before this segment, and what it owes after
            // it. The difference is the exact amount the segment made claimable, carry included.
            let owed_before = index_owed(mine.reward_index, mine.total_power)?;
            let next_reward_index = mine
                .reward_index
                .checked_add(index_delta)
                .ok_or(DiggoError::MathOverflow)?;
            let owed_increment = index_owed(next_reward_index, mine.total_power)?
                .checked_sub(owed_before)
                .ok_or(DiggoError::MathOverflow)?;
            mine.reward_index = next_reward_index;
            if distributed > 0 {
                match source {
                    // The curve's inventory is debited through its own ledger, which is the only
                    // thing that may ever shrink it for a reason other than a buy and which
                    // refuses every source but a settled mining emission.
                    //
                    // It is debited by what the index can actually pay, not by the segment's
                    // budget: the index divides the budget by the mine's power and truncates, so
                    // a remainder can be owed to nobody at all. Debiting it anyway would park it
                    // in curve_mining_unpaid - counted as claimable for the rest of the market's
                    // life, and stranded in the market vault at graduation, because graduation
                    // moves the curve's inventory into the pool and deliberately leaves the
                    // unpaid part behind. Left where it is, the remainder is curve inventory, so
                    // it seeds the pool exactly like any other unsold token.
                    //
                    // The clamp is against the room curve_mining_room reports, which is the cap
                    // room bounded by the inventory the curve actually holds - so the debit below
                    // can never be refused for liquidity, whatever a buy did to the token
                    // reserve, and the walk always gets past its segment. The index is advanced
                    // by what this clamp allows, so only what is debited is ever credited: a
                    // segment the inventory cannot cover credits nothing and pays nothing.
                    EmissionSource::Curve(_) => {
                        let owed = owed_increment.min(source.room());
                        if owed > 0 {
                            let active = market.as_deref_mut().ok_or(DiggoError::SyncBehind)?;
                            apply_curve_mining_debit(active, CurveDebit::MiningEmission, owed)?;
                        }
                    }
                    // The Mining Reserve is only ever debited through this ledger, which refuses
                    // every source other than a real mining claim. It takes the whole clamped
                    // segment: the reserve is the mine's own budget and its last block is defined
                    // as taking whatever is left, which is what makes FullyMined reachable. Its
                    // leftovers stay in the mine's own reserve vault either way, so unlike the
                    // curve's they are never moved by another instruction.
                    EmissionSource::Reserve(_) => {
                        apply_reserve_debit(mine, ReserveDebit::MiningClaim, distributed)?
                    }
                }
            }
        }
        // The terminal state is reachable as soon as the reserve side is empty, and it is set
        // here as well as after the loop because a call that runs out of its segment budget
        // returns Behind without reaching the tail: leaving the status behind would let the
        // next call short-circuit on an exhausted reserve that still reads MiningActive.
        if graduated && mine.remaining_reserve == 0 && !curve_phase_pending(mine) {
            mine.status = MineStatus::FullyMined;
        }
        mine.next_block_at = mine
            .next_block_at
            .checked_add(
                mine.block_interval
                    .checked_mul(blocks as i64)
                    .ok_or(DiggoError::MathOverflow)?,
            )
            .ok_or(DiggoError::MathOverflow)?;
        segments += 1;
    }
    // FullyMined keeps exactly the meaning it always had — there is nothing left to pay
    // out — so it is only reached once the reserve has been the source and is empty. A
    // curve-phase mine whose cap is spent is idle, not finished: its Mining Reserve is
    // untouched and graduation turns it back on.
    if graduated && mine.remaining_reserve == 0 && !curve_phase_pending(mine) {
        mine.status = MineStatus::FullyMined;
    }
    // A segment can spend the last of the curve's cap, so the mirror the walk reads at its own
    // start is refreshed here too: a caller that holds the market always leaves it describing
    // the state the walk just produced.
    if let Some(active) = market.as_deref() {
        sync_mine_phase(mine, active);
    }
    Ok(SyncProgress::CaughtUp)
}


pub fn settle_position(position: &mut MiningPositionV4, mine: &Mine) -> Result<()> {
    if position.assigned_power == 0 {
        position.last_reward_index = mine.reward_index;
        return Ok(());
    }
    let delta = mine
        .reward_index
        .checked_sub(position.last_reward_index)
        .ok_or(DiggoError::MathOverflow)?;
    let earned = (position.assigned_power as u128)
        .checked_mul(delta)
        .ok_or(DiggoError::MathOverflow)?
        / INDEX_SCALE;
    let earned = u64::try_from(earned).map_err(|_| error!(DiggoError::MathOverflow))?;
    position.pending_reward = position
        .pending_reward
        .checked_add(earned)
        .ok_or(DiggoError::MathOverflow)?;
    position.last_reward_index = mine.reward_index;
    Ok(())
}
