import { describe, expect, it } from "vitest";
import { DIGGO_CONFIG, createDiggoConfig, type RiskSignalName } from "./config";
import {
  assessRisk,
  canClaim,
  canDiscover,
  computeRiskScore,
  mineTrust,
  publicRiskView,
  rewardStateFor,
  riskLevel,
  riskResponse,
  type RiskSignals,
} from "./risk";

function signals(name: RiskSignalName, raw: number): RiskSignals {
  const value: RiskSignals = {};
  value[name] = raw;
  return value;
}

const ALL_SIGNALS = Object.keys(DIGGO_CONFIG.risk.signals) as RiskSignalName[];

const STRONG_ABUSE: RiskSignals = {
  walletsPerDeviceCluster: 300,
  accountsPerNetworkCluster: 500,
  activationTimingRegularity: 2,
  activationSynchrony: 1,
  burstActions: 300,
  switchingPatternSimilarity: 2,
  claimBurst: 300,
  creationCluster: 400,
  linkedAbuseHistory: 1,
};

describe("risk scoring", () => {
  it("scores nothing when there are no signals", () => {
    expect(computeRiskScore({})).toBe(0);
    const assessment = assessRisk({});
    expect(assessment.level).toBe("LOW");
    expect(assessment.response).toBe("observe");
    expect(assessment.rewardState).toBe("NORMAL");
    expect(assessment.breakdown).toEqual([]);
  });

  it("never lets a single weak signal exceed MEDIUM", () => {
    for (const name of ALL_SIGNALS) {
      const rules = DIGGO_CONFIG.risk.signals[name];
      const raw = rules.strongAt * 0.9;
      const assessment = assessRisk(signals(name, raw));
      expect(assessment.strongSignals).toEqual([]);
      expect(assessment.level).not.toBe("HIGH");
      expect(assessment.response).not.toBe("ban");
      expect(assessment.response).not.toBe("hold");
      expect(assessment.response).not.toBe("review");
      expect(canClaim(assessment.rewardState)).toBe(true);
      expect(assessment.score).toBeLessThanOrEqual(DIGGO_CONFIG.risk.maxSingleWeakSignalScore);
    }
  });

  it("keeps many weak signals below HIGH too", () => {
    const weak: RiskSignals = {};
    for (const name of ALL_SIGNALS) weak[name] = DIGGO_CONFIG.risk.signals[name].strongAt * 0.9;
    const assessment = assessRisk(weak);
    expect(assessment.level).toBe("MEDIUM");
    expect(assessment.strongSignals).toEqual([]);
    expect(assessment.response).toBe("discovery_restrict");
    expect(assessment.rewardState).toBe("UNDER_REVIEW");
    expect(canClaim(assessment.rewardState)).toBe(true);
    expect(canDiscover(assessment.rewardState)).toBe(false);
  });

  it("blocks a single strong signal from banning on its own", () => {
    const assessment = assessRisk({ linkedAbuseHistory: 1 });
    expect(assessment.strongSignals).toEqual(["linkedAbuseHistory"]);
    expect(assessment.response).toBe("rate_limit");
    expect(assessment.level).toBe("MEDIUM");
    expect(assessment.rewardState).toBe("UNDER_REVIEW");
    expect(canClaim(assessment.rewardState)).toBe(true);
    expect(canDiscover(assessment.rewardState)).toBe(false);
    expect(assessment.score).toBe(DIGGO_CONFIG.risk.signals.linkedAbuseHistory.weight);
  });

  it("bans only with strong multi-signal evidence", () => {
    const twoStrong = assessRisk({ linkedAbuseHistory: 1, walletsPerDeviceCluster: 300 });
    expect(twoStrong.strongSignals).toHaveLength(2);
    expect(twoStrong.score).toBeLessThan(DIGGO_CONFIG.risk.banMinimumScore);
    expect(twoStrong.response).not.toBe("ban");

    const banned = assessRisk(STRONG_ABUSE);
    expect(banned.score).toBeGreaterThanOrEqual(DIGGO_CONFIG.risk.banMinimumScore);
    expect(banned.strongSignals.length).toBeGreaterThanOrEqual(DIGGO_CONFIG.risk.banMinimumStrongSignals);
    expect(banned.response).toBe("ban");
    expect(banned.rewardState).toBe("BLOCKED");
    expect(canClaim(banned.rewardState)).toBe(false);
    expect(canDiscover(banned.rewardState)).toBe(false);
  });

  it("escalates progressively instead of jumping to a ban", () => {
    const friction = assessRisk({ burstActions: 300, claimBurst: 300, activationSynchrony: 1 });
    expect(friction.response).toBe("challenge");
    expect(friction.level).toBe("MEDIUM");

    const restricted = assessRisk({ linkedAbuseHistory: 1, walletsPerDeviceCluster: 300 });
    expect(restricted.response).toBe("discovery_restrict");

    const held = assessRisk({
      linkedAbuseHistory: 1,
      walletsPerDeviceCluster: 300,
      accountsPerNetworkCluster: 500,
      burstActions: 300,
    });
    expect(held.response).toBe("hold");
    expect(held.rewardState).toBe("HELD");
    expect(canClaim(held.rewardState)).toBe(false);
    expect(canDiscover(held.rewardState)).toBe(false);

    const reviewed = assessRisk({
      linkedAbuseHistory: 1,
      walletsPerDeviceCluster: 300,
      accountsPerNetworkCluster: 500,
      burstActions: 300,
      claimBurst: 300,
    });
    expect(reviewed.response).toBe("review");
    expect(reviewed.rewardState).toBe("HELD");
  });

  it("scales contribution with the raw signal value", () => {
    const low = computeRiskScore({ walletsPerDeviceCluster: 2 });
    const mid = computeRiskScore({ walletsPerDeviceCluster: 12 });
    const high = computeRiskScore({ walletsPerDeviceCluster: 20 });
    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(high);
  });

  it("maps scores to levels and reward states", () => {
    const config = DIGGO_CONFIG.risk;
    expect(riskLevel(0)).toBe("LOW");
    expect(riskLevel(config.lowMaxScore)).toBe("LOW");
    expect(riskLevel(config.lowMaxScore + 1)).toBe("MEDIUM");
    expect(riskLevel(config.mediumMaxScore)).toBe("MEDIUM");
    expect(riskLevel(config.mediumMaxScore + 1)).toBe("HIGH");
    expect(riskLevel(1_000)).toBe("HIGH");
    expect(riskResponse(0, 9)).toBe("observe");
    expect(riskResponse(19, 0)).toBe("observe");
    expect(riskResponse(20, 0)).toBe("rate_limit");
    expect(riskResponse(35, 0)).toBe("challenge");
    expect(riskResponse(60, 0)).toBe("discovery_restrict");
    expect(rewardStateFor("LOW", "observe")).toBe("NORMAL");
    expect(rewardStateFor("MEDIUM", "challenge")).toBe("UNDER_REVIEW");
    expect(rewardStateFor("HIGH", "hold")).toBe("HELD");
    expect(rewardStateFor("HIGH", "ban")).toBe("BLOCKED");
  });

  it("honours tightened thresholds from config", () => {
    const strict = createDiggoConfig({ risk: { lowMaxScore: 1, mediumMaxScore: 2 } });
    expect(riskLevel(3, strict)).toBe("HIGH");
    const assessment = assessRisk({ burstActions: 300 }, strict);
    expect(assessment.level).toBe("HIGH");
    expect(assessment.response).not.toBe("ban");
  });
});

