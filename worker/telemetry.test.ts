/**
 * Telemetry tests: the Analytics Engine mirror, webhook alert delivery with its dedupe window, and
 * the Sentry envelope reporter.
 *
 * Everything external is injected (fetch) or faked (TOKEN_CACHE, D1), so these tests never touch
 * the network and assert the exact bytes each integration would receive.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RiskAlert } from "../shared/riskOps";
import type { RuntimeEnv } from "./env";
import { createTestHarness } from "./test/d1-sqlite";
import {
  ALERT_DEDUPE_DEFAULT_SECONDS,
  ALERT_DEDUPE_MAX_SECONDS,
  METRIC,
  alertDedupeSeconds,
  deliverAlerts,
  metric,
  parseSentryDsn,
  reportError,
} from "./telemetry";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function firedAlert(overrides: Partial<RiskAlert> = {}): RiskAlert {
  return {
    name: "reserve_drain_velocity",
    metric: "reserveDrainVelocityUsdPerHour",
    severity: "critical",
    threshold: 30,
    floor: 1,
    value: 42,
    metricValue: 42,
    observedAt: 1_700_000_000,
    ...overrides,
  };
}

interface RecordedCall {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly rawBody: string;
}

/** A fetch double that records every call and answers with one canned response. */
function recordingFetch(response: Response = new Response("ok", { status: 200 })) {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      rawBody: String(init?.body ?? ""),
    });
    return response;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("metric", () => {
  it("writes the D1 counter and mirrors it into Analytics Engine", async () => {
    const harness = createTestHarness();
    const points: unknown[] = [];
    const env = {
      ...harness.env,
      DIGGO_METRICS: { writeDataPoint: (point: unknown) => points.push(point) },
    } as unknown as RuntimeEnv;

    await metric(env, METRIC.rateLimitHit, 3, { dimension: "ip" });

    const row = harness.db
      .prepare("SELECT value, tags FROM metrics_counters WHERE name = ?")
      .get(METRIC.rateLimitHit) as { value: number; tags: string };
    expect(row.value).toBe(3);
    expect(row.tags).toBe("dimension=ip");
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({
      indexes: [METRIC.rateLimitHit],
      doubles: [3],
      blobs: [METRIC.rateLimitHit, "dimension=ip", expect.any(String)],
    });
  });

  it("keeps counting when the dataset binding is absent", async () => {
    const harness = createTestHarness();

    await metric(harness.env, METRIC.replayAttempt, 1);

    const row = harness.db
      .prepare("SELECT value FROM metrics_counters WHERE name = ?")
      .get(METRIC.replayAttempt) as { value: number };
    expect(row.value).toBe(1);
  });
});

describe("alertDedupeSeconds", () => {
  const env = (value?: string) => ({ ALERT_DEDUPE_SECONDS: value }) as unknown as RuntimeEnv;

  it("falls back to the default for an unset or unparseable value", () => {
    expect(alertDedupeSeconds(env())).toBe(ALERT_DEDUPE_DEFAULT_SECONDS);
    expect(alertDedupeSeconds(env("soon"))).toBe(ALERT_DEDUPE_DEFAULT_SECONDS);
  });

  it("allows disabling dedupe and clamps an absurd window", () => {
    expect(alertDedupeSeconds(env("0"))).toBe(0);
    expect(alertDedupeSeconds(env("120"))).toBe(120);
    expect(alertDedupeSeconds(env("99999999"))).toBe(ALERT_DEDUPE_MAX_SECONDS);
  });
});

