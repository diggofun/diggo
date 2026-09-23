/**
 * Risk-operations configuration and the pure aggregation math behind the server-side Account
 * Risk Score (spec 39-53, 60-67).
 *
 * This module deliberately has no Cloudflare bindings, so every threshold and every signal
 * transform stays unit-testable. Its worker-side counterparts are worker/risk.ts (the gate),
 * worker/signals.ts (signal persistence), worker/breakers.ts (circuit breakers) and
 * worker/telemetry.ts (metrics and alert evaluation).
 *
 * Everything here is internal: scores, weights, thresholds and rate-limit budgets are never
 * returned to a client (spec 62). Only neutral copy is public.
 */

import { DIGGO_CONFIG, type DeepPartial, deepFreeze, type RiskSignalName } from "./config";
import type { RiskSignals } from "./risk";

/** Every action the risk gate can gate (see gateAction in worker/risk.ts). */
export type GatedActionKey =
  | "activate"
  | "claim_reward"
  | "claim_discovery"
  | "discovery_roll"
  | "switch_mine"
  | "crew_upgrade"
  | "auth"
  | "bootstrap";

/**
 * Gating is always keyed on several dimensions at once, never on IP alone (spec 48, 51):
 * one household, school, dorm or CGNAT egress shares an IP, while one wallet farm shares a
 * device and a session.
 */
export type RateLimitDimension = "wallet" | "session" | "ip" | "device" | "network";

export interface ActionRateLimitConfig {
  /** Fixed counter-bucket width in seconds. */
  windowSeconds: number;
  wallet: number;
  session: number;
  ip: number;
  device: number;
  network: number;
}

export interface ChallengeConfig {
  /** How long an issued verification challenge stays usable. */
  ttlSeconds: number;
  /** How long one successful challenge clears further friction for this wallet+action. */
  clearedSeconds: number;
  /** Actions where a MEDIUM account clears a challenge before proceeding (spec 52). */
  gatedActions: readonly GatedActionKey[];
  /** Actions a HELD account may still perform: mining accounting keeps running (spec 53). */
  heldActions: readonly GatedActionKey[];
  /** Neutral public copy. Never a reason, score or threshold (spec 62). */
  publicMessage: string;
  challengeMessage: string;
}

export type AlertSeverity = "info" | "warning" | "critical";

/** The alert-ready metric set of spec 66. */
export interface AlertMetricSnapshot {
  activationsPerHour: number;
  newAccountsPerHour: number;
  claimsPerHour: number;
  discoveriesPerHour: number;
  avgDiscoveryValueUsd: number;
  discoveryValuePerAccountUsd: number;
  walletsPerDeviceCluster: number;
  walletsPerNetworkCluster: number;
  failedChallengesPerHour: number;
  replayAttemptsPerHour: number;
  rateLimitHitsPerHour: number;
  synchronizedActivityShare: number;
  reserveDrainVelocityUsdPerHour: number;
  reserveDrainedFraction: number;
}

export type AlertMetricName = keyof AlertMetricSnapshot;

export interface AlertRule {
  name: string;
  metric: AlertMetricName;
  severity: AlertSeverity;
  /** Fires when the metric is at or above this value. */
  threshold: number;
  /** Below this absolute value the rule never fires, so tiny samples stay quiet. */
  floor: number;
}

export interface RiskAlert extends AlertRule {
  value: number;
  metricValue: number;
  observedAt: number;
}

export interface BreakerThresholdConfig {
  /** USD/hour leaving the Discovery Reserve that opens the discovery breaker automatically. */
  reserveDrainVelocityUsdPerHour: number;
  /** Never auto-open below this much drained value in the window, however fast it looks. */
  reserveDrainMinUsd: number;
  /** Minimum discoveries in the window before the drain velocity is trusted at all. */
  minimumSampleDiscoveries: number;
  /** Auto-opened breakers close again once velocity falls to this share of the threshold. */
  autoCloseShare: number;
  /** After an admin closes a breaker by hand, the cron stays off it for this many minutes. */
  manualHoldMinutes: number;
}

