import { describe, expect, it } from "vitest";
import type { CurveMiningSummary } from "../shared/types";
import {
  curveCapSpent,
  describeEmissionWindow,
  describeMineStatus,
  emissionEnded,
  resolveNetworkPower,
} from "./mineView";

/** The app's clock is milliseconds (Date.now), while every API deadline is in Unix seconds. */
const NOW_MS = 1_800_000_000_000;
const NOW_S = 1_800_000_000;

/** A curve mine with room left in its launch cap, the state the mine page renders most often. */
function curve(overrides: Partial<CurveMiningSummary> = {}): CurveMiningSummary {
  return {
    open: true,
    onCurve: true,
    cap: 1_000_000,
    mined: 160_000,
    remaining: 840_000,
    progress: 0.16,
    blockReward: 250,
    unpaid: 1_200,
    ...overrides,
  };
}

describe("resolveNetworkPower", () => {
  it("prefers the live mine info over the cached token column for the same mine", () => {
    const power = resolveNetworkPower(
      { mint: "mint-a", networkPower: 0 },
      { mint: "mint-a", totalMiningPower: 12_400 },
    );
    expect(power).toBe(12_400);
  });

  it("prints a genuine zero once mine info says there is no crew on the mine", () => {
    const power = resolveNetworkPower(
      { mint: "mint-a", networkPower: 9_999 },
      { mint: "mint-a", totalMiningPower: 0 },
    );
    expect(power).toBe(0);
  });

  it("falls back to the token list before mine info lands, but never to a cached zero", () => {
    expect(resolveNetworkPower({ mint: "mint-a", networkPower: 4_200 }, null)).toBe(4_200);
    expect(resolveNetworkPower({ mint: "mint-a", networkPower: 0 }, null)).toBeNull();
  });

  it("ignores a mine info payload describing a different mine", () => {
    const power = resolveNetworkPower(
      { mint: "mint-a", networkPower: 0 },
      { mint: "mint-b", totalMiningPower: 12_400 },
    );
    expect(power).toBeNull();
  });

  it("has nothing to print when neither payload is loaded", () => {
    expect(resolveNetworkPower(null, null)).toBeNull();
  });
});

describe("curveCapSpent", () => {
  it("is false while the cap has room and true once it is spent", () => {
    expect(curveCapSpent(curve())).toBe(false);
    expect(curveCapSpent(curve({ open: false, mined: 1_000_000, remaining: 0, progress: 1 }))).toBe(true);
    expect(curveCapSpent(curve({ remaining: 0, progress: 1, open: false }))).toBe(true);
  });

  it("is false for a graduated mine and for a curve mine launched without a budget", () => {
    expect(curveCapSpent(curve({ onCurve: false, cap: 0, remaining: 0, open: false }))).toBe(false);
    expect(curveCapSpent(curve({ cap: 0, remaining: 0, progress: 0, open: false }))).toBe(false);
  });
});

describe("describeEmissionWindow", () => {
  it("keeps the epoch countdown for a graduated mine", () => {
    const window = describeEmissionWindow({
      curve: curve({ onCurve: false }),
      daysRemaining: null,
      epochEndsAt: NOW_S + 6 * 86_400,
      now: NOW_MS,
    });
    expect(window).toEqual({
      label: "Next reduction",
      value: "6d 0h 0m",
      detail: "block reward steps down each epoch",
      onCurve: false,
    });
  });

  it("reports the curve runway instead of an epoch countdown", () => {
    const window = describeEmissionWindow({
      curve: curve(),
      daysRemaining: 12.4,
      epochEndsAt: NOW_S + 6 * 86_400,
      now: NOW_MS,
    });
    expect(window.label).toBe("Curve cap runs out in");
    expect(window.value).toBe("≈ 12 days");
    expect(window.onCurve).toBe(true);
  });

  it("says the rate is flat when no runway estimate exists", () => {
    const window = describeEmissionWindow({
      curve: curve(),
      daysRemaining: null,
      epochEndsAt: NOW_S,
      now: NOW_MS,
    });
    expect(window.value).toBe("Flat");
    expect(window.detail).toContain("no epoch reductions");
  });

  it("reports the spent cap as awaiting graduation", () => {
    const window = describeEmissionWindow({
      curve: curve({ open: false, mined: 1_000_000, remaining: 0, progress: 1 }),
      daysRemaining: null,
      epochEndsAt: NOW_S,
      now: NOW_MS,
    });
    expect(window.value).toBe("Awaiting graduation");
    expect(window.detail).toBe("curve cap reached — mining resumes after graduation");
  });
});

describe("describeMineStatus", () => {
  it("labels the statuses the API documents", () => {
    expect(describeMineStatus("MINING_ACTIVE")).toMatchObject({ badge: "Mining active", tone: "active", known: true });
    expect(describeMineStatus("LAUNCHING")).toMatchObject({ tone: "idle", known: true });
    expect(describeMineStatus("FULLY_MINED")).toMatchObject({ tone: "danger", known: true });
  });

  it("labels a cap-reached curve status as awaiting graduation", () => {
    const view = describeMineStatus("CURVE_CAP_REACHED");
    expect(view.badge).toBe("Awaiting graduation");
    expect(view.detail).toBe("Curve cap reached — mining resumes after graduation.");
    expect(view.tone).toBe("paused");
  });

  it("reads the curve's own numbers when the status column has not caught up", () => {
    const view = describeMineStatus("MINING_ACTIVE", { curveCapSpent: true });
    expect(view.badge).toBe("Awaiting graduation");
    expect(view.tone).toBe("paused");
  });

  it("keeps the louder fully-mined label even when a curve cap is spent", () => {
    expect(describeMineStatus("FULLY_MINED", { curveCapSpent: true }).tone).toBe("danger");
  });

  it("labels a status this build has never seen in its own words", () => {
    const view = describeMineStatus("pool_draining");
    expect(view.known).toBe(false);
    expect(view.badge).toBe("pool draining");
    expect(view.detail).toContain("POOL_DRAINING");
  });

  it("copes with a missing status", () => {
    expect(describeMineStatus(null)).toMatchObject({ badge: "Status unknown", known: false });
    expect(describeMineStatus(undefined)).toMatchObject({ badge: "Status unknown", known: false });
    expect(describeMineStatus("")).toMatchObject({ badge: "Status unknown", known: false });
  });
});

describe("emissionEnded", () => {
  it("is true for a spent reserve and for a spent curve cap", () => {
    expect(emissionEnded("FULLY_MINED", curve({ onCurve: false }))).toBe(true);
    expect(emissionEnded("MINING_ACTIVE", curve({ open: false, remaining: 0, progress: 1 }))).toBe(true);
  });

  it("is false for a mine that is still paying", () => {
    expect(emissionEnded("MINING_ACTIVE", curve())).toBe(false);
  });
});
