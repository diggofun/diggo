import { DIGGO_CONFIG, type DiggoConfig } from "./config";
import { ACCOUNT_RENT_LAMPORTS } from "./program";
import type { DecodedCoin, DecodedLiquidityPool } from "./program";
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

/**
 * The five curve-ledger fields of a decoded `Coin`, which is all this ledger reads. They are
 * named rather than taken from `DecodedCoin` so a caller holding only the ledger - a test, the
 * sim's own market - can use the same helpers without inventing a whole account.
 */
export interface CurveMiningLedgerFields {
  graduated: boolean;
  curveMiningCap: bigint;
  curveMiningMined: bigint;
  curveMiningUnpaid: bigint;
  curveMiningBlockReward: bigint;
}

export function curveMiningStateOf(market: CurveMiningLedgerFields): CurveMiningState {
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

/** The reserve pair and the graduation flag a sell capacity is read from. */
export interface CurveVenueReserves {
  graduated: boolean;
  solReserve: bigint;
  virtualSolReserve: bigint;
  tokenReserve: bigint;
}

export function curveSellCapacity(market: CurveVenueReserves): CurveSellCapacity {
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

// ---- v2: the bonding curve, the locked pool, the fee split and the on-chain TWAP -----------
//
// The client-and-Worker mirror of programs/diggo-protocol/src/math/curve.rs, math/fees.rs and
// the Coin ledger helpers of state/coin.rs. None of it decides anything: the chain is the
// authority and a disagreement here is a bug to fix, not a rule to apply. Every function rounds
// the way the Rust does - down, never in the caller's favour - and the golden vectors in
// shared/parity/coin.json pin the pair from the Rust side.
//
// A launched coin trades on its bonding curve until it reaches its graduation target and in its
// locked pool afterwards. Both paths charge the same two fees, snapshotted into the coin at
// launch so a later config change can never alter an existing market retroactively.

/** Scale of every price the program derives from its own pool, in lamports per base unit. */
export const PRICE_SCALE = 1_000_000_000_000n;

/** Slots per second, used to turn an epoch's length in seconds into slots. */
export const SLOTS_PER_SECOND = 2n;

/** Basis points, as the chain counts them. */
export const BPS_V2 = 10_000n;

/** The share of a graduation target a curve starts with as a virtual SOL reserve. */
export const DEFAULT_VIRTUAL_SOL_BPS = 3_500;

/** Rent-exempt minimum of an account of this size: (size + 128) * 3,480 * 2 lamports. */
export function rentExemptLamports(size: number): bigint {
  return (BigInt(size) + 128n) * 6_960n;
}

/** A share of an amount in bps, rounded down: the direction every split on this path rounds. */
export function mulBpsV2(amount: bigint, bps: number): bigint {
  return (amount * BigInt(bps)) / BPS_V2;
}

/** The tokens a curve buy returns for a net SOL input, with the fees already taken. */
export function curveBuyOut(
  tokenReserve: bigint,
  solReserve: bigint,
  virtualSolReserve: bigint,
  netSol: bigint,
): bigint {
  return (tokenReserve * netSol) / (solReserve + virtualSolReserve + netSol);
}

/**
 * The gross SOL a curve sell returns for a token input, capped at the curve's real SOL.
 *
 * The virtual reserve inflates the price but can never be paid out, so the cap is what stops a
 * sell from being paid out of lamports the curve does not hold.
 */
export function curveSellOut(
  tokenReserve: bigint,
  solReserve: bigint,
  virtualSolReserve: bigint,
  tokensIn: bigint,
): bigint {
  const raw = ((solReserve + virtualSolReserve) * tokensIn) / (tokenReserve + tokensIn);
  return raw < solReserve ? raw : solReserve;
}

/** Tokens out of the locked pool for a net SOL input. */
export function poolBuyOut(tokenReserve: bigint, solReserve: bigint, netSol: bigint): bigint {
  return (tokenReserve * netSol) / (solReserve + netSol);
}

/** SOL out of the locked pool for a token input, before the explicit fees. */
export function poolSellOut(tokenReserve: bigint, solReserve: bigint, tokensIn: bigint): bigint {
  const raw = (solReserve * tokensIn) / (tokenReserve + tokensIn);
  return raw < solReserve ? raw : solReserve;
}

/** The two destinations of one trade's fee, in lamports. */
export interface TradeFeesV2 {
  creator: bigint;
  platform: bigint;
}

/**
 * Splits a trade's gross lamports into the creator's share and the protocol's share.
 *
 * Both shares round down, so the net the curve or the pool receives is the remainder and the
 * lamports always add up. The two shares together may never exceed the protocol cap, which is
 * what stops a governance mistake from turning a trade into a fee.
 */
export function splitTradeFees(
  gross: bigint,
  creatorFeeBps: number,
  platformFeeBps: number,
): TradeFeesV2 {
  return {
    creator: mulBpsV2(gross, creatorFeeBps),
    platform: mulBpsV2(gross, platformFeeBps),
  };
}

/** What the curve or the pool receives after the fees. */
export function netAfterTradeFees(gross: bigint, fees: TradeFeesV2): bigint {
  return gross - fees.creator - fees.platform;
}

/** The share of the protocol bucket the crank-pool PDA receives at sweep time. */
export function crankPoolShare(platformLamports: bigint, crankPoolFeeBps: number): bigint {
  return mulBpsV2(platformLamports, crankPoolFeeBps);
}

/** Splits the protocol bucket between the crank pool and the treasury. The two always add up. */
export function splitPlatformBucket(
  platformLamports: bigint,
  crankPoolFeeBps: number,
): { crankPool: bigint; treasury: bigint } {
  const crankPool = crankPoolShare(platformLamports, crankPoolFeeBps);
  return { crankPool, treasury: platformLamports - crankPool };
}

/** The largest tip one crank_tip may pay: CRANK_TIP_BPS of the protocol bucket. */
export function maxCrankTip(platformLamports: bigint, crankTipBps = 200): bigint {
  return mulBpsV2(platformLamports, crankTipBps);
}

/** The lamports-per-base-unit price of one reserve pair, scaled by PRICE_SCALE. */
export function priceLamportsPerUnit(solReserve: bigint, tokenReserve: bigint): bigint {
  return (solReserve * PRICE_SCALE) / tokenReserve;
}

/** One observation into a cumulative price-slot accumulator. */
export function accumulatePrice(cum: bigint, price: bigint, slots: bigint): bigint {
  return slots === 0n ? cum : cum + price * slots;
}

/** The time-weighted average of an accumulator's increment over the slots it covered. */
export function twapAverage(cumDelta: bigint, slots: bigint): bigint {
  return cumDelta / slots;
}

/** The base units a lamport amount buys at a scaled price, rounded down. */
export function unitsForLamports(lamports: bigint, price: bigint): bigint {
  return (lamports * PRICE_SCALE) / price;
}

/** The value in lamports of some base units at a scaled price, rounded down. */
export function lamportsForUnits(units: bigint, price: bigint): bigint {
  return (units * price) / PRICE_SCALE;
}

/**
 * The launch split of one total supply: the Mining Reserve, the Discovery Reserve and the
 * curve's inventory, in that order. Both reserves round down, so the curve keeps the remainder
 * and the three always add up to the whole supply.
 */
export function splitSupply(
  totalSupply: bigint,
  reserveBps: number,
  discoveryReserveBps: number,
): { reserve: bigint; discovery: bigint; curve: bigint } {
  const reserve = mulBpsV2(totalSupply, reserveBps);
  const discovery = mulBpsV2(totalSupply, discoveryReserveBps);
  return { reserve, discovery, curve: totalSupply - reserve - discovery };
}

/** The virtual SOL depth a curve starts with, derived from its graduation target. */
export function virtualSolReserve(graduationTarget: bigint): bigint {
  return mulBpsV2(graduationTarget, DEFAULT_VIRTUAL_SOL_BPS);
}

/**
 * The initial per-block reward of a coin's Mining Reserve: the reserve spread over the blocks of
 * one epoch, floored at the launch's minimum reward.
 */
export function initialBlockReward(
  reserveRemaining: bigint,
  epochLength: number,
  blockInterval: number,
  minimumReward: bigint,
): bigint {
  const blocks = BigInt(Math.max(1, Math.floor(epochLength / blockInterval)));
  const reward = reserveRemaining / blocks;
  return reward > minimumReward ? reward : minimumReward;
}

/**
 * The rent one launch costs the creator, account by account: the mint at the frozen 438-byte
 * `MINT_V2_SIZE` layout the Rust program funds, the Coin account at its 464-byte `Coin::SIZE` and
 * the single vault at 165. The figures are read from the frozen account table rather than restated,
 * so a contract change moves this function with it.
 */
export function launchRentLamports(): {
  mint: bigint;
  coin: bigint;
  vault: bigint;
  total: bigint;
} {
  const mint = ACCOUNT_RENT_LAMPORTS.mint;
  const coin = ACCOUNT_RENT_LAMPORTS.coin;
  const vault = ACCOUNT_RENT_LAMPORTS.coinVault;
  return { mint, coin, vault, total: mint + coin + vault };
}

/**
 * The two launch defaults the form sends for the reserve split, mirroring
 * `constants.rs::DEFAULT_RESERVE_BPS` and `constants.rs::DEFAULT_DISCOVERY_RESERVE_BPS`.
 *
 * They are launch arguments rather than protocol policy, so a creator may name different ones and
 * the form shows the split it will actually send. They live here, with `splitSupply`, because
 * that is the function that turns them into the three parts of a supply (CCR-F5).
 */
export const DEFAULT_RESERVE_BPS = 500;
export const DEFAULT_DISCOVERY_RESERVE_BPS = 50;

// ---- the quotes a form shows, and the guards the program applies ---------------------------
//
// The single home of the trade quote mirror (CCR-F4). Every function is a transcription of
// programs/diggo-protocol/src/math/curve.rs and math/fees.rs, with the same integer widths and
// the same rounding direction: division truncates, and every truncation is arranged so the
// protocol keeps the remainder rather than the caller. When a value disagrees, the Rust value
// wins and this file is the bug, because the chain is what pays. The four quote functions also
// reproduce the program's `require!` guards, so a trade the program would reject is refused
// before anything is signed.

/** `mul_bps`, under the name the quote path has always used. One implementation: `mulBpsV2`. */
export { mulBpsV2 as mulBps };

/** The two fee rates one trade carries, both snapshotted into the coin at launch. */
export interface TradeFeeBps {
  creatorFeeBps: number;
  platformFeeBps: number;
}

/** The three parts of one trade's gross: what the venue sees and the two explicit fees. */
export interface FeeSplit {
  /** What the curve or the pool sees, or what the wallet receives on a sell. */
  net: bigint;
  creatorFee: bigint;
  platformFee: bigint;
  /** creatorFee + platformFee, which is what `split_trade_fees` caps as a pair. */
  totalFee: bigint;
}

/**
 * Splits a gross amount into the net and the two explicit fees.
 *
 * A coin carries exactly two fee buckets, so a trader pays exactly two fees. The crank pool is
 * **not** a third one: `ProtocolConfig.crank_pool_fee_bps` is carved out of the protocol's own
 * bucket at sweep time by `split_platform_bucket`, and a crank tip is paid from the same bucket
 * (math/fees.rs, CCR-F2). Charging it to the trader as well would over-state the fee and
 * under-state the floor a form sends.
 */
export function splitFees(amount: bigint, bps: TradeFeeBps): FeeSplit {
  const fees = splitTradeFees(amount, bps.creatorFeeBps, bps.platformFeeBps);
  return {
    net: netAfterTradeFees(amount, fees),
    creatorFee: fees.creator,
    platformFee: fees.platform,
    totalFee: fees.creator + fees.platform,
  };
}

/** Thrown when a trade cannot be priced, or when the program would refuse it. */
export class QuoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuoteError";
  }
}

