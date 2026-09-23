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
/// All of the progress lives in the mine account itself â€” `next_block_at`, `epoch`,
/// `epoch_ends_at`, `current_block_reward`, `reward_index` and `remaining_reserve` â€” so a
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
    // otherwise from the mine's own mirror of it â€” never from whether the optional account
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
        // what keeps a spent curve cap idle rather than pending â€” if the cursor stayed put, the
        // whole idle stretch would be paid out of the Mining Reserve the moment the market
        // graduated, which is the same wrong-side payout in a slower shape.
        if source.room() > 0 {
            // The curve phase pays a flat rate â€” the cap spread over the launch runway â€” and
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
    // FullyMined keeps exactly the meaning it always had â€” there is nothing left to pay
    // out â€” so it is only reached once the reserve has been the source and is empty. A
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

// ---- v2: the two-tranche reward index (design 3.2 amendment, 4.1, 8.2) -------------------
//
// A v2 Coin is its own market: one account carries the curve inventory, the Mining Reserve, the
// two tranche powers and one cumulative index per tranche, and the walk reads the phase out of it
// directly.
//
// The tranche rule (docs/ONCHAIN_V2_DESIGN.md 3.2, CONTRACTS.md "Amendment: STARTER_TRANCHE_CAP")
// has two bounds that apply at once and that neither can be traded for the other: an unbonded
// player's power is already STARTER_EFFICIENCY_BPS of the same maturity-adjusted power, and the
// whole starter tranche may never receive more than STARTER_TRANCHE_BPS of one block's reward.
//
// This file is the single definition of both indexes, and the walk is their only writer. A
// position stores the index of the tranche it accrues in and settles against that field; nothing
// derives one index from the other, and no second implementation of the rule exists anywhere in
// the tree.
//
// A stored starter index is what makes the cap exact. The walk credits the starter tranche its
// proportional share of the block and clamps it to STARTER_TRANCHE_BPS, and the clamp is
// representable precisely because the starter index is stored rather than computed from the
// bonded one. The earlier derivation (reward_index * E * T / BPS^2) made the starter's share of a
// block a function of the two powers alone - S*E*T / (S*E*T + B*BPS^2) - so the cap could only
// hold while starter_power * E * (BPS - T) <= bonded_power * BPS^2, and a coin outside that
// regime had to assign the block nothing at all rather than over-pay the tranche. Both of those
// rows are resolved by the two-index shape. See docs/CONTRACT_CHANGE_REQUESTS.md.

/// The cumulative index a position of this tranche settles against. The one definition every
/// settle path and the walk itself read.
pub fn tranche_index(coin: &Coin, tranche: u8) -> u128 {
    if tranche == TRANCHE_STARTER {
        coin.starter_index
    } else {
        coin.bonded_index
    }
}

/// The most one block's reward may hand the starter tranche, in base units.
pub fn starter_tranche_cap(reward: u64, protocol: &ProtocolConfig) -> Result<u64> {
    mul_bps(reward, protocol.starter_tranche_bps)
}

/// One block's (or one segment's) reward, split between the two tranches.
///
/// The two takes add up to the whole reward whenever the bonded tranche can be credited, and to
/// exactly the starter's capped share when it cannot, so a caller can always treat assigned() as
/// the amount that leaves the emission source. Rounding is down on both sides, which is the
/// protocol's favour.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TrancheSplit {
    pub bonded: u64,
    pub starter: u64,
}

impl TrancheSplit {
    /// The part of the block the two indexes are credited with. The rest stays in the emission
    /// source: it is never burned and never re-assigned to the starter index.
    pub fn assigned(self) -> u64 {
        self.bonded.saturating_add(self.starter)
    }
}

/// Splits one block's reward between the bonded and the starter tranche.
///
/// The starter tranche takes its proportional share of the block - starter_power over the whole
/// power, and starter_power is already scaled by the efficiency bound, so both of the amendment's
/// bounds are in that one ratio - clamped to STARTER_TRANCHE_BPS of the block. The bonded tranche
/// takes the rest.
///
/// Two consequences are the amendment, stated as arithmetic:
///
///   - a bonded position always keeps at least (BPS - T) of every block, because the starter's
///     take can never pass the cap;
///   - a coin with no bonded power assigns the starter tranche its cap and nothing else. The
///     bonded take has nowhere to go - there is no bonded power to divide it by - so it stays in
///     the emission source, which is the Mining Reserve. It is never burned and never re-assigned
///     to the starter index.
///
/// What this returns is what the walk credits, so assigned() is exactly what leaves the emission
/// source; the indexes' own truncation can only make the credited amount smaller, and the
/// difference stays in the source with the rest.
pub fn split_block_reward(
    reward: u64,
    coin: &Coin,
    protocol: &ProtocolConfig,
) -> Result<TrancheSplit> {
    if reward == 0 {
        return Ok(TrancheSplit::default());
    }
    let total_power = coin
        .bonded_power
        .checked_add(coin.starter_power)
        .ok_or(DiggoError::MathOverflow)?;
    if total_power == 0 {
        return Ok(TrancheSplit::default());
    }
    if coin.starter_power == 0 {
        return Ok(TrancheSplit {
            bonded: reward,
            starter: 0,
        });
    }
    let ideal = (reward as u128)
        .checked_mul(coin.starter_power as u128)
        .ok_or(DiggoError::MathOverflow)?
        / total_power as u128;
    let cap = starter_tranche_cap(reward, protocol)?;
    let starter = u64::try_from(ideal.min(cap as u128))
        .map_err(|_| error!(DiggoError::MathOverflow))?;
    let bonded = if coin.bonded_power > 0 {
        reward.saturating_sub(starter)
    } else {
        0
    };
    Ok(TrancheSplit { bonded, starter })
}

/// The index a freshly created position starts from. A caller that creates a MiningPosition must
/// store this in its last_reward_index (design 3.3).
pub fn position_initial_index(coin: &Coin, tranche: u8) -> u128 {
    tranche_index(coin, tranche)
}

