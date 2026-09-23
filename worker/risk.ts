/**
 * The risk gate (spec 39-53, 60-67).
 *
 * One entry point, gateAction, answers a single question for any sensitive action: may this
 * wallet do it right now? It checks admin restrictions, circuit breakers, a multi-dimensional
 * rate limit that is never keyed on IP alone, and the wallet's Account Risk Score, then maps the
 * result onto progressive friction instead of a single blunt yes/no:
 *
 *   LOW      -> proceed (this is the overwhelming majority of real players)
 *   MEDIUM   -> proceed, or clear one verification challenge on the sensitive actions
 *   HIGH     -> reward hold: mining accounting keeps running, claims and discoveries stop
 *   BLOCKED  -> nothing proceeds until an admin lifts it
 *
 * Design rules this module is built to keep:
 * - No single signal decides anything (sun/risk.ts blends weighted signals).
 * - A score, a weight or a reason is never returned: only neutral, detail-free copy (spec 62).
 * - Enforcement escalates progressively, so a false positive costs a real player friction and
 *   never their account (spec 63).
 * - This module can slow a wallet down; it can never move funds. There is no signing, transfer
 *   or withdrawal code anywhere in the anti-abuse layer.
 */
import { DIGGO_CONFIG, type RewardState, type RiskLevel } from "../shared/config";
import {
  assessRisk,
  mineTrust,
  publicRiskView,
  scoreRefusal,
  type RiskSignals,
  type ScoreRefusal,
} from "../shared/risk";
import {
  type AlertMetricSnapshot,
  type ClusterCounts,
  type GateRefusalKind,
  RISK_OPS,
  type RiskOpsConfig,
  activationIntervals,
  buildRiskSignals,
  claimHoldState,
  enforcementDecision,
  enforcedRewardState,
  rateLimitDimensions,
} from "../shared/riskOps";
import type { PublicRiskView } from "../shared/types";
import {
  type ChallengeConsumeResult,
  challengeKey,
  consumeChallengeNonce,
  issueChallenge,
  loadChallenge,
  sessionWallet,
  verifyTurnstile,
  verifyWalletSignature,
} from "./auth";
import type { RuntimeEnv } from "./env";
import {
  type RateLimitCheck,
  apiError,
  checkKeyedRateLimits,
  isBase58Address,
  json,
  readJson,
} from "./http";
import type { PlayerRow } from "./player";
import {
  type ActivityOutcome,
  type RequestFingerprint,
  type RestrictionRow,
  activeRestrictions,
  fingerprintRequest,
  recordActivityRow,
} from "./signals";
import { METRIC, REALIZED_DISCOVERY_PREDICATE, collectMetrics, logAlerts, metric } from "./telemetry";

/** The actions the gate understands. Exactly these, and nothing else. */
export type GatedAction =
  | "activate"
  | "claim_reward"
  | "claim_discovery"
  | "discovery_roll"
  | "switch_mine"
  | "crew_upgrade"
  | "auth"
  | "bootstrap"
  | "profile_update";

export const GATED_ACTIONS: readonly GatedAction[] = [
  "activate",
  "claim_reward",
  "claim_discovery",
  "discovery_roll",
  "switch_mine",
  "crew_upgrade",
  "auth",
  "bootstrap",
  "profile_update",
];

export function isGatedAction(value: unknown): value is GatedAction {
  return typeof value === "string" && (GATED_ACTIONS as readonly string[]).includes(value);
}

export interface GateResult {
  allowed: boolean;
  challengeRequired: boolean;
  rewardState: RewardState;
  /** Neutral copy only (spec 62). Never a score, weight, signal name or threshold. */
  publicMessage?: string;
  retryAfterSec?: number;
  /**
   * Internal only. While enforcement is shadowed the score still reaches a verdict, and this
   * carries it so an operator can see what would have happened. It is never a reason to refuse
   * anything, and callers must not report it to a player.
   */
  shadowState?: RewardState;
}

/** Per-call overrides, so tests and staging can run a tuned config without touching RISK_OPS. */
export interface GateOptions {
  config?: RiskOpsConfig;
  now?: number;
}

/**
 * The score-derived refusal in the gate's own vocabulary. A shadow decision is recorded with the
 * kind, so the observation says *what* would have happened, not just that something would.
 */
const SCORE_REFUSAL_KINDS: Readonly<Record<Exclude<ScoreRefusal, "none">, GateRefusalKind>> = {
  block: "score_block",
  hold: "score_hold",
  challenge: "score_challenge",
};

const STATE_RANK: Readonly<Record<RewardState, number>> = {
  NORMAL: 0,
  UNDER_REVIEW: 1,
  HELD: 2,
  BLOCKED: 3,
};

function worstState(left: RewardState, right: RewardState): RewardState {
  return STATE_RANK[left] >= STATE_RANK[right] ? left : right;
}

function statusMessage(state: RewardState): string {
  return publicRiskView(state).message;
}

// --- account risk record -----------------------------------------------------------------

