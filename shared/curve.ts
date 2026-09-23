import { DIGGO_CONFIG, type DiggoConfig } from "./config";
import type { DecodedLaunchMarket } from "./program";
import type { MineEmissionSource } from "./types";

/**
 * Curve-phase mining: the pre-graduation emission source.
 *
 * Mining works from the launch block, not from graduation. While a market is still on its
 * bonding curve its block rewards are paid out of that curve's own token inventory, so a
 * mined token moves the curve where a bought one moves the token side of it, and the SOL
 * side is untouched. The budget for that is the market's launch-time cap, an immutable
 * share of the inventory the curve started with, spread over a configured runway so a 5%
 * share is weeks of rewards rather than the hours a reserve-sized block reward would spend
 * it in. When the cap is spent, or the market graduates, pre-graduation emission stops; from
 * graduation onwards the mine pays out of its own Mining Reserve exactly as before.
 *
 * A spent cap is idle, not finished: nothing may pay a block until the market graduates, and
 * the mine's Mining Reserve is untouched until then. A market that was launched without a
 * curve share - or one that predates the curve-mining ledger entirely, whose cap a migration
 * can only ever leave at zero - never has one, which is a different state to report and a
 * different state to explain to a player.
 *
 * Everything here is the client-and-Worker mirror of the program's own rules
 * (programs/diggo-protocol/src/lib.rs: curve_mining_is_open, curve_mining_room,
 * curve_mining_rate and apply_curve_mining_debit). None of it decides anything: the program
 * is the authority, and a disagreement here is a bug to fix, not a rule to apply.
 */

/** Which side of a mine pays for a block. Defined with the other wire types. */
export type { MineEmissionSource };

/** The curve-mining ledger of one market, as decoded from its LaunchMarket account. */
export interface CurveMiningState {
  /** True once the market has graduated into its locked pool. */
  graduated: boolean;
  /** The launch-time budget, in base units. Immutable after launch; 0 on a legacy market. */
  cap: bigint;
  /** Cumulative emission, in base units. Never above cap. */
  mined: bigint;
  /** Mined but not yet paid to a claimer, in base units; what graduation leaves behind. */
  unpaid: bigint;
  /** The curve phase's flat per-block output, in base units. */
  blockReward: bigint;
}

export function curveMiningStateOf(market: DecodedLaunchMarket): CurveMiningState {
  return {
    graduated: market.graduated,
    cap: market.curveMiningCap,
    mined: market.curveMiningMined,
    unpaid: market.curveMiningUnpaid,
    blockReward: market.curveMiningBlockReward,
  };
}

/** The budget left under the cap. Zero once it is spent, and zero after graduation. */
export function curveMiningRoom(state: CurveMiningState): bigint {
  if (state.graduated) return 0n;
  const room = state.cap - state.mined;
  return room > 0n ? room : 0n;
}

/** True while this market may still emit mined tokens out of its curve inventory. */
export function isCurveMiningOpen(state: CurveMiningState): boolean {
  return !state.graduated && state.cap > 0n && state.mined < state.cap;
}

/**
 * True once the pre-graduation budget has been spent but the market has not graduated: the
 * mine is idle. Its blocks accrue nothing at all - the program pays none of them, and it never
 * falls back on the Mining Reserve, which only starts paying at graduation.
 */
export function isCurveMiningCapReached(state: CurveMiningState): boolean {
  return !state.graduated && state.cap > 0n && state.mined >= state.cap;
}

/**
 * True for a market on its curve that never had a curve-mining budget at all: launched with a
 * zero share, or written before the ledger existed, where a migration can only ever default
 * the cap to zero. Mining is not paused for these markets, it simply starts at graduation -
 * which is what the UI has to say, rather than showing a progress bar over a budget that was
 * never granted.
 */
export function isCurveMiningDisabled(state: CurveMiningState): boolean {
  return !state.graduated && state.cap <= 0n;
}

/** How much of the curve-mining budget has been spent, as a 0..1 fraction for a progress bar. */
export function curveMiningProgress(state: CurveMiningState): number {
  if (state.cap <= 0n) return state.mined > 0n ? 1 : 0;
  const spent = Number(state.mined) / Number(state.cap);
  return Math.min(1, Math.max(0, spent));
}

/** Blocks a runway spans at one block interval, never fewer than one. */
export function curveMiningRunwayBlocks(blockIntervalSeconds: number, runwayDays: number): bigint {
  if (!(blockIntervalSeconds > 0) || !(runwayDays > 0)) return 0n;
  const blocks = Math.floor((runwayDays * 86_400) / blockIntervalSeconds);
  return BigInt(Math.max(1, blocks));
}

/**
 * Fewest blocks the program will spread a curve budget over (MIN_CURVE_MINING_BLOCKS in
 * programs/diggo-protocol/src/lib.rs). A flat rate is `cap / runway_blocks`, so a launch whose
 * runway holds a single block would emit its whole budget at block one - a budget, not a
 * schedule - and the launch is rejected instead.
 */
export const CURVE_MINING_MIN_BLOCKS = 48;

/**
 * Whether a launch's runway holds enough blocks to be a schedule. Mirrors the program's own
 * check in validate_launch_args: a zero curve share has no runway to bound, and anything else
 * needs at least CURVE_MINING_MIN_BLOCKS of them.
 */
export function curveMiningRunwayIsValid(
  blockIntervalSeconds: number,
  runwayDays: number,
  miningBps: number,
): boolean {
  if (miningBps <= 0) return true;
  return curveMiningRunwayBlocks(blockIntervalSeconds, runwayDays) >= BigInt(CURVE_MINING_MIN_BLOCKS);
}

