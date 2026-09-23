/**
 * Curve-phase mining: what pre-graduation emission does to a bonding curve.
 *
 * Every mine launched through the protocol mines from its launch block, and before graduation it
 * pays those block rewards out of its own curve's token inventory (see shared/curve.ts and
 * apply_curve_mining_debit in programs/diggo-protocol/src/lib.rs). That is a market question, and
 * nothing else in the harness models a curve, so this module does - on the real rules: the
 * program's own quote math and spot price (shared/program.ts), the launch-time cap, rate, room and
 * sell capacity (shared/curve.ts), and the reward index that divides the emission across the power
 * pointed at the mine (shared/rewardIndex.ts).
 *
 * Two curves run over the same trade sequence, one that mines and one that does not. The gap
 * between them is the price impact of curve-phase mining, measured rather than asserted.
 *
 * What it shows, and why it is worth reading:
 *   - mining out of the curve raises the price exactly where a buy of the same token amount moves
 *     the token side, and it brings no SOL with it, so sell capacity does not move at all;
 *   - the cap is finite: whoever spends it - a farm, or honest players - ends curve-phase emission
 *     for everyone, and graduation is what turns mining back on;
 *   - the ledger is exact: the curve's inventory only ever shrinks by what the reward index can
 *     actually pay out, so every base unit taken from the curve is claimable and the remainder the
 *     integer index cannot divide stays in the inventory to seed the pool at graduation;
 *   - a farm's power is damped by the configured cluster factors, but the tokens it does mine are
 *     still tokens taken out of the curve everyone else is buying from, which raises the price
 *     against them.
 */
import { DIGGO_CONFIG, type DiggoConfig } from "../../shared/config";
import {
  curveMiningBlockReward,
  curveMiningCapFor,
  curveMiningDaysRemaining,
  curveMiningProgress,
  curveMiningRoom,
  curveMiningStateOf,
  curveSellCapacity,
  curveBuyOut,
  curveSellOut,
  isCurveMiningOpen,
  type CurveMiningLedgerFields,
  type CurveVenueReserves,
} from "../../shared/curve";
import {
  applyBlock,
  createMiningPosition,
  createRewardIndexState,
  setPositionPower,
  settlePosition,
  type MiningPosition,
  type RewardIndexState,
} from "../../shared/rewardIndex";
import type { CheckResult } from "./selfcheck";
import { RngStream } from "./rng";

/** The launch this scenario prices: a 1B supply with the default reserve split. */
const TOTAL_SUPPLY_WHOLE = 1_000_000_000;
const DECIMALS = 6;
const RESERVE_BPS = 500;
const DISCOVERY_BPS = 50;
const BLOCK_SECONDS = 300;
const BLOCKS_PER_DAY = 86_400 / BLOCK_SECONDS;
/** One Mining Power unit per wallet, before maturity and cluster damping. */
const POWER_PER_WALLET = 100;
/** Wallets arrive evenly over this window, exactly as the rest of the harness models it. */
const ARRIVAL_DAYS = 30;

export interface CurvePhaseOptions {
  seed: number;
  days: number;
  /** Honest wallets. */
  humans: number;
  /** Wallets in one naive farm, all created at launch on one device and one network. */
  bots: number;
  config?: DiggoConfig;
}

export interface CurvePhaseRow {
  day: number;
  /** SOL per whole token on the curve that mines. */
  priceSol: number;
  /** The same curve over the same trades, with no mining at all. */
  counterfactualPriceSol: number;
  /** How much of the price curve-phase mining is responsible for, in bps. */
  miningPriceImpactBps: number;
  curveInventoryWhole: number;
  capWhole: number;
  minedWhole: number;
  capProgress: number;
  humanMinedWhole: number;
  botMinedWhole: number;
  botShareBps: number;
  /** Real SOL a seller can take out of the curve right now. */
  sellCapacitySol: number;
  /** Token amount that would take all of it, or null when no finite amount can. */
  sellCapacityTokens: number | null;
  daysOfCapLeft: number | null;
  graduated: boolean;
  capSpent: boolean;
}

export interface CurvePhaseTotals {
  initialInventoryWhole: number;
  curveInventoryWhole: number;
  minedWhole: number;
  boughtOutWhole: number;
  soldBackWhole: number;
  claimableWhole: number;
  dustWhole: number;
  /** Budget the integer index could not divide among the mine's power, left in the curve. */
  unowedWhole: number;
  capWhole: number;
  /** The conservation identity's residual: curve + mined + bought - sold - initial. */
  conservationErrorWhole: number;
  dayCapSpent: number | null;
  dayGraduated: number | null;
  sellCapacitySol: number;
}

