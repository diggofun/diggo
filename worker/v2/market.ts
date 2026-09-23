/**
 * The pure arithmetic the read API needs, mirroring the program's own formulas.
 *
 * Nothing here is authoritative for anything: the chain pays, and these functions only decide
 * what a page displays. They are kept separate from the indexer so a display bug cannot be
 * mistaken for an indexed fact, and they are unit-tested against the same formulas the program
 * uses so a price on screen is the price the program would quote.
 */
import {
  INDEX_SCALE,
  type DecodedCoin,
  type DecodedLiquidityPool,
  baseUnitsToWhole,
  lamportsToSol,
} from "./program";

/** `BPS` as a bigint, so every division below stays in integer arithmetic. */
const BPS_BIG = 10_000n;

/**
 * The bonding-curve spot price in lamports per whole token: the curve's effective SOL over its
 * token inventory. A post-graduation read has to come from the pool instead, because a
 * graduated coin's own curve reserves are zero by design.
 */
export function curveSpotPriceLamports(coin: DecodedCoin, decimals: number): number {
  const effectiveSol = Number(coin.solReserve + coin.virtualSolReserve);
  const whole = baseUnitsToWhole(coin.tokenReserve, decimals);
  if (whole <= 0) return 0;
  return effectiveSol / whole;
}

/** The locked pool's spot price in lamports per whole token. */
export function poolSpotPriceLamports(pool: DecodedLiquidityPool, decimals: number): number {
  const whole = baseUnitsToWhole(pool.tokenReserve, decimals);
  if (whole <= 0) return 0;
  return Number(pool.solReserve) / whole;
}

export type CoinVenue = "curve" | "pool";

/**
 * Which venue a coin trades on. A coin is on its pool exactly when it has graduated, whether or
 * not the pool account came back this time: a graduated coin's curve reserves are zero by design,
 * so calling it a curve would describe a venue that holds nothing.
 */
export function venueOf(coin: DecodedCoin, _pool: DecodedLiquidityPool | null): CoinVenue {
  return coin.graduated ? "pool" : "curve";
}

/**
 * The spot price in lamports per whole token, read from whichever venue holds the liquidity.
 * A graduated coin with an unreadable pool reports zero rather than its by-then-empty curve: a
 * visibly wrong zero is better than a plausibly wrong price.
 */
export function spotPriceLamports(
  coin: DecodedCoin,
  pool: DecodedLiquidityPool | null,
  decimals: number,
): number {
  if (!coin.graduated) return curveSpotPriceLamports(coin, decimals);
  return pool ? poolSpotPriceLamports(pool, decimals) : 0;
}

/** Real SOL backing the price, in lamports, from whichever venue holds it. */
export function venueLiquidityLamports(coin: DecodedCoin, pool: DecodedLiquidityPool | null): bigint {
  if (!coin.graduated) return coin.solReserve;
  return pool?.solReserve ?? 0n;
}

/**
 * True when a permissionless `graduate_market` could do anything right now: the curve has
 * reached its target, the coin has not graduated, and there is no pool yet.
 */
export function graduationReady(coin: DecodedCoin, pool: DecodedLiquidityPool | null): boolean {
  return (
    !coin.graduated &&
    pool === null &&
    coin.graduationTarget > 0n &&
    coin.solReserve >= coin.graduationTarget
  );
}

/** The curve-phase mining ledger, as the coin's own fields describe it. */
export function curveMining(coin: DecodedCoin) {
  const cap = coin.curveMiningCap;
  const mined = coin.curveMiningMined;
  const remaining = cap > mined ? cap - mined : 0n;
  return {
    open: coin.curveMiningOpen && !coin.graduated && remaining > 0n,
    disabled: cap === 0n,
    cap: Number(cap),
    mined: Number(mined),
    remaining: Number(remaining),
    progress: cap === 0n ? 0 : Number(mined) / Number(cap),
    blockReward: Number(coin.curveMiningBlockReward),
    unpaid: Number(coin.curveMiningUnpaid),
  };
}

/**
 * The bonded and starter shares of one block, from the coin's two power totals and the
 * starter-tranche cap. Mirrors the starter-tranche amendment: the starter index may never
 * receive more than `starterTrancheBps` of a block, and when there is no bonded power at all the
 * remainder stays in the Mining Reserve rather than moving to the starter index.
 */
export function blockSplit(
  coin: DecodedCoin,
  starterTrancheBps: number,
): { bonded: bigint; starter: bigint; unassigned: bigint } {
  const reward = coin.currentBlockReward;
  if (reward === 0n) return { bonded: 0n, starter: 0n, unassigned: 0n };
  const bondedPower = coin.bondedPower;
  const starterPower = coin.starterPower;
  const totalPower = bondedPower + starterPower;
  if (totalPower === 0n) return { bonded: 0n, starter: 0n, unassigned: reward };
  const starterCap = (reward * BigInt(starterTrancheBps)) / BPS_BIG;
  const starterShare = (reward * starterPower) / totalPower;
  const starter = starterShare > starterCap ? starterCap : starterShare;
  const bonded = reward - starter;
  // When nothing is bonded, the block's whole remainder is unassigned and stays in the reserve.
  const unassigned = bondedPower === 0n ? bonded : 0n;
  return { bonded, starter, unassigned };
}

/**
 * A position's unclaimed reward at the current index, for display.
 *
 * The coin carries one cumulative index per tranche - `bondedIndex` for bonded power and
 * `starterIndex` for the starter tranche, already scaled by the starter efficiency in the program -
 * so a position is priced off the index of its own tranche and `INDEX_SCALE` is the fixed point.
 */
export function pendingReward(
  position: { assignedPower: bigint; lastRewardIndex: bigint; pendingReward: bigint; tranche: number },
  coin: DecodedCoin,
): bigint {
  const index = position.tranche === 1 ? coin.starterIndex : coin.bondedIndex;
  if (index <= position.lastRewardIndex) return position.pendingReward;
  const delta = index - position.lastRewardIndex;
  return position.pendingReward + (position.assignedPower * delta) / INDEX_SCALE;
}

/** Lamports to SOL, re-exported so callers of this module need one import, not two. */
export { lamportsToSol };
