/**
 * Economy simulation orchestrator: builds the mines, runs the population through the day loop,
 * rolls every day up into CSV-ready rows and audits the result.
 *
 * Every rule the simulation obeys comes from shared/ (see state.ts, world.ts and market.ts).
 */
import { type DiggoConfig, type RewardState } from "../../shared/config";
import { CREW_COMPONENTS, crewPower, effectiveMiningPower, maxCrewPowerRatio } from "../../shared/crew";
import { oreCapacity } from "../../shared/ore";
import { auditReserve, createRewardIndexState } from "../../shared/rewardIndex";
import { robustPrice } from "../../shared/rarity";
import { type RiskOpsConfig } from "../../shared/riskOps";
import { digest, unitFromInts } from "./rng";
import {
  DAY,
  DEFAULT_MAX_CREW_POWER,
  bps,
  mean,
  percentile,
  priceSamplesFor,
  vintageOf,
  type MineRuntime,
  type SimPlayer,
  type DayEvent,
  type FarmRuntime,
} from "./state";
import { buildPopulation, planPlayerDay, settleAndPark } from "./world";
import {
  advanceMine,
  refreshRisk,
  releaseArmedPosition,
  runDiscovery,
  type AdvanceContext,
  type DiscoveryContext,
} from "./market";
import type { Cohort, SimOptions } from "./model";

// --- result shapes ---------------------------------------------------------------------

export interface MineDayRow {
  day: number;
  mineKey: string;
  symbol: string;
  status: "MINING_ACTIVE" | "FULLY_MINED";
  rewardPerBlock: number;
  remainingReserve: number;
  distributedToday: number;
  distributedCum: number;
  totalPower: number;
  botPower: number;
  discoveryRemaining: number;
  discoverySpentToday: number;
  discoverySpentCum: number;
  discoveryEpochSpent: number;
  fullyMinedDay: number | null;
}

export interface DailyRow {
  day: number;
  humansArmed: number;
  botsArmed: number;
  humanPower: number;
  botPower: number;
  totalPower: number;
  botPowerShareBps: number;
  distributedToday: number;
  distributedCum: number;
  minesFullyMined: number;
  humanTokensCum: number;
  botTokensCum: number;
  botMiningShareBps: number;
  /** Tokens actually handed to each cohort by a claim, cumulative (spec 53). */
  humanReleasedCum: number;
  botReleasedCum: number;
  botReleasedShareBps: number;
  /** Tokens parked by a reward hold, cumulative. Reversible, so not captured. */
  heldTokensCum: number;
  humansRetained: number;
  strandedTokens: number;
}

export interface DiscoveryDayRow {
  day: number;
  mineKey: string;
  symbol: string;
  hits: number;
  humanHits: number;
  botHits: number;
  tokens: number;
  usd: number;
  humanTokens: number;
  botTokens: number;
  remaining: number;
  denials: string;
}

export interface CohortDayRow {
  day: number;
  cohort: Cohort;
  players: number;
  oreBalanceP10: number;
  oreBalanceP50: number;
  oreBalanceP90: number;
  oreBalanceP99: number;
  oreBalanceMean: number;
  oreEarnedP50: number;
  oreEarnedP90: number;
  oreEarnedMean: number;
  oreOverflowMean: number;
  oreCapacityMean: number;
  powerP50: number;
  powerP90: number;
  powerMean: number;
  /** Power after account maturity and cluster damping, before the per-account share cap. */
  effectivePowerP50: number;
  crewLevelsP50: number;
  streakP50: number;
  discoveryHitsTotal: number;
}

export interface PowerRow {
  day: number;
  cohort: Cohort;
  vintage: string;
  players: number;
  powerP50: number;
  powerP90: number;
  powerMean: number;
  powerMax: number;
  effectivePowerP50: number;
  ratioVsStarterP50: number;
  starterPower: number;
}

export interface RiskRow {
  day: number;
  cohort: Cohort;
  players: number;
  scoreP50: number;
  scoreP90: number;
  normal: number;
  underReview: number;
  held: number;
  blocked: number;
  claimsAllowed: number;
  discoveriesAllowed: number;
  trustP50: number;
}

