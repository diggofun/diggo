/**
 * Wallet authentication: sign-in challenges, ed25519 signature verification and the session
 * cookie/token later requests present. Challenges are single-use nonces held in KV with a short
 * TTL, so a captured signature cannot be replayed (see spec 47 Replay Protection).
 *
 * Challenge hardening (spec 46, 47): a nonce is single-use, short-lived and bound to one
 * wallet + action (+ resource). Consumption is a conditional UPDATE against challenge_nonces
 * rather than a read-then-delete, because read-then-delete races; a second attempt with a spent
 * nonce is reported as a replay, and both replays and bad signatures are recorded as account
 * signals so the risk score and the metrics can see them.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";
import { DIGGO_CONFIG } from "../shared/config";
import { RISK_OPS } from "../shared/riskOps";
import { optionalBinding, type RuntimeEnv } from "./env";
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  apiError,
  checkRateLimit,
  isBase58Address,
  json,
  readJson,
  sessionCookie,
  textEncoder,
} from "./http";
import { fingerprintRequest, recordActivityRow } from "./signals";
import { METRIC, metric } from "./telemetry";
import { gateAction, type GateResult } from "./risk";
import { captureAttribution } from "./referrals";

export interface ChallengeRecord {
  wallet: string;
  message: string;
  /** Action the nonce is bound to; filled in from the key when a caller omits it. */
  action?: string;
  resource?: string | null;
  /** Unix seconds the nonce stops being usable. */
  expiresAt?: number;
}

/** KV key for a challenge. Format: "<action>:challenge:<nonce>". */
export function challengeKey(action: string, nonce: string): string {
  return action + ":challenge:" + nonce;
}

function actionFromKey(key: string): string {
  const action = key.split(":")[0];
  return action.length > 0 ? action : "unknown";
}

function nonceFromKey(key: string): string {
  const parts = key.split(":");
  return parts[parts.length - 1] ?? key;
}

/**
 * Stores a single-use challenge record under key, expiring after ttlSeconds, and registers the
 * nonce so a later consumption can be atomic.
 */
export async function storeChallenge(
  env: RuntimeEnv,
  key: string,
  record: ChallengeRecord,
  ttlSeconds = RISK_OPS.challenge.ttlSeconds,
): Promise<void> {
  const now = Math.floor(Date.now() / 1_000);
  const action = record.action ?? actionFromKey(key);
  const nonce = nonceFromKey(key);
  const enriched: ChallengeRecord = {
    ...record,
    action,
    resource: record.resource ?? null,
    expiresAt: record.expiresAt ?? now + ttlSeconds,
  };
  await env.TOKEN_CACHE.put(key, JSON.stringify(enriched), { expirationTtl: ttlSeconds });
  await env.DB.prepare(
    "INSERT INTO challenge_nonces (nonce, wallet, action, resource, issued_at, expires_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(nonce) DO UPDATE SET wallet = excluded.wallet, " +
      "action = excluded.action, resource = excluded.resource, expires_at = excluded.expires_at",
  )
    .bind(nonce, record.wallet, action, enriched.resource ?? null, now, enriched.expiresAt ?? now + ttlSeconds)
    .run();
}

/**
 * Reads a challenge stored by storeChallenge. Null once it expired, was consumed or was never
 * registered. A storage error on the nonce table falls back to the KV record rather than locking
 * every player out of their own activation.
 */
export async function loadChallenge(env: RuntimeEnv, key: string): Promise<ChallengeRecord | null> {
  const record = await env.TOKEN_CACHE.get<ChallengeRecord>(key, "json");
  if (!record) return null;
  const now = Math.floor(Date.now() / 1_000);
  if (record.expiresAt !== undefined && record.expiresAt <= now) return null;
  try {
    const row = await env.DB.prepare("SELECT consumed_at, expires_at FROM challenge_nonces WHERE nonce = ?1")
      .bind(nonceFromKey(key))
      .first<{ consumed_at: number | null; expires_at: number }>();
    if (!row) return null;
    if (row.consumed_at !== null) return null;
    if (row.expires_at <= now) return null;
  } catch (error) {
    console.error(JSON.stringify({ event: "auth.nonce_read_failed", error: String(error) }));
  }
  return record;
}

export type ChallengeConsumeResult = "ok" | "replay" | "expired" | "unknown";

