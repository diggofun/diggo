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
import { assessRisk, mineTrust, publicRiskView, type RiskSignals } from "../shared/risk";
import {
  type AlertMetricSnapshot,
  type ClusterCounts,
  RISK_OPS,
  type RiskOpsConfig,
  activationIntervals,
  buildRiskSignals,
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
import { autoCloseBreaker, autoOpenBreaker, isBreakerOpen, type BreakerScope } from "./breakers";
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
import { METRIC, collectMetrics, logAlerts, metric } from "./telemetry";

/** The actions the gate understands. Exactly these, and nothing else. */
export type GatedAction =
  | "activate"
  | "claim_reward"
  | "claim_discovery"
  | "discovery_roll"
  | "switch_mine"
  | "crew_upgrade"
  | "auth"
  | "bootstrap";

export const GATED_ACTIONS: readonly GatedAction[] = [
  "activate",
  "claim_reward",
  "claim_discovery",
  "discovery_roll",
  "switch_mine",
  "crew_upgrade",
  "auth",
  "bootstrap",
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
}

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
}

export interface AccountRiskRecord {
  wallet: string;
  score: number;
  level: RiskLevel;
  rewardState: RewardState;
  trust: number;
  flags: AccountRiskFlags;
  updatedAt: number;
}

interface AccountRiskRow {
  wallet: string;
  score: number;
  level: RiskLevel;
  reward_state: RewardState;
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
    };
  } catch {
    return { signals: {}, strong: [], weak: [], response: "observe", source: "request" };
  }
}

