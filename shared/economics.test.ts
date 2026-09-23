import { describe, expect, it } from "vitest";
import {
  BPS_DENOMINATOR,
  CREW_TIERS,
  DISCOVERY_DEFAULTS,
  DISCOVERY_RARITY_TABLE,
  GAMEPLAY_DEFAULTS,
  applyActivation,
  auditReserve,
  capRarityByBudget,
  clampRewardToReserve,
  crewPower,
  crewTier,
  discoveryEligible,
  discoveryTokenAmount,
  discoveryValueUsd,
  isEligibleForBlock,
  maturityBps,
  nextStreak,
  normalizedDiscoveryAmount,
  oreForActiveSeconds,
  oreFromActivation,
  proportionalReward,
  reducedReward,
  resolveRarity,
  robustPrice,
  rollDiscoveryRarity,
  upgradeOreCost,
  type ActivationRecord,
} from "./economics";

const DAY = 86_400;

describe("Diggo economics", () => {
  it("uses proportional mining rewards", () => {
    expect(proportionalReward(10_000, 4_000, 2_000_000)).toBe(20);
  });

  it("reduces epoch reward by 25%", () => {
    expect(reducedReward(10_000)).toBe(7_500);
  });

  it("uses ORE-only upgrade costs", () => {
    expect(upgradeOreCost("miners", 1)).toBe(120);
    expect(upgradeOreCost("drills", 10)).toBeGreaterThan(upgradeOreCost("drills", 9));
  });

  it("never distributes above the reserve", () => {
    expect(clampRewardToReserve(10_000, 2_500)).toBe(2_500);
  });

  it("ramps progression efficiency with account maturity", () => {
    expect(maturityBps(0)).toBe(2_000);
    expect(maturityBps(3 * DAY)).toBe(5_000);
    expect(maturityBps(7 * DAY)).toBe(10_000);
    expect(oreForActiveSeconds(3_600, 0)).toBe(4);
  });

  it("applies diminishing returns to crew power", () => {
    const starter = crewPower({ miners: 1, drills: 1, carts: 1, foreman: 1, storage: 1 });
    const veteran = crewPower({ miners: 100, drills: 100, carts: 100, foreman: 100, storage: 100 });
    expect(starter).toBeGreaterThan(0);
    expect(veteran / starter).toBeLessThan(100);
  });

  it("preserves a streak within grace and consumes one earned freeze after it", () => {
    expect(nextStreak(1_000, 1_000 + 30 * 3_600, 6, 0)).toEqual({ streak: 7, freezes: 0, usedFreeze: false });
    expect(nextStreak(1_000, 1_000 + 48 * 3_600, 6, 1)).toEqual({ streak: 7, freezes: 0, usedFreeze: true });
  });

  it("gates valuable discoveries behind time and progression", () => {
    expect(discoveryEligible(6 * DAY, 5, 2)).toBe(false);
    expect(discoveryEligible(7 * DAY, 5, 2)).toBe(true);
  });

  it("rolls discovery rarity from a server-supplied random draw, weighted toward common", () => {
    expect(rollDiscoveryRarity(0)).toBe("common");
    expect(rollDiscoveryRarity(0.69)).toBe("common");
    expect(rollDiscoveryRarity(0.71)).toBe("uncommon");
    expect(rollDiscoveryRarity(0.999999)).toBe("mythic");
    expect(() => rollDiscoveryRarity(1)).toThrow();
    expect(() => rollDiscoveryRarity(-0.1)).toThrow();
  });

  it("prices discoveries in token units from a target USD value, never trusting a zero/invalid price", () => {
    expect(discoveryTokenAmount(discoveryValueUsd("common"), 0.05)).toBe(1);
    expect(discoveryTokenAmount(5, 0)).toBe(0);
    expect(discoveryTokenAmount(-1, 1)).toBe(0);
  });

  it("promotes crew tier only once the crew's combined levels clear a threshold", () => {
    const starter = { miners: 1, drills: 1, carts: 1, foreman: 1, storage: 1 };
    expect(crewTier(starter).tier).toBe(1);
    const veteran = { miners: 20, drills: 20, carts: 20, foreman: 20, storage: 20 };
    expect(crewTier(veteran).tier).toBeGreaterThan(1);
  });
});

