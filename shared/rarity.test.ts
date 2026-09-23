import { describe, expect, it } from "vitest";
import { DIGGO_CONFIG, createDiggoConfig } from "./config";
import {
  capRarityByBudget,
  discoveryValueUsd,
  healthScore,
  normalizedDiscoveryAmount,
  rarityTier,
  resolveRarity,
  robustPrice,
  rollDiscoveryRarity,
  tokenEligibilityScore,
  type PriceSample,
  type TokenEligibilityInput,
} from "./rarity";
import {
  DISCOVERY_PRICE_SCALE,
  coinPriceScaled,
  discoveryFacts,
  discoveryUnitsForValue,
  planDiscoveryPayout,
  resolveRarityTier,
  rolledRarityTier,
  type V2RarityTier
} from "./rarity";

describe("v2 derived discovery outcome (parity with math/rarity.rs)", () => {
  const TIERS: readonly V2RarityTier[] = [
    { cumulativeChanceBps: 7_000, valueLamports: 333_333n, minEligibilityScore: 0, minLiquidityLamports: 0n, minVolumeLamports: 0n },
    { cumulativeChanceBps: 9_000, valueLamports: 1_000_000n, minEligibilityScore: 20, minLiquidityLamports: 15_000_000_000n, minVolumeLamports: 3_000_000_000n },
    { cumulativeChanceBps: 9_700, valueLamports: 3_333_333n, minEligibilityScore: 40, minLiquidityLamports: 60_000_000_000n, minVolumeLamports: 15_000_000_000n },
    { cumulativeChanceBps: 9_950, valueLamports: 10_000_000n, minEligibilityScore: 60, minLiquidityLamports: 300_000_000_000n, minVolumeLamports: 60_000_000_000n },
    { cumulativeChanceBps: 9_995, valueLamports: 33_333_333n, minEligibilityScore: 80, minLiquidityLamports: 1_500_000_000_000n, minVolumeLamports: 300_000_000_000n },
    { cumulativeChanceBps: 10_000, valueLamports: 133_333_333n, minEligibilityScore: 92, minLiquidityLamports: 6_000_000_000_000n, minVolumeLamports: 1_200_000_000_000n }
  ];

  const THIN = {
    tokenReserve: 1_000_000_000n,
    solReserve: 100_000_000n,
    virtualSolReserve: 30_000_000_000n,
    graduationTarget: 100_000_000_000n,
    discoveryReserveTotal: 10_000_000n,
    discoveryRemaining: 10_000_000n,
    discoveryEpochBudget: 1_000_000n,
    discoveryEpochSpent: 0n
  };

  const RICH = {
    ...THIN,
    tokenReserve: 1_000_000_000_000n,
    solReserve: 2_000_000_000_000n,
    virtualSolReserve: 5_000_000_000_000n,
    graduationTarget: 1_000_000_000_000n,
    discoveryReserveTotal: 1_000_000_000n,
    discoveryRemaining: 1_000_000_000n,
    discoveryEpochBudget: 100_000_000n
  };

  it("matches the Rust tier-selection vectors", () => {
    const VECTORS = [
      { rollBps: 0, tier: 0 },
      { rollBps: 6_999, tier: 0 },
      { rollBps: 7_000, tier: 1 },
      { rollBps: 8_999, tier: 1 },
      { rollBps: 9_000, tier: 2 },
      { rollBps: 9_999, tier: 5 }
    ];
    for (const vector of VECTORS) {
      expect(rolledRarityTier(TIERS, vector.rollBps)).toBe(vector.tier);
    }
    expect(rolledRarityTier([{ ...TIERS[0], cumulativeChanceBps: 5_000 }], 5_000)).toBeNull();
  });

  it("downgrades an illiquid coin rather than refusing it", () => {
    const facts = discoveryFacts(THIN);
    expect(facts.eligibilityScore).toBeLessThan(60);
    expect(resolveRarityTier(TIERS, 5, facts)).toBe(0);
    const rich = discoveryFacts(RICH);
    expect(rich.eligibilityScore).toBe(100);
    expect(resolveRarityTier(TIERS, 5, rich)).toBe(5);
  });

  it("reads its price from the coin's own market and never below the average", () => {
    expect(coinPriceScaled(THIN)).toBe((30_100_000_000n * DISCOVERY_PRICE_SCALE) / 1_000_000_000n);
    // A crashed marginal price does not lower the price the payout is priced at.
    const crashed = {
      ...THIN,
      twapLastUpdateSlot: 1_000_000n,
      twapCumPriceLamportsPerUnit: 1_000n * DISCOVERY_PRICE_SCALE * 1_000_000n,
      solReserve: 1n,
      virtualSolReserve: 1n
    };
    expect(coinPriceScaled(crashed)).toBe(1_000n * DISCOVERY_PRICE_SCALE);
    expect(coinPriceScaled({ ...THIN, tokenReserve: 0n, solReserve: 0n, virtualSolReserve: 0n })).toBeNull();
  });

  it("rounds units down and never pays more than the value class", () => {
    expect(discoveryUnitsForValue(THIN, 333_333n)).toBe(11_074n);
    const price = coinPriceScaled(THIN)!;
    expect(11_074n * price).toBeLessThanOrEqual(333_333n * DISCOVERY_PRICE_SCALE);
    expect(discoveryUnitsForValue(THIN, 0n)).toBe(0n);
  });

  it("clamps a payout to the reserve, the per-call ceiling and the epoch budget", () => {
    const digest = new Uint8Array(32);
    const payout = planDiscoveryPayout({ tiers: TIERS, discoveryMaxBps: 100, coin: RICH, digest });
    expect(payout.units).toBeGreaterThan(0n);
    expect(payout.units).toBeLessThanOrEqual(RICH.discoveryRemaining);
    expect(payout.units).toBeLessThanOrEqual(RICH.discoveryEpochBudget);
    expect(payout.valueLamports).toBeGreaterThan(0n);

    const spent = planDiscoveryPayout({
      tiers: TIERS,
      discoveryMaxBps: 100,
      coin: { ...RICH, discoveryEpochSpent: RICH.discoveryEpochBudget },
      digest
    });
    expect(spent.units).toBe(0n);
    expect(spent.valueLamports).toBe(0n);
  });
});