/// Settles one position against the index of the tranche it accrues in, gated by the owner's
/// activation window, and re-anchors it. Returns (credited, forfeited).
///
/// The window is half open, exactly as the worker's isEligibleForBlock describes it -
/// [last_activation_at, active_until) - and it is the whole rule: a position earns only while the
/// window is open. The walk cannot see per-position windows and must not have to, so it credits
/// every armed position's share into outstanding_claims as the index advances, and this is where
/// eligibility is enforced, lazily, at the only moment the program knows who is asking.
///
/// A settle that finds the window closed therefore puts the share the index credited to this
/// position since its last settle back into the emission source (Coin::forfeit_emission) and
/// advances the cursor, so nothing after active_until is claimable now or later. That is the
/// off-chain rule - a lapsed position is paused and forfeits its share - done without a keeper,
/// without an operator and without an extra account.
///
/// The honest client never meets the forfeit: activate settles the position before it moves the
/// window, and REACTIVATION_EARLY_SECONDS lets the legal re-activation land inside the window it
/// closes, so a player who activates each window settles exactly. A player who lets the window
/// lapse forfeits the accrual of the whole interval since their last settle: bounded by that
/// interval, never negative for the coin, and never claimable afterwards. That is the one
/// residual, and it is stated in CONTRACTS.md rather than hidden.
pub fn settle_position_gated(
    position: &mut MiningPosition,
    coin: &mut Coin,
    activated: bool,
) -> Result<(u64, u64)> {
    let index = tranche_index(coin, position.tranche);
    if position.assigned_power == 0 {
        position.last_reward_index = index;
        return Ok((0, 0));
    }
    let delta = index
        .checked_sub(position.last_reward_index)
        .ok_or(DiggoError::MathOverflow)?;
    let share = u64::try_from(
        (position.assigned_power as u128)
            .checked_mul(delta)
            .ok_or(DiggoError::MathOverflow)?
            / INDEX_SCALE,
    )
    .map_err(|_| error!(DiggoError::MathOverflow))?;
    position.last_reward_index = index;
    if !activated {
        coin.forfeit_emission(share)?;
        return Ok((0, share));
    }
    position.pending_reward = position
        .pending_reward
        .checked_add(share)
        .ok_or(DiggoError::MathOverflow)?;
    Ok((share, 0))
}

/// Which side of a v2 coin's ledger pays for the next segment of the walk.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CoinEmissionSource {
    /// The curve's token inventory, while the coin has not graduated. The payload is the
    /// room left under the launch-time cap and the inventory that can pay it.
    Curve(u64),
    /// The coin's own Mining Reserve, which pays from graduation onwards.
    Reserve(u64),
}

impl CoinEmissionSource {
    pub fn room(self) -> u64 {
        match self {
            CoinEmissionSource::Curve(room) | CoinEmissionSource::Reserve(room) => room,
        }
    }
}

/// Room left under a coin's immutable curve-mining cap, bounded by the inventory the curve
/// still holds and by the reserved last base unit, exactly as the v4 market's room is.
pub fn coin_curve_mining_room(coin: &Coin) -> u64 {
    if coin.graduated != 0 {
        return 0;
    }
    coin.curve_mining_cap
        .saturating_sub(coin.curve_mining_mined)
        .min(coin.token_reserve.saturating_sub(1))
}

/// True while a graduated coin still owes blocks that landed before its graduation cursor.
pub fn coin_curve_phase_pending(coin: &Coin) -> bool {
    coin.graduated != 0 && coin.curve_phase_ends_at > 0 && coin.next_block_at < coin.curve_phase_ends_at
}

/// Which side pays the next segment. A block that landed before the graduation cursor is
/// curve-phase for good, whatever the flag says now, so those blocks pay nothing rather than
/// draining the reserve with emission the curve phase never made.
pub fn coin_emission_source(coin: &Coin) -> CoinEmissionSource {
    if coin.next_block_at < coin.curve_phase_ends_at || coin.graduated == 0 {
        CoinEmissionSource::Curve(coin_curve_mining_room(coin))
    } else {
        CoinEmissionSource::Reserve(coin.reserve_remaining)
    }
}

/// True when a v2 coin owes no further ledger work at `now`.
pub fn coin_sync_is_complete(coin: &Coin, now: i64) -> bool {
    if coin.total_power == 0 || now < coin.next_block_at {
        return true;
    }
    if coin.status == COIN_STATUS_FULLY_MINED {
        return true;
    }
    if coin.graduated == 0 {
        // Pre-graduation only the curve's inventory may pay a block, and a segment with no
        // room left still has to be consumed rather than left pending for the reserve.
        return false;
    }
    coin.reserve_remaining == 0 && !coin_curve_phase_pending(coin)
}

/// Debits a coin's curve token inventory for a settled mining emission. The single place
/// the inventory may shrink for a reason other than a buy.
pub fn apply_coin_curve_debit(coin: &mut Coin, amount: u64) -> Result<()> {
    require!(coin.graduated == 0, DiggoError::MarketGraduated);
    require!(amount > 0, DiggoError::InvalidAmount);
    let mined = coin
        .curve_mining_mined
        .checked_add(amount)
        .ok_or(DiggoError::MathOverflow)?;
    require!(
        mined <= coin.curve_mining_cap,
        DiggoError::CurveMiningCapExceeded
    );
    coin.token_reserve = coin
        .token_reserve
        .checked_sub(amount)
        .ok_or(DiggoError::InsufficientLiquidity)?;
    coin.curve_mining_mined = mined;
    coin.curve_mining_unpaid = coin
        .curve_mining_unpaid
        .checked_add(amount)
        .ok_or(DiggoError::MathOverflow)?;
    Ok(())
}

/// What one bounded walk did, so the instruction that drove it can emit the epoch events.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CoinSyncOutcome {
    pub progress: SyncProgress,
    pub epochs_rolled: u32,
    /// The seed target the walk armed, or zero when it rolled no epoch.
    pub target_slot: u64,
}

/// The slot span a v2 coin predicts for one epoch, measured from the slot span the previous
/// epoch actually took.
///
/// An epoch's length is a duration and the seed target is a slot, and nothing on chain maps
/// one to the other: there is no slots-per-second field, and a compiled-in one would drift
/// against the cluster. The coin already records the slot it expected the last epoch to end
/// at, so the honest answer is the one it can observe - how many slots actually passed - and
/// a walk that is several epochs behind divides that span by the number of epochs it rolled,
/// which keeps the prediction from growing without bound. When there is nothing to observe
/// (the first rollover, or a cursor that is not in the past) the prediction falls back to
/// SLOT_HASHES_WINDOW, which is far enough ahead that the armed target is still in the
/// future - the one property the seed depends on.
pub fn predict_epoch_span_slots(coin: &Coin, slot: u64, epochs_rolled: u32) -> u64 {
    if coin.epoch_ends_slot == 0 || slot <= coin.epoch_ends_slot {
        return SLOT_HASHES_WINDOW;
    }
    let span = slot - coin.epoch_ends_slot;
    let epochs = (epochs_rolled.max(1)) as u64;
    (span / epochs).max(1)
}

/// Rolls the coin's epoch cursor forward by one epoch: the reward steps down, the discovery
/// budget for the new epoch is recomputed from the protocol's share, and the spent counter
/// restarts.
pub fn roll_coin_epoch(coin: &mut Coin, protocol: &ProtocolConfig) -> Result<()> {
    coin.current_block_reward = reduced_reward(
        coin.current_block_reward,
        coin.reduction_bps,
        coin.minimum_reward,
    )?;
    coin.epoch_index = coin
        .epoch_index
        .checked_add(1)
        .ok_or(DiggoError::MathOverflow)?;
    coin.epoch_ends_at = coin
        .epoch_ends_at
        .checked_add(coin.epoch_length as i64)
        .ok_or(DiggoError::MathOverflow)?;
    coin.discovery_epoch_index = coin.epoch_index;
    coin.discovery_epoch_spent = 0;
    coin.discovery_epoch_budget = mul_bps(
        coin.discovery_reserve_total,
        protocol.discovery_epoch_budget_bps,
    )?;
    Ok(())
}