export async function getAccountRisk(env: RuntimeEnv, wallet: string): Promise<AccountRiskRecord | null> {
  const row = await env.DB.prepare(
    "SELECT wallet, score, level, reward_state, trust, flags, updated_at FROM account_risk WHERE wallet = ?1",
  )
    .bind(wallet)
    .first<AccountRiskRow>();
  if (!row) return null;
  return {
    wallet: row.wallet,
    score: row.score,
    level: row.level,
    rewardState: row.reward_state,
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
    env.DB.prepare("SELECT COUNT(*) AS n FROM discoveries WHERE wallet = ?1 AND status = 'CLAIMED'").bind(wallet),
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
  const rewardState = worstState(assessment.rewardState, restrictionRewardState(restrictions, now));
  const flags: AccountRiskFlags = {
    signals,
    strong: assessment.strongSignals,
    weak: assessment.weakSignals,
    response: assessment.response,
    source: options.source ?? "request",
  };
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO account_risk (wallet, score, level, reward_state, trust, flags, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT(wallet) DO UPDATE SET score = excluded.score, " +
        "level = excluded.level, reward_state = excluded.reward_state, trust = excluded.trust, " +
        "flags = excluded.flags, updated_at = excluded.updated_at",
    ).bind(wallet, assessment.score, assessment.level, rewardState, trust, JSON.stringify(flags), now),
    env.DB.prepare("UPDATE players SET risk_state = ?1, risk_score = ?2 WHERE wallet = ?3").bind(
      rewardState,
      assessment.score,
      wallet,
    ),
  ]);
  await metric(env, METRIC.riskRefresh, 1, { level: assessment.level });
  return {
    wallet,
    score: assessment.score,
    level: assessment.level,
    rewardState,
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
        trust: 0,
        flags: { signals: {}, strong: [], weak: [], response: "observe", source: "request" },
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

// --- breakers ----------------------------------------------------------------------------

function breakerScopesFor(action: GatedAction, mint: string | null): { scope: BreakerScope; mint?: string }[] {
  if (action === "discovery_roll") return [{ scope: "discoveries" }];
  if (action === "claim_discovery") return [{ scope: "discovery_reserve", mint: mint ?? undefined }];
  if (action === "claim_reward") return [{ scope: "claims" }];
  return [];
}

const BREAKER_MESSAGE = "Rewards are temporarily paused. Please try again later.";

/**
 * The account's last computed reward state, from a single cached read. Used for the cheap
 * refusal paths, which must not pay for a full risk recomputation just to phrase a message.
 */
async function cachedRewardState(env: RuntimeEnv, wallet: string): Promise<RewardState> {
  return (await getAccountRisk(env, wallet).catch(() => null))?.rewardState ?? "NORMAL";
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
): Promise<GateResult> {
  const config = RISK_OPS;
  const now = Math.floor(Date.now() / 1_000);
  const fingerprint = await fingerprintRequest(env, ctx.request);
  const mint = new URL(ctx.request.url).searchParams.get("mint");
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

  for (const candidate of breakerScopesFor(ctx.action, mint)) {
    if (await isBreakerOpen(env, candidate.scope, candidate.mint)) {
      await recordActivityRow(env, {
        wallet: ctx.wallet,
        action: ctx.action,
        outcome: "rejected",
        fingerprint,
        ts: now,
      });
      return {
        allowed: false,
        challengeRequired: false,
        rewardState: await cachedRewardState(env, ctx.wallet),
        publicMessage: BREAKER_MESSAGE,
        retryAfterSec: 60,
      };
    }
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
  const rewardState = risk.rewardState;

  if (rewardState === "BLOCKED") {
    await recordActivityRow(env, { wallet: ctx.wallet, action: ctx.action, outcome: "rejected", fingerprint, ts: now });
    return { allowed: false, challengeRequired: false, rewardState, publicMessage: statusMessage("BLOCKED") };
  }

  if (rewardState === "HELD" && sensitive && !config.challenge.heldActions.includes(ctx.action)) {
    await recordActivityRow(env, { wallet: ctx.wallet, action: ctx.action, outcome: "rejected", fingerprint, ts: now });
    return { allowed: false, challengeRequired: false, rewardState, publicMessage: statusMessage("HELD") };
  }

  if (rewardState === "UNDER_REVIEW" && sensitive && !(await challengeCleared(env, ctx.wallet, ctx.action))) {
    await recordActivityRow(env, { wallet: ctx.wallet, action: ctx.action, outcome: "rejected", fingerprint, ts: now });
    return {
      allowed: false,
      challengeRequired: true,
      rewardState,
      publicMessage: config.challenge.publicMessage,
    };
  }

  return { allowed: true, challengeRequired: false, rewardState };
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
  breakerOpened: boolean;
  breakerClosed: boolean;
  snapshot: AlertMetricSnapshot;
}

/**
 * True when an admin closed this scope's breaker by hand inside the hold window. The cron must
 * not immediately re-open a decision a human just made (spec 65: emergency controls are
 * bounded and auditable, which includes not fighting the operator).
 */
async function breakerClosedByAdminRecently(
  env: RuntimeEnv,
  scope: BreakerScope,
  now: number,
  minutes: number,
): Promise<boolean> {
  if (minutes <= 0) return false;
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'breaker.close' AND target = ?1 AND created_at >= ?2",
  )
    .bind(scope, now - minutes * 60)
    .first<{ n: number }>();
  return (row?.n ?? 0) > 0;
}

/**
 * Scheduled hook (see worker/index.ts): collects the spec-66 metrics, logs alerts, refreshes
 * the risk of recently active accounts that have no fresh score, and auto-opens the discovery
 * breaker when Discovery Reserve drain looks anomalous.
 *
 * Auto-open is the only automatic emergency action, and it is deliberately conservative: it
 * needs a real sample of discoveries, a drain velocity above the configured threshold and real
 * value already gone. Auto-close only ever touches a breaker the cron itself opened, so an
 * admin hold is never lifted by a cron.
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
  let breakerOpened = false;
  let breakerClosed = false;
  if (anomaly && !(await breakerClosedByAdminRecently(env, "discoveries", now, thresholds.manualHoldMinutes))) {
    breakerOpened = await autoOpenBreaker(env, "discoveries", "reserve_drain_anomaly");
  } else if (
    !anomaly &&
    report.snapshot.reserveDrainVelocityUsdPerHour <=
      thresholds.reserveDrainVelocityUsdPerHour * thresholds.autoCloseShare
  ) {
    breakerClosed = await autoCloseBreaker(env, "discoveries", "reserve_drain_normalized");
  }

  return { refreshed, alerts: report.alerts.length, breakerOpened, breakerClosed, snapshot: report.snapshot };
}