const NOW = 1_700_000_000;
const healthy = { mintAuthorityRevoked: true, freezeAuthorityRevoked: true, liquidityLocked: true, tradingEnabled: true };

const deepToken: TokenEligibilityInput = {
  liquidityUsd: 2_000_000,
  volume24hUsd: 500_000,
  tradeCount24h: 5_000,
  reserveAvailableUsd: 50_000,
  priceConfidence: 1,
  health: healthy,
};

const thinToken: TokenEligibilityInput = {
  liquidityUsd: 300_000,
  volume24hUsd: 60_000,
  tradeCount24h: 600,
  reserveAvailableUsd: 6_000,
  priceConfidence: 0.8,
  health: healthy,
};

/** A very expensive unit price with no liquidity, activity or reserve. */
const illiquidExpensive: TokenEligibilityInput = {
  liquidityUsd: 50,
  volume24hUsd: 0,
  tradeCount24h: 0,
  reserveAvailableUsd: 1,
  priceConfidence: 0.1,
  health: { ...healthy, mintAuthorityRevoked: false, freezeAuthorityRevoked: false, liquidityLocked: false },
};

function sample(priceUsd: number, secondsAgo: number, volumeUsd = 1_000): PriceSample {
  return { priceUsd, timestamp: NOW - secondsAgo, volumeUsd };
}

