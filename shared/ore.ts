import {
  BPS_DENOMINATOR,
  DIGGO_CONFIG,
  rampBps,
  type CrewLevels,
  type DiggoConfig,
  type OreSource,
} from "./config";
import { assertCrewLevel, onchainLevelIndex, onchainMaturityRampBps } from "./crew";

/**
 * ORE is the non-transferable progression resource (spec 2). It is never a SPL
 * token, never tradeable and never purchasable. Every source below is pure and
 * configurable; nothing in Diggo grants ORE for real money.
 */
export const ORE_SOURCES: readonly OreSource[] = [
  "active_mine",
  "activation",
  "streak_milestone",
  "achievement",
  "level_up",
  "quest",
  "season",
];

/** round(10_000 * cartsEfficiency(level)). */
export const CARTS_ORE_BPS: readonly number[] = [
  10000, 10241, 10466, 10675, 10870, 11051, 11220, 11377, 11523, 11660,
  11787, 11905, 12015, 12117, 12212, 12301, 12384, 12461, 12532, 12599,
  12661, 12719, 12773, 12823, 12870, 12913, 12954, 12991, 13026, 13059,
  13089, 13118, 13144, 13169, 13191, 13213, 13233, 13251, 13268, 13284,
  13299, 13313, 13326, 13338, 13349, 13359, 13369, 13378, 13386, 13394,
  13402, 13408, 13415, 13421, 13426, 13431, 13436, 13440, 13444, 13448,
  13452, 13455, 13458, 13461, 13464, 13466, 13469, 13471, 13473, 13475,
  13476, 13478, 13480, 13481, 13482, 13483, 13485, 13486, 13487, 13488,
  13488, 13489, 13490, 13491, 13491, 13492, 13492, 13493, 13493, 13494,
  13494, 13495, 13495, 13495, 13496, 13496, 13496, 13497, 13497, 13497,
];

/** round(10_000 * foremanEfficiency(level)). */
export const FOREMAN_ORE_BPS: readonly number[] = [
  10000, 10108, 10210, 10307, 10399, 10485, 10567, 10644, 10718, 10787,
  10852, 10915, 10973, 11029, 11081, 11131, 11178, 11222, 11264, 11304,
  11342, 11377, 11411, 11443, 11473, 11501, 11528, 11554, 11578, 11601,
  11622, 11643, 11662, 11680, 11698, 11714, 11729, 11744, 11758, 11771,
  11783, 11795, 11806, 11817, 11826, 11836, 11845, 11853, 11861, 11869,
  11876, 11882, 11889, 11895, 11900, 11906, 11911, 11916, 11920, 11925,
  11929, 11933, 11936, 11940, 11943, 11946, 11949, 11952, 11954, 11957,
  11959, 11961, 11963, 11965, 11967, 11969, 11971, 11972, 11974, 11975,
  11977, 11978, 11979, 11980, 11981, 11982, 11983, 11984, 11985, 11986,
  11987, 11987, 11988, 11989, 11989, 11990, 11990, 11991, 11991, 11992,
];

/** floor(storageCapacityScale * level ^ storageCapacityExponent). */
export const STORAGE_CAPACITY: readonly number[] = [
  420, 721, 989, 1238, 1473, 1699, 1916, 2126, 2331, 2530,
  2726, 2917, 3105, 3290, 3472, 3651, 3828, 4002, 4175, 4345,
  4514, 4681, 4846, 5009, 5171, 5332, 5491, 5649, 5806, 5962,
  6116, 6269, 6422, 6573, 6723, 6873, 7021, 7169, 7316, 7462,
  7607, 7751, 7895, 8037, 8180, 8321, 8462, 8602, 8741, 8880,
  9018, 9156, 9293, 9430, 9566, 9701, 9836, 9970, 10104, 10237,
  10370, 10503, 10634, 10766, 10897, 11027, 11158, 11287, 11416, 11545,
  11674, 11802, 11930, 12057, 12184, 12310, 12436, 12562, 12688, 12813,
  12938, 13062, 13186, 13310, 13433, 13556, 13679, 13802, 13924, 14046,
  14167, 14289, 14410, 14530, 14651, 14771, 14891, 15010, 15130, 15249,
];

