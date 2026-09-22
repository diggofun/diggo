import { describe, expect, it } from "vitest";
import { DIGGO_CONFIG, createDiggoConfig, type CrewComponent } from "./config";
import {
  CREW_COMPONENTS,
  crewPower,
  crewTier,
  crewTotalLevel,
  drillEfficiency,
  maxCrewPowerRatio,
  minersBasePower,
  upgradeCostMultiplier,
  upgradeOreCost,
} from "./crew";
import { oreEfficiency } from "./ore";

const starter = { miners: 1, drills: 1, carts: 1, foreman: 1, storage: 1 };
const veteran = { miners: 100, drills: 100, carts: 100, foreman: 100, storage: 100 };

describe("Mining Crew branches", () => {
  it("keeps every branch strategically distinct", () => {
    const base = crewPower({ miners: 10, drills: 10, carts: 1, foreman: 1, storage: 1 });
    const withCarts = crewPower({ miners: 10, drills: 10, carts: 60, foreman: 1, storage: 1 });
    const withForeman = crewPower({ miners: 10, drills: 10, carts: 1, foreman: 60, storage: 1 });
    const withStorage = crewPower({ miners: 10, drills: 10, carts: 1, foreman: 1, storage: 60 });
    const withDrills = crewPower({ miners: 10, drills: 60, carts: 1, foreman: 1, storage: 1 });

    // Carts, Foreman and Storage are not mining power branches.
    expect(withCarts).toBe(base);
    expect(withForeman).toBe(base);
    expect(withStorage).toBe(base);
    // Drills multiply Miner output instead of adding a second flat power term.
    expect(withDrills).toBeGreaterThan(base);
  });

  it("makes Drills a multiplier on Miners, never flat power", () => {
    const weakMiners = { miners: 1, drills: 100, carts: 1, foreman: 1, storage: 1 };
    const strongMiners = { miners: 100, drills: 1, carts: 1, foreman: 1, storage: 1 };
    const multiplier = drillEfficiency(100);
    expect(multiplier).toBeGreaterThan(1);
    expect(multiplier).toBeLessThan(1 + DIGGO_CONFIG.crew.drillEfficiencyGain + 0.001);
    // A maxed Drill branch cannot carry a starter crew above a real miner crew.
    expect(crewPower(weakMiners)).toBeLessThan(crewPower(strongMiners));
    expect(minersBasePower(100) / minersBasePower(1)).toBeLessThan(100);
  });

  it("makes Foreman a discount on upgrade costs", () => {
    expect(upgradeCostMultiplier(1)).toBe(1);
    const discounted = upgradeOreCost("miners", 10, 60);
    const full = upgradeOreCost("miners", 10, 1);
    expect(discounted).toBeLessThan(full);
    expect(upgradeCostMultiplier(100)).toBeGreaterThanOrEqual(DIGGO_CONFIG.crew.minimumUpgradeCostMultiplier);
  });

  it("applies diminishing returns per level", () => {
    const early = minersBasePower(11) - minersBasePower(1);
    const late = minersBasePower(100) - minersBasePower(90);
    expect(late).toBeLessThan(early);
  });

  it("bounds a max-level veteran crew against a starter crew", () => {
    const ratio = crewPower(veteran) / crewPower(starter);
    expect(ratio).toBeLessThanOrEqual(DIGGO_CONFIG.crew.maxVeteranPowerRatio);
    expect(maxCrewPowerRatio()).toBeLessThanOrEqual(DIGGO_CONFIG.crew.maxVeteranPowerRatio);
    expect(crewPower(veteran)).toBeGreaterThan(crewPower(starter));
  });

  it("respects a tightened veteran ratio from config", () => {
    const strict = createDiggoConfig({ crew: { maxVeteranPowerRatio: 5, minerPowerExponent: 0.25 } });
    const ratio = crewPower(veteran, strict) / crewPower(starter, strict);
    expect(ratio).toBeLessThanOrEqual(strict.crew.maxVeteranPowerRatio);
    expect(maxCrewPowerRatio(strict)).toBeLessThanOrEqual(strict.crew.maxVeteranPowerRatio);
  });

  it("promotes crew tiers from combined levels", () => {
    expect(crewTotalLevel(starter)).toBe(5);
    expect(crewTier(starter).tier).toBe(1);
    expect(crewTier({ miners: 20, drills: 20, carts: 20, foreman: 20, storage: 20 }).tier).toBe(4);
    expect(crewTier(veteran).tier).toBe(DIGGO_CONFIG.crew.tiers[DIGGO_CONFIG.crew.tiers.length - 1].tier);
  });

  it("rejects invalid levels and unknown components", () => {
    expect(() => crewPower({ miners: 0, drills: 1, carts: 1, foreman: 1, storage: 1 })).toThrow();
    expect(() => crewPower({ miners: 101, drills: 1, carts: 1, foreman: 1, storage: 1 })).toThrow();
    expect(() => upgradeOreCost("miners", 100)).toThrow();
    expect(() => upgradeOreCost("miners", 0)).toThrow();
    expect(() => upgradeOreCost("lasers" as CrewComponent, 1)).toThrow();
    expect(CREW_COMPONENTS).toHaveLength(5);
  });

  it("gives Carts and Foreman an ORE efficiency role", () => {
    expect(oreEfficiency(starter)).toBeCloseTo(1, 6);
    expect(oreEfficiency({ miners: 1, drills: 1, carts: 60, foreman: 1, storage: 1 })).toBeGreaterThan(1);
    expect(oreEfficiency({ miners: 1, drills: 1, carts: 1, foreman: 60, storage: 1 })).toBeGreaterThan(1);
    expect(oreEfficiency({ miners: 100, drills: 100, carts: 100, foreman: 100, storage: 100 })).toBeLessThan(2);
  });
});
