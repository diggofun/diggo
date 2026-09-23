import {
  BPS_DENOMINATOR,
  DIGGO_CONFIG,
  type DiggoConfig,
  type DiscoveryRarity,
  type RarityTierConfig,
  type RobustPriceConfig,
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

/**
 * One observation of a token's price from a named source. External sources (a DEX aggregator, a
 * Pyth SOL/USD feed converted through the token's SOL price) are single quotes; the token's own
 * trade history arrives separately as a pre-combined robust price, because it is already a series.
 */
export interface PriceQuote {
  /** Stable source id: "jupiter", "pyth", "internal-twap", ... Used for dedup and reporting. */
  source: string;
  priceUsd: number;
  /** When the *source* observed this price, unix seconds. Not when we fetched it. */
  observedAt: number;
  /** Optional traded value behind the observation, used to weight it in the median. */
  weightUsd?: number;
  /** Source reliability in [0, 1]; scales the combined confidence. Defaults to 1. */
  reliability?: number;
  /** True when the quote came from a cache rather than a live read. Reporting only. */
  cached?: boolean;
}

/** The token's own price history, already reduced to a robustness-checked central value. */
export interface InternalPriceSource {
  price: RobustPrice;
  /** Timestamp of the newest sample behind it. */
  observedAt: number;
  /** Traded value behind the samples, used as the source's weight. */
  weightUsd?: number;
}

export interface PriceSourceSet {
  internal: InternalPriceSource | null;
  external: readonly PriceQuote[];
}

/** Staleness and gating rules for combining sources, on top of robustPrice's own settings. */
export interface SourcePriceRules extends RobustPriceConfig {
  /**
   * Hard staleness limit. A source observed longer ago than this is dropped even when it still sits
   * inside the lookback window, because a price old enough to be overtaken by the market is not
   * evidence of what a discovery is worth right now.
   */
  maxStalenessSeconds: number;
  /** Age up to which an observation counts as fully fresh, so ordinary cron lag is not penalized. */
  freshSeconds: number;
  /** Below this combined confidence no price is returned at all. */
  minimumConfidence: number;
  /**
   * How many independent external sources a price must have before it is usable. 0 keeps a
   * deployment without oracle credentials working off its own trade history; raising it is the
   * hardening knob once Jupiter/Pyth are wired up.
   */
  minimumExternalSources: number;
}

export const SOURCE_PRICE_RULES: SourcePriceRules = Object.freeze({
  lookbackSeconds: 3_600,
  minimumSamples: 3,
  maxDeviationBps: 1_500,
  volumeWeighted: true,
  maxStalenessSeconds: 900,
  freshSeconds: 300,
  minimumConfidence: 0.6,
  minimumExternalSources: 0,
});

/**
 * Effective rules: the shipped defaults, overlaid with the deployment's own robustPrice settings
 * (so an operator override still applies), overlaid with the caller's explicit overrides.
 */
export function sourcePriceRules(
  config: DiggoConfig = DIGGO_CONFIG,
  overrides: Partial<SourcePriceRules> = {},
): SourcePriceRules {
  return { ...SOURCE_PRICE_RULES, ...config.rarity.robustPrice, ...overrides };
}

export type PriceSourceRejection = "invalid" | "future" | "stale" | "superseded";

export interface RejectedPriceSource {
  source: string;
  reason: PriceSourceRejection;
}

export interface CombinedPrice extends RobustPrice {
  /** Sources that made it into the median, newest first is not guaranteed. */
  sources: readonly string[];
  /** Sources that were dropped, with the reason, for logging and operator visibility. */
  rejected: readonly RejectedPriceSource[];
  /** Timestamp of the freshest observation that survived. */
  observedAt: number;
  /** 0..1: 1 means the freshest evidence is within freshSeconds of now. */
  freshness: number;
  /** Number of independent price sources behind the median (internal counts as one). */
  sourceCount: number;
}

/** Tolerance for a source that reports an observation a moment in the future. */
const FUTURE_TOLERANCE_SECONDS = 5;

/**
 * Combines the token's internal price history with external oracle quotes into one robust price.
 *
 * The rules are the same shape as robustPrice's, applied across sources instead of across samples:
 * at most one quote per source (the newest) so no single source can vote twice, staleness and
 * deviation gates that fail closed, and a confidence output that folds in how well the sources
 * agree, how fresh the evidence is and how reliable each source is. Returns null - meaning no
 * discovery is paid - when there is no usable evidence, when the sources disagree more than the
 * configured band, or when the resulting confidence is below the configured minimum.
 */
export function combinePriceSources(
  set: PriceSourceSet,
  now: number,
  config: DiggoConfig = DIGGO_CONFIG,
  overrides: Partial<SourcePriceRules> = {},
): CombinedPrice | null {
  const rules = sourcePriceRules(config, overrides);
  const rejected: RejectedPriceSource[] = [];
  const candidates: {
    source: string;
    priceUsd: number;
    observedAt: number;
    weight: number;
    reliability: number;
  }[] = [];
  const band = rules.maxDeviationBps > 0 ? rules.maxDeviationBps : 1;

  const admit = (source: string, priceUsd: number, observedAt: number, weight: number, reliability: number): void => {
    if (!Number.isFinite(priceUsd) || priceUsd <= 0 || !Number.isFinite(observedAt)) {
      rejected.push({ source, reason: "invalid" });
      return;
    }
    if (observedAt > now + FUTURE_TOLERANCE_SECONDS) {
      rejected.push({ source, reason: "future" });
      return;
    }
    if (now - observedAt > rules.maxStalenessSeconds) {
      rejected.push({ source, reason: "stale" });
      return;
    }
    candidates.push({ source, priceUsd, observedAt, weight, reliability });
  };

  if (set.internal) {
    admit(
      "internal",
      set.internal.price.medianPriceUsd,
      set.internal.observedAt,
      typeof set.internal.weightUsd === "number" && set.internal.weightUsd > 0 ? set.internal.weightUsd : 1,
      1,
    );
  }

  // Newest quote per external source wins; the rest are reported as superseded so an operator can
  // see that a source spoke twice.
  const newestPerSource = new Map<string, PriceQuote>();
  for (const quote of set.external) {
    const source = quote && typeof quote.source === "string" && quote.source.length > 0 ? quote.source : "unknown";
    if (source === "internal") {
      // Internal evidence has to come through the internal channel, which applies robustPrice's
      // sample-count and deviation gates; an external caller cannot bypass that.
      rejected.push({ source, reason: "invalid" });
      continue;
    }
    const previous = newestPerSource.get(source);
    if (!previous || quote.observedAt > previous.observedAt) {
      if (previous) rejected.push({ source, reason: "superseded" });
      newestPerSource.set(source, quote);
    } else {
      rejected.push({ source, reason: "superseded" });
    }
  }
  for (const [source, quote] of newestPerSource) {
    const reliability =
      typeof quote.reliability === "number" && Number.isFinite(quote.reliability)
        ? clamp01(quote.reliability)
        : 1;
    admit(
      source,
      quote.priceUsd,
      quote.observedAt,
      typeof quote.weightUsd === "number" && quote.weightUsd > 0 ? quote.weightUsd : 1,
      reliability,
    );
  }

  if (candidates.length === 0) return null;
  const externalCount = candidates.filter((candidate) => candidate.source !== "internal").length;
  if (rules.minimumExternalSources > 0 && externalCount < rules.minimumExternalSources) return null;

  const weightOf = (candidate: (typeof candidates)[number]): number =>
    rules.volumeWeighted ? candidate.weight : 1;
  const byPrice = [...candidates].sort((a, b) => a.priceUsd - b.priceUsd);
  const totalWeight = byPrice.reduce((sum, candidate) => sum + weightOf(candidate), 0);
  let median = byPrice[byPrice.length - 1].priceUsd;
  let accumulated = 0;
  for (const candidate of byPrice) {
    accumulated += weightOf(candidate);
    if (accumulated >= totalWeight / 2) {
      median = candidate.priceUsd;
      break;
    }
  }

  let maxDeviationBps = 0;
  for (const candidate of candidates) {
    const deviation = (Math.abs(candidate.priceUsd - median) / median) * BPS_DENOMINATOR;
    if (deviation > maxDeviationBps) maxDeviationBps = deviation;
  }
  // Fail closed: sources that disagree this much cannot value a real payout.
  if (maxDeviationBps > rules.maxDeviationBps) return null;

  const observedAt = candidates.reduce((newest, candidate) => Math.max(newest, candidate.observedAt), 0);
  const age = Math.max(0, now - observedAt);
  const freshness = clamp01(
    1 - Math.max(0, age - rules.freshSeconds) / Math.max(1, rules.maxStalenessSeconds - rules.freshSeconds),
  );
  const averageReliability =
    candidates.reduce((sum, candidate) => sum + candidate.reliability, 0) / candidates.length;
  const internalConfidence = set.internal ? clamp01(set.internal.price.confidence) : 1;
  const confidence = clamp01(
    (1 - maxDeviationBps / band) * freshness * averageReliability * internalConfidence,
  );
  if (confidence < rules.minimumConfidence) return null;

  return {
    priceUsd: median,
    medianPriceUsd: median,
    twapUsd: set.internal ? set.internal.price.twapUsd : median,
    maxDeviationBps,
    sampleCount: set.internal ? set.internal.price.sampleCount : candidates.length,
    confidence,
    sources: candidates.map((candidate) => candidate.source),
    rejected,
    observedAt,
    freshness,
    sourceCount: candidates.length,
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
