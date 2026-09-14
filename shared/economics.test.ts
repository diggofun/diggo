import { describe, expect, it } from "vitest";
import {
  clampRewardToReserve,
  crewPower,
  crewTier,
  discoveryEligible,
  discoveryTokenAmount,
  discoveryValueUsd,
  maturityBps,
  nextStreak,
  oreForActiveSeconds,
  proportionalReward,
  reducedReward,
  rollDiscoveryRarity,
  upgradeOreCost,
} from "./economics";

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
    expect(maturityBps(3 * 86_400)).toBe(5_000);
    expect(maturityBps(7 * 86_400)).toBe(10_000);
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
    expect(discoveryEligible(6 * 86_400, 5, 2)).toBe(false);
    expect(discoveryEligible(7 * 86_400, 5, 2)).toBe(true);
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