/** floor(cartsCapacityScale * sqrt(level)). */
export const CARTS_CAPACITY: readonly number[] = [
  120, 169, 207, 240, 268, 293, 317, 339, 360, 379,
  397, 415, 432, 448, 464, 480, 494, 509, 523, 536,
  549, 562, 575, 587, 600, 611, 623, 634, 646, 657,
  668, 678, 689, 699, 709, 720, 729, 739, 749, 758,
  768, 777, 786, 795, 804, 813, 822, 831, 840, 848,
  856, 865, 873, 881, 889, 897, 905, 913, 921, 929,
  937, 944, 952, 960, 967, 974, 982, 989, 996, 1003,
  1011, 1018, 1025, 1032, 1039, 1046, 1052, 1059, 1066, 1073,
  1080, 1086, 1093, 1099, 1106, 1112, 1119, 1125, 1132, 1138,
  1144, 1150, 1157, 1163, 1169, 1175, 1181, 1187, 1193, 1200,
];

// ---- the on-chain mirror (math/ore.rs) ----------------------------------------------------
//
// The accrual, the storage clamp and the offline hours are the chain's own numbers. Every
// function below is the exact integer mirror, and `maturityBps`, `oreCapacity`,
// `offlineHours`, `oreForActiveSeconds`, `oreFromActivation` and `storeOre` return these
// values whenever they are called with the deployed config, so the client and the indexer can
// never promise a player more ORE than the chain will book.

export const ONCHAIN_SECONDS_PER_HOUR = 3_600;
export const ONCHAIN_SECONDS_PER_DAY = 86_400;
export const ONCHAIN_BASE_ORE_PER_ACTIVE_HOUR = 30;
export const ONCHAIN_ACTIVATION_BONUS_ORE = 50;
export const ONCHAIN_STORAGE_BASE_CAPACITY = 1_800;
export const ONCHAIN_OFFLINE_HOURS_BASE = 24;
export const ONCHAIN_OFFLINE_HOURS_PER_STORAGE_LEVEL = 4;
export const ONCHAIN_OFFLINE_HOURS_CAP = 168;
/** Longest stretch one settlement pays for: the activation window and the accrual cap. */
export const ONCHAIN_MAX_ACCRUAL_SECONDS = 86_400;

/** floor(carts_ore_bps[carts] * foreman_ore_bps[foreman] / BPS): math/ore.rs ore_efficiency_bps. */
export function onchainOreEfficiencyBps(levels: CrewLevels): number {
  const carts = CARTS_ORE_BPS[onchainLevelIndex(levels.carts)];
  const foreman = FOREMAN_ORE_BPS[onchainLevelIndex(levels.foreman)];
  return Math.floor((carts * foreman) / BPS_DENOMINATOR);
}

/** The crew's storage capacity in ORE: math/ore.rs ore_capacity. */
export function onchainOreCapacity(levels: CrewLevels): number {
  return (
    ONCHAIN_STORAGE_BASE_CAPACITY +
    STORAGE_CAPACITY[onchainLevelIndex(levels.storage)] +
    CARTS_CAPACITY[onchainLevelIndex(levels.carts)]
  );
}

/** Hours of offline accrual, capped: math/ore.rs offline_hours. */
export function onchainOfflineHours(levels: CrewLevels): number {
  const hours =
    ONCHAIN_OFFLINE_HOURS_BASE +
    ONCHAIN_OFFLINE_HOURS_PER_STORAGE_LEVEL * onchainLevelIndex(levels.storage);
  return Math.min(ONCHAIN_OFFLINE_HOURS_CAP, hours);
}

/** Maturity from the PlayerAccount's creation timestamp, in bps of full accrual. */
export function onchainOreMaturityBps(accountAgeSeconds: number): number {
  if (!Number.isFinite(accountAgeSeconds) || accountAgeSeconds < 0) return 0;
  return onchainMaturityRampBps(Math.floor(accountAgeSeconds / ONCHAIN_SECONDS_PER_DAY));
}

/**
 * floor(seconds * 30 * maturityBps * efficiencyBps / (3600 * BPS^2)): one rounding, at the
 * end, downwards, exactly where the chain rounds. A lapsed window passes activeSeconds = 0,
 * because a paused mine accrues nothing.
 */
export function onchainOreForActiveSeconds(
  activeSeconds: number,
  maturityBps: number,
  efficiencyBps: number,
): number {
  if (!Number.isFinite(activeSeconds) || activeSeconds <= 0) return 0;
  const seconds = Math.min(Math.floor(activeSeconds), ONCHAIN_MAX_ACCRUAL_SECONDS);
  const numerator = seconds * ONCHAIN_BASE_ORE_PER_ACTIVE_HOUR * maturityBps * efficiencyBps;
  return Math.floor(
    numerator / (ONCHAIN_SECONDS_PER_HOUR * BPS_DENOMINATOR * BPS_DENOMINATOR),
  );
}

