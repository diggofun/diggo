/**
 * Self-checks for the simulation harness. They exist to keep the harness honest: the reserve runway is
 * cross-checked against an independently written block schedule, the reserve ledger is cross-checked
 * with shared/rewardIndex.ts auditReserve and its released/forfeited identity, the whole-reserve
 * guarantee is proved across launch parameters, the discovery caps are cross-checked from the emitted
 * rows, and the harness RNG is compared against the real shared/random.ts HMAC source.
 */
import { createDiggoConfig } from "../../shared/config";
import { createHmacRandomSource } from "../../shared/random";
import { type RiskOpsConfig } from "../../shared/riskOps";
import { DAY } from "./state";
import { DEFAULT_MINES, DEFAULT_SIM_OPTIONS, type MineSpec, type SimOptions } from "./model";
import { runScenario, type SimResult } from "./engine";
import { unitFromInts } from "./rng";

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface RunwayInput {
  initialReserve: number;
  launchRewardPerBlock: number;
  blockIntervalSeconds: number;
  epochLengthSeconds: number;
  secondsPerDay: number;
  schedule: "reserve_runway" | "epoch_reduction";
  targetLifetimeDays: number;
  reductionBps: number;
  minimumReducedReward: number;
  minimumRewardPerBlock: number;
  nonIncreasing: boolean;
  startTime: number;
  maxDays: number;
}

export interface RunwayResult {
  fullyMinedDay: number | null;
  distributed: number;
  remaining: number;
  rewardAtEpoch0: number;
  remainingAtDay: Map<number, number>;
}

/**
 * The reserve runway computed independently of the engine: the same rules written out again as a
 * plain block loop (reduction at each epoch boundary, block reward capped at the remaining reserve,
 * a floor that keeps paying, and the pre-hardening geometric step when the schedule asks for it).
 * Deliberately not imported from the engine, and deliberately not imported from shared/rewardIndex.ts
 * either: this is the second opinion, not a copy.
 */
export function analyticRunway(input: RunwayInput): RunwayResult {
  const blocksPerEpoch = Math.max(1, Math.floor(input.epochLengthSeconds / input.blockIntervalSeconds));
  const totalEpochs = Math.max(
    1,
    Math.ceil((input.targetLifetimeDays * input.secondsPerDay) / input.epochLengthSeconds),
  );
  const nextReward = (epoch: number, previous: number, remaining: number): number => {
    if (input.schedule === "epoch_reduction") {
      const reduction = Math.floor((previous * input.reductionBps) / 10_000);
      return Math.min(previous, Math.max(input.minimumReducedReward, previous - reduction));
    }
    // The remaining reserve paid out over the blocks left of the lifetime, floored, never raised.
    const epochsLeft = Math.max(1, totalEpochs - epoch);
    // Rounded up, exactly like the rule under test: an epoch can always finish the reserve it holds.
    const budget = Math.ceil(remaining / (blocksPerEpoch * epochsLeft));
    let scheduled = Math.max(input.minimumRewardPerBlock, budget);
    if (input.nonIncreasing && scheduled > previous) scheduled = previous;
    return scheduled;
  };

  let remaining = input.initialReserve;
  let reward = input.launchRewardPerBlock;
  const rewardAtEpoch0 = reward;
  let cursor = input.startTime - input.blockIntervalSeconds;
  let epochEndsAt = input.startTime + input.epochLengthSeconds;
  let epoch = 0;
  let distributed = 0;
  let fullyMinedDay: number | null = null;
  const remainingAtDay = new Map<number, number>();
  while (remaining > 0) {
    const blockTime = cursor + input.blockIntervalSeconds;
    while (blockTime >= epochEndsAt) {
      epoch += 1;
      epochEndsAt += input.epochLengthSeconds;
      reward = nextReward(epoch, reward, remaining);
    }
    const capped = Math.min(reward, remaining);
    remaining -= capped;
    distributed += capped;
    cursor = blockTime;
    const day = Math.floor((blockTime - input.startTime) / DAY) + 1;
    remainingAtDay.set(day, remaining);
    if (remaining <= 0) {
      fullyMinedDay = day;
      break;
    }
    if (day > input.maxDays) break;
  }
  return { fullyMinedDay, distributed, remaining, rewardAtEpoch0, remainingAtDay };
}