/// Arms the next epoch seed target at a slot that has not been produced yet.
///
/// The target is a whole predicted epoch past the roll, so the hash it names cannot be known
/// while the epoch's rolls are being created, which is the whole of the commit half of design
/// 4.1. The delay is added on top of the predicted end so the reveal lands after the epoch has
/// closed even if the prediction is a little short.
pub fn arm_epoch_seed(
    coin: &mut Coin,
    protocol: &ProtocolConfig,
    slot: u64,
    epochs_rolled: u32,
) -> Result<u64> {
    let span = predict_epoch_span_slots(coin, slot, epochs_rolled);
    let delay = protocol.epoch_seed_delay_slots.max(1);
    coin.epoch_ends_slot = slot
        .checked_add(span)
        .ok_or(DiggoError::MathOverflow)?;
    let target = coin
        .epoch_ends_slot
        .checked_add(delay)
        .ok_or(DiggoError::MathOverflow)?;
    coin.epoch_seed_target_slot = target;
    Ok(target)
}

/// Walks a v2 coin's ledger forward from its persisted cursors, doing at most
/// `max_segments` segments of work, and reports whether it reached `now`.
///
/// All progress lives in the coin account, so a caller further behind than one transaction
/// can afford simply calls again and the walk resumes where it stopped, folding to the
/// identical ledger an unbounded pass would have produced. Every segment strictly advances
/// `next_block_at`, so each call that reports Behind has made real progress and the walk
/// always terminates. The cost of one segment is bounded because launch validation forces
/// `epoch_length >= block_interval`, so the rollover loop runs at most once per segment.
///
/// The tranche split is applied to the segment's budget and then credited through the two
/// indexes, and the emission source is debited by exactly what the indexes credit, so
/// `reserve_remaining + cumulative_distributed + outstanding_claims` is conserved across
/// every path and the vault ledger invariant holds by construction.
/// Kept out of line on purpose: this is the largest frame in the program, and inlining it
/// into an instruction handler is what pushes an SBF frame past the 4 KB the stack checker
/// allows.
#[inline(never)]
pub fn sync_coin_with_budget(
    coin: &mut Coin,
    protocol: &ProtocolConfig,
    now: i64,
    slot: u64,
    max_segments: usize,
) -> Result<CoinSyncOutcome> {
    let mut outcome = CoinSyncOutcome {
        progress: SyncProgress::CaughtUp,
        epochs_rolled: 0,
        target_slot: 0,
    };
    if coin_sync_is_complete(coin, now) {
        return Ok(outcome);
    }
    require!(
        coin.block_interval > 0 && coin.epoch_length > 0,
        DiggoError::InvalidSchedule
    );
    let mut segments = 0usize;
    while now >= coin.next_block_at {
        if segments >= max_segments {
            outcome.progress = SyncProgress::Behind;
            return Ok(outcome);
        }
        let source = coin_emission_source(coin);
        let mut epochs_here = 0u32;
        while coin.next_block_at >= coin.epoch_ends_at {
            roll_coin_epoch(coin, protocol)?;
            epochs_here = epochs_here.saturating_add(1);
        }
        if epochs_here > 0 {
            let target = arm_epoch_seed(coin, protocol, slot, epochs_here)?;
            outcome.epochs_rolled = outcome.epochs_rolled.saturating_add(epochs_here);
            outcome.target_slot = target;
        }
        let blocks_due = ((now - coin.next_block_at) / coin.block_interval as i64 + 1) as u64;
        let blocks_until_epoch = (((coin.epoch_ends_at - coin.next_block_at - 1).max(0))
            / coin.block_interval as i64
            + 1) as u64;
        let blocks = blocks_due.min(blocks_until_epoch.max(1));
        if source.room() > 0 {
            let rate = match source {
                CoinEmissionSource::Curve(_) => coin.curve_mining_block_reward,
                CoinEmissionSource::Reserve(_) => coin.current_block_reward,
            };
            let requested = (rate as u128)
                .checked_mul(blocks as u128)
                .ok_or(DiggoError::MathOverflow)?;
            let budget = requested.min(source.room() as u128) as u64;
            let split = split_block_reward(budget, coin, protocol)?;
            // Each tranche advances its own index by its own take over its own power. There is no
            // shared denominator any more: the split already clamped the starter's take to the
            // tranche cap, so crediting it over the starter power is exact and the cap holds by
            // construction rather than by an inequality on the two powers.
            let previous_bonded = coin.bonded_index;
            let previous_starter = coin.starter_index;
            let next_bonded = if coin.bonded_power > 0 && split.bonded > 0 {
                previous_bonded
                    .checked_add(
                        (split.bonded as u128)
                            .checked_mul(INDEX_SCALE)
                            .ok_or(DiggoError::MathOverflow)?
                            / coin.bonded_power as u128,
                    )
                    .ok_or(DiggoError::MathOverflow)?
            } else {
                previous_bonded
            };
            let next_starter = if coin.starter_power > 0 && split.starter > 0 {
                previous_starter
                    .checked_add(
                        (split.starter as u128)
                            .checked_mul(INDEX_SCALE)
                            .ok_or(DiggoError::MathOverflow)?
                            / coin.starter_power as u128,
                    )
                    .ok_or(DiggoError::MathOverflow)?
            } else {
                previous_starter
            };
            // What each index can actually pay, carry included: the difference between what it owes
            // its tranche's whole power before and after the advance. The two are summed into one
            // debit, so the emission source moves by exactly what the positions can claim and
            // everything the indexes cannot assign stays where it is.
            let owed_bonded = index_owed(next_bonded, coin.bonded_power)?
                .checked_sub(index_owed(previous_bonded, coin.bonded_power)?)
                .ok_or(DiggoError::MathOverflow)?;
            let owed_starter = index_owed(next_starter, coin.starter_power)?
                .checked_sub(index_owed(previous_starter, coin.starter_power)?)
                .ok_or(DiggoError::MathOverflow)?;
            let assigned = owed_bonded
                .checked_add(owed_starter)
                .ok_or(DiggoError::MathOverflow)?;
            require!(
                assigned <= source.room(),
                DiggoError::LedgerInvariantViolated
            );
            coin.bonded_index = next_bonded;
            coin.starter_index = next_starter;
            if assigned > 0 {
                match source {
                    CoinEmissionSource::Curve(_) => apply_coin_curve_debit(coin, assigned)?,
                    CoinEmissionSource::Reserve(_) => {
                        coin.reserve_remaining = coin
                            .reserve_remaining
                            .checked_sub(assigned)
                            .ok_or(DiggoError::InsufficientReserve)?;
                    }
                }
                coin.cumulative_distributed = coin
                    .cumulative_distributed
                    .checked_add(assigned)
                    .ok_or(DiggoError::MathOverflow)?;
                coin.outstanding_claims = coin
                    .outstanding_claims
                    .checked_add(assigned)
                    .ok_or(DiggoError::MathOverflow)?;
            }
        }
        if coin.graduated != 0 && coin.reserve_remaining == 0 && !coin_curve_phase_pending(coin) {
            coin.status = COIN_STATUS_FULLY_MINED;
        }
        coin.next_block_at = coin
            .next_block_at
            .checked_add(
                (coin.block_interval as i64)
                    .checked_mul(blocks as i64)
                    .ok_or(DiggoError::MathOverflow)?,
            )
            .ok_or(DiggoError::MathOverflow)?;
        segments += 1;
    }
    if coin.graduated != 0 && coin.reserve_remaining == 0 && !coin_curve_phase_pending(coin) {
        coin.status = COIN_STATUS_FULLY_MINED;
    }
    coin.curve_mining_open = if coin.graduated == 0 && coin_curve_mining_room(coin) > 0 {
        1
    } else {
        0
    };
    Ok(outcome)
}

