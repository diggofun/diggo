/**
 * The consent gate on PostHog, plus the privacy boundary on what an event may carry.
 *
 * Nothing may load or send before "Allow analytics"; "Essential only" or a withdrawal must opt the
 * client out and stop replay in the same page load; a re-grant must switch capture back on, because
 * posthog's opt-out is sticky for the session. The modules are re-imported per test
 * (vi.resetModules) because both keep their state in module scope.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const posthog = vi.hoisted(() => ({
  init: vi.fn(),
  capture: vi.fn(),
  identify: vi.fn(),
  reset: vi.fn(),
  opt_in_capturing: vi.fn(),
  opt_out_capturing: vi.fn(),
  startSessionRecording: vi.fn(),
  stopSessionRecording: vi.fn(),
}));

vi.mock("posthog-js", () => ({ default: posthog }));

const CONFIG = { posthogApiKey: "phc_test", posthogHost: "/ph" };
const MINT = "12cens35GKeZH8is6R1gdbJ1faktyLrXgHvHyBB6veb7";
const WALLET = "H5TTpszeSNneNNxypM3UjaWMjVRNTvmWSCXfgXtzdELT";

/** A page-load scope for consent.ts: window.localStorage plus the events it dispatches. */
function installWindow(): void {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const entries = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => void entries.set(key, value),
    removeItem: (key: string) => void entries.delete(key),
    clear: () => entries.clear(),
    key: (index: number) => [...entries.keys()][index] ?? null,
    get length() {
      return entries.size;
    },
  };
  const win = {
    localStorage,
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners.get(type)?.delete(listener);
    },
    dispatchEvent: (event: { type: string }) => {
      for (const listener of listeners.get(event.type) ?? []) listener(event);
      return true;
    },
  };
  globalThis.window = win as unknown as Window & typeof globalThis;
}

async function load() {
  const consent = await import("./components/legal/consent");
  const analytics = await import("./analytics");
  return { consent, ...analytics };
}

