import { hasAnalyticsConsent, subscribeConsent } from "./components/legal/consent";
import { acquisitionProperties, clearAcquisition } from "./acquisition";

/**
 * Product analytics (PostHog EU), gated on consent.
 *
 * Nothing is imported from PostHog, and no request leaves the page, until the player chose
 * "Allow analytics" in the consent banner (src/components/legal/consent.ts). A choice made after
 * the config arrives starts it immediately and every later change is followed: "Essential only" or
 * a withdrawal opts the client out and stops session replay in the same page load, and granting it
 * again switches capture back on, because posthog's opt-out lasts for the rest of the session.
 *
 * The SDK talks to the Worker's first-party proxy (api_host "/ph", worker/posthogProxy.ts), so the
 * site's CSP stays 'self'-only. The event set below is closed: track() only accepts these names,
 * and only the allowlisted property keys ever reach PostHog. The one identity ever sent is a
 * signed-in wallet's public key, via identifyWallet(); never a signature, key, email or payload.
 */

export interface AnalyticsConfig {
  posthogApiKey?: string;
  posthogHost?: string;
}

export const POSTHOG_UI_HOST = "https://eu.posthog.com";

type Side = "buy" | "sell";

/** Every product event Diggo sends, with the properties each one may carry. */
export interface AnalyticsEvents {
  wallet_connect_clicked: { location: string };
  wallet_connected: { wallet_name: string };
  wallet_signed_in: Record<string, never>;
  crew_activate_clicked: Record<string, never>;
  crew_activated: { tier?: number };
  crew_activation_failed: { reason: string };
  rewards_claim_clicked: Record<string, never>;
  rewards_claimed: { coins_count: number };
  rewards_claim_failed: { reason: string };
  discovery_revealed: { rarity?: string; token_symbol?: string };
  upgrade_purchased: { item: string; level?: number; ore_cost?: number };
  swap_quote_requested: { side: Side; mint: string; is_official_diggo: boolean };
  swap_submitted: { side: Side; mint: string; amount_sol?: number };
  swap_confirmed: { side: Side; mint: string; amount_sol?: number };
  swap_failed: { side: Side; mint: string; reason: string };
  launch_started: Record<string, never>;
  launch_image_uploaded: Record<string, never>;
  launch_form_submitted: Record<string, never>;
  launch_confirmed: { mint: string };
  launch_failed: { reason: string };
  referral_landing: { ref_code: string };
  referral_link_copied: Record<string, never>;
  referral_link_customized: Record<string, never>;
  share_card_shared: { target: "x" | "copy"; location: string };
  mine_link_shared: { mint: string; location: string; target: "x" };
  mine_link_copied: { mint: string; location: string };
  mine_link_applied: { mint: string; location?: string };
  mine_boosted: { mint: string; tier: string };
  coin_sold: { mint: string };
  referral_signup: { ref_code: string };
  alerts_enabled: Record<string, never>;
  alerts_disabled: Record<string, never>;
  watchlist_added: { mint: string };
  watchlist_removed: { mint: string };
  coin_viewed: { mint: string; is_official_diggo: boolean };
  trade_diggo_viewed: Record<string, never>;
  platform_fees_claimed: { amount_sol?: number };
  x_link_clicked: { location: string };
}

export type AnalyticsEvent = keyof AnalyticsEvents;
type PropertyValue = string | number | boolean;
type Properties = Record<string, PropertyValue>;

/** The only property keys that may leave the page. Anything else is dropped before capture. */
const ALLOWED_PROPERTIES = new Set([
  "location",
  "wallet_name",
  "tier",
  "reason",
  "coins_count",
  "rarity",
  "token_symbol",
  "item",
  "level",
  "ore_cost",
  "side",
  "mint",
  "is_official_diggo",
  "amount_sol",
  "ref_code",
]);
const MAX_STRING = 120;
const BASE58_RUN = /[1-9A-HJ-NP-Za-km-z]{32,}/g;

/** The slice of the PostHog client this module uses, so the import stays lazy and typed. */
interface AnalyticsClient {
  capture(event: string, properties: Properties): void;
  identify(distinctId: string): void;
  reset(): void;
  opt_in_capturing(): void;
  opt_out_capturing(): void;
  startSessionRecording(): void;
  stopSessionRecording(): void;
}