/// The production walk: MAX_SYNC_SEGMENTS per call.
pub fn sync_coin(
    coin: &mut Coin,
    protocol: &ProtocolConfig,
    now: i64,
    slot: u64,
) -> Result<CoinSyncOutcome> {
    sync_coin_with_budget(coin, protocol, now, slot, MAX_SYNC_SEGMENTS)
}

/// Walks the ledger to `now`, or refuses with SyncBehind.
///
/// A position may only be settled against a ledger that has accounted for every due block:
/// settling against a half-walked index would credit the epochs the walk got through and then
/// hide the rest behind `last_reward_index`, permanently forfeiting them. The refusal locks
/// nothing, because advance_mine is permissionless.
pub fn sync_coin_to_now(
    coin: &mut Coin,
    protocol: &ProtocolConfig,
    now: i64,
    slot: u64,
) -> Result<CoinSyncOutcome> {
    let outcome = sync_coin(coin, protocol, now, slot)?;
    match outcome.progress {
        SyncProgress::CaughtUp => Ok(outcome),
        SyncProgress::Behind => Err(error!(DiggoError::SyncBehind)),
    }
}

#[cfg(test)]
mod coin_index_tests {
    use super::*;

    fn protocol() -> ProtocolConfig {
        ProtocolConfig {
            starter_efficiency_bps: STARTER_EFFICIENCY_BPS,
            starter_tranche_bps: STARTER_TRANCHE_BPS,
            epoch_seed_delay_slots: EPOCH_SEED_DELAY_SLOTS,
            epoch_seed_max_lateness_slots: EPOCH_SEED_MAX_LATENESS_SLOTS,
            discovery_epoch_budget_bps: DEFAULT_DISCOVERY_EPOCH_BUDGET_BPS,
            ..Default::default()
        }
    }

    /// A graduated coin whose Mining Reserve pays, so the tranche math can be exercised
    /// without the curve ledger in the way.
    fn graduated_coin(bonded: u64, starter: u64, reward: u64) -> Coin {
        Coin {
            total_power: bonded.saturating_add(starter),
            bonded_power: bonded,
            starter_power: starter,
            current_block_reward: reward,
            block_interval: 300,
            epoch_length: 604_800,
            epoch_ends_at: 604_800,
            next_block_at: 300,
            reduction_bps: DEFAULT_REDUCTION_BPS,
            minimum_reward: 1,
            reserve_remaining: 1_000_000_000,
            discovery_reserve_total: 1_000_000_000,
            status: COIN_STATUS_MINING_ACTIVE,
            graduated: 1,
            ..Default::default()
        }
    }

    /// What a whole tranche can still claim from an index.
    fn owed(index: u128, power: u64) -> u64 {
        index_owed(index, power).unwrap()
    }

    #[test]
    fn starter_tranche_cap_holds_for_a_small_starter_tranche() {
        let coin = graduated_coin(1_000, 250, 10_000);
        let split = split_block_reward(10_000, &coin, &protocol()).unwrap();
        // 10% of the block is the ceiling, and the starter's own weight is far below it.
        assert!(split.starter <= 1_000, "starter took {}", split.starter);
        assert!(split.bonded >= 9_000, "bonded kept {}", split.bonded);
    }

    #[test]
    fn split_is_exact_and_rounds_down() {
        let protocol = protocol();
        for (bonded, starter) in [(1_000u64, 0u64), (1_000, 1), (1_000, 250), (7, 3), (1, 1)] {
            let coin = graduated_coin(bonded, starter, 9_999);
            let split = split_block_reward(9_999, &coin, &protocol).unwrap();
            assert_eq!(
                split.assigned(),
                9_999,
                "bonded {bonded} starter {starter} lost a base unit"
            );
        }
    }

    #[test]
    fn bonded_tranche_keeps_at_least_ninety_percent_of_every_assigned_block() {
        let protocol = protocol();
        let mut checked = 0usize;
        for bonded in [1u64, 7, 100, 1_000, 50_000] {
            for starter in [0u64, 1, 25, 100, 1_000, 10_000, 250_000] {
                let coin = graduated_coin(bonded, starter, 100_000);
                let split = split_block_reward(100_000, &coin, &protocol).unwrap();
                if split.assigned() == 0 {
                    continue;
                }
                assert!(
                    split.bonded * BPS as u64 >= split.assigned() * 9_000,
                    "bonded {bonded} starter {starter} gave the starter more than 10%"
                );
                checked += 1;
            }
        }
        assert!(checked > 0);
    }

    #[test]
    fn a_starter_heavy_coin_still_pays_the_starter_its_cap() {
        // The regime the single derived index could not serve at all: 10,000 starter power against
        // 100 bonded. The tranche is held to its cap instead of being paid nothing, and the bonded
        // tranche keeps the rest.
        let coin = graduated_coin(100, 10_000, 10_000);
        let split = split_block_reward(10_000, &coin, &protocol()).unwrap();
        assert_eq!(split.starter, 1_000, "the starter takes exactly its cap");
        assert_eq!(split.bonded, 9_000);
        assert_eq!(split.assigned(), 10_000);
    }

