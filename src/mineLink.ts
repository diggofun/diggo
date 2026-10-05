/**
 * Mine links: diggo.fun/m/<mint>. Opening one sends the visitor's crew to that mine.
 *
 * The mint is remembered in this browser until the visitor is signed in, then handed to the Worker
 * (POST /api/game/mine { mint }), which keeps assigning that mine while it can be dug.
 */

const KEY = "diggo:pending-mine-link";
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function mineLink(mint: string): string {
  return `https://diggo.fun/m/${encodeURIComponent(mint)}`;
}

export function mineFromLocation(href: string): string | null {
  try {
    const match = new URL(href).pathname.match(/^\/m\/([^/]+)\/?$/);
    const mint = match ? decodeURIComponent(match[1]!) : "";
    return MINT.test(mint) ? mint : null;
  } catch {
    return null;
  }
}

export function rememberMine(mint: string): void {
  if (!MINT.test(mint)) return;
  try {
    localStorage.setItem(KEY, mint);
  } catch {
    // Private mode: the link still works for this page view through the returned mint.
  }
}

export function pendingMine(): string | null {
  try {
    const mint = localStorage.getItem(KEY);
    return mint && MINT.test(mint) ? mint : null;
  } catch {
    return null;
  }
}

export function clearPendingMine(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing stored.
  }
}

/**
 * On a /m/<mint> landing: remember the mint and show the mine page instead, keeping any query
 * (?ref=, utm_*) for the captures that run after this one.
 */
export function captureMineLink(href: string = window.location.href): string | null {
  const mint = mineFromLocation(href);
  if (!mint) return null;
  rememberMine(mint);
  const url = new URL(href);
  window.history.replaceState(null, "", "/mine" + url.search + url.hash);
  return mint;
}
