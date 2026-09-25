/**
 * Reading and remembering the referrer a visitor arrived with.
 *
 * The referral code used to live only in `?ref=` and was read straight off `window.location` at
 * the moment the wallet signed in. That loses the referral in two ordinary situations: a visitor
 * who clicks any in-app link (`/?mint=…`, `/explore`, …) before connecting loses the query string,
 * and a visitor who already holds a valid session cookie never signs in again, so the code is
 * never sent to the Worker at all. Stashing the code on arrival, for a bounded window, fixes both.
 */

import { normalizeReferralCode, validateReferralCode } from "../shared/referral";

const STORAGE_KEY = "diggo_ref";
/** Long enough to cover "landed, browsed for a while, then connected", short enough not to
 *  attribute a visit to somebody who arrived weeks ago. */
export const REFERRAL_MEMORY_DAYS = 30;
const REFERRAL_MEMORY_MS = REFERRAL_MEMORY_DAYS * 24 * 60 * 60 * 1_000;

/** How long a remembered referral stays valid, in seconds. */
export const REFERRAL_MEMORY_SECONDS = Math.floor(REFERRAL_MEMORY_MS / 1_000);

interface StoredReferral {
  code: string;
  /** Epoch milliseconds after which the code is no longer honoured. */
  expiresAt: number;
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * The code carried by a URL, from either supported shape: `?ref=slug` and the short `/r/slug`
 * link. Returns null for anything that is not a well-formed code, so a junk query string is never
 * persisted and later sent to the Worker.
 */
export function referralCodeFromLocation(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const candidate = url.searchParams.get("ref") ?? pathSlug(url.pathname);
  if (!candidate) return null;
  const validation = validateReferralCode(candidate);
  return validation.ok ? validation.code : null;
}

/** `/r/abc123` -> `abc123`. Any other path yields null. */
function pathSlug(pathname: string): string | null {
  const match = pathname.match(/^\/r\/([^/]+)\/?$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return match[1]!;
  }
}

function parse(raw: string | null): StoredReferral | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { code, expiresAt } = value as { code?: unknown; expiresAt?: unknown };
  if (typeof code !== "string" || typeof expiresAt !== "number") return null;
  const validation = validateReferralCode(code);
  return validation.ok ? { code: validation.code, expiresAt } : null;
}

/**
 * Reads the stored value, treating a storage that throws as empty. Privacy modes can refuse
 * getItem as readily as setItem, and losing a referral is better than breaking the page load.
 */
function readStored(): StoredReferral | null {
  const store = storage();
  if (!store) return null;
  try {
    return parse(store.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

/**
 * Remembers a referral code and returns the canonical `/r/` link for it. An already-valid stored
 * code is not overwritten, so a visitor who arrives from a second link keeps their first referrer.
 * Returns null when the code is invalid or already stored.
 */
export function rememberReferral(code: string, now: number = Date.now()): string | null {
  const validation = validateReferralCode(code);
  if (!validation.ok) return null;
  const link = referralLink(validation.code);
  const store = storage();
  if (!store) return link;
  const existing = readStored();
  if (existing && existing.expiresAt > now) return null;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify({ code: validation.code, expiresAt: now + REFERRAL_MEMORY_MS }));
  } catch {
    return link;
  }
  return link;
}

/** The remembered code, or null when absent, malformed or expired. */
export function readRememberedReferral(now: number = Date.now()): string | null {
  const stored = readStored();
  if (!stored) return null;
  if (stored.expiresAt <= now) {
    try {
      storage()?.removeItem(STORAGE_KEY);
    } catch {
      // A storage that refuses to clear simply keeps re-reporting an expired code, which is
      // harmless because the Worker re-validates the code and the window on every use.
    }
    return null;
  }
  return stored.code;
}

/** Drops the remembered referral once the wallet has signed in, so the next visit starts clean. */
export function clearRememberedReferral(): void {
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do: an uncleared code is bounded by its own expiry.
  }
}

/** The shareable link for a code. The short `/r/` path is the one we hand out. */
export function referralLink(code: string): string {
  return `https://diggo.fun/r/${encodeURIComponent(normalizeReferralCode(code))}`;
}

/**
 * Records a freshly-landing referral and strips it from the visible URL, so the visitor's next
 * in-app navigation cannot overwrite or drop the code. The query parameter is removed rather than
 * the whole path: `?mint=` and friends must keep working.
 */
export function captureLandingReferral(href: string = window.location.href): string | null {
  const code = referralCodeFromLocation(href);
  if (!code) return null;
  const link = rememberReferral(code);
  const url = new URL(href);
  url.searchParams.delete("ref");
  const next = url.pathname === "/r/" || /^\/r\/[^/]+\/?$/.test(url.pathname) ? "/" : url.pathname + url.search + url.hash;
  window.history.replaceState(null, "", next);
  return link;
}
