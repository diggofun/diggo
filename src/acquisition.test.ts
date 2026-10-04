import { beforeEach, describe, expect, it, vi } from "vitest";

const NOW = 1_800_000_000_000;
let values: Map<string, string>;

async function load() {
  const acquisition = await import("./acquisition");
  const consent = await import("./components/legal/consent");
  return { ...acquisition, ...consent };
}

beforeEach(() => {
  vi.resetModules();
  values = new Map();
  vi.stubGlobal("window", {
    location: { href: "https://diggo.fun/" },
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    },
  });
  vi.stubGlobal("document", { referrer: "" });
});

describe("campaign source detection", () => {
  it.each([
    ["tiktok", "tiktok"], ["TikTok", "tiktok"], ["twitter", "x"], ["X", "x"],
    ["youtube", "youtube"], ["yt", "youtube"], ["ig", "instagram"], ["fb", "facebook"],
    ["newsletter", "newsletter"],
  ])("normalizes UTM source %s to %s", async (input, source) => {
    const { parseAcquisition } = await load();
    expect(parseAcquisition("https://diggo.fun/?utm_source=" + input + "&utm_medium=paid_social&utmcampaign=ignored").source).toBe(source);
  });

  it.each([
    ["https://www.tiktok.com/@diggo", "tiktok"], ["https://t.co/abc", "x"],
    ["https://m.youtube.com/watch?v=abc", "youtube"], ["https://l.instagram.com/", "instagram"],
    ["https://www.google.pl/search?q=diggo", "google"], ["https://example.org/page", "example.org"],
    ["https://x.com.evil.org/", "x.com.evil.org"],
  ])("recognizes external referring domain %s", async (referrer, source) => {
    const { parseAcquisition } = await load();
    expect(parseAcquisition("https://diggo.fun/", referrer).source).toBe(source);
  });

  it.each([["ttclid", "tiktok"], ["twclid", "x"], ["gclid", "google"], ["wbraid", "google"]])(
    "infers paid traffic from %s without copying the ad identifier", async (key, source) => {
      const { parseAcquisition } = await load();
      const touch = parseAcquisition(`https://diggo.fun/?${key}=private-ad-identifier`);
      expect(touch).toMatchObject({ source, paid: true });
      expect(JSON.stringify(touch)).not.toContain("private-ad-identifier");
    },
  );

  it("gives UTM source priority and does not treat every Facebook click as paid", async () => {
    const { parseAcquisition } = await load();
    expect(parseAcquisition("https://diggo.fun/?utm_source=youtube&utm_medium=social&ttclid=abc", "https://t.co/")).toMatchObject({ source: "youtube", medium: "social", paid: false });
    expect(parseAcquisition("https://diggo.fun/?fbclid=abc", "https://instagram.com/")).toMatchObject({ source: "instagram", paid: false });
  });

  it("treats internal navigation as direct and reads referral links separately", async () => {
    const { parseAcquisition } = await load();
    expect(parseAcquisition("https://diggo.fun/mine", "https://diggo.fun/")).toMatchObject({ source: "direct", referringDomain: "" });
    expect(parseAcquisition("https://diggo.fun/r/player?utm_source=tiktok").source).toBe("tiktok");
    expect(parseAcquisition("https://diggo.fun/r/player").source).toBe("referral");
  });

  it("rejects email addresses, URLs and oversized campaign labels", async () => {
    const { parseAcquisition } = await load();
    expect(parseAcquisition("https://diggo.fun/?utm_campaign=a%40b.com&utm_content=https%3A%2F%2Fprivate.example&email=private")).toMatchObject({ campaign: "", content: "" });
    expect(parseAcquisition("https://diggo.fun/?utm_campaign=" + "a".repeat(121)).campaign).toBe("");
  });
});

describe("consented acquisition persistence", () => {
  it("keeps the landing only in memory before consent, including when a referral URL is stripped", async () => {
    const { captureAcquisition, acquisitionProperties, recordConsent, ACQUISITION_STORAGE_KEY } = await load();
    captureAcquisition("https://diggo.fun/r/player?utm_source=tiktok&utm_medium=paid_social&utm_campaign=launch_october");
    expect(acquisitionProperties(NOW)).toEqual({});
    expect(values.has(ACQUISITION_STORAGE_KEY)).toBe(false);
    window.location.href = "https://diggo.fun/";
    recordConsent("all");
    expect(acquisitionProperties(NOW)).toMatchObject({ traffic_source: "tiktok", traffic_paid: true, traffic_campaign: "launch_october" });
    expect(values.has(ACQUISITION_STORAGE_KEY)).toBe(true);
  });

  it("preserves a source through navigation and distinguishes first from latest campaign", async () => {
    const { captureAcquisition, acquisitionProperties, recordConsent } = await load();
    recordConsent("all");
    captureAcquisition("https://diggo.fun/?utm_source=tiktok&utm_campaign=launch_a");
    expect(acquisitionProperties(NOW).traffic_campaign).toBe("launch_a");
    captureAcquisition("https://diggo.fun/mine", "https://diggo.fun/");
    expect(acquisitionProperties(NOW + 1).traffic_source).toBe("tiktok");
    captureAcquisition("https://diggo.fun/?utm_source=twitter&utm_campaign=launch_b");
    expect(acquisitionProperties(NOW + 2)).toMatchObject({ traffic_source: "x", traffic_campaign: "launch_b", first_traffic_source: "tiktok", first_traffic_campaign: "launch_a" });
    captureAcquisition("https://diggo.fun/crew");
    expect(acquisitionProperties(NOW + 3).traffic_source).toBe("x");
  });

  it("forgets old attribution after 30 days", async () => {
    const { captureAcquisition, acquisitionProperties, recordConsent } = await load();
    recordConsent("all");
    captureAcquisition("https://diggo.fun/?utm_source=tiktok");
    acquisitionProperties(NOW);
    captureAcquisition("https://diggo.fun/");
    expect(acquisitionProperties(NOW + 30 * 86_400_000)).toMatchObject({ traffic_source: "direct", first_traffic_source: "direct" });
  });

  it("uses this visit when storage is blocked or corrupted", async () => {
    const { captureAcquisition, acquisitionProperties, recordConsent, ACQUISITION_STORAGE_KEY } = await load();
    recordConsent("all");
    values.set(ACQUISITION_STORAGE_KEY, "invalid JSON");
    captureAcquisition("https://diggo.fun/?utm_source=youtube");
    expect(acquisitionProperties(NOW).traffic_source).toBe("youtube");
    window.localStorage.setItem = () => { throw new Error("blocked"); };
    captureAcquisition("https://diggo.fun/?utm_source=tiktok");
    expect(acquisitionProperties(NOW).traffic_source).toBe("tiktok");
  });
});
