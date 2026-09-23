/**
 * Public usernames: reading one, and the single write that sets or changes it.
 *
 * The write is a per-wallet mutation and goes through the same three doors as every other sensitive
 * action: a signed session (the wallet in the session cookie, never a body field), the risk gate
 * under its own `profile_update` budget, and an IP rate limit. Uniqueness is not decided here -
 * the UNIQUE index on the normalized name settles a race between two wallets, and this module only
 * turns the resulting constraint failure into a 409.
 *
 * The change clock lives in the row (updated_at) and the cooldown is applied inside the upsert's
 * WHERE clause rather than by a read followed by a write, so two requests arriving together cannot
 * both slip past a cooldown they should share.
 */
import { DIGGO_CONFIG } from "../shared/config";
import {
  USERNAME_MESSAGES,
  USERNAME_RULES,
  usernameCooldownRemaining,
  usernameRejectionMessage,
  validateUsername,
  withUsernameRules,
  type UsernameRules,
} from "../shared/username";
import { sessionWallet } from "./auth";
import { optionalBinding, type RuntimeEnv } from "./env";
import { apiError, checkRateLimit, isBase58Address, json, readJson } from "./http";
import { gateAction, type GateResult } from "./risk";
import { fingerprintRequest, recordActivityRow } from "./signals";

/** Per-IP budget for the write, on top of the gate's own per-wallet budget. */
const USERNAME_RATE_LIMIT = 10;
const USERNAME_RATE_BUCKET = "profile";

interface UsernameRow {
  username: string;
  username_normalized: string;
  updated_at: number;
}

/**
 * One statement for both the first set and every later change.
 *
 * A wallet with no row is inserted; a wallet that already has one is updated only when the cooldown
 * has elapsed, which the WHERE clause decides on the row the update would overwrite. A name already
 * held by another wallet fails the UNIQUE index on username_normalized instead, and the caller maps
 * that failure to 409.
 */
const UPSERT_USERNAME_SQL =
  "INSERT INTO usernames (wallet, username, username_normalized, created_at, updated_at, change_count) " +
  "VALUES (?1, ?2, ?3, ?4, ?4, 1) " +
  "ON CONFLICT(wallet) DO UPDATE SET username = excluded.username, " +
  "username_normalized = excluded.username_normalized, updated_at = excluded.updated_at, " +
  "change_count = usernames.change_count + 1 " +
  "WHERE usernames.updated_at <= ?5";

/** The rules this deployment runs with: the shared defaults plus optional environment overrides. */
export function usernameRules(env: RuntimeEnv): UsernameRules {
  const extraReserved = optionalBinding<string>(env, "USERNAME_EXTRA_RESERVED");
  const cooldown = optionalBinding<string | number>(env, "USERNAME_COOLDOWN_SECONDS");
  return withUsernameRules(USERNAME_RULES, {
    reserved: typeof extraReserved === "string" ? extraReserved.split(",") : undefined,
    cooldownSeconds: cooldown === undefined ? undefined : Number(cooldown),
  });
}

export async function usernameFor(env: RuntimeEnv, wallet: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT username FROM usernames WHERE wallet = ?1")
    .bind(wallet)
    .first<{ username: string }>();
  return row?.username ?? null;
}

async function loadUsernameRow(env: RuntimeEnv, wallet: string): Promise<UsernameRow | null> {
  return env.DB.prepare("SELECT username, username_normalized, updated_at FROM usernames WHERE wallet = ?1")
    .bind(wallet)
    .first<UsernameRow>();
}

/** True for the UNIQUE failure a taken name produces, on D1 and on the SQLite test double alike. */
function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unique constraint|sqlite_constraint/i.test(message);
}

function tooSoonResponse(retryAfterSec: number): Response {
  const retry = Math.max(1, Math.ceil(retryAfterSec));
  return json(
    { code: "USERNAME_TOO_SOON", message: USERNAME_MESSAGES.tooSoon, retryAfterSec: retry },
    { status: 429, headers: { "retry-after": String(retry) } },
  );
}

/**
 * Neutral refusal for a write the risk gate will not let through (spec 62): the public state name
 * and nothing about the score behind it.
 */