describe("deliverAlerts", () => {
  it("sends nothing when no webhook is configured", async () => {
    const harness = createTestHarness();
    const { calls, fetchImpl } = recordingFetch();

    const result = await deliverAlerts(harness.env, [firedAlert()], { fetchImpl });

    expect(result).toEqual({ configured: false, delivered: [], suppressed: [], failed: [] });
    expect(calls).toHaveLength(0);
  });

  it("delivers a Discord/Slack compatible payload", async () => {
    const harness = createTestHarness();
    const { calls, fetchImpl } = recordingFetch();
    const env = {
      ...harness.env,
      ALERT_WEBHOOK_URL: "https://hooks.example/diggo",
      ENVIRONMENT: "staging",
    } as unknown as RuntimeEnv;

    const result = await deliverAlerts(env, [firedAlert()], { fetchImpl });

    expect(result.delivered).toEqual(["reserve_drain_velocity"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://hooks.example/diggo");
    expect(calls[0].headers["content-type"]).toBe("application/json");
    const payload = JSON.parse(calls[0].rawBody) as Record<string, unknown> & { content: string; text: string };
    // Discord reads content, Slack reads text, and both carry the same line.
    expect(payload.content).toBe(payload.text);
    expect(payload.content).toContain("reserve_drain_velocity");
    expect(payload.content).toContain("CRITICAL");
    expect(payload.content).toContain("staging");
    expect(payload.alerts).toEqual([
      {
        name: "reserve_drain_velocity",
        metric: "reserveDrainVelocityUsdPerHour",
        severity: "critical",
        value: 42,
        threshold: 30,
        observedAt: 1_700_000_000,
      },
    ]);
  });

  it("suppresses the same alert name inside the dedupe window", async () => {
    const harness = createTestHarness();
    const { calls, fetchImpl } = recordingFetch();
    const env = {
      ...harness.env,
      ALERT_WEBHOOK_URL: "https://hooks.example/diggo",
      ALERT_DEDUPE_SECONDS: "1800",
    } as unknown as RuntimeEnv;

    const first = await deliverAlerts(env, [firedAlert()], { fetchImpl });
    const repeat = await deliverAlerts(env, [firedAlert()], { fetchImpl });
    const other = await deliverAlerts(env, [firedAlert({ name: "replay_attempts" })], { fetchImpl });

    expect(first.delivered).toEqual(["reserve_drain_velocity"]);
    expect(repeat.delivered).toEqual([]);
    expect(repeat.suppressed).toEqual(["reserve_drain_velocity"]);
    expect(other.delivered).toEqual(["replay_attempts"]);
    expect(calls).toHaveLength(2);
  });

  it("delivers again once the dedupe window has passed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T00:00:00Z"));
    const harness = createTestHarness();
    const { calls, fetchImpl } = recordingFetch();
    const env = {
      ...harness.env,
      ALERT_WEBHOOK_URL: "https://hooks.example/diggo",
      ALERT_DEDUPE_SECONDS: "600",
    } as unknown as RuntimeEnv;

    expect((await deliverAlerts(env, [firedAlert()], { fetchImpl })).delivered).toEqual(["reserve_drain_velocity"]);
    vi.setSystemTime(new Date("2026-09-22T00:05:00Z"));
    expect((await deliverAlerts(env, [firedAlert()], { fetchImpl })).suppressed).toEqual(["reserve_drain_velocity"]);
    vi.setSystemTime(new Date("2026-09-22T00:11:00Z"));
    expect((await deliverAlerts(env, [firedAlert()], { fetchImpl })).delivered).toEqual(["reserve_drain_velocity"]);
    expect(calls).toHaveLength(2);
  });

  it("does not start the dedupe window when the webhook rejects the message", async () => {
    const harness = createTestHarness();
    const failing = recordingFetch(new Response("nope", { status: 500 }));
    const healthy = recordingFetch();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const env = {
      ...harness.env,
      ALERT_WEBHOOK_URL: "https://hooks.example/diggo",
      ALERT_DEDUPE_SECONDS: "1800",
    } as unknown as RuntimeEnv;

    const rejected = await deliverAlerts(env, [firedAlert()], { fetchImpl: failing.fetchImpl });
    const retried = await deliverAlerts(env, [firedAlert()], { fetchImpl: healthy.fetchImpl });

    expect(rejected.failed).toEqual(["reserve_drain_velocity"]);
    expect(rejected.delivered).toEqual([]);
    expect(retried.delivered).toEqual(["reserve_drain_velocity"]);
    expect(errors).toHaveBeenCalled();
  });

  it("caps the number of messages one tick may send", async () => {
    const harness = createTestHarness();
    const { calls, fetchImpl } = recordingFetch();
    const env = {
      ...harness.env,
      ALERT_WEBHOOK_URL: "https://hooks.example/diggo",
    } as unknown as RuntimeEnv;
    const alerts = Array.from({ length: 8 }, (_, index) => firedAlert({ name: "rule_" + index }));

    const result = await deliverAlerts(env, alerts, { fetchImpl, maxMessages: 2 });

    expect(result.delivered).toHaveLength(2);
    expect(calls).toHaveLength(2);
  });
});