export interface RiskOpsConfig {
  rateLimits: Readonly<Record<GatedActionKey, ActionRateLimitConfig>>;
  challenge: ChallengeConfig;
  /** Window used for device/network cluster counting. */
  clusterWindowSeconds: number;
  /** Window used for burst and claim counting. */
  burstWindowSeconds: number;
  /** Window for "these accounts were created together" clustering (spec 61). */
  creationClusterWindowSeconds: number;
  /** Bucket width used to measure activation-time synchrony. */
  synchronyBucketSeconds: number;
  /** Minimum activation samples before timing regularity is trusted. */
  minimumTimingSamples: number;
  /** How many recent activations feed the regularity/synchrony signals. */
  maxTimingSamples: number;
  /** How long a computed risk score stays fresh before the gate recomputes it. */
  refreshIntervalSeconds: number;
  /** Accounts refreshed per cron run. */
  cronRefreshLimit: number;
  alerts: readonly AlertRule[];
  breakers: BreakerThresholdConfig;
}

export const RISK_OPS_DEFAULTS: RiskOpsConfig = {
  rateLimits: {
    // Per-IP and per-network budgets are the most generous dimensions on purpose: a family,
    // dorm or office behind one address must stay playable at low volume (spec 51), while the
    // wallet/session/device budgets are what actually stop a farm.
    activate: { windowSeconds: 300, wallet: 6, session: 8, ip: 30, device: 12, network: 45 },
    auth: { windowSeconds: 300, wallet: 12, session: 12, ip: 40, device: 15, network: 60 },
    bootstrap: { windowSeconds: 60, wallet: 20, session: 30, ip: 90, device: 45, network: 180 },
    crew_upgrade: { windowSeconds: 60, wallet: 24, session: 36, ip: 90, device: 60, network: 150 },
    switch_mine: { windowSeconds: 60, wallet: 12, session: 15, ip: 45, device: 24, network: 75 },
    claim_reward: { windowSeconds: 300, wallet: 20, session: 30, ip: 90, device: 45, network: 150 },
    claim_discovery: { windowSeconds: 300, wallet: 12, session: 18, ip: 45, device: 24, network: 75 },
    discovery_roll: { windowSeconds: 300, wallet: 12, session: 15, ip: 36, device: 18, network: 60 },
  },
  challenge: {
    ttlSeconds: 300,
    clearedSeconds: 900,
    gatedActions: ["activate", "claim_reward", "claim_discovery", "discovery_roll", "switch_mine", "crew_upgrade"],
    heldActions: ["activate", "auth", "bootstrap", "switch_mine", "crew_upgrade"],
    publicMessage: "Additional verification required.",
    challengeMessage: "Additional verification required.",
  },
  clusterWindowSeconds: 86_400,
  burstWindowSeconds: 3_600,
  creationClusterWindowSeconds: 86_400,
  synchronyBucketSeconds: 300,
  minimumTimingSamples: 3,
  maxTimingSamples: 30,
  refreshIntervalSeconds: 900,
  cronRefreshLimit: 200,
  alerts: [
    { name: "reserve_drain_velocity", metric: "reserveDrainVelocityUsdPerHour", severity: "critical", threshold: 30, floor: 1 },
    { name: "reserve_drained_fraction", metric: "reserveDrainedFraction", severity: "warning", threshold: 0.5, floor: 0.05 },
    { name: "discovery_value_per_account", metric: "discoveryValuePerAccountUsd", severity: "critical", threshold: 5, floor: 0.01 },
    { name: "avg_discovery_value", metric: "avgDiscoveryValueUsd", severity: "warning", threshold: 8, floor: 0.01 },
    { name: "device_cluster", metric: "walletsPerDeviceCluster", severity: "critical", threshold: 100, floor: 25 },
    { name: "network_cluster", metric: "walletsPerNetworkCluster", severity: "warning", threshold: 200, floor: 40 },
    { name: "synchronized_activity", metric: "synchronizedActivityShare", severity: "warning", threshold: 0.8, floor: 0.1 },
    { name: "replay_attempts", metric: "replayAttemptsPerHour", severity: "critical", threshold: 100, floor: 1 },
    { name: "replay_attempts_low", metric: "replayAttemptsPerHour", severity: "warning", threshold: 25, floor: 1 },
    { name: "rate_limit_hits", metric: "rateLimitHitsPerHour", severity: "warning", threshold: 300, floor: 1 },
    { name: "failed_challenges", metric: "failedChallengesPerHour", severity: "warning", threshold: 50, floor: 1 },
    { name: "claims_per_hour", metric: "claimsPerHour", severity: "warning", threshold: 120, floor: 1 },
    { name: "discoveries_per_hour", metric: "discoveriesPerHour", severity: "warning", threshold: 120, floor: 1 },
    { name: "activations_per_hour", metric: "activationsPerHour", severity: "critical", threshold: 3_000, floor: 1 },
    { name: "new_accounts_per_hour", metric: "newAccountsPerHour", severity: "critical", threshold: 1_000, floor: 1 },
  ],
  breakers: {
    reserveDrainVelocityUsdPerHour: 25,
    reserveDrainMinUsd: 5,
    minimumSampleDiscoveries: 10,
    autoCloseShare: 0.5,
    manualHoldMinutes: 60,
  },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeOverrides<T>(base: T, override: unknown): T {
  if (override === undefined) return base;
  if (Array.isArray(override)) return override as unknown as T;
  if (isPlainObject(base) && isPlainObject(override)) {
    const merged: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const key of Object.keys(override)) merged[key] = mergeOverrides(merged[key], override[key]);
    return merged as unknown as T;
  }
  return override as T;
}