function gateResponse(gate: GateResult): Response {
  const message = gate.publicMessage ?? DIGGO_CONFIG.risk.publicStatus[gate.rewardState];
  if (gate.retryAfterSec === undefined) return json({ code: gate.rewardState, message }, { status: 403 });
  return json(
    { code: "RATE_LIMITED", message },
    { status: 429, headers: { "retry-after": String(gate.retryAfterSec) } },
  );
}

/**
 * GET /api/profile/:wallet -> { wallet, username | null }.
 *
 * Public on purpose: the leaderboard and the header both show the name, so it is not a secret. The
 * response is never cached, because a player who just renamed would otherwise keep seeing the old
 * one from a shared cache.
 */
export async function publicProfile(_request: Request, env: RuntimeEnv, wallet: string): Promise<Response> {
  if (!isBase58Address(wallet)) return apiError("Invalid Solana wallet");
  return json({ wallet, username: await usernameFor(env, wallet) }, { headers: { "cache-control": "no-store" } });
}

/**
 * POST /api/profile/username { username } -> 200 { username }
 *
 * 400 for a name the shared rules refuse, 409 when another wallet holds it, 429 while the change
 * cooldown is running, 401 without a signed session and 403/429 when the gate refuses the write.
 */
export async function setUsername(request: Request, env: RuntimeEnv): Promise<Response> {
  const wallet = await sessionWallet(request, env);
  if (!wallet) return apiError("Wallet authentication required", 401);

  // The gate first: a farm brute-forcing names spends its own budget, and an operator's restriction
  // or an open breaker stops the request before any validation work is done.
  const gate = await gateAction(env, { wallet, request, action: "profile_update" });
  if (!gate.allowed) return gateResponse(gate);
  if (!(await checkRateLimit(request, env, USERNAME_RATE_BUCKET, USERNAME_RATE_LIMIT))) {
    return apiError("Too many requests", 429);
  }

  const body = await readJson<{ username?: unknown }>(request);
  const rules = usernameRules(env);
  const validation = validateUsername(body.username, rules);
  if (!validation.ok) {
    return json(
      { code: validation.reason.toUpperCase(), message: usernameRejectionMessage(validation.reason) },
      { status: 400 },
    );
  }

  const now = Math.floor(Date.now() / 1_000);
  const existing = await loadUsernameRow(env, wallet);
  // Re-sending the name already stored is a retry, not a change: it succeeds without spending the
  // cooldown, so a client that lost the first answer is never stuck for a week.
  if (existing && existing.username === validation.username && existing.username_normalized === validation.normalized) {
    return json({ username: existing.username, changed: false }, { headers: { "cache-control": "no-store" } });
  }
  if (existing) {
    const wait = usernameCooldownRemaining(existing.updated_at, now, rules);
    if (wait > 0) return tooSoonResponse(wait);
  }

  let stored: string;
  try {
    const result = await env.DB.prepare(UPSERT_USERNAME_SQL)
      .bind(wallet, validation.username, validation.normalized, now, now - rules.cooldownSeconds)
      .run();
    if (result.meta.changes === 0) {
      // The row changed between the read above and this statement: the cooldown the other request
      // just started is now the authoritative one.
      const raced = await loadUsernameRow(env, wallet);
      return tooSoonResponse(raced ? usernameCooldownRemaining(raced.updated_at, now, rules) : rules.cooldownSeconds);
    }
    stored = validation.username;
  } catch (error) {
    const raced = await loadUsernameRow(env, wallet).catch(() => null);
    if (raced && raced.username_normalized === validation.normalized) {
      // Another request from this same wallet won the race with the very name asked for.
      stored = raced.username;
    } else if (isUniqueViolation(error)) {
      return json({ code: "USERNAME_TAKEN", message: USERNAME_MESSAGES.taken }, { status: 409 });
    } else {
      throw error;
    }
  }

  await recordActivityRow(env, {
    wallet,
    action: "profile_update",
    outcome: "ok",
    fingerprint: await fingerprintRequest(env, request),
    ts: now,
  });
  return json({ username: stored, changed: true }, { headers: { "cache-control": "no-store" } });
}
