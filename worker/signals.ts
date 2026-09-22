/**
 * Signal capture: privacy-preserving request fingerprints, the append-only account_signals
 * log every risk query reads, and the account_restrictions helpers.
 *
 * Raw IP addresses and raw client device strings are never persisted (spec 50, 51, 67): each
 * identifier is salted and hashed before it reaches D1, so clusters can be counted without
 * storing personal data. The salt lives in the DIGGO_DEVICE_SALT secret.
 */
import type { GatedActionKey } from "../shared/riskOps";
import type { RuntimeEnv } from "./env";
import { SESSION_COOKIE, textEncoder } from "./http";

/** Recorded outcome of a gated action. Anything but "ok" is friction the metrics watch. */
export type ActivityOutcome = "ok" | "rejected" | "replay" | "rate_limited" | "failed_challenge";

/**
 * Client-provided, privacy-conscious device hint. It is a hint, never an identity: a normal
 * player may have several wallets, and one device can never be the sole reason for a ban
 * (spec 50).
 */
export const DEVICE_HEADER = "x-diggo-device";

export interface RequestFingerprint {
  ipHash: string | null;
  deviceHash: string | null;
  networkHash: string | null;
  sessionId: string | null;
}

export type RestrictionKind =
  | "ACCOUNT_BLOCK"
  | "CLAIM_HOLD"
  | "DISCOVERY_BLOCK"
  | "CHALLENGE_REQUIRED"
  | "RATE_LIMIT";

export const RESTRICTION_KINDS: readonly RestrictionKind[] = [
  "ACCOUNT_BLOCK",
  "CLAIM_HOLD",
  "DISCOVERY_BLOCK",
  "CHALLENGE_REQUIRED",
  "RATE_LIMIT",
];

export interface RestrictionRow {
  wallet: string;
  kind: RestrictionKind;
  reason_code: string;
  created_at: number;
  expires_at: number | null;
  created_by: string;
}

export interface SignalRow {
  wallet: string;
  ts: number;
  action: string;
  ip_hash: string | null;
  network_hash: string | null;
  device_hash: string | null;
  session_id: string | null;
  outcome: string;
}

const FALLBACK_SALT = "diggo:risk:v1";

