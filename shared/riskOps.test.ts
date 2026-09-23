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
  appealEligible,
  appealStatusFor,
  canonicalJson,
  claimHoldApplies,
  claimHoldState,
  enforcementDecision,
  enforcementModeFor,
  enforcedRewardState,
  isAdminStepUpAction,
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

describe("enforcement modes", () => {
  it("shadows every score-derived refusal by default and never shadows hard safety", () => {
    expect(RISK_OPS.enforcement.mode).toBe("shadow");
    for (const kind of ["score_block", "score_hold", "score_challenge"] as const) {
      const decision = enforcementDecision(kind, "claim_reward");
      expect(decision.enforced).toBe(false);
      expect(decision.shadowed).toBe(true);
      expect(decision.hard).toBe(false);
    }
    for (const kind of ["replay", "rate_limit", "breaker", "admin_block", "admin_hold", "admin_challenge"] as const) {
      const decision = enforcementDecision(kind, "claim_reward");
      expect(decision.enforced).toBe(true);
      expect(decision.shadowed).toBe(false);
      expect(decision.hard).toBe(true);
    }
  });

  it("applies score-derived refusals when the mode says enforce", () => {
    const enforce = createRiskOpsConfig({ enforcement: { mode: "enforce" } });
    const decision = enforcementDecision("score_hold", "claim_reward", enforce);
    expect(decision.enforced).toBe(true);
    expect(decision.shadowed).toBe(false);
    expect(decision.mode).toBe("enforce");
  });

  it("lets a per-action override disagree with the global mode in both directions", () => {
    const staged = createRiskOpsConfig({ enforcement: { overrides: { discovery_roll: "enforce" } } });
    expect(enforcementModeFor("discovery_roll", staged)).toBe("enforce");
    expect(enforcementModeFor("claim_reward", staged)).toBe("shadow");
    expect(enforcementDecision("score_hold", "discovery_roll", staged).enforced).toBe(true);
    expect(enforcementDecision("score_hold", "claim_reward", staged).enforced).toBe(false);

    const inverse = createRiskOpsConfig({
      enforcement: { mode: "enforce", overrides: { activate: "shadow" } },
    });
    expect(enforcementDecision("score_hold", "activate", inverse).enforced).toBe(false);
    expect(enforcementDecision("score_hold", "activate", inverse).shadowed).toBe(true);
    expect(enforcementDecision("score_hold", "claim_reward", inverse).enforced).toBe(true);
  });

  it("keeps the enforced state NORMAL while shadowing and the real one under enforce", () => {
    expect(enforcedRewardState("HELD")).toEqual({ state: "NORMAL", shadowed: true });
    expect(enforcedRewardState("BLOCKED")).toEqual({ state: "NORMAL", shadowed: true });
    expect(enforcedRewardState("UNDER_REVIEW")).toEqual({ state: "NORMAL", shadowed: true });
    expect(enforcedRewardState("NORMAL")).toEqual({ state: "NORMAL", shadowed: false });
    const enforce = createRiskOpsConfig({ enforcement: { mode: "enforce" } });
    expect(enforcedRewardState("HELD", enforce)).toEqual({ state: "HELD", shadowed: false });
    expect(enforcedRewardState("NORMAL", enforce)).toEqual({ state: "NORMAL", shadowed: false });
  });
});

describe("step-up payload canonicalisation", () => {
  it("hashes the same payload the same way whatever order the fields arrived in", () => {
    expect(canonicalJson({ wallet: "w", kind: "CLAIM_HOLD" })).toBe(
      canonicalJson({ kind: "CLAIM_HOLD", wallet: "w" }),
    );
    expect(canonicalJson({ b: [1, { d: 4, c: 3 }], a: 2 })).toBe('{"a":2,"b":[1,{"c":3,"d":4}]}');
    // A key the client left out is not the same payload as one it sent as undefined.
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
    expect(canonicalJson("OPEN")).toBe('"OPEN"');
    expect(canonicalJson(null)).toBe("null");
  });
});

