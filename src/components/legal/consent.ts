/**
 * Consent for non-essential storage, kept framework-free so the banner
 * (src/components/ConsentBanner.tsx), the legal pages and the analytics loader (src/analytics.ts)
 * can all read it without importing each other's React tree.
 *
 * Only analytics consent is recordable today. Essential storage - the session cookie, the random
 * anti-abuse device id (src/device.ts) and the record of this very choice - is not gated on this
 * banner; it is disclosed in the Cookie & Storage Notice. See docs/SECURITY.md for why the device
 * id exists at all (spec 50).
 */

export type ConsentDecision = "essential" | "all";

export interface ConsentRecord {
  readonly version: number;
  readonly decision: ConsentDecision;
  /** Unix milliseconds, so the record itself can be shown to the player. */
  readonly decidedAt: number;
}

export const CONSENT_STORAGE_KEY = "diggo.consent.v1";
export const CONSENT_VERSION = 1;

/** Fired in this tab whenever a choice is recorded or cleared. */
export const CONSENT_EVENT = "diggo:consent-changed";
/** Fired by the legal pages to ask the banner to open again. */
export const CONSENT_OPEN_EVENT = "diggo:consent-open";

/**
 * localStorage throws in some privacy modes. A session-only fallback keeps the player's choice
 * working for the rest of the page load instead of asking again on every render.
 */
let sessionFallback: ConsentRecord | null = null;

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isDecision(value: unknown): value is ConsentDecision {
  return value === "essential" || value === "all";
}

export function readConsent(): ConsentRecord | null {
  let raw: string | null;
  try {
    raw = storage()?.getItem(CONSENT_STORAGE_KEY) ?? null;
  } catch {
    return sessionFallback;
  }
  if (raw === null) return sessionFallback;
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; decision?: unknown; decidedAt?: unknown };
    // A record from an older wording of the banner is not consent to the new one.
    if (parsed.version !== CONSENT_VERSION || !isDecision(parsed.decision)) return null;
    const decidedAt = typeof parsed.decidedAt === "number" && Number.isFinite(parsed.decidedAt)
      ? parsed.decidedAt
      : 0;
    return { version: CONSENT_VERSION, decision: parsed.decision, decidedAt };
  } catch {
    return null;
  }
}

/** True only for the decision that permits optional analytics. Absent consent is not consent. */
export function hasAnalyticsConsent(): boolean {
  return readConsent()?.decision === "all";
}

export function recordConsent(decision: ConsentDecision): ConsentRecord {
  const record: ConsentRecord = { version: CONSENT_VERSION, decision, decidedAt: Date.now() };
  sessionFallback = record;
  try {
    storage()?.setItem(CONSENT_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // The choice still applies to this page load through sessionFallback.
  }
  try {
    window.dispatchEvent(new CustomEvent<ConsentRecord>(CONSENT_EVENT, { detail: record }));
  } catch {
    // No window (a test or a non-browser render): the stored record is still the source of truth.
  }
  return record;
}

/** Clears the choice, so the banner asks again. Analytics must stop on the next page load. */
export function clearConsent(): void {
  sessionFallback = null;
  try {
    storage()?.removeItem(CONSENT_STORAGE_KEY);
  } catch {
    // Nothing was stored.
  }
  try {
    window.dispatchEvent(new CustomEvent<ConsentRecord | null>(CONSENT_EVENT, { detail: null }));
  } catch {
    // Nothing to notify.
  }
}

/**
 * Calls back on every consent change in this tab and in other tabs. Returns an unsubscribe
 * function, which is what a React effect has to hand back.
 */
export function subscribeConsent(listener: (record: ConsentRecord | null) => void): () => void {
  const local = () => listener(readConsent());
  const crossTab = (event: StorageEvent) => {
    if (event.key === null || event.key === CONSENT_STORAGE_KEY) listener(readConsent());
  };
  window.addEventListener(CONSENT_EVENT, local);
  window.addEventListener("storage", crossTab);
  return () => {
    window.removeEventListener(CONSENT_EVENT, local);
    window.removeEventListener("storage", crossTab);
  };
}

/** Asks the banner to open again, so a choice can be changed from the legal pages. */
export function requestConsentBanner(): void {
  try {
    window.dispatchEvent(new Event(CONSENT_OPEN_EVENT));
  } catch {
    // No window: nothing to open.
  }
}
