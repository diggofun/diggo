interface AnalyticsConfig {
  posthogApiKey?: string;
  posthogHost?: string;
}

let analyticsReady = false;
let analyticsStart: Promise<void> | null = null;
let capture: ((event: string, properties: Record<string, string | number | boolean>) => void) | null = null;

export function startAnalytics(config: AnalyticsConfig): Promise<void> {
  if (analyticsStart || !config.posthogApiKey || !config.posthogHost) {
    return analyticsStart ?? Promise.resolve();
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
    capture = (event, properties) => posthog.capture(event, properties);
    analyticsReady = true;
  });
  return analyticsStart;
}

export function track(event: string, properties: Record<string, string | number | boolean> = {}): void {
  if (analyticsReady) capture?.(event, properties);
}
