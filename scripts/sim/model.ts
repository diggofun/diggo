/**
 * Inputs of the economy simulation: who plays, which mines exist, and which knobs are being tested.
 *
 * Everything that is a *game rule* comes from shared/config.ts (DIGGO_CONFIG / createDiggoConfig) or
 * from shared/{crew,ore,streak,rewardIndex,discovery,risk,rarity}.ts. This file only describes the
 * world the rules are applied to: a population with habits, and mines with launch parameters.
 */
import { createDiggoConfig, type DeepPartial, type DiggoConfig } from "../../shared/config";
import type { TokenHealthFlags } from "../../shared/rarity";

export type Cohort = "human" | "bot";
export type BotStealth = "naive" | "stealthy";

/**
 * A human behaviour class. Real players differ mainly in how many days per week they come back and
 * how long they stay. `sessionsPerDay` is how many separate visits a player makes on an active day;
 * each visit re-rolls ORE accrual the way the real activation/report path does.
 */
export interface HumanHabitClass {
  name: string;
  share: number;
  /** Probability of activating on a given day while still retained. */
  activationDaysPerWeek: number;
  /** Visit spread: the activation lands in one of this many evenly spaced daily slots. */
  sessionsPerDay: number;
  /** Daily probability of leaving for good. */
  churnPerDay: number;
  /** How likely this class is to spend ORE as soon as it can (1 = always buys upgrades). */
  upgradeEagerness: number;
}

export const HUMAN_HABITS: readonly HumanHabitClass[] = [
  { name: "hardcore", share: 0.12, activationDaysPerWeek: 6.6, sessionsPerDay: 3, churnPerDay: 0.002, upgradeEagerness: 0.95 },
  { name: "regular", share: 0.31, activationDaysPerWeek: 5.0, sessionsPerDay: 2, churnPerDay: 0.008, upgradeEagerness: 0.75 },
  { name: "casual", share: 0.34, activationDaysPerWeek: 2.6, sessionsPerDay: 1.4, churnPerDay: 0.026, upgradeEagerness: 0.45 },
  { name: "tourist", share: 0.23, activationDaysPerWeek: 1.6, sessionsPerDay: 1, churnPerDay: 0.06, upgradeEagerness: 0.35 },
];

/**
 * Launch parameters of one mine. `rewardPerBlock` and the reserve split are launch inputs on
 * Solana (see programs/diggo-protocol/src/lib.rs launch_mine), not values in DIGGO_CONFIG, which is
 * why they live here rather than in shared/config.ts.
 */
export interface MineSpec {
  key: string;
  symbol: string;
  name: string;
  /** Fixed supply. Reserve split is applied to it, exactly like launch_mine does. */
  totalSupply: number;
  /** DEFAULT_RESERVE_BPS = 500 (5%). */
  reserveBps: number;
  /** DEFAULT_DISCOVERY_RESERVE_BPS = 50 (0.5%). */
  discoveryReserveBps: number;
  rewardPerBlock: number;
  /**
   * Launch parameter: days over which this mine is meant to distribute its whole Mining Reserve
   * (shared/rewardIndex.ts epochReward). Not part of DIGGO_CONFIG because it belongs to a launch,
   * the same way the reserve split and the starting reward do.
   */
  lifetimeDays: number;
  priceUsd: number;
  liquidityUsd: number;
  volume24hUsd: number;
  tradeCount24h: number;
  priceConfidence: number;
  health: TokenHealthFlags;
  /** Relative share of miner attention; drives which mine players pick. */
  popularity: number;
  /** Sim day (1-based) the mine becomes launchable. */
  launchDay: number;
}

function healthyToken(): TokenHealthFlags {
  return {
    mintAuthorityRevoked: true,
    freezeAuthorityRevoked: true,
    liquidityLocked: true,
    tradingEnabled: true,
    transferRestricted: false,
  };
}