export interface MineSummary {
  mineKey: string;
  symbol: string;
  initialReserve: number;
  rewardPerBlock: number;
  /** Launch parameter: days over which this mine distributes its reserve (spec 20, 21). */
  lifetimeDays: number;
  /** The block reward the schedule is paying on the last simulated day. */
  rewardPerBlockAtEnd: number;
  fullyMinedDay: number | null;
  reserveRemainingEnd: number;
  reserveDrainedBps: number;
  distributedCum: number;
  humanTokensCum: number;
  botTokensCum: number;
  botMiningShareBps: number;
  /** Tokens a claim actually released, per cohort: what a farm walked away with (spec 53). */
  humanPaidTokens: number;
  botPaidTokens: number;
  humanHeldTokens: number;
  botHeldTokens: number;
  /** Bot share of the tokens this mine released, in bps. The headline anti-farm number. */
  botReleasedShareBps: number;
  discoveryTotalTokens: number;
  discoveryTotalUsd: number;
  discoveryHumanTokens: number;
  discoveryBotTokens: number;
  discoveryBotShareBps: number;
  /** Discovery tokens the receiving wallet could actually keep (a held win is not received). */
  discoveryHumanReleasedTokens: number;
  discoveryBotReleasedTokens: number;
  discoveryBotReleasedShareBps: number;
  discoveryHeldTokens: number;
  discoveryRemaining: number;
  discoveryReserveUsedBps: number;
  /** Reserve-audit components, in whole tokens, from shared/rewardIndex.ts auditReserve. */
  audit: {
    claimed: number;
    dust: number;
    outstanding: number;
    remaining: number;
    initial: number;
    forfeited: number;
    released: number;
    drained: number;
    /** Tokens the index released that no claim, forfeit, entitlement or dust accounts for. */
    unattributed: number;
    settled: number;
    capped: number;
    dustScaledRaw: string;
    conserved: boolean;
    indexBalanced: boolean;
    reserveBalanced: boolean;
  };
  auditConserved: boolean;
  /** Diagnostics: applied events and settlements, so a ledger mismatch can be traced. */
  events: { arm: number; expire: number; power: number; settlements: number };
  /** Diagnostics: settles that hit the forfeit path (a paused position that still held power). */
  forfeitSettles: { arm: number; expire: number; power: number };
}

export interface SummaryStats {
  scenario: string;
  seed: number;
  days: number;
  humans: number;
  bots: number;
  botStealth: string;
  note: string;
  humanActivationRate: number;
  humansRetainedEnd: number;
  mines: MineSummary[];
  networkDistributedCum: number;
  networkBotMiningShareBps: number;
  /** Bot share of the tokens actually released by a claim: the headline anti-farm number. */
  networkBotReleasedShareBps: number;
  networkReleasedTokens: number;
  networkHeldTokens: number;
  networkDiscoveryUsd: number;
  networkDiscoveryBotShareBps: number;
  oreP50End: { human: number; bot: number };
  oreEarnedP50End: { human: number; bot: number };
  oreBotVsHumanRatio: number;
  powerRatios: {
    starterPower: number;
    day1P50: number;
    day7P50: number;
    veteranP50: number;
    lateEntrantDay7At14P50: number;
    veteranVsDay1: number;
    veteranVsDay7: number;
    veteranEffectiveP50: number;
    theoreticalMaxRatio: number;
    onChainMaxCrewPower: number;
  };
  capDenials: Readonly<Record<string, number>>;
  discoveryMisses: number;
  strandedTokens: number;
  oreLedger: {
    earned: number;
    heldByPlayers: number;
    overflow: number;
    spentOnCrew: number;
  };
  invariants: {
    reservesConserved: boolean;
    discoveryDebitsMatch: boolean;
    oreLedgerClosed: boolean;
    capViolations: number;
    determinismDigest: string;
  };
}

export interface SimResult {
  options: SimOptions;
  mines: MineDayRow[];
  daily: DailyRow[];
  discovery: DiscoveryDayRow[];
  cohorts: CohortDayRow[];
  powers: PowerRow[];
  risk: RiskRow[];
  summary: SummaryStats;
}

// --- statistics ------------------------------------------------------------------------

/**
 * The power a wallet brings to a block at a moment in time, from the same shared rule the arm path
 * uses (spec 40, 58, 61). The per-account share cap is left out on purpose: this is the progression
 * curve of a normal account, and the cap only ever bites on an account out of scale for its mine.
 */
function effectivePowerAt(player: SimPlayer, now: number, config: DiggoConfig): number {
  return Number(
    effectiveMiningPower({
      power: player.power,
      accountAgeSeconds: Math.max(0, now - player.createdTime),
      cluster: { walletsOnDevice: player.deviceCluster, walletsOnNetwork: player.networkCluster },
      config,
    }),
  );
}

