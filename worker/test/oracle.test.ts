/**
 * W-ORACLE: the price oracle (spec 25-27, 54).
 *
 * Every test here is about one of the ways a discovery valuation can go wrong: a source that
 * disagrees with the others, evidence that is too old, a quote with no history behind it, or an
 * aggregator that stops answering. In each case the oracle's answer must be "no price", because a
 * wrong price here becomes real tokens handed to a player from a mine's Discovery Reserve.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ORACLE_QUOTE_CACHE_PREFIX,
  WRAPPED_SOL_MINT,
  getRobustPrice,
  getSolUsd,
  readJupiterPrice,
  refreshExternalQuotes,
} from "../oracle";
import { ORACLE_LIMITS } from "../oracle";
import { DIGGO_CONFIG } from "../../shared/config";
import type { RuntimeEnv } from "../env";
import {
  countWhere,
  createOracleHarness,
  mockFetch,
  readValue,
  seedCachedQuote,
  seedSample,
  seedSolUsd,
  seedToken,
  seedTrade,
  type OracleTestHarness,
} from "./oracle-d1";

const NOW_MS = 1_800_000_123_000;
const NOW = Math.floor(NOW_MS / 1_000);
const MINT = "HeaLthyMint1111111111111111111111111111111";
const OTHER_MINT = "SecondMint11111111111111111111111111111111";
const JUPITER_V3 = "price/v3";

let harness: OracleTestHarness;
let env: RuntimeEnv;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW_MS));
  harness = createOracleHarness();
  env = harness.env;
});

afterEach(() => {
  harness.close();
  vi.useRealTimers();
});

/** Three fresh, agreeing observations: the minimum a token needs to be valued at all. */
function seedHealthyHistory(mint = MINT, priceUsd = 0.01): void {
  seedToken(env, mint, "MINING_ACTIVE");
  for (const secondsAgo of [120, 180, 240]) {
    seedSample(env, mint, priceUsd, NOW - secondsAgo);
  }
}

function metricCount(name: string, tag?: string): number {
  const clause = tag ? " AND tags LIKE '%" + tag + "%'" : "";
  return countWhere(
    env,
    "SELECT COUNT(*) AS total FROM metrics_counters WHERE name = '" + name + "'" + clause,
  );
}

describe("combining sources (spec 27)", () => {
  it("takes its bounds from the central config", () => {
    // The oracle reads DIGGO_CONFIG.oracle and re-exports it as ORACLE_LIMITS, so one config
    // object still describes the whole deployment.
    expect(ORACLE_LIMITS).toBe(DIGGO_CONFIG.oracle);
  });

  it("takes the weighted median across the internal history and an external quote", async () => {
    seedHealthyHistory();
    seedCachedQuote(env, MINT, "jupiter", 0.0102, NOW - 60);

    const quote = await getRobustPrice(env, MINT, { now: NOW, useCache: false });
    expect(quote).not.toBeNull();
    // The internal history carries 3x1000 of volume against the quote's unweighted 1, so the median
    // stays on the history rather than being dragged by a source with no traded value behind it.
    expect(quote!.priceUsd).toBeCloseTo(0.01, 10);
    expect(quote!.sources).toEqual(expect.arrayContaining(["internal", "jupiter"]));
    expect(quote!.sourceCount).toBe(2);
    // 0.0102 against 0.01 is 200 bps, inside the 1500 bps band, so this is a usable price with a
    // confidence below 1 rather than a refusal.
    expect(quote!.maxDeviationBps).toBeCloseTo(200, 6);
    expect(quote!.confidence).toBeGreaterThan(0.6);
    expect(quote!.confidence).toBeLessThan(1);
    expect(quote!.cached).toBe(false);
  });

  it("uses the recorded trades as a source, but not a single print", async () => {
    seedHealthyHistory();
    for (const secondsAgo of [500, 400, 300]) {
      seedTrade(env, MINT, 0.0101, 1_000, NOW - secondsAgo);
    }
    const quote = await getRobustPrice(env, MINT, { now: NOW, useCache: false });
    expect(quote!.sources).toContain("trade-twap");

    // One trade is not a series: a wash trade must not become a price source.
    seedHealthyHistory(OTHER_MINT);
    seedTrade(env, OTHER_MINT, 0.02, 1_000, NOW - 60);
    const thin = await getRobustPrice(env, OTHER_MINT, { now: NOW, useCache: false });
    expect(thin!.sources).not.toContain("trade-twap");
    expect(thin!.priceUsd).toBeCloseTo(0.01, 10);
  });

  it("prefers the oracle SOL rate when one is reachable", async () => {
    seedHealthyHistory();
    seedSolUsd(env, "pyth-sol", 150.5, NOW - 10);

    const quote = await getRobustPrice(env, MINT, { now: NOW, useCache: false });
    expect(quote!.solUsd).toBeCloseTo(150.5, 6);
    expect(quote!.solUsdSource).toBe("pyth-sol");
  });
});

