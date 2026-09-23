import { describe, expect, it } from "vitest";
import { DIGGO_CONFIG, createDiggoConfig } from "./config";
import {
  discoveryBudgetCheck,
  discoveryBudgetRemaining,
  discoveryEligible,
  discoveryEligibility,
  heldUsageCountedUsd,
  type DiscoveryUsage,
} from "./discovery";
import {
  DISCOVERY_MIN_TOTAL_CREW_LEVEL,
  discoveryAccountCapCheck,
  discoveryDayIndex,
  discoveryIsEligibleV2,
  discoveryMaturityBps,
  discoveryReservationLamports,
  discoveryWeekIndex,
  discoveryWindowReset
} from "./discovery";
import { crewTotalLevel } from "./crew";

describe("v2 eligibility, windows and reservation (parity with math/rarity.rs)", () => {
  const TIERS = [{ valueLamports: 333_333n }, { valueLamports: 133_333_333n }];
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
  const CREATED = 1_000_000;

  function player(overrides: Partial<{
    createdAt: number;
    activeDays: number;
    validActivations: number;
    crewLevels: number[];
  }> = {}) {
    return {
      createdAt: CREATED,
      activeDays: 5,
      validActivations: 5,
      crewLevels: [3, 3, 3, 3, 3],
      ...overrides
    };
  }

  it("steps the maturity ramp at its rungs and completes past the last one", () => {
    const at = (days: number) => discoveryMaturityBps(CREATED, CREATED + days * DAY);
    expect(at(0)).toBe(0);
    expect(at(1)).toBe(2_000);
    expect(at(3)).toBe(4_000);
    expect(at(7)).toBe(7_000);
    expect(at(8)).toBe(10_000);
    expect(at(365)).toBe(10_000);
  });

  it("requires the milestones: history, crew and maturity", () => {
    const now = CREATED + 30 * DAY;
    expect(discoveryIsEligibleV2(player(), now)).toBe(true);
    expect(discoveryIsEligibleV2(player({ activeDays: 4 }), now)).toBe(false);
    expect(discoveryIsEligibleV2(player({ validActivations: 4 }), now)).toBe(false);
    expect(discoveryIsEligibleV2(player({ crewLevels: [2, 2, 2, 2, 2] }), now)).toBe(false);
    // A wallet created a minute ago cannot roll. There is no longer any amount of SOL that would
    // change that, because the bond gate is gone: a roll is earned by the account's own history.
    expect(discoveryIsEligibleV2(player(), CREATED + 60)).toBe(false);
  });

  it("sums all five crew components", () => {
    expect(crewTotalLevel([0, 0, 0, 0, 0])).toBe(0);
    expect(crewTotalLevel([3, 3, 3, 3, 3])).toBe(DISCOVERY_MIN_TOTAL_CREW_LEVEL);
    expect(crewTotalLevel([100, 100, 100, 100, 100])).toBe(500);
  });

  it("advances the budget windows by their own periods", () => {
    expect(discoveryDayIndex(0)).toBe(0);
    expect(discoveryDayIndex(DAY - 1)).toBe(0);
    expect(discoveryDayIndex(DAY)).toBe(1);
    expect(discoveryWeekIndex(7 * DAY - 1)).toBe(0);
    expect(discoveryWeekIndex(7 * DAY)).toBe(1);
  });

  it("reserves the top value class clamped by the coin's own ceilings", () => {
    expect(discoveryReservationLamports(TIERS, 100, THIN)).toBe(3_010_000n);
    const deep = {
      ...THIN,
      tokenReserve: 1_000_000_000_000n,
      solReserve: 2_000_000_000_000n,
      virtualSolReserve: 5_000_000_000_000n,
      discoveryReserveTotal: 10_000_000_000n,
      discoveryRemaining: 10_000_000_000n,
      discoveryEpochBudget: 10_000_000_000n
    };
    expect(discoveryReservationLamports(TIERS, 100, deep)).toBe(133_333_333n);
    expect(discoveryReservationLamports(TIERS, 100, { ...THIN, discoveryRemaining: 1n })).toBeLessThan(100n);
    expect(
      discoveryReservationLamports(TIERS, 100, { ...THIN, discoveryEpochSpent: THIN.discoveryEpochBudget })
    ).toBe(0n);
    expect(
      discoveryReservationLamports(TIERS, 100, { ...THIN, tokenReserve: 0n, solReserve: 0n, virtualSolReserve: 0n })
    ).toBeNull();
  });

  it("refuses a roll past either account cap", () => {
    expect(discoveryAccountCapCheck(0n, 0n, 10n, 100n, 400n)).toBe("ok");
    expect(discoveryAccountCapCheck(95n, 0n, 10n, 100n, 400n)).toBe("daily");
    expect(discoveryAccountCapCheck(0n, 395n, 10n, 100n, 400n)).toBe("weekly");
  });

  it("resets a window only when it rolls", () => {
    const rolled = discoveryWindowReset(1, 1, 5n, 6n, 2 * DAY);
    expect(rolled.dayIndex).toBe(2);
    expect(rolled.weekIndex).toBe(0);
    expect(rolled.spentDayLamports).toBe(0n);
    expect(rolled.spentWeekLamports).toBe(0n);
    // Only the day rolls here, so only the day's spend resets.
    const dayOnly = discoveryWindowReset(6, 1, 5n, 6n, 7 * DAY + 1);
    expect(dayOnly.dayIndex).toBe(7);
    expect(dayOnly.weekIndex).toBe(1);
    expect(dayOnly.spentDayLamports).toBe(0n);
    expect(dayOnly.spentWeekLamports).toBe(6n);
    const same = discoveryWindowReset(2, 0, 5n, 6n, 2 * DAY);
    expect(same.spentDayLamports).toBe(5n);
    expect(same.spentWeekLamports).toBe(6n);
  });
});


