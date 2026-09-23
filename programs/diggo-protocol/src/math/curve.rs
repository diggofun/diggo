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
pub fn pool_invariant(pool: &LiquidityPoolV4) -> Result<u128> {
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
    pool: &mut LiquidityPoolV4,
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
    pool: &mut LiquidityPoolV4,
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

// ---- v2: the bonding curve, the locked pool and the on-chain TWAP (design 1.3, 4.3) -------
//
// The v4 curve and pool math above is the v2 math: the bonding curve keeps the same virtual
// SOL reserve and the same integer rounding, and the locked pool keeps the same constant
// product. What v2 adds is the layer around it - the fee split, the guards that stop a trade
// from draining a side, and the accumulator the program prices its own discovery caps with.

/// Scale of every price the program derives from its own pool, in lamports per base unit.
///
/// 1e12 keeps a lamport-per-unit price exact for supplies up to a million whole tokens and
/// SOL reserves in the thousands, which is the whole range a launched coin occupies.
pub const PRICE_SCALE: u128 = 1_000_000_000_000;

/// Slots per second, used to turn an epoch's length in seconds into the slot the epoch ends
/// at, and therefore into the slot its seed target is armed from (design 4.1).
///
/// The cluster produces about two and a half slots a second, so two is a conservative floor:
/// the number only decides that a target slot is comfortably in the future, which is the whole
/// point of the commit, and a target that lands late is handled by the re-arm path rather than
/// by a better estimate here.
pub const SLOTS_PER_SECOND: u64 = 2;

/// The tokens a curve buy returns for a net SOL input, with the fees already taken.
///
/// The guard the v4 quote leaves to its caller is here: the curve's token inventory may never
/// be emptied, because graduation needs both sides non-zero (plan_graduation), so a buy that
/// would take the last base unit is refused instead of leaving a coin that can never graduate.
pub fn curve_buy_out(
    token_reserve: u64,
    sol_reserve: u64,
    virtual_sol_reserve: u64,
    net_sol: u64,
) -> Result<u64> {
    require!(net_sol > 0, DiggoError::InvalidAmount);
    require!(token_reserve > 0, DiggoError::CurveExhausted);
    let out = quote_buy(token_reserve, sol_reserve, virtual_sol_reserve, net_sol)?;
    require!(out > 0, DiggoError::InvalidAmount);
    require!(out < token_reserve, DiggoError::CurveExhausted);
    Ok(out)
}

/// The gross SOL a curve sell returns for a token input, capped at the curve's real SOL.
///
/// The virtual reserve only ever inflates the price, never the payout: quote_sell caps at the
/// real sol_reserve, so a sell can never be paid out of lamports the curve does not hold. That
/// cap is why the fee on a sell is taken out of the capped gross rather than added on top, and
/// it is the reason apply_curve_sell takes the gross amount.
pub fn curve_sell_out(
    token_reserve: u64,
    sol_reserve: u64,
    virtual_sol_reserve: u64,
    tokens_in: u64,
) -> Result<u64> {
    require!(tokens_in > 0, DiggoError::InvalidAmount);
    require!(token_reserve > 0, DiggoError::CurveExhausted);
    require!(sol_reserve > 0, DiggoError::InsufficientLiquidity);
    let gross = quote_sell(token_reserve, sol_reserve, virtual_sol_reserve, tokens_in)?;
    require!(gross > 0, DiggoError::InsufficientLiquidity);
    Ok(gross)
}

/// Applies a settled curve buy: the buyer's net SOL joins the curve's real SOL reserve and the
/// tokens leave its inventory. The virtual reserve is a launch parameter and never moves.
pub fn apply_curve_buy(coin: &mut Coin, net_sol: u64, tokens_out: u64) -> Result<()> {
    coin.sol_reserve = coin
        .sol_reserve
        .checked_add(net_sol)
        .ok_or(DiggoError::MathOverflow)?;
    coin.token_reserve = coin
        .token_reserve
        .checked_sub(tokens_out)
        .ok_or(DiggoError::CurveExhausted)?;
    Ok(())
}

/// Applies a settled curve sell: the gross SOL leaves the curve's real reserve and the tokens
/// rejoin its inventory. The gross amount is what leaves the reserve, so the fee buckets are
/// funded out of the curve's own SOL rather than out of a reserve or the pool.
pub fn apply_curve_sell(coin: &mut Coin, gross_sol: u64, tokens_in: u64) -> Result<()> {
    coin.sol_reserve = coin
        .sol_reserve
        .checked_sub(gross_sol)
        .ok_or(DiggoError::InsufficientLiquidity)?;
    coin.token_reserve = coin
        .token_reserve
        .checked_add(tokens_in)
        .ok_or(DiggoError::MathOverflow)?;
    Ok(())
}

/// True once the curve has reached its graduation target. The condition is on-chain and anyone
/// may act on it: graduate_market is permissionless and needs no privileged trigger.
pub fn curve_is_graduable(coin: &Coin) -> bool {
    coin.graduated == 0
        && coin.graduation_target > 0
        && coin.sol_reserve >= coin.graduation_target
        && coin.sol_reserve > 0
        && coin.token_reserve > 0
}

// --- the locked pool ----------------------------------------------------------------------

/// x*y before a swap, as a u128 so the product of two u64 reserves can never overflow.
pub fn pool_invariant_v2(pool: &LiquidityPool) -> Result<u128> {
    (pool.sol_reserve as u128)
        .checked_mul(pool.token_reserve as u128)
        .ok_or_else(|| error!(DiggoError::MathOverflow))
}

/// Tokens out of the locked pool for a net SOL input. Integer division rounds in the pool's
/// favour, so k can only grow, and a single buy can never take the whole token side.
pub fn pool_buy_out(token_reserve: u64, sol_reserve: u64, net_sol: u64) -> Result<u64> {
    require!(net_sol > 0, DiggoError::InvalidAmount);
    require!(
        token_reserve > 0 && sol_reserve > 0,
        DiggoError::PoolNotInitialised
    );
    let out = pool_quote_buy(token_reserve, sol_reserve, net_sol)?;
    require!(out > 0, DiggoError::InvalidAmount);
    Ok(out)
}

/// SOL out of the locked pool for a token input, before the explicit fees, capped at the pool's
/// tracked SOL reserve so the payout can never exceed what the pool actually holds.
pub fn pool_sell_out(token_reserve: u64, sol_reserve: u64, tokens_in: u64) -> Result<u64> {
    require!(tokens_in > 0, DiggoError::InvalidAmount);
    require!(
        token_reserve > 0 && sol_reserve > 0,
        DiggoError::PoolNotInitialised
    );
    let out = pool_quote_sell(token_reserve, sol_reserve, tokens_in)?;
    require!(out > 0, DiggoError::InsufficientLiquidity);
    Ok(out)
}

/// The single place where the locked pool's liquidity changes, and the only place it may ever
/// shrink. A whole swap is applied at once so the invariant is checked across the trade rather
/// than between its two halves: k after the swap may only be >= k before it.
///
/// AdminWithdraw exists so an LP withdrawal is rejected explicitly rather than merely being
/// unreachable: there is no LP mint, no LP token and no instruction that takes a destination.
pub fn apply_pool_swap_v2(
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
    let before = pool_invariant_v2(pool)?;
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
        pool_invariant_v2(pool)? >= before,
        DiggoError::PoolInvariantViolated
    );
    Ok(())
}

