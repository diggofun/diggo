/**
 * The legal routes and their paths, in a module with no document text in it.
 *
 * App.tsx imports only this (and lazy-loads the page itself), so the legal copy is a separate
 * chunk and the router does not have to change for a new document.
 */

export type LegalDocId = "terms" | "privacy" | "risk" | "cookies";

export interface LegalRouteDefinition {
  readonly id: LegalDocId;
  readonly path: string;
  readonly title: string;
  /** Short label for the cross-links at the foot of each document. */
  readonly short: string;
}

export const LEGAL_ROUTES: readonly LegalRouteDefinition[] = Object.freeze([
  { id: "terms", path: "/terms", title: "Terms of Service", short: "Terms" },
  { id: "privacy", path: "/privacy", title: "Privacy Policy", short: "Privacy" },
  { id: "risk", path: "/risk", title: "Risk Disclosure", short: "Risk" },
  { id: "cookies", path: "/cookies", title: "Cookie & Storage Notice", short: "Cookies" },
]);

export function legalDocId(pathname: string): LegalDocId | null {
  // A trailing slash is the same document: the asset layer may serve /terms or /terms/ for the
  // same SPA shell, and the two must not disagree about what the page is.
  const normalized = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  const match = LEGAL_ROUTES.find((route) => route.path === normalized);
  return match ? match.id : null;
}

export function isLegalPath(pathname: string): boolean {
  return legalDocId(pathname) !== null;
}
