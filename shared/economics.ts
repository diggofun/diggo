export const BPS_DENOMINATOR = 10_000;

export const GAMEPLAY_DEFAULTS = {
  activationSeconds: 86_400,
  graceSeconds: 43_200,
  minimumReactivationSeconds: 72_000,
  baseOrePerHour: 20,
  activationOre: 50,
  starterPower: 100,
  discoveryMinimumAgeDays: 7,
  discoveryMinimumActiveDays: 5,
} as const;

export const DISCOVERY_DEFAULTS = {
  minimumMarketCapUsd: 250_000,
  accountDailyCapUsd: 0.5,
  accountWeeklyCapUsd: 2.5,
  tokenDailyCapUsd: 25,
  globalDailyCapUsd: 500,
} as const;

export type DiscoveryRarity = "common" | "uncommon" | "rare" | "epic" | "legendary" | "mythic";

export interface RarityTier {
  rarity: DiscoveryRarity;
  /** Cumulative probability upper bound in [0, 1), rolled against a uniform random draw. */
  cumulativeChance: number;
  /** Target USD-equivalent value of the reward before caps are applied. */
  valueUsd: number;
}

export const DISCOVERY_RARITY_TABLE: RarityTier[] = [
  { rarity: "common", cumulativeChance: 0.70, valueUsd: 0.05 },
  { rarity: "uncommon", cumulativeChance: 0.90, valueUsd: 0.15 },
  { rarity: "rare", cumulativeChance: 0.97, valueUsd: 0.50 },
  { rarity: "epic", cumulativeChance: 0.995, valueUsd: 1.50 },
  { rarity: "legendary", cumulativeChance: 0.9995, valueUsd: 5.00 },
  { rarity: "mythic", cumulativeChance: 1, valueUsd: 20.00 },
];

export const CREW_TIERS = [
  { tier: 1, name: "Backyard Diggers", minTotalLevel: 5 },
  { tier: 2, name: "Small Mining Crew", minTotalLevel: 15 },
  { tier: 3, name: "Industrial Crew", minTotalLevel: 35 },
  { tier: 4, name: "Deep Mine Division", minTotalLevel: 75 },
  { tier: 5, name: "Mega Mining Operation", minTotalLevel: 150 },
  { tier: 6, name: "Legendary Diggo Crew", minTotalLevel: 300 },
] as const;

export function crewTier(levels: CrewLevels): (typeof CREW_TIERS)[number] {
  const totalLevel = Object.values(levels).reduce((sum, level) => sum + level, 0);
  let current: (typeof CREW_TIERS)[number] = CREW_TIERS[0];
  for (const tier of CREW_TIERS) {
    if (totalLevel >= tier.minTotalLevel) current = tier;
  }
  return current;
}

/**
 * Rolls a discovery rarity from a caller-supplied uniform random draw in [0, 1).
 * The draw must come from a cryptographically secure, server-side RNG — never
 * frontend Math.random() — since this decides a real-token reward.
 */
export function rollDiscoveryRarity(randomUnitInterval: number): DiscoveryRarity {
  if (!Number.isFinite(randomUnitInterval) || randomUnitInterval < 0 || randomUnitInterval >= 1) {
    throw new Error("randomUnitInterval must be in [0, 1)");
  }
  for (const tier of DISCOVERY_RARITY_TABLE) {
    if (randomUnitInterval < tier.cumulativeChance) return tier.rarity;
  }
  return "mythic";
}

export function discoveryValueUsd(rarity: DiscoveryRarity): number {
  const tier = DISCOVERY_RARITY_TABLE.find((entry) => entry.rarity === rarity);
  if (!tier) throw new Error("Unknown discovery rarity");
  return tier.valueUsd;
}

/**
 * Converts a target USD value into token units using a token's spot price.
 * Callers must only pass prices from tokens that already passed liquidity/eligibility
 * checks (see DISCOVERY_DEFAULTS.minimumMarketCapUsd) — this function does not
 * defend against manipulated or illiquid prices on its own.
 */
export function discoveryTokenAmount(valueUsd: number, priceUsd: number): number {
  if (valueUsd <= 0 || !Number.isFinite(priceUsd) || priceUsd <= 0) return 0;
  return valueUsd / priceUsd;
}