export function analyticFor(options: SimOptions, mine: MineSpec, maxDays = 10_000): RunwayResult {
  const emission = options.config.economy.emission;
  return analyticRunway({
    initialReserve: Math.floor((mine.totalSupply * mine.reserveBps) / 10_000),
    launchRewardPerBlock: mine.rewardPerBlock,
    blockIntervalSeconds: options.blockIntervalSeconds,
    epochLengthSeconds: options.epochLengthSeconds,
    secondsPerDay: options.config.time.secondsPerDay,
    schedule: emission.schedule,
    targetLifetimeDays: mine.lifetimeDays,
    reductionBps: options.config.economy.rewardReductionBps,
    minimumReducedReward: options.config.economy.minimumReducedReward,
    minimumRewardPerBlock: emission.minimumRewardPerBlock,
    nonIncreasing: emission.nonIncreasing,
    startTime: options.startTime + (mine.launchDay - 1) * DAY,
    maxDays,
  });
}

export interface RunwayCase {
  label: string;
  reserve: number;
  launchRewardPerBlock: number;
  targetLifetimeDays: number;
}

/**
 * The launch parameters the whole-reserve guarantee is proved across: a flagship reserve with launch
 * rewards from far below to far above the runway budget (the old schedule could only ever distribute
 * 8,064 x reward of a reserve, which is what locked tokens below 6,201 per block), a small long-tail
 * reserve, and a two-year lift-off.
 */
export function runwayCases(): RunwayCase[] {
  return [
    { label: "flagship 1,200/block, 12 months", reserve: 50_000_000, launchRewardPerBlock: 1_200, targetLifetimeDays: 365 },
    { label: "flagship 1,900/block, 12 months", reserve: 50_000_000, launchRewardPerBlock: 1_900, targetLifetimeDays: 365 },
    { label: "flagship 3,000/block, 12 months", reserve: 50_000_000, launchRewardPerBlock: 3_000, targetLifetimeDays: 365 },
    { label: "flagship 7,500/block, 12 months", reserve: 50_000_000, launchRewardPerBlock: 7_500, targetLifetimeDays: 365 },
    { label: "long tail 300/block, 90 days", reserve: 3_000_000, launchRewardPerBlock: 300, targetLifetimeDays: 90 },
    { label: "large lift-off 40,000/block, 24 months", reserve: 200_000_000, launchRewardPerBlock: 40_000, targetLifetimeDays: 730 },
  ];
}

export interface RunwayProofRow extends RunwayCase {
  rewardAtEpoch0: number;
  fullyMinedDay: number | null;
  distributed: number;
  shareOfReserve: number;
  targetDays: number;
}

/** The whole-reserve proof the report quotes, so the doc and the sim cannot disagree. */
export function runwayProof(options: SimOptions = DEFAULT_SIM_OPTIONS): RunwayProofRow[] {
  const emission = options.config.economy.emission;
  return runwayCases().map((entry) => {
    const result = analyticRunway({
      initialReserve: entry.reserve,
      launchRewardPerBlock: entry.launchRewardPerBlock,
      blockIntervalSeconds: options.blockIntervalSeconds,
      epochLengthSeconds: options.epochLengthSeconds,
      secondsPerDay: options.config.time.secondsPerDay,
      schedule: emission.schedule,
      targetLifetimeDays: entry.targetLifetimeDays,
      reductionBps: options.config.economy.rewardReductionBps,
      minimumReducedReward: options.config.economy.minimumReducedReward,
      minimumRewardPerBlock: emission.minimumRewardPerBlock,
      nonIncreasing: emission.nonIncreasing,
      startTime: options.startTime,
      maxDays: 5_000,
    });
    return {
      ...entry,
      rewardAtEpoch0: result.rewardAtEpoch0,
      fullyMinedDay: result.fullyMinedDay,
      distributed: result.distributed,
      shareOfReserve: entry.reserve > 0 ? result.distributed / entry.reserve : 0,
      targetDays: entry.targetLifetimeDays,
    };
  });
}