/** One flagship mine plus a spread of mid and long-tail launches, all mixing to the same supply. */
export const DEFAULT_MINES: readonly MineSpec[] = [
  {
    key: "flagship",
    symbol: "DRILL",
    name: "Dog Wif Drill",
    totalSupply: 1_000_000_000,
    reserveBps: 500,
    discoveryReserveBps: 50,
    rewardPerBlock: 7_500,
    lifetimeDays: 365,
    priceUsd: 0.00284,
    liquidityUsd: 120_000,
    volume24hUsd: 60_000,
    tradeCount24h: 900,
    priceConfidence: 0.95,
    health: healthyToken(),
    popularity: 0.42,
    launchDay: 1,
  },
  {
    key: "midcap",
    symbol: "STONE",
    name: "Stone Coin",
    totalSupply: 1_000_000_000,
    reserveBps: 500,
    discoveryReserveBps: 50,
    rewardPerBlock: 9_200,
    lifetimeDays: 270,
    priceUsd: 0.0142,
    liquidityUsd: 400_000,
    volume24hUsd: 150_000,
    tradeCount24h: 1_400,
    priceConfidence: 0.97,
    health: healthyToken(),
    popularity: 0.28,
    launchDay: 1,
  },
  {
    key: "longtail",
    symbol: "BYTE",
    name: "Byte Token",
    totalSupply: 1_000_000_000,
    reserveBps: 500,
    discoveryReserveBps: 50,
    rewardPerBlock: 3_000,
    lifetimeDays: 90,
    priceUsd: 0.0009,
    liquidityUsd: 25_000,
    volume24hUsd: 9_000,
    tradeCount24h: 320,
    priceConfidence: 0.9,
    health: healthyToken(),
    popularity: 0.18,
    launchDay: 1,
  },
  {
    key: "fresh",
    symbol: "FROG",
    name: "Fresh Frog",
    totalSupply: 1_000_000_000,
    reserveBps: 500,
    discoveryReserveBps: 50,
    // A fresh launch that asks for a 30-day distribution: the schedule pays it out in about five
    // epochs, which is what makes it the harness's in-sim FULLY_MINED case.
    rewardPerBlock: 5_000,
    lifetimeDays: 30,
    priceUsd: 0.0004,
    liquidityUsd: 12_000,
    volume24hUsd: 5_500,
    tradeCount24h: 210,
    priceConfidence: 0.85,
    health: healthyToken(),
    popularity: 0.12,
    launchDay: 14,
  },
];

export interface SimOptions {
  seed: number;
  days: number;
  /** Number of human wallets that exist by the end of the arrival window. */
  humans: number;
  /** Wallets per bot farm, repeated for each farm size in `botFarmSizes`. */
  botFarmSizes: readonly number[];
  botStealth: BotStealth;
  mines: readonly MineSpec[];
  /** The single override layer: shared/config.ts createDiggoConfig. */
  config: DiggoConfig;
  /** Apply the risk gate (rewardState) to claims and discoveries, like worker/risk.ts does. */
  riskGating: boolean;
  /**
   * Which economy the run uses. full is the current shared/ rules. legacy switches exactly the
   * hardened knobs back to their pre-hardening values (the geometric reduction schedule, no
   * effective-power scaling, no share cap, and the storage and upgrade numbers the ORE analysis
   * was run against), so a BEFORE column and an AFTER column come out of the same code and seed.
   */
  hardening: "full" | "legacy";
  /** Counterfactual proposal: minimum crew tier required to own eligible mining power (0 = off). */
  miningMinCrewTier: number;
  /** How many days the human population arrives over (launch spike then a trickle). */
  arrivalWindowDays: number;
  blockIntervalSeconds: number;
  epochLengthSeconds: number;
  /** On-chain DEFAULT_DISCOVERY_EPOCH_BUDGET_BPS = 500 of a mine's Discovery Reserve per epoch. */
  discoveryEpochBudgetBps: number;
  startTime: number;
  /** Per-scenario note that ends up in the report. */
  note: string;
  /**
   * Population processing order. The harness is order-independent by construction (every draw is
   * keyed by wallet, and the mine accounting sums commute), so selfcheck.ts re-runs a scenario in
   * reverse and requires an identical result digest.
   */
  playerOrder: "forward" | "reverse";
  /** Diagnostic: assert that each mine's running power equals the sum of armed positions. */
  debugPower: boolean;
}

export const DEFAULT_SIM_OPTIONS: SimOptions = {
  seed: 20_260_922,
  days: 90,
  humans: 5_000,
  botFarmSizes: [],
  botStealth: "naive",
  mines: DEFAULT_MINES,
  config: createDiggoConfig(),
  riskGating: true,
  hardening: "full",
  miningMinCrewTier: 0,
  arrivalWindowDays: 30,
  blockIntervalSeconds: 300,
  epochLengthSeconds: 604_800,
  discoveryEpochBudgetBps: 500,
  startTime: 1_767_225_600,
  note: "",
  playerOrder: "forward",
  debugPower: false,
};

export interface Scenario {
  key: string;
  title: string;
  /** Applies to the resolved options, so it can also replace the mine table. */
  patch: (base: SimOptions) => SimOptions;
}