describe("analytics consent gate", () => {
  beforeEach(() => {
    installWindow();
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("loads nothing and captures nothing before a decision", async () => {
    const { startAnalytics, track, identifyWallet } = await load();
    await startAnalytics(CONFIG);
    track("wallet_signed_in");
    identifyWallet(WALLET);

    expect(posthog.init).not.toHaveBeenCalled();
    expect(posthog.capture).not.toHaveBeenCalled();
    expect(posthog.identify).not.toHaveBeenCalled();
  });

  it("loads nothing and captures nothing after 'Essential only'", async () => {
    const { consent, startAnalytics, track } = await load();
    consent.recordConsent("essential");
    await startAnalytics(CONFIG);
    track("launch_started");

    expect(posthog.init).not.toHaveBeenCalled();
    expect(posthog.capture).not.toHaveBeenCalled();
  });

  it("initialises the EU proxy client with SPA pageviews, masked replay and identified-only profiles", async () => {
    const { consent, startAnalytics } = await load();
    consent.recordConsent("all");
    await startAnalytics(CONFIG);

    expect(posthog.init).toHaveBeenCalledTimes(1);
    expect(posthog.init).toHaveBeenCalledWith("phc_test", expect.objectContaining({
      api_host: "/ph",
      ui_host: "https://eu.posthog.com",
      capture_pageview: "history_change",
      capture_pageleave: true,
      person_profiles: "identified_only",
      session_recording: expect.objectContaining({ maskAllInputs: true }),
    }));
    expect(posthog.opt_in_capturing).toHaveBeenCalledTimes(1);
  });

  it("starts when analytics is allowed after the config arrived", async () => {
    const { consent, startAnalytics, track } = await load();
    await startAnalytics(CONFIG);
    expect(posthog.init).not.toHaveBeenCalled();

    consent.recordConsent("all");
    await vi.waitFor(() => expect(posthog.opt_in_capturing).toHaveBeenCalledTimes(1));
    track("alerts_enabled");

    expect(posthog.capture).toHaveBeenCalledWith("alerts_enabled", {});
  });

  it("opts out and stops replay on withdrawal, then re-opts-in on a re-grant", async () => {
    const { consent, startAnalytics, track } = await load();
    consent.recordConsent("all");
    await startAnalytics(CONFIG);
    track("alerts_enabled");
    expect(posthog.capture).toHaveBeenCalledWith("alerts_enabled", {});

    consent.recordConsent("essential");
    track("alerts_disabled");
    expect(posthog.opt_out_capturing).toHaveBeenCalledTimes(1);
    expect(posthog.stopSessionRecording).toHaveBeenCalledTimes(1);
    expect(posthog.capture).not.toHaveBeenCalledWith("alerts_disabled", {});

    consent.recordConsent("all");
    await vi.waitFor(() => expect(posthog.opt_in_capturing).toHaveBeenCalledTimes(2));
    track("referral_link_copied");
    expect(posthog.startSessionRecording).toHaveBeenCalledTimes(1);
    expect(posthog.capture).toHaveBeenCalledWith("referral_link_copied", {});
    expect(posthog.init).toHaveBeenCalledTimes(1);
  });

  it("stops capture when consent is cleared from the legal pages", async () => {
    const { consent, startAnalytics, track } = await load();
    consent.recordConsent("all");
    await startAnalytics(CONFIG);
    consent.clearConsent();
    track("launch_started");

    expect(posthog.opt_out_capturing).toHaveBeenCalledTimes(1);
    expect(posthog.capture).not.toHaveBeenCalled();
  });

  it("does not flush an event queued during startup once consent is withdrawn", async () => {
    const { consent, startAnalytics, track } = await load();
    consent.recordConsent("all");
    const started = startAnalytics(CONFIG);
    track("launch_started");
    consent.recordConsent("essential");
    await started;

    expect(posthog.capture).not.toHaveBeenCalled();
  });

  it("flushes a consented startup event once the client finishes loading", async () => {
    const { consent, startAnalytics, track } = await load();
    consent.recordConsent("all");
    const started = startAnalytics(CONFIG);
    track("launch_started");
    expect(posthog.capture).not.toHaveBeenCalled();
    await started;

    expect(posthog.capture).toHaveBeenCalledWith("launch_started", {});
  });

  it("is a no-op when the deployment has no analytics configured", async () => {
    const { consent, startAnalytics, track } = await load();
    consent.recordConsent("all");
    await startAnalytics({});
    track("launch_started");

    expect(posthog.init).not.toHaveBeenCalled();
    expect(posthog.capture).not.toHaveBeenCalled();
  });

  it("records a view observed before consent once consent is granted, and not after it unmounted", async () => {
    const { consent, startAnalytics, trackOnce } = await load();
    await startAnalytics(CONFIG);
    trackOnce("trade_diggo_viewed");
    const endView = trackOnce("coin_viewed", { mint: MINT, is_official_diggo: true });
    endView();

    consent.recordConsent("all");
    await vi.waitFor(() => expect(posthog.capture).toHaveBeenCalledTimes(1));
    trackOnce("trade_diggo_viewed");

    expect(posthog.capture).toHaveBeenCalledTimes(1);
    expect(posthog.capture).toHaveBeenCalledWith("trade_diggo_viewed", {});
  });

  it("identifies the signed-in wallet only after consent and resets it on logout", async () => {
    const { consent, startAnalytics, identifyWallet, resetAnalyticsIdentity } = await load();
    await startAnalytics(CONFIG);
    identifyWallet(WALLET);
    expect(posthog.identify).not.toHaveBeenCalled();

    consent.recordConsent("all");
    await vi.waitFor(() => expect(posthog.identify).toHaveBeenCalledWith(WALLET));
    identifyWallet(WALLET);
    expect(posthog.identify).toHaveBeenCalledTimes(1);

    resetAnalyticsIdentity();
    expect(posthog.reset).toHaveBeenCalledTimes(1);
    resetAnalyticsIdentity();
    expect(posthog.reset).toHaveBeenCalledTimes(1);
  });
});

describe("analytics privacy boundary", () => {
  beforeEach(() => {
    installWindow();
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("sends only allowlisted properties", async () => {
    const { consent, startAnalytics, track } = await load();
    consent.recordConsent("all");
    await startAnalytics(CONFIG);
    track("swap_submitted", {
      side: "buy",
      mint: MINT,
      amount_sol: 0.5,
      ...({ signature: "5igSig", privateKey: "secret", email: "a@b.c", transaction: "AQID" } as object),
    });

    expect(posthog.capture).toHaveBeenCalledWith("swap_submitted", { side: "buy", mint: MINT, amount_sol: 0.5 });
  });

  it("turns failures into short reasons without addresses or signatures", async () => {
    const { failureReason } = await load();
    expect(failureReason(new Error("User rejected the request."))).toBe("user_rejected");
    const reason = failureReason(new Error("Program failed for account " + WALLET + " with custom error 6042"));
    expect(reason).not.toContain(WALLET);
    expect(reason.length).toBeLessThanOrEqual(80);
  });
});