/**
 * The tokens a curve buy returns for a net SOL input, with the fees already taken.
 *
 * The curve's token inventory may never be emptied, because graduation needs both sides
 * non-zero, so a buy that would take the last base unit is refused here exactly as
 * `curve_buy_out` refuses it on-chain.
 */
export function quoteCurveBuy(
  coin: Pick<DecodedCoin, "tokenReserve" | "solReserve" | "virtualSolReserve">,
  netSol: bigint,
): bigint {
  if (netSol <= 0n) throw new QuoteError("Enter an amount to trade.");
  if (coin.tokenReserve <= 0n) throw new QuoteError("This coin's curve has sold out.");
  const out = curveBuyOut(coin.tokenReserve, coin.solReserve, coin.virtualSolReserve, netSol);
  if (out <= 0n) throw new QuoteError("This trade is too small to fill.");
  if (out >= coin.tokenReserve) {
    throw new QuoteError(
      "This buy would empty the curve, which the program refuses. Try a smaller amount.",
    );
  }
  return out;
}

/**
 * The gross SOL a curve sell returns for a token input, capped at the curve's real SOL. The
 * virtual reserve only ever inflates the price, never the payout, so a sell can never be paid
 * out of lamports the curve does not hold.
 */
export function quoteCurveSell(
  coin: Pick<DecodedCoin, "tokenReserve" | "solReserve" | "virtualSolReserve">,
  tokensIn: bigint,
): bigint {
  if (tokensIn <= 0n) throw new QuoteError("Enter an amount to trade.");
  if (coin.tokenReserve <= 0n) throw new QuoteError("This coin's curve has sold out.");
  if (coin.solReserve <= 0n) throw new QuoteError("This curve holds no SOL to pay a sell.");
  const gross = curveSellOut(coin.tokenReserve, coin.solReserve, coin.virtualSolReserve, tokensIn);
  if (gross <= 0n) throw new QuoteError("This curve holds no SOL to pay a sell.");
  return gross;
}

