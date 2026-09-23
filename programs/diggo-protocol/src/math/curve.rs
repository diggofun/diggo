//! math::curve.rs (phase 0a mechanical split of lib.rs).

use crate::*;



pub fn mul_bps(amount: u64, bps: u16) -> Result<u64> {
    u64::try_from(
        (amount as u128)
            .checked_mul(bps as u128)
            .ok_or(DiggoError::MathOverflow)?
            / BPS,
    )
    .map_err(|_| error!(DiggoError::MathOverflow))
}


pub fn quote_buy(
    token_reserve: u64,
    sol_reserve: u64,
    virtual_sol_reserve: u64,
    sol_in: u64,
) -> Result<u64> {
    let denominator = (sol_reserve as u128)
        .checked_add(virtual_sol_reserve as u128)
        .and_then(|v| v.checked_add(sol_in as u128))
        .ok_or(DiggoError::MathOverflow)?;
    let out = (token_reserve as u128)
        .checked_mul(sol_in as u128)
        .ok_or(DiggoError::MathOverflow)?
        / denominator;
    u64::try_from(out).map_err(|_| error!(DiggoError::MathOverflow))
}


pub fn quote_sell(
    token_reserve: u64,
    sol_reserve: u64,
    virtual_sol_reserve: u64,
    tokens_in: u64,
) -> Result<u64> {
    let effective_sol = (sol_reserve as u128)
        .checked_add(virtual_sol_reserve as u128)
        .ok_or(DiggoError::MathOverflow)?;
    let denominator = (token_reserve as u128)
        .checked_add(tokens_in as u128)
        .ok_or(DiggoError::MathOverflow)?;
    let raw = effective_sol
        .checked_mul(tokens_in as u128)
        .ok_or(DiggoError::MathOverflow)?
        / denominator;
    u64::try_from(raw.min(sol_reserve as u128)).map_err(|_| error!(DiggoError::MathOverflow))
}


pub fn reduced_reward(current: u64, reduction_bps: u16, minimum: u64) -> Result<u64> {
    let reduction = mul_bps(current, reduction_bps)?;
    Ok(current.saturating_sub(reduction).max(minimum))
}


// --- post-graduation constant-product pool (spec 36) ------------------------------------

/// x*y before a swap, as a u128 so the product of two u64 reserves can never overflow.
pub fn pool_invariant(pool: &LiquidityPool) -> Result<u128> {
    (pool.sol_reserve as u128)
        .checked_mul(pool.token_reserve as u128)
        .ok_or_else(|| error!(DiggoError::MathOverflow))
}


/// Tokens out of the pool for a net SOL input: k = x*y with the input added to the SOL
/// side. Integer division rounds in the pool's favour, so k can only grow.
pub fn pool_quote_buy(token_reserve: u64, sol_reserve: u64, net_sol: u64) -> Result<u64> {
    require!(net_sol > 0, DiggoError::InvalidAmount);
    require!(
        token_reserve > 0 && sol_reserve > 0,
        DiggoError::InsufficientLiquidity
    );
    let denominator = (sol_reserve as u128)
        .checked_add(net_sol as u128)
        .ok_or(DiggoError::MathOverflow)?;
    let out = (token_reserve as u128)
        .checked_mul(net_sol as u128)
        .ok_or(DiggoError::MathOverflow)?
        / denominator;
    let out = u64::try_from(out).map_err(|_| error!(DiggoError::MathOverflow))?;
    // A single buy can never take the whole token side: the pool must stay a pool.
    require!(out < token_reserve, DiggoError::InsufficientLiquidity);
    Ok(out)
}