/** ORE for a fresh activation, throttled by the same ramp: math/ore.rs ore_from_activation. */
export function onchainOreFromActivation(maturityBps: number): number {
  return Math.floor((ONCHAIN_ACTIVATION_BONUS_ORE * maturityBps) / BPS_DENOMINATOR);
}

/** math/ore.rs store_ore: the overflow is returned, never silently kept. */
export function onchainStoreOre(balance: number, amount: number, capacity: number): OreStoreResult {
  const safeBalance = Number.isFinite(balance) && balance > 0 ? Math.floor(balance) : 0;
  const safeCapacity = Number.isFinite(capacity) && capacity > 0 ? Math.floor(capacity) : 0;
  const requested = Number.isFinite(amount) && amount > 0 ? Math.floor(amount) : 0;
  const free = Math.max(0, safeCapacity - safeBalance);
  const stored = Math.min(free, requested);
  return { balance: safeBalance + stored, stored, overflow: requested - stored, capacity: safeCapacity };
}

/** Account maturity ramp (spec 40, 42): young accounts are throttled, not paywalled. */
export function maturityBps(accountAgeSeconds: number, config: DiggoConfig = DIGGO_CONFIG): number {
  if (!Number.isFinite(accountAgeSeconds) || accountAgeSeconds < 0) return 0;
  if (config === DIGGO_CONFIG) return onchainOreMaturityBps(accountAgeSeconds);
  return rampBps(config.ore.maturityRamp, accountAgeSeconds / config.time.secondsPerDay);
}

function saturating(level: number, gain: number, scale: number, config: DiggoConfig): number {
  const steps = level - config.crew.minLevel;
  if (steps <= 0) return 1;
  return 1 + gain * (1 - Math.exp(-steps / scale));
}

/** Carts plus Foreman logistics bonus. Applies to ORE only, never to power. */
export function oreEfficiency(levels: CrewLevels, config: DiggoConfig = DIGGO_CONFIG): number {
  assertCrewLevel(levels.carts, config);
  assertCrewLevel(levels.foreman, config);
  const carts = saturating(levels.carts, config.ore.cartsEfficiencyGain, config.ore.cartsEfficiencyScale, config);
  const foreman = saturating(
    levels.foreman,
    config.ore.foremanEfficiencyGain,
    config.ore.foremanEfficiencyScale,
    config,
  );
  return carts * foreman;
}

/** ORE storage capacity. Storage is the offline/management branch. */
export function oreCapacity(levels: CrewLevels, config: DiggoConfig = DIGGO_CONFIG): number {
  assertCrewLevel(levels.storage, config);
  assertCrewLevel(levels.carts, config);
  if (config === DIGGO_CONFIG) return onchainOreCapacity(levels);
  return Math.floor(
    config.ore.storageBaseCapacity +
      config.ore.storageCapacityScale * Math.pow(levels.storage, config.ore.storageCapacityExponent) +
      config.ore.cartsCapacityScale * Math.sqrt(levels.carts),
  );
}

/** How long an activated crew can keep accruing ORE while the player is away. */
export function offlineHours(levels: CrewLevels, config: DiggoConfig = DIGGO_CONFIG): number {
  assertCrewLevel(levels.storage, config);
  if (config === DIGGO_CONFIG) return onchainOfflineHours(levels);
  const hours =
    config.ore.offlineHoursBase + config.ore.offlineHoursPerStorageLevel * (levels.storage - config.crew.minLevel);
  return Math.min(config.ore.offlineHoursCap, hours);
}

export function maxAccrualSeconds(config: DiggoConfig = DIGGO_CONFIG): number {
  return Math.min(config.ore.maxAccrualSeconds, config.streak.activationSeconds);
}

/**
 * Active-time ORE accrual with the maturity ramp and logistics efficiency.
 * A paused mine accrues nothing: callers must pass activeSeconds = 0 when the
 * activation window has lapsed (see isEligibleForBlock in ./streak).
 */