/**
 * Atomically consumes a nonce. Only one caller can ever get "ok": the conditional UPDATE is what
 * makes a captured signature useless the second time (spec 47).
 */
export async function consumeChallengeNonce(
  env: RuntimeEnv,
  input: { nonce: string; wallet: string; action: string; resource?: string | null },
): Promise<ChallengeConsumeResult> {
  const now = Math.floor(Date.now() / 1_000);
  const base =
    "UPDATE challenge_nonces SET consumed_at = ?1 WHERE nonce = ?2 AND wallet = ?3 AND action = ?4 " +
    "AND consumed_at IS NULL AND expires_at > ?1";
  const bound =
    input.resource === undefined || input.resource === null
      ? env.DB.prepare(base).bind(now, input.nonce, input.wallet, input.action)
      : env.DB.prepare(base + " AND IFNULL(resource, '') = ?5").bind(
          now,
          input.nonce,
          input.wallet,
          input.action,
          input.resource,
        );
  const result = await bound.run();
  if (result.meta.changes > 0) return "ok";
  const row = await env.DB.prepare(
    "SELECT wallet, action, consumed_at, expires_at FROM challenge_nonces WHERE nonce = ?1",
  )
    .bind(input.nonce)
    .first<{ wallet: string; action: string; consumed_at: number | null; expires_at: number }>();
  if (!row) return "unknown";
  if (row.consumed_at !== null) return "replay";
  if (row.expires_at <= now) return "expired";
  return "unknown";
}

export interface IssuedChallenge {
  nonce: string;
  message: string;
  expiresAt: number;
  key: string;
}