    #[test]
    fn an_empty_starter_tranche_leaves_no_slice_of_the_block_behind() {
        // Every position is armed in the full tranche now that the bond is retired, so a live
        // coin's starter tranche is empty. The split then has to hand the bonded index the whole
        // block: an empty tranche is neither a rounding case nor a place to withhold a fee, and
        // this is the arithmetic behind "the block is not skimmed".
        let protocol = protocol();
        let coin = graduated_coin(1_000, 0, 10_000);
        let split = split_block_reward(10_000, &coin, &protocol).unwrap();
        assert_eq!(split.starter, 0);
        assert_eq!(split.bonded, 10_000, "the whole block goes to the full tranche");
        assert_eq!(split.assigned(), 10_000, "and none of it stays behind");

        // The same for a coin with several full-tranche positions, and for ragged blocks where a
        // rounding rule could hide a slice.
        let coin = graduated_coin(5_000, 0, 10_000);
        for reward in [1u64, 3, 7, 999, 10_000, 1_000_001, u32::MAX as u64] {
            let split = split_block_reward(reward, &coin, &protocol).unwrap();
            assert_eq!(split.starter, 0, "an empty tranche takes nothing of {reward}");
            assert_eq!(
                split.assigned(),
                reward,
                "block {reward} left {} behind",
                reward.saturating_sub(split.assigned())
            );
        }
    }

    #[test]
    #[test]
    fn zero_bonded_power_assigns_only_the_starter_cap_and_leaves_the_rest_in_the_reserve() {
        let protocol = protocol();
        let mut coin = graduated_coin(0, 1_000, 10_000);
        let before = coin.reserve_remaining;
        let outcome = sync_coin(&mut coin, &protocol, 300, 1_000).unwrap();
        assert_eq!(outcome.progress, SyncProgress::CaughtUp);
        // The starter tranche is paid its cap and nothing more. The bonded tranche's 90% has no
        // power to be divided by, so it is never debited from the reserve at all: it is not burned
        // and it is not re-assigned to the starter index.
        assert_eq!(coin.cumulative_distributed, 1_000);
        assert_eq!(coin.outstanding_claims, 1_000);
        assert_eq!(coin.reserve_remaining, before - 1_000);
        assert_eq!(coin.bonded_index, 0, "an index with no power cannot advance");
        assert!(coin.starter_index > 0);
    }

    #[test]
    fn a_bonded_walk_debits_the_reserve_by_exactly_what_the_indexes_credit() {
        let protocol = protocol();
        let mut coin = graduated_coin(1_000, 250, 10_000);
        let reserve_before = coin.reserve_remaining;
        sync_coin(&mut coin, &protocol, 300, 1_000).unwrap();
        assert_eq!(coin.cumulative_distributed, 10_000);
        assert_eq!(coin.outstanding_claims, 10_000);
        assert_eq!(coin.reserve_remaining, reserve_before - 10_000);
        // The vault-side buckets are conserved: nothing was created and nothing was burned.
        assert_eq!(
            coin.reserve_remaining + coin.outstanding_claims + coin.discovery_remaining,
            reserve_before
        );
    }

    #[test]
    fn both_tranches_settle_in_proportion_to_their_indexes() {
        let protocol = protocol();
        let mut coin = graduated_coin(1_000, 250, 10_000);
        sync_coin(&mut coin, &protocol, 300, 1_000).unwrap();
        let mut bonded = MiningPosition {
            assigned_power: 1_000,
            tranche: TRANCHE_BONDED,
            ..Default::default()
        };
        let mut starter = MiningPosition {
            assigned_power: 250,
            tranche: TRANCHE_STARTER,
            ..Default::default()
        };
        settle_position_gated(&mut bonded, &mut coin, true).unwrap();
        settle_position_gated(&mut starter, &mut coin, true).unwrap();
        // The bonded tranche holds the whole index, so it is paid the block minus rounding.
        assert!(bonded.pending_reward >= 9_000);
        // The starter tranche's index is the bonded one scaled by 2500*1000/BPS^2.
        assert!(starter.pending_reward > 0);
        assert!(starter.pending_reward <= 1_000);
        assert_eq!(bonded.pending_reward + starter.pending_reward, 10_000);
    }

    #[test]
    fn settling_twice_at_the_same_index_credits_nothing_the_second_time() {
        let protocol = protocol();
        let mut coin = graduated_coin(1_000, 0, 10_000);
        sync_coin(&mut coin, &protocol, 300, 1_000).unwrap();
        let mut position = MiningPosition {
            assigned_power: 1_000,
            tranche: TRANCHE_BONDED,
            ..Default::default()
        };
        settle_position_gated(&mut position, &mut coin, true).unwrap();
        let first = position.pending_reward;
        settle_position_gated(&mut position, &mut coin, true).unwrap();
        assert_eq!(position.pending_reward, first);
        assert_eq!(position.last_reward_index, coin.bonded_index);
    }

    #[test]
    fn an_unassigned_position_only_re_anchors() {
        let protocol = protocol();
        let mut coin = graduated_coin(1_000, 0, 10_000);
        sync_coin(&mut coin, &protocol, 300, 1_000).unwrap();
        let mut position = MiningPosition {
            assigned_power: 0,
            tranche: TRANCHE_STARTER,
            last_reward_index: 0,
            ..Default::default()
        };
        settle_position_gated(&mut position, &mut coin, true).unwrap();
        assert_eq!(position.pending_reward, 0);
        // An unassigned position only re-anchors, and it anchors on its own tranche's index.
        assert_eq!(position.last_reward_index, coin.starter_index);
    }

    #[test]
    fn the_walk_is_bounded_and_resumes_to_the_same_ledger() {
        let protocol = protocol();
        // One segment covers at most one epoch, so a backlog of several epochs is what makes
        // a four-segment budget bind.
        let mut resumed = graduated_coin(1_000, 250, 10_000);
        let far = resumed.epoch_ends_at + resumed.epoch_length as i64 * 6;
        let mut bounded_calls = 0usize;
        loop {
            let outcome = sync_coin_with_budget(&mut resumed, &protocol, far, 10_000, 4).unwrap();
            bounded_calls += 1;
            if outcome.progress == SyncProgress::CaughtUp {
                break;
            }
            assert!(bounded_calls < 10_000, "the walk did not terminate");
        }
        assert!(bounded_calls > 1, "the budget must actually bind");

        let mut one_pass = graduated_coin(1_000, 250, 10_000);
        sync_coin_with_budget(&mut one_pass, &protocol, far, 10_000, usize::MAX).unwrap();
        assert_eq!(resumed.bonded_index, one_pass.bonded_index);
        assert_eq!(resumed.next_block_at, one_pass.next_block_at);
        assert_eq!(resumed.reserve_remaining, one_pass.reserve_remaining);
        assert_eq!(resumed.outstanding_claims, one_pass.outstanding_claims);
        assert_eq!(resumed.epoch_index, one_pass.epoch_index);
    }

    #[test]
    fn a_curve_phase_walk_pays_from_the_inventory_and_leaves_the_reserve_alone() {
        let protocol = protocol();
        let mut coin = graduated_coin(1_000, 0, 10_000);
        coin.graduated = 0;
        coin.status = COIN_STATUS_MINING_ACTIVE;
        coin.curve_mining_cap = 5_000;
        coin.curve_mining_block_reward = 100;
        coin.token_reserve = 100_000;
        coin.reserve_remaining = 1_000_000;
        let outcome = sync_coin(&mut coin, &protocol, 300, 1_000).unwrap();
        assert_eq!(outcome.progress, SyncProgress::CaughtUp);
        assert_eq!(coin.curve_mining_mined, 100);
        assert_eq!(coin.token_reserve, 99_900);
        assert_eq!(coin.curve_mining_unpaid, 100);
        assert_eq!(
            coin.reserve_remaining, 1_000_000,
            "pre-graduation may never touch the Mining Reserve"
        );
    }