export function oreForActiveSeconds(
  activeSeconds: number,
  accountAgeSeconds: number,
  levels?: CrewLevels,
  config: DiggoConfig = DIGGO_CONFIG,
): number {
  if (!Number.isFinite(activeSeconds) || activeSeconds <= 0) return 0;
  if (config === DIGGO_CONFIG) {
    return onchainOreForActiveSeconds(
      activeSeconds,
      onchainOreMaturityBps(accountAgeSeconds),
      levels ? onchainOreEfficiencyBps(levels) : BPS_DENOMINATOR,
    );
  }
  const seconds = Math.min(activeSeconds, maxAccrualSeconds(config));
  const base = (seconds / config.time.secondsPerHour) * config.ore.baseOrePerActiveHour;
  const efficiency = levels ? oreEfficiency(levels, config) : 1;
  return Math.floor((base * maturityBps(accountAgeSeconds, config) * efficiency) / BPS_DENOMINATOR);
}

export function oreFromActivation(
  accountAgeSeconds: number,
  config: DiggoConfig = DIGGO_CONFIG,
): number {
  if (config === DIGGO_CONFIG) {
    return onchainOreFromActivation(onchainOreMaturityBps(accountAgeSeconds));
  }
  return Math.floor(
    (config.ore.activationBonusOre * maturityBps(accountAgeSeconds, config)) / BPS_DENOMINATOR,
  );
}

export function oreFromAchievement(
  achievementId: string,
  config: DiggoConfig = DIGGO_CONFIG,
): number {
  const ore = config.ore.achievementOre[achievementId];
  return typeof ore === "number" && ore > 0 ? ore : 0;
}

export function oreFromLevelUp(level: number, config: DiggoConfig = DIGGO_CONFIG): number {
  if (!Number.isInteger(level) || level <= config.crew.minLevel) return 0;
  const steps = level - config.crew.minLevel;
  return Math.floor(config.ore.levelUpBaseOre * Math.pow(steps, config.ore.levelUpOrePerLevel));
}

export interface OreGrantInput {
  source: OreSource;
  activeSeconds?: number;
  accountAgeSeconds?: number;
  /** Streak day reached, used for the streak milestone source. */
  streakDay?: number;
  /** Total ORE configured for the milestone reached. */
  milestoneOre?: number;
  achievementId?: string;
  level?: number;
  /** Explicit grant for quest and season rewards; always capped by config. */
  amount?: number;
}

/** Single dispatch point for every configured ORE source (spec 14). */
export function oreGrant(
  input: OreGrantInput,
  levels?: CrewLevels,
  config: DiggoConfig = DIGGO_CONFIG,
): number {
  const accountAgeSeconds = input.accountAgeSeconds ?? 0;
  switch (input.source) {
    case "active_mine":
      return oreForActiveSeconds(input.activeSeconds ?? 0, accountAgeSeconds, levels, config);
    case "activation":
      return oreFromActivation(accountAgeSeconds, config);
    case "streak_milestone":
      return Math.max(0, Math.floor(input.milestoneOre ?? 0));
    case "achievement":
      return oreFromAchievement(input.achievementId ?? "", config);
    case "level_up":
      return oreFromLevelUp(input.level ?? config.crew.minLevel, config);
    case "quest":
      return Math.max(0, Math.min(Math.floor(input.amount ?? 0), config.ore.questOreCap));
    case "season":
      return Math.max(0, Math.min(Math.floor(input.amount ?? 0), config.ore.seasonOreCap));
    default:
      return 0;
  }
}

export interface OreStoreResult {
  /** Balance after the deposit. */
  balance: number;
  /** Amount actually accepted into storage. */
  stored: number;
  /** Amount that did not fit. Callers must decide what to do with it; it is never dropped silently. */
  overflow: number;
  capacity: number;
}

/**
 * Deposits ORE into storage and reports overflow explicitly (spec 42). Nothing
 * is ever silently discarded: the caller receives the overflow amount.
 */
export function storeOre(
  balance: number,
  amount: number,
  capacity: number,
  config: DiggoConfig = DIGGO_CONFIG,
): OreStoreResult {
  if (config === DIGGO_CONFIG) return onchainStoreOre(balance, amount, capacity);
  const safeBalance = Number.isFinite(balance) && balance > 0 ? balance : 0;
  const safeCapacity = Number.isFinite(capacity) && capacity > 0 ? capacity : 0;
  const requested = Number.isFinite(amount) && amount > 0 ? amount : 0;
  const free = Math.max(0, safeCapacity - safeBalance);
  const stored = Math.min(free, Math.floor(requested));
  return {
    balance: safeBalance + stored,
    stored,
    overflow: Math.floor(requested) - stored,
    capacity: safeCapacity,
  };
}
