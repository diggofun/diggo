/**
 * Rate limiting tests (worker/http.ts).
 *
 * The limiter has two layers - the Rate Limiting binding (strongly consistent, present in
 * production) and the KV counters (exact per-action budgets, always present) - and these tests pin
 * down how they combine and what happens when the binding is missing or broken.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "./env";
import { checkKeyedRateLimits, type RateLimitCheck } from "./http";
import { createTestHarness } from "./test/d1-sqlite";

afterEach(() => {
  vi.restoreAllMocks();
});

function ipCheck(limit = 2): RateLimitCheck[] {
  return [{ dimension: "ip", key: "203.0.113.9", limit, windowSeconds: 60 }];
}

function envWithLimiter(limit: (options: { key: string }) => Promise<{ success: boolean }>): RuntimeEnv {
  return { ...createTestHarness().env, RATE_LIMITER: { limit } } as unknown as RuntimeEnv;
}

describe("checkKeyedRateLimits", () => {
  it("enforces the per-dimension budget from the KV counters when no binding is present", async () => {
    const harness = createTestHarness();

    expect(await checkKeyedRateLimits(harness.env, ipCheck())).toMatchObject({ allowed: true, exceeded: null });
    expect(await checkKeyedRateLimits(harness.env, ipCheck())).toMatchObject({ allowed: true });
    expect(await checkKeyedRateLimits(harness.env, ipCheck())).toMatchObject({
      allowed: false,
      exceeded: "ip",
      retryAfterSec: 60,
    });
  });

  it("refuses as soon as the binding says no, before touching the counters", async () => {
    const keys: string[] = [];
    const env = envWithLimiter(async (options) => {
      keys.push(options.key);
      return { success: false };
    });

    const verdict = await checkKeyedRateLimits(env, [
      { dimension: "wallet", key: "wallet-a", limit: 100, windowSeconds: 300 },
    ]);

    expect(verdict).toMatchObject({ allowed: false, exceeded: "wallet", retryAfterSec: 300 });
    expect(keys).toEqual(["rl:wallet:wallet-a"]);
  });

  it("still applies the KV budget when the binding allows the request", async () => {
    const env = envWithLimiter(async () => ({ success: true }));

    expect(await checkKeyedRateLimits(env, ipCheck(1))).toMatchObject({ allowed: true });
    expect(await checkKeyedRateLimits(env, ipCheck(1))).toMatchObject({ allowed: false, exceeded: "ip" });
  });

  it("falls back to the KV counters when the binding itself fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = envWithLimiter(async () => {
      throw new Error("rate limiter unavailable");
    });

    expect(await checkKeyedRateLimits(env, ipCheck())).toMatchObject({ allowed: true });
    expect(warn).toHaveBeenCalled();
  });
});