export interface CurvePhaseResult {
  rows: readonly CurvePhaseRow[];
  totals: CurvePhaseTotals;
}

/** The maturity ramp, applied to a wallet that is ageDays old (shared/config.ts). */
function rampFactor(ageDays: number, config: DiggoConfig): number {
  for (const point of config.effectivePower.maturityRamp) {
    if (ageDays < point.upToDay) return point.bps / 10_000;
  }
  return 1;
}

/**
 * The cluster factor a farm of wallets on one device and one network keeps, from the configured
 * allowance, decay and floors. It is the one thing between a farm and the whole cap.
 */
function clusterFactor(wallets: number, config: DiggoConfig): number {
  const cluster = config.effectivePower.cluster;
  const overDevice = Math.max(0, wallets - cluster.deviceAllowance);
  const overNetwork = Math.max(0, wallets - cluster.networkAllowance);
  const device = (cluster.deviceDecayBps / 10_000) ** overDevice;
  const network = Math.max(
    cluster.minimumNetworkFactorBps / 10_000,
    (cluster.networkDecayBps / 10_000) ** overNetwork,
  );
  return Math.max(cluster.minimumFactorBps / 10_000, device * network);
}

/**
 * The curve fields this scenario tracks, read from the v2 mirror's own structural types: a Coin's
 * curve side, its curve-mining ledger, and the graduation target the scenario watches.
 */
type CurveMarket = CurveMiningLedgerFields &
  CurveVenueReserves & { graduationTarget: bigint; creatorFeeBps: number; platformFeeBps: number };

/** The curve's buy quote, in the v2 mirror's own terms (the v4 wrapper's replacement). */
function quoteBuy(market: CurveVenueReserves, netSol: bigint): bigint {
  return curveBuyOut(market.tokenReserve, market.solReserve, market.virtualSolReserve, netSol);
}

/** The curve's sell quote, capped at the curve's real SOL by the mirror itself. */
function quoteSell(market: CurveVenueReserves, tokensIn: bigint): bigint {
  return curveSellOut(market.tokenReserve, market.solReserve, market.virtualSolReserve, tokensIn);
}

/**
 * The curve's spot price in lamports per whole token, which is the unit the report's price column
 * has always used. The v2 mirror publishes lamports per base unit, so the decimals conversion the
 * scenario already knows about is applied here rather than restated as a second formula.
 */
function spotPriceLamportsPerWholeToken(market: CurveVenueReserves): number {
  if (market.tokenReserve <= 0n) return 0;
  const effective = market.solReserve + market.virtualSolReserve;
  return Number((effective * 10n ** BigInt(DECIMALS)) / market.tokenReserve);
}

function launchMarket(): CurveMarket {
  const marketBps = 10_000 - RESERVE_BPS - DISCOVERY_BPS;
  const marketWhole = (TOTAL_SUPPLY_WHOLE * marketBps) / 10_000;
  return {
    tokenReserve: BigInt(marketWhole) * 10n ** BigInt(DECIMALS),
    solReserve: 0n,
    virtualSolReserve: 30n * 1_000_000_000n,
    graduationTarget: 85n * 1_000_000_000n,
    graduated: false,
    creatorFeeBps: 50,
    platformFeeBps: 50,
    curveMiningCap: 0n,
    curveMiningMined: 0n,
    curveMiningUnpaid: 0n,
    curveMiningBlockReward: 0n,
  };
}

/**
 * The program's own debit, mirrored: the token side shrinks and the SOL side does not move. This is
 * the whole economic claim of the feature, so the scenario applies it verbatim rather than
 * approximating it.
 */
function debitCurve(market: CurveMarket, amount: bigint): void {
  if (amount <= 0n) return;
  market.tokenReserve -= amount;
  market.curveMiningMined += amount;
  market.curveMiningUnpaid += amount;
}

interface CurveRun {
  market: CurveMarket;
  index: RewardIndexState;
  /** The honest population's position on this mine. */
  human: MiningPosition;
  /** The farm's position on it. Everything the mine carries is one or the other. */
  bot: MiningPosition;
  mined: bigint;
}

