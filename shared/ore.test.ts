import { describe, expect, it } from "vitest";
import { DIGGO_CONFIG, createDiggoConfig } from "./config";
import {
  ORE_SOURCES,
  maturityBps,
  maxAccrualSeconds,
  offlineHours,
  oreCapacity,
  oreEfficiency,
  oreForActiveSeconds,
  oreFromAchievement,
  oreFromActivation,
  oreFromLevelUp,
  oreGrant,
  storeOre,
  ONCHAIN_MAX_ACCRUAL_SECONDS,
  onchainOreCapacity,
  onchainOreEfficiencyBps,
  onchainOreForActiveSeconds,
  onchainOreFromActivation,
  onchainOreMaturityBps,
  onchainOfflineHours,
  onchainStoreOre,
} from "./ore";

const DAY = 86_400;
const starter = { miners: 2, drills: 1, carts: 1, foreman: 1, storage: 1 };
const day = (value: number) => value * DAY;

describe("ORE generation", () => {
  it("ramps maturity from throttled to full efficiency", () => {
    expect(maturityBps(0)).toBe(2_000);
    // The chain's ramp, which is also the power ramp (design 5): day 1 20%, day 3 40%,
    // day 7 70%, then 100%. It replaced the off-chain ORE ramp of 20/35/50 so that a
    // player never has to reason about two different ages.
    expect(maturityBps(day(2))).toBe(4_000);
    expect(maturityBps(day(3))).toBe(7_000);
    expect(maturityBps(day(30))).toBe(10_000);
    expect(maturityBps(-1)).toBe(0);
    expect(maturityBps(Number.NaN)).toBe(0);
  });

  it("accrues ORE from active time at the configured base rate", () => {
    expect(oreForActiveSeconds(3_600, day(7))).toBe(DIGGO_CONFIG.ore.baseOrePerActiveHour);
    // A brand-new account accrues its maturity share of the same hour.
    expect(oreForActiveSeconds(3_600, 0)).toBe(
      Math.floor((DIGGO_CONFIG.ore.baseOrePerActiveHour * maturityBps(0)) / 10_000),
    );
    expect(oreForActiveSeconds(0, day(7))).toBe(0);
    expect(oreForActiveSeconds(-10, day(7))).toBe(0);
    expect(oreForActiveSeconds(Number.NaN, day(7))).toBe(0);
  });

  it("clamps an accrual window to one activation so offline time cannot be farmed", () => {
    const capped = oreForActiveSeconds(maxAccrualSeconds(), day(30));
    expect(oreForActiveSeconds(day(30), day(30))).toBe(capped);
    expect(maxAccrualSeconds()).toBeLessThanOrEqual(DIGGO_CONFIG.streak.activationSeconds);
  });

  it("never accrues ORE while the crew is paused or without a crew", () => {
    expect(oreForActiveSeconds(3_600, day(30), { miners: 1, drills: 1, carts: 1, foreman: 1, storage: 1 })).toBe(
      oreForActiveSeconds(3_600, day(30)),
    );
    expect(oreForActiveSeconds(0, day(30), { miners: 100, drills: 100, carts: 100, foreman: 100, storage: 100 })).toBe(0);
  });

  it("lets logistics raise ORE without touching mining power", () => {
    const base = oreForActiveSeconds(3_600, day(30), starter);
    const carts = oreForActiveSeconds(3_600, day(30), { ...starter, carts: 60 });
    expect(carts).toBeGreaterThan(base);
    expect(oreEfficiency({ ...starter, carts: 60 })).toBeGreaterThan(1);
  });

  it("pays the daily activation bonus scaled by maturity", () => {
    expect(oreFromActivation(0)).toBe(10);
    expect(oreFromActivation(day(7))).toBe(DIGGO_CONFIG.ore.activationBonusOre);
    expect(oreFromActivation(day(7))).toBeGreaterThan(oreFromActivation(0));
  });

  it("grows level-up ORE with the level reached", () => {
    expect(oreFromLevelUp(1)).toBe(0);
    expect(oreFromLevelUp(2)).toBeGreaterThan(0);
    expect(oreFromLevelUp(10)).toBeGreaterThan(oreFromLevelUp(9));
  });

  it("reads achievement ORE from config and ignores unknown achievements", () => {
    expect(oreFromAchievement("FIRST_DISCOVERY")).toBe(DIGGO_CONFIG.ore.achievementOre.FIRST_DISCOVERY);
    expect(oreFromAchievement("NOT_A_REAL_ACHIEVEMENT")).toBe(0);
  });

  it("covers every configured ORE source through one dispatcher", () => {
    for (const source of ORE_SOURCES) {
      const amount = oreGrant({ source, activeSeconds: 3_600, accountAgeSeconds: day(30), streakDay: 7, milestoneOre: 250, achievementId: "FIRST_BLOCK", level: 5, amount: 100 }, starter);
      expect(amount).toBeGreaterThanOrEqual(0);
    }
    expect(oreGrant({ source: "active_mine", activeSeconds: 3_600, accountAgeSeconds: day(30) })).toBe(
      DIGGO_CONFIG.ore.baseOrePerActiveHour,
    );
    expect(oreGrant({ source: "activation", accountAgeSeconds: 0 })).toBe(10);
    expect(oreGrant({ source: "streak_milestone", milestoneOre: 250 })).toBe(250);
    expect(oreGrant({ source: "achievement", achievementId: "FIRST_DISCOVERY" })).toBe(200);
    expect(oreGrant({ source: "quest", amount: 1_000_000 })).toBe(DIGGO_CONFIG.ore.questOreCap);
    expect(oreGrant({ source: "season", amount: 1_000_000 })).toBe(DIGGO_CONFIG.ore.seasonOreCap);
  });

  it("never grants ORE for a payment: an explicit amount is always capped", () => {
    expect(oreGrant({ source: "quest", amount: 1e12 })).toBeLessThanOrEqual(DIGGO_CONFIG.ore.questOreCap);
    expect(oreGrant({ source: "season", amount: 1e12 })).toBeLessThanOrEqual(DIGGO_CONFIG.ore.seasonOreCap);
  });
});