function withFlagship(options: SimOptions, patch: Partial<MineSpec>): SimOptions {
  return {
    ...options,
    mines: options.mines.map((mine) => (mine.key === "flagship" ? { ...mine, ...patch } : mine)),
  };
}

// The pre-hardening economy, spelled out. Only the knobs the hardening changed are listed, so a
// legacy run plays the old game and a full run plays the new one on identical seeds.
export const LEGACY_CONFIG_PATCH: DeepPartial<DiggoConfig> = {
  economy: { emission: { schedule: "epoch_reduction" } },
  effectivePower: {
    maturityRamp: [{ upToDay: Number.POSITIVE_INFINITY, bps: 10_000 }],
    perAccountBlockShareCapBps: 0,
    cluster: {
      deviceAllowance: Number.MAX_SAFE_INTEGER,
      networkAllowance: Number.MAX_SAFE_INTEGER,
    },
  },
  ore: {
    storageBaseCapacity: 480,
    storageCapacityScale: 240,
    cartsCapacityScale: 80,
    offlineHoursBase: 12,
    offlineHoursPerStorageLevel: 1.5,
    offlineHoursCap: 72,
  },
  crew: {
    upgradeCostBase: { miners: 120, drills: 160, carts: 140, foreman: 220, storage: 180 },
    upgradeCostExponent: 1.72,
  },
};

export function legacyConfig(): DiggoConfig {
  return createDiggoConfig(LEGACY_CONFIG_PATCH);
}

export function withLegacyEconomy(options: SimOptions): SimOptions {
  return { ...options, hardening: "legacy", config: legacyConfig() };
}

function withDiscoveryCaps(options: SimOptions, patch: DeepPartial<DiggoConfig["discovery"]>): SimOptions {
  return { ...options, config: createDiggoConfig({ discovery: patch }) };
}

/**
 * The standard matrix.
 *
 * Three groups: the human-only reference, bot pressure (each large farm measured twice, once with
 * the hardened economy and once with the pre-hardening one, on the same seed), and the launch
 * parameter sweeps that price the emission schedule. Rows that end in `-legacy` run
 * LEGACY_CONFIG_PATCH, so the report's BEFORE columns are measured, not remembered.
 */