const DAY = 86_400;

const fresh = {
  accountAgeSeconds: DAY,
  activeDays: 1,
  validActivations: 1,
  crewTier: 1,
  maturityBps: 2_000,
  riskState: "NORMAL" as const,
  abuseFlags: 0,
};

const mature = {
  accountAgeSeconds: 30 * DAY,
  activeDays: 20,
  validActivations: 25,
  crewTier: 3,
  maturityBps: 10_000,
  riskState: "NORMAL" as const,
  abuseFlags: 0,
};

const noUsage: DiscoveryUsage = {
  accountDailyUsd: 0,
  accountWeeklyUsd: 0,
  tokenDailyUsd: 0,
  tokenPeriodUsd: 0,
  globalDailyUsd: 0,
};

describe("discovery eligibility", () => {
  it("keeps a fresh account out of real-value discoveries", () => {
    const result = discoveryEligibility(fresh);
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("account_too_new");
    expect(result.reasons).toContain("insufficient_active_days");
    expect(result.reasons).toContain("insufficient_valid_activations");
    expect(result.reasons).toContain("crew_tier_too_low");
    expect(result.reasons).toContain("maturity_below_minimum");
    expect(result.reasons).toHaveLength(5);
    expect(result.requiredAccountAgeSeconds).toBe(DIGGO_CONFIG.discovery.minimumAccountAgeDays * DAY);
  });

  it("admits a mature, clean account", () => {
    const result = discoveryEligibility(mature);
    expect(result.eligible).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("gates on risk state and abuse flags", () => {
    const held = discoveryEligibility({ ...mature, riskState: "HELD" });
    expect(held.eligible).toBe(false);
    expect(held.reasons).toContain("risk_state_not_normal");
    const flagged = discoveryEligibility({ ...mature, abuseFlags: 1 });
    expect(flagged.eligible).toBe(false);
    expect(flagged.reasons).toContain("abuse_flags_present");
    const underReview = discoveryEligibility({ ...mature, riskState: "UNDER_REVIEW" });
    expect(underReview.eligible).toBe(false);
  });

  it("keeps the legacy three-signal gate working", () => {
    expect(discoveryEligible(6 * DAY, 5, 2)).toBe(false);
    expect(discoveryEligible(7 * DAY, 5, 2)).toBe(true);
    expect(discoveryEligible(30 * DAY, 4, 2)).toBe(false);
    expect(discoveryEligible(30 * DAY, 5, 1)).toBe(false);
  });

  it("honours configured eligibility thresholds", () => {
    const relaxed = createDiggoConfig({ discovery: { minimumAccountAgeDays: 0, minimumActiveDays: 0, minimumValidActivations: 0, minimumCrewTier: 1, minimumMaturityBps: 0 } });
    expect(discoveryEligibility(fresh, relaxed).eligible).toBe(true);
  });
});

describe("discovery budget caps", () => {
  it("allows a request inside every cap and reports the headroom", () => {
    const result = discoveryBudgetCheck(noUsage, { requestedUsd: 0.4 });
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.maxAllowedUsd).toBe(DIGGO_CONFIG.discovery.accountDailyCapUsd);
    expect(discoveryBudgetRemaining(noUsage)).toBe(DIGGO_CONFIG.discovery.accountDailyCapUsd);
  });

  it("blocks a request above the per-account daily cap", () => {
    const result = discoveryBudgetCheck(noUsage, { requestedUsd: 0.6 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("account_daily_cap");
    expect(result.maxAllowedUsd).toBe(DIGGO_CONFIG.discovery.accountDailyCapUsd);
  });

  it("blocks a request above the per-account weekly cap", () => {
    const usage = { ...noUsage, accountDailyUsd: 0.2, accountWeeklyUsd: DIGGO_CONFIG.discovery.accountWeeklyCapUsd - 0.1 };
    const result = discoveryBudgetCheck(usage, { requestedUsd: 0.2 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("account_weekly_cap");
    expect(result.maxAllowedUsd).toBeCloseTo(0.1, 6);
  });

  it("blocks a request above the per-token daily cap", () => {
    const usage = { ...noUsage, tokenDailyUsd: DIGGO_CONFIG.discovery.tokenDailyCapUsd - 0.1 };
    const result = discoveryBudgetCheck(usage, { requestedUsd: 0.2 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("token_daily_cap");
  });

  it("blocks a request above the per-token period cap", () => {
    const usage = { ...noUsage, tokenPeriodUsd: DIGGO_CONFIG.discovery.tokenPeriodCapUsd - 0.1 };
    const result = discoveryBudgetCheck(usage, { requestedUsd: 0.2 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("token_period_cap");
  });

  it("blocks a request above the global daily budget", () => {
    const usage = { ...noUsage, globalDailyUsd: DIGGO_CONFIG.discovery.globalDailyCapUsd - 0.1 };
    const result = discoveryBudgetCheck(usage, { requestedUsd: 0.2 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("global_daily_cap");
  });

  it("blocks a single request above the per-request cap", () => {
    const generous = createDiggoConfig({
      discovery: {
        accountDailyCapUsd: 1_000,
        accountWeeklyCapUsd: 5_000,
        tokenDailyCapUsd: 5_000,
        tokenPeriodCapUsd: 5_000,
        globalDailyCapUsd: 5_000,
        perRequestCapUsd: 20,
      },
    });
    const result = discoveryBudgetCheck(noUsage, { requestedUsd: 21 }, generous);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("per_request_cap");
    expect(result.maxAllowedUsd).toBe(20);
    expect(discoveryBudgetCheck(noUsage, { requestedUsd: 20 }, generous).allowed).toBe(true);
  });

  it("reports exhausted budget instead of paying out", () => {
    const usage = { ...noUsage, accountDailyUsd: DIGGO_CONFIG.discovery.accountDailyCapUsd };
    const result = discoveryBudgetCheck(usage, { requestedUsd: 0.01 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("no_budget_left");
    expect(result.maxAllowedUsd).toBe(0);
    expect(discoveryBudgetRemaining(usage)).toBe(0);
  });

  it("closes the circuit breaker without touching trading", () => {
    const result = discoveryBudgetCheck(noUsage, { requestedUsd: 0.1, circuitBreakerOpen: true });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("circuit_breaker_open");
    expect(result.maxAllowedUsd).toBe(0);
  });

  it("rejects non-positive requests", () => {
    expect(discoveryBudgetCheck(noUsage, { requestedUsd: 0 }).allowed).toBe(false);
    expect(discoveryBudgetCheck(noUsage, { requestedUsd: -5 }).allowed).toBe(false);
    expect(discoveryBudgetCheck(noUsage, { requestedUsd: Number.NaN }).allowed).toBe(false);
  });

  it("never reports more headroom than the tightest cap", () => {
    const usage = { accountDailyUsd: 0.4, accountWeeklyUsd: 2, tokenDailyUsd: 24, tokenPeriodUsd: 90, globalDailyUsd: 499 };
    const result = discoveryBudgetCheck(usage, { requestedUsd: 0.05 });
    expect(result.allowed).toBe(true);
    expect(result.maxAllowedUsd).toBeCloseTo(0.1, 6);
    expect(result.headroom.account_daily_cap).toBeCloseTo(0.1, 6);
  });
});

describe("held grants and the budget they may reserve", () => {
  it("counts held value in full while it is inside its configured share", () => {
    // 10% of the 500 cap, against 20 held: the share is what binds, not the held value.
    const config = createDiggoConfig({ discovery: { heldBudgetShareBps: 1_000 } });

    expect(heldUsageCountedUsd(20, 500, config)).toBe(20);
    expect(heldUsageCountedUsd(50, 500, config)).toBe(50);
  });

  it("stops counting held value above the configured share", () => {
    const config = createDiggoConfig({ discovery: { heldBudgetShareBps: 1_000 } });

    // A held farm cannot commit more than its share of a cap, however much it holds.
    expect(heldUsageCountedUsd(495, 500, config)).toBe(50);
    expect(heldUsageCountedUsd(1_000_000, 500, config)).toBe(50);
  });

  it("counts nothing when held value, the cap or the share is unusable", () => {
    const noShare = createDiggoConfig({ discovery: { heldBudgetShareBps: 0 } });

    expect(heldUsageCountedUsd(0, 500)).toBe(0);
    expect(heldUsageCountedUsd(-5, 500)).toBe(0);
    expect(heldUsageCountedUsd(Number.NaN, 500)).toBe(0);
    expect(heldUsageCountedUsd(50, 0)).toBe(0);
    expect(heldUsageCountedUsd(50, -1)).toBe(0);
    expect(heldUsageCountedUsd(50, 500, noShare)).toBe(0);
    // The shipped default is the fifth the deployment ships with, not a full pass-through.
    expect(heldUsageCountedUsd(500, 500)).toBe(100);
  });
});