/// SOL out of the pool for a token input, before the explicit fees. Capped at the pool's
/// tracked SOL reserve, so the payout can never exceed what the pool actually holds.
pub fn pool_quote_sell(token_reserve: u64, sol_reserve: u64, tokens_in: u64) -> Result<u64> {
    require!(tokens_in > 0, DiggoError::InvalidAmount);
    require!(
        token_reserve > 0 && sol_reserve > 0,
        DiggoError::InsufficientLiquidity
    );
    let denominator = (token_reserve as u128)
        .checked_add(tokens_in as u128)
        .ok_or(DiggoError::MathOverflow)?;
    let raw = (sol_reserve as u128)
        .checked_mul(tokens_in as u128)
        .ok_or(DiggoError::MathOverflow)?
        / denominator;
    u64::try_from(raw.min(sol_reserve as u128)).map_err(|_| error!(DiggoError::MathOverflow))
}


/// Why the pool's liquidity is being debited.
///
/// A swap is the only legitimate reason, ever. PoolWithdraw exists so the ledger rejects
/// the idea of an LP withdrawal explicitly instead of merely happening to have no
/// instruction that reaches it: the LP is permanently program-controlled, no LP token is
/// minted to anyone, and creator, admin and guardian all have no path to it (spec 35, 36).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum PoolDebit {
    /// A constant-product swap through pool_buy or pool_sell.
    Swap,
    /// Any admin, guardian, creator or keeper withdrawal. Always rejected.
    AdminWithdraw,
}


/// The single place where pool liquidity changes, and the only place it may ever shrink.
///
/// A whole swap is applied at once so the invariant is checked across the trade rather
/// than between its two halves: k after the swap may only be >= k before it. There is no
/// other caller and no other arm that permits a debit — AdminWithdraw exists so an LP
/// withdrawal is rejected explicitly rather than merely unreachable (spec 35, 36).
pub fn apply_pool_swap(
    pool: &mut LiquidityPool,
    debit: PoolDebit,
    sol_in: u64,
    tokens_in: u64,
    sol_out: u64,
    tokens_out: u64,
) -> Result<()> {
    if debit == PoolDebit::AdminWithdraw {
        return Err(error!(DiggoError::PoolWithdrawForbidden));
    }
    let before = pool_invariant(pool)?;
    pool.sol_reserve = pool
        .sol_reserve
        .checked_add(sol_in)
        .and_then(|value| value.checked_sub(sol_out))
        .ok_or(DiggoError::InsufficientLiquidity)?;
    pool.token_reserve = pool
        .token_reserve
        .checked_add(tokens_in)
        .and_then(|value| value.checked_sub(tokens_out))
        .ok_or(DiggoError::InsufficientLiquidity)?;
    require!(
        pool_invariant(pool)? >= before,
        DiggoError::PoolInvariantViolated
    );
    Ok(())
}


/// What one graduation moves.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GraduationPlan {
    pub sol: u64,
    pub tokens: u64,
}


/// The complete pre-flight rule set for graduation: the market must not be graduated
/// already, must genuinely have reached its target, and must have something to move.
/// The plan is exactly the market's curve reserves — never a fee bucket, never rent.
pub fn plan_graduation(market: &LaunchMarket) -> Result<GraduationPlan> {
    require!(!market.graduated, DiggoError::MarketAlreadyGraduated);
    require!(
        market.sol_reserve >= market.graduation_target,
        DiggoError::GraduationTargetNotMet
    );
    require!(
        market.sol_reserve > 0 && market.token_reserve > 0,
        DiggoError::InvalidMarket
    );
    Ok(GraduationPlan {
        sol: market.sol_reserve,
        tokens: market.token_reserve,
    })
}


/// Applies a plan to the market and to the freshly created pool.
///
/// The pool must still be empty, which is what makes graduation single-shot, and the
/// market's curve reserves end at exactly zero: both assets are conserved, so the SOL and
/// the tokens the pool holds are provably the ones the curve held a moment earlier.
pub fn apply_graduation(
    market: &mut LaunchMarket,
    pool: &mut LiquidityPool,
    plan: GraduationPlan,
) -> Result<()> {
    require!(
        pool.sol_reserve == 0 && pool.token_reserve == 0,
        DiggoError::InvalidPool
    );
    pool.sol_reserve = plan.sol;
    pool.token_reserve = plan.tokens;
    market.sol_reserve = 0;
    market.token_reserve = 0;
    market.graduated = true;
    Ok(())
}


