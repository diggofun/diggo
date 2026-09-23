/**
 * Per-browser device hint sent as the X-Diggo-Device header (see worker/signals.ts, which hashes
 * it before storage).
 *
 * This is deliberately the smallest thing that works: a random 128-bit value generated in the
 * browser and remembered in localStorage. There is no canvas/WebGL/audio fingerprinting, no
 * cross-site identifier, no third-party script, and nothing derived from the machine or the
 * wallet — a player who clears storage gets a fresh id, and one browser may legitimately hold
 * several wallets. The Worker treats it as a hint that groups accounts for the risk score, never
 * as an identity and never as the sole reason for a restriction (spec 50).
 */

export const DEVICE_HEADER = "X-Diggo-Device";

const STORAGE_KEY = "diggo.device.v1";

let cached: string | null = null;

function randomDeviceId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** localStorage throws in some privacy modes; a page-scoped id still beats sending nothing. */
function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The stable id for this browser, created on first use. */
export function deviceId(): string {
  if (cached) return cached;
  const store = storage();
  try {
    const stored = store?.getItem(STORAGE_KEY);
    if (stored && stored.length >= 16) {
      cached = stored;
      return cached;
    }
  } catch {
    // Fall through and mint a new id for this page load.
  }
  cached = randomDeviceId();
  try {
    store?.setItem(STORAGE_KEY, cached);
  } catch {
    // Not persisting is acceptable: the id stays valid for this page load.
  }
  return cached;
}

/** Forgets this browser's id and returns the replacement. */
export function resetDeviceId(): string {
  cached = null;
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to remove.
  }
  return deviceId();
}