/// Graduation moves exactly the coin's curve reserves into the pool and nothing else: not a fee
/// bucket, not a reserve, not rent. Both assets are conserved, so the SOL and the tokens the
/// pool holds are provably the ones the curve held a moment earlier.
///
/// The curve-phase tokens a position has already been credited with are not part of
/// token_reserve any more: a curve-phase emission debits token_reserve as it credits
/// outstanding_claims, so what graduation moves is exactly what no position is owed.
pub fn apply_graduation_v2(
    coin: &mut Coin,
    pool: &mut LiquidityPool,
    now: i64,
    slot: u64,
) -> Result<()> {
    require!(coin.graduated == 0, DiggoError::MarketAlreadyGraduated);
    require!(curve_is_graduable(coin), DiggoError::GraduationTargetNotMet);
    require!(
        pool.sol_reserve == 0 && pool.token_reserve == 0,
        DiggoError::PoolNotInitialised
    );
    pool.sol_reserve = coin.sol_reserve;
    pool.token_reserve = coin.token_reserve;
    pool.graduated_at = now;
    // The TWAP's denominator base is the slot the pool started at and the accumulator itself
    // starts empty: the program prices discovery off the pool's own life, never off a number
    // the pool was launched with.
    pool.last_update_slot = slot;
    pool.cum_price_lamports_per_unit = 0;
    coin.twap_cum_price_lamports_per_unit = 0;
    coin.twap_last_update_slot = slot;
    coin.twap_last_price = price_lamports_per_unit(pool.sol_reserve, pool.token_reserve)?;
    coin.twap_window_slot = slot;
    coin.twap_window_cum = 0;
    coin.sol_reserve = 0;
    coin.token_reserve = 0;
    coin.graduated = 1;
    coin.curve_mining_open = 0;
    coin.curve_phase_ends_at = now;
    coin.status = COIN_STATUS_MINING_ACTIVE;
    Ok(())
}