export interface AccountRiskFlags {
  signals: RiskSignals;
  strong: string[];
  weak: string[];
  response: string;
  source: "request" | "cron" | "admin";
  /**
   * True when the score reached a refusal that the enforcement mode did not apply. Recorded so a
   * reviewer can see, from the risk record alone, why computed_state and reward_state differ.
   */
  shadowed: boolean;
}

export interface AccountRiskRecord {
  wallet: string;
  score: number;
  level: RiskLevel;
  /** The state actually in force: what gameplay and the public risk view read. */
  rewardState: RewardState;
  /** The state the score alone asked for, before the enforcement mode was applied. */
  computedState: RewardState;
  trust: number;
  flags: AccountRiskFlags;
  updatedAt: number;
}

interface AccountRiskRow {
  wallet: string;
  score: number;
  level: RiskLevel;
  reward_state: RewardState;
  computed_state: RewardState | null;
  trust: number;
  flags: string;
  updated_at: number;
}

function parseFlags(raw: string): AccountRiskFlags {
  try {
    const parsed = JSON.parse(raw) as Partial<AccountRiskFlags>;
    return {
      signals: parsed.signals ?? {},
      strong: parsed.strong ?? [],
      weak: parsed.weak ?? [],
      response: parsed.response ?? "observe",
      source: parsed.source ?? "request",
      shadowed: parsed.shadowed === true,
    };
  } catch {
    return { signals: {}, strong: [], weak: [], response: "observe", source: "request", shadowed: false };
  }
}

export async function getAccountRisk(env: RuntimeEnv, wallet: string): Promise<AccountRiskRecord | null> {
  const row = await env.DB.prepare(
    "SELECT wallet, score, level, reward_state, computed_state, trust, flags, updated_at " +
      "FROM account_risk WHERE wallet = ?1",
  )
    .bind(wallet)
    .first<AccountRiskRow>();
  if (!row) return null;
  return {
    wallet: row.wallet,
    score: row.score,
    level: row.level,
    rewardState: row.reward_state,
    // Rows written before 0014 have no computed state; the enforced state is the best answer.
    computedState: row.computed_state ?? row.reward_state,
    trust: row.trust,
    flags: parseFlags(row.flags),
    updatedAt: row.updated_at,
  };
}

// --- signal reads ------------------------------------------------------------------------

interface SignalReadResult extends ClusterCounts {
  claimedDiscoveries: number;
}

