/**
 * Admin anti-abuse surface (spec 65, 67).
 *
 * Authentication is a real signed wallet session (worker/auth.ts) whose wallet is listed in the
 * ADMIN_WALLETS secret - there is no separate admin password or long-lived token to leak.
 *
 * What this module can do: read a compact anti-abuse view of accounts, place or lift an account
 * restriction, open or close a circuit breaker on discoveries, claims or one mine's Discovery
 * Reserve, and read the anti-abuse metrics.
 *
 * What it deliberately cannot do, here or anywhere it reaches: move, seize, refund or withdraw
 * funds, sign a transaction, or touch the launch market. Restrictions and breakers only ever
 * stop work - they can never redirect value (spec 65). Every mutation is written to admin_audit
 * and every breaker change additionally to breaker_audit (worker/breakers.ts). The admin view
 * never returns raw IP, device or session identifiers (spec 67).
 */
import { crewTier, type CrewLevels } from "../shared/economics";
import {
  type AdminStepUpAction,
  RISK_OPS,
  canonicalJson,
  isAdminStepUpAction,
} from "../shared/riskOps";
import { sessionWallet, verifyWalletSignature } from "./auth";
import {
  BREAKER_SCOPES,
  type BreakerScope,
  breakerStates,
  setBreaker,
  type BreakerState,
} from "./breakers";
import type { RuntimeEnv } from "./env";
import { apiError, checkWalletRateLimit, isBase58Address, json, readJson, textEncoder } from "./http";
import {
  RESTRICTION_KINDS,
  type RestrictionKind,
  clearRestriction,
  setRestriction,
} from "./signals";
import { collectMetrics, readCounters } from "./telemetry";

const ABUSE_LIMIT_MAX = 100;
const ABUSE_LIMIT_DEFAULT = 25;

