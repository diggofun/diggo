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

import {
  DIGGO_CONFIG,
  type DeepPartial,
  type RewardState,
  deepFreeze,
  type RiskSignalName,
} from "./config";
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
  | "bootstrap"
  | "profile_update";

/**
 * How the gate treats a *score-derived* refusal (spec 63).
 *
 * "shadow" is the launch default: the gate still computes and records every decision it would
 * have made, but only hard safety (replay, rate limits, circuit breakers and an admin's own
 * block) actually stops anybody. That way a false positive costs an operator a row in
 * account_signals instead of a real player a blocked claim, and enforcing is one config change
 * away once the observed decisions have been reviewed.
 *
 * "enforce" is the classic behaviour: the score's response is applied progressively.
 */
export type EnforcementMode = "shadow" | "enforce";

/**
 * Why a gated action was refused, in the gate's own vocabulary. Hard refusals are the ones that
 * hold in every enforcement mode; the score-derived ones are what shadow mode observes.
 */
export type GateRefusalKind =
  | "replay"
  | "rate_limit"
  | "breaker"
  | "admin_block"
  | "admin_hold"
  | "admin_challenge"
  | "score_block"
  | "score_hold"
  | "score_challenge";

/** A refusal that is enforced regardless of risk.enforcement.mode. */
export const HARD_REFUSALS: readonly GateRefusalKind[] = [
  "replay",
  "rate_limit",
  "breaker",
  "admin_block",
  "admin_hold",
  "admin_challenge",
];

export function isHardRefusal(kind: GateRefusalKind): boolean {
  return HARD_REFUSALS.includes(kind);
}

export interface EnforcementConfig {
  /** Global default. "shadow" for launch, so nothing is blocked on a score alone. */
  mode: EnforcementMode;
  /**
   * Per-action overrides, for the staged rollout: an action may enforce while the default
   * shadows, or the other way round. Actions not listed follow mode.
   */
  overrides: Readonly<Partial<Record<GatedActionKey, EnforcementMode>>>;
}

/** Shape of an enforcement decision, kept pure so the gate stays a thin wrapper around it. */
export interface EnforcementDecision {
  action: GatedActionKey | null;
  mode: EnforcementMode;
  kind: GateRefusalKind;
  /** True when the refusal holds even in shadow mode. */
  hard: boolean;
  /** True when the gate must refuse the action. */
  enforced: boolean;
  /** True when the gate would have refused, but shadow mode let it through. */
  shadowed: boolean;
}

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

export type AppealStatus = "OPEN" | "ACCEPTED" | "REJECTED";
export type AppealResolution = "accepted" | "rejected";

export const APPEAL_STATUSES: readonly AppealStatus[] = ["OPEN", "ACCEPTED", "REJECTED"];
export const APPEAL_RESOLUTIONS: readonly AppealResolution[] = ["accepted", "rejected"];

/** The reward states a player may appeal from. A NORMAL account has nothing to appeal about. */
export const APPEAL_STATES: readonly RewardState[] = ["HELD", "UNDER_REVIEW", "BLOCKED"];

export function appealEligible(state: RewardState): boolean {
  return APPEAL_STATES.includes(state);
}

export function appealStatusFor(resolution: AppealResolution): AppealStatus {
  return resolution === "accepted" ? "ACCEPTED" : "REJECTED";
}

/** Shortest and longest appeal a player may file. Kept in one place so copy cannot drift. */
export const APPEAL_MIN_MESSAGE_LENGTH = 20;
export const APPEAL_MAX_MESSAGE_LENGTH = 2_000;
export const APPEAL_MAX_NOTE_LENGTH = 500;

/**
 * Player appeals (spec 53, 62). An appeal is how a real player asks a *person* to look again at
 * a hold. It is a request for review and nothing more: submitting one cannot lift a restriction,
 * change a reward state or move value, and the answer a player sees is neutral copy with no
 * score, weight or reason in it (spec 62).
 */
export interface AppealConfig {
  minMessageLength: number;
  maxMessageLength: number;
  /** Body size refused before anything is parsed. */
  maxBodyBytes: number;
  /** Independent rate-limit dimensions; every one of them must have budget (spec 48, 51). */
  windowSeconds: number;
  wallet: number;
  session: number;
  ip: number;
  device: number;
  network: number;
  /** Open appeals one account may have at the same time. */
  maxOpenPerAccount: number;
  /** Longest admin resolution note that is stored. */
  maxNoteLength: number;
  publicMessage: string;
  notEligibleMessage: string;
  tooManyMessage: string;
  invalidMessage: string;
  /** Neutral status copy per appeal status; never a reason or a score. */
  statusMessages: Readonly<Record<AppealStatus, string>>;
}