export async function hashIdentifier(salt: string, value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(salt + "|" + value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

export function deviceSalt(env: RuntimeEnv): string {
  return env.DIGGO_DEVICE_SALT && env.DIGGO_DEVICE_SALT.length > 0 ? env.DIGGO_DEVICE_SALT : FALLBACK_SALT;
}

/** Session id from the session cookie or the bearer token, without touching KV. */
export function sessionIdOf(request: Request): string | null {
  const cookieMatch = request.headers.get("cookie")?.match(new RegExp("(?:^|;\\s*)" + SESSION_COOKIE + "=([^;]+)"));
  if (cookieMatch?.[1]) {
    try {
      return decodeURIComponent(cookieMatch[1]);
    } catch {
      return null;
    }
  }
  const header = request.headers.get("authorization");
  return header?.startsWith("Bearer ") ? header.slice(7) : null;
}

interface CloudflareRequest extends Request {
  cf?: { asn?: number; colo?: string; country?: string };
}

/**
 * Network environment, not a person: ASN + colo + the client subnet (/24 for IPv4, /48 for
 * IPv6, which covers one NAT pool or household LAN). "same IP = ban" is explicitly not a rule
 * (spec 51); this value only ever feeds one weighted signal.
 */
export function networkKey(request: Request, ip: string | null): string | null {
  const cf = (request as CloudflareRequest).cf;
  const parts: string[] = [];
  if (cf?.asn !== undefined) parts.push("asn" + cf.asn);
  if (cf?.colo) parts.push("colo" + cf.colo);
  if (cf?.country) parts.push("cc" + cf.country);
  const subnet = ip ? ipSubnet(ip) : null;
  if (subnet) parts.push(subnet);
  return parts.length > 0 ? parts.join("|") : null;
}

function ipSubnet(ip: string): string | null {
  if (ip.includes(":")) {
    const groups = ip.split(":").filter((part) => part.length > 0);
    return groups.length >= 3 ? "v6:" + groups.slice(0, 3).join(":") : null;
  }
  const octets = ip.split(".");
  return octets.length === 4 ? "v4:" + octets.slice(0, 3).join(".") : null;
}

export async function fingerprintRequest(env: RuntimeEnv, request: Request): Promise<RequestFingerprint> {
  const salt = deviceSalt(env);
  const ip = request.headers.get("cf-connecting-ip");
  const device = request.headers.get(DEVICE_HEADER);
  const network = networkKey(request, ip);
  const [ipHash, deviceHash, networkHash] = await Promise.all([
    ip ? hashIdentifier(salt, "ip|" + ip) : Promise.resolve(null),
    device ? hashIdentifier(salt, "device|" + device) : Promise.resolve(null),
    network ? hashIdentifier(salt, "network|" + network) : Promise.resolve(null),
  ]);
  return { ipHash, deviceHash, networkHash, sessionId: sessionIdOf(request) };
}

export interface RecordActivityInput {
  wallet: string;
  action: GatedActionKey;
  outcome: ActivityOutcome;
  fingerprint: RequestFingerprint;
  ts?: number;
}

/**
 * Appends one row to account_signals. Best effort by design: signal capture must never fail a
 * player's request, so errors are logged and swallowed.
 */
export async function recordActivityRow(env: RuntimeEnv, input: RecordActivityInput): Promise<void> {
  try {
    await env.DB.prepare(
      "INSERT INTO account_signals (wallet, ts, action, ip_hash, network_hash, device_hash, session_id, outcome) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )
      .bind(
        input.wallet,
        input.ts ?? Math.floor(Date.now() / 1_000),
        input.action,
        input.fingerprint.ipHash,
        input.fingerprint.networkHash,
        input.fingerprint.deviceHash,
        input.fingerprint.sessionId,
        input.outcome,
      )
      .run();
  } catch (error) {
    console.error(JSON.stringify({ event: "risk.signal_write_failed", wallet: input.wallet, error: String(error) }));
  }
}

export async function activeRestrictions(
  env: RuntimeEnv,
  wallet: string,
  now = Math.floor(Date.now() / 1_000),
): Promise<RestrictionRow[]> {
  const result = await env.DB.prepare(
    "SELECT wallet, kind, reason_code, created_at, expires_at, created_by FROM account_restrictions " +
      "WHERE wallet = ?1 AND (expires_at IS NULL OR expires_at > ?2) ORDER BY created_at DESC",
  )
    .bind(wallet, now)
    .all<RestrictionRow>();
  return result.results;
}

export interface SetRestrictionInput {
  wallet: string;
  kind: RestrictionKind;
  reasonCode: string;
  createdBy: string;
  expiresAt?: number | null;
}

/** Upsert of one restriction, keyed (wallet, kind): the newest decision wins. */
export async function setRestriction(env: RuntimeEnv, input: SetRestrictionInput): Promise<RestrictionRow> {
  const now = Math.floor(Date.now() / 1_000);
  const expiresAt = input.expiresAt ?? null;
  await env.DB.prepare(
    "INSERT INTO account_restrictions (wallet, kind, reason_code, created_at, expires_at, created_by) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6) " +
      "ON CONFLICT(wallet, kind) DO UPDATE SET reason_code = excluded.reason_code, " +
      "expires_at = excluded.expires_at, created_by = excluded.created_by, created_at = excluded.created_at",
  )
    .bind(input.wallet, input.kind, input.reasonCode, now, expiresAt, input.createdBy)
    .run();
  return {
    wallet: input.wallet,
    kind: input.kind,
    reason_code: input.reasonCode,
    created_at: now,
    expires_at: expiresAt,
    created_by: input.createdBy,
  };
}

export async function clearRestriction(env: RuntimeEnv, wallet: string, kind: RestrictionKind): Promise<boolean> {
  const result = await env.DB.prepare("DELETE FROM account_restrictions WHERE wallet = ?1 AND kind = ?2")
    .bind(wallet, kind)
    .run();
  return result.meta.changes > 0;
}