describe("refusals (spec 25, 27)", () => {
  it("refuses a price when the sources disagree beyond the deviation band", async () => {
    seedHealthyHistory();
    // A 5x quote on the same mint is exactly the manipulation the band exists to catch.
    seedCachedQuote(env, MINT, "jupiter", 0.05, NOW - 60);

    expect(await getRobustPrice(env, MINT, { now: NOW, useCache: false })).toBeNull();
    expect(metricCount("oracle.quote_unavailable")).toBeGreaterThan(0);
  });

  it("refuses a price whose only evidence is older than the staleness limit", async () => {
    seedToken(env, MINT, "MINING_ACTIVE");
    for (const secondsAgo of [1_000, 1_100, 1_200]) {
      seedSample(env, MINT, 0.01, NOW - secondsAgo);
    }
    // Inside robustPrice's 3600s lookback but past the 900s staleness limit: too old to price a payout.
    expect(await getRobustPrice(env, MINT, { now: NOW, useCache: false })).toBeNull();
    expect(metricCount("oracle.quote_unavailable", "stale_history")).toBeGreaterThan(0);

    // With the limit relaxed the same evidence is usable, which proves staleness is what refused it.
    const relaxed = await getRobustPrice(env, MINT, {
      now: NOW,
      useCache: false,
      rules: { maxStalenessSeconds: 3_600 },
    });
    expect(relaxed).not.toBeNull();
    expect(relaxed!.priceUsd).toBeCloseTo(0.01, 10);
  });

  it("refuses a price when the combined confidence is below the minimum", async () => {
    seedToken(env, MINT, "MINING_ACTIVE");
    // Near the edge of the deviation band, so the sources agree only just: high deviation means low
    // confidence, and a low-confidence price must not decide a real payout.
    for (const priceUsd of [1, 1, 1.14]) {
      seedSample(env, MINT, priceUsd, NOW - 60);
    }
    expect(await getRobustPrice(env, MINT, { now: NOW, useCache: false })).toBeNull();

    const tolerated = await getRobustPrice(env, MINT, {
      now: NOW,
      useCache: false,
      rules: { minimumConfidence: 0.001 },
    });
    expect(tolerated).not.toBeNull();
  });

  it("refuses a fresh external quote that has no history behind it", async () => {
    seedToken(env, MINT, "MINING_ACTIVE");
    seedCachedQuote(env, MINT, "jupiter", 0.01, NOW - 30);

    // One aggregator price on a pool we know nothing about is not evidence of what a discovery is
    // worth, so no valuation is produced no matter how fresh the quote is.
    expect(await getRobustPrice(env, MINT, { now: NOW, useCache: false })).toBeNull();
    expect(metricCount("oracle.quote_unavailable", "no_internal_history")).toBeGreaterThan(0);
  });

  it("honours a minimum external source requirement", async () => {
    const strict = createOracleHarness({ vars: { ORACLE_MIN_EXTERNAL_SOURCES: "1" } });
    try {
      seedToken(strict.env, MINT, "MINING_ACTIVE");
      for (const secondsAgo of [120, 180, 240]) {
        seedSample(strict.env, MINT, 0.01, NOW - secondsAgo);
      }
      expect(await getRobustPrice(strict.env, MINT, { now: NOW, useCache: false })).toBeNull();

      seedCachedQuote(strict.env, MINT, "jupiter", 0.0101, NOW - 60);
      const quote = await getRobustPrice(strict.env, MINT, { now: NOW, useCache: false });
      expect(quote).not.toBeNull();
      expect(quote!.sources).toContain("jupiter");
    } finally {
      strict.close();
    }
  });

  it("does not cache a refusal, so better evidence is used as soon as it exists", async () => {
    seedToken(env, MINT, "MINING_ACTIVE");
    seedSample(env, MINT, 0.01, NOW - 120);
    seedSample(env, MINT, 0.01, NOW - 180);
    expect(await getRobustPrice(env, MINT, { now: NOW })).toBeNull();

    seedSample(env, MINT, 0.01, NOW - 240);
    const quote = await getRobustPrice(env, MINT, { now: NOW });
    expect(quote).not.toBeNull();
    expect(quote!.priceUsd).toBeCloseTo(0.01, 10);
  });
});