/** The same proof against the pre-hardening schedule, for the report's BEFORE column. */
export function legacyRunwayProof(): Array<{ label: string; fullyMinedDay: number | null; shareOfReserve: number }> {
  return runwayCases().map((entry) => {
    const result = analyticRunway({
      initialReserve: entry.reserve,
      launchRewardPerBlock: entry.launchRewardPerBlock,
      blockIntervalSeconds: DEFAULT_SIM_OPTIONS.blockIntervalSeconds,
      epochLengthSeconds: DEFAULT_SIM_OPTIONS.epochLengthSeconds,
      secondsPerDay: DEFAULT_SIM_OPTIONS.config.time.secondsPerDay,
      schedule: "epoch_reduction",
      targetLifetimeDays: entry.targetLifetimeDays,
      reductionBps: DEFAULT_SIM_OPTIONS.config.economy.rewardReductionBps,
      minimumReducedReward: DEFAULT_SIM_OPTIONS.config.economy.minimumReducedReward,
      minimumRewardPerBlock: DEFAULT_SIM_OPTIONS.config.economy.minimumReducedReward,
      nonIncreasing: true,
      startTime: DEFAULT_SIM_OPTIONS.startTime,
      maxDays: 5_000,
    });
    return {
      label: entry.label,
      fullyMinedDay: result.fullyMinedDay,
      shareOfReserve: entry.reserve > 0 ? result.distributed / entry.reserve : 0,
    };
  });
}

function smallOptions(overrides: Partial<SimOptions> = {}): SimOptions {
  return {
    ...DEFAULT_SIM_OPTIONS,
    seed: 424_242,
    days: 30,
    humans: 0,
    botFarmSizes: [100],
    botStealth: "naive",
    mines: DEFAULT_MINES.filter((mine) => mine.key === "flagship"),
    config: createDiggoConfig(),
    ...overrides,
  };
}

async function checkDeterminism(options: SimOptions, riskOps: RiskOpsConfig): Promise<CheckResult> {
  const first = runScenario("determinism-a", options, riskOps).summary.invariants.determinismDigest;
  const second = runScenario("determinism-a", options, riskOps).summary.invariants.determinismDigest;
  const reversed = runScenario("determinism-a", { ...options, playerOrder: "reverse" }, riskOps).summary
    .invariants.determinismDigest;
  return {
    name: "determinism and order independence",
    ok: first === second && first === reversed,
    detail: `same seed: ${first === second ? "identical" : "DIFFERENT"}; reversed population order: ${
      first === reversed ? "identical" : "DIFFERENT"
    } (${first})`,
  };
}

function checkBlockSchedule(options: SimOptions, riskOps: RiskOpsConfig): CheckResult {
  const result = runScenario("selfcheck-blocks", options, riskOps);
  const mine = options.mines[0];
  const analytic = analyticFor(options, mine, options.days);
  const simulated = result.summary.mines[0];
  const reserveMatches = Math.abs(simulated.reserveRemainingEnd - analytic.remaining) < 1;
  const dayMatches = (simulated.fullyMinedDay ?? null) === (analytic.fullyMinedDay ?? null);
  return {
    name: "block schedule vs independent runway model",
    ok: reserveMatches && dayMatches,
    detail: `over ${options.days} days: simulated FULLY_MINED day ${
      simulated.fullyMinedDay ?? "never"
    }, reserve ${simulated.reserveRemainingEnd}; independent model day ${
      analytic.fullyMinedDay ?? "never"
    }, reserve ${analytic.remaining}`,
  };
}

/**
 * The point of the emission redesign: the whole Mining Reserve is distributable whatever the launch
 * parameters are. Below 6,201 per block the old schedule could never empty a 50M reserve, so a mine
 * could sit on locked tokens forever; every case here has to reach zero.
 */