/** Tokens out of the locked pool for a net SOL input. k can only grow. */
export function quotePoolBuy(
  pool: Pick<DecodedLiquidityPool, "tokenReserve" | "solReserve">,
  netSol: bigint,
): bigint {
  if (netSol <= 0n) throw new QuoteError("Enter an amount to trade.");
  if (pool.tokenReserve <= 0n || pool.solReserve <= 0n) {
    throw new QuoteError("This pool is not initialised yet.");
  }
  const out = poolBuyOut(pool.tokenReserve, pool.solReserve, netSol);
  if (out <= 0n) throw new QuoteError("This trade is too small to fill.");
  if (out >= pool.tokenReserve) {
    throw new QuoteError("This buy would empty the pool. Try a smaller amount.");
  }
  return out;
}

/** SOL out of the locked pool for a token input, before the explicit fees. */
export function quotePoolSell(
  pool: Pick<DecodedLiquidityPool, "tokenReserve" | "solReserve">,
  tokensIn: bigint,
): bigint {
  if (tokensIn <= 0n) throw new QuoteError("Enter an amount to trade.");
  if (pool.tokenReserve <= 0n || pool.solReserve <= 0n) {
    throw new QuoteError("This pool is not initialised yet.");
  }
  const out = poolSellOut(pool.tokenReserve, pool.solReserve, tokensIn);
  if (out <= 0n) throw new QuoteError("This pool holds no SOL to pay a sell.");
  return out;
}

/**
 * The spot price in lamports per base unit, from the venue that actually backs the price.
 * The pool's own reserves price a graduated coin; the curve prices one before graduation.
 *
 * Display only: the program prices its own discovery caps off the pool TWAP, never off a spot
 * read, and nothing here is an input to any instruction.
 */
export function curveSpotPriceLamportsPerUnit(
  coin: Pick<DecodedCoin, "tokenReserve" | "solReserve" | "virtualSolReserve">,
): number | null {
  if (coin.tokenReserve <= 0n) return null;
  const effective = coin.solReserve + coin.virtualSolReserve;
  return Number((effective * 1_000_000_000n) / coin.tokenReserve) / 1_000_000_000;
}

export function poolSpotPriceLamportsPerUnit(
  pool: Pick<DecodedLiquidityPool, "tokenReserve" | "solReserve">,
): number | null {
  if (pool.tokenReserve <= 0n || pool.solReserve <= 0n) return null;
  return Number((pool.solReserve * 1_000_000_000n) / pool.tokenReserve) / 1_000_000_000;
}
