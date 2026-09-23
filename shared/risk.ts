import {
  DIGGO_CONFIG,
  type DiggoConfig,
  type RiskLevel,
  type RiskResponse,
  type RiskSignalName,
  type RewardState,
} from "./config";
import type { PublicRiskView } from "./types";

/**
 * Behavioural risk scoring, progressive responses and Mine Trust
 * (spec 49-53, 60, 63).
 *
 * Invariants enforced here:
 * - No single signal decides anything: scores blend several weighted signals.
 * - A single weak signal can never place an account above MEDIUM.
 * - "ban" requires strong, corroborating, multi-signal evidence.
 * - Enforcement escalates progressively to protect normal players.
 * - Scores, weights and thresholds are internal; only neutral copy is public.
 */

export type RiskSignals = Partial<Record<RiskSignalName, number>>;

export interface RiskContribution {
  signal: RiskSignalName;
  raw: number;
  contribution: number;
  /** True when the raw value reached the signal's strong-evidence threshold. */
  strong: boolean;
}

export interface RiskAssessment {
  score: number;
  level: RiskLevel;
  response: RiskResponse;
  rewardState: RewardState;
  strongSignals: RiskSignalName[];
  weakSignals: RiskSignalName[];
  /** Internal breakdown. Never return this to a client. */
  breakdown: RiskContribution[];
}

function clampScore(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(100, Math.round(value));
}

export function riskContributions(
  signals: RiskSignals,
  config: DiggoConfig = DIGGO_CONFIG,
): RiskContribution[] {
  const contributions: RiskContribution[] = [];
  for (const name of Object.keys(config.risk.signals) as RiskSignalName[]) {
    const raw = signals[name];
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) continue;
    const rules = config.risk.signals[name];
    const ratio = raw >= rules.saturation ? 1 : raw / rules.saturation;
    contributions.push({
      signal: name,
      raw,
      contribution: Math.round(rules.weight * ratio),
      strong: raw >= rules.strongAt,
    });
  }
  return contributions;
}

export function riskLevel(score: number, config: DiggoConfig = DIGGO_CONFIG): RiskLevel {
  const safe = clampScore(score);
  if (safe <= config.risk.lowMaxScore) return "LOW";
  if (safe <= config.risk.mediumMaxScore) return "MEDIUM";
  return "HIGH";
}

export function riskResponse(
  score: number,
  strongSignalCount: number,
  config: DiggoConfig = DIGGO_CONFIG,
): RiskResponse {
  const safe = clampScore(score);
  if (
    strongSignalCount >= config.risk.banMinimumStrongSignals &&
    safe >= config.risk.banMinimumScore
  ) {
    return "ban";
  }
  let response: RiskResponse = config.risk.responses[0].response;
  for (const entry of config.risk.responses) {
    if (entry.response === "ban") continue;
    if (safe >= entry.minScore) response = entry.response;
  }
  return response;
}

export function rewardStateFor(
  level: RiskLevel,
  response: RiskResponse,
  config: DiggoConfig = DIGGO_CONFIG,
): RewardState {
  if (response === "ban") return "BLOCKED";
  if (response === "hold" || response === "review") return "HELD";
  return config.risk.rewardStates[level];
}

/**
 * Weighted score in [0, 100]. Weak-only evidence is clamped to the configured
 * ceiling so a single suspicious signal can never hold or block rewards.
 */
export function computeRiskScore(
  signals: RiskSignals,
  config: DiggoConfig = DIGGO_CONFIG,
): number {
  const contributions = riskContributions(signals, config);
  let score = 0;
  let strongCount = 0;
  for (const entry of contributions) {
    if (entry.strong) {
      strongCount += 1;
      score += entry.contribution;
    } else {
      score += Math.min(entry.contribution, config.risk.maxSingleWeakSignalScore);
    }
  }
  if (strongCount === 0) score = Math.min(score, config.risk.weakEvidenceScoreCeiling);
  return clampScore(score);
}

export function assessRisk(signals: RiskSignals, config: DiggoConfig = DIGGO_CONFIG): RiskAssessment {
  const contributions = riskContributions(signals, config);
  let score = 0;
  const strongSignals: RiskSignalName[] = [];
  const weakSignals: RiskSignalName[] = [];
  for (const entry of contributions) {
    if (entry.strong) {
      strongSignals.push(entry.signal);
      score += entry.contribution;
    } else {
      weakSignals.push(entry.signal);
      score += Math.min(entry.contribution, config.risk.maxSingleWeakSignalScore);
    }
  }
  if (strongSignals.length === 0) score = Math.min(score, config.risk.weakEvidenceScoreCeiling);
  const bounded = clampScore(score);
  const level = riskLevel(bounded, config);
  const response = riskResponse(bounded, strongSignals.length, config);
  return {
    score: bounded,
    level,
    response,
    rewardState: rewardStateFor(level, response, config),
    strongSignals,
    weakSignals,
    breakdown: contributions,
  };
}

export function canClaim(state: RewardState): boolean {
  return state === "NORMAL" || state === "UNDER_REVIEW";
}

export function canDiscover(state: RewardState): boolean {
  return state === "NORMAL";
}

/** Neutral, detail-free status copy (spec 62). No score, weights or reasons. */
export function publicRiskView(state: RewardState, config: DiggoConfig = DIGGO_CONFIG): PublicRiskView {
  const status: PublicRiskView["status"] =
    state === "BLOCKED"
      ? "unavailable"
      : state === "HELD"
        ? "under_review"
        : state === "UNDER_REVIEW"
          ? "verification_required"
          : "normal";
  return { status, message: config.risk.publicStatus[state] };
}

export interface TrustInput {
  accountAgeSeconds: number;
  validActivations: number;
  /** 0..1 consistency of the activation streak. */
  streakConsistency: number;
  validClaims: number;
  abuseFlags: number;
  /**
   * Accepted for call-site convenience and deliberately ignored: SOL balance is
   * never a proxy for being human (spec 60).
   */
  solBalance?: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Mine Trust in [0, 100], built only from time, valid play and clean history. */
export function mineTrust(input: TrustInput, config: DiggoConfig = DIGGO_CONFIG): number {
  const trust = config.risk.trust;
  const ageDays = Math.max(0, input.accountAgeSeconds) / config.time.secondsPerDay;
  const age = clamp01(trust.fullAgeDays > 0 ? ageDays / trust.fullAgeDays : 1);
  const activations = clamp01(
    trust.fullValidActivations > 0 ? input.validActivations / trust.fullValidActivations : 1,
  );
  const streakConsistency = clamp01(input.streakConsistency);
  const claims = clamp01(trust.fullValidClaims > 0 ? input.validClaims / trust.fullValidClaims : 1);
  const absenceOfAbuse = clamp01(
    1 - Math.max(0, input.abuseFlags) / trust.abuseFlagsForZeroTrust,
  );
  const blended =
    age * trust.weights.age +
    activations * trust.weights.validActivations +
    streakConsistency * trust.weights.streakConsistency +
    claims * trust.weights.validClaims +
    absenceOfAbuse * trust.weights.absenceOfAbuse;
  return clampScore(blended * 100);
}

