import {
  DIGGO_CONFIG,
  type CrewLevels,
  type CrewTierConfig,
  type CrewComponent,
  type DiggoConfig,
} from "./config";

/**
 * Mining Crew branches (spec 10). Each branch has its own strategic meaning:
 * - Miners: base Mining Power.
 * - Drills: efficiency multiplier applied to Miners (never flat power).
 * - Carts: logistics, raising ORE efficiency (never mining power).
 * - Foreman: organisation, reducing upgrade costs and raising ORE efficiency.
 * - Storage: offline capacity and offline hours.
 */
export const CREW_COMPONENTS: readonly CrewComponent[] = [
  "miners",
  "drills",
  "carts",
  "foreman",
  "storage",
];

export function assertCrewLevel(level: number, config: DiggoConfig = DIGGO_CONFIG): void {
  if (
    !Number.isInteger(level) ||
    level < config.crew.minLevel ||
    level > config.crew.maxLevel
  ) {
    throw new Error("Invalid crew level");
  }
}

function assertAllLevels(levels: CrewLevels, config: DiggoConfig): void {
  for (const component of CREW_COMPONENTS) {
    const level = levels[component];
    if (typeof level !== "number") throw new Error("Invalid crew levels");
    if (level < config.crew.minLevel || level > config.crew.maxLevel) {
      throw new Error("Invalid crew levels");
    }
  }
}

/**
 * Saturating efficiency curve. Returns 1 at the minimum level and approaches
 * 1 + gain at the maximum level, so no branch can grow without bound.
 */
function saturating(level: number, gain: number, scale: number, config: DiggoConfig): number {
  const steps = level - config.crew.minLevel;
  if (steps <= 0) return 1;
  return 1 + gain * (1 - Math.exp(-steps / scale));
}

/** Drills multiply Miner output rather than adding a second flat power term. */
export function drillEfficiency(drillsLevel: number, config: DiggoConfig = DIGGO_CONFIG): number {
  assertCrewLevel(drillsLevel, config);
  return saturating(drillsLevel, config.crew.drillEfficiencyGain, config.crew.drillEfficiencyScale, config);
}

export function minersBasePower(minersLevel: number, config: DiggoConfig = DIGGO_CONFIG): number {
  assertCrewLevel(minersLevel, config);
  return config.crew.starterPower * Math.pow(minersLevel, config.crew.minerPowerExponent);
}

export function crewPower(levels: CrewLevels, config: DiggoConfig = DIGGO_CONFIG): number {
  assertAllLevels(levels, config);
  const base = minersBasePower(levels.miners, config);
  return Math.floor(base * drillEfficiency(levels.drills, config));
}

/**
 * Highest possible ratio between a max-level crew and a starter crew, derived
 * from the configured curve. Used as a guard test against runaway scaling.
 */
export function maxCrewPowerRatio(config: DiggoConfig = DIGGO_CONFIG): number {
  const minerRatio =
    Math.pow(config.crew.maxLevel, config.crew.minerPowerExponent) /
    Math.pow(config.crew.minLevel, config.crew.minerPowerExponent);
  return minerRatio * (1 + config.crew.drillEfficiencyGain);
}

export function upgradeCostMultiplier(
  foremanLevel: number,
  config: DiggoConfig = DIGGO_CONFIG,
): number {
  assertCrewLevel(foremanLevel, config);
  const reduction = saturating(
    foremanLevel,
    config.crew.foremanDiscountGain,
    config.crew.foremanDiscountScale,
    config,
  );
  return Math.max(config.crew.minimumUpgradeCostMultiplier, 2 - reduction);
}

/**
 * ORE cost of the next level. The Foreman branch discounts the price, which is
 * why the signature accepts an optional foreman level while staying compatible
 * with the original two-argument call.
 */
export function upgradeOreCost(
  component: CrewComponent,
  currentLevel: number,
  foremanLevel: number = DIGGO_CONFIG.crew.minLevel,
  config: DiggoConfig = DIGGO_CONFIG,
): number {
  if (
    !Number.isInteger(currentLevel) ||
    currentLevel < config.crew.minLevel ||
    currentLevel >= config.crew.upgradeCostMaxLevel
  ) {
    throw new Error("Invalid crew level");
  }
  const base = config.crew.upgradeCostBase[component];
  if (typeof base !== "number") throw new Error("Unknown crew component");
  const raw = base * Math.pow(currentLevel, config.crew.upgradeCostExponent);
  return Math.floor(raw * upgradeCostMultiplier(foremanLevel, config));
}

export function crewTotalLevel(levels: CrewLevels): number {
  return CREW_COMPONENTS.reduce((sum, component) => sum + levels[component], 0);
}

export function crewTier(levels: CrewLevels, config: DiggoConfig = DIGGO_CONFIG): CrewTierConfig {
  const totalLevel = crewTotalLevel(levels);
  let current: CrewTierConfig = config.crew.tiers[0];
  for (const tier of config.crew.tiers) {
    if (totalLevel >= tier.minTotalLevel) current = tier;
  }
  return current;
}