// --- the TWAP the program prices its own discovery caps with (design 4.3) -------------------

/// The lamports-per-base-unit price of one reserve pair, scaled by PRICE_SCALE.
pub fn price_lamports_per_unit(sol_reserve: u64, token_reserve: u64) -> Result<u128> {
    require!(
        token_reserve > 0 && sol_reserve > 0,
        DiggoError::PoolNotInitialised
    );
    (sol_reserve as u128)
        .checked_mul(PRICE_SCALE)
        .ok_or(DiggoError::MathOverflow)?
        .checked_div(token_reserve as u128)
        .ok_or_else(|| error!(DiggoError::MathOverflow))
}

/// One observation into a cumulative price-slot accumulator: the price that held for some
/// slots, added as a product so the average is a single division at the end.
///
/// The price is read before the swap that triggers the accumulation, because it is the price
/// that held during those slots. A swap is the only thing that moves the price, so an
/// accumulator that is only written on a swap is exact.
pub fn accumulate_price(cum: u128, price: u128, slots: u64) -> Result<u128> {
    if slots == 0 {
        return Ok(cum);
    }
    let delta = price
        .checked_mul(slots as u128)
        .ok_or(DiggoError::MathOverflow)?;
    cum.checked_add(delta)
        .ok_or_else(|| error!(DiggoError::MathOverflow))
}

/// The time-weighted average of an accumulator's increment over the slots it covered.
///
/// No external oracle is consulted anywhere on this path: the only price the program trusts is
/// one it observed itself, and the rounding is downwards, so a manipulated spot price can only
/// ever be diluted by the slots it has to survive.
pub fn twap_average(cum_delta: u128, slots: u64) -> Result<u128> {
    require!(slots > 0, DiggoError::TwapUnavailable);
    Ok(cum_delta / slots as u128)
}

/// The value in lamports of some base units at a scaled price, rounded down so a payout can
/// never exceed the value the program meant to hand out.
pub fn lamports_for_units(units: u64, price_lamports_per_unit: u128) -> Result<u64> {
    require!(price_lamports_per_unit > 0, DiggoError::TwapUnavailable);
    let lamports = (units as u128)
        .checked_mul(price_lamports_per_unit)
        .ok_or(DiggoError::MathOverflow)?
        .checked_div(PRICE_SCALE)
        .ok_or(DiggoError::MathOverflow)?;
    u64::try_from(lamports).map_err(|_| error!(DiggoError::MathOverflow))
}