describe("appeals config", () => {
  it("accepts an appeal only from an account that is actually under something", () => {
    expect(appealEligible("HELD")).toBe(true);
    expect(appealEligible("UNDER_REVIEW")).toBe(true);
    expect(appealEligible("BLOCKED")).toBe(true);
    expect(appealEligible("NORMAL")).toBe(false);
    expect(appealStatusFor("accepted")).toBe("ACCEPTED");
    expect(appealStatusFor("rejected")).toBe("REJECTED");
  });

  it("bounds the message, the queue and every rate-limit dimension", () => {
    const appeals = RISK_OPS.appeals;
    expect(appeals.maxMessageLength).toBeGreaterThan(appeals.minMessageLength);
    expect(appeals.maxOpenPerAccount).toBeGreaterThan(0);
    for (const limit of [appeals.wallet, appeals.session, appeals.ip, appeals.device, appeals.network]) {
      expect(limit).toBeGreaterThan(0);
    }
    // Still never IP alone: a shared address keeps a more generous budget than one wallet does.
    expect(appeals.ip).toBeGreaterThan(appeals.wallet);
    expect(appeals.invalidMessage).toContain(String(appeals.minMessageLength));
  });

  it("keeps the neutral player copy free of scores, reasons and numbers", () => {
    const appeals = RISK_OPS.appeals;
    const neutral = [
      appeals.publicMessage,
      appeals.notEligibleMessage,
      appeals.tooManyMessage,
      appeals.statusMessages.OPEN,
      appeals.statusMessages.ACCEPTED,
      appeals.statusMessages.REJECTED,
    ];
    for (const message of neutral) {
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toMatch(/[0-9]/);
      expect(message).not.toMatch(/score|weight|signal|threshold|risk/i);
    }
  });

  it("gives a step-up a two minute window and only the mutating actions", () => {
    expect(RISK_OPS.adminStepUp.ttlSeconds).toBe(120);
    expect(RISK_OPS.adminStepUp.ttlSeconds).toBeLessThanOrEqual(300);
    expect(RISK_OPS.adminStepUp.maxPayloadBytes).toBeGreaterThan(0);
    expect([...RISK_OPS.adminStepUp.actions].sort()).toEqual([
      "appeal.resolve",
      "breaker.close",
      "breaker.open",
      "restriction.lift",
      "restriction.set",
    ]);
    expect(isAdminStepUpAction("breaker.open")).toBe(true);
    expect(isAdminStepUpAction("funds.move")).toBe(false);
    // Nothing that could move value is even nameable as an action.
    for (const action of RISK_OPS.adminStepUp.actions) {
      expect(action).not.toMatch(/withdraw|payout|refund|transfer|seize|reserve/i);
    }
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

describe("reward holds (spec 53, 63, 64)", () => {
  const heldStates = ["UNDER_REVIEW", "HELD", "BLOCKED"] as const;

  it("holds real-value claims in every state that is under scrutiny", () => {
    for (const state of heldStates) {
      expect(claimHoldApplies(state, "claim_reward")).toBe(true);
      expect(claimHoldApplies(state, "claim_discovery")).toBe(true);
      expect(claimHoldState(state, "claim_reward")).toBe(state);
    }
    expect(claimHoldApplies("NORMAL", "claim_reward")).toBe(false);
    expect(claimHoldState("NORMAL", "claim_reward")).toBeNull();
  });

  it("never touches mining accounting, progression or friction", () => {
    const untouched = ["activate", "crew_upgrade", "switch_mine", "discovery_roll", "auth", "bootstrap"] as const;
    for (const state of heldStates) {
      for (const action of untouched) {
        expect(claimHoldApplies(state, action)).toBe(false);
      }
    }
    expect(claimHoldState("HELD", "activate")).toBeNull();
  });

  it("is configurable, so a deployment chooses what a hold covers", () => {
    const noHolds = createRiskOpsConfig({ claimHold: { states: [], actions: [] } });
    expect(claimHoldApplies("BLOCKED", "claim_reward", noHolds)).toBe(false);
    const claimsOnly = createRiskOpsConfig({ claimHold: { states: ["HELD"], actions: ["claim_reward"] } });
    expect(claimHoldApplies("HELD", "claim_reward", claimsOnly)).toBe(true);
    expect(claimHoldApplies("HELD", "claim_discovery", claimsOnly)).toBe(false);
    expect(claimHoldApplies("UNDER_REVIEW", "claim_reward", claimsOnly)).toBe(false);
  });

  it("stays separate from the enforcement mode", () => {
    // A hold is applied by claimHoldApplies in every mode; enforcementDecision still only records a
    // score-derived hold when the action's mode is shadow (spec 63).
    const decision = enforcementDecision("score_hold", "claim_reward", RISK_OPS);
    expect(decision.enforced).toBe(false);
    expect(decision.shadowed).toBe(true);
    expect(claimHoldApplies("HELD", "claim_reward", RISK_OPS)).toBe(true);
  });
});