function asNumber(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Most recent fingerprint on record for a wallet, used when the cron refreshes a risk score. */
async function latestFingerprint(env: RuntimeEnv, wallet: string): Promise<RequestFingerprint> {
  const row = await env.DB.prepare(
    "SELECT ip_hash, network_hash, device_hash, session_id FROM account_signals WHERE wallet = ?1 " +
      "ORDER BY ts DESC LIMIT 1",
  )
    .bind(wallet)
    .first<{
      ip_hash: string | null;
      network_hash: string | null;
      device_hash: string | null;
      session_id: string | null;
    }>();
  return {
    ipHash: row?.ip_hash ?? null,
    networkHash: row?.network_hash ?? null,
    deviceHash: row?.device_hash ?? null,
    sessionId: row?.session_id ?? null,
  };
}

/**
 * Reads the raw behaviour counters behind every signal for one wallet. The hashed device and
 * network keys drive cluster sizes, and the timing signals are measured across the whole device
 * cluster rather than inside one wallet - "identical minute/second offsets" is a cluster
 * property (spec 61), and a single wallet can only ever activate once a day. An absent key
 * simply yields zero, which is why a missing header can never look like evidence.
 */
async function readSignalCounts(
  env: RuntimeEnv,
  wallet: string,
  fingerprint: RequestFingerprint,
  now: number,
  config: RiskOpsConfig,
): Promise<SignalReadResult> {
  const device = fingerprint.deviceHash ?? "";
  const network = fingerprint.networkHash ?? "";
  const clusterFrom = now - config.clusterWindowSeconds;
  const burstFrom = now - config.burstWindowSeconds;
  const results = await env.DB.batch<Record<string, number | null>>([
    env.DB.prepare(
      "SELECT COUNT(DISTINCT wallet) AS n FROM account_signals WHERE device_hash = ?1 AND ts >= ?2",
    ).bind(device, clusterFrom),
    env.DB.prepare(
      "SELECT COUNT(DISTINCT wallet) AS n FROM account_signals WHERE network_hash = ?1 AND ts >= ?2",
    ).bind(network, clusterFrom),
    env.DB.prepare(
      "SELECT COUNT(*) AS n FROM players WHERE created_at IS NOT NULL AND " +
        "ABS(created_at - COALESCE((SELECT created_at FROM players WHERE wallet = ?1), -999999999)) <= ?2",
    ).bind(wallet, config.creationClusterWindowSeconds),
    env.DB.prepare(
      "SELECT COALESCE(MAX(c), 0) AS n FROM (SELECT COUNT(*) AS c FROM account_signals " +
        "WHERE wallet = ?1 AND ts >= ?2 GROUP BY ts / 60)",
    ).bind(wallet, burstFrom),
    env.DB.prepare(
      "SELECT COUNT(*) AS n FROM account_signals WHERE wallet = ?1 " +
        "AND action IN ('claim_reward', 'claim_discovery') AND ts >= ?2",
    ).bind(wallet, clusterFrom),
    env.DB.prepare("SELECT COUNT(*) AS n FROM account_signals WHERE wallet = ?1 AND ts >= ?2").bind(wallet, burstFrom),
    env.DB.prepare(
      "SELECT ts FROM account_signals WHERE device_hash = ?1 AND action = 'activate' AND outcome = 'ok' " +
        "AND ts >= ?2 ORDER BY ts DESC LIMIT ?3",
    ).bind(device, clusterFrom, config.maxTimingSamples),
    env.DB.prepare(
      "SELECT COALESCE(MAX(c), 0) AS n FROM (SELECT COUNT(DISTINCT p.wallet) AS c FROM players p " +
        "JOIN account_signals s ON s.wallet = p.wallet WHERE s.device_hash = ?1 AND s.ts >= ?2 " +
        "AND p.active_mint IS NOT NULL GROUP BY p.active_mint)",
    ).bind(device, clusterFrom),
    env.DB.prepare(
      "SELECT COUNT(DISTINCT s.wallet) AS n FROM account_signals s JOIN account_risk r ON r.wallet = s.wallet " +
        "WHERE s.device_hash = ?1 AND s.ts >= ?2 AND (r.level = 'HIGH' OR r.reward_state IN ('HELD', 'BLOCKED'))",
    ).bind(device, clusterFrom),
    env.DB.prepare(
      "SELECT COUNT(*) AS n FROM discovery_events WHERE wallet = ?1 AND" + REALIZED_DISCOVERY_PREDICATE,
    ).bind(wallet),
  ]);
  const count = (index: number): number => asNumber(results[index]?.results?.[0]?.n);
  const timestamps = (results[6]?.results ?? [])
    .map((row) => row.ts)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return {
    walletsOnDevice: count(0),
    walletsOnNetwork: count(1),
    accountsCreatedInWindow: count(2),
    peakActionsPerMinute: count(3),
    claimsInWindow: count(4),
    actionsInBurstWindow: count(5),
    activationTimestamps: timestamps,
    activationIntervalsSeconds: activationIntervals(timestamps),
    clusterWalletsOnSameMine: count(7),
    clusterHardFlaggedWallets: count(8),
    claimedDiscoveries: count(9),
  };
}

/**
 * Device and network cluster sizes for one wallet (spec 61). These are the same two counters the
 * risk score reads, so mining weight and risk can never disagree about how big a cluster is. A
 * missing device or network key reports zero, which means “no cluster”: an absent header can
 * never damp a real player (spec 50, 63).
 */
export async function miningClusterCounts(
  env: RuntimeEnv,
  wallet: string,
  now: number,
  config: RiskOpsConfig = RISK_OPS,
): Promise<{ walletsOnDevice: number; walletsOnNetwork: number }> {
  const fingerprint = await latestFingerprint(env, wallet);
  const clusterFrom = now - config.clusterWindowSeconds;
  const device = fingerprint.deviceHash;
  const network = fingerprint.networkHash;
  const [onDevice, onNetwork] = await Promise.all([
    device ? countClusterWallets(env, "device_hash", device, clusterFrom) : Promise.resolve(0),
    network ? countClusterWallets(env, "network_hash", network, clusterFrom) : Promise.resolve(0),
  ]);
  return { walletsOnDevice: onDevice, walletsOnNetwork: onNetwork };
}

async function countClusterWallets(
  env: RuntimeEnv,
  column: "device_hash" | "network_hash",
  value: string,
  from: number,
): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(DISTINCT wallet) AS n FROM account_signals WHERE ${column} = ?1 AND ts >= ?2`,
  )
    .bind(value, from)
    .first<{ n: number | null }>();
  return asNumber(row?.n);
}

export interface RefreshRiskOptions {
  now?: number;
  fingerprint?: RequestFingerprint;
  source?: AccountRiskFlags["source"];
  config?: RiskOpsConfig;
}

/**
 * Recomputes and persists one account's risk score, level, reward state and Mine Trust. The
 * persisted reward_state is mirrored onto players.risk_state, which is what the gameplay
 * modules read, and an admin restriction always wins over the computed state.
 */
export async function refreshAccountRisk(
  env: RuntimeEnv,
  wallet: string,
  options: RefreshRiskOptions = {},
): Promise<AccountRiskRecord> {
  const now = options.now ?? Math.floor(Date.now() / 1_000);
  const config = options.config ?? RISK_OPS;
  const [player, restrictions, fingerprint] = await Promise.all([
    env.DB.prepare("SELECT * FROM players WHERE wallet = ?1").bind(wallet).first<PlayerRow>(),
    activeRestrictions(env, wallet, now),
    options.fingerprint ? Promise.resolve(options.fingerprint) : latestFingerprint(env, wallet),
  ]);
  const counts = await readSignalCounts(env, wallet, fingerprint, now, config);
  const signals = buildRiskSignals(counts);
  const assessment = assessRisk(signals);
  const accountAgeSeconds = player ? Math.max(0, now - player.created_at) : 0;
  const ageDays = accountAgeSeconds / DIGGO_CONFIG.time.secondsPerDay;
  const trust = mineTrust({
    accountAgeSeconds,
    validActivations: player?.active_days ?? 0,
    streakConsistency: ageDays > 0 ? Math.min(1, (player?.active_days ?? 0) / ageDays) : 0,
    validClaims: counts.claimedDiscoveries,
    abuseFlags: counts.clusterHardFlaggedWallets + restrictions.length,
  });
  // The score's verdict is always computed and recorded; whether it is *applied* is a separate
  // decision (spec 63). In shadow mode the enforced state stays NORMAL, so no gameplay module
  // that reads players.risk_state can quietly enforce a decision the operator has not reviewed.
  const enforced = enforcedRewardState(assessment.rewardState, config);
  const rewardState = worstState(enforced.state, restrictionRewardState(restrictions, now));
  const flags: AccountRiskFlags = {
    signals,
    strong: assessment.strongSignals,
    weak: assessment.weakSignals,
    response: assessment.response,
    source: options.source ?? "request",
    shadowed: enforced.shadowed,
  };
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO account_risk (wallet, score, level, reward_state, computed_state, trust, flags, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT(wallet) DO UPDATE SET score = excluded.score, " +
        "level = excluded.level, reward_state = excluded.reward_state, " +
        "computed_state = excluded.computed_state, trust = excluded.trust, " +
        "flags = excluded.flags, updated_at = excluded.updated_at",
    ).bind(
      wallet,
      assessment.score,
      assessment.level,
      rewardState,
      assessment.rewardState,
      trust,
      JSON.stringify(flags),
      now,
    ),
    env.DB.prepare("UPDATE players SET risk_state = ?1, risk_score = ?2 WHERE wallet = ?3").bind(
      rewardState,
      assessment.score,
      wallet,
    ),
  ]);
  await metric(env, METRIC.riskRefresh, 1, {
    level: assessment.level,
    enforcement: config.enforcement.mode,
  });
  return {
    wallet,
    score: assessment.score,
    level: assessment.level,
    rewardState,
    computedState: assessment.rewardState,
    trust,
    flags,
    updatedAt: now,
  };
}

/**
 * Cached read of an account's risk. Recomputes when the record is missing or older than the
 * configured freshness window. Lookup failures fail open to NORMAL, because a telemetry
 * outage must not lock every real player out of the game.
 */
export async function loadOrRefreshRisk(
  env: RuntimeEnv,
  wallet: string,
  options: RefreshRiskOptions = {},
): Promise<AccountRiskRecord> {
  const now = options.now ?? Math.floor(Date.now() / 1_000);
  const config = options.config ?? RISK_OPS;
  try {
    const existing = await getAccountRisk(env, wallet);
    if (existing && now - existing.updatedAt <= config.refreshIntervalSeconds) return existing;
    return await refreshAccountRisk(env, wallet, { ...options, now, config });
  } catch (error) {
    console.error(JSON.stringify({ event: "risk.refresh_failed", wallet, error: String(error) }));
    return (
      (await getAccountRisk(env, wallet).catch(() => null)) ?? {
        wallet,
        score: 0,
        level: "LOW",
        rewardState: "NORMAL",
        computedState: "NORMAL",
        trust: 0,
        flags: { signals: {}, strong: [], weak: [], response: "observe", source: "request", shadowed: false },
        updatedAt: now,
      }
    );
  }
}

// --- restrictions ------------------------------------------------------------------------

function restrictionRewardState(
  restrictions: readonly RestrictionRow[],
  now = Math.floor(Date.now() / 1_000),
): RewardState {
  let state: RewardState = "NORMAL";
  for (const restriction of restrictions) {
    if (restriction.expires_at !== null && restriction.expires_at <= now) continue;
    if (restriction.kind === "ACCOUNT_BLOCK") state = worstState(state, "BLOCKED");
    else if (restriction.kind === "CLAIM_HOLD" || restriction.kind === "DISCOVERY_BLOCK")
      state = worstState(state, "HELD");
    else if (restriction.kind === "CHALLENGE_REQUIRED") state = worstState(state, "UNDER_REVIEW");
  }
  return state;
}

interface RestrictionVerdict {
  result: GateResult;
  outcome: ActivityOutcome;
}

function restrictionVerdict(
  restrictions: readonly RestrictionRow[],
  action: GatedAction,
  config: RiskOpsConfig,
  now: number,
  challengeCleared: boolean,
): RestrictionVerdict | null {
  const isClaim = action === "claim_reward" || action === "claim_discovery";
  const isDiscovery = action === "discovery_roll" || action === "claim_discovery";
  const sensitive = config.challenge.gatedActions.includes(action);
  for (const restriction of restrictions) {
    if (restriction.expires_at !== null && restriction.expires_at <= now) continue;
    if (restriction.kind === "ACCOUNT_BLOCK") {
      return {
        outcome: "rejected",
        result: { allowed: false, challengeRequired: false, rewardState: "BLOCKED", publicMessage: statusMessage("BLOCKED") },
      };
    }
    if (restriction.kind === "CLAIM_HOLD" && isClaim) {
      return {
        outcome: "rejected",
        result: { allowed: false, challengeRequired: false, rewardState: "HELD", publicMessage: statusMessage("HELD") },
      };
    }
    if (restriction.kind === "DISCOVERY_BLOCK" && isDiscovery) {
      return {
        outcome: "rejected",
        result: { allowed: false, challengeRequired: false, rewardState: "HELD", publicMessage: statusMessage("HELD") },
      };
    }
    if (restriction.kind === "CHALLENGE_REQUIRED" && sensitive && !challengeCleared) {
      return {
        outcome: "rejected",
        result: {
          allowed: false,
          challengeRequired: true,
          rewardState: "UNDER_REVIEW",
          publicMessage: config.challenge.publicMessage,
        },
      };
    }
    if (restriction.kind === "RATE_LIMIT") {
      const retryAfterSec = restriction.expires_at !== null ? Math.max(1, restriction.expires_at - now) : 60;
      return {
        outcome: "rate_limited",
        result: {
          allowed: false,
          challengeRequired: false,
          rewardState: "NORMAL",
          publicMessage: "Too many requests. Please slow down.",
          retryAfterSec,
        },
      };
    }
  }
  return null;
}

// --- what the v4 breakers became ---------------------------------------------------------
//
// v4 could halt discoveries, claims or one mine's Discovery Reserve from here. v2 cannot, and
// that is the point: there is no operator key with a hold over a player's money, so there is
// nothing left to halt. What replaces it is an advisory alert on the same conditions, which
// informs support and can rate limit an HTTP surface, and which no instruction reads.

/**
 * The account's last computed reward state, from a single cached read. Used for the cheap
 * refusal paths, which must not pay for a full risk recomputation just to phrase a message.
 */
async function cachedRewardState(env: RuntimeEnv, wallet: string): Promise<RewardState> {
  return (await getAccountRisk(env, wallet).catch(() => null))?.rewardState ?? "NORMAL";
}

/**
 * Both states that matter for a wallet, from two reads and no signal aggregation: the state
 * actually in force (the persisted risk state combined with whatever operator restrictions are
 * live right now) and the state the score computed for it. The cheap way for a front-door decision
 * (an appeal, a status view) to ask what an account is under without paying for a recomputation.
 *
 * They differ exactly while a score-derived decision is shadowed. A caller that needs to know
 * whether the player is actually experiencing friction wants the enforced state; a caller asking
 * whether the score has something to say about the account wants both.
 */
export interface WalletRiskStates {
  enforced: RewardState;
  computed: RewardState;
}

export async function walletRiskStates(
  env: RuntimeEnv,
  wallet: string,
  now = Math.floor(Date.now() / 1_000),
): Promise<WalletRiskStates> {
  const [risk, restrictions] = await Promise.all([
    getAccountRisk(env, wallet).catch(() => null),
    activeRestrictions(env, wallet, now),
  ]);
  const enforced = worstState(risk?.rewardState ?? "NORMAL", restrictionRewardState(restrictions, now));
  return { enforced, computed: risk?.computedState ?? enforced };
}

// --- challenge state ---------------------------------------------------------------------

export function challengeClearKey(wallet: string, action: GatedAction): string {
  return "risk:challenge:" + wallet + ":" + action;
}

/** True while a wallet sits inside the short window a cleared challenge buys it. */
export async function challengeCleared(env: RuntimeEnv, wallet: string, action: GatedAction): Promise<boolean> {
  return (await env.TOKEN_CACHE.get(challengeClearKey(wallet, action))) === "1";
}

export async function clearChallenge(
  env: RuntimeEnv,
  wallet: string,
  action: GatedAction,
  config: RiskOpsConfig = RISK_OPS,
): Promise<void> {
  await env.TOKEN_CACHE.put(challengeClearKey(wallet, action), "1", {
    expirationTtl: config.challenge.clearedSeconds,
  });
}

// --- rate limits -------------------------------------------------------------------------

function rateKeyFor(dimension: string, wallet: string, fingerprint: RequestFingerprint): string | null {
  if (dimension === "wallet") return wallet;
  if (dimension === "session") return fingerprint.sessionId;
  if (dimension === "ip") return fingerprint.ipHash;
  if (dimension === "device") return fingerprint.deviceHash;
  if (dimension === "network") return fingerprint.networkHash;
  return null;
}

function rateChecksFor(
  action: GatedAction,
  wallet: string,
  fingerprint: RequestFingerprint,
  config: RiskOpsConfig,
): RateLimitCheck[] {
  const limits = config.rateLimits[action];
  return rateLimitDimensions(limits).map(({ dimension, limit }) => ({
    dimension,
    key: rateKeyFor(dimension, wallet, fingerprint),
    limit,
    windowSeconds: limits.windowSeconds,
  }));
}

async function recordOutcome(env: RuntimeEnv, outcome: ActivityOutcome): Promise<void> {
  if (outcome === "replay") await metric(env, METRIC.replayAttempt);
  else if (outcome === "failed_challenge") await metric(env, METRIC.failedChallenge);
  else if (outcome === "rate_limited") await metric(env, METRIC.rateLimitHit);
}

/**
 * Appends what happened to one gated action. Callers report the outcome they observed; the
 * gate itself already records every request it refused, so a caller only has to report "ok"
 * (or a replay/failed-challenge it detected downstream). Never throws.
 */
export async function recordActivity(
  env: RuntimeEnv,
  ctx: { wallet: string; request: Request; action: GatedAction; outcome: ActivityOutcome },
): Promise<void> {
  const fingerprint = await fingerprintRequest(env, ctx.request);
  await recordActivityRow(env, {
    wallet: ctx.wallet,
    action: ctx.action,
    outcome: ctx.outcome,
    fingerprint,
  });
  await recordOutcome(env, ctx.outcome);
}

// --- the gate ----------------------------------------------------------------------------

/**
 * Multi-key rate limiting, restriction and breaker checks, then progressive friction derived
 * from the refreshed Account Risk Score. The result is the only thing callers need to respect:
 * if allowed is false, the action must not happen.
 */
export async function gateAction(
  env: RuntimeEnv,
  ctx: { wallet: string; request: Request; action: GatedAction },
  options: GateOptions = {},
): Promise<GateResult> {
  const config = options.config ?? RISK_OPS;
  const now = options.now ?? Math.floor(Date.now() / 1_000);
  const fingerprint = await fingerprintRequest(env, ctx.request);
  // The mint is still read because the activity log records which coin an action named; it is no
  // longer a breaker key, since v2 has no breaker to key.
  const mint = new URL(ctx.request.url).searchParams.get("mint");
  void mint;
  const sensitive = config.challenge.gatedActions.includes(ctx.action);

  // Explicit, cheap checks first, so a flood is refused without paying for the full signal
  // aggregation: operator restrictions, then circuit breakers, then the multi-key rate limits.
  // Everything after them is expressed relative to the account's current reward state.
  const restrictions = await activeRestrictions(env, ctx.wallet, now);
  const needsChallenge = restrictions.some(
    (restriction) =>
      restriction.kind === "CHALLENGE_REQUIRED" && (restriction.expires_at === null || restriction.expires_at > now),
  );
  const restricted = restrictionVerdict(
    restrictions,
    ctx.action,
    config,
    now,
    needsChallenge ? await challengeCleared(env, ctx.wallet, ctx.action) : false,
  );
  if (restricted) {
    const result: GateResult = {
      ...restricted.result,
      rewardState: worstState(await cachedRewardState(env, ctx.wallet), restricted.result.rewardState),
    };
    await recordActivityRow(env, {
      wallet: ctx.wallet,
      action: ctx.action,
      outcome: restricted.outcome,
      fingerprint,
      ts: now,
    });
    await recordOutcome(env, restricted.outcome);
    return result;
  }

  const verdict = await checkKeyedRateLimits(env, rateChecksFor(ctx.action, ctx.wallet, fingerprint, config));
  if (!verdict.allowed) {
    await recordActivityRow(env, {
      wallet: ctx.wallet,
      action: ctx.action,
      outcome: "rate_limited",
      fingerprint,
      ts: now,
    });
    await recordOutcome(env, "rate_limited");
    return {
      allowed: false,
      challengeRequired: false,
      rewardState: await cachedRewardState(env, ctx.wallet),
      publicMessage: "Too many requests. Please slow down.",
      retryAfterSec: verdict.retryAfterSec,
    };
  }

  // Only a request that got this far is worth a risk recomputation.
  const risk = await loadOrRefreshRisk(env, ctx.wallet, { now, fingerprint, config, source: "request" });

  // Everything below this line is the *score's* opinion, read from the computed state rather than
  // the enforced one, so a per-action override can enforce an action the global mode shadows (and
  // the other way round). The operator's own restrictions were already settled above and always
  // keep their full weight.
  //
  // Reward holds are the exception: they are applied whatever the enforcement mode says (spec 53,
  // 63). A hold destroys nothing - mining accounting keeps running and the tokens stay in the
  // mine's Mining Reserve until the hold is lifted - so it is safe to apply on a score alone, and
  // it is what stops an account the score is unsure about from draining real tokens before an
  // operator has looked at it (spec 64). Friction, challenges, discovery parameters and bans below
  // stay governed by the mode.
  const held = claimHoldState(risk.computedState, ctx.action, config);
  if (held !== null) {
    await recordActivityRow(env, {
      wallet: ctx.wallet,
      action: ctx.action,
      outcome: "rejected",
      fingerprint,
      ts: now,
    });
    await metric(env, "risk.claim_held", 1, { action: ctx.action, state: held });
    return {
      allowed: false,
      challengeRequired: false,
      rewardState: worstState(risk.rewardState, held),
      publicMessage: statusMessage(held),
    };
  }
  const refusal = scoreRefusal(risk.computedState);
  let wouldRefuse = refusal === "block";
  let wouldChallenge = false;
  if (refusal === "hold") {
    // A hold stops claims and discoveries but never mining accounting (spec 53).
    wouldRefuse = sensitive && !config.challenge.heldActions.includes(ctx.action);
  } else if (refusal === "challenge") {
    wouldChallenge = sensitive && !(await challengeCleared(env, ctx.wallet, ctx.action));
    wouldRefuse = wouldChallenge;
  }

  if (!wouldRefuse) {
    return { allowed: true, challengeRequired: false, rewardState: risk.rewardState };
  }

  const decision = enforcementDecision(SCORE_REFUSAL_KINDS[refusal as Exclude<ScoreRefusal, "none">], ctx.action, config);
  const effectiveState = worstState(risk.rewardState, risk.computedState);
  if (!decision.enforced) {
    // Shadow mode (spec 63): the decision is recorded and nothing else happens. The action is let
    // through, and the state reported to the caller stays the enforced one, so no downstream
    // module can act on a decision the operator has not adopted yet.
    await recordActivityRow(env, {
      wallet: ctx.wallet,
      action: ctx.action,
      outcome: "shadow_would_block",
      fingerprint,
      ts: now,
    });
    await metric(env, METRIC.shadowWouldBlock, 1, { action: ctx.action, kind: decision.kind });
    return {
      allowed: true,
      challengeRequired: false,
      rewardState: risk.rewardState,
      shadowState: risk.computedState,
    };
  }

  await recordActivityRow(env, { wallet: ctx.wallet, action: ctx.action, outcome: "rejected", fingerprint, ts: now });
  if (wouldChallenge) {
    return {
      allowed: false,
      challengeRequired: true,
      rewardState: effectiveState,
      publicMessage: config.challenge.publicMessage,
    };
  }
  const state: RewardState = refusal === "block" ? "BLOCKED" : "HELD";
  return { allowed: false, challengeRequired: false, rewardState: effectiveState, publicMessage: statusMessage(state) };
}

// --- progressive friction endpoint -------------------------------------------------------

async function finishChallenge(
  env: RuntimeEnv,
  wallet: string,
  action: GatedAction,
  strategy: "turnstile" | "signature",
  fingerprint: RequestFingerprint,
): Promise<Response> {
  await clearChallenge(env, wallet, action);
  await recordActivityRow(env, { wallet, action, outcome: "ok", fingerprint });
  await metric(env, METRIC.challengeCleared, 1, { action });
  const risk = await getAccountRisk(env, wallet);
  return json(
    {
      cleared: true,
      strategy,
      expiresIn: RISK_OPS.challenge.clearedSeconds,
      rewardState: risk?.rewardState ?? "NORMAL",
      publicMessage: "Verification complete.",
    },
    { headers: { "cache-control": "no-store" } },
  );
}

interface ChallengeRequestBody {
  wallet?: string;
  action?: string;
  resource?: string;
  turnstileToken?: string;
  nonce?: string;
  signature?: string;
}

/**
 * POST /api/verify/challenge - progressive friction for an account the risk score put in
 * UNDER_REVIEW. Uses Turnstile when it is configured, and otherwise falls back to a signed
 * re-verification bound to wallet + action + resource. Either way a successful challenge clears
 * friction for a short window only.
 */
export async function verifyChallenge(request: Request, env: RuntimeEnv): Promise<Response> {
  const config = RISK_OPS;
  let body: ChallengeRequestBody;
  try {
    body = await readJson<ChallengeRequestBody>(request, 8_192);
  } catch {
    return apiError("Invalid verification request");
  }
  const session = await sessionWallet(request, env);
  const wallet = session ?? (isBase58Address(body.wallet) ? body.wallet : null);
  if (!wallet) return apiError("Wallet authentication required", 401);
  if (session && body.wallet && body.wallet !== session) return apiError("Wallet mismatch", 401);
  const action: GatedAction = isGatedAction(body.action) ? body.action : "activate";
  const resource = typeof body.resource === "string" && body.resource.length > 0 ? body.resource : null;
  const fingerprint = await fingerprintRequest(env, request);
  const strategy: "turnstile" | "signature" = env.TURNSTILE_SECRET ? "turnstile" : "signature";

  if (strategy === "turnstile") {
    const token = body.turnstileToken ?? "";
    if (!token) {
      return json(
        { cleared: false, strategy, challengeRequired: true, publicMessage: config.challenge.publicMessage },
        { status: 202 },
      );
    }
    if (!(await verifyTurnstile(token, request, env))) {
      await recordActivityRow(env, { wallet, action, outcome: "failed_challenge", fingerprint });
      await metric(env, METRIC.failedChallenge, 1, { action });
      return json({ cleared: false, strategy, publicMessage: config.challenge.publicMessage }, { status: 403 });
    }
    return finishChallenge(env, wallet, action, strategy, fingerprint);
  }

  if (!body.nonce || !body.signature) {
    const challenge = await issueChallenge(env, {
      wallet,
      action,
      resource,
      title: "Verify Diggo.fun account",
    });
    return json(
      {
        cleared: false,
        strategy,
        challengeRequired: true,
        nonce: challenge.nonce,
        message: challenge.message,
        expiresIn: config.challenge.ttlSeconds,
        publicMessage: config.challenge.publicMessage,
      },
      { status: 202 },
    );
  }

  const challenge = await loadChallenge(env, challengeKey(action, body.nonce));
  if (!challenge || challenge.wallet !== wallet || (challenge.action ?? action) !== action) {
    // A nonce whose KV record is gone was either never issued, expired, or already spent. The
    // nonce table can tell the difference, and a spent nonce is a replay worth recording.
    const status = await consumeChallengeNonce(env, { nonce: body.nonce, wallet, action });
    if (status === "replay") {
      await recordActivityRow(env, { wallet, action, outcome: "replay", fingerprint });
      await metric(env, METRIC.replayAttempt, 1, { action });
      return apiError("Challenge already used", 409);
    }
    return apiError("Challenge expired", 401);
  }
  if (!verifyWalletSignature(wallet, challenge.message, body.signature)) {
    await recordActivityRow(env, { wallet, action, outcome: "failed_challenge", fingerprint });
    await metric(env, METRIC.failedChallenge, 1, { action });
    return apiError("Invalid wallet signature", 401);
  }
  const consumed: ChallengeConsumeResult = await consumeChallengeNonce(env, { nonce: body.nonce, wallet, action });
  if (consumed !== "ok") {
    await recordActivityRow(env, { wallet, action, outcome: "replay", fingerprint });
    await metric(env, METRIC.replayAttempt, 1, { action });
    return apiError(consumed === "replay" ? "Challenge already used" : "Challenge expired", consumed === "replay" ? 409 : 401);
  }
  return finishChallenge(env, wallet, action, strategy, fingerprint);
}

/** Neutral public risk view for a wallet; no score, weights or reasons (spec 62). */
export async function publicRiskStatus(env: RuntimeEnv, wallet: string): Promise<PublicRiskView> {
  const risk = await getAccountRisk(env, wallet);
  return publicRiskView(risk?.rewardState ?? "NORMAL");
}

// --- scheduled risk maintenance ----------------------------------------------------------

export interface RiskCronReport {
  refreshed: number;
  alerts: number;
  /** True when an anomalous drain was recorded as an advisory alert. Nothing was halted. */
  advisoryRaised: boolean;
  snapshot: AlertMetricSnapshot;
}

/**
 * Scheduled hook (see worker/index.ts): collects the metrics, logs alerts, refreshes the risk of
 * recently active accounts that have no fresh score, and records an advisory alert when a
 * coin's Discovery Reserve drain looks anomalous.
 *
 * In v4 the last part opened a circuit breaker that halted payouts. v2 has no such switch, so
 * the same detection now writes an alert row and stops there. A player's claim is decided by
 * their own signed instruction and a public crank, not by this cron.
 */
export async function riskCron(env: RuntimeEnv, now = Math.floor(Date.now() / 1_000)): Promise<RiskCronReport> {
  const config = RISK_OPS;
  const report = await collectMetrics(env, now, config);
  await logAlerts(env, report.alerts);

  const stale = await env.DB.prepare(
    "SELECT DISTINCT s.wallet AS wallet FROM account_signals s LEFT JOIN account_risk r ON r.wallet = s.wallet " +
      "WHERE s.ts >= ?1 AND (r.updated_at IS NULL OR r.updated_at <= ?2) ORDER BY s.ts DESC LIMIT ?3",
  )
    .bind(now - config.clusterWindowSeconds, now - config.refreshIntervalSeconds, config.cronRefreshLimit)
    .all<{ wallet: string }>();

  let refreshed = 0;
  for (const row of stale.results) {
    try {
      await refreshAccountRisk(env, row.wallet, { now, source: "cron", config });
      refreshed += 1;
    } catch (error) {
      console.error(JSON.stringify({ event: "risk.cron_refresh_failed", wallet: row.wallet, error: String(error) }));
    }
  }

  const thresholds = config.breakers;
  const anomaly =
    report.snapshot.reserveDrainVelocityUsdPerHour >= thresholds.reserveDrainVelocityUsdPerHour &&
    report.reserveDrainedInWindowUsd >= thresholds.reserveDrainMinUsd &&
    report.discoveriesInWindow >= thresholds.minimumSampleDiscoveries;
  let advisoryRaised = false;
  if (anomaly) {
    const { recordAdvisory } = await import("./indexStore");
    await recordAdvisory(env, {
      kind: "reserve_drain_anomaly",
      severity: "WARN",
      detail:
        `discovery reserve drained ${report.reserveDrainedInWindowLamports} lamports over ` +
        `${report.discoveriesInWindow} settled discoveries` +
        (report.usdPriceAvailable ? ` (~${report.reserveDrainedInWindowUsd} usd)` : " (no sol/usd rate)") +
        "; nothing was halted",
    });
    advisoryRaised = true;
  }

  return { refreshed, alerts: report.alerts.length, advisoryRaised, snapshot: report.snapshot };
}