function checkEmissionSchedulable(): CheckResult {
  const rows = runwayProof();
  const epochDays = DEFAULT_SIM_OPTIONS.epochLengthSeconds / DEFAULT_SIM_OPTIONS.config.time.secondsPerDay;
  // The schedule counts in whole epochs, so the honest bound is the target lifetime rounded up to
  // one - a 365-day target with 7-day epochs finishes on day 371.
  const horizon = (targetDays: number): number => Math.ceil(targetDays / epochDays) * epochDays + 2;
  const failing = rows.filter(
    (row) =>
      row.fullyMinedDay === null ||
      row.shareOfReserve < 0.999_999 ||
      row.fullyMinedDay > horizon(row.targetDays),
  );
  const legacy = legacyRunwayProof().filter((row) => (row.fullyMinedDay ?? Number.POSITIVE_INFINITY) > 1_000);
  return {
    name: "the whole Mining Reserve is distributable",
    ok: failing.length === 0,
    detail:
      failing.length === 0
        ? `all ${rows.length} launch parameter sets reach FULLY_MINED within their target lifetime: ${rows
            .map((row) => `${row.launchRewardPerBlock}/block -> day ${row.fullyMinedDay} of ${horizon(row.targetDays)}`)
            .join(", ")} (the old schedule never empties ${legacy.length} of them)`
        : failing
            .map(
              (row) =>
                `${row.label}: mined out ${row.fullyMinedDay ?? "never"}, distributed ${(
                  row.shareOfReserve * 100
                ).toFixed(1)}% of the reserve`,
            )
            .join("; "),
  };
}

function checkConservation(result: SimResult): CheckResult {
  const failing = result.summary.mines.filter((mine) => !mine.auditConserved);
  const misattributed = result.summary.mines.filter(
    (mine) => Math.abs(mine.humanTokensCum + mine.botTokensCum - mine.audit.settled) > 1,
  );
  const unattributed = result.summary.mines.filter((mine) => mine.audit.unattributed !== 0);
  return {
    name: "mining reserve conservation (shared/rewardIndex.ts auditReserve)",
    ok: failing.length === 0 && misattributed.length === 0 && unattributed.length === 0,
    detail:
      failing.length === 0 && misattributed.length === 0 && unattributed.length === 0
        ? `all ${result.summary.mines.length} mines balance exactly: released - forfeited == initial - remaining, released == claimed + forfeited + outstanding + dust, nothing unattributed, and every settled token is attributed to a cohort`
        : misattributed.length > 0
          ? `cohort attribution off on ${misattributed.map((mine) => mine.mineKey).join(", ")}`
          : failing
              .map(
                (mine) =>
                  `${mine.mineKey}: released ${mine.audit.released} - forfeited ${mine.audit.forfeited} != initial ${mine.audit.initial} - remaining ${mine.audit.remaining}; claimed ${mine.audit.claimed} + dust ${mine.audit.dust} + outstanding ${mine.audit.outstanding} + unattributed ${mine.audit.unattributed} (settled ${mine.audit.settled}, reserveBalanced ${mine.audit.reserveBalanced}, indexBalanced ${mine.audit.indexBalanced}, dustScaled ${mine.audit.dustScaledRaw}, forfeit settles ${mine.forfeitSettles.arm}a/${mine.forfeitSettles.power}p/${mine.forfeitSettles.expire}e)`,
              )
              .join("; "),
  };
}

