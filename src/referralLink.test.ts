/**
 * The referral link lifecycle in the browser.
 *
 * The bug these tests pin down: the code used to be read from `window.location.search` at the
 * exact moment the wallet signed in, so any in-app navigation dropped it and a returning player
 * with a live session was never attributed at all.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  REFERRAL_MEMORY_SECONDS,
  captureLandingReferral,
  clearRememberedReferral,
  readRememberedReferral,
  referralCodeFromLocation,
  referralLink,
  rememberReferral,
} from "./referralLink";

const NOW = 1_700_000_000_000;
const STORAGE_KEY = "diggo_ref";

function withStorage(): { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void; removeItem: (key: string) => void } {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

let store: ReturnType<typeof withStorage>;
let location: string;

beforeEach(() => {
  store = withStorage();
  location = "https://diggo.fun/";
  (globalThis as { window?: unknown }).window = {
    localStorage: store,
    location: {
      get href() { return location; },
      set href(value: string) { location = value; },
    },
    history: {
      replaceState: (_state: unknown, _title: string, url: string) => { location = "https://diggo.fun" + url; },
    },
  };
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("reading a referral code from a URL", () => {
  it("accepts both the ?ref= and the /r/ shapes and normalizes them", () => {
    expect(referralCodeFromLocation("https://diggo.fun/?ref=JUREK")).toBe("jurek");
    expect(referralCodeFromLocation("https://diggo.fun/r/jurek")).toBe("jurek");
    expect(referralCodeFromLocation("https://diggo.fun/r/jurek/")).toBe("jurek");
    expect(referralCodeFromLocation("https://diggo.fun/?ref=my_code-1")).toBe("my_code-1");
  });

  it("ignores codes that could never be stored, and non-referral paths", () => {
    expect(referralCodeFromLocation("https://diggo.fun/?ref=no")).toBeNull();
    expect(referralCodeFromLocation("https://diggo.fun/?ref=UPPER CASE")).toBeNull();
    expect(referralCodeFromLocation("https://diggo.fun/?ref=admin")).toBeNull();
    expect(referralCodeFromLocation("https://diggo.fun/r/way-too-long-to-be-a-code")).toBeNull();
    expect(referralCodeFromLocation("https://diggo.fun/explore")).toBeNull();
    expect(referralCodeFromLocation("not a url")).toBeNull();
  });
});

describe("remembering a referral across navigation", () => {
  it("keeps the code after the query string is gone, which is the whole point", () => {
    captureLandingReferral("https://diggo.fun/?ref=jurek");
    // The visitor clicks an in-app link; the code is no longer in the URL but must still be sent.
    expect(readRememberedReferral(NOW)).toBe("jurek");
  });

  it("strips ?ref= from the visible URL while preserving other parameters and the hash", () => {
    captureLandingReferral("https://diggo.fun/?ref=jurek&mint=So111");
    expect(location).toBe("https://diggo.fun/?mint=So111");
    captureLandingReferral("https://diggo.fun/explore?ref=jurek#top");
    expect(location).toBe("https://diggo.fun/explore#top");
  });

  it("sends a /r/ visitor back to the home page after capturing the slug", () => {
    expect(captureLandingReferral("https://diggo.fun/r/jurek")).toBe("https://diggo.fun/r/jurek");
    expect(location).toBe("https://diggo.fun/");
  });

  it("never lets a second link displace the first referrer", () => {
    rememberReferral("first", NOW);
    expect(rememberReferral("second", NOW)).toBeNull();
    expect(readRememberedReferral(NOW)).toBe("first");
  });

  it("expires a remembered code and forgets it on read", () => {
    rememberReferral("jurek", NOW);
    const later = NOW + (REFERRAL_MEMORY_SECONDS + 1) * 1000;
    expect(readRememberedReferral(later)).toBeNull();
    expect(store.getItem(STORAGE_KEY)).toBeNull();
  });

  it("replaces an expired code with a fresh one", () => {
    rememberReferral("old", NOW);
    const later = NOW + (REFERRAL_MEMORY_SECONDS + 1) * 1000;
    expect(rememberReferral("new", later)).toBe("https://diggo.fun/r/new");
    expect(readRememberedReferral(later)).toBe("new");
  });

  it("treats a corrupt stored value as no referral at all", () => {
    store.setItem(STORAGE_KEY, "{not json");
    expect(readRememberedReferral(NOW)).toBeNull();
    store.setItem(STORAGE_KEY, JSON.stringify({ code: 42, expiresAt: NOW + 1 }));
    expect(readRememberedReferral(NOW)).toBeNull();
  });

  it("clears the code once the wallet has signed in", () => {
    rememberReferral("jurek", NOW);
    clearRememberedReferral();
    expect(readRememberedReferral(NOW)).toBeNull();
  });

  it("still returns a usable link when storage refuses to persist", () => {
    const denied = () => { throw new Error("denied"); };
    (globalThis as { window?: { localStorage?: unknown } }).window!.localStorage = {
      getItem: denied,
      setItem: denied,
      removeItem: denied,
    };
    expect(rememberReferral("jurek", NOW)).toBe("https://diggo.fun/r/jurek");
    expect(readRememberedReferral(NOW)).toBeNull();
  });
});

describe("the shareable link", () => {
  it("is the short /r/ path, trimmed and lowercased", () => {
    expect(referralLink("JUREK")).toBe("https://diggo.fun/r/jurek");
    expect(referralLink("  My_Code  ")).toBe("https://diggo.fun/r/my_code");
  });
});