describe("ORE storage", () => {
  it("scales capacity with Storage and Carts", () => {
    expect(oreCapacity(starter)).toBeGreaterThan(0);
    expect(oreCapacity({ ...starter, storage: 40 })).toBeGreaterThan(oreCapacity(starter));
    expect(oreCapacity({ ...starter, carts: 40 })).toBeGreaterThan(oreCapacity(starter));
  });

  it("scales offline hours with Storage up to a configured cap", () => {
    expect(offlineHours(starter)).toBe(DIGGO_CONFIG.ore.offlineHoursBase);
    expect(offlineHours({ ...starter, storage: 20 })).toBeGreaterThan(offlineHours(starter));
    expect(offlineHours({ ...starter, storage: 100 })).toBe(DIGGO_CONFIG.ore.offlineHoursCap);
  });

  it("returns overflow explicitly instead of dropping it silently", () => {
    const capacity = oreCapacity(starter);
    const partial = storeOre(capacity - 10, 50, capacity);
    expect(partial.stored).toBe(10);
    expect(partial.overflow).toBe(40);
    expect(partial.balance).toBe(capacity);

    const full = storeOre(capacity, 50, capacity);
    expect(full.stored).toBe(0);
    expect(full.overflow).toBe(50);
    expect(full.balance).toBe(capacity);
  });

  it("never exceeds capacity and conserves the requested amount", () => {
    const capacity = 480;
    const result = storeOre(470, 50, capacity);
    expect(result.balance).toBeLessThanOrEqual(capacity);
    expect(result.stored + result.overflow).toBe(50);
    const overfull = storeOre(1_000, 25, capacity);
    // An existing balance above capacity is never destroyed by a deposit.
    expect(overfull.balance).toBe(1_000);
    expect(overfull.stored).toBe(0);
    expect(overfull.overflow).toBe(25);
  });

  it("accepts configurable capacity tuning", () => {
    const small = createDiggoConfig({ ore: { storageBaseCapacity: 10, storageCapacityScale: 0, cartsCapacityScale: 0 } });
    expect(oreCapacity(starter, small)).toBe(10);
    expect(storeOre(0, 25, oreCapacity(starter, small), small).overflow).toBe(15);
  });
});