export function runCurvePhase(options: CurvePhaseOptions): CurvePhaseResult {
  const config = options.config ?? DIGGO_CONFIG;
  const launched = launchMarket();
  const initialInventory = launched.tokenReserve;
  const cap = curveMiningCapFor(initialInventory, config.curve.defaultMiningBps);
  const rate = curveMiningBlockReward(cap, BLOCK_SECONDS, config.curve.defaultRunwayDays);
  const rng = new RngStream(options.seed, "curve-phase");
  const arrivalDays = Math.min(ARRIVAL_DAYS, Math.max(1, options.days));
  const farmFactor = clusterFactor(Math.max(1, options.bots), config);
  const rows: CurvePhaseRow[] = [];

  const curve = (): CurveRun => ({
    market: { ...launched, curveMiningCap: cap, curveMiningBlockReward: rate },
    index: createRewardIndexState(cap, rate, config),
    human: createMiningPosition("curve-phase", 0n),
    bot: createMiningPosition("curve-phase", 0n),
    mined: 0n,
  });
  const minedRun: CurveRun = curve();
  // The control curve sees the same trades and never mines, so its positions are never used: it
  // exists for the price it holds without any curve-phase emission.
  const controlRun: CurveRun = curve();
  const humanMined = { total: 0n };
  const botMined = { total: 0n };
  // Base units the index could not divide among the power pointed at the mine, and which therefore
  // never left the curve: curve inventory that graduates into the pool with everything else.
  let unowed = 0n;
  let boughtOut = 0n;
  let soldBack = 0n;
  let dayCapSpent: number | null = null;
  let dayGraduated: number | null = null;

  for (let day = 1; day <= options.days; day += 1) {
    let humanPower = 0n;
    for (let arrival = 1; arrival <= arrivalDays; arrival += 1) {
      if (arrival > day) break;
      const perDay = options.humans / arrivalDays;
      humanPower += BigInt(Math.round(perDay * POWER_PER_WALLET * rampFactor(day - arrival, config)));
    }
    const botPower = BigInt(
      Math.round(options.bots * POWER_PER_WALLET * rampFactor(day - 1, config) * farmFactor),
    );
    const totalPower = humanPower + botPower;

    // Arming the two cohorts: everything the mine carries is split into "humans" and "the farm",
    // which is the only distinction the scenario makes, and both are settled through the real
    // reward index rather than by dividing the emission by hand.
    const humanArm = setPositionPower(minedRun.index, minedRun.human, humanPower, config);
    minedRun.human = humanArm.position;
    humanMined.total += humanArm.earned;
    const botArm = setPositionPower(minedRun.index, minedRun.bot, botPower, config);
    minedRun.bot = botArm.position;
    botMined.total += botArm.earned;

    for (let block = 0; block < BLOCKS_PER_DAY; block += 1) {
      const draw = rng.next();
      if (draw < 0.25) {
        const solIn = BigInt(Math.round(1_000_000 + rng.next() * 9_000_000));
        const net = (solIn * BigInt(10_000 - launched.creatorFeeBps - launched.platformFeeBps)) / 10_000n;
        const out = quoteBuy(minedRun.market, net);
        if (out > 0n && out < minedRun.market.tokenReserve && net > 0n) {
          minedRun.market.tokenReserve -= out;
          minedRun.market.solReserve += net;
          boughtOut += out;
          // The control curve sees the same buy, at the price it is at without mining.
          const controlOut = quoteBuy(controlRun.market, net);
          controlRun.market.tokenReserve -= controlOut;
          controlRun.market.solReserve += net;
        }
      } else if (draw < 0.4) {
        const tokensIn = BigInt(Math.round(1_000 + rng.next() * 200_000)) * 10n ** BigInt(DECIMALS);
        const out = quoteSell(minedRun.market, tokensIn);
        if (out > 0n) {
          minedRun.market.tokenReserve += tokensIn;
          minedRun.market.solReserve -= out;
          soldBack += tokensIn;
          const controlOut = quoteSell(controlRun.market, tokensIn);
          controlRun.market.tokenReserve += tokensIn;
          controlRun.market.solReserve -= controlOut;
        }
      }

      // The curve phase's own block, at its flat launch-time rate and clamped by the room left
      // under the cap: the ledger the program walks, block for block.
      if (isCurveMiningOpen(curveMiningStateOf(minedRun.market)) && totalPower > 0n) {
        const room = curveMiningRoom(curveMiningStateOf(minedRun.market));
        const requested = rate < room ? rate : room;
        // The market's own room is the budget for this block, exactly as the program reads it, and
        // what leaves the curve is what the index owes - not the budget. The integer index divides
        // the budget by the power pointed at the mine and truncates, so a remainder can be owed to
        // nobody at all; the program leaves it in the curve's inventory, where graduation moves it
        // into the pool with the rest, instead of parking it in curveMiningUnpaid where no position
        // could ever claim it.
        const outcome = applyBlock(
          { ...minedRun.index, reserveRemaining: room },
          requested,
          totalPower,
          config,
        );
        debitCurve(minedRun.market, outcome.distributed);
        minedRun.mined += outcome.distributed;
        unowed += outcome.capped - outcome.distributed;
        minedRun.index = {
          ...outcome.state,
          reserveRemaining: curveMiningRoom(curveMiningStateOf(minedRun.market)),
        };

        const humanSettle = settlePosition(minedRun.index, minedRun.human, config);
        minedRun.human = humanSettle.position;
        humanMined.total += humanSettle.earned;
        const botSettle = settlePosition(minedRun.index, minedRun.bot, config);
        minedRun.bot = botSettle.position;
        botMined.total += botSettle.earned;
      }
    }

    if (dayCapSpent === null && !isCurveMiningOpen(curveMiningStateOf(minedRun.market)) && !minedRun.market.graduated) {
      dayCapSpent = day;
    }
    if (dayGraduated === null && minedRun.market.solReserve >= minedRun.market.graduationTarget) {
      minedRun.market.graduated = true;
      dayGraduated = day;
    }

    const capacity = curveSellCapacity(minedRun.market);
    const price = spotPriceLamportsPerWholeToken(minedRun.market);
    const counterfactual = spotPriceLamportsPerWholeToken(controlRun.market);
    const claimable = humanMined.total + botMined.total;
    rows.push({
      day,
      priceSol: price,
      counterfactualPriceSol: counterfactual,
      miningPriceImpactBps: counterfactual > 0 ? (price / counterfactual - 1) * 10_000 : 0,
      curveInventoryWhole: Number(minedRun.market.tokenReserve) / 10 ** DECIMALS,
      capWhole: Number(cap) / 10 ** DECIMALS,
      minedWhole: Number(minedRun.market.curveMiningMined) / 10 ** DECIMALS,
      capProgress: curveMiningProgress(curveMiningStateOf(minedRun.market)),
      humanMinedWhole: Number(humanMined.total) / 10 ** DECIMALS,
      botMinedWhole: Number(botMined.total) / 10 ** DECIMALS,
      botShareBps: claimable > 0n ? Number((botMined.total * 10_000n) / claimable) : 0,
      sellCapacitySol: Number(capacity.realSolLamports) / 1_000_000_000,
      sellCapacityTokens:
        capacity.tokensForFullCapacity === null
          ? null
          : Number(capacity.tokensForFullCapacity) / 10 ** DECIMALS,
      daysOfCapLeft: curveMiningDaysRemaining(curveMiningStateOf(minedRun.market), BLOCK_SECONDS),
      graduated: minedRun.market.graduated,
      capSpent: !isCurveMiningOpen(curveMiningStateOf(minedRun.market)) && !minedRun.market.graduated,
    });
  }

  const whole = (value: bigint): number => Number(value) / 10 ** DECIMALS;
  const residual =
    minedRun.market.tokenReserve + minedRun.market.curveMiningMined + boughtOut - soldBack - initialInventory;
  const claimable = humanMined.total + botMined.total;
  return {
    rows,
    totals: {
      initialInventoryWhole: whole(initialInventory),
      curveInventoryWhole: whole(minedRun.market.tokenReserve),
      minedWhole: whole(minedRun.market.curveMiningMined),
      boughtOutWhole: whole(boughtOut),
      soldBackWhole: whole(soldBack),
      claimableWhole: whole(claimable),
      dustWhole: whole(minedRun.mined - claimable),
      unowedWhole: whole(unowed),
      capWhole: whole(cap),
      conservationErrorWhole: whole(residual),
      dayCapSpent,
      dayGraduated,
      sellCapacitySol: Number(curveSellCapacity(minedRun.market).realSolLamports) / 1_000_000_000,
    },
  };
}