/**
 * The curve phase's flat per-block output: the cap spread over the runway, rounded up so the
 * budget is always finishable, and never below one base unit while the cap is non-zero.
 * Rounding up can only make the last block smaller, because the program clamps every block
 * to the room left under the cap.
 */
export function curveMiningBlockReward(cap: bigint, blockIntervalSeconds: number, runwayDays: number): bigint {
  if (cap <= 0n) return 0n;
  const blocks = curveMiningRunwayBlocks(blockIntervalSeconds, runwayDays);
  if (blocks <= 0n) return 0n;
  const rate = (cap + blocks - 1n) / blocks;
  return rate > 0n ? rate : 1n;
}

/** The launch-time budget for one market: a bps share of the curve's initial token inventory. */
export function curveMiningCapFor(initialCurveInventory: bigint, miningBps: number): bigint {
  if (initialCurveInventory <= 0n || miningBps <= 0) return 0n;
  return (initialCurveInventory * BigInt(miningBps)) / 10_000n;
}

/** The whole launch-time curve-mining ledger for a market, from its launch parameters. */
export function curveMiningLedgerFor(input: {
  initialCurveInventory: bigint;
  miningBps: number;
  blockIntervalSeconds: number;
  runwayDays: number;
  config?: DiggoConfig;
}): CurveMiningState {
  const config = input.config ?? DIGGO_CONFIG;
  const runtime = config.curve;
  const miningBps = Math.max(0, Math.min(runtime.maxMiningBps, input.miningBps));
  const runwayDays = Math.max(1, Math.min(runtime.maxRunwayDays, input.runwayDays));
  const cap = curveMiningCapFor(input.initialCurveInventory, miningBps);
  return {
    graduated: false,
    cap,
    mined: 0n,
    unpaid: 0n,
    blockReward: curveMiningBlockReward(cap, input.blockIntervalSeconds, runwayDays),
  };
}

/**
 * How long the remaining budget lasts at the current rate, in days, or null when there is
 * nothing left to spend or no rate to spend it at. Display-only: it is an estimate of a
 * schedule, never a promise (see ESTIMATE_LABEL in worker/mining.ts).
 */
export function curveMiningDaysRemaining(
  state: CurveMiningState,
  blockIntervalSeconds: number,
): number | null {
  const room = curveMiningRoom(state);
  if (room <= 0n || state.blockReward <= 0n) return null;
  if (!(blockIntervalSeconds > 0)) return null;
  const blocks = Number(room) / Number(state.blockReward);
  return (blocks * blockIntervalSeconds) / 86_400;
}

/**
 * The read-only sell capacity of a market still on its curve: the real SOL a seller can ever
 * receive, and the token amount that would take all of it.
 *
 * Mined tokens bring no SOL with them, so mining never adds sell capacity: the real reserve
 * is what it always was, and the quote path caps every payout at it. A graduated market has
 * no curve to sell into, so its capacity here is zero and its liquidity is the pool's.
 *
 * tokensForFullCapacity solves quote_sell(t) == sol_reserve for the uncapped curve:
 * (sol + virtual) * t / (tokens + t) = sol gives t = sol * tokens / virtual. With no virtual
 * SOL reserve the uncapped curve can only approach the real reserve asymptotically, so no
 * finite token amount takes all of it and the answer is null.
 */
export interface CurveSellCapacity {
  realSolLamports: bigint;
  tokensForFullCapacity: bigint | null;
}

export function curveSellCapacity(market: DecodedLaunchMarket): CurveSellCapacity {
  if (market.graduated) return { realSolLamports: 0n, tokensForFullCapacity: 0n };
  const realSol = market.solReserve;
  const virtual = market.virtualSolReserve;
  if (virtual <= 0n || realSol <= 0n) return { realSolLamports: realSol, tokensForFullCapacity: null };
  return {
    realSolLamports: realSol,
    tokensForFullCapacity: (realSol * market.tokenReserve) / virtual,
  };
}

/** Everything one mine's off-chain reward index needs to know about its next block. */
export interface ActiveMineBudgetInput {
  curve: CurveMiningState;
  /** The mine's Mining Reserve, in whole tokens, as read from chain. */
  reserveRemaining: bigint;
  /** The reserve as allocated, for progress display. */
  reserveTotal: bigint;
  /** The mine's own reserve-phase block reward, in whole tokens. */
  reserveBlockReward: bigint;
}

export interface ActiveMineBudget {
  source: MineEmissionSource;
  /** The budget the index is spending, so progress is measured against the right one. */
  initialReserve: bigint;
  remainingReserve: bigint;
  rewardPerBlock: bigint;
}

/**
 * Which budget pays the next block, mirroring the program's own rule exactly.
 *
 * Before graduation it is the curve's, open or spent: a spent cap pays nothing rather than
 * quietly falling back on the Mining Reserve, and graduation is what switches the mine back
 * to its own reserve. A mine launched with a zero curve share is pre-graduation for the same
 * reason a legacy one is, and reports a zero budget accordingly.
 */
export function activeMineBudget(input: ActiveMineBudgetInput): ActiveMineBudget {
  if (!input.curve.graduated) {
    return {
      source: "CURVE",
      initialReserve: input.curve.cap,
      remainingReserve: curveMiningRoom(input.curve),
      rewardPerBlock: input.curve.blockReward,
    };
  }
  return {
    source: "RESERVE",
    initialReserve: input.reserveTotal,
    remainingReserve: input.reserveRemaining,
    rewardPerBlock: input.reserveBlockReward,
  };
}