let analyticsReady = false;
let analyticsStart: Promise<void> | null = null;
let client: AnalyticsClient | null = null;
let pendingConfig: AnalyticsConfig | null = null;
let consentWatch: (() => void) | null = null;
let recordingStopped = false;
/** The signed-in wallet the page wants identified, and the one PostHog currently holds. */
let wantedIdentity: string | null = null;
let appliedIdentity: string | null = null;
const trackedOnce = new Set<string>();
const pendingOnceEvents = new Map<string, { event: string; properties: Properties }>();
const pendingEvents: Array<{ event: string; properties: Properties }> = [];

export function safeProperties(properties: Record<string, unknown> = {}): Properties {
  const safe: Properties = {};
  for (const [key, value] of Object.entries(properties)) {
    if (!ALLOWED_PROPERTIES.has(key) || value === undefined || value === null) continue;
    if (typeof value === "number") {
      if (Number.isFinite(value)) safe[key] = value;
    } else if (typeof value === "boolean") {
      safe[key] = value;
    } else if (typeof value === "string") {
      safe[key] = value.slice(0, MAX_STRING);
    }
  }
  return safe;
}

/**
 * A short, payload-free reason for a failed action. Wallet and RPC errors can quote addresses,
 * signatures or serialized transactions, so long base58 runs are redacted and the text is capped.
 */
export function failureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const text = message.toLowerCase();
  if (/reject|denied|declin|cancel/.test(text)) return "user_rejected";
  if (/insufficient|not enough|0x1\b/.test(text)) return "insufficient_funds";
  if (/slippage|0x1771|minimum amount/.test(text)) return "slippage";
  if (/blockhash|expired|timeout|timed out/.test(text)) return "timeout";
  if (/failed to fetch|network|unreachable|unavailable/.test(text)) return "network";
  if (/sign in|authenticat|session/.test(text)) return "not_signed_in";
  const scrubbed = message.replace(BASE58_RUN, "[redacted]").replace(/\s+/g, " ").trim();
  return scrubbed ? scrubbed.slice(0, 80) : "unknown";
}

function applyIdentity(instance: AnalyticsClient): void {
  if (wantedIdentity && wantedIdentity !== appliedIdentity) {
    instance.identify(wantedIdentity);
    appliedIdentity = wantedIdentity;
  }
}

/**
 * Turns capture on for a client that is already loaded. Opting out is sticky inside posthog for the
 * rest of the session, so a re-grant has to call opt_in_capturing() again rather than only setting
 * the flag this module reads: otherwise the events would be handed to a client that drops them.
 */
function enableCapture(instance: AnalyticsClient): void {
  instance.opt_in_capturing();
  if (recordingStopped) {
    instance.startSessionRecording();
    recordingStopped = false;
  }
  client = instance;
  analyticsReady = true;
  applyIdentity(instance);
  for (const pending of pendingEvents.splice(0)) instance.capture(pending.event, pending.properties);
}

/** Stops capture and replay now, and silences every event track() would have sent. */
function disableCapture(): void {
  analyticsReady = false;
  clearAcquisition();
  // An event that was waiting for a client must not suddenly be sent after a later opt-in: the
  // action happened before the new consent decision and would otherwise be reported out of time.
  pendingEvents.length = 0;
  pendingOnceEvents.clear();
  if (client) {
    client.stopSessionRecording();
    recordingStopped = true;
    client.opt_out_capturing();
  }
}

function dispatch(event: string, properties: Properties): void {
  if (!hasAnalyticsConsent()) return;
  const attributed = { ...properties, ...acquisitionProperties() };
  if (analyticsReady && client) {
    client.capture(event, attributed);
    return;
  }
  if (pendingConfig && pendingEvents.length < 20) pendingEvents.push({ event, properties: attributed });
}

/**
 * Moves observations that were eligible for this still-mounted view into the consent decision that
 * just allowed them. Keys already recorded stay recorded.
 */