export const RISK_OPS: RiskOpsConfig = deepFreeze(RISK_OPS_DEFAULTS);

/** Derives a tuned ops config from the defaults (tests, per-environment tuning). */
export function createRiskOpsConfig(overrides: DeepPartial<RiskOpsConfig> = {}): RiskOpsConfig {
  return deepFreeze(mergeOverrides(RISK_OPS_DEFAULTS, overrides));
}

const SEVERITY_RANK: Readonly<Record<AlertSeverity, number>> = { info: 1, warning: 2, critical: 3 };

export function alertSeverityRank(severity: AlertSeverity): number {
  return SEVERITY_RANK[severity];
}

/** Every distinct dimension a gated action is rate limited on. */
export function rateLimitDimensions(limits: ActionRateLimitConfig): readonly { dimension: RateLimitDimension; limit: number }[] {
  return [
    { dimension: "wallet", limit: limits.wallet },
    { dimension: "session", limit: limits.session },
    { dimension: "ip", limit: limits.ip },
    { dimension: "device", limit: limits.device },
    { dimension: "network", limit: limits.network },
  ];
}

// --- signal aggregation -----------------------------------------------------------------

/**
 * Raw cluster/behaviour counts read from account_signals (worker/signals.ts) for one wallet.
 * Kept as a plain object so the transform below is pure and testable.
 */
export interface ClusterCounts {
  walletsOnDevice: number;
  walletsOnNetwork: number;
  accountsCreatedInWindow: number;
  peakActionsPerMinute: number;
  actionsInBurstWindow: number;
  claimsInWindow: number;
  activationIntervalsSeconds: readonly number[];
  activationTimestamps: readonly number[];
  clusterWalletsOnSameMine: number;
  clusterHardFlaggedWallets: number;
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  return value > max ? max : value;
}

/**
 * Machine-like regularity of activation intervals, in [0, 2].
 * 2 means every interval was identical (a cron job on a fixed period), 1 is human-ish jitter
 * around a daily rhythm, 0 is noise or too few samples.
 */
export function timingRegularity(
  intervals: readonly number[],
  minimumSamples = RISK_OPS.minimumTimingSamples,
): number {
  if (intervals.length < minimumSamples) return 0;
  const mean = intervals.reduce((sum, value) => sum + value, 0) / intervals.length;
  if (mean <= 0) return 2;
  const variance = intervals.reduce((sum, value) => sum + (value - mean) ** 2, 0) / intervals.length;
  return clamp(2 - (2 * Math.sqrt(variance)) / mean, 0, 2);
}

/**
 * Share in [0, 1] of recent activations that landed in the single most common wall-clock
 * bucket. Farm scripts fire every account on the same minute offset; a human drifts.
 */
export function activationSynchrony(
  timestamps: readonly number[],
  bucketSeconds: number,
  daySeconds = DIGGO_CONFIG.time.secondsPerDay,
): number {
  if (timestamps.length < RISK_OPS.minimumTimingSamples || bucketSeconds <= 0 || daySeconds <= 0) return 0;
  const buckets = new Map<number, number>();
  for (const timestamp of timestamps) {
    const bucket = Math.floor((timestamp % daySeconds) / bucketSeconds);
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
  }
  let peak = 0;
  for (const count of buckets.values()) peak = Math.max(peak, count);
  return clamp(peak / timestamps.length, 0, 1);
}

