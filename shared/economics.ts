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
// `crewTotalLevel` is the one name two of the star exports above both provide. The crew module
// owns it (it is the crew's total, and discovery reads it for its eligibility floor), so it is
// re-exported explicitly here rather than left ambiguous.
export { crewTotalLevel } from "./crew";
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

// ---- v2: what a launch and a trade cost on-chain -------------------------------------------
//
// The product constraint the whole v2 design bends to: the owner pays for the program once, and
// creating a coin costs about a cent of SOL which the creator pays by default. Sponsorship
// events can move that cost onto a sponsor vault, and the only deposit anyone else makes is the
// player's refundable bond. These numbers are measured in the program's own tests
// (the_launch_rent_is_exactly_the_sum_of_the_three_accounts) rather than quoted.

/** Rent-exempt minimum of an account of this size: (size + 128) * 3,480 * 2 lamports. */
export function v2RentExemptLamports(size: number): bigint {
  return (BigInt(size) + 128n) * 6_960n;
}

/**
 * The three accounts a launch creates, and what the creator pays for them: the mint at the frozen
 * 438-byte `MINT_V2_SIZE` layout, the Coin at its 464-byte `Coin::SIZE` and the vault at 165.
 */
export const V2_LAUNCH_RENT_LAMPORTS = {
  mint: v2RentExemptLamports(438),
  coin: v2RentExemptLamports(464),
  vault: v2RentExemptLamports(165),
} as const;

/** 0.01009896 SOL: the whole launch, before transaction fees. */
export const V2_LAUNCH_RENT_TOTAL_LAMPORTS =
  V2_LAUNCH_RENT_LAMPORTS.mint +
  V2_LAUNCH_RENT_LAMPORTS.coin +
  V2_LAUNCH_RENT_LAMPORTS.vault;

/**
 * The mint's settled size for a maximal metadata, which is the same number as the funded layout:
 * the caps are the layout, so a shorter metadata reallocs the difference away.
 */
export const V2_MINT_SETTLED_SIZE = 438;

/**
 * The dollar figure the UI shows for a lamport cap, converted at display time. No instruction
 * consults a price: the caps' real value floats with the price of SOL, which is the accepted
 * trade-off of keeping a manipulable external input out of the program.
 */
export function v2CapUsd(lamports: bigint, solUsd: number): number {
  return (Number(lamports) / 1_000_000_000) * solUsd;
}