describe("Diggo economics facade", () => {
  it("keeps the legacy table and constant exports working", () => {
    expect(BPS_DENOMINATOR).toBe(10_000);
    expect(GAMEPLAY_DEFAULTS.activationSeconds).toBe(DAY);
    expect(GAMEPLAY_DEFAULTS.activationOre).toBe(50);
    expect(DISCOVERY_DEFAULTS.accountDailyCapUsd).toBe(0.5);
    expect(DISCOVERY_RARITY_TABLE).toHaveLength(6);
    expect(DISCOVERY_RARITY_TABLE[0]).toEqual({ rarity: "common", cumulativeChance: 0.7, valueUsd: 0.05 });
    expect(CREW_TIERS).toHaveLength(6);
    expect(CREW_TIERS[0].name).toBe("Backyard Diggers");
  });

  it("keeps upgrade costs free of any payment parameter", () => {
    // Arity guard: the only inputs are a component and a level. There is no
    // "pay SOL / USDC / memecoin" path that could buy mining power.
    expect(upgradeOreCost.length).toBe(2);
    expect(crewPower.length).toBe(1);
  });

  it("runs the daily activation loop end to end", () => {
    const record: ActivationRecord = {
      activatedAt: null,
      activeUntil: null,
      lastActivationAt: null,
      streak: 0,
      longestStreak: 0,
      streakFreezes: 0,
    };
    const first = applyActivation(record, 0);
    expect(first.streak).toBe(1);
    expect(isEligibleForBlock(first.window.activeUntil, DAY / 2, first.window.activatedAt)).toBe(true);
    expect(isEligibleForBlock(first.window.activeUntil, first.window.activeUntil, first.window.activatedAt)).toBe(false);

    const seventh = applyActivation(
      { ...record, lastActivationAt: 0, streak: 6, longestStreak: 6, streakFreezes: 0 },
      24 * 3_600,
    );
    expect(seventh.streak).toBe(7);
    expect(seventh.rewards.badges).toContain("WEEK_ONE");
    expect(seventh.rewards.ore).toBe(250);
    expect(seventh.rewards.freezes).toBe(1);
    expect(seventh.freezes).toBe(1);
    expect(oreFromActivation(0)).toBeLessThan(oreFromActivation(7 * DAY));
  });

  it("never rewards a raw streak with a real-token multiplier", () => {
    for (let streak = 1; streak <= 400; streak += 1) {
      const rewards = applyActivation(
        { activatedAt: 0, activeUntil: DAY, lastActivationAt: 0, streak, longestStreak: streak, streakFreezes: 0 },
        DAY,
      ).rewards;
      expect(Object.keys(rewards).sort()).toEqual(["badges", "freezes", "ore", "titles", "xp"]);
    }
  });

  it("runs a discovery from roll to normalized payout, refusing weak prices", () => {
    const price = robustPrice(
      [
        { priceUsd: 0.01, timestamp: 1_000, volumeUsd: 5_000 },
        { priceUsd: 0.0101, timestamp: 1_500, volumeUsd: 4_000 },
        { priceUsd: 0.0099, timestamp: 1_900, volumeUsd: 6_000 },
      ],
      2_000,
    );
    expect(price).not.toBeNull();

    const token = {
      liquidityUsd: 2_000_000,
      volume24hUsd: 500_000,
      tradeCount24h: 5_000,
      reserveAvailableUsd: 50_000,
      priceConfidence: price!.confidence,
      health: {
        mintAuthorityRevoked: true,
        freezeAuthorityRevoked: true,
        liquidityLocked: true,
        tradingEnabled: true,
      },
    };
    const rolled = rollDiscoveryRarity(0.9996);
    expect(rolled).toBe("mythic");
    const resolution = resolveRarity(rolled, token);
    expect(resolution.rarity).toBe("mythic");
    const budget = capRarityByBudget(resolution.rarity, 0.2);
    expect(budget).toBe("uncommon");
    const payout = normalizedDiscoveryAmount(budget, price, undefined, 0.2);
    expect(payout).not.toBeNull();
    expect(payout?.valueUsd).toBeLessThanOrEqual(0.2);
    expect(payout?.amount).toBeGreaterThan(0);
  });

  it("keeps quote-based normalization conservative for a thin pool", () => {
    const thin = robustPrice(
      [
        { priceUsd: 1, timestamp: 1_000 },
        { priceUsd: 1, timestamp: 1_500 },
        { priceUsd: 5, timestamp: 1_900 },
      ],
      2_000,
    );
    expect(thin).toBeNull();
  });

  it("documents the reserve conservation invariant used by the index accounting", () => {
    // auditReserve is covered in rewardIndex.test.ts; this guards the exported surface.
    expect(typeof auditReserve).toBe("function");
  });
});