export const SCENARIOS: readonly Scenario[] = [
  {
    key: "baseline",
    title: "Humans only",
    patch: (base) => ({ ...base, botFarmSizes: [], note: "Reference population, no farming." }),
  },
  {
    key: "baseline-legacy",
    title: "Humans only, pre-hardening economy",
    patch: (base) => ({
      ...withLegacyEconomy(base),
      botFarmSizes: [],
      note: "The reference population on the old rules: geometric reward reduction, no effective-power scaling, old ORE curves.",
    }),
  },
  {
    key: "bots-100-naive",
    title: "Humans + 100 scripted wallets",
    patch: (base) => ({
      ...base,
      botFarmSizes: [100],
      botStealth: "naive",
      note: "One small scripted farm: perfect 20h activation loop, no jitter, one device cluster.",
    }),
  },
  {
    key: "bots-1000-naive",
    title: "Humans + 1,000 scripted wallets",
    patch: (base) => ({
      ...base,
      botFarmSizes: [1_000],
      botStealth: "naive",
      note: "Medium farm, same scripted behaviour.",
    }),
  },
  {
    key: "bots-10000-naive",
    title: "Humans + 10,000 scripted wallets",
    patch: (base) => ({
      ...base,
      botFarmSizes: [10_000],
      botStealth: "naive",
      note: "Largest scripted farm: 10k wallets, one creation batch, one device cluster.",
    }),
  },
  {
    key: "bots-10000-naive-legacy",
    title: "Humans + 10,000 scripted wallets, pre-hardening economy",
    patch: (base) => ({
      ...withLegacyEconomy(base),
      botFarmSizes: [10_000],
      botStealth: "naive",
      note: "The same farm before the hardening.",
    }),
  },
  {
    key: "bots-1000-stealthy",
    title: "Humans + 1,000 spread-out wallets",
    patch: (base) => ({
      ...base,
      botFarmSizes: [1_000],
      botStealth: "stealthy",
      note: "Farm hides its shape: staggered creation, jittered activations, 15 wallets per device.",
    }),
  },
  {
    key: "bots-10000-stealthy",
    title: "Humans + 10,000 spread-out wallets",
    patch: (base) => ({
      ...base,
      botFarmSizes: [10_000],
      botStealth: "stealthy",
      note: "The load-bearing adversarial case: 10k wallets that do not look like a script.",
    }),
  },
  {
    key: "bots-10000-stealthy-legacy",
    title: "Humans + 10,000 spread-out wallets, pre-hardening economy",
    patch: (base) => ({
      ...withLegacyEconomy(base),
      botFarmSizes: [10_000],
      botStealth: "stealthy",
      note: "The same staggered farm before the hardening.",
    }),
  },
  {
    key: "bots-10000-stealthy-nogate",
    title: "10,000 spread-out wallets, risk gate off",
    patch: (base) => ({
      ...base,
      botFarmSizes: [10_000],
      botStealth: "stealthy",
      riskGating: false,
      note: "Detection-independent bound: what a farm keeps if the risk gate never fires at all.",
    }),
  },
  {
    key: "bots-10000-stealthy-nogate-legacy",
    title: "10,000 spread-out wallets, risk gate off, pre-hardening economy",
    patch: (base) => ({
      ...withLegacyEconomy(base),
      botFarmSizes: [10_000],
      botStealth: "stealthy",
      riskGating: false,
      note: "The detection-independent bound before the hardening.",
    }),
  },
  {
    key: "bots-10000-stealthy-caps-off",
    title: "10,000 spread-out wallets, discovery caps off",
    patch: (base) => ({
      ...withDiscoveryCaps(base, {
        accountDailyCapUsd: 1_000_000_000,
        accountWeeklyCapUsd: 1_000_000_000,
        tokenDailyCapUsd: 1_000_000_000,
        tokenPeriodCapUsd: 1_000_000_000,
        globalDailyCapUsd: 1_000_000_000,
        perRequestCapUsd: 1_000_000_000,
      }),
      botFarmSizes: [10_000],
      botStealth: "stealthy",
      note: "Caps raised to effectively unlimited to isolate what the caps are doing.",
    }),
  },
  {
    key: "bots-10000-stealthy-caps-5x",
    title: "10,000 spread-out wallets, discovery caps x5",
    patch: (base) => ({
      ...withDiscoveryCaps(base, {
        accountDailyCapUsd: 2.5,
        accountWeeklyCapUsd: 12.5,
        tokenDailyCapUsd: 125,
        tokenPeriodCapUsd: 500,
        globalDailyCapUsd: 2_500,
      }),
      botFarmSizes: [10_000],
      botStealth: "stealthy",
      note: "A generous discovery budget: what it costs to make discoveries actually reach players.",
    }),
  },
  {
    key: "bots-10000-stealthy-tier2",
    title: "10,000 spread-out wallets, tier-2 mining gate",
    patch: (base) => ({
      ...base,
      botFarmSizes: [10_000],
      botStealth: "stealthy",
      miningMinCrewTier: 2,
      note: "Counterfactual: a Crew below tier 2 (total level 15) owns no eligible power, mirroring the discovery gate.",
    }),
  },
  {
    key: "sweep-lifetime-30",
    title: "Flagship reserved for a 30-day distribution",
    patch: (base) => ({
      ...withFlagship(base, { lifetimeDays: 30 }),
      note: "Flagship launch parameter: distribute the whole reserve in 30 days.",
    }),
  },
  {
    key: "sweep-lifetime-90",
    title: "Flagship reserved for a 90-day distribution",
    patch: (base) => ({
      ...withFlagship(base, { lifetimeDays: 90 }),
      note: "Flagship launch parameter: distribute the whole reserve in 90 days.",
    }),
  },
  {
    key: "sweep-lifetime-180",
    title: "Flagship reserved for a 180-day distribution",
    patch: (base) => ({
      ...withFlagship(base, { lifetimeDays: 180 }),
      note: "Flagship launch parameter: distribute the whole reserve in 180 days.",
    }),
  },
  {
    key: "sweep-lifetime-730",
    title: "Flagship reserved for a 730-day distribution",
    patch: (base) => ({
      ...withFlagship(base, { lifetimeDays: 730 }),
      note: "Flagship launch parameter: distribute the whole reserve in two years.",
    }),
  },
  {
    key: "sweep-launch-400",
    title: "Flagship launched at 400 per block",
    patch: (base) => ({
      ...withFlagship(base, { rewardPerBlock: 400 }),
      note: "A launch reward below the reserve-runway budget: the reserve lasts longer than the target and still empties.",
    }),
  },
];

export function findScenario(key: string): Scenario | undefined {
  return SCENARIOS.find((scenario) => scenario.key === key);
}
