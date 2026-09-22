/**
 * Diggo economics facade.
 *
 * The historical public API of this module is preserved for existing worker/src
 * call sites. The implementation now lives in focused modules under shared/:
 *
 *   config.ts       one central, fully configurable parameter set with defaults
 *   crew.ts         Crew branches, Mining Power, upgrade costs, tiers
 *   ore.ts          non-transferable ORE sources, capacity, storage overflow
 *   streak.ts       daily activation, streak continue/break, freezes, block boundaries
 *   rewardIndex.ts  BigInt cumulative reward index, reductions, FULLY_MINED
 *   rarity.ts       rarity table, eligibility score, robust price normalization
 *   risk.ts         risk scoring, progressive responses, Mine Trust
 *   discovery.ts    discovery eligibility and multi-level budget caps
 *   random.ts       server-authoritative RNG abstraction (HMAC-SHA256)
 *
 * Real money never buys Mining Power, ORE or real-token luck: nothing in this
 * module accepts a payment to increase power, rewards or discovery odds.
 */

import { DIGGO_CONFIG, type DiscoveryRarity } from "./config";

export {
  BPS_DENOMINATOR,
  DIGGO_CONFIG,
  DIGGO_CONFIG_DEFAULTS,
  DISCOVERY_DEFAULTS,
  GAMEPLAY_DEFAULTS,
  createDiggoConfig,
  deepFreeze,
} from "./config";

export type {
  CrewComponent,
  CrewConfig,
  CrewLevels,
  CrewTierConfig,
  DeepPartial,
  DiggoConfig,
  DiscoveryConfig,
  DiscoveryDefaults,
  DiscoveryRarity,
  EconomyConfig,
  GameplayDefaults,
  MaturityRampPoint,
  OreConfig,
  OreSource,
  RarityConfig,
  RarityTierConfig,
  RewardState,
  RiskConfig,
  RiskLevel,
  RiskResponse,
  RiskSignalName,
  StreakConfig,
  StreakMilestoneConfig,
  TimeConfig,
  TrustConfig,
} from "./config";

export * from "./crew";
export * from "./ore";
export * from "./streak";
export * from "./rewardIndex";
export * from "./rarity";
export * from "./risk";
export * from "./discovery";
export * from "./random";

/** Legacy shape of a discovery rarity row, derived from the central config. */
export interface RarityTier {
  rarity: DiscoveryRarity;
  cumulativeChance: number;
  valueUsd: number;
}

export const DISCOVERY_RARITY_TABLE: RarityTier[] = DIGGO_CONFIG.rarity.tiers.map((tier) => ({
  rarity: tier.rarity,
  cumulativeChance: tier.cumulativeChance,
  valueUsd: tier.valueUsd,
}));

export const CREW_TIERS = DIGGO_CONFIG.crew.tiers;

/**
 * Legacy helper: converts a target USD value into token units using a spot
 * price. New code should use normalizedDiscoveryAmount with a robust price and
 * a token eligibility score, since this function does not defend against a
 * manipulated or illiquid spot price on its own.
 */
export function discoveryTokenAmount(valueUsd: number, priceUsd: number): number {
  if (valueUsd <= 0 || !Number.isFinite(priceUsd) || priceUsd <= 0) return 0;
  return valueUsd / priceUsd;
}