export type AdminStepUpAction =
  | "restriction.set"
  | "restriction.lift"
  | "breaker.open"
  | "breaker.close"
  | "appeal.resolve";

export const ADMIN_STEP_UP_ACTIONS: readonly AdminStepUpAction[] = [
  "restriction.set",
  "restriction.lift",
  "breaker.open",
  "breaker.close",
  "appeal.resolve",
];

/**
 * Admin step-up (spec 65, 67). An admin session alone is not enough to mutate anything: every
 * mutating admin call also has to carry a fresh wallet signature over that exact action and
 * payload, so a stolen or replayed session cookie, or a request replayed from a log, cannot
 * place a restriction, flip a breaker or resolve an appeal.
 */
export interface AdminStepUpConfig {
  /** How long one signed step-up stays usable. Deliberately short: it authorises one mutation. */
  ttlSeconds: number;
  /** Largest canonical payload that may be bound to a nonce. */
  maxPayloadBytes: number;
  /** The actions that require a signature. */
  actions: readonly AdminStepUpAction[];
}

export function isAdminStepUpAction(value: unknown): value is AdminStepUpAction {
  return typeof value === "string" && (ADMIN_STEP_UP_ACTIONS as readonly string[]).includes(value);
}

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
  /** Whether a score-derived refusal is applied or only recorded (spec 63). */
  enforcement: EnforcementConfig;
  /** Reward holds: the one score-derived response that is never shadowed (spec 53, 63). */
  claimHold: ClaimHoldConfig;
  appeals: AppealConfig;
  adminStepUp: AdminStepUpConfig;
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

/**
 * Reward holding (spec 53, 63, 64).
 *
 * A hold is the one score-derived response that is applied in *every* enforcement mode, shadow
 * mode included, because holding is non-destructive: mining accounting keeps running, the tokens
 * stay in the mine's program-controlled Mining Reserve, and a cleared account still owns everything
 * it accrued. What a hold stops is the *release* of real tokens to an account the score is still
 * unsure about. That is exactly what spec 53 asks for (mining accounting may keep being observed,
 * withdrawal/claim may be suspended) and what spec 64 wants bounded (a bot nobody caught must not
 * be able to do much damage).
 *
 * Friction stays governed by the enforcement mode: a hold never adds a challenge, never changes an
 * activation outcome and never touches a discovery roll's parameters.
 */
export interface ClaimHoldConfig {
  /** Reward states whose real-value claims are parked instead of released. */
  states: readonly RewardState[];
  /** The actions a hold applies to: real-value claims only. */
  actions: readonly GatedActionKey[];
}

export const DEFAULT_CLAIM_HOLD: ClaimHoldConfig = {
  states: ["UNDER_REVIEW", "HELD", "BLOCKED"],
  actions: ["claim_reward", "claim_discovery"],
};

/**
 * Whether one action on one account has to be held rather than released. Pure, so the gate, the
 * claim handlers and the economy simulation all apply the same rule.
 */
export function claimHoldApplies(
  computed: RewardState,
  action: GatedActionKey,
  config: RiskOpsConfig = RISK_OPS,
): boolean {
  return config.claimHold.states.includes(computed) && config.claimHold.actions.includes(action);
}

/** The state a hold parks a claim under, which is the account's computed state (spec 53). */
export function claimHoldState(
  computed: RewardState,
  action: GatedActionKey,
  config: RiskOpsConfig = RISK_OPS,
): RewardState | null {
  return claimHoldApplies(computed, action, config) ? computed : null;
}