    #[test]
    fn a_spent_curve_cap_idles_and_never_moves_onto_the_reserve() {
        let protocol = protocol();
        let mut coin = graduated_coin(1_000, 0, 10_000);
        coin.graduated = 0;
        coin.curve_mining_cap = 100;
        coin.curve_mining_mined = 100;
        coin.curve_mining_block_reward = 100;
        coin.token_reserve = 100_000;
        coin.reserve_remaining = 1_000_000;
        sync_coin(&mut coin, &protocol, 900, 1_000).unwrap();
        assert_eq!(coin.reserve_remaining, 1_000_000);
        assert_eq!(coin.curve_mining_mined, 100);
        assert_eq!(coin.next_block_at, 1_200, "the idle blocks are consumed");
    }

    #[test]
    fn a_graduated_coin_stops_at_an_empty_reserve() {
        let protocol = protocol();
        let mut coin = graduated_coin(1_000, 0, 10_000);
        coin.reserve_remaining = 5_000;
        sync_coin(&mut coin, &protocol, 300, 1_000).unwrap();
        assert_eq!(coin.reserve_remaining, 0);
        assert_eq!(coin.status, COIN_STATUS_FULLY_MINED);
        assert!(coin_sync_is_complete(&coin, 10_000));
    }

    #[test]
    fn an_epoch_rollover_reduces_the_reward_and_arms_a_future_seed_target() {
        let protocol = protocol();
        let mut coin = graduated_coin(1_000, 0, 10_000);
        coin.epoch_ends_slot = 1_000;
        let now = coin.epoch_ends_at + 1;
        let outcome = sync_coin(&mut coin, &protocol, now, 2_000).unwrap();
        assert_eq!(outcome.epochs_rolled, 1);
        assert_eq!(coin.epoch_index, 1);
        // 2500 bps of the reward is the step down, and the minimum is a floor.
        assert_eq!(coin.current_block_reward, 7_500);
        assert!(
            outcome.target_slot > 2_000,
            "the seed target must be in a slot that has not been produced yet"
        );
        assert!(coin.epoch_ends_slot > 2_000);
        assert_eq!(
            outcome.target_slot,
            coin.epoch_ends_slot + protocol.epoch_seed_delay_slots
        );
        // The measured span is carried forward, not a compiled-in slots-per-second.
        assert_eq!(coin.epoch_ends_slot, 2_000 + (2_000 - 1_000));
    }

    #[test]
    fn a_multi_epoch_catch_up_divides_the_measured_span() {
        let mut coin = graduated_coin(1_000, 0, 10_000);
        coin.epoch_ends_slot = 1_000;
        // 3000 slots observed over 4 epochs is 750 per epoch, so a catch-up cannot inflate
        // the prediction the way an un-divided span would.
        assert_eq!(predict_epoch_span_slots(&coin, 4_000, 4), 750);
        assert_eq!(predict_epoch_span_slots(&coin, 4_000, 1), 3_000);
        // Nothing to measure: the fallback is a whole sysvar window, which is far enough
        // ahead that the armed target is still in the future.
        coin.epoch_ends_slot = 0;
        assert_eq!(predict_epoch_span_slots(&coin, 4_000, 1), SLOT_HASHES_WINDOW);
        coin.epoch_ends_slot = 9_000;
        assert_eq!(predict_epoch_span_slots(&coin, 4_000, 1), SLOT_HASHES_WINDOW);
    }

    #[test]
    fn every_armed_target_is_in_a_slot_that_has_not_been_produced() {
        let protocol = protocol();
        let mut coin = graduated_coin(1_000, 0, 10_000);
        coin.epoch_ends_slot = 1_000;
        let slot = 4_000u64;
        let now = coin.epoch_ends_at + coin.epoch_length as i64 * 6;
        // Walk the whole backlog, checking after every call that the target the walk left
        // behind still names a slot the cluster has not produced.
        loop {
            let outcome = sync_coin(&mut coin, &protocol, now, slot).unwrap();
            assert!(
                coin.epoch_seed_target_slot > slot,
                "an armed target must be in the future"
            );
            assert!(coin.epoch_ends_slot > slot);
            if outcome.progress == SyncProgress::CaughtUp {
                break;
            }
        }
        assert!(coin.epoch_index >= 6);
    }

    #[test]
    fn the_first_rollover_falls_back_to_a_safe_span() {
        let protocol = protocol();
        let mut coin = graduated_coin(1_000, 0, 10_000);
        coin.epoch_ends_slot = 0;
        let now = coin.epoch_ends_at + 1;
        sync_coin(&mut coin, &protocol, now, 50_000).unwrap();
        assert_eq!(coin.epoch_ends_slot, 50_000 + SLOT_HASHES_WINDOW);
    }

    #[test]
    fn the_discovery_epoch_budget_is_recomputed_on_every_rollover() {
        let protocol = protocol();
        let mut coin = graduated_coin(1_000, 0, 10_000);
        coin.discovery_epoch_spent = 7;
        let now = coin.epoch_ends_at + 1;
        sync_coin(&mut coin, &protocol, now, 2_000).unwrap();
        assert_eq!(coin.discovery_epoch_spent, 0);
        assert_eq!(coin.discovery_epoch_index, coin.epoch_index);
        assert_eq!(
            coin.discovery_epoch_budget,
            mul_bps(
                coin.discovery_reserve_total,
                DEFAULT_DISCOVERY_EPOCH_BUDGET_BPS
            )
            .unwrap()
        );
    }

    #[test]
    fn each_tranche_reads_its_own_stored_index() {
        let coin = Coin {
            bonded_index: 11 * INDEX_SCALE,
            starter_index: 3 * INDEX_SCALE,
            ..Coin::default()
        };
        assert_eq!(tranche_index(&coin, TRANCHE_BONDED), 11 * INDEX_SCALE);
        assert_eq!(tranche_index(&coin, TRANCHE_STARTER), 3 * INDEX_SCALE);
        // Any byte that is not the starter tranche reads the bonded index, which is the safe
        // default for a corrupt or legacy account.
        assert_eq!(tranche_index(&coin, 2), 11 * INDEX_SCALE);
    }