/** The checks this scenario is required to pass; main.ts appends them to the run's self-checks. */
export function curvePhaseChecks(result: CurvePhaseResult): CheckResult[] {
  const { totals, rows } = result;
  const last = rows[rows.length - 1];
  return [
    {
      ok: Math.abs(totals.conservationErrorWhole) < 1e-6,
      name: "Curve-phase mining conserves the curve's token inventory",
      detail:
        "curve + mined out + bought - sold back == the launch inventory, to the base unit (residual " +
        totals.conservationErrorWhole.toExponential(2) +
        " whole tokens)",
    },
    {
      ok: totals.minedWhole <= totals.capWhole + 1e-6,
      name: "Curve-phase mining never passes its launch-time cap",
      detail:
        totals.minedWhole.toLocaleString("en-US") +
        " of " +
        totals.capWhole.toLocaleString("en-US") +
        " whole tokens mined" +
        (totals.dayCapSpent === null ? " (cap not spent in the horizon)" : " (spent on day " + totals.dayCapSpent + ")"),
    },
    {
      ok: totals.claimableWhole <= totals.minedWhole + 1e-6,
      name: "Positions can never be credited more than the curve emitted",
      detail:
        totals.claimableWhole.toLocaleString("en-US") +
        " whole tokens claimable out of " +
        totals.minedWhole.toLocaleString("en-US") +
        " emitted: the ledger debits the index's own rounded share, so there is no gap for dust",
    },
    {
      // The review's dust finding: the index cannot always divide a segment's budget among the
      // power pointed at the mine, and the remainder is owed to nobody. Debiting it anyway parks
      // it in curve_mining_unpaid - tokens that left the curve's inventory, that no position can
      // claim, and that graduation leaves stranded in the market vault instead of seeding the
      // pool. The ledger follows the index instead, so every base unit the curve gave up is a
      // base unit some position can claim.
      ok: Math.abs(totals.minedWhole - totals.claimableWhole) < 1e-6,
      name: "What the curve gave up is exactly what positions can claim",
      detail:
        totals.minedWhole.toLocaleString("en-US") +
        " whole tokens mined and claimable, with " +
        totals.unowedWhole.toExponential(2) +
        " whole tokens the index could not divide left in the curve's inventory, where graduation" +
        " moves them into the pool instead of stranding them in the market vault",
    },
    {
      ok: (last?.miningPriceImpactBps ?? 0) >= 0,
      name: "Mining out of the curve never lowers the price",
      detail:
        "day " +
        (last?.day ?? 0) +
        ": " +
        (((last?.miningPriceImpactBps ?? 0) / 100)).toFixed(2) +
        "% above the same curve with no mining",
    },
    {
      ok: rows.every((row) => row.sellCapacitySol <= totals.sellCapacitySol + 1e-9),
      name: "Mining never adds sell capacity",
      detail:
        "the real SOL stays with the curve's own buys (day " +
        (last?.day ?? 0) +
        ": " +
        (last?.sellCapacitySol ?? 0).toFixed(2) +
        " SOL available to sellers)",
    },
  ];
}