/// The base units a lamport amount buys at a scaled price, rounded down: the divisor in every
/// discovery payout, and the reason a discovery can never be worth more than the value the
/// rarity table names.
pub fn units_for_lamports(lamports: u64, price_lamports_per_unit: u128) -> Result<u64> {
    require!(price_lamports_per_unit > 0, DiggoError::TwapUnavailable);
    let units = (lamports as u128)
        .checked_mul(PRICE_SCALE)
        .ok_or(DiggoError::MathOverflow)?
        .checked_div(price_lamports_per_unit)
        .ok_or(DiggoError::MathOverflow)?;
    u64::try_from(units).map_err(|_| error!(DiggoError::MathOverflow))
}

#[cfg(test)]
mod v2_tests {
    use super::*;

    fn launched_coin() -> Coin {
        Coin {
            total_supply: 1_000_000_000,
            token_reserve: 700_000_000,
            reserve_remaining: 250_000_000,
            discovery_remaining: 50_000_000,
            virtual_sol_reserve: 30_000_000_000,
            graduation_target: 85_000_000_000,
            curve_mining_cap: 35_000_000,
            ..Coin::default()
        }
    }

    #[test]
    fn a_curve_buy_can_never_empty_the_curve() {
        let coin = launched_coin();
        let out = curve_buy_out(
            coin.token_reserve,
            coin.sol_reserve,
            coin.virtual_sol_reserve,
            1_000_000_000,
        )
        .unwrap();
        assert!(out > 0 && out < coin.token_reserve);

        // A trade the size of half the u64 range still leaves inventory behind.
        let huge = curve_buy_out(
            coin.token_reserve,
            coin.sol_reserve,
            coin.virtual_sol_reserve,
            u64::MAX / 2,
        )
        .unwrap();
        assert!(huge < coin.token_reserve, "the curve is never emptied");

        assert!(curve_buy_out(coin.token_reserve, 0, coin.virtual_sol_reserve, 0).is_err());
        assert!(curve_buy_out(0, 0, 0, 1_000).is_err());
    }

    #[test]
    fn a_curve_sell_is_capped_by_the_real_sol_reserve() {
        // The virtual reserve inflates the price but can never be paid out: the cap is the real
        // reserve, whatever the token input is.
        let gross = curve_sell_out(700_000_000, 1_000_000, 30_000_000_000, u64::MAX).unwrap();
        assert_eq!(gross, 1_000_000);

        assert!(curve_sell_out(700_000_000, 0, 30_000_000_000, 1_000).is_err());
        assert!(curve_sell_out(700_000_000, 1_000, 30_000_000_000, 0).is_err());
    }

    #[test]
    fn a_curve_round_trip_never_pays_out_more_than_it_took_in() {
        let mut coin = launched_coin();
        let net_in = 5_000_000_000u64;
        let tokens = curve_buy_out(
            coin.token_reserve,
            coin.sol_reserve,
            coin.virtual_sol_reserve,
            net_in,
        )
        .unwrap();
        apply_curve_buy(&mut coin, net_in, tokens).unwrap();
        assert_eq!(coin.sol_reserve, net_in);

        let gross = curve_sell_out(
            coin.token_reserve,
            coin.sol_reserve,
            coin.virtual_sol_reserve,
            tokens,
        )
        .unwrap();
        assert!(
            gross <= net_in,
            "a round trip through the curve can never be profitable"
        );
        apply_curve_sell(&mut coin, gross, tokens).unwrap();
        assert!(coin.sol_reserve <= net_in);
    }

    #[test]
    fn the_pool_invariant_never_shrinks_and_a_withdrawal_is_refused() {
        let mut pool = LiquidityPool {
            sol_reserve: 85_000_000_000,
            token_reserve: 700_000_000,
            ..LiquidityPool::default()
        };
        let k = pool_invariant_v2(&pool).unwrap();

        let net = 1_000_000_000u64;
        let tokens_out = pool_buy_out(pool.token_reserve, pool.sol_reserve, net).unwrap();
        apply_pool_swap_v2(&mut pool, PoolDebit::Swap, net, 0, 0, tokens_out).unwrap();
        let after = pool_invariant_v2(&pool).unwrap();
        assert!(after >= k);

        let gross = pool_sell_out(pool.token_reserve, pool.sol_reserve, tokens_out).unwrap();
        apply_pool_swap_v2(&mut pool, PoolDebit::Swap, 0, tokens_out, gross, 0).unwrap();
        assert!(pool_invariant_v2(&pool).unwrap() >= after);

        let sol_before = pool.sol_reserve;
        let tokens_before = pool.token_reserve;
        assert!(apply_pool_swap_v2(&mut pool, PoolDebit::AdminWithdraw, 0, 0, 1_000, 0).is_err());
        assert_eq!(pool.sol_reserve, sol_before);
        assert_eq!(pool.token_reserve, tokens_before);
    }