export const RISK_OPS_DEFAULTS: RiskOpsConfig = {
  rateLimits: {
    // Per-IP and per-network budgets are the most generous dimensions on purpose: a family,
    // dorm or office behind one address must stay playable at low volume (spec 51), while the
    // wallet/session/device budgets are what actually stop a farm.
    activate: { windowSeconds: 300, wallet: 6, session: 8, ip: 30, device: 12, network: 45 },
    auth: { windowSeconds: 300, wallet: 12, session: 12, ip: 40, device: 15, network: 60 },
    bootstrap: { windowSeconds: 60, wallet: 20, session: 30, ip: 90, device: 45, network: 180 },
    // A username is changed rarely, so the budget is the tightest of the set. It is still a
    // five-dimension budget: a wallet rotating addresses cannot buy extra attempts, and a shared
    // household IP with a few real players stays far inside it.
    profile_update: { windowSeconds: 300, wallet: 6, session: 8, ip: 30, device: 12, network: 45 },
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
  // Launch default (spec 63): the gate keeps deciding and recording, while only hard safety is
  // enforced. A score cannot stop a real player until an operator has reviewed what it would
  // have done.
  enforcement: {
    mode: "shadow",
    overrides: {},
  },
  // Reward holds are enforced whatever the mode says (spec 53, 63): they cost a suspect account
  // nothing it cannot get back, and they are what keeps an undetected farm from draining real
  // tokens before an operator has looked at it (spec 64).
  claimHold: DEFAULT_CLAIM_HOLD,
  appeals: {
    minMessageLength: APPEAL_MIN_MESSAGE_LENGTH,
    maxMessageLength: APPEAL_MAX_MESSAGE_LENGTH,
    maxBodyBytes: 8_192,
    windowSeconds: 3_600,
    // Appeals are rare and deliberate, so the wallet budget is small. The IP budget stays
    // generous: a household, dorm or office behind one address has to stay able to appeal.
    wallet: 3,
    session: 3,
    ip: 12,
    device: 6,
    network: 20,
    maxOpenPerAccount: 3,
    maxNoteLength: APPEAL_MAX_NOTE_LENGTH,
    publicMessage: "Your appeal has been received. A person reviews every appeal.",
    notEligibleMessage: "There is nothing under review for this account right now.",
    tooManyMessage: "Too many appeals. Please wait before trying again.",
    invalidMessage:
      "Please describe your situation in " +
      APPEAL_MIN_MESSAGE_LENGTH +
      " to " +
      APPEAL_MAX_MESSAGE_LENGTH +
      " characters.",
    statusMessages: {
      OPEN: "Your appeal is waiting for review.",
      ACCEPTED: "Your appeal was reviewed and accepted.",
      REJECTED: "Your appeal was reviewed and no change was made.",
    },
  },
  adminStepUp: {
    ttlSeconds: 120,
    maxPayloadBytes: 16_384,
    actions: ADMIN_STEP_UP_ACTIONS,
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

// --- enforcement decisions --------------------------------------------------------------

/** The enforcement mode that governs one action: its override, or the global default. */
export function enforcementModeFor(
  action: GatedActionKey,
  config: RiskOpsConfig = RISK_OPS,
): EnforcementMode {
  return config.enforcement.overrides[action] ?? config.enforcement.mode;
}

/**
 * Turns a refusal into a decision. Hard safety is enforced in every mode; a score-derived
 * refusal is enforced only when the action's mode says so, and is otherwise left to be recorded
 * as a shadow decision (spec 63). Reward holds do not come through here: they are decided by
 * claimHoldApplies() and applied in every mode, because holding a claim is reversible.
 */
export function enforcementDecision(
  kind: GateRefusalKind,
  action: GatedActionKey | null,
  config: RiskOpsConfig = RISK_OPS,
): EnforcementDecision {
  const mode = action === null ? config.enforcement.mode : enforcementModeFor(action, config);
  const hard = isHardRefusal(kind);
  const enforced = hard || mode === "enforce";
  return { action, mode, kind, hard, enforced, shadowed: !hard && !enforced };
}

/**
 * The state the gate persists onto account_risk/players and that every gameplay module reads.
 * In shadow mode a score-derived state is not a state at all: it is an observation, so the
 * stored state stays NORMAL while the computed one is kept beside it for review.
 */
export function enforcedRewardState(
  computed: RewardState,
  config: RiskOpsConfig = RISK_OPS,
): { state: RewardState; shadowed: boolean } {
  if (config.enforcement.mode === "enforce") return { state: computed, shadowed: false };
  return { state: "NORMAL", shadowed: computed !== "NORMAL" };
}

/**
 * Canonical JSON: object keys sorted, undefined-valued keys dropped. An admin step-up signature
 * binds this exact string, so the same payload signed by the client always hashes to the same
 * value on the server, whatever order the fields arrived in.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map((entry) => canonicalJson(entry)).join(",") + "]";
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return (
    "{" +
    entries.map(([key, entry]) => JSON.stringify(key) + ":" + canonicalJson(entry)).join(",") +
    "}"
  );
}

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