function checkCaps(result: SimResult): CheckResult {
  const config = result.options.config;
  const problems: string[] = [];
  const byMine = new Map<string, { day: number; usd: number }[]>();
  for (const row of result.discovery) {
    const list = byMine.get(row.mineKey) ?? [];
    list.push({ day: row.day, usd: row.usd });
    byMine.set(row.mineKey, list);
  }
  for (const [mineKey, rows] of byMine) {
    for (const row of rows) {
      if (row.usd > config.discovery.tokenDailyCapUsd + 1e-6) {
        problems.push(`${mineKey} day ${row.day}: ${row.usd} over the token daily cap`);
      }
      const week = rows
        .filter((entry) => entry.day <= row.day && entry.day > row.day - 7)
        .reduce((total, entry) => total + entry.usd, 0);
      if (week > config.discovery.tokenPeriodCapUsd + 1e-6) {
        problems.push(`${mineKey} day ${row.day}: ${week.toFixed(2)} over the token weekly cap`);
      }
    }
  }
  const perDay = new Map<number, number>();
  for (const row of result.discovery) perDay.set(row.day, (perDay.get(row.day) ?? 0) + row.usd);
  for (const [day, usd] of perDay) {
    if (usd > config.discovery.globalDailyCapUsd + 1e-6) {
      problems.push(`day ${day}: ${usd} over the global daily cap`);
    }
  }
  if (result.summary.invariants.capViolations > 0) {
    problems.push(`${result.summary.invariants.capViolations} payouts exceeded the per-request cap`);
  }
  return {
    name: "discovery caps hold end to end",
    ok: problems.length === 0,
    detail:
      problems.length === 0
        ? "token daily/period, global daily and per-request caps never exceeded"
        : problems.slice(0, 3).join("; "),
  };
}

function checkOreSources(result: SimResult): CheckResult {
  // No ORE appears out of nowhere and none disappears: everything ever granted through
  // shared/ore.ts is either still in a player's storage, sitting in tracked overflow, or spent on a
  // crew upgrade (shared/crew.ts upgradeOreCost).
  const ledger = result.summary.oreLedger;
  const closed = result.summary.invariants.oreLedgerClosed;
  return {
    name: "ORE accounting is closed (earned == held + overflow + spent)",
    ok: closed,
    detail: `earned ${Math.round(ledger.earned)}, held ${Math.round(ledger.heldByPlayers)}, overflow ${Math.round(
      ledger.overflow,
    )}, spent ${Math.round(ledger.spentOnCrew)}`,
  };
}

async function checkRandomSource(): Promise<CheckResult> {
  const source = createHmacRandomSource();
  const draws = 3_000;
  const hmac: number[] = [];
  for (let index = 0; index < draws; index += 1) {
    hmac.push(
      await source.roll({
        serverSecret: "sim-selfcheck-secret",
        eventId: "roll:" + index,
        accountId: "wallet:" + index,
        window: index,
      }),
    );
  }
  const harness: number[] = [];
  for (let index = 0; index < draws; index += 1) harness.push(unitFromInts(20_260_922, 99, index, 7, 1));
  const average = (values: readonly number[]) => values.reduce((total, value) => total + value, 0) / values.length;
  const buckets = (values: readonly number[]): number[] => {
    const counts = new Array<number>(10).fill(0);
    for (const value of values) counts[Math.min(9, Math.floor(value * 10))] += 1;
    return counts;
  };
  const expected = draws / 10;
  const chiSquare = (counts: readonly number[]): number =>
    counts.reduce((total, count) => total + ((count - expected) ** 2) / expected, 0);
  const hmacAverage = average(hmac);
  const harnessAverage = average(harness);
  const hmacChi = chiSquare(buckets(hmac));
  const harnessChi = chiSquare(buckets(harness));
  const threshold = 27.88; // chi-square, 9 degrees of freedom, p = 0.001
  const ok =
    Math.abs(hmacAverage - 0.5) < 0.03 &&
    Math.abs(harnessAverage - 0.5) < 0.03 &&
    hmacChi < threshold &&
    harnessChi < threshold;
  return {
    name: "harness RNG matches shared/random.ts distribution",
    ok,
    detail: `HMAC mean ${hmacAverage.toFixed(4)} chi2 ${hmacChi.toFixed(1)}; harness mean ${harnessAverage.toFixed(
      4,
    )} chi2 ${harnessChi.toFixed(1)} (threshold ${threshold})`,
  };
}

export async function runSelfChecks(
  reference: SimResult,
  riskOps: RiskOpsConfig,
): Promise<CheckResult[]> {
  const options = smallOptions();
  return [
    await checkDeterminism(options, riskOps),
    checkBlockSchedule(options, riskOps),
    checkEmissionSchedulable(),
    checkConservation(reference),
    checkCaps(reference),
    checkOreSources(reference),
    await checkRandomSource(),
  ];
}
