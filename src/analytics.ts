import { hasAnalyticsConsent, subscribeConsent } from "./components/legal/consent";

/**
 * Product analytics (PostHog), gated on consent.
 *
 * Analytics is optional storage: nothing is imported from PostHog, and no event leaves the page,
 * until the player chose "Allow analytics" in the consent banner (src/components/legal/consent.ts).
 * A choice made after the config arrives starts it immediately, and every later change is followed:
 * withdrawing consent stops capture in the same page load as well as silencing every event track()
 * would have sent, and granting it again after a withdrawal switches capture back on, because the
 * client is already loaded and posthog's opt-out lasts for the rest of the session.
 */

interface AnalyticsConfig {
  posthogApiKey?: string;
  posthogHost?: string;
}

/** The slice of the PostHog client this module uses, so the import stays lazy and typed. */
interface AnalyticsClient {
  capture(event: string, properties: Record<string, string | number | boolean>): void;
  opt_in_capturing(): void;
  opt_out_capturing(): void;
}

let analyticsReady = false;
let analyticsStart: Promise<void> | null = null;
let capture: ((event: string, properties: Record<string, string | number | boolean>) => void) | null = null;
let client: AnalyticsClient | null = null;
let pendingConfig: AnalyticsConfig | null = null;
let consentWatch: (() => void) | null = null;
const trackedOnce = new Set<string>();
const pendingOnceEvents = new Map<string, { event: string; properties: Record<string, string | number | boolean> }>();
const pendingEvents: Array<{ event: string; properties: Record<string, string | number | boolean> }> = [];
const pendingLaunchSuccesses: Array<{ event: string; properties: Record<string, string | number | boolean> }> = [];
const suppressedEvents = new Set(["launch_submitted"]);
const sensitiveProperty = /(?:address|wallet|mint|signature|amount|referral_?code|email|name)/i;

function safeProperties(properties: Record<string, string | number | boolean>): Record<string, string | number | boolean> {
  return Object.fromEntries(Object.entries(properties).filter(([key]) => !sensitiveProperty.test(key)));
}

/**
 * Turns capture on for a client that is already loaded. Opting out is sticky inside posthog for the
 * rest of the session, so a re-grant has to call opt_in_capturing() again rather than only setting
 * the flag this module reads: otherwise the events would be handed to a client that drops them.
 */
function enableCapture(instance: AnalyticsClient): void {
  instance.opt_in_capturing();
  client = instance;
  capture = (event, properties) => instance.capture(event, properties);
  analyticsReady = true;
  for (const pending of pendingEvents.splice(0)) {
    capture(pending.event, pending.properties);
  }
}

/** Stops capture now, and silences every event track() would have sent for the rest of the load. */
function disableCapture(): void {
  capture = null;
  analyticsReady = false;
  // An event that was waiting for a client must not suddenly be sent after a later opt-in: the
  // action happened before the new consent decision and would otherwise be reported out of time.
  pendingEvents.length = 0;
  pendingOnceEvents.clear();
  pendingLaunchSuccesses.length = 0;
  client?.opt_out_capturing();
}

/** Sends only after consent, either immediately or into the already-consented startup window. */
function dispatch(event: string, properties: Record<string, string | number | boolean>): void {
  if (suppressedEvents.has(event) || !hasAnalyticsConsent()) return;
  const safe = safeProperties(properties);
  if (analyticsReady) {
    capture?.(event, safe);
    return;
  }
  if (pendingConfig && pendingEvents.length < 20) {
    pendingEvents.push({ event, properties: safe });
  }
}

/**
 * Moves observations that were eligible for this still-mounted view into the consent decision that
 * just allowed them. Keys already recorded stay recorded; cleared keys can be registered again by
 * the same view if it observes the state again.
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
  // The config is remembered and the consent watcher is always armed, not only on the path where no
  // decision exists yet: a player who withdraws after a decision made at load must be followed too.
  pendingConfig = config;
  watchForConsent();
  flushPendingOnceEvents();
  if (!hasAnalyticsConsent()) {
    // Remembered, not loaded: even the import("posthog-js") waits for the decision.
    return Promise.resolve();
  }
  if (analyticsStart) {
    // Already imported in this page load: a re-grant only needs capture turned back on.
    if (client) enableCapture(client);
    return analyticsStart;
  }
  analyticsStart = import("posthog-js").then(({ default: posthog }) => {
    posthog.init(config.posthogApiKey!, {
      api_host: config.posthogHost!,
      autocapture: false,
      capture_pageview: true,
      capture_pageleave: true,
      disable_session_recording: true,
      disable_surveys: true,
    });
    const instance = posthog as unknown as AnalyticsClient;
    client = instance;
    // The decision can be withdrawn while the import is still in flight.
    if (hasAnalyticsConsent()) enableCapture(instance);
    else disableCapture();
  });
  return analyticsStart;
}

export function track(event: string, properties: Record<string, string | number | boolean> = {}): void {
  if (event === "launch_succeeded" && hasAnalyticsConsent()) {
    // onLaunched() reports every completed registration, including recovery. Hold success for one
    // turn so the recovery branch can add its segment without relying on event order or a timeout.
    const safe = safeProperties(properties);
    const pending = { event, properties: safe };
    pendingLaunchSuccesses.push(pending);
    queueMicrotask(() => {
      const index = pendingLaunchSuccesses.indexOf(pending);
      if (index < 0) return;
      pendingLaunchSuccesses.splice(index, 1);
      dispatch(event, safe);
    });
    return;
  }

  if (event === "launch_recovered") {
    const network = String(properties.network ?? "");
    for (let index = pendingLaunchSuccesses.length - 1; index >= 0; index -= 1) {
      if (String(pendingLaunchSuccesses[index].properties.network ?? "") === network) {
        const [succeeded] = pendingLaunchSuccesses.splice(index, 1);
        dispatch(succeeded.event, succeeded.properties);
        break;
      }
    }
  }
  dispatch(event, properties);
}

function onceKey(event: string, properties: Record<string, string | number | boolean>): string {
  return `${event}:${JSON.stringify(safeProperties(properties))}`;
}

function cancelPendingOnce(key: string, pending: { event: string; properties: Record<string, string | number | boolean> }): void {
  if (pendingOnceEvents.get(key) === pending) pendingOnceEvents.delete(key);
}

/**
 * Captures a current-view observation at most once. Before consent the observation is held only in
 * memory and the returned cleanup removes it when this view unmounts. Denial clears every held
 * observation, so a later re-grant cannot replay an event the player did not allow.
 */
export function trackOnce(
  event: string,
  properties: Record<string, string | number | boolean> = {},
): () => void {
  if (suppressedEvents.has(event)) return () => {};
  const key = onceKey(event, properties);
  if (trackedOnce.has(key)) return () => {};
  if (hasAnalyticsConsent()) {
    trackedOnce.add(key);
    track(event, safeProperties(properties));
    return () => {};
  }
  if (pendingOnceEvents.has(key)) return () => {};
  const pending = { event, properties: safeProperties(properties) };
  pendingOnceEvents.set(key, pending);
  return () => cancelPendingOnce(key, pending);
}