/// Why a market's curve token inventory is being debited.
///
/// A mining emission is the only legitimate reason this ledger ever has, and it is the
/// reason the product decision needs: pre-graduation mining is paid out of the curve's own
/// token inventory instead of the Mining Reserve, so a mined token moves the curve exactly
/// where a bought one would. CurveWithdraw exists so the ledger rejects the idea of a
/// creator, admin, guardian or keeper withdrawal explicitly, the same way ReserveDebit and
/// PoolDebit do, rather than merely happening to have no instruction that reaches it.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum CurveDebit {
    /// A block reward the mining ledger emitted before graduation, drawn from the market's
    /// curve token inventory. The SOL side is untouched: mined tokens bring no SOL with
    /// them, which is why pre-graduation sell capacity does not grow as a mine emits.
    MiningEmission,
    /// Any admin, guardian, creator or keeper withdrawal. Always rejected.
    AdminWithdraw,
}


/// True while this market may still emit mined tokens out of its curve inventory: it has
/// not graduated, its launch-time cap is non-zero, the cap has room left, and the curve
/// still holds inventory to pay it with.
///
/// The room term is the one that can close the phase without the cap being spent. A buy takes
/// tokens out of the curve's token reserve, so a market can be left holding less than the
/// emission it still owes; it may never debit more than it holds, and once the room is gone the
/// phase is over for the same practical reason a spent cap is. Such a market is idle, not
/// finished: it pays nothing until graduation turns the Mining Reserve back on, and a sell that
/// puts tokens back into the curve reopens it.
///
/// Derived from curve_mining_room rather than restating its terms, so the flag can never claim
/// there is emission to make where the walk would clamp it to nothing.
pub fn curve_mining_is_open(market: &LaunchMarket) -> bool {
    !market.graduated && market.curve_mining_cap > 0 && curve_mining_room(market) > 0
}


/// The room left under a market's immutable curve-mining cap, bounded by the inventory that
/// can actually pay it.
///
/// The cap is a promise about a launch's own token inventory, and a buy takes inventory out
/// of the curve: the market can be left holding less than the cap still allows. Every debit
/// is clamped to this room, which is what keeps the ledger from ever being asked for more
/// tokens than the curve holds. That used to be a revert - InsufficientLiquidity from
/// apply_curve_mining_debit - and a revert here bricks the market: the walk can never get
/// past the segment it cannot pay, so advance_mine, every claim, every assignment and
/// graduation itself fail forever.
///
/// What the inventory cannot cover is never emitted and never booked. It is not part of
/// curve_mining_mined, because nothing left the curve, and deliberately not part of
/// curve_mining_unpaid either: a position can claim that total, and there would be nothing
/// behind it. The cursor still consumes those blocks and pays nothing for them, exactly as
/// it does for a spent cap.
///
/// The last base unit of the curve's inventory is reserved, never emitted. Graduation is what
/// gives a mine its Mining Reserve back, and it requires the market to have something to move
/// (plan_graduation): a walk that drained the curve to zero would leave a market that can never
/// graduate, which is the same deadlock this clamp exists to remove, one step later. A buy
/// already holds that invariant - it may never take the last base unit - and so does this debit.
/// The reserved unit stays curve inventory, so it seeds the pool with the rest of what was never
/// sold.
pub fn curve_mining_room(market: &LaunchMarket) -> u64 {
    if market.graduated {
        return 0;
    }
    market
        .curve_mining_cap
        .saturating_sub(market.curve_mining_mined)
        .min(market.token_reserve.saturating_sub(1))
}


/// True while this mine still owes blocks that landed before its graduation cursor: it has
/// graduated, a cursor was recorded, and the walk has not yet consumed the stretch that ends
/// there.
///
/// Those blocks are curve-phase for good, so they may never be paid out of the Mining Reserve,
/// and a mine that still owes one is not settled however empty its reserve looks. A cursor of
/// zero means there is none to read - a mine that has not graduated, or an account written
/// before the cursor existed - and then `graduated` alone decides, exactly as it did before.
pub fn curve_phase_pending(mine: &Mine) -> bool {
    mine.graduated && mine.curve_phase_ends_at > 0 && mine.next_block_at < mine.curve_phase_ends_at
}