    #[test]
    fn the_twap_is_the_price_the_pool_held_across_its_slots() {
        let price = price_lamports_per_unit(85_000_000_000, 700_000_000).unwrap();
        assert_eq!(price, 85_000_000_000 * PRICE_SCALE / 700_000_000);

        // Ten slots at 100 and ten at 200 average to 150, whatever the ordering.
        let cum = accumulate_price(0, 100, 10).unwrap();
        let cum = accumulate_price(cum, 200, 10).unwrap();
        assert_eq!(twap_average(cum, 20).unwrap(), 150);
        assert_eq!(accumulate_price(cum, 7, 0).unwrap(), cum);

        // No slots covered is no price at all rather than a division by zero.
        assert!(twap_average(0, 0).is_err());
        assert!(price_lamports_per_unit(0, 1).is_err());
        assert!(price_lamports_per_unit(1, 0).is_err());
    }

    #[test]
    fn value_and_units_round_down_and_are_inverses_at_the_boundary() {
        let price = 1_500_000_000_000u128; // one and a half lamports per base unit
        assert_eq!(lamports_for_units(10, price).unwrap(), 15);
        assert_eq!(units_for_lamports(15, price).unwrap(), 10);

        // Rounding down on both sides means a round trip can never hand out more than it took.
        let units = units_for_lamports(14, price).unwrap();
        assert_eq!(units, 9);
        assert!(lamports_for_units(units, price).unwrap() <= 14);

        assert!(lamports_for_units(1, 0).is_err());
        assert!(units_for_lamports(1, 0).is_err());
    }

    #[test]
    fn graduation_moves_exactly_the_curve_reserves_and_starts_the_twap() {
        let mut coin = launched_coin();
        coin.sol_reserve = 90_000_000_000;
        let curve_tokens = coin.token_reserve;
        let curve_sol = coin.sol_reserve;
        let mut pool = LiquidityPool::default();

        apply_graduation_v2(&mut coin, &mut pool, 1_700_000_000, 123_456).unwrap();
        assert_eq!(pool.sol_reserve, curve_sol);
        assert_eq!(pool.token_reserve, curve_tokens);
        assert_eq!(pool.last_update_slot, 123_456);
        assert_eq!(coin.twap_last_update_slot, 123_456);
        assert_eq!(coin.sol_reserve, 0);
        assert_eq!(coin.token_reserve, 0);
        assert_eq!(coin.graduated, 1);
        assert_eq!(coin.curve_mining_open, 0);
        assert_eq!(coin.curve_phase_ends_at, 1_700_000_000);
        // The reserves graduation does not touch are untouched.
        assert_eq!(coin.reserve_remaining, 250_000_000);
        assert_eq!(coin.discovery_remaining, 50_000_000);

        // Single shot, and only past the target.
        let mut again = LiquidityPool::default();
        assert!(apply_graduation_v2(&mut coin, &mut again, 1, 1).is_err());

        let mut below = launched_coin();
        below.sol_reserve = below.graduation_target - 1;
        let mut pool2 = LiquidityPool::default();
        assert!(apply_graduation_v2(&mut below, &mut pool2, 1, 1).is_err());
        assert!(!curve_is_graduable(&below));
    }

    #[test]
    fn the_slot_estimate_is_conservative() {
        assert_eq!(SLOTS_PER_SECOND, 2);
        assert_eq!(PRICE_SCALE, 1_000_000_000_000);
        // An epoch's worth of slots at two a second is comfortably inside a week.
        assert_eq!(604_800u64 * SLOTS_PER_SECOND, 1_209_600);
    }