export function adminWallets(env: RuntimeEnv): string[] {
  return (env.ADMIN_WALLETS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export function isAdminWallet(env: RuntimeEnv, wallet: string): boolean {
  return adminWallets(env).includes(wallet);
}

/** Newline inside a signed message. */
const NEWLINE = "\n";

/** Admin wallet for this request, or null when it is not a listed signed-in wallet. */
export async function adminActor(env: RuntimeEnv, request: Request): Promise<string | null> {
  const wallet = await sessionWallet(request, env);
  if (!wallet) return null;
  return isAdminWallet(env, wallet) ? wallet : null;
}

export async function writeAudit(
  env: RuntimeEnv,
  actor: string,
  action: string,
  target: string | null,
  detail: unknown,
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO admin_audit (id, actor, action, target, detail, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  )
    .bind(crypto.randomUUID(), actor, action, target, JSON.stringify(detail ?? {}), Math.floor(Date.now() / 1_000))
    .run();
}

interface AuditRow {
  id: string;
  actor: string;
  action: string;
  target: string | null;
  detail: string | null;
  created_at: number;
}

export async function recentAudit(env: RuntimeEnv, limit = 25): Promise<AuditRow[]> {
  const result = await env.DB.prepare(
    "SELECT id, actor, action, target, detail, created_at FROM admin_audit ORDER BY created_at DESC LIMIT ?1",
  )
    .bind(limit)
    .all<AuditRow>();
  return result.results;
}


// --- admin step-up (spec 65, 67) ---------------------------------------------------------

/**
 * A mutation is only authorised when it carries a fresh signature over the action it performs
 * *and* the exact payload it performs it with. An admin session is therefore never sufficient on
 * its own: a leaked cookie, a request replayed out of a proxy log, or a signature issued for a
 * different payload all fail here, and no amount of session trust makes them pass.
 */
async function payloadHashOf(payload: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(canonicalJson(payload)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stepUpMessage(input: {
  wallet: string;
  action: AdminStepUpAction;
  payloadHash: string;
  nonce: string;
  expiresAt: number;
}): string {
  return [
    "Diggo.fun admin step-up",
    "Wallet: " + input.wallet,
    "Action: " + input.action,
    "Payload: " + input.payloadHash,
    "Nonce: " + input.nonce,
    "Expires: " + new Date(input.expiresAt * 1_000).toISOString(),
    "This request does not trigger a blockchain transaction.",
  ].join(NEWLINE);
}

/** The proof a client attaches to a mutating admin call. */
export interface AdminStepUpProof {
  nonce?: unknown;
  signature?: unknown;
}

interface AdminStepUpBody {
  action?: unknown;
  payload?: unknown;
}

interface StepUpRow {
  nonce: string;
  wallet: string;
  action: string;
  payload_hash: string;
  message: string;
  expires_at: number;
  consumed_at: number | null;
}

/**
 * POST /api/admin/stepup { action, payload }
 *
 * Issues the short-lived message an admin has to sign for one specific mutation. The payload is
 * bound by hash, so the signature covers what will actually be sent and cannot be moved onto a
 * different restriction, breaker or appeal decision.
 */
export async function adminStepUp(request: Request, env: RuntimeEnv): Promise<Response> {
  const actor = await adminActor(env, request);
  if (!actor) return apiError("Admin session required", 401);
  if (!(await checkWalletRateLimit(env, actor, "admin_stepup", 30, 60))) {
    return apiError("Too many confirmation requests", 429);
  }
  let body: AdminStepUpBody;
  try {
    body = await readJson<AdminStepUpBody>(request, RISK_OPS.adminStepUp.maxPayloadBytes + 1_024);
  } catch {
    return apiError("Invalid step-up request");
  }
  if (!isAdminStepUpAction(body.action)) return apiError("Unknown admin action");
  const config = RISK_OPS.adminStepUp;
  const payload = body.payload ?? {};
  const encoded = canonicalJson(payload);
  if (encoded.length > config.maxPayloadBytes) return apiError("Payload too large");
  const payloadHash = await payloadHashOf(payload);
  const now = Math.floor(Date.now() / 1_000);
  const expiresAt = now + config.ttlSeconds;
  const nonce = crypto.randomUUID();
  const message = stepUpMessage({ wallet: actor, action: body.action, payloadHash, nonce, expiresAt });
  await env.DB.prepare(
    "INSERT INTO admin_stepup_nonces (nonce, wallet, action, payload_hash, message, created_at, expires_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
  )
    .bind(nonce, actor, body.action, payloadHash, message, now, expiresAt)
    .run();
  // Housekeeping for this wallet only: an expired or already-spent confirmation is dead weight.
  await env.DB.prepare(
    "DELETE FROM admin_stepup_nonces WHERE wallet = ?1 AND (expires_at <= ?2 OR " +
      "(consumed_at IS NOT NULL AND consumed_at <= ?3))",
  )
    .bind(actor, now, now - 3_600)
    .run()
    .catch(() => undefined);
  return json(
    { nonce, action: body.action, payloadHash, message, expiresInSec: config.ttlSeconds },
    { headers: { "cache-control": "no-store" } },
  );
}

export type AdminStepUpVerdict = { ok: true; nonce: string } | { ok: false; response: Response };

/**
 * Verifies the proof attached to a mutating admin call. Single use is enforced by a conditional
 * UPDATE, so two concurrent replays of one signature cannot both succeed. Every rejection is
 * audited, which is what makes "who tried what" answerable after the fact.
 */
export async function requireAdminStepUp(
  env: RuntimeEnv,
  input: { actor: string; action: AdminStepUpAction; payload: unknown; proof: AdminStepUpProof | undefined },
): Promise<AdminStepUpVerdict> {
  const now = Math.floor(Date.now() / 1_000);
  const nonce = typeof input.proof?.nonce === "string" ? input.proof.nonce : "";
  const signature = typeof input.proof?.signature === "string" ? input.proof.signature : "";
  const reject = async (reason: string, message: string, status: number): Promise<AdminStepUpVerdict> => {
    await writeAudit(env, input.actor, "admin.stepup.rejected", input.action, { reason });
    return { ok: false, response: apiError(message, status) };
  };
  if (nonce.length === 0 || signature.length === 0) {
    return reject("missing", "A fresh signed confirmation is required", 401);
  }
  const row = await env.DB.prepare(
    "SELECT nonce, wallet, action, payload_hash, message, expires_at, consumed_at " +
      "FROM admin_stepup_nonces WHERE nonce = ?1",
  )
    .bind(nonce)
    .first<StepUpRow>();
  const payloadHash = await payloadHashOf(input.payload);
  if (!row || row.wallet !== input.actor || row.action !== input.action || row.payload_hash !== payloadHash) {
    // One neutral answer for "unknown nonce", "someone else's nonce" and "a nonce issued for a
    // different payload": all three mean this confirmation does not authorise this mutation.
    return reject("unbound", "That confirmation does not authorise this action", 403);
  }
  if (row.consumed_at !== null) return reject("replay", "That confirmation has already been used", 409);
  if (row.expires_at <= now) return reject("expired", "That confirmation has expired", 401);
  if (!verifyWalletSignature(input.actor, row.message, signature)) {
    return reject("bad_signature", "Invalid wallet signature", 401);
  }
  const consumed = await env.DB.prepare(
    "UPDATE admin_stepup_nonces SET consumed_at = ?1 WHERE nonce = ?2 AND consumed_at IS NULL AND expires_at > ?1",
  )
    .bind(now, nonce)
    .run();
  if (consumed.meta.changes <= 0) return reject("replay", "That confirmation has already been used", 409);
  return { ok: true, nonce };
}

function placeholders(count: number): string {
  return Array.from({ length: count }, (_, index) => "?" + (index + 1)).join(",");
}

function parseFlags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as { strong?: unknown; weak?: unknown };
    const strong = Array.isArray(parsed.strong) ? parsed.strong.filter((v): v is string => typeof v === "string") : [];
    const weak = Array.isArray(parsed.weak) ? parsed.weak.filter((v): v is string => typeof v === "string") : [];
    return strong.concat(weak).slice(0, 8);
  } catch {
    return [];
  }
}

interface AbuseRow {
  wallet: string;
  created_at: number;
  active_days: number;
  streak: number;
  risk_state: string;
  risk_reward_state: string;
  computed_state: string;
  risk_score: number;
  miners_level: number;
  drills_level: number;
  carts_level: number;
  foreman_level: number;
  storage_level: number;
  risk_level: string;
  trust: number;
  flags: string;
  discoveries_count: number;
  claimed_value_usd: number;
  related_accounts: number;
}

function crewLevelsOf(row: AbuseRow): CrewLevels {
  return {
    miners: row.miners_level,
    drills: row.drills_level,
    carts: row.carts_level,
    foreman: row.foreman_level,
    storage: row.storage_level,
  };
}

/**
 * GET /api/admin/abuse?wallet=&risk=&limit=
 *
 * Compact anti-abuse view (spec 67). Returns the hashed-signal summary only: no raw IP, no
 * device string, no session id, no score weights.
 */
export async function adminAbuse(request: Request, env: RuntimeEnv): Promise<Response> {
  const actor = await adminActor(env, request);
  if (!actor) return apiError("Admin session required", 401);
  const url = new URL(request.url);
  const wallet = url.searchParams.get("wallet");
  const risk = url.searchParams.get("risk");
  const limitParam = Number(url.searchParams.get("limit") ?? ABUSE_LIMIT_DEFAULT);
  const limit = Number.isFinite(limitParam)
    ? Math.min(ABUSE_LIMIT_MAX, Math.max(1, Math.floor(limitParam)))
    : ABUSE_LIMIT_DEFAULT;
  const now = Math.floor(Date.now() / 1_000);

  const bindings: unknown[] = [now - RISK_OPS.clusterWindowSeconds];
  let where = "";
  if (wallet && isBase58Address(wallet)) {
    bindings.push(wallet);
    where += " WHERE p.wallet = ?" + bindings.length;
  } else if (risk === "HIGH" || risk === "MEDIUM") {
    bindings.push(risk);
    where += " WHERE COALESCE(r.level, 'LOW') = ?" + bindings.length;
  }
  bindings.push(limit);
  const sql =
    "SELECT p.wallet, p.created_at, p.active_days, p.streak, p.risk_state, p.risk_score, " +
    "p.miners_level, p.drills_level, p.carts_level, p.foreman_level, p.storage_level, " +
    "COALESCE(r.level, 'LOW') AS risk_level, COALESCE(r.trust, 0) AS trust, COALESCE(r.flags, '{}') AS flags, " +
    "COALESCE(r.computed_state, r.reward_state, p.risk_state, 'NORMAL') AS computed_state, " +
    "COALESCE(r.reward_state, p.risk_state, 'NORMAL') AS risk_reward_state, " +
    "(SELECT COUNT(*) FROM discoveries d WHERE d.wallet = p.wallet) AS discoveries_count, " +
    "(SELECT COALESCE(SUM(d.value_usd), 0) FROM discoveries d WHERE d.wallet = p.wallet AND d.status = 'CLAIMED') " +
    "AS claimed_value_usd, " +
    "(SELECT COUNT(DISTINCT s2.wallet) FROM account_signals s1 JOIN account_signals s2 " +
    "ON s2.device_hash = s1.device_hash WHERE s1.wallet = p.wallet AND s1.device_hash IS NOT NULL " +
    "AND s2.ts >= ?1) AS related_accounts " +
    "FROM players p LEFT JOIN account_risk r ON r.wallet = p.wallet" +
    where +
    " ORDER BY p.risk_score DESC, p.created_at DESC LIMIT ?" +
    bindings.length;
  const rows = (await env.DB.prepare(sql).bind(...bindings).all<AbuseRow>()).results;
  const wallets = rows.map((row) => row.wallet);
  const restrictions = wallets.length
    ? (
        await env.DB.prepare(
          "SELECT wallet, kind, reason_code, created_at, expires_at, created_by FROM account_restrictions " +
            "WHERE wallet IN (" +
            placeholders(wallets.length) +
            ") AND (expires_at IS NULL OR expires_at > ?" +
            (wallets.length + 1) +
            ") ORDER BY created_at DESC",
        )
          .bind(...wallets, now)
          .all<{
            wallet: string;
            kind: RestrictionKind;
            reason_code: string;
            created_at: number;
            expires_at: number | null;
            created_by: string;
          }>()
      ).results
    : [];
  const accounts = rows.map((row) => ({
    wallet: row.wallet,
    riskLevel: row.risk_level,
    // The state in force comes from the risk record, which is what a refresh writes and what
    // gameplay reads; players.risk_state is only the fallback for an account with no record yet.
    rewardState: row.risk_reward_state,
    /**
     * What the score asked for, next to the state actually in force. They differ exactly while a
     * score-derived decision is being shadowed rather than enforced (spec 63).
     */
    computedState: row.computed_state,
    shadowed: row.computed_state !== row.risk_reward_state,
    accountAgeSeconds: Math.max(0, now - row.created_at),
    activeDays: row.active_days,
    streak: row.streak,
    crewLevel: row.miners_level + row.drills_level + row.carts_level + row.foreman_level + row.storage_level,
    crewTier: crewTier(crewLevelsOf(row)).tier,
    discoveries: row.discoveries_count,
    claimedValueUsd: row.claimed_value_usd,
    trust: row.trust,
    flags: parseFlags(row.flags),
    relatedAccounts: row.related_accounts,
    restrictions: restrictions
      .filter((restriction) => restriction.wallet === row.wallet)
      .map((restriction) => ({
        kind: restriction.kind,
        reasonCode: restriction.reason_code,
        createdAt: restriction.created_at,
        expiresAt: restriction.expires_at,
        createdBy: restriction.created_by,
      })),
  }));
  return json(
    {
      actor,
      /**
       * The operator's view of the enforcement switch, so the console can say out loud whether a
       * HIGH account is being held or merely watched.
       */
      enforcement: {
        mode: RISK_OPS.enforcement.mode,
        overrides: RISK_OPS.enforcement.overrides,
        shadowedAccounts: accounts.filter((account) => account.shadowed).length,
      },
      accounts,
      count: accounts.length,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

interface RestrictionBody {
  wallet?: string;
  kind?: string;
  reasonCode?: string;
  expiresInSec?: number;
  lift?: boolean;
  stepUp?: AdminStepUpProof;
}

/**
 * The bytes a step-up signature covers: the mutation body exactly as it arrived, minus the proof
 * itself. Canonicalised on both sides, so field order in the JSON never matters.
 */
export function stepUpPayload<T extends { stepUp?: AdminStepUpProof }>(body: T): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...body };
  delete payload.stepUp;
  return payload;
}

/**
 * POST /api/admin/restrictions { wallet, kind, reasonCode?, expiresInSec?, lift? }
 *
 * Places or lifts one restriction. A restriction can only slow an account down; it never moves
 * value.
 */
export async function adminRestrictions(request: Request, env: RuntimeEnv): Promise<Response> {
  const actor = await adminActor(env, request);
  if (!actor) return apiError("Admin session required", 401);
  const body = await readJson<RestrictionBody>(request, 4_096);
  if (!isBase58Address(body.wallet)) return apiError("Invalid Solana wallet");
  const kind = body.kind as RestrictionKind;
  if (!RESTRICTION_KINDS.includes(kind)) return apiError("Unknown restriction kind");
  // Session first, then a signature over this exact change: the session says who is asking, the
  // step-up says they meant *this* mutation, just now.
  const proof = await requireAdminStepUp(env, {
    actor,
    action: body.lift ? "restriction.lift" : "restriction.set",
    payload: stepUpPayload(body),
    proof: body.stepUp,
  });
  if (!proof.ok) return proof.response;
  const now = Math.floor(Date.now() / 1_000);
  if (body.lift) {
    const lifted = await clearRestriction(env, body.wallet, kind);
    await writeAudit(env, actor, "restriction.lift", body.wallet, { kind, lifted, stepUp: proof.nonce });
    return json({ wallet: body.wallet, kind, lifted }, { headers: { "cache-control": "no-store" } });
  }
  const reasonCode = (body.reasonCode ?? "admin_manual").slice(0, 64);
  const expiresInSec =
    typeof body.expiresInSec === "number" && Number.isFinite(body.expiresInSec) && body.expiresInSec > 0
      ? Math.min(60 * 60 * 24 * 30, Math.floor(body.expiresInSec))
      : null;
  const restriction = await setRestriction(env, {
    wallet: body.wallet,
    kind,
    reasonCode,
    createdBy: actor,
    expiresAt: expiresInSec === null ? null : now + expiresInSec,
  });
  await writeAudit(env, actor, "restriction.set", body.wallet, {
    kind,
    reasonCode,
    expiresInSec,
    stepUp: proof.nonce,
  });
  return json({ restriction }, { headers: { "cache-control": "no-store" } });
}

interface BreakerBody {
  scope?: string;
  mint?: string;
  open?: boolean;
  reason?: string;
  stepUp?: AdminStepUpProof;
}

/**
 * POST /api/admin/breakers { scope, mint?, open, reason }
 *
 * The full extent of emergency control: halt or resume new discoveries, claims, or one mine's
 * Discovery Reserve payouts. Trading, the launch market and every fund movement are untouched by
 * design - there is no code path from here to any of them.
 */
export async function adminBreakers(request: Request, env: RuntimeEnv): Promise<Response> {
  const actor = await adminActor(env, request);
  if (!actor) return apiError("Admin session required", 401);
  const body = await readJson<BreakerBody>(request, 4_096);
  const scope = body.scope as BreakerScope;
  if (!BREAKER_SCOPES.includes(scope)) return apiError("Unknown breaker scope");
  if (scope === "discovery_reserve" && body.mint !== undefined && !isBase58Address(body.mint)) {
    return apiError("Invalid mint for discovery_reserve");
  }
  if (typeof body.reason !== "string" || body.reason.trim().length === 0) {
    return apiError("A reason is required for every breaker change");
  }
  const open = body.open !== false;
  const proof = await requireAdminStepUp(env, {
    actor,
    action: open ? "breaker.open" : "breaker.close",
    payload: stepUpPayload(body),
    proof: body.stepUp,
  });
  if (!proof.ok) return proof.response;
  const breaker: BreakerState = await setBreaker(env, {
    scope,
    mint: scope === "discovery_reserve" ? (body.mint ?? null) : null,
    open,
    reason: body.reason.trim().slice(0, 200),
    actor,
  });
  await writeAudit(env, actor, open ? "breaker.open" : "breaker.close", breaker.mint ?? breaker.scope, {
    scope,
    mint: breaker.mint,
    reason: breaker.reason,
    stepUp: proof.nonce,
  });
  return json(
    { breaker, breakers: await breakerStates(env) },
    { headers: { "cache-control": "no-store" } },
  );
}

/**
 * GET /api/admin/metrics - the spec 66 metric set, the alert evaluation and the current breaker
 * state, so an operator sees the same numbers the alerting would.
 */
export async function adminMetrics(request: Request, env: RuntimeEnv): Promise<Response> {
  const actor = await adminActor(env, request);
  if (!actor) return apiError("Admin session required", 401);
  const now = Math.floor(Date.now() / 1_000);
  const [report, counters, breakers, audit] = await Promise.all([
    collectMetrics(env, now),
    readCounters(env, 24),
    breakerStates(env),
    recentAudit(env, 25),
  ]);
  return json(
    {
      actor,
      window: report.window,
      metrics: report.snapshot,
      alerts: report.alerts,
      breakers,
      counters,
      audit,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