export type CrewComponent = "miners" | "drills" | "carts" | "foreman" | "storage";

export interface CrewLevels {
  miners: number;
  drills: number;
  carts: number;
  foreman: number;
  storage: number;
}

export function proportionalReward(
  blockReward: number,
  assignedPower: number,
  totalPower: number,
): number {
  if (blockReward < 0 || assignedPower < 0 || totalPower <= 0) return 0;
  return Math.min(blockReward, blockReward * (assignedPower / totalPower));
}

export function reducedReward(
  currentReward: number,
  reductionBps = 2_500,
  minimumReward = 1,
): number {
  if (currentReward <= 0) return 0;
  const reduction = Math.floor((currentReward * reductionBps) / BPS_DENOMINATOR);
  return Math.max(minimumReward, currentReward - reduction);
}

export function clampRewardToReserve(reward: number, reserve: number): number {
  return Math.max(0, Math.min(reward, reserve));
}

export function maturityBps(accountAgeSeconds: number): number {
  if (accountAgeSeconds < 0) return 0;
  const days = accountAgeSeconds / 86_400;
  if (days < 1) return 2_000;
  if (days < 3) return 3_500;
  if (days < 7) return 5_000;
  return BPS_DENOMINATOR;
}

export function oreForActiveSeconds(activeSeconds: number, accountAgeSeconds: number): number {
  if (!Number.isFinite(activeSeconds) || activeSeconds <= 0) return 0;
  const base = (activeSeconds / 3_600) * GAMEPLAY_DEFAULTS.baseOrePerHour;
  return Math.floor((base * maturityBps(accountAgeSeconds)) / BPS_DENOMINATOR);
}

export function upgradeOreCost(component: CrewComponent, currentLevel: number): number {
  if (!Number.isInteger(currentLevel) || currentLevel < 1 || currentLevel >= 100) {
    throw new Error("Invalid crew level");
  }
  const base: Record<CrewComponent, number> = {
    miners: 120,
    drills: 160,
    carts: 140,
    foreman: 220,
    storage: 180,
  };
  return Math.floor(base[component] * currentLevel ** 1.72);
}

export function crewPower(levels: CrewLevels): number {
  const valid = Object.values(levels).every((level) => Number.isInteger(level) && level >= 1 && level <= 100);
  if (!valid) throw new Error("Invalid crew levels");
  const minerPower = 75 * Math.pow(levels.miners, 0.82);
  const drillEfficiency = 1 + 0.035 * Math.sqrt(levels.drills - 1);
  const foremanEfficiency = 1 + 0.025 * Math.log2(levels.foreman);
  return Math.floor((GAMEPLAY_DEFAULTS.starterPower + minerPower) * drillEfficiency * foremanEfficiency);
}

export function oreCapacity(levels: CrewLevels): number {
  return Math.floor(480 + 240 * Math.pow(levels.storage, 0.78) + 80 * Math.sqrt(levels.carts));
}

export function nextStreak(
  previousActivationAt: number | null,
  now: number,
  currentStreak: number,
  freezes: number,
): { streak: number; freezes: number; usedFreeze: boolean } {
  if (previousActivationAt === null) return { streak: 1, freezes, usedFreeze: false };
  const elapsed = now - previousActivationAt;
  const normalWindow = GAMEPLAY_DEFAULTS.activationSeconds + GAMEPLAY_DEFAULTS.graceSeconds;
  if (elapsed <= normalWindow) return { streak: currentStreak + 1, freezes, usedFreeze: false };
  if (elapsed <= normalWindow + GAMEPLAY_DEFAULTS.activationSeconds && freezes > 0) {
    return { streak: currentStreak + 1, freezes: freezes - 1, usedFreeze: true };
  }
  return { streak: 1, freezes, usedFreeze: false };
}

export function discoveryEligible(accountAgeSeconds: number, activeDays: number, crewTier: number): boolean {
  return accountAgeSeconds >= GAMEPLAY_DEFAULTS.discoveryMinimumAgeDays * 86_400
    && activeDays >= GAMEPLAY_DEFAULTS.discoveryMinimumActiveDays
    && crewTier >= 2;
}