function cohortStats(
  day: number,
  cohort: Cohort,
  group: readonly SimPlayer[],
  config: DiggoConfig,
  now: number,
): CohortDayRow {
  const balance = group.map((player) => player.oreBalance).sort((a, b) => a - b);
  const earned = group.map((player) => player.oreEarned).sort((a, b) => a - b);
  const powers = group.map((player) => Number(player.power)).sort((a, b) => a - b);
  const effective = group.map((player) => effectivePowerAt(player, now, config)).sort((a, b) => a - b);
  const levels = group
    .map((player) => CREW_COMPONENTS.reduce((total, component) => total + player.levels[component], 0))
    .sort((a, b) => a - b);
  const streaks = group.map((player) => player.activation.streak).sort((a, b) => a - b);
  return {
    day,
    cohort,
    players: group.length,
    oreBalanceP10: percentile(balance, 0.1),
    oreBalanceP50: percentile(balance, 0.5),
    oreBalanceP90: percentile(balance, 0.9),
    oreBalanceP99: percentile(balance, 0.99),
    oreBalanceMean: mean(balance),
    oreEarnedP50: percentile(earned, 0.5),
    oreEarnedP90: percentile(earned, 0.9),
    oreEarnedMean: mean(earned),
    oreOverflowMean: mean(group.map((player) => player.oreOverflow)),
    oreCapacityMean: mean(group.map((player) => oreCapacity(player.levels, config))),
    powerP50: percentile(powers, 0.5),
    powerP90: percentile(powers, 0.9),
    powerMean: mean(powers),
    effectivePowerP50: percentile(effective, 0.5),
    crewLevelsP50: percentile(levels, 0.5),
    streakP50: percentile(streaks, 0.5),
    discoveryHitsTotal: group.reduce((total, player) => total + player.discoveryHits, 0),
  };
}

function vintageStats(
  day: number,
  players: readonly SimPlayer[],
  options: SimOptions,
  now: number,
): PowerRow[] {
  const buckets = new Map<string, SimPlayer[]>();
  for (const player of players) {
    if (player.churned || player.createdDay > day) continue;
    const vintage = vintageOf(player);
    const list = buckets.get(vintage) ?? [];
    list.push(player);
    buckets.set(vintage, list);
  }
  const starterPower = crewPower(options.config.crew.starterLevels, options.config);
  const rows: PowerRow[] = [];
  for (const [vintage, group] of buckets) {
    const powers = group.map((player) => Number(player.power)).sort((a, b) => a - b);
    const effective = group
      .map((player) => effectivePowerAt(player, now, options.config))
      .sort((a, b) => a - b);
    const p50 = percentile(powers, 0.5);
    rows.push({
      day,
      cohort: group[0].cohort,
      vintage,
      players: group.length,
      powerP50: p50,
      powerP90: percentile(powers, 0.9),
      powerMean: mean(powers),
      powerMax: powers[powers.length - 1] ?? 0,
      effectivePowerP50: percentile(effective, 0.5),
      ratioVsStarterP50: starterPower > 0 ? p50 / starterPower : 0,
      starterPower,
    });
  }
  return rows;
}

function riskStats(day: number, cohort: Cohort, group: readonly SimPlayer[]): RiskRow {
  const scores = group.map((player) => player.riskScore).sort((a, b) => a - b);
  const trusts = group.map((player) => player.trust).sort((a, b) => a - b);
  const count = (state: RewardState): number => group.filter((player) => player.rewardState === state).length;
  return {
    day,
    cohort,
    players: group.length,
    scoreP50: percentile(scores, 0.5),
    scoreP90: percentile(scores, 0.9),
    normal: count("NORMAL"),
    underReview: count("UNDER_REVIEW"),
    held: count("HELD"),
    blocked: count("BLOCKED"),
    claimsAllowed: group.filter((player) => player.rewardState === "NORMAL" || player.rewardState === "UNDER_REVIEW").length,
    discoveriesAllowed: group.filter((player) => player.rewardState === "NORMAL").length,
    trustP50: percentile(trusts, 0.5),
  };
}

// --- the run ---------------------------------------------------------------------------