    #[test]
    #[test]
    fn a_position_starting_index_matches_the_tranche_it_accrues_in() {
        let coin = graduated_coin(1_000, 250, 10_000);
        let mut coin = Coin {
            bonded_index: 5 * INDEX_SCALE,
            starter_index: 7 * INDEX_SCALE,
            ..coin
        };
        assert_eq!(position_initial_index(&coin, TRANCHE_BONDED), 5 * INDEX_SCALE);
        assert_eq!(position_initial_index(&coin, TRANCHE_STARTER), 7 * INDEX_SCALE);
        // The two indexes are independent: moving one never moves the other, which is the whole
        // reason the starter cap can be exact.
        coin.bonded_index = 9 * INDEX_SCALE;
        assert_eq!(position_initial_index(&coin, TRANCHE_BONDED), 9 * INDEX_SCALE);
        assert_eq!(position_initial_index(&coin, TRANCHE_STARTER), 7 * INDEX_SCALE);
    }

    #[test]
    fn owed_matches_a_hand_computed_share() {
        // index 1e12 over power 1_000 is one base unit per unit of power.
        assert_eq!(owed(INDEX_SCALE, 1_000), 1_000);
        assert_eq!(owed(INDEX_SCALE / 2, 1_000), 500);
        assert_eq!(owed(0, 1_000), 0);
    }

/// Emits shared/parity/mining.json. Run with --nocapture to regenerate it:
///
///     cargo test --lib mining_parity_vectors -- --nocapture
///
/// The chain is authoritative and this is the Rust side of the one-way parity gate: WS-G's
/// shared/parity test asserts the same numbers in TypeScript, so a divergence shows up as a
/// failing vector rather than as a client that quietly disagrees with the program about who
/// is owed what.
#[test]
fn mining_parity_vectors() {
    fn hex(bytes: &[u8]) -> String {
        let mut out = String::new();
        for byte in bytes {
            out.push_str(&format!("{byte:02x}"));
        }
        out
    }

    let protocol = ProtocolConfig {
        starter_efficiency_bps: STARTER_EFFICIENCY_BPS,
        starter_tranche_bps: STARTER_TRANCHE_BPS,
        epoch_seed_delay_slots: EPOCH_SEED_DELAY_SLOTS,
        epoch_seed_max_lateness_slots: EPOCH_SEED_MAX_LATENESS_SLOTS,
        discovery_epoch_budget_bps: DEFAULT_DISCOVERY_EPOCH_BUDGET_BPS,
        ..Default::default()
    };

    let mut out = String::new();
    out.push_str("{\n");
    out.push_str("  \"generatedBy\": \"WS-C Rust unit test mining_parity_vectors; do not edit by hand\",\n");
    out.push_str(&format!(
        "  \"indexScale\": \"{}\",\n",
        INDEX_SCALE
    ));
    out.push_str(&format!(
        "  \"starterEfficiencyBps\": {},\n",
        protocol.starter_efficiency_bps
    ));
    out.push_str(&format!(
        "  \"starterTrancheBps\": {},\n",
        protocol.starter_tranche_bps
    ));

    // sha256(seed || owner || window le), and the roll it reduces to.
    out.push_str("  \"derivation\": [\n");
    let seed = [1u8; 32];
    let owner = Pubkey::new_from_array([2u8; 32]);
    let windows = [0u16, 1, 258, 65_535];
    for (index, window) in windows.iter().enumerate() {
        let digest = discovery_digest(&seed, &owner, *window);
        out.push_str(&format!(
            "    {{\"seedHex\": \"{}\", \"ownerHex\": \"{}\", \"windowIndex\": {}, \"digestHex\": \"{}\", \"rollBps\": {}}}{}\n",
            hex(&seed),
            hex(owner.as_ref()),
            window,
            hex(&digest),
            discovery_roll_bps(&digest),
            if index + 1 == windows.len() { "" } else { "," }
        ));
    }
    out.push_str("  ],\n");

    // The tranche split, and what each tranche can actually claim.
    out.push_str("  \"trancheSplit\": [\n");
    let splits = [
        (1_000u64, 0u64, 10_000u64),
        (1_000, 250, 10_000),
        (1_000, 4_444, 10_000),
        (1_000, 4_445, 10_000),
        (7, 3, 9_999),
        (0, 1_000, 10_000),
    ];
    for (index, (bonded, starter, reward)) in splits.iter().enumerate() {
        let coin = Coin {
            total_power: bonded + starter,
            bonded_power: *bonded,
            starter_power: *starter,
            ..Default::default()
        };
        let split = split_block_reward(*reward, &coin, &protocol).unwrap();
        out.push_str(&format!(
            "    {{\"bondedPower\": \"{}\", \"starterPower\": \"{}\", \"reward\": \"{}\", \"cap\": \"{}\", \"bonded\": \"{}\", \"starter\": \"{}\"}}{}\n",
            bonded,
            starter,
            reward,
            starter_tranche_cap(*reward, &protocol).unwrap(),
            split.bonded,
            split.starter,
            if index + 1 == splits.len() { "" } else { "," }
        ));
    }
    out.push_str("  ],\n");

    // The two stored indexes after one walk, and what each tranche can claim from them. This is
    // the family the TypeScript mirror has to reproduce: the walk credits each tranche's own take
    // over its own power, so a claim is the index times the power, and the cap shows up in the
    // split rather than in an inequality on the two powers.
    out.push_str("  \"trancheIndex\": [\n");
    let index_cases = [
        (1_000u64, 250u64, 10_000u64, 1u64),
        (1_000, 250, 10_000, 4),
        (0, 1_000, 10_000, 2),
        (500, 2_000, 9_999, 1),
    ];
    for (index, (bonded, starter, reward, blocks)) in index_cases.iter().enumerate() {
        let mut coin = Coin {
            total_power: bonded + starter,
            bonded_power: *bonded,
            starter_power: *starter,
            current_block_reward: *reward,
            block_interval: 300,
            epoch_length: 604_800,
            epoch_ends_at: 604_800,
            next_block_at: 300,
            reduction_bps: DEFAULT_REDUCTION_BPS,
            minimum_reward: 1,
            reserve_remaining: 1_000_000_000,
            discovery_reserve_total: 1_000_000_000,
            graduated: 1,
            status: COIN_STATUS_MINING_ACTIVE,
            ..Default::default()
        };
        let now = 300 + 300 * (*blocks as i64 - 1);
        sync_coin_with_budget(&mut coin, &protocol, now, 1_000, usize::MAX).unwrap();
        out.push_str(&format!(
            "    {{\"bondedPower\": \"{}\", \"starterPower\": \"{}\", \"blockReward\": \"{}\", \"blocks\": {}, \"bondedIndex\": \"{}\", \"starterIndex\": \"{}\", \"bondedClaim\": \"{}\", \"starterClaim\": \"{}\", \"reserveRemaining\": \"{}\"}}{}\n",
            bonded,
            starter,
            reward,
            blocks,
            coin.bonded_index,
            coin.starter_index,
            index_owed(coin.bonded_index, *bonded).unwrap(),
            index_owed(coin.starter_index, *starter).unwrap(),
            coin.reserve_remaining,
            if index + 1 == index_cases.len() { "" } else { "," }
        ));
    }
    out.push_str("  ],\n");

    out.push_str("  \"owed\": [\n");
    let owed_cases = [
        (INDEX_SCALE, 1_000u64),
        (INDEX_SCALE / 2, 1_000),
        (0, 1_000),
        (3 * INDEX_SCALE + 7, 333),
    ];
    for (index, (value, power)) in owed_cases.iter().enumerate() {
        out.push_str(&format!(
            "    {{\"index\": \"{}\", \"power\": \"{}\", \"owed\": \"{}\"}}{}\n",
            value,
            power,
            index_owed(*value, *power).unwrap(),
            if index + 1 == owed_cases.len() { "" } else { "," }
        ));
    }
    out.push_str("  ],\n");

    // One full walk of a graduated coin, which is what pins the reserve arithmetic.
    out.push_str("  \"walk\": [\n");
    let walks = [(1_000u64, 250u64, 10_000u64, 1i64), (1_000, 0, 10_000, 4), (500, 2_000, 9_999, 1)];
    for (index, (bonded, starter, reward, blocks)) in walks.iter().enumerate() {
        let mut coin = Coin {
            total_power: bonded + starter,
            bonded_power: *bonded,
            starter_power: *starter,
            current_block_reward: *reward,
            block_interval: 300,
            epoch_length: 604_800,
            epoch_ends_at: 604_800,
            next_block_at: 300,
            reduction_bps: DEFAULT_REDUCTION_BPS,
            minimum_reward: 1,
            reserve_remaining: 1_000_000_000,
            discovery_reserve_total: 1_000_000_000,
            graduated: 1,
            status: COIN_STATUS_MINING_ACTIVE,
            ..Default::default()
        };
        let now = 300 + 300 * (blocks - 1);
        sync_coin_with_budget(&mut coin, &protocol, now, 1_000, usize::MAX).unwrap();
        out.push_str(&format!(
            "    {{\"bondedPower\": \"{}\", \"starterPower\": \"{}\", \"blockReward\": \"{}\", \"blocks\": {}, \"rewardIndex\": \"{}\", \"reserveRemaining\": \"{}\", \"cumulativeDistributed\": \"{}\", \"outstandingClaims\": \"{}\"}}{}\n",
            bonded,
            starter,
            reward,
            blocks,
            coin.bonded_index,
            coin.reserve_remaining,
            coin.cumulative_distributed,
            coin.outstanding_claims,
            if index + 1 == walks.len() { "" } else { "," }
        ));
    }
    out.push_str("  ],\n");

    out.push_str("  \"seedReveal\": [\n");
    let reveal_cases = [
        (1_000u64, 1_000u64, 512u64, 32u64),
        (1_000, 1_511, 512, 32),
        (1_000, 1_512, 512, 32),
        (1_000, 1_513, 512, 32),
        (1_000, 2_000, 2_048, 32),
    ];
    for (index, (target, current, lateness, delay)) in reveal_cases.iter().enumerate() {
        let plan = plan_seed_reveal(*target, *current, *lateness, *delay).unwrap();
        let (name, rearm) = match plan {
            SeedRevealPlan::Target => ("target", 0u64),
            SeedRevealPlan::Oldest => ("oldest", 0),
            SeedRevealPlan::Rearm(slot) => ("rearm", slot),
        };
        out.push_str(&format!(
            "    {{\"targetSlot\": {}, \"currentSlot\": {}, \"maxLatenessSlots\": {}, \"delaySlots\": {}, \"plan\": \"{}\", \"rearmSlot\": {}}}{}\n",
            target,
            current,
            lateness,
            delay,
            name,
            rearm,
            if index + 1 == reveal_cases.len() { "" } else { "," }
        ));
    }
    out.push_str("  ],\n");

    // The launch rarity table's cumulative chances, and which tier a roll lands in.
    out.push_str("  \"rarity\": {\n");
    out.push_str("    \"cumulativeChanceBps\": [7000, 9000, 9700, 9950, 9995, 10000],\n");
    out.push_str("    \"rolls\": [\n");
    let rolls = [0u16, 6_999, 7_000, 8_999, 9_000, 9_999];
    let mut rarity_protocol = protocol;
    rarity_protocol.rarity_tier_count = 6;
    let chances = [7_000u16, 9_000, 9_700, 9_950, 9_995, 10_000];
    for (index, chance) in chances.iter().enumerate() {
        rarity_protocol.rarity_tiers[index].cumulative_chance_bps = *chance;
    }
    for (index, roll) in rolls.iter().enumerate() {
        out.push_str(&format!(
            "      {{\"rollBps\": {}, \"tier\": {}}}{}\n",
            roll,
            rolled_rarity_tier(&rarity_protocol, *roll).unwrap_or(0),
            if index + 1 == rolls.len() { "" } else { "," }
        ));
    }
    out.push_str("    ]\n");
    out.push_str("  }\n");
    out.push_str("}\n");

    // The vector file is the artifact; the assertion below keeps the generator honest.
    assert!(out.contains("\"derivation\""));
    assert_eq!(discovery_roll_bps(&discovery_digest(&seed, &owner, 0)), 2_754);
    println!("{out}");
}