describe("parseSentryDsn", () => {
  it("derives the envelope endpoint from the DSN", () => {
    expect(parseSentryDsn("https://abc123@o1.ingest.sentry.io/42")).toEqual({
      endpoint: "https://o1.ingest.sentry.io/api/42/envelope/",
      publicKey: "abc123",
      projectId: "42",
    });
  });

  it("rejects anything without a key or a project id", () => {
    expect(parseSentryDsn(undefined)).toBeNull();
    expect(parseSentryDsn("")).toBeNull();
    expect(parseSentryDsn("not-a-dsn")).toBeNull();
    expect(parseSentryDsn("https://o1.ingest.sentry.io/42")).toBeNull();
    expect(parseSentryDsn("https://abc123@o1.ingest.sentry.io/")).toBeNull();
  });
});

describe("reportError", () => {
  it("does nothing when no DSN is configured", async () => {
    const harness = createTestHarness();
    const { calls, fetchImpl } = recordingFetch();

    await expect(reportError(harness.env, new Error("boom"), {}, { fetchImpl })).resolves.toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("posts a three-line Sentry envelope with the error and its context", async () => {
    const harness = createTestHarness();
    const { calls, fetchImpl } = recordingFetch();
    const env = {
      ...harness.env,
      SENTRY_DSN: "https://abc123@o1.ingest.sentry.io/42",
      ENVIRONMENT: "staging",
    } as unknown as RuntimeEnv;

    const reported = await reportError(
      env,
      new Error("activation failed"),
      { pathname: "/api/mine/activate" },
      { fetchImpl, now: 1_700_000_000 },
    );

    expect(reported).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://o1.ingest.sentry.io/api/42/envelope/");
    expect(calls[0].headers["x-sentry-auth"]).toContain("sentry_key=abc123");
    expect(calls[0].headers["content-type"]).toBe("application/x-sentry-envelope");
    const [envelopeHeader, itemHeader, eventLine] = calls[0].rawBody.trim().split("\n");
    const header = JSON.parse(envelopeHeader) as Record<string, string>;
    expect(header.dsn).toBe("https://abc123@o1.ingest.sentry.io/42");
    expect(header.event_id).toHaveLength(32);
    expect(JSON.parse(itemHeader)).toEqual({ type: "event", content_type: "application/json" });
    const event = JSON.parse(eventLine) as Record<string, unknown>;
    expect(event).toMatchObject({
      level: "error",
      platform: "javascript",
      environment: "staging",
      event_id: header.event_id,
      exception: { values: [{ type: "Error", value: "activation failed" }] },
    });
    expect(event.extra).toMatchObject({ pathname: "/api/mine/activate", stack: expect.any(String) });
  });

  it("returns false when Sentry rejects the envelope", async () => {
    const harness = createTestHarness();
    const { fetchImpl } = recordingFetch(new Response("no", { status: 401 }));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const env = { ...harness.env, SENTRY_DSN: "https://abc123@o1.ingest.sentry.io/42" } as unknown as RuntimeEnv;

    await expect(reportError(env, new Error("boom"), {}, { fetchImpl })).resolves.toBe(false);
    expect(errors).toHaveBeenCalled();
  });
});