export function runScenario(scenarioKey: string, options: SimOptions, riskOps: RiskOpsConfig): SimResult {
  const config = options.config;
  const { humans, bots, farms } = buildPopulation(options);
  const players = [...humans, ...bots];
  const order = options.playerOrder === "reverse" ? [...players].reverse() : players;
  const farmById = new Map<number, FarmRuntime>(farms.map((farm) => [farm.id, farm]));

  const mines: MineRuntime[] = options.mines.map((spec, index) => {
    const initialReserve = BigInt(Math.floor((spec.totalSupply * spec.reserveBps) / 10_000));
    const discoveryTotal = Math.floor((spec.totalSupply * spec.discoveryReserveBps) / 10_000);
    const launchTime = options.startTime + (spec.launchDay - 1) * DAY;
    const samples = priceSamplesFor(spec, options.seed + index, launchTime);
    const price = robustPrice(samples, launchTime, config);
    if (!price) throw new Error("simulation price series unusable for " + spec.key);
    return {
      spec,
      initialReserve,
      core: createRewardIndexState(initialReserve, BigInt(spec.rewardPerBlock), config),
      rewardPerBlock: BigInt(spec.rewardPerBlock),
      epoch: 0,
      epochEndsAt: launchTime + options.epochLengthSeconds,
      cursor: launchTime - options.blockIntervalSeconds,
      power: 0n,
      powerHumans: 0n,
      powerBots: 0n,
      status: "MINING_ACTIVE",
      distributed: 0n,
      cappedTotal: 0n,
      forfeited: 0n,
      fullyMinedAt: null,
      distributedToday: 0,
      settledToday: 0,
      settledTotal: 0,
      humanTokens: 0,
      botTokens: 0,
      discoveryReserveTotal: discoveryTotal,
      discoveryReserveRemaining: discoveryTotal,
      discoveryEpochBudget: Math.floor((discoveryTotal * options.discoveryEpochBudgetBps) / 10_000),
      discoveryEpochSpent: 0,
      discoveryEpochEndsAt: launchTime + options.epochLengthSeconds,
      discoverySpent: 0,
      discoverySpentToday: 0,
      discoveryUsd: 0,
      discoveryHumanUsd: 0,
      discoveryBotUsd: 0,
      discoveryHumanTokens: 0,
      discoveryBotTokens: 0,
      discoveryHumanHeldTokens: 0,
      discoveryBotHeldTokens: 0,
      discoveryHitsToday: 0,
      discoveryHumanHitsToday: 0,
      discoveryBotHitsToday: 0,
      discoveryTokensToday: 0,
      discoveryHumanTokensToday: 0,
      discoveryBotTokensToday: 0,
      discoveryUsdToday: 0,
      tokenUsdByDay: new Map<number, number>(),
      paidTokens: 0,
      heldTokens: 0,
      humanPaidTokens: 0,
      botPaidTokens: 0,
      humanHeldTokens: 0,
      botHeldTokens: 0,
      eventCounts: { arm: 0, expire: 0, power: 0 },
      forfeitSettles: { arm: 0, expire: 0, power: 0 },
      settlementCount: 0,
      price,
      denialsToday: new Map<string, number>(),
    };
  });
  const mineByKey = new Map<string, MineRuntime>(mines.map((mine) => [mine.spec.key, mine]));

  const mineRows: MineDayRow[] = [];
  const dailyRows: DailyRow[] = [];
  const discoveryRows: DiscoveryDayRow[] = [];
  const cohortRows: CohortDayRow[] = [];
  const powerRows: PowerRow[] = [];
  const riskRows: RiskRow[] = [];
  const capDenials = new Map<string, number>();
  const misses = { count: 0 };
  const violations = { count: 0 };
  const snapshotDays = new Set([1, 2, 3, 5, 7, 10, 14, 21, 30, 45, 60, 75, options.days]);
  const advanceContext: AdvanceContext = { config, options, riskOps, mineByKey, players };
  let globalUsdToday = 0;

  for (let day = 1; day <= options.days; day += 1) {
    const dayStart = options.startTime + (day - 1) * DAY;
    const dayEnd = dayStart + DAY;
    globalUsdToday = 0;
    const queues = new Map<string, DayEvent[]>();
    for (const mine of mines) {
      mine.denialsToday = new Map<string, number>();
      mine.distributedToday = 0;
      mine.settledToday = 0;
      mine.discoverySpentToday = 0;
      mine.discoveryHitsToday = 0;
      mine.discoveryHumanHitsToday = 0;
      mine.discoveryBotHitsToday = 0;
      mine.discoveryTokensToday = 0;
      mine.discoveryHumanTokensToday = 0;
      mine.discoveryBotTokensToday = 0;
      mine.discoveryUsdToday = 0;
      if (dayStart >= mine.discoveryEpochEndsAt) {
        mine.discoveryEpochSpent = 0;
        mine.discoveryEpochEndsAt += options.epochLengthSeconds;
      }
      if (mine.spec.launchDay === day) {
        const samples = priceSamplesFor(mine.spec, options.seed, dayStart);
        mine.price = robustPrice(samples, dayStart, config) ?? mine.price;
      }
      queues.set(mine.spec.key, []);
    }

    const discoveryContext: DiscoveryContext = {
      options,
      riskOps,
      globalUsdToday: () => globalUsdToday,
      addGlobalUsd: (usd) => {
        globalUsdToday += usd;
      },
      capDenials,
      misses,
      violations,
    };

    for (const player of order) {
      if (player.createdDay > day) continue;
      const plan = planPlayerDay(player, day, dayStart, options, riskOps, mines, mineByKey);
      for (const event of plan.events) {
        const queue = queues.get(event.mineKey);
        if (queue) queue.push(event);
      }
      if (plan.discoveryIntervals.length > 0) {
        runDiscovery(player, day, dayStart, plan.discoveryIntervals, mines, discoveryContext);
      }
    }

    for (const mine of mines) {
      const queue = (queues.get(mine.spec.key) ?? []).sort(
        (left, right) => left.time - right.time || left.player.id - right.player.id,
      );
      advanceMine(mine, dayEnd, queue, advanceContext);
    }
    if (options.debugPower) {
      for (const mine of mines) {
        if (mine.spec.key === "midcap" || mine.spec.key === "longtail") {
          console.log(
            `day ${day} ${mine.spec.key}: released ${mine.distributedToday} settled ${mine.settledToday} power ${mine.power}`,
          );
        }
        let expected = 0n;
        for (const player of players) {
          if (player.powerMine === mine.spec.key) expected += player.powerArmed;
        }
        if (expected !== mine.power) {
          console.log(
            `power mismatch day ${day} ${mine.spec.key}: aggregate ${mine.power} vs positions ${expected}`,
          );
        }
        let stray = 0n;
        for (const player of players) {
          if (player.powerArmed > 0n && player.powerMine !== player.positionMine) stray += player.powerArmed;
        }
        if (stray > 0n) {
          console.log(`stray power day ${day} ${mine.spec.key}: ${stray} in a mine whose position is elsewhere`);
        }
      }
    }

    let stranded = 0;
    for (const player of players) stranded += Number(player.position.pendingReward);
    const humanPower = mines.reduce((total, mine) => total + mine.powerHumans, 0n);
    const botPower = mines.reduce((total, mine) => total + mine.powerBots, 0n);
    const humanTokens = mines.reduce((total, mine) => total + mine.humanTokens, 0);
    const botTokens = mines.reduce((total, mine) => total + mine.botTokens, 0);
    const humanReleased = mines.reduce((total, mine) => total + mine.humanPaidTokens, 0);
    const botReleased = mines.reduce((total, mine) => total + mine.botPaidTokens, 0);
    const heldTotal = mines.reduce((total, mine) => total + mine.heldTokens, 0);
    let distributedCum = 0;
    let distributedToday = 0;
    let fullyMined = 0;
    for (const mine of mines) {
      distributedCum += Number(mine.distributed);
      distributedToday += mine.distributedToday;
      if (mine.status === "FULLY_MINED") fullyMined += 1;
      mineRows.push({
        day,
        mineKey: mine.spec.key,
        symbol: mine.spec.symbol,
        status: mine.status,
        rewardPerBlock: Number(mine.rewardPerBlock),
        remainingReserve: Number(mine.core.reserveRemaining),
        distributedToday: mine.distributedToday,
        distributedCum: Number(mine.distributed),
        totalPower: Number(mine.power),
        botPower: Number(mine.powerBots),
        discoveryRemaining: mine.discoveryReserveRemaining,
        discoverySpentToday: mine.discoverySpentToday,
        discoverySpentCum: mine.discoverySpent,
        discoveryEpochSpent: mine.discoveryEpochSpent,
        fullyMinedDay:
          mine.fullyMinedAt === null ? null : Math.floor((mine.fullyMinedAt - options.startTime) / DAY) + 1,
      });
      discoveryRows.push({
        day,
        mineKey: mine.spec.key,
        symbol: mine.spec.symbol,
        hits: mine.discoveryHitsToday,
        humanHits: mine.discoveryHumanHitsToday,
        botHits: mine.discoveryBotHitsToday,
        tokens: mine.discoveryTokensToday,
        usd: mine.discoveryUsdToday,
        humanTokens: mine.discoveryHumanTokensToday,
        botTokens: mine.discoveryBotTokensToday,
        remaining: mine.discoveryReserveRemaining,
        denials: JSON.stringify(Object.fromEntries([...mine.denialsToday.entries()].sort())),
      });
    }
    dailyRows.push({
      day,
      humansArmed: humans.filter((player) => player.armedUntil !== null && player.armedUntil > dayStart).length,
      botsArmed: bots.filter((player) => player.armedUntil !== null && player.armedUntil > dayStart).length,
      humanPower: Number(humanPower),
      botPower: Number(botPower),
      totalPower: Number(humanPower + botPower),
      botPowerShareBps: bps(Number(botPower), Number(humanPower + botPower)),
      distributedToday,
      distributedCum,
      minesFullyMined: fullyMined,
      humanTokensCum: humanTokens,
      botTokensCum: botTokens,
      botMiningShareBps: bps(botTokens, humanTokens + botTokens),
      humanReleasedCum: humanReleased,
      botReleasedCum: botReleased,
      botReleasedShareBps: bps(botReleased, humanReleased + botReleased),
      heldTokensCum: heldTotal,
      humansRetained: humans.filter((player) => !player.churned).length,
      strandedTokens: stranded,
    });

    for (const player of order) {
      if (player.createdDay > day || player.churned) continue;
      if (player.cohort === "human" && player.habit) {
        const churn = drawChurn(options.seed, player.id, day);
        if (churn < player.habit.churnPerDay) {
          player.churned = true;
          continue;
        }
      }
      refreshRisk(player, dayStart, config, riskOps, farmById);
    }

    if (snapshotDays.has(day)) {
      const retained = players.filter((player) => player.createdDay <= day && !player.churned);
      for (const cohort of ["human", "bot"] as const) {
        const group = retained.filter((player) => player.cohort === cohort);
        if (group.length === 0) continue;
        cohortRows.push(cohortStats(day, cohort, group, config, dayStart));
        riskRows.push(riskStats(day, cohort, group));
      }
      for (const row of vintageStats(day, players, options, dayStart)) powerRows.push(row);
    }
  }

  // --- release every still-armed position at the end of the horizon
  const simEnd = options.startTime + options.days * DAY;
  for (const mine of mines) {
    const queue: DayEvent[] = [];
    for (const player of players) {
      if (player.powerMine === mine.spec.key && player.powerArmed > 0n) {
        queue.push({
          time: simEnd,
          kind: "expire",
          mineKey: mine.spec.key,
          power: 0n,
          windowEnd: simEnd,
          player,
        });
      }
    }
    queue.sort((left, right) => left.player.id - right.player.id);
    advanceMine(mine, simEnd, queue, advanceContext);
    for (const event of queue) releaseArmedPosition(mine, event.player, advanceContext);
  }
  for (const mine of mines) {
    for (const player of players) {
      // Parked against the index owner, which is the mine that released the tokens.
      if (player.position.mineId === mine.spec.key) settleAndPark(player, mine, riskOps, options);
    }
  }

  // --- per-mine summary and the reserve audit
  const minesSummary: MineSummary[] = mines.map((mine) => {
    const positions = players
      // Every position whose index cursor lives in this mine, whether or not the player has since
      // pointed somewhere else: the mine that released a token is the mine that accounts for it.
      // Filtering on the player's current mine is what used to leave an audit residual behind.
      .filter((player) => player.position.mineId === mine.spec.key)
      .map((player) => player.position);
    const audited = auditReserve(
      mine.core,
      mine.initialReserve,
      positions,
      BigInt(Math.round(mine.paidTokens + mine.heldTokens)),
      config,
    );
    const discoveryTokens = mine.discoveryHumanTokens + mine.discoveryBotTokens;
    return {
      mineKey: mine.spec.key,
      symbol: mine.spec.symbol,
      initialReserve: Number(mine.initialReserve),
      rewardPerBlock: mine.spec.rewardPerBlock,
      lifetimeDays: mine.spec.lifetimeDays,
      rewardPerBlockAtEnd: Number(mine.rewardPerBlock),
      fullyMinedDay:
        mine.fullyMinedAt === null ? null : Math.floor((mine.fullyMinedAt - options.startTime) / DAY) + 1,
      reserveRemainingEnd: Number(mine.core.reserveRemaining),
      reserveDrainedBps: bps(
        Number(mine.initialReserve - mine.core.reserveRemaining),
        Number(mine.initialReserve),
      ),
      distributedCum: Number(mine.distributed),
      humanTokensCum: mine.humanTokens,
      botTokensCum: mine.botTokens,
      botMiningShareBps: bps(mine.botTokens, mine.humanTokens + mine.botTokens),
      humanPaidTokens: mine.humanPaidTokens,
      botPaidTokens: mine.botPaidTokens,
      humanHeldTokens: mine.humanHeldTokens,
      botHeldTokens: mine.botHeldTokens,
      botReleasedShareBps: bps(mine.botPaidTokens, mine.humanPaidTokens + mine.botPaidTokens),
      discoveryTotalTokens: discoveryTokens,
      discoveryTotalUsd: mine.discoveryUsd,
      discoveryHumanTokens: mine.discoveryHumanTokens,
      discoveryBotTokens: mine.discoveryBotTokens,
      discoveryBotShareBps: bps(mine.discoveryBotTokens, discoveryTokens),
      discoveryHumanReleasedTokens: mine.discoveryHumanTokens - mine.discoveryHumanHeldTokens,
      discoveryBotReleasedTokens: mine.discoveryBotTokens - mine.discoveryBotHeldTokens,
      discoveryBotReleasedShareBps: bps(
        mine.discoveryBotTokens - mine.discoveryBotHeldTokens,
        discoveryTokens - mine.discoveryHumanHeldTokens - mine.discoveryBotHeldTokens,
      ),
      discoveryHeldTokens: mine.discoveryHumanHeldTokens + mine.discoveryBotHeldTokens,
      discoveryRemaining: mine.discoveryReserveRemaining,
      discoveryReserveUsedBps: bps(
        mine.discoveryReserveTotal - mine.discoveryReserveRemaining,
        mine.discoveryReserveTotal,
      ),
      audit: {
        claimed: Number(audited.claimed),
        dust: Number(audited.dustTokens),
        outstanding: Number(audited.outstandingScaled / BigInt(config.economy.rewardIndexScale)),
        remaining: Number(audited.remaining),
        initial: Number(audited.initialReserve),
        forfeited: Number(audited.forfeited),
        released: Number(audited.released),
        drained: Number(audited.drained),
        unattributed: Number(audited.unattributedScaled / BigInt(config.economy.rewardIndexScale)),
        settled: mine.settledTotal,
        capped: Number(mine.core.released),
        dustScaledRaw: mine.core.dustScaled.toString(),
        conserved: audited.conserved,
        indexBalanced: audited.indexBalanced,
        reserveBalanced: audited.reserveBalanced,
      },
      auditConserved: audited.conserved,
      events: {
        arm: mine.eventCounts.arm,
        expire: mine.eventCounts.expire,
        power: mine.eventCounts.power,
        settlements: mine.settlementCount,
      },
      forfeitSettles: mine.forfeitSettles,
    };
  });

  const networkDistributed = minesSummary.reduce((total, mine) => total + mine.distributedCum, 0);
  const networkHumanTokens = minesSummary.reduce((total, mine) => total + mine.humanTokensCum, 0);
  const networkBotTokens = minesSummary.reduce((total, mine) => total + mine.botTokensCum, 0);
  const networkReleasedTokens = minesSummary.reduce((total, mine) => total + mine.humanPaidTokens + mine.botPaidTokens, 0);
  const networkHumanReleased = minesSummary.reduce((total, mine) => total + mine.humanPaidTokens, 0);
  const networkBotReleased = minesSummary.reduce((total, mine) => total + mine.botPaidTokens, 0);
  const networkHeldTokens = minesSummary.reduce((total, mine) => total + mine.humanHeldTokens + mine.botHeldTokens, 0);
  const networkDiscoveryUsd = minesSummary.reduce((total, mine) => total + mine.discoveryTotalUsd, 0);
  const networkDiscoveryBotTokens = minesSummary.reduce((total, mine) => total + mine.discoveryBotTokens, 0);
  const networkDiscoveryTokens = minesSummary.reduce((total, mine) => total + mine.discoveryTotalTokens, 0);

  const retainedHumans = humans.filter((player) => !player.churned);
  const balanceP50 = (group: readonly SimPlayer[]): number =>
    percentile(group.map((player) => player.oreBalance).sort((a, b) => a - b), 0.5);
  const earnedP50 = (group: readonly SimPlayer[]): number =>
    percentile(group.map((player) => player.oreEarned).sort((a, b) => a - b), 0.5);
  const powerP50 = (group: readonly SimPlayer[]): number =>
    percentile(group.map((player) => Number(player.power)).sort((a, b) => a - b), 0.5);
  const humanOreP50 = balanceP50(retainedHumans);
  const botOreP50 = balanceP50(bots);
  const humanEarnedP50 = earnedP50(retainedHumans);
  const botEarnedP50 = earnedP50(bots);
  const day1Vintage = humans.filter((player) => player.createdDay === 1);
  // The veteran line the report quotes is the *retained* day-1 cohort at the end of the run: a median
  // over every day-1 wallet also measures the ones that churned in week one, which drags the ratio
  // down to a number no active player ever experiences.
  const veteranRow = [...powerRows].reverse().find((row) => row.vintage === "day1");
  const veteranP50 = veteranRow?.powerP50 ?? powerP50(day1Vintage);
  const day1Row = powerRows.find((row) => row.day === 1 && row.vintage === "day1");
  const day7Row = powerRows.find((row) => row.day === 7 && row.vintage === "day1");
  const day7EntrantRow = powerRows.find((row) => row.day === 14 && row.vintage === "day7");
  const starterPower = crewPower(config.crew.starterLevels, config);
  const day1P50 = day1Row?.powerP50 ?? starterPower;
  const day7P50 = day7Row?.powerP50 ?? 0;
  const oreEarnedTotal = players.reduce((total, player) => total + player.oreEarned, 0);
  const oreHeldTotal = players.reduce((total, player) => total + player.oreBalance, 0);
  const oreOverflowTotal = players.reduce((total, player) => total + player.oreOverflow, 0);
  const oreSpentTotal = players.reduce((total, player) => total + player.oreSpent, 0);
  const oreLedgerClosed = Math.abs(oreEarnedTotal - (oreHeldTotal + oreOverflowTotal + oreSpentTotal)) < 1e-6;

  const summary: SummaryStats = {
    scenario: scenarioKey,
    seed: options.seed,
    days: options.days,
    humans: options.humans,
    bots: options.botFarmSizes.reduce((total, size) => total + size, 0),
    botStealth: options.botStealth,
    note: options.note,
    humanActivationRate:
      humans.length > 0
        ? humans.reduce((total, player) => total + player.activeDays, 0) /
          humans.reduce((total, player) => total + Math.max(1, options.days - player.createdDay + 1), 0)
        : 0,
    humansRetainedEnd: retainedHumans.length,
    mines: minesSummary,
    networkDistributedCum: networkDistributed,
    networkBotMiningShareBps: bps(networkBotTokens, networkHumanTokens + networkBotTokens),
    networkBotReleasedShareBps: bps(networkBotReleased, networkHumanReleased + networkBotReleased),
    networkReleasedTokens,
    networkHeldTokens,
    networkDiscoveryUsd,
    networkDiscoveryBotShareBps: bps(networkDiscoveryBotTokens, networkDiscoveryTokens),
    oreP50End: { human: humanOreP50, bot: botOreP50 },
    oreEarnedP50End: { human: humanEarnedP50, bot: botEarnedP50 },
    oreBotVsHumanRatio: humanEarnedP50 > 0 ? botEarnedP50 / humanEarnedP50 : 0,
    powerRatios: {
      starterPower,
      day1P50,
      day7P50,
      veteranP50,
      veteranEffectiveP50: veteranRow?.effectivePowerP50 ?? 0,
      lateEntrantDay7At14P50: day7EntrantRow?.powerP50 ?? 0,
      veteranVsDay1: day1P50 > 0 ? veteranP50 / day1P50 : 0,
      veteranVsDay7: day7P50 > 0 ? veteranP50 / day7P50 : 0,
      theoreticalMaxRatio: maxCrewPowerRatio(config),
      onChainMaxCrewPower: DEFAULT_MAX_CREW_POWER,
    },
    capDenials: Object.fromEntries([...capDenials.entries()].sort()),
    discoveryMisses: misses.count,
    strandedTokens: players.reduce((total, player) => total + Number(player.position.pendingReward), 0),
    oreLedger: {
      earned: oreEarnedTotal,
      heldByPlayers: oreHeldTotal,
      overflow: oreOverflowTotal,
      spentOnCrew: oreSpentTotal,
    },
    invariants: {
      reservesConserved: minesSummary.every((mine) => mine.auditConserved),
      discoveryDebitsMatch: mines.every(
        (mine) =>
          Math.abs(
            mine.discoveryReserveTotal -
              mine.discoveryReserveRemaining -
              mine.discoveryHumanTokens -
              mine.discoveryBotTokens,
          ) < 1e-6,
      ),
      oreLedgerClosed,
      capViolations: violations.count,
      determinismDigest: digest([
        scenarioKey,
        networkDistributed,
        networkBotTokens,
        networkDiscoveryTokens,
        Math.round(players.reduce((total, player) => total + player.oreEarned, 0)),
        Number(mines.reduce((total, mine) => total + mine.core.reserveRemaining, 0n)),
      ]),
    },
  };

  return {
    options,
    mines: mineRows,
    daily: dailyRows,
    discovery: discoveryRows,
    cohorts: cohortRows,
    powers: powerRows,
    risk: riskRows,
    summary,
  };
}

/** Churn draw, kept local so the engine owns the day loop's randomness in one place. */
function drawChurn(seed: number, id: number, day: number): number {
  return unitFromInts(seed, 13, id, day);
}