describe("discovery rarity table", () => {
  it("uses the configured probability ladder", () => {
    expect(DIGGO_CONFIG.rarity.tiers.map((tier) => tier.cumulativeChance)).toEqual([
      0.7, 0.9, 0.97, 0.995, 0.9995, 1,
    ]);
    expect(DIGGO_CONFIG.rarity.tiers.map((tier) => tier.valueUsd)).toEqual([0.05, 0.15, 0.5, 1.5, 5, 20]);
  });

  it("rolls rarity from a server-supplied uniform draw", () => {
    expect(rollDiscoveryRarity(0)).toBe("common");
    expect(rollDiscoveryRarity(0.699999)).toBe("common");
    expect(rollDiscoveryRarity(0.7)).toBe("uncommon");
    expect(rollDiscoveryRarity(0.9)).toBe("rare");
    expect(rollDiscoveryRarity(0.97)).toBe("epic");
    expect(rollDiscoveryRarity(0.995)).toBe("legendary");
    expect(rollDiscoveryRarity(0.9995)).toBe("mythic");
    expect(rollDiscoveryRarity(0.99999999)).toBe("mythic");
    expect(() => rollDiscoveryRarity(1)).toThrow();
    expect(() => rollDiscoveryRarity(-0.001)).toThrow();
    expect(() => rollDiscoveryRarity(Number.NaN)).toThrow();
  });

  it("honours a reconfigured ladder", () => {
    const flat = createDiggoConfig({
      rarity: {
        tiers: [
          { rarity: "common", cumulativeChance: 0.5, valueUsd: 0.01, minEligibilityScore: 0, minLiquidityUsd: 0, minVolume24hUsd: 0 },
          { rarity: "mythic", cumulativeChance: 1, valueUsd: 1, minEligibilityScore: 0, minLiquidityUsd: 0, minVolume24hUsd: 0 },
        ],
      },
    });
    expect(rollDiscoveryRarity(0.49, flat)).toBe("common");
    expect(rollDiscoveryRarity(0.5, flat)).toBe("mythic");
  });

  it("exposes rarity value classes", () => {
    expect(discoveryValueUsd("mythic")).toBe(20);
    expect(rarityTier("common").rarity).toBe("common");
    expect(() => rarityTier("godlike" as "common")).toThrow();
  });
});

describe("token eligibility score", () => {
  it("ranks liquid, active, healthy tokens above thin ones", () => {
    const deep = tokenEligibilityScore(deepToken);
    const thin = tokenEligibilityScore(thinToken);
    const dead = tokenEligibilityScore(illiquidExpensive);
    expect(deep).toBeGreaterThan(thin);
    expect(thin).toBeGreaterThan(dead);
    expect(deep).toBeGreaterThanOrEqual(92);
    expect(dead).toBeLessThan(DIGGO_CONFIG.rarity.tiers[1].minEligibilityScore);
  });

  it("penalises unhealthy token flags", () => {
    expect(healthScore(healthy)).toBe(1);
    expect(healthScore({ ...healthy, mintAuthorityRevoked: false })).toBeLessThan(1);
    expect(healthScore({ ...healthy, transferRestricted: true })).toBeLessThan(1);
    expect(healthScore({
      mintAuthorityRevoked: false,
      freezeAuthorityRevoked: false,
      liquidityLocked: false,
      tradingEnabled: false,
      transferRestricted: true,
    })).toBe(0);
    expect(tokenEligibilityScore({ ...deepToken, health: { ...healthy, tradingEnabled: false } })).toBeLessThan(
      tokenEligibilityScore(deepToken),
    );
  });
});

describe("rarity is not token price", () => {
  it("never lets an illiquid expensive token become Mythic", () => {
    const resolution = resolveRarity("mythic", illiquidExpensive);
    expect(resolution.rarity).toBe("common");
    expect(resolution.downgraded).toBe(true);
    expect(resolution.reason).not.toBe("ok");
  });

  it("downgrades a deep-but-not-deep-enough token one class", () => {
    const resolution = resolveRarity("mythic", thinToken);
    expect(resolution.rarity).toBe("legendary");
    expect(resolution.downgraded).toBe(true);
  });

  it("allows a genuinely deep token to reach Mythic", () => {
    const resolution = resolveRarity("mythic", deepToken);
    expect(resolution.rarity).toBe("mythic");
    expect(resolution.downgraded).toBe(false);
    expect(resolution.reason).toBe("ok");
    expect(resolveRarity("common", illiquidExpensive).rarity).toBe("common");
  });

  it("pays nothing out when price confidence is too low, however deep the token", () => {
    const lowConfidence = { ...deepToken, priceConfidence: 0 };
    expect(tokenEligibilityScore(lowConfidence)).toBeLessThan(tokenEligibilityScore(deepToken));
    const unreliable = {
      priceUsd: 1,
      medianPriceUsd: 1,
      twapUsd: 1,
      maxDeviationBps: 1_499,
      sampleCount: 3,
      confidence: 0.4,
    };
    expect(normalizedDiscoveryAmount("mythic", unreliable)).toBeNull();
    const thin = { ...deepToken, liquidityUsd: 20_000, volume24hUsd: 1_000, priceConfidence: 0 };
    expect(resolveRarity("mythic", thin).rarity).not.toBe("mythic");
  });
});