    /// The two-index split is exact for every pair of powers, which is the whole point of the
    /// second index. The single derived index could only hold the cap while
    /// starter_power * E * (BPS - T) <= bonded_power * BPS^2, and outside that regime it had to
    /// assign a starter-heavy block nothing at all; here the tranche takes its capped share and
    /// the bonded tranche keeps the rest.
    #[test]
    fn the_starter_cap_holds_for_every_pair_of_powers() {
        let changed = ProtocolConfig {
            starter_efficiency_bps: 2_500,
            starter_tranche_bps: 1_500,
            ..Default::default()
        };
        let mut checked = 0usize;
        for bonded in [0u64, 1, 7, 100, 1_000, 50_000] {
            for starter in [0u64, 1, 25, 100, 1_000, 10_000, 250_000] {
                let coin = Coin {
                    bonded_power: bonded,
                    starter_power: starter,
                    total_power: bonded + starter,
                    ..Default::default()
                };
                let split = split_block_reward(10_000, &coin, &changed).unwrap();
                let cap = starter_tranche_cap(10_000, &changed).unwrap();
                if bonded == 0 && starter == 0 {
                    // No power at all: nothing is assigned and the whole block stays put.
                    assert_eq!(split, TrancheSplit::default());
                    continue;
                }
                assert!(split.starter <= cap, "bonded {bonded} starter {starter} passed the cap");
                if bonded > 0 {
                    assert_eq!(split.assigned(), 10_000, "an assignable block must add up");
                    assert!(split.bonded >= 10_000 - cap);
                } else {
                    assert_eq!(split.assigned(), cap);
                    assert_eq!(split.bonded, 0);
                }
                checked += 1;
            }
        }
        assert!(checked > 0);
    }
}