export function curvePhaseTable(rows: readonly CurvePhaseRow[], checkpoints = [1, 7, 30, 60, 90]): string {
  const shown = rows.filter((row) => checkpoints.includes(row.day));
  const header =
    "| Day | Price (SOL) | Price with mining vs without | Curve inventory | Cap spent | Mined by humans | Mined by the farm | Farm share | Sell capacity (SOL) | Sell capacity (tokens) | Capped out |\n" +
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |";
  const body = shown
    .map((row) =>
      "| " +
      [
        row.day,
        row.priceSol.toExponential(3),
        (row.miningPriceImpactBps / 100).toFixed(2) + "%",
        Math.round(row.curveInventoryWhole).toLocaleString("en-US"),
        (row.capProgress * 100).toFixed(1) + "%",
        Math.round(row.humanMinedWhole).toLocaleString("en-US"),
        Math.round(row.botMinedWhole).toLocaleString("en-US"),
        (row.botShareBps / 100).toFixed(1) + "%",
        row.sellCapacitySol.toFixed(2),
        row.sellCapacityTokens === null
          ? "no finite amount"
          : Math.round(row.sellCapacityTokens).toLocaleString("en-US"),
        row.capSpent ? "yes" : "no",
      ].join(" | ") +
      " |",
    )
    .join("\n");
  return header + "\n" + body;
}