/** Issues and registers a short-lived challenge bound to wallet + action (+ resource). */
export async function issueChallenge(
  env: RuntimeEnv,
  input: { wallet: string; action: string; resource?: string | null; title: string; ttlSeconds?: number },
): Promise<IssuedChallenge> {
  const ttlSeconds = input.ttlSeconds ?? RISK_OPS.challenge.ttlSeconds;
  const nonce = crypto.randomUUID();
  const expiresAt = Math.floor(Date.now() / 1_000) + ttlSeconds;
  const message = [
    input.title,
    "Wallet: " + input.wallet,
    "Action: " + input.action,
    input.resource ? "Resource: " + input.resource : null,
    "Nonce: " + nonce,
    "Expires: " + new Date(expiresAt * 1_000).toISOString(),
    "This request does not trigger a blockchain transaction.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
  const key = challengeKey(input.action, nonce);
  await storeChallenge(
    env,
    key,
    { wallet: input.wallet, message, action: input.action, resource: input.resource ?? null },
    ttlSeconds,
  );
  await env.DB.prepare("DELETE FROM challenge_nonces WHERE wallet = ?1 AND expires_at <= ?2")
    .bind(input.wallet, Math.floor(Date.now() / 1_000))
    .run()
    .catch(() => undefined);
  return { nonce, message, expiresAt, key };
}

async function recordAuthOutcome(
  env: RuntimeEnv,
  request: Request,
  wallet: string,
  outcome: "ok" | "rejected" | "replay" | "failed_challenge",
): Promise<void> {
  const fingerprint = await fingerprintRequest(env, request);
  await recordActivityRow(env, { wallet, action: "auth", outcome, fingerprint });
  if (outcome === "replay") await metric(env, METRIC.replayAttempt, 1, { action: "auth" });
  else if (outcome === "failed_challenge") await metric(env, METRIC.failedChallenge, 1, { action: "auth" });
}

/**
 * Neutral refusal for a sign-in the risk gate will not let through (spec 62).
 *
 * Sign-in is a gated action like any other (spec 48): a wallet farm must clear the multi-key
 * limiter before it can even ask for a nonce, and the refusal is recorded by the gate itself. The
 * gate deliberately never challenges an UNDER_REVIEW account here - a player has to be able to
 * sign in to see what is going on - and HELD accounts may still authenticate (spec 53).
 */
function authGateResponse(gate: GateResult): Response {
  const message = gate.publicMessage ?? DIGGO_CONFIG.risk.publicStatus[gate.rewardState];
  if (gate.retryAfterSec === undefined) return json({ code: gate.rewardState, message }, { status: 403 });
  return json(
    { code: "RATE_LIMITED", message },
    { status: 429, headers: { "retry-after": String(gate.retryAfterSec) } },
  );
}

/**
 * Verifies a base58 wallet signature over a challenge message, returning false on malformed
 * input instead of throwing, so callers can answer with a plain 401.
 */
export function verifyWalletSignature(wallet: string, message: string, signature: string): boolean {
  try {
    return ed25519.verify(bs58.decode(signature), textEncoder.encode(message), bs58.decode(wallet));
  } catch {
    return false;
  }
}

/**
 * A configured hostname list entry, reduced to the host siteverify reports: a bare hostname, or a
 * URL/origin an operator pasted, all with the same meaning.
 */
function normalizeTurnstileHostname(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return "";
  const afterScheme = trimmed.includes("://") ? trimmed.slice(trimmed.indexOf("://") + 3) : trimmed;
  const host = (afterScheme.split("/")[0] ?? "").split(":")[0] ?? "";
  return host;
}

function commaSeparatedBinding(env: RuntimeEnv, name: string): string[] {
  const raw = optionalBinding<string>(env, name);
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/**
 * The hostnames a Turnstile token is allowed to have been solved on: wherever this request actually
 * arrived (so the production domain needs no configuration) plus the configured allowlist, because
 * the same deployment legitimately answers on apex, ``www`` and preview hosts.
 */
export function turnstileAllowedHostnames(request: Request, env: RuntimeEnv): string[] {
  const hostnames = new Set<string>();
  const requestHostname = normalizeTurnstileHostname(new URL(request.url).hostname);
  if (requestHostname.length > 0) hostnames.add(requestHostname);
  for (const entry of commaSeparatedBinding(env, "TURNSTILE_ALLOWED_HOSTNAMES")) {
    const hostname = normalizeTurnstileHostname(entry);
    if (hostname.length > 0) hostnames.add(hostname);
  }
  return [...hostnames];
}

/**
 * Verifies a Turnstile token (spec 46, 62).
 *
 * Success is not enough on its own: siteverify reports the hostname the token was solved on, so a
 * token solved on an attacker's own page - which an attacker can always produce with their own site
 * key - has to be refused here, or the friction this gate exists to add can be cleared off-site.
 * When the token carries an action it has to be one this deployment expects (TURNSTILE_ACTIONS),
 * which is what stops a token minted for a cheap widget from being replayed into a sensitive one.
 */
export async function verifyTurnstile(
  token: string,
  request: Request,
  env: RuntimeEnv,
): Promise<boolean> {
  const hostname = new URL(request.url).hostname;
  if ((hostname === "localhost" || hostname === "127.0.0.1") && token === "dev-bypass") {
    return true;
  }
  if (!env.TURNSTILE_SECRET || !token) return false;
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      secret: env.TURNSTILE_SECRET,
      response: token,
      remoteip: request.headers.get("cf-connecting-ip") ?? undefined,
      idempotency_key: crypto.randomUUID(),
    }),
  });
  let result: { success?: boolean; hostname?: string; action?: string };
  try {
    result = (await response.json()) as { success?: boolean; hostname?: string; action?: string };
  } catch {
    // An unreadable answer is an unverified token, never a cleared one.
    return false;
  }
  if (result.success !== true) return false;

  const solvedOn = typeof result.hostname === "string" ? normalizeTurnstileHostname(result.hostname) : "";
  if (solvedOn.length === 0) return false;
  if (!turnstileAllowedHostnames(request, env).includes(solvedOn)) return false;

  const action = typeof result.action === "string" ? result.action.trim().toLowerCase() : "";
  // The action check only exists for deployments that declare actions. An unconfigured list must
  // not refuse every token: siteverify reports an empty action for a widget with no action, and a
  // deployment that never set TURNSTILE_ACTIONS would otherwise reject every real solution - a
  // gate that fails closed on its own missing configuration is an outage, not a defence. The
  // hostname check above is what makes the token this deployment's, and it always runs.
  const declaredActions = commaSeparatedBinding(env, "TURNSTILE_ACTIONS");
  if (declaredActions.length > 0 && action.length > 0 && !declaredActions.includes(action)) return false;
  return true;
}

