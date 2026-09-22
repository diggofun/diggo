import {
  BPS_DENOMINATOR,
  DIGGO_CONFIG,
  type DiggoConfig,
  type DiscoveryRarity,
  type RarityTierConfig,
} from "./config";

/**
 * Rarity, token eligibility and value normalization (spec 25, 26, 27).
 *
 * Rarity is a value class, never a function of the token unit price. An
 * illiquid or low-confidence token cannot reach a high rarity no matter how
 * expensive a single unit is, and the token amount is derived from a robust
 * price (volume-weighted median with a deviation gate), not from the spot price.
 */

export interface PriceSample {
  priceUsd: number;
  timestamp: number;
  volumeUsd?: number;
}

export interface RobustPrice {
  /** Conservative central price used for value normalization. */
  priceUsd: number;
  medianPriceUsd: number;
  /** Time weighted average price over the lookback window. */
  twapUsd: number;
  maxDeviationBps: number;
  sampleCount: number;
  /**
   * 0..1, where 1 means every sample sat exactly on the median and 0 means the
   * samples used the entire configured deviation band.
   */
  confidence: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Robust price from recent samples. Returns null when there is not enough data
 * or when the samples disagree more than the configured maximum deviation, so
 * that a manipulated small-pool price cannot normalize a discovery amount.
 */
export function robustPrice(
  samples: readonly PriceSample[],
  now: number,
  config: DiggoConfig = DIGGO_CONFIG,
): RobustPrice | null {
  const rules = config.rarity.robustPrice;
  const usable = samples.filter(
    (sample) =>
      Number.isFinite(sample.priceUsd) &&
      sample.priceUsd > 0 &&
      Number.isFinite(sample.timestamp) &&
      sample.timestamp <= now &&
      sample.timestamp >= now - rules.lookbackSeconds,
  );
  if (usable.length < rules.minimumSamples) return null;

  const byPrice = [...usable].sort((a, b) => a.priceUsd - b.priceUsd);
  const weightOf = (sample: PriceSample): number =>
    rules.volumeWeighted && typeof sample.volumeUsd === "number" && sample.volumeUsd > 0
      ? sample.volumeUsd
      : 1;
  const totalWeight = byPrice.reduce((sum, sample) => sum + weightOf(sample), 0);
  let median = byPrice[byPrice.length - 1].priceUsd;
  let accumulated = 0;
  for (const sample of byPrice) {
    accumulated += weightOf(sample);
    if (accumulated >= totalWeight / 2) {
      median = sample.priceUsd;
      break;
    }
  }

  const byTime = [...usable].sort((a, b) => a.timestamp - b.timestamp);
  let weightedPrice = 0;
  let weightedDuration = 0;
  for (let index = 0; index < byTime.length; index += 1) {
    const sample = byTime[index];
    const next = byTime[index + 1];
    const duration = next ? Math.max(1, next.timestamp - sample.timestamp) : Math.max(1, now - sample.timestamp);
    weightedPrice += sample.priceUsd * duration;
    weightedDuration += duration;
  }
  const twap = weightedDuration > 0 ? weightedPrice / weightedDuration : median;

  let maxDeviationBps = 0;
  for (const sample of usable) {
    const deviation = (Math.abs(sample.priceUsd - median) / median) * BPS_DENOMINATOR;
    if (deviation > maxDeviationBps) maxDeviationBps = deviation;
  }
  if (maxDeviationBps > rules.maxDeviationBps) return null;

  const band = rules.maxDeviationBps > 0 ? rules.maxDeviationBps : 1;
  return {
    priceUsd: median,
    medianPriceUsd: median,
    twapUsd: twap,
    maxDeviationBps,
    sampleCount: usable.length,
    confidence: clamp01(1 - maxDeviationBps / band),
  };
}

export interface TokenHealthFlags {
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  liquidityLocked: boolean;
  tradingEnabled: boolean;
  /** Set when a transfer restriction / honeypot check failed. */
  transferRestricted?: boolean;
}

export interface TokenEligibilityInput {
  liquidityUsd: number;
  volume24hUsd: number;
  tradeCount24h: number;
  reserveAvailableUsd: number;
  /** 0..1 confidence from robustPrice. */
  priceConfidence: number;
  health: TokenHealthFlags;
}

function logScore(value: number, reference: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (!Number.isFinite(reference) || reference <= 0) return 1;
  return clamp01(Math.log10(1 + value) / Math.log10(1 + reference));
}

export function healthScore(health: TokenHealthFlags, config: DiggoConfig = DIGGO_CONFIG): number {
  let failures = 0;
  if (!health.mintAuthorityRevoked) failures += 1;
  if (!health.freezeAuthorityRevoked) failures += 1;
  if (!health.liquidityLocked) failures += 1;
  if (!health.tradingEnabled) failures += 1;
  if (health.transferRestricted === true) failures += 1;
  return clamp01(1 - failures * config.rarity.healthFlagPenalty);
}

/** Blended, configurable eligibility score in [0, 100]. */
export function tokenEligibilityScore(
  input: TokenEligibilityInput,
  config: DiggoConfig = DIGGO_CONFIG,
): number {
  const weights = config.rarity.weights;
  const references = config.rarity.references;
  const blended =
    weights.liquidity * logScore(input.liquidityUsd, references.liquidityUsd) +
    weights.volume * logScore(input.volume24hUsd, references.volume24hUsd) +
    weights.activity * logScore(input.tradeCount24h, references.tradeCount24h) +
    weights.health * healthScore(input.health, config) +
    weights.reserve * logScore(input.reserveAvailableUsd, references.reserveUsd) +
    weights.priceConfidence * clamp01(input.priceConfidence);
  return Math.max(0, Math.min(100, Math.floor(blended * 100)));
}

export function rarityTier(
  rarity: DiscoveryRarity,
  config: DiggoConfig = DIGGO_CONFIG,
): RarityTierConfig {
  const tier = config.rarity.tiers.find((entry) => entry.rarity === rarity);
  if (!tier) throw new Error("Unknown discovery rarity");
  return tier;
}

/**
 * Rolls a discovery rarity from a caller-supplied uniform draw in [0, 1).
 * The draw must come from a server-side CSPRNG (see ./random), never from
 * Math.random() on the client, since this decides a real-token reward.
 */
export function rollDiscoveryRarity(
  randomUnitInterval: number,
  config: DiggoConfig = DIGGO_CONFIG,
): DiscoveryRarity {
  if (!Number.isFinite(randomUnitInterval) || randomUnitInterval < 0 || randomUnitInterval >= 1) {
    throw new Error("randomUnitInterval must be in [0, 1)");
  }
  for (const tier of config.rarity.tiers) {
    if (randomUnitInterval < tier.cumulativeChance) return tier.rarity;
  }
  return config.rarity.tiers[config.rarity.tiers.length - 1].rarity;
}

export function discoveryValueUsd(
  rarity: DiscoveryRarity,
  config: DiggoConfig = DIGGO_CONFIG,
): number {
  return rarityTier(rarity, config).valueUsd;
}

export type RarityDowngradeReason = "ok" | "eligibility_score" | "liquidity" | "volume";

export interface RarityResolution {
  rolled: DiscoveryRarity;
  rarity: DiscoveryRarity;
  eligibilityScore: number;
  downgraded: boolean;
  reason: RarityDowngradeReason;
}

/**
 * Applies token eligibility to a rolled rarity. Illiquid, inactive or
 * low-confidence tokens are downgraded, so an illiquid expensive token can
 * never resolve to a high rarity (spec 26).
 */
export function resolveRarity(
  rolled: DiscoveryRarity,
  input: TokenEligibilityInput,
  config: DiggoConfig = DIGGO_CONFIG,
): RarityResolution {
  const score = tokenEligibilityScore(input, config);
  const rolledIndex = config.rarity.tiers.findIndex((tier) => tier.rarity === rolled);
  const startIndex = rolledIndex < 0 ? 0 : rolledIndex;
  let reason: RarityDowngradeReason = "ok";
  for (let index = startIndex; index >= 0; index -= 1) {
    const tier = config.rarity.tiers[index];
    if (score < tier.minEligibilityScore) {
      if (reason === "ok") reason = "eligibility_score";
      continue;
    }
    if (input.liquidityUsd < tier.minLiquidityUsd) {
      if (reason === "ok") reason = "liquidity";
      continue;
    }
    if (input.volume24hUsd < tier.minVolume24hUsd) {
      if (reason === "ok") reason = "volume";
      continue;
    }
    return {
      rolled,
      rarity: tier.rarity,
      eligibilityScore: score,
      downgraded: tier.rarity !== rolled,
      reason,
    };
  }
  const fallback = config.rarity.tiers[0];
  return {
    rolled,
    rarity: fallback.rarity,
    eligibilityScore: score,
    downgraded: fallback.rarity !== rolled,
    reason: reason === "ok" ? "eligibility_score" : reason,
  };
}

/** Highest rarity whose target value fits the remaining budget (spec 64). */
export function capRarityByBudget(
  rarity: DiscoveryRarity,
  remainingBudgetUsd: number,
  config: DiggoConfig = DIGGO_CONFIG,
): DiscoveryRarity {
  if (!config.discovery.cappedRarityByBudget) return rarity;
  const budget = Number.isFinite(remainingBudgetUsd) ? remainingBudgetUsd : 0;
  let capped = config.rarity.tiers[0].rarity;
  for (const tier of config.rarity.tiers) {
    if (tier.valueUsd <= budget) capped = tier.rarity;
  }
  const requestedIndex = config.rarity.tiers.findIndex((tier) => tier.rarity === rarity);
  const cappedIndex = config.rarity.tiers.findIndex((tier) => tier.rarity === capped);
  if (requestedIndex < 0) return capped;
  return requestedIndex <= cappedIndex ? rarity : capped;
}

export interface NormalizedDiscoveryAmount {
  rarity: DiscoveryRarity;
  valueUsd: number;
  priceUsd: number;
  amount: number;
  decimals: number;
}

/**
 * Converts a rarity value class into token units using a robust price. Returns
 * null when price confidence is too low, which means no discovery is paid out
 * for that token instead of paying out a manipulated amount (spec 27, 55).
 */
export function normalizedDiscoveryAmount(
  rarity: DiscoveryRarity,
  price: RobustPrice | null,
  config: DiggoConfig = DIGGO_CONFIG,
  maxValueUsd?: number,
): NormalizedDiscoveryAmount | null {
  if (!price || !Number.isFinite(price.priceUsd) || price.priceUsd <= 0) return null;
  if (price.confidence < config.discovery.minimumPriceConfidence) return null;
  const tier = rarityTier(rarity, config);
  const requested = typeof maxValueUsd === "number" ? Math.min(tier.valueUsd, maxValueUsd) : tier.valueUsd;
  if (!Number.isFinite(requested) || requested <= 0) return null;
  const factor = Math.pow(10, config.rarity.amountDecimals);
  const amount = Math.floor((requested / price.priceUsd) * factor) / factor;
  if (amount <= 0) return null;
  return {
    rarity,
    valueUsd: requested,
    priceUsd: price.priceUsd,
    amount,
    decimals: config.rarity.amountDecimals,
  };
}

