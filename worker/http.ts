/**
 * HTTP plumbing shared by every route module: JSON responses, error helpers, request-body
 * parsing, session cookie formatting and the two rate-limit dimensions (per-IP and per-wallet).
 */
import type { RuntimeEnv } from "./env";

interface CloudflareSubtleCrypto extends SubtleCrypto {
  timingSafeEqual(a: ArrayBufferView, b: ArrayBufferView): boolean;
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

export const textEncoder = new TextEncoder();
export const SESSION_COOKIE = "diggo_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(JSON_HEADERS);
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  return new Response(JSON.stringify(data), {
    ...init,
    headers,
  });
}

export function apiError(message: string, status = 400): Response {
  return json({ error: message }, { status });
}

export function isBase58Address(value: unknown): value is string {
  return typeof value === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

export function sameSecret(received: string | null, expected: string | undefined): boolean {
  if (!received || !expected) return false;
  const left = textEncoder.encode(received);
  const right = textEncoder.encode(expected);
  const subtle = crypto.subtle as CloudflareSubtleCrypto;
  return left.byteLength === right.byteLength && subtle.timingSafeEqual(left, right);
}

export async function readJson<T>(request: Request, maxBytes = 32_768): Promise<T> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > maxBytes) throw new Error("Payload too large");
  const raw = await request.text();
  if (raw.length > maxBytes) throw new Error("Payload too large");
  return JSON.parse(raw) as T;
}

export async function checkRateLimit(request: Request, env: RuntimeEnv, bucket: string, limit = 12): Promise<boolean> {
  const ip = request.headers.get("cf-connecting-ip") ?? "local";
  const windowId = Math.floor(Date.now() / 60_000);
  const key = `rate:${bucket}:${ip}:${windowId}`;
  const count = Number((await env.TOKEN_CACHE.get(key)) ?? "0");
  if (count >= limit) return false;
  await env.TOKEN_CACHE.put(key, String(count + 1), { expirationTtl: 120 });
  return true;
}

/**
 * A second, independent rate-limit dimension keyed by wallet rather than IP.
 * Anti-bot invariant: a single wallet cannot hammer daily-activation, crew
 * upgrade or discovery endpoints just because it rotates source IPs, and a
 * single IP/device cannot be the only signal that gates many wallets either
 * — see checkRateLimit for the IP dimension. Both must pass.
 */
export async function checkWalletRateLimit(
  env: RuntimeEnv,
  wallet: string,
  bucket: string,
  limit: number,
  windowSeconds = 60,
): Promise<boolean> {
  const windowId = Math.floor(Date.now() / (windowSeconds * 1_000));
  const key = `rate:${bucket}:${wallet}:${windowId}`;
  const count = Number((await env.TOKEN_CACHE.get(key)) ?? "0");
  if (count >= limit) return false;
  await env.TOKEN_CACHE.put(key, String(count + 1), { expirationTtl: windowSeconds * 2 });
  return true;
}

/**
 * One rate-limit dimension to check: an already-hashed or opaque key, its budget and the
 * counter-bucket width. Callers pass keys, never raw personal data, so the KV keys this creates
 * stay non-identifying (spec 48, 51, 67).
 */
export interface RateLimitCheck {
  /** "wallet" | "session" | "ip" | "device" | "network" | any custom bucket. */
  dimension: string;
  /** Null when the request carries nothing to key this dimension on (e.g. no device header). */
  key: string | null;
  limit: number;
  windowSeconds: number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  /** Dimension that ran out of budget, for internal metrics only - never returned as-is. */
  exceeded: string | null;
  retryAfterSec: number;
}

function rateKey(dimension: string, key: string, windowSeconds: number): string {
  const windowId = Math.floor(Date.now() / (windowSeconds * 1_000));
  return "rate:" + dimension + ":" + key + ":" + windowId;
}

/**
 * Checks several independent dimensions at once and passes only when all of them have budget.
 * Rate limiting is never IP-only (spec 48): the gate feeds wallet, session, IP, device and
 * network keys in one call, so rotating addresses does not buy a farm extra actions while a
 * shared household IP with a handful of real players stays well inside its budget.
 */
export async function checkKeyedRateLimits(
  env: RuntimeEnv,
  checks: readonly RateLimitCheck[],
): Promise<RateLimitVerdict> {
  const active = checks.filter((check) => check.key !== null && check.key.length > 0 && check.limit > 0);
  if (active.length === 0) return { allowed: true, exceeded: null, retryAfterSec: 0 };
  const counts = await Promise.all(
    active.map(async (check) => {
      const stored = await env.TOKEN_CACHE.get(rateKey(check.dimension, check.key as string, check.windowSeconds));
      const value = Number(stored ?? "0");
      return Number.isFinite(value) && value > 0 ? value : 0;
    }),
  );
  let exceeded: string | null = null;
  let retryAfterSec = 0;
  await Promise.all(
    active.map(async (check, index) => {
      if (counts[index] >= check.limit) {
        if (exceeded === null) {
          exceeded = check.dimension;
          retryAfterSec = check.windowSeconds;
        }
        return;
      }
      const key = rateKey(check.dimension, check.key as string, check.windowSeconds);
      await env.TOKEN_CACHE.put(key, String(counts[index] + 1), {
        expirationTtl: Math.max(120, check.windowSeconds * 2),
      });
    }),
  );
  return { allowed: exceeded === null, exceeded, retryAfterSec: exceeded === null ? 0 : retryAfterSec };
}


export function sessionCookie(session: string): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(session)}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}