// ---- the on-chain mirror (math/ore.rs) ----------------------------------------------------

describe("on-chain ORE (math/ore.rs)", () => {
  const maxed = { miners: 100, drills: 100, carts: 100, foreman: 100, storage: 100 };

  it("pins the golden efficiency, capacity and offline hours", () => {
    expect(onchainOreEfficiencyBps(starter)).toBe(10_000);
    expect(onchainOreEfficiencyBps({ ...starter, carts: 60 })).toBe(13_448);
    expect(onchainOreEfficiencyBps({ ...starter, foreman: 60 })).toBe(11_925);
    expect(onchainOreEfficiencyBps(maxed)).toBe(16_185);
    expect(onchainOreCapacity(starter)).toBe(2_340);
    expect(onchainOreCapacity({ ...starter, storage: 40 })).toBe(9_382);
    expect(onchainOreCapacity({ ...starter, carts: 40 })).toBe(2_978);
    expect(onchainOfflineHours(starter)).toBe(24);
    expect(onchainOfflineHours({ ...starter, storage: 10 })).toBe(60);
    expect(onchainOfflineHours({ ...starter, storage: 37 })).toBe(168);
    // The deployed config returns the chain's numbers, not a parallel estimate.
    expect(oreCapacity(starter)).toBe(2_340);
    expect(offlineHours(starter)).toBe(24);
  });

  it("pins the golden accrual and rounds down exactly once", () => {
    expect(onchainOreForActiveSeconds(0, 10_000, 10_000)).toBe(0);
    expect(onchainOreForActiveSeconds(-5, 10_000, 10_000)).toBe(0);
    expect(onchainOreForActiveSeconds(3_599, 10_000, 10_000)).toBe(29);
    expect(onchainOreForActiveSeconds(3_600, 10_000, 10_000)).toBe(30);
    expect(onchainOreForActiveSeconds(DAY, 10_000, 10_000)).toBe(720);
    // The clamp is the accrual cap: a week away pays exactly what a day pays.
    expect(onchainOreForActiveSeconds(7 * DAY, 10_000, 10_000)).toBe(720);
    expect(onchainOreForActiveSeconds(200_000, 10_000, 10_000)).toBe(720);
    expect(ONCHAIN_MAX_ACCRUAL_SECONDS).toBe(DAY);
    // Maturity and logistics both throttle, and neither is rounded separately.
    expect(onchainOreForActiveSeconds(3_600, 2_000, 10_000)).toBe(6);
    expect(oreForActiveSeconds(3_600, day(30))).toBe(30);
  });

  it("pins the golden activation bonus, maturity and storage clamp", () => {
    expect(onchainOreFromActivation(0)).toBe(0);
    expect(onchainOreFromActivation(2_000)).toBe(10);
    expect(onchainOreFromActivation(7_000)).toBe(35);
    expect(onchainOreFromActivation(10_000)).toBe(50);
    expect(onchainOreMaturityBps(0)).toBe(2_000);
    expect(onchainOreMaturityBps(DAY)).toBe(4_000);
    expect(onchainOreMaturityBps(3 * DAY)).toBe(7_000);
    expect(onchainOreMaturityBps(7 * DAY)).toBe(10_000);
    expect(onchainOreMaturityBps(-1)).toBe(0);
    const capacity = onchainOreCapacity(starter);
    expect(onchainStoreOre(capacity - 10, 50, capacity)).toEqual({
      balance: capacity,
      stored: 10,
      overflow: 40,
      capacity,
    });
    expect(onchainStoreOre(470, 50, capacity)).toEqual({
      balance: 520,
      stored: 50,
      overflow: 0,
      capacity,
    });
  });
});
