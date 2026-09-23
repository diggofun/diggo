import { describe, expect, it } from "vitest";
import {
  DISCOVERY_TUNABLE_BOUNDS,
  DIGGO_CONFIG,
  DISCOVERY_DEFAULTS,
  GAMEPLAY_DEFAULTS,
  clampDiscoveryTunables,
  clampHeldBudgetTunables,
  configFromEnv,
  createDiggoConfig,
  DISCOVERY_HELD_TUNABLE_BOUNDS,
} from "./config";
import { activationWindow, isEligibleForBlock } from "./streak";
import { crewPower, upgradeOreCost } from "./crew";
import { maturityBps, oreForActiveSeconds } from "./ore";

describe("central Diggo config", () => {
  it("carries the documented default activation and grace windows", () => {
    expect(DIGGO_CONFIG.streak.activationSeconds).toBe(86_400);
    expect(DIGGO_CONFIG.streak.graceSeconds).toBe(43_200);
    expect(DIGGO_CONFIG.time.secondsPerDay).toBe(86_400);
  });

  it("is frozen so no call site can mutate shared defaults", () => {
    expect(Object.isFrozen(DIGGO_CONFIG)).toBe(true);
    expect(Object.isFrozen(DIGGO_CONFIG.streak)).toBe(true);
    expect(Object.isFrozen(DIGGO_CONFIG.streak.milestones)).toBe(true);
    expect(() => {
      (DIGGO_CONFIG.streak as { activationSeconds: number }).activationSeconds = 1;
    }).toThrow();
    expect(DIGGO_CONFIG.streak.activationSeconds).toBe(86_400);
  });

  it("derives tuned configs by deep merge without touching the defaults", () => {
    const tuned = createDiggoConfig({ streak: { activationSeconds: 3_600 } });
    expect(tuned.streak.activationSeconds).toBe(3_600);
    expect(tuned.streak.graceSeconds).toBe(DIGGO_CONFIG.streak.graceSeconds);
    expect(DIGGO_CONFIG.streak.activationSeconds).toBe(86_400);
    expect(Object.isFrozen(tuned)).toBe(true);
  });

  it("replaces arrays wholesale when overridden", () => {
    const tuned = createDiggoConfig({
      streak: { milestones: [{ day: 2, ore: 10, xp: 1, badges: ["EARLY"], titles: [], freezes: 0 }] },
    });
    expect(tuned.streak.milestones).toHaveLength(1);
    expect(DIGGO_CONFIG.streak.milestones).toHaveLength(7);
  });

  it("drives behaviour from config instead of hardcoded numbers", () => {
    const tuned = createDiggoConfig({
      streak: { activationSeconds: 3_600, graceSeconds: 600 },
      ore: { maturityRamp: [{ upToDay: Number.POSITIVE_INFINITY, bps: 1_000 }] },
      crew: { upgradeCostBase: { miners: 7, drills: 7, carts: 7, foreman: 7, storage: 7 } },
    });
    expect(activationWindow(0, tuned).activeUntil).toBe(3_600);
    expect(activationWindow(0, tuned).graceUntil).toBe(4_200);
    expect(isEligibleForBlock(activationWindow(0, tuned).activeUntil, 3_600, 0)).toBe(false);
    expect(maturityBps(30 * 86_400, tuned)).toBe(1_000);
    // One hour at the base rate, scaled by the 1,000 bps maturity ramp this config carries.
    expect(oreForActiveSeconds(3_600, 30 * 86_400, undefined, tuned)).toBe(3);
    expect(upgradeOreCost("miners", 1, undefined, tuned)).toBe(7);
  });

  it("keeps a starter crew fully specified for new accounts", () => {
    expect(DIGGO_CONFIG.crew.starterLevels.miners).toBe(2);
    expect(crewPower(DIGGO_CONFIG.crew.starterLevels)).toBeGreaterThan(0);
  });

  it("keeps the legacy flat views in sync with the central config", () => {
    expect(GAMEPLAY_DEFAULTS.activationSeconds).toBe(DIGGO_CONFIG.streak.activationSeconds);
    expect(GAMEPLAY_DEFAULTS.baseOrePerHour).toBe(DIGGO_CONFIG.ore.baseOrePerActiveHour);
    expect(GAMEPLAY_DEFAULTS.discoveryMinimumAgeDays).toBe(DIGGO_CONFIG.discovery.minimumAccountAgeDays);
    expect(DISCOVERY_DEFAULTS.accountDailyCapUsd).toBe(DIGGO_CONFIG.discovery.accountDailyCapUsd);
    expect(DISCOVERY_DEFAULTS.globalDailyCapUsd).toBe(DIGGO_CONFIG.discovery.globalDailyCapUsd);
  });

  it("configures every ORE source and the discovery rarity table", () => {
    expect(DIGGO_CONFIG.rarity.tiers.map((tier) => tier.rarity)).toEqual([
      "common",
      "uncommon",
      "rare",
      "epic",
      "legendary",
      "mythic",
    ]);
    expect(DIGGO_CONFIG.rarity.tiers[DIGGO_CONFIG.rarity.tiers.length - 1].cumulativeChance).toBe(1);
    const weights = DIGGO_CONFIG.rarity.weights;
    const total =
      weights.liquidity + weights.volume + weights.activity + weights.health + weights.reserve + weights.priceConfidence;
    expect(total).toBeCloseTo(1, 5);
    const trustWeights = DIGGO_CONFIG.risk.trust.weights;
    const trustTotal =
      trustWeights.age +
      trustWeights.validActivations +
      trustWeights.streakConsistency +
      trustWeights.validClaims +
      trustWeights.absenceOfAbuse;
    expect(trustTotal).toBeCloseTo(1, 5);
  });

  it("keeps the shipped discovery window and roll chance in the central config", () => {
    expect(DIGGO_CONFIG.discovery.windowSeconds).toBe(3_600);
    expect(DIGGO_CONFIG.discovery.rollChanceBps).toBe(250);
  });

  it("applies environment overrides on top of the defaults without mutating them", () => {
    const tuned = configFromEnv({
      DISCOVERY_WINDOW_SECONDS: "120",
      DISCOVERY_ROLL_CHANCE_BPS: "9000",
    });
    expect(tuned.discovery.windowSeconds).toBe(120);
    expect(tuned.discovery.rollChanceBps).toBe(9_000);
    // Everything else still comes from the frozen defaults.
    expect(tuned.discovery.accountDailyCapUsd).toBe(DIGGO_CONFIG.discovery.accountDailyCapUsd);
    expect(tuned.streak.activationSeconds).toBe(DIGGO_CONFIG.streak.activationSeconds);
    expect(Object.isFrozen(tuned)).toBe(true);
    expect(DIGGO_CONFIG.discovery.windowSeconds).toBe(3_600);
  });

  it("returns the base config untouched when no override is set", () => {
    expect(configFromEnv({})).toBe(DIGGO_CONFIG);
    expect(configFromEnv({ DISCOVERY_WINDOW_SECONDS: "", DISCOVERY_ROLL_CHANCE_BPS: "nonsense" })).toBe(
      DIGGO_CONFIG,
    );
  });

  it("clamps hostile or mistyped environment overrides into the tunable bounds", () => {
    const tiny = configFromEnv({ DISCOVERY_WINDOW_SECONDS: "0" });
    expect(tiny.discovery.windowSeconds).toBe(DISCOVERY_TUNABLE_BOUNDS.windowSeconds.min);
    const huge = configFromEnv({ DISCOVERY_WINDOW_SECONDS: "99999999" });
    expect(huge.discovery.windowSeconds).toBe(DISCOVERY_TUNABLE_BOUNDS.windowSeconds.max);
    expect(configFromEnv({ DISCOVERY_ROLL_CHANCE_BPS: "-1" }).discovery.rollChanceBps).toBe(0);
    expect(configFromEnv({ DISCOVERY_ROLL_CHANCE_BPS: "50000" }).discovery.rollChanceBps).toBe(10_000);
    expect(configFromEnv({ DISCOVERY_ROLL_CHANCE_BPS: "abc" }).discovery.rollChanceBps).toBe(
      DIGGO_CONFIG.discovery.rollChanceBps,
    );
    expect(clampDiscoveryTunables({ windowSeconds: 12.9, rollChanceBps: 250.7 })).toEqual({
      windowSeconds: 60,
      rollChanceBps: 250,
    });
  });

  it("ships a held-grant budget ceiling and review window, and clamps their overrides", () => {
    // Held grants may reserve a fifth of each cap, and an uncleared hold expires after a day.
    expect(DIGGO_CONFIG.discovery.heldBudgetShareBps).toBe(2_000);
    expect(DIGGO_CONFIG.discovery.heldGrantReviewSeconds).toBe(86_400);

    const tuned = configFromEnv({
      DISCOVERY_HELD_BUDGET_SHARE_BPS: "500",
      DISCOVERY_HELD_REVIEW_SECONDS: "7200",
    });
    expect(tuned.discovery.heldBudgetShareBps).toBe(500);
    expect(tuned.discovery.heldGrantReviewSeconds).toBe(7_200);

    // Out-of-range and mistyped values fall back into the bounds, never outside them.
    expect(clampHeldBudgetTunables({ heldBudgetShareBps: 50_000 }).heldBudgetShareBps).toBe(10_000);
    expect(clampHeldBudgetTunables({ heldBudgetShareBps: -1 }).heldBudgetShareBps).toBe(0);
    expect(clampHeldBudgetTunables({ heldGrantReviewSeconds: 1 }).heldGrantReviewSeconds).toBe(
      DISCOVERY_HELD_TUNABLE_BOUNDS.heldGrantReviewSeconds.min,
    );
    expect(clampHeldBudgetTunables({ heldGrantReviewSeconds: "nonsense" }).heldGrantReviewSeconds).toBe(
      DIGGO_CONFIG.discovery.heldGrantReviewSeconds,
    );
    expect(configFromEnv({ DISCOVERY_HELD_REVIEW_SECONDS: "abc" })).toBe(DIGGO_CONFIG);
  });
});