/** 2 means the whole cluster mines the exact same mine, 1 means half of it does. */
export function switchingSimilarity(clusterWalletsOnSameMine: number, clusterSize: number): number {
  if (clusterSize <= 0) return 0;
  return clamp((2 * nonNegative(clusterWalletsOnSameMine)) / clusterSize, 0, 2);
}

/** Share in [0, 1] of the cluster that is already flagged (spec 61 "linked abuse history"). */
export function linkedAbuseRatio(flaggedWallets: number, clusterSize: number): number {
  if (clusterSize <= 0) return 0;
  return clamp(nonNegative(flaggedWallets) / clusterSize, 0, 1);
}

/**
 * Raw counts -> the weighted signal names shared/risk.ts scores. Zero and non-finite signals
 * are dropped so an absent measurement can never look like evidence.
 */
export function buildRiskSignals(counts: ClusterCounts): RiskSignals {
  const clusterSize = nonNegative(counts.walletsOnDevice);
  const signals: RiskSignals = {
    walletsPerDeviceCluster: clusterSize,
    accountsPerNetworkCluster: nonNegative(counts.walletsOnNetwork),
    activationTimingRegularity: timingRegularity(counts.activationIntervalsSeconds),
    activationSynchrony: activationSynchrony(counts.activationTimestamps, RISK_OPS.synchronyBucketSeconds),
    burstActions: nonNegative(counts.peakActionsPerMinute),
    switchingPatternSimilarity: switchingSimilarity(counts.clusterWalletsOnSameMine, clusterSize),
    claimBurst: nonNegative(counts.claimsInWindow),
    creationCluster: nonNegative(counts.accountsCreatedInWindow),
    linkedAbuseHistory: linkedAbuseRatio(counts.clusterHardFlaggedWallets, clusterSize),
  };
  for (const name of Object.keys(signals) as RiskSignalName[]) {
    const value = signals[name];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) delete signals[name];
  }
  return signals;
}

/** Rolling activation intervals (seconds, newest first) from raw activation timestamps. */
export function activationIntervals(timestampsDescending: readonly number[]): number[] {
  const intervals: number[] = [];
  for (let index = 1; index < timestampsDescending.length; index += 1) {
    const interval = timestampsDescending[index - 1] - timestampsDescending[index];
    if (Number.isFinite(interval) && interval >= 0) intervals.push(interval);
  }
  return intervals;
}

// --- alert evaluation -------------------------------------------------------------------

/**
 * Pure alert evaluation. Returns every rule that fired, worst first, so the caller can log
 * structured JSON and let an external alerting integration pick it up (spec 66).
 */
export function evaluateAlerts(
  metrics: AlertMetricSnapshot,
  config: RiskOpsConfig = RISK_OPS,
  observedAt = Math.floor(Date.now() / 1_000),
): RiskAlert[] {
  const fired: RiskAlert[] = [];
  for (const rule of config.alerts) {
    const metricValue = metrics[rule.metric];
    if (typeof metricValue !== "number" || !Number.isFinite(metricValue)) continue;
    if (metricValue < rule.floor) continue;
    if (metricValue < rule.threshold) continue;
    fired.push({ ...rule, value: metricValue, metricValue, observedAt });
  }
  return fired.sort(
    (left, right) =>
      SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity] ||
      right.metricValue / (right.threshold || 1) - left.metricValue / (left.threshold || 1),
  );
}

/** Empty snapshot; used as the identity for partial metric collection. */
export function emptyMetricSnapshot(): AlertMetricSnapshot {
  return {
    activationsPerHour: 0,
    newAccountsPerHour: 0,
    claimsPerHour: 0,
    discoveriesPerHour: 0,
    avgDiscoveryValueUsd: 0,
    discoveryValuePerAccountUsd: 0,
    walletsPerDeviceCluster: 0,
    walletsPerNetworkCluster: 0,
    failedChallengesPerHour: 0,
    replayAttemptsPerHour: 0,
    rateLimitHitsPerHour: 0,
    synchronizedActivityShare: 0,
    reserveDrainVelocityUsdPerHour: 0,
    reserveDrainedFraction: 0,
  };
}