describe("robust price", () => {
  it("uses a volume-weighted median of recent samples", () => {
    const price = robustPrice([sample(1, 0), sample(1.02, 600), sample(0.98, 1_200)], NOW);
    expect(price).not.toBeNull();
    expect(price?.priceUsd).toBe(1);
    expect(price?.maxDeviationBps).toBeCloseTo(200, 6);
    expect(price?.confidence).toBeCloseTo(1 - 200 / DIGGO_CONFIG.rarity.robustPrice.maxDeviationBps, 6);
    expect(price?.sampleCount).toBe(3);
    expect(price?.twapUsd).toBeGreaterThan(0);
  });

  it("returns null when samples disagree beyond the configured deviation", () => {
    expect(robustPrice([sample(1, 0), sample(1, 600), sample(3, 1_200)], NOW)).toBeNull();
  });

  it("returns null without enough fresh samples", () => {
    expect(robustPrice([sample(1, 0), sample(1, 60)], NOW)).toBeNull();
    const stale = DIGGO_CONFIG.rarity.robustPrice.lookbackSeconds + 1;
    expect(robustPrice([sample(1, 0), sample(1, 60), sample(1, stale)], NOW)).toBeNull();
  });

  it("ignores invalid samples", () => {
    expect(
      robustPrice([sample(1, 0), sample(1, 60), sample(1, 120), sample(0, 10), sample(Number.NaN, 10)], NOW)?.sampleCount,
    ).toBe(3);
  });

  it("honours a configurable deviation band", () => {
    const strict = createDiggoConfig({ rarity: { robustPrice: { maxDeviationBps: 100 } } });
    expect(robustPrice([sample(1, 0), sample(1.02, 600), sample(0.98, 1_200)], NOW, strict)).toBeNull();
  });
});

describe("value normalization", () => {
  const price = (priceUsd: number, confidence = 1) => ({
    priceUsd,
    medianPriceUsd: priceUsd,
    twapUsd: priceUsd,
    maxDeviationBps: 0,
    sampleCount: 5,
    confidence,
  });

  it("pays fewer units of an expensive token and more of a cheap one", () => {
    const expensive = normalizedDiscoveryAmount("mythic", price(1_000));
    const cheap = normalizedDiscoveryAmount("mythic", price(0.001));
    expect(expensive?.amount).toBe(0.02);
    expect(cheap?.amount).toBe(20_000);
    expect(cheap!.amount).toBeGreaterThan(expensive!.amount);
    expect(expensive?.valueUsd).toBe(20);
  });

  it("returns null instead of a manipulated amount when confidence is low", () => {
    expect(normalizedDiscoveryAmount("rare", price(1, DIGGO_CONFIG.discovery.minimumPriceConfidence - 0.01))).toBeNull();
    expect(normalizedDiscoveryAmount("rare", null)).toBeNull();
    expect(normalizedDiscoveryAmount("rare", price(0))).toBeNull();
  });

  it("caps the payout at the allowed budget", () => {
    const capped = normalizedDiscoveryAmount("mythic", price(1), DIGGO_CONFIG, 0.5);
    expect(capped?.valueUsd).toBe(0.5);
    expect(capped?.amount).toBe(0.5);
    expect(normalizedDiscoveryAmount("mythic", price(1), DIGGO_CONFIG, 0)).toBeNull();
  });

  it("never pays a sub-dust amount", () => {
    expect(normalizedDiscoveryAmount("common", price(1_000_000_000))).toBeNull();
  });

  it("caps rarity by the remaining budget", () => {
    expect(capRarityByBudget("mythic", 0)).toBe("common");
    expect(capRarityByBudget("mythic", 0.05)).toBe("common");
    expect(capRarityByBudget("mythic", 0.5)).toBe("rare");
    expect(capRarityByBudget("mythic", 20)).toBe("mythic");
    expect(capRarityByBudget("common", 20)).toBe("common");
  });
});
