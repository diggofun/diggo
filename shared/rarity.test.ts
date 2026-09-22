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
