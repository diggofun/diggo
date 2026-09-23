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
}

/** Stops capture now, and silences every event track() would have sent for the rest of the load. */
function disableCapture(): void {
  capture = null;
  analyticsReady = false;
  client?.opt_out_capturing();
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
  if (analyticsReady) capture?.(event, properties);
}