    /// The golden vectors shared/parity/coin.json carries, asserted against the code that pays
    /// them out. shared/curve.test.ts asserts the same file from the TypeScript side, so a change
    /// on either side fails a test rather than silently diverging from the chain.
    #[test]
    fn coin_parity_vectors_match_the_program() {
        use crate::instructions::launch::{initial_block_reward, DEFAULT_VIRTUAL_SOL_BPS};

        // --- the launch split ---
        assert_eq!(
            Coin::split_supply(1_000_000_000, 2_500, 500).unwrap(),
            (250_000_000, 50_000_000, 700_000_000)
        );
        assert_eq!(Coin::split_supply(1_001, 333, 333).unwrap(), (33, 33, 935));

        // --- the bonding curve ---
        let out = curve_buy_out(700_000_000, 0, 29_750_000_000, 1_000_000_000).unwrap();
        assert_eq!(out, 22_764_227);
        assert_eq!(
            curve_sell_out(
                700_000_000 - out,
                1_000_000_000,
                29_750_000_000,
                out
            )
            .unwrap(),
            999_999_971
        );
        assert_eq!(
            curve_sell_out(700_000_000, 1_000_000, 29_750_000_000, u64::MAX).unwrap(),
            1_000_000
        );

        // --- the locked pool ---
        let pool_out = pool_buy_out(700_000_000, 85_000_000_000, 1_000_000_000).unwrap();
        assert_eq!(pool_out, 8_139_534);
        assert_eq!(
            pool_sell_out(700_000_000 - pool_out, 86_000_000_000, pool_out).unwrap(),
            999_999_891
        );

        // --- the fee split, the protocol bucket and the crank ---
        let fees = split_trade_fees(1_000_000_000, 50, 50).unwrap();
        assert_eq!((fees.creator, fees.platform), (5_000_000, 5_000_000));
        assert_eq!(net_after_trade_fees(1_000_000_000, fees).unwrap(), 990_000_000);
        let odd = split_trade_fees(1_999, 50, 50).unwrap();
        assert_eq!((odd.creator, odd.platform), (9, 9));
        assert_eq!(net_after_trade_fees(1_999, odd).unwrap(), 1_981);
        assert_eq!(split_platform_bucket(10_000, 200).unwrap(), (200, 9_800));
        assert_eq!(split_platform_bucket(10_000, 0).unwrap(), (0, 10_000));
        assert_eq!(max_crank_tip(10_000).unwrap(), 200);
        assert_eq!(max_crank_tip(0).unwrap(), 0);

        // --- the TWAP the program prices its own discovery caps with ---
        let price = price_lamports_per_unit(85_000_000_000, 700_000_000).unwrap();
        assert_eq!(price, 121_428_571_428_571);
        let cum = accumulate_price(0, price, 10).unwrap();
        assert_eq!(cum, 1_214_285_714_285_710);
        let cum = accumulate_price(cum, price * 2, 10).unwrap();
        assert_eq!(twap_average(cum, 20).unwrap(), 182_142_857_142_856);

        // --- value normalisation ---
        assert_eq!(lamports_for_units(10, 1_500_000_000_000).unwrap(), 15);
        assert_eq!(units_for_lamports(15, 1_500_000_000_000).unwrap(), 10);
        assert_eq!(units_for_lamports(14, 1_500_000_000_000).unwrap(), 9);

        // --- the launch's mining schedule ---
        assert_eq!(
            initial_block_reward(250_000_000, 604_800, 300, 100).unwrap(),
            124_007
        );
        assert_eq!(mul_bps(700_000_000, 500).unwrap(), 35_000_000);
        assert_eq!(curve_mining_rate(35_000_000, 300, 30).unwrap(), 4_051);
        assert_eq!(
            mul_bps(85_000_000_000, DEFAULT_VIRTUAL_SOL_BPS).unwrap(),
            29_750_000_000
        );
    }

}