function flushPendingOnceEvents(): void {
  if (!hasAnalyticsConsent()) return;
  for (const [key, pending] of pendingOnceEvents) {
    pendingOnceEvents.delete(key);
    trackedOnce.add(key);
    dispatch(pending.event, pending.properties);
  }
}

/** Follows the consent decision that lets analytics load, and every change after it. */
function watchForConsent(): void {
  if (consentWatch) return;
  consentWatch = subscribeConsent((record) => {
    if (record?.decision === "all") {
      // A re-grant in the same page load must not be a no-op: the client is not imported twice, so
      // startAnalytics() returning the cached promise still has to switch capture back on.
      if (pendingConfig) void startAnalytics(pendingConfig);
      else if (client) enableCapture(client);
      flushPendingOnceEvents();
      return;
    }
    disableCapture();
  });
}

export function startAnalytics(config: AnalyticsConfig): Promise<void> {
  if (!config.posthogApiKey || !config.posthogHost) return Promise.resolve();
  pendingConfig = config;
  watchForConsent();
  flushPendingOnceEvents();
  if (!hasAnalyticsConsent()) {
    // Remembered, not loaded: even the import("posthog-js") waits for the decision.
    return Promise.resolve();
  }
  if (analyticsStart) {
    if (client) enableCapture(client);
    return analyticsStart;
  }
  analyticsStart = import("posthog-js").then(({ default: posthog }) => {
    posthog.init(config.posthogApiKey!, {
      api_host: config.posthogHost!,
      ui_host: POSTHOG_UI_HOST,
      person_profiles: "identified_only",
      capture_pageview: "history_change",
      capture_pageleave: true,
      autocapture: false,
      disable_surveys: true,
      disable_session_recording: false,
      session_recording: { maskAllInputs: true },
      before_send: (event) => {
        if (!event || !hasAnalyticsConsent()) return null;
        // Includes automatic pageviews, so the first funnel step has the same source as actions.
        event.properties = { ...event.properties, ...acquisitionProperties() };
        return event;
      },
    });
    const instance = posthog as unknown as AnalyticsClient;
    client = instance;
    // The decision can be withdrawn while the import is still in flight.
    if (hasAnalyticsConsent()) enableCapture(instance);
    else disableCapture();
  });
  return analyticsStart;
}

/** Captures one product event. A no-op without analytics consent. */
export function track<E extends AnalyticsEvent>(event: E, properties?: AnalyticsEvents[E]): void {
  dispatch(event, safeProperties(properties as Record<string, unknown> | undefined));
}

function onceKey(event: string, properties: Properties): string {
  return event + ":" + JSON.stringify(properties);
}

/**
 * Captures a current-view observation at most once per page load. Before consent the observation is
 * held only in memory and the returned cleanup removes it when the view unmounts. Denial clears
 * every held observation, so a later re-grant cannot replay an event the player did not allow.
 */
export function trackOnce<E extends AnalyticsEvent>(event: E, properties?: AnalyticsEvents[E]): () => void {
  const safe = safeProperties(properties as Record<string, unknown> | undefined);
  const key = onceKey(event, safe);
  if (trackedOnce.has(key)) return () => {};
  if (hasAnalyticsConsent()) {
    trackedOnce.add(key);
    dispatch(event, safe);
    return () => {};
  }
  if (pendingOnceEvents.has(key)) return () => {};
  const pending = { event, properties: safe };
  pendingOnceEvents.set(key, pending);
  return () => {
    if (pendingOnceEvents.get(key) === pending) pendingOnceEvents.delete(key);
  };
}

/**
 * Ties later events to a signed-in wallet's public key. Remembered in memory until consent, then
 * applied; nothing is sent without it.
 */
export function identifyWallet(walletAddress: string): void {
  wantedIdentity = walletAddress;
  if (analyticsReady && client && hasAnalyticsConsent()) applyIdentity(client);
}

/** Forgets the identified wallet on logout or disconnect, so the next person is anonymous again. */
export function resetAnalyticsIdentity(): void {
  const hadIdentity = wantedIdentity !== null || appliedIdentity !== null;
  wantedIdentity = null;
  if (!hadIdentity) return;
  appliedIdentity = null;
  client?.reset();
}