describe("external sources", () => {
  it("reads Jupiter v3 through the injected fetch, caches it, and reuses the cache", async () => {
    seedHealthyHistory();
    const remote = mockFetch((url) =>
      url.includes(JUPITER_V3) ? { [MINT]: { usdPrice: 0.0101, decimals: 6 } } : {},
    );

    const first = await getRobustPrice(env, MINT, { now: NOW, fetch: remote.fetch });
    expect(first!.sources).toContain("jupiter");
    expect(remote.mintRequests(MINT)).toBe(1);
    expect(remote.urls[0]).toContain("ids=" + MINT);
    // The observation is stored per source, which is what a later request reads after a restart.
    expect(
      readValue<number>(
        env,
        "SELECT price_usd FROM oracle_price_cache WHERE mint = '" + MINT + "' AND source = 'jupiter'",
        "price_usd",
      ),
    ).toBeCloseTo(0.0101, 10);

    // Second read inside the TTL: served from KV, no second call to the aggregator.
    const second = await getRobustPrice(env, MINT, { now: NOW });
    expect(second!.cached).toBe(true);
    expect(second!.priceUsd).toBeCloseTo(first!.priceUsd, 12);
    expect(remote.mintRequests(MINT)).toBe(1);

    // Bypassing the KV cache still does not re-fetch, because the stored observation is inside the
    // external refresh window: the aggregator is asked at most once per window per mint.
    const third = await getRobustPrice(env, MINT, { now: NOW, useCache: false, fetch: remote.fetch });
    expect(third!.sources).toContain("jupiter");
    expect(remote.mintRequests(MINT)).toBe(1);
  });

  it("falls back to the legacy Jupiter v2 endpoint when v3 has no price", async () => {
    seedHealthyHistory();
    const remote = mockFetch((url) => {
      if (url.includes("price/v2")) return { data: { [MINT]: { id: MINT, price: "0.0103" } } };
      return {};
    });

    const quote = await getRobustPrice(env, MINT, { now: NOW, fetch: remote.fetch });
    expect(quote!.sources).toContain("jupiter");
    expect(quote!.priceUsd).toBeCloseTo(0.01, 10);
    expect(remote.urls.filter((url) => url.includes(MINT)).length).toBe(2);
    expect(remote.urls.some((url) => url.includes("price/v2"))).toBe(true);
    expect(
      readValue<number>(
        env,
        "SELECT price_usd FROM oracle_price_cache WHERE mint = '" + MINT + "' AND source = 'jupiter'",
        "price_usd",
      ),
    ).toBeCloseTo(0.0103, 10);
  });

  it("never asks an aggregator about a mine that has not graduated", async () => {
    seedToken(env, MINT, "LAUNCHING");
    const remote = mockFetch(() => ({}));

    const result = await refreshExternalQuotes(env, MINT, { now: NOW, fetch: remote.fetch });
    expect(result.graduated).toBe(false);
    expect(result.stored).not.toContain("jupiter");
    // A bonding-curve-only mine has no DEX market to quote, so no token request is made at all.
    expect(remote.mintRequests(MINT)).toBe(0);
  });

  it("survives an aggregator failure without failing the caller", async () => {
    seedHealthyHistory();
    const remote = mockFetch((url) => {
      if (url.includes(JUPITER_V3)) return new Response("upstream down", { status: 502 });
      return {};
    });

    const result = await refreshExternalQuotes(env, MINT, { now: NOW, fetch: remote.fetch });
    expect(result.failed.some((entry) => entry.source === "jupiter")).toBe(true);
    // The internal history still values the token: one dead third party is not an outage.
    const quote = await getRobustPrice(env, MINT, { now: NOW, useCache: false });
    expect(quote).not.toBeNull();
    expect(quote!.sources).toEqual(["internal"]);
    // ... and the failed source is reported rather than silently dropped.
    const withFetch = await getRobustPrice(env, MINT, { now: NOW, useCache: false, fetch: remote.fetch });
    expect(withFetch!.unavailable.some((entry) => entry.source === "jupiter")).toBe(true);
  });
});