/// The single place where a market's curve token inventory may shrink for a reason other
/// than a buy.
///
/// Every guard the product decision names is here and nowhere else: the market must not
/// have graduated, the cumulative emission may never pass the launch-time cap, and the
/// debit may never take more than the curve actually holds. The tokens stay in the market
/// vault — this is inventory accounting, not a transfer — and are counted as unpaid until
/// a claimer takes them, which is what keeps graduation from moving tokens the reward
/// index has already credited to a position. There is no arm that permits an admin,
/// guardian, creator or keeper debit; AdminWithdraw exists so that attempt fails loudly.
pub fn apply_curve_mining_debit(
    market: &mut LaunchMarket,
    debit: CurveDebit,
    amount: u64,
) -> Result<()> {
    if debit == CurveDebit::AdminWithdraw {
        return Err(error!(DiggoError::CurveWithdrawForbidden));
    }
    require!(!market.graduated, DiggoError::MarketGraduated);
    require!(amount > 0, DiggoError::InvalidAmount);
    let mined = market
        .curve_mining_mined
        .checked_add(amount)
        .ok_or(DiggoError::MathOverflow)?;
    require!(
        mined <= market.curve_mining_cap,
        DiggoError::CurveMiningCapExceeded
    );
    market.token_reserve = market
        .token_reserve
        .checked_sub(amount)
        .ok_or(DiggoError::InsufficientLiquidity)?;
    market.curve_mining_mined = mined;
    market.curve_mining_unpaid = market
        .curve_mining_unpaid
        .checked_add(amount)
        .ok_or(DiggoError::MathOverflow)?;
    Ok(())
}


/// How many blocks a launch's curve-mining runway spans, at that launch's block interval.
pub fn curve_mining_runway_blocks(block_interval: i64, runway_days: u16) -> Result<u64> {
    require!(block_interval > 0, DiggoError::InvalidSchedule);
    let seconds = (runway_days as i64)
        .checked_mul(86_400)
        .ok_or(DiggoError::MathOverflow)?;
    Ok(((seconds / block_interval).max(1)) as u64)
}


/// The curve phase's flat per-block output: the cap spread over the launch runway, rounded
/// up so the budget is always finishable, and never below one base unit while the cap is
/// non-zero. Rounding up can only make the last block smaller, because the walk clamps
/// every block to the room left under the cap.
pub fn curve_mining_rate(cap: u64, block_interval: i64, runway_days: u16) -> Result<u64> {
    if cap == 0 {
        return Ok(0);
    }
    let blocks = curve_mining_runway_blocks(block_interval, runway_days)?;
    let rate = ((cap as u128) + (blocks as u128) - 1) / (blocks as u128);
    Ok(u64::try_from(rate).map_err(|_| error!(DiggoError::MathOverflow))?.max(1))
}


/// Mirrors a market's phase onto the mine's own two flags: `curve_mining_open` and
/// `graduated`.
///
/// These flags are how the walk reads the phase when it is handed the market: `graduated` is
/// what picks the side that pays - the curve before graduation, the Mining Reserve after it -
/// and `curve_mining_open` is what tells a pre-graduation walk whether there is anything left
/// to pay at all. Both are written together from one market read, so they can never describe
/// two different phases, and every instruction that holds both accounts keeps them current.
///
/// They are also the mine's own record of a phase fact the market alone can change under it:
/// a buy can take the curve's inventory below the emission it still owes, which closes the
/// phase without the cap being spent, and curve_mining_open follows that.
pub fn sync_mine_phase(mine: &mut Mine, market: &LaunchMarket) {
    mine.graduated = market.graduated;
    mine.curve_mining_open = curve_mining_is_open(market);
}