describe("public risk view", () => {
  it("returns only neutral status text", () => {
    for (const state of ["NORMAL", "UNDER_REVIEW", "HELD", "BLOCKED"] as const) {
      const view = publicRiskView(state);
      expect(Object.keys(view).sort()).toEqual(["message", "status"]);
      expect(view.message).toBe(DIGGO_CONFIG.risk.publicStatus[state]);
      const serialized = JSON.stringify(view).toLowerCase();
      expect(serialized).not.toContain("score");
      expect(serialized).not.toContain("weight");
      expect(serialized).not.toContain("threshold");
      for (const name of ALL_SIGNALS) expect(serialized).not.toContain(name.toLowerCase());
      const hasDigit = serialized.split("").some((character) => character >= "0" && character <= "9");
      expect(hasDigit).toBe(false);
    }
    expect(publicRiskView("UNDER_REVIEW").message).toBe("Additional verification required.");
    expect(publicRiskView("BLOCKED").status).toBe("unavailable");
  });
});

describe("Mine Trust", () => {
  it("grows with age, valid play and a clean history", () => {
    const trust = mineTrust({
      accountAgeSeconds: 30 * 86_400,
      validActivations: 30,
      streakConsistency: 1,
      validClaims: 30,
      abuseFlags: 0,
    });
    expect(trust).toBe(100);
    expect(mineTrust({ accountAgeSeconds: 0, validActivations: 0, streakConsistency: 0, validClaims: 0, abuseFlags: 0 }))
      .toBe(15);
    expect(mineTrust({ accountAgeSeconds: 15 * 86_400, validActivations: 15, streakConsistency: 0.5, validClaims: 15, abuseFlags: 0 }))
      .toBeLessThan(trust);
  });

  it("punishes abuse flags", () => {
    const clean = mineTrust({ accountAgeSeconds: 30 * 86_400, validActivations: 30, streakConsistency: 1, validClaims: 30, abuseFlags: 0 });
    const flagged = mineTrust({ accountAgeSeconds: 30 * 86_400, validActivations: 30, streakConsistency: 1, validClaims: 30, abuseFlags: 1 });
    expect(flagged).toBeLessThan(clean);
    const dirty = mineTrust({ accountAgeSeconds: 30 * 86_400, validActivations: 30, streakConsistency: 1, validClaims: 30, abuseFlags: 3 });
    expect(dirty).toBe(clean - DIGGO_CONFIG.risk.trust.weights.absenceOfAbuse * 100);
  });

  it("never uses SOL balance as a proxy for being human", () => {
    const base = { accountAgeSeconds: 10 * 86_400, validActivations: 10, streakConsistency: 0.6, validClaims: 10, abuseFlags: 0 };
    expect(mineTrust({ ...base, solBalance: 0 })).toBe(mineTrust(base));
    expect(mineTrust({ ...base, solBalance: 1_000_000 })).toBe(mineTrust(base));
    expect(DIGGO_CONFIG.risk.trust.solBalanceIsNotAnInput).toBe(true);
    expect(Object.keys(DIGGO_CONFIG.risk.trust.weights)).not.toContain("solBalance");
  });
});
