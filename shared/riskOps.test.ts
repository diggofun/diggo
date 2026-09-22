import { describe, expect, it } from "vitest";
import { DIGGO_CONFIG } from "./config";
import { assessRisk } from "./risk";
import {
  type AlertMetricSnapshot,
  type ClusterCounts,
  RISK_OPS,
  activationIntervals,
  activationSynchrony,
  alertSeverityRank,
  buildRiskSignals,
  createRiskOpsConfig,
  emptyMetricSnapshot,
  evaluateAlerts,
  linkedAbuseRatio,
  rateLimitDimensions,
  switchingSimilarity,
  timingRegularity,
} from "./riskOps";

function counts(overrides: Partial<ClusterCounts> = {}): ClusterCounts {
  return {
    walletsOnDevice: 0,
    walletsOnNetwork: 0,
    accountsCreatedInWindow: 0,
    peakActionsPerMinute: 0,
    actionsInBurstWindow: 0,
    claimsInWindow: 0,
    activationIntervalsSeconds: [],
    activationTimestamps: [],
    clusterWalletsOnSameMine: 0,
    clusterHardFlaggedWallets: 0,
    ...overrides,
  };
}

function snapshot(overrides: Partial<AlertMetricSnapshot> = {}): AlertMetricSnapshot {
  return { ...emptyMetricSnapshot(), ...overrides };
}

describe("risk ops config", () => {
  it("rate limits every gated action on five dimensions, never on IP alone", () => {
    for (const limits of Object.values(RISK_OPS.rateLimits)) {
      const dimensions = rateLimitDimensions(limits).map((entry) => entry.dimension);
      expect(dimensions).toEqual(["wallet", "session", "ip", "device", "network"]);
      for (const entry of rateLimitDimensions(limits)) expect(entry.limit).toBeGreaterThan(0);
      // The per-IP budget is the most forgiving one: a household, dorm or office behind one
      // address has to stay playable at low volume (spec 51).
      expect(limits.ip).toBeGreaterThan(limits.device);
      expect(limits.ip).toBeGreaterThanOrEqual(limits.wallet);
    }
  });

  it("is frozen and derives tuned copies without mutating the defaults", () => {
    expect(Object.isFrozen(RISK_OPS)).toBe(true);
    expect(Object.isFrozen(RISK_OPS.rateLimits.activate)).toBe(true);
    const tuned = createRiskOpsConfig({ rateLimits: { activate: { device: 3 } } });
    expect(tuned.rateLimits.activate.device).toBe(3);
    expect(tuned.rateLimits.activate.ip).toBe(RISK_OPS.rateLimits.activate.ip);
    expect(RISK_OPS.rateLimits.activate.device).toBe(12);
  });
});

describe("signal transforms", () => {
  it("treats identical intervals as machine-like and jitter as human", () => {
    expect(timingRegularity([])).toBe(0);
    expect(timingRegularity([86_400, 86_400])).toBe(0);
    expect(timingRegularity([86_400, 86_400, 86_400, 86_400])).toBe(2);
    expect(timingRegularity([0, 0, 0, 0])).toBe(2);
    expect(timingRegularity([100, 90_000, 400, 70_000])).toBeLessThan(1);
  });

  it("measures activation synchrony as the busiest wall-clock bucket share", () => {
    expect(activationSynchrony([], 300)).toBe(0);
    expect(activationSynchrony([0, 10], 300)).toBe(0);
    expect(activationSynchrony([0, 10, 20], 300)).toBe(1);
    const same = [1_700_000_000, 1_700_000_010, 1_700_000_020, 1_700_000_030];
    expect(activationSynchrony(same, 300)).toBe(1);
    expect(activationSynchrony([0, 400, 800], 300)).toBeCloseTo(1 / 3, 5);
  });

  it("derives cluster similarity and linked-abuse ratios inside their documented bounds", () => {
    expect(switchingSimilarity(10, 10)).toBe(2);
    expect(switchingSimilarity(5, 10)).toBe(1);
    expect(switchingSimilarity(0, 10)).toBe(0);
    expect(switchingSimilarity(10, 0)).toBe(0);
    expect(linkedAbuseRatio(1, 4)).toBe(0.25);
    expect(linkedAbuseRatio(9, 4)).toBe(1);
  });

  it("never turns an absent measurement into evidence", () => {
    expect(buildRiskSignals(counts())).toEqual({});
    const signals = buildRiskSignals(counts({ walletsOnDevice: 3, claimsInWindow: 0 }));
    expect(signals.walletsPerDeviceCluster).toBe(3);
    expect(signals.claimBurst).toBeUndefined();
    expect(signals.activationSynchrony).toBeUndefined();
  });

  it("derives activation intervals from newest-first timestamps", () => {
    expect(activationIntervals([300, 200, 100])).toEqual([100, 100]);
    expect(activationIntervals([100])).toEqual([]);
  });
});

describe("progressive responses", () => {
  it("keeps one weak signal below the escalation ceiling", () => {
    const single = buildRiskSignals(counts({ walletsOnDevice: 30 }));
    const assessment = assessRisk(single);
    expect(assessment.strongSignals).toEqual([]);
    expect(assessment.score).toBeLessThanOrEqual(DIGGO_CONFIG.risk.weakEvidenceScoreCeiling);
    expect(assessment.level).toBe("LOW");
    expect(assessment.rewardState).toBe("NORMAL");
  });

  it("never reaches a ban without strong, corroborating evidence", () => {
    const weakOnly = buildRiskSignals(
      counts({ walletsOnDevice: 30, walletsOnNetwork: 60, peakActionsPerMinute: 25, claimsInWindow: 20 }),
    );
    const assessment = assessRisk(weakOnly);
    expect(assessment.strongSignals).toEqual([]);
    expect(assessment.level).toBe("MEDIUM");
    expect(assessment.response).not.toBe("ban");
    expect(assessment.rewardState).toBe("UNDER_REVIEW");
  });
});

describe("alert evaluation", () => {
  it("stays quiet on a normal snapshot", () => {
    expect(evaluateAlerts(snapshot())).toEqual([]);
  });

  it("fires above threshold and never below the noise floor", () => {
    const fired = evaluateAlerts(snapshot({ reserveDrainVelocityUsdPerHour: 40 }));
    expect(fired.map((alert) => alert.name)).toContain("reserve_drain_velocity");
    expect(fired[0]?.value).toBe(40);
    expect(fired[0]?.threshold).toBe(RISK_OPS.alerts.find((rule) => rule.name === "reserve_drain_velocity")?.threshold);
    // 0.5 USD/hour is above nothing that matters and below the floor for a velocity alert.
    expect(evaluateAlerts(snapshot({ reserveDrainVelocityUsdPerHour: 0.5 }))).toEqual([]);
  });

  it("returns the worst severity first", () => {
    const fired = evaluateAlerts(
      snapshot({ replayAttemptsPerHour: 120, reserveDrainedFraction: 0.6, claimsPerHour: 130 }),
    );
    expect(fired.length).toBeGreaterThanOrEqual(3);
    expect(alertSeverityRank(fired[0].severity)).toBeGreaterThanOrEqual(alertSeverityRank(fired[1].severity));
    expect(fired[0].severity).toBe("critical");
  });
});