export async function sessionWallet(request: Request, env: RuntimeEnv): Promise<string | null> {
  const cookieMatch = request.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  let cookieSession: string | null = null;
  if (cookieMatch?.[1]) {
    try {
      cookieSession = decodeURIComponent(cookieMatch[1]);
    } catch {
      cookieSession = null;
    }
  }
  const header = request.headers.get("authorization");
  const bearerSession = header?.startsWith("Bearer ") ? header.slice(7) : null;
  const session = cookieSession ?? bearerSession;
  return session ? env.TOKEN_CACHE.get(`auth:session:${session}`) : null;
}

export async function createChallenge(request: Request, env: RuntimeEnv): Promise<Response> {
  if (!(await checkRateLimit(request, env, "auth"))) return apiError("Too many requests", 429);
  const { wallet } = await readJson<{ wallet?: string }>(request);
  if (!isBase58Address(wallet)) return apiError("Invalid Solana wallet");
  const gate = await gateAction(env, { wallet, request, action: "auth" });
  if (!gate.allowed) return authGateResponse(gate);
  const nonce = crypto.randomUUID();
  const message = [
    "Sign in to Diggo.fun",
    `Wallet: ${wallet}`,
    `Nonce: ${nonce}`,
    "This request does not trigger a blockchain transaction.",
  ].join("\n");
  await storeChallenge(env, `auth:challenge:${nonce}`, { wallet, message });
  return json({ nonce, message });
}

export async function verifyWallet(request: Request, env: RuntimeEnv): Promise<Response> {
  if (!(await checkRateLimit(request, env, "auth"))) return apiError("Too many requests", 429);
  const body = await readJson<{ wallet?: string; nonce?: string; signature?: string }>(request);
  if (!isBase58Address(body.wallet) || !body.nonce || !body.signature) {
    return apiError("Incomplete wallet proof");
  }
  const gate = await gateAction(env, { wallet: body.wallet, request, action: "auth" });
  if (!gate.allowed) return authGateResponse(gate);
  const challenge = await loadChallenge(env, `auth:challenge:${body.nonce}`);
  if (!challenge || challenge.wallet !== body.wallet) {
    // Nothing usable is left in KV, so the nonce table has the final word: a nonce that was
    // already consumed is a replay, not merely a late request (spec 47).
    const status = await consumeChallengeNonce(env, { nonce: body.nonce, wallet: body.wallet, action: "auth" });
    if (status === "replay") {
      await recordAuthOutcome(env, request, body.wallet, "replay");
      return apiError("Challenge already used", 409);
    }
    return apiError("Challenge expired", 401);
  }
  if (!verifyWalletSignature(body.wallet, challenge.message, body.signature)) {
    await recordAuthOutcome(env, request, body.wallet, "failed_challenge");
    return apiError("Invalid wallet signature", 401);
  }
  const consumed = await consumeChallengeNonce(env, { nonce: body.nonce, wallet: body.wallet, action: "auth" });
  if (consumed !== "ok") {
    await recordAuthOutcome(env, request, body.wallet, "replay");
    return apiError(
      consumed === "replay" ? "Challenge already used" : "Challenge expired",
      consumed === "replay" ? 409 : 401,
    );
  }
  await env.TOKEN_CACHE.delete(`auth:challenge:${body.nonce}`);
  const session = crypto.randomUUID().replaceAll("-", "");
  await recordAuthOutcome(env, request, body.wallet, "ok");
  await env.TOKEN_CACHE.put(`auth:session:${session}`, body.wallet, { expirationTtl: SESSION_TTL_SECONDS });
  const referralCode = new URL(request.url).searchParams.get("ref");
  const attribution = await captureAttribution(env, body.wallet, referralCode);
  // True when this wallet is bound to the code it signed in with, so the client can report the
  // referee's sign-in once (referral_signup). Carries no referrer identity.
  const referralCaptured = Boolean(
    attribution && referralCode && attribution.code.toLowerCase() === referralCode.trim().toLowerCase(),
  );
  return json(
    { wallet: body.wallet, expiresIn: SESSION_TTL_SECONDS, referralCaptured },
    { headers: { "set-cookie": sessionCookie(session), "cache-control": "no-store" } },
  );
}

export async function walletSession(request: Request, env: RuntimeEnv): Promise<Response> {
  const wallet = await sessionWallet(request, env);
  return wallet
    ? json({ wallet }, { headers: { "cache-control": "no-store" } })
    : apiError("Wallet authentication required", 401);
}