describe("SOL/USD (spec 27)", () => {
  it("reads Pyth Hermes and Jupiter and takes the median of the two", async () => {
    const remote = mockFetch((url) => {
      if (url.includes("hermes.pyth.network")) {
        return { parsed: [{ price: { price: "15012345678", expo: -8, publish_time: NOW - 5 } }] };
      }
      if (url.includes(WRAPPED_SOL_MINT)) return { [WRAPPED_SOL_MINT]: { usdPrice: 150.2 } };
      return {};
    });

    const sol = await getSolUsd(env, { now: NOW, fetch: remote.fetch });
    expect(sol.fromOracle).toBe(true);
    expect(sol.source).toBe("median");
    expect(sol.priceUsd).toBeCloseTo(150.12345678, 6);
    expect(sol.sources.map((entry) => entry.source).sort()).toEqual(["jupiter-sol", "pyth-sol"]);
    expect(sol.confidence).toBeGreaterThan(0.9);

    // The same rate is what a discovery valuation reports, so a SOL-denominated sample is converted
    // at a real rate rather than at the illustrative constant.
    seedHealthyHistory();
    const quote = await getRobustPrice(env, MINT, { now: NOW, useCache: false });
    expect(quote!.solUsd).toBeCloseTo(150.12345678, 6);
    expect(quote!.solUsdSource).toBe("median");
  });

  it("labels the illustrative rate as a fallback instead of claiming it is an oracle", async () => {
    const sol = await getSolUsd(env, { now: NOW });
    expect(sol.priceUsd).toBe(150);
    expect(sol.source).toBe("illustrative-devnet-fallback");
    expect(sol.fromOracle).toBe(false);
    expect(sol.confidence).toBeLessThan(0.5);
    expect(sol.stale).toBe(true);
  });

  it("honours an explicit operator override", async () => {
    const overridden = createOracleHarness({ vars: { ORACLE_SOL_USD_OVERRIDE: "200" } });
    try {
      const sol = await getSolUsd(overridden.env, { now: NOW });
      expect(sol.priceUsd).toBe(200);
      expect(sol.source).toBe("config-override");
      expect(sol.fromOracle).toBe(true);
    } finally {
      overridden.close();
    }
  });
});

describe("response parsing", () => {
  it("accepts every Jupiter response shape and rejects everything else", () => {
    expect(readJupiterPrice({ [MINT]: { usdPrice: 1.5 } }, MINT)).toBe(1.5);
    expect(readJupiterPrice({ data: { [MINT]: { price: "2.5" } } }, MINT)).toBe(2.5);
    expect(readJupiterPrice({ [MINT]: 3 }, MINT)).toBe(3);
    expect(readJupiterPrice({ data: { [MINT]: { priceUsd: 4 } } }, MINT)).toBe(4);

    expect(readJupiterPrice({ [MINT]: { price: "abc" } }, MINT)).toBeNull();
    expect(readJupiterPrice({ [MINT]: { usdPrice: 0 } }, MINT)).toBeNull();
    expect(readJupiterPrice({ [MINT]: { usdPrice: -1 } }, MINT)).toBeNull();
    expect(readJupiterPrice({}, MINT)).toBeNull();
    expect(readJupiterPrice(null, MINT)).toBeNull();
    expect(readJupiterPrice("nope", MINT)).toBeNull();
    expect(readJupiterPrice({ other: { usdPrice: 5 } }, MINT)).toBeNull();
  });

  it("writes nothing and reads nothing without a fetch implementation", async () => {
    seedHealthyHistory();
    const result = await refreshExternalQuotes(env, MINT, { now: NOW, fetch: null });
    expect(result.stored).toEqual([]);
    expect(result.failed).toEqual([]);
    // The roll path never supplies a fetch, so this is the production read path for a player request.
    expect(await env.TOKEN_CACHE.get(ORACLE_QUOTE_CACHE_PREFIX + MINT)).toBeNull();
    const quote = await getRobustPrice(env, MINT, { now: NOW });
    expect(quote!.sources).toEqual(["internal"]);
    expect(quote!.cached).toBe(false);
  });
});
