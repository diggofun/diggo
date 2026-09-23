/**
 * Shared simulation state and small numerics for the economy harness.
 *
 * No game rule lives here: MINING/ORE/streak/reward-index/discovery/risk behaviour is always
 * imported from `shared/`. This module only describes the simulated world (who is playing, what a
 * mine looks like at runtime) and the statistics the report is built from.
 */
import type { CrewLevels, RewardState } from "../../shared/config";
import type { MiningPosition, RewardIndexState } from "../../shared/rewardIndex";
import type { ActivationRecord } from "../../shared/streak";
import type { RiskSignals } from "../../shared/risk";
import type { PriceSample, RobustPrice } from "../../shared/rarity";
import { unitFromInts } from "./rng";
import type { Cohort, HumanHabitClass, MineSpec, SimOptions } from "./model";

export const DAY = 86_400;
export const HOUR = 3_600;
/** Blocks per day at the nominal 300s interval, used only for the credited-block counter. */
export const BLOCKS_PER_DAY = 288;
export const RISK_SAMPLE_WINDOW = 12;
/** On-chain ceiling on Crew Power (lib.rs DEFAULT_MAX_CREW_POWER), a documented constant. */
export const DEFAULT_MAX_CREW_POWER = 50_000;

/** Draw lanes: one wallet's draws for different purposes can never collide. */
export const LANE = {
  arrival: 1,
  activeDay: 2,
  visitSlot: 3,
  visitJitter: 4,
  discoveryWindow: 5,
  discoveryTarget: 6,
  discoveryRarity: 7,
  habit: 8,
  anchor: 9,
  drift: 10,
  dormant: 11,
  target: 12,
  churn: 13,
  upgrade: 14,
  price: 15,
} as const;

export function draw(seed: number, lane: number, a: number, b: number, c = 0): number {
  return unitFromInts(seed, lane, a, b, c);
}

export interface MineRuntime {
  spec: MineSpec;
  initialReserve: bigint;
  core: RewardIndexState;
  rewardPerBlock: bigint;
  epoch: number;
  epochEndsAt: number;
  cursor: number;
  power: bigint;
  powerHumans: bigint;
  powerBots: bigint;
  status: "MINING_ACTIVE" | "FULLY_MINED";
  distributed: bigint;
  /** Total block budget taken out of the reserve so far (shared/rewardIndex.ts BlockOutcome.capped). */
  cappedTotal: bigint;
  forfeited: bigint;
  fullyMinedAt: number | null;
  distributedToday: number;
  settledToday: number;
  settledTotal: number;
  humanTokens: number;
  botTokens: number;
  discoveryReserveTotal: number;
  discoveryReserveRemaining: number;
  discoveryEpochBudget: number;
  discoveryEpochSpent: number;
  discoveryEpochEndsAt: number;
  discoverySpent: number;
  discoverySpentToday: number;
  discoveryUsd: number;
  discoveryHumanUsd: number;
  discoveryBotUsd: number;
  discoveryHumanTokens: number;
  discoveryBotTokens: number;
  /** Discovery wins parked by a reward hold: committed against the reserve, not received (53). */
  discoveryHumanHeldTokens: number;
  discoveryBotHeldTokens: number;
  discoveryHitsToday: number;
  discoveryHumanHitsToday: number;
  discoveryBotHitsToday: number;
  discoveryTokensToday: number;
  discoveryHumanTokensToday: number;
  discoveryBotTokensToday: number;
  discoveryUsdToday: number;
  tokenUsdByDay: Map<number, number>;
  paidTokens: number;
  heldTokens: number;
  /** Released tokens, split by cohort: what a farm actually walked away with (spec 53, 64). */
  humanPaidTokens: number;
  botPaidTokens: number;
  /** Tokens parked by a reward hold, split by cohort. Reversible, so never counted as captured. */
  humanHeldTokens: number;
  botHeldTokens: number;
  /** Diagnostics: applied events of each kind, and how often a position was settled. */
  eventCounts: { arm: number; expire: number; power: number };
  /** Diagnostics: settles that took the forfeit path, split by the event that caused them. */
  forfeitSettles: { arm: number; expire: number; power: number };
  settlementCount: number;
  price: RobustPrice;
  denialsToday: Map<string, number>;
}

