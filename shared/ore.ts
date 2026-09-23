import {
  BPS_DENOMINATOR,
  DIGGO_CONFIG,
  rampBps,
  type CrewLevels,
  type DiggoConfig,
  type OreSource,
} from "./config";
import { assertCrewLevel } from "./crew";

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

/** Account maturity ramp (spec 40, 42): young accounts are throttled, not paywalled. */
export function maturityBps(accountAgeSeconds: number, config: DiggoConfig = DIGGO_CONFIG): number {
  if (!Number.isFinite(accountAgeSeconds) || accountAgeSeconds < 0) return 0;
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
  return Math.floor(
    config.ore.storageBaseCapacity +
      config.ore.storageCapacityScale * Math.pow(levels.storage, config.ore.storageCapacityExponent) +
      config.ore.cartsCapacityScale * Math.sqrt(levels.carts),
  );
}

/** How long an activated crew can keep accruing ORE while the player is away. */
export function offlineHours(levels: CrewLevels, config: DiggoConfig = DIGGO_CONFIG): number {
  assertCrewLevel(levels.storage, config);
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
  const seconds = Math.min(activeSeconds, maxAccrualSeconds(config));
  const base = (seconds / config.time.secondsPerHour) * config.ore.baseOrePerActiveHour;
  const efficiency = levels ? oreEfficiency(levels, config) : 1;
  return Math.floor((base * maturityBps(accountAgeSeconds, config) * efficiency) / BPS_DENOMINATOR);
}

export function oreFromActivation(
  accountAgeSeconds: number,
  config: DiggoConfig = DIGGO_CONFIG,
): number {
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
