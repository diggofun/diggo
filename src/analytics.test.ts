/**
 * Regression tests for the consent gate on PostHog capture.
 *
 * The bug these cover: startAnalytics() cached its import promise, and the only consent
 * subscription was created on the "no decision yet" path. So a player who withdrew consent and then
 * allowed analytics again in the same page load kept a loaded-but-opted-out client: every later
 * track() was dropped, and nothing ever called opt_in_capturing() a second time. Withdrawing consent
 * after a decision had been made at load was not followed at all.
 *
 * The modules are re-imported per test (vi.resetModules) because both keep their state in module
 * scope, which is exactly the state that made this bug live for the rest of the page load.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const posthog = vi.hoisted(() => ({
  init: vi.fn(),
  capture: vi.fn(),
  opt_in_capturing: vi.fn(),
  opt_out_capturing: vi.fn(),
}));

vi.mock("posthog-js", () => ({ default: posthog }));

const CONFIG = { posthogApiKey: "ph-key", posthogHost: "https://us.i.posthog.com" };

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

async function loadConsent() {
  return await import("./components/legal/consent");
}

async function loadAnalytics() {
  return await import("./analytics");
}

describe("analytics consent", () => {
  beforeEach(() => {
    installWindow();
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("does not load the client while the config arrives without a decision", async () => {
    const { startAnalytics, track } = await loadAnalytics();
    await startAnalytics(CONFIG);
    track("before_any_decision");
    expect(posthog.init).not.toHaveBeenCalled();
    expect(posthog.capture).not.toHaveBeenCalled();
  });

  it("re-opts-in when analytics is allowed again after a withdrawal", async () => {
    const consent = await loadConsent();
    const { startAnalytics, track } = await loadAnalytics();
    consent.recordConsent("all");
    await startAnalytics(CONFIG);
    track("before_withdrawal");
    expect(posthog.capture).toHaveBeenCalledWith("before_withdrawal", {});

    consent.recordConsent("essential");
    track("while_withdrawn");
    expect(posthog.capture).not.toHaveBeenCalledWith("while_withdrawn", {});
    expect(posthog.opt_out_capturing).toHaveBeenCalledTimes(1);

    consent.recordConsent("all");
    track("after_regrant");
    expect(posthog.capture).toHaveBeenCalledWith("after_regrant", {});
    expect(posthog.opt_in_capturing).toHaveBeenCalledTimes(2);
    expect(posthog.init).toHaveBeenCalledTimes(1);
  });

  it("re-opts-in when the decision was made after the config arrived", async () => {
    const consent = await loadConsent();
    const { startAnalytics, track } = await loadAnalytics();
    await startAnalytics(CONFIG);

    consent.recordConsent("all");
    // The decision starts the import asynchronously; wait for the client to be opted in.
    await vi.waitFor(() => expect(posthog.opt_in_capturing).toHaveBeenCalledTimes(1));
    track("after_decision");
    expect(posthog.capture).toHaveBeenCalledWith("after_decision", {});

    consent.recordConsent("essential");
    track("while_withdrawn");
    expect(posthog.capture).not.toHaveBeenCalledWith("while_withdrawn", {});

    consent.recordConsent("all");
    track("after_regrant");
    expect(posthog.capture).toHaveBeenCalledWith("after_regrant", {});
    expect(posthog.opt_in_capturing).toHaveBeenCalledTimes(2);
    expect(posthog.init).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when the deployment has no analytics configured", async () => {
    const consent = await loadConsent();
    const { startAnalytics, track } = await loadAnalytics();
    consent.recordConsent("all");
    await startAnalytics({});
    track("never_sent");
    expect(posthog.capture).not.toHaveBeenCalled();
  });
});