export interface FarmRuntime {
  id: number;
  size: number;
  stealth: SimOptions["botStealth"];
  walletsPerDevice: number;
  walletsPerNetwork: number;
  creationBatchSize: number;
  burstActionsPerMinute: number;
  claimBurstPerMinute: number;
  synchronyFraction: number;
  switchingSimilarity: number;
}

export interface SimPlayer {
  id: number;
  cohort: Cohort;
  farmId: number;
  habit: HumanHabitClass | null;
  createdDay: number;
  createdTime: number;
  churned: boolean;
  activation: ActivationRecord;
  oreBalance: number;
  oreOverflow: number;
  oreEarned: number;
  oreSpent: number;
  levels: CrewLevels;
  power: bigint;
  position: MiningPosition;
  positionMine: string | null;
  armedUntil: number | null;
  armedMine: string | null;
  /**
   * Which mine's running power currently includes this player, and how much. Written only when an
   * event is *applied* (never when it is planned), so a plan that is overtaken by a switch cannot
   * leave the aggregate disagreeing with the positions it is paying.
   */
  powerMine: string | null;
  powerArmed: bigint;
  /** Settled-but-unclaimed tokens live on the position: one ledger, audited by shared/rewardIndex. */
  claimedTokens: number;
  /**
   * Device and network cluster sizes this wallet sits in (spec 61). One wallet per device for the
   * harness's humans; a scripted farm is one flat cluster, which is what its signals say too.
   */
  deviceCluster: number;
  networkCluster: number;
  minedTokens: number;
  discoveryTokens: number;
  discoveryUsd: number;
  discoveryHits: number;
  activeMine: string | null;
  oreCollectedAt: number;
  activeDays: number;
  validActivations: number;
  validClaims: number;
  riskScore: number;
  computedState: RewardState;
  rewardState: RewardState;
  trust: number;
  signals: RiskSignals;
  intervals: number[];
  blocksCredited: number;
  achievements: Set<string>;
  accountUsdByDay: Map<number, number>;
  anchorHour: number;
  dormantToday: boolean;
  lastOverflow: number;
  upgradeEagerness: number;
  creationClusterWindow: number;
  peakActionsPerMinuteToday: number;
  claimsInWindow: number;
}

export interface DayEvent {
  time: number;
  kind: "arm" | "expire" | "power";
  mineKey: string;
  power: bigint;
  windowEnd: number;
  player: SimPlayer;
}

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

export function stdev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  let total = 0;
  for (const value of values) total += (value - average) ** 2;
  return Math.sqrt(total / (values.length - 1));
}

export function bps(part: number, whole: number): number {
  if (!(whole > 0)) return 0;
  return Math.round((part / whole) * 10_000);
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function sumDays(map: Map<number, number> | undefined, fromDay: number, toDay: number): number {
  if (!map) return 0;
  let total = 0;
  for (let day = fromDay; day <= toDay; day += 1) total += map.get(day) ?? 0;
  return total;
}

export function vintageOf(player: SimPlayer): string {
  if (player.cohort === "bot") return "bot";
  const day = player.createdDay;
  if (day <= 1) return "day1";
  if (day === 7) return "day7";
  if (day <= 6) return "day2-6";
  if (day <= 30) return "day8-30";
  return "day31+";
}

/**
 * A short internal price series around a token's spot price. Production builds this from
 * token_price_samples in D1 and passes it through robustPrice (worker/discovery.ts); here the
 * series is synthesized from the mine's launch parameters with a tiny deterministic wobble, so
 * the confidence gate and value normalization behave exactly as in production.
 */
export function priceSamplesFor(mine: MineSpec, seed: number, now: number): PriceSample[] {
  const samples: PriceSample[] = [];
  for (let index = 0; index < 4; index += 1) {
    const wobble = (draw(seed, LANE.price, mine.launchDay, index, 1) - 0.5) * 0.004;
    samples.push({
      priceUsd: mine.priceUsd * (1 + wobble),
      timestamp: now - index * 600,
      volumeUsd: mine.volume24hUsd / 24,
    });
  }
  return samples;
}
