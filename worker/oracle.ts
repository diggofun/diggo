/**
 * Price oracle abstraction for discovery valuation (spec 25-27, 54).
 *
 * A discovery hands out real memecoin value, so the USD price it is normalized against must not be
 * something a small pool can move with one swap. `getRobustPrice` therefore combines several
 * independent sources and refuses to answer when they disagree:
 *
 *   * `internal`      - the token's own observed history (token_price_samples, written by the chain
 *                       sync in worker/indexing.ts) reduced by robustPrice's sample, lookback and
 *                       deviation gates. This is the only source whose absence is fatal: without
 *                       history we know nothing about the depth of the market, and one external
 *                       quote on a thin pool is exactly the manipulation we are defending against.
 *   * `trade-twap`    - a volume-weighted average of real recorded trades over the lookback window,
 *                       when there are enough of them to be a series rather than a single print.
 *   * `jupiter`       - Jupiter Price API v3 (lite-api, keyless) for a graduated mint, falling back
 *                       to the legacy v2 endpoint and to the last cached observation when the API is
 *                       unreachable. Both URLs and an optional API key are configurable per
 *                       deployment.
 *   * `pyth-sol`      - Pyth Hermes SOL/USD, which is what converts a bonding-curve SOL price into
 *                       USD. This replaces the hardcoded ILLUSTRATIVE_DEVNET_SOL_USD rate wherever
 *                       the conversion decides a discovery's value; the constant survives only as a
 *                       clearly labelled fallback of last resort with confidence 0.2.
 *
 * Combining is shared/rarity.ts's combinePriceSources: weighted median across sources, a hard
 * staleness limit, a max-deviation gate and a confidence output. All three fail closed - a null
 * return means the roll pays nothing rather than trusting a price we cannot stand behind.
 *
 * Network access is injectable (`options.fetch`). The roll path deliberately does not refresh
 * external quotes inline: cron (worker/index.ts -> refreshOracleQuotes) keeps the cache warm, and a
 * player request must not block on a third-party API. Passing `fetch` is what turns a live refresh
 * on, which is how tests exercise the whole path deterministically and offline.
 */
import {
  combinePriceSources,
  robustPrice,
  sourcePriceRules,
  type CombinedPrice,
  type InternalPriceSource,
  type PriceQuote,
  type PriceSample,
  type SourcePriceRules,
} from "../shared/rarity";
import { DIGGO_CONFIG, type DiggoConfig } from "../shared/config";
import type { OracleBindings, RuntimeEnv } from "./env";
import { metric } from "./telemetry";

/**
 * The last-resort SOL/USD rate, and the only place a hardcoded one still lives.
 *
 * Devnet SOL has no real value, so this is a display convenience rather than a price: it is what
 * `getSolUsd` answers with when no oracle source is reachable, and it is deliberately labelled
 * (`source: "illustrative-devnet-fallback"`, confidence 0.2) so no caller can mistake it for a
 * reading. worker/chain.ts's USD columns are the only consumers; settlement never touches it.
 */
export const ILLUSTRATIVE_DEVNET_SOL_USD = 150;

/** Keyless Jupiter Price API v3. v2 was deprecated in August 2025 but is still served. */
export const JUPITER_PRICE_V3_URL = "https://lite-api.jup.ag/price/v3";
export const JUPITER_PRICE_V2_URL = "https://lite-api.jup.ag/price/v2";
/** Jupiter's own wrapped-SOL mint, used as a second SOL/USD source. */
export const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
/** Pyth Hermes, the HTTP front end of the Pyth network. */
export const PYTH_HERMES_URL = "https://hermes.pyth.network";
/** Crypto.SOL/USD on Pyth. Overridable per deployment (mainnet vs devnet feeds differ). */
export const PYTH_SOL_USD_FEED_ID =
  "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

/** How the roll path and the cron refresher treat freshness, cache and network. */
export interface OracleLimits {
  /** How long a combined quote may be served from KV. */
  quoteTtlSeconds: number;
  /** How long a SOL/USD read may be served from cache. */
  solTtlSeconds: number;
  /** Hard staleness limit for a single source observation. */
  maxStalenessSeconds: number;
  /** Age up to which an observation counts as fully fresh. */
  freshSeconds: number;
  /** Confidence below which no price is returned. */
  minimumConfidence: number;
  /** Default external-source requirement; 0 keeps a credential-less deployment working. */
  minimumExternalSources: number;
  /** Do not re-fetch one mint's external quote more often than this. */
  externalRefreshSeconds: number;
  /** Timeout for one third-party call. */
  fetchTimeoutMs: number;
}

/**
 * The oracle's bounds come from DIGGO_CONFIG (shared/config.ts `oracle`), so every tunable lives in
 * one place and a deployment cannot run an oracle policy that is invisible to the rest of config.
 * Deep-frozen there, which is why this needs no freeze of its own.
 */
export const ORACLE_LIMITS: OracleLimits = DIGGO_CONFIG.oracle;

/** Traded prints required before the trade history counts as a source of its own. */
export const ORACLE_MIN_TRADE_SAMPLES = 3;

export const ORACLE_QUOTE_CACHE_PREFIX = "oracle:v1:quote:";
export const ORACLE_SOL_CACHE_KEY = "oracle:v1:sol-usd";

/**
 * The oracle's vars are declared once in worker/env.ts, so `npm run types` and this module can
 * never disagree about which knobs exist. Re-exported here for callers that already import the
 * oracle's own names.
 */
export type OracleVars = OracleBindings;

export type OracleEnv = RuntimeEnv;

interface ResolvedVars {
  jupiterUrl: string;
  jupiterV2Url: string;
  jupiterApiKey: string | null;
  pythUrl: string;
  pythApiKey: string | null;
  pythSolFeedId: string;
  solUsdOverride: number | null;
  minimumExternalSources: number;
}

function numeric(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function resolveVars(env: RuntimeEnv): ResolvedVars {
  const vars = env;
  const override = numeric(vars.ORACLE_SOL_USD_OVERRIDE);
  const minimum = numeric(vars.ORACLE_MIN_EXTERNAL_SOURCES);
  return {
    jupiterUrl: vars.JUPITER_PRICE_URL?.trim() || JUPITER_PRICE_V3_URL,
    jupiterV2Url: vars.JUPITER_PRICE_V2_URL?.trim() || JUPITER_PRICE_V2_URL,
    jupiterApiKey: vars.JUPITER_API_KEY?.trim() || null,
    pythUrl: (vars.PYTH_HERMES_URL?.trim() || PYTH_HERMES_URL).replace(/[/]+$/, ""),
    pythApiKey: vars.PYTH_API_KEY?.trim() || null,
    pythSolFeedId: vars.PYTH_SOL_USD_FEED_ID?.trim() || PYTH_SOL_USD_FEED_ID,
    solUsdOverride: override !== null && override > 0 ? override : null,
    minimumExternalSources: Math.max(
      0,
      Math.floor(minimum ?? ORACLE_LIMITS.minimumExternalSources),
    ),
  };
}

export interface OracleOptions {
  now?: number;
  /**
   * Injectable fetch. Supplying it enables live refresh; leaving it undefined keeps every read
   * local (D1 + KV only), which is what production does on the roll path.
   */
  fetch?: typeof fetch | null;
  signal?: AbortSignal;
  config?: DiggoConfig;
  /** Skip the KV read (tests that vary price rules between calls). */
  useCache?: boolean;
  /** Override the graduated-token determination instead of reading tokens.status. */
  graduated?: boolean;
  /** Override individual combine rules. */
  rules?: Partial<SourcePriceRules>;
}

export interface OracleSourceRejection {
  source: string;
  reason: string;
}

export interface OracleQuote extends CombinedPrice {
  mint: string;
  /** SOL/USD used to interpret SOL-denominated internal samples. */
  solUsd: number;
  solUsdSource: string;
  /** True when the whole quote came from the KV cache. */
  cached: boolean;
  fetchedAt: number;
  /** External sources that failed to return a usable observation this round. */
  unavailable: readonly OracleSourceRejection[];
}

export interface SolUsdQuote {
  priceUsd: number;
  source: string;
  observedAt: number;
  fetchedAt: number;
  cached: boolean;
  confidence: number;
  stale: boolean;
  /**
   * True when the value came from a real oracle (or an explicit operator override) rather than the
   * illustrative fallback. Callers converting a SOL price into USD for discovery valuation must
   * check this before preferring the oracle rate over the indexed token price.
   */
  fromOracle: boolean;
  sources: readonly { source: string; priceUsd: number; observedAt: number }[];
}

// --- internal evidence ----------------------------------------------------------------------------

/**
 * The token's observed price history, oldest first. Written by the chain sync after every
 * successful read (see recordPriceSample in worker/discovery.ts), so these are real observations
 * rather than one cached spot value a small pool could move.
 */
export async function internalPriceSamples(
  env: RuntimeEnv,
  mint: string,
  now: number,
  config: DiggoConfig = DIGGO_CONFIG,
): Promise<PriceSample[]> {
  const result = await env.DB.prepare(
    `SELECT price_usd, volume_usd, observed_at FROM token_price_samples
       WHERE mint = ?1 AND observed_at >= ?2
      ORDER BY observed_at ASC
      LIMIT 500`,
  )
    .bind(mint, now - config.rarity.robustPrice.lookbackSeconds)
    .all<{ price_usd: number; volume_usd: number; observed_at: number }>();
  return (result.results ?? []).map((row) => ({
    priceUsd: row.price_usd,
    volumeUsd: row.volume_usd,
    timestamp: row.observed_at,
  }));
}

async function internalSource(
  env: RuntimeEnv,
  mint: string,
  now: number,
  config: DiggoConfig,
): Promise<InternalPriceSource | null> {
  const samples = await internalPriceSamples(env, mint, now, config);
  const price = robustPrice(samples, now, config);
  if (!price) return null;
  let observedAt = 0;
  let weightUsd = 0;
  for (const sample of samples) {
    if (sample.timestamp > observedAt) observedAt = sample.timestamp;
    weightUsd += typeof sample.volumeUsd === "number" && sample.volumeUsd > 0 ? sample.volumeUsd : 0;
  }
  return { price, observedAt, weightUsd: weightUsd > 0 ? weightUsd : undefined };
}

interface TradeTwapRow {
  vwap: number;
  usd_volume: number;
  newest: number;
  total: number;
}

/**
 * Volume-weighted average of recorded trades over the lookback window. Returned as a quote so it
 * enters the median with its traded value as weight; omitted when there are too few prints to be a
 * series, so a single wash trade cannot become a price source.
 */
async function tradeTwapQuote(
  env: RuntimeEnv,
  mint: string,
  now: number,
  config: DiggoConfig,
): Promise<PriceQuote | null> {
  const row = await env.DB.prepare(
    `SELECT CASE WHEN SUM(amount) > 0 THEN SUM(price_usd * amount) / SUM(amount) ELSE 0 END AS vwap,
            COALESCE(SUM(amount * price_usd), 0) AS usd_volume,
            COALESCE(MAX(block_time), 0) AS newest,
            COUNT(*) AS total
       FROM trades
      WHERE mint = ?1 AND block_time >= ?2 AND amount > 0 AND price_usd > 0`,
  )
    .bind(mint, now - config.rarity.robustPrice.lookbackSeconds)
    .first<TradeTwapRow>();
  if (!row || row.total < ORACLE_MIN_TRADE_SAMPLES) return null;
  if (!Number.isFinite(row.vwap) || row.vwap <= 0 || row.newest <= 0) return null;
  return {
    source: "trade-twap",
    priceUsd: row.vwap,
    observedAt: row.newest,
    weightUsd: row.usd_volume > 0 ? row.usd_volume : undefined,
    // Real trades on this mint, but not an independent venue: weighted below the aggregator.
    reliability: 0.8,
  };
}

// --- external sources -----------------------------------------------------------------------------

async function fetchJson(
  url: string,
  options: OracleOptions,
  headers: Record<string, string>,
  fetcher: typeof fetch,
): Promise<unknown> {
  const timeoutMs = ORACLE_LIMITS.fetchTimeoutMs;
  let signal = options.signal;
  if (!signal && typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    signal = AbortSignal.timeout(timeoutMs);
  }
  const response = await fetcher(url, { headers, signal });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).host}`);
  return response.json();
}

/**
 * Jupiter token price. v3 first (current endpoint), v2 as a legacy fallback, and both tolerate
 * either response shape because the aggregator has moved fields between versions before.
 */
export async function fetchJupiterQuote(
  mint: string,
  now: number,
  vars: ResolvedVars,
  options: OracleOptions,
  fetcher: typeof fetch,
): Promise<PriceQuote | null> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (vars.jupiterApiKey) headers["x-api-key"] = vars.jupiterApiKey;
  const urls = [vars.jupiterUrl, vars.jupiterV2Url].filter((url, index, all) => all.indexOf(url) === index);
  let lastError: unknown = null;
  for (const base of urls) {
    try {
      const payload = (await fetchJson(`${base}?ids=${encodeURIComponent(mint)}`, options, headers, fetcher)) as
        | Record<string, unknown>
        | null;
      const priceUsd = readJupiterPrice(payload, mint);
      if (priceUsd === null) {
        lastError = new Error("no price for mint in response");
        continue;
      }
      return {
        source: "jupiter",
        priceUsd,
        // v3 carries no observation timestamp, so the moment we read it is the observation.
        observedAt: now,
        reliability: 0.9,
      };
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return null;
}

/** Reads a USD price out of either the v3 (`{ mint: { usdPrice } }`) or v2 (`{ data: ... }`) shape. */
export function readJupiterPrice(payload: unknown, mint: string): number | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;
  const containers = [root, root.data].filter(
    (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
  );
  for (const container of containers) {
    const entry = container[mint];
    if (typeof entry === "number") {
      if (Number.isFinite(entry) && entry > 0) return entry;
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;
    const fields = entry as Record<string, unknown>;
    for (const key of ["usdPrice", "price", "priceUsd"]) {
      const parsed = numeric(fields[key]);
      if (parsed !== null && parsed > 0) return parsed;
    }
  }
  return null;
}

/** Pyth Hermes SOL/USD. `price * 10^expo`, with the feed's own publish_time as observedAt. */
export async function fetchPythSolUsd(
  vars: ResolvedVars,
  options: OracleOptions,
  fetcher: typeof fetch,
): Promise<PriceQuote | null> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (vars.pythApiKey) headers.authorization = `Bearer ${vars.pythApiKey}`;
  const feed = vars.pythSolFeedId.replace(/^0x/, "");
  const url = `${vars.pythUrl}/v2/updates/price/latest?parsed=true&ids[]=0x${feed}`;
  const payload = (await fetchJson(url, options, headers, fetcher)) as { parsed?: unknown } | null;
  const entries = Array.isArray(payload?.parsed) ? payload.parsed : [];
  for (const entry of entries) {
    const price = (entry as { price?: Record<string, unknown> } | null)?.price;
    if (!price) continue;
    const mantissa = numeric(price.price);
    const exponent = numeric(price.expo);
    if (mantissa === null || exponent === null) continue;
    const priceUsd = mantissa * Math.pow(10, exponent);
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) continue;
    const publishTime = numeric(price.publish_time);
    return {
      source: "pyth-sol",
      priceUsd,
      observedAt: publishTime !== null && publishTime > 0 ? Math.floor(publishTime) : Math.floor(Date.now() / 1_000),
      reliability: 0.95,
    };
  }
  return null;
}

// --- SOL/USD --------------------------------------------------------------------------------------

interface SolRow {
  source: string;
  price_usd: number;
  observed_at: number;
  fetched_at: number;
  reliability: number;
}

async function readSolRows(env: RuntimeEnv): Promise<SolRow[]> {
  const result = await env.DB.prepare(
    "SELECT source, price_usd, observed_at, fetched_at, reliability FROM oracle_sol_usd",
  ).all<SolRow>();
  return result.results ?? [];
}

async function storeSolQuotes(env: RuntimeEnv, quotes: readonly PriceQuote[], now: number): Promise<void> {
  const statements = quotes.map((quote) =>
    env.DB.prepare(
      `INSERT INTO oracle_sol_usd (source, price_usd, observed_at, fetched_at, reliability)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(source) DO UPDATE SET
         price_usd = excluded.price_usd,
         observed_at = excluded.observed_at,
         fetched_at = excluded.fetched_at,
         reliability = excluded.reliability`,
    ).bind(quote.source, quote.priceUsd, quote.observedAt, now, quote.reliability ?? 1),
  );
  if (statements.length > 0) await env.DB.batch(statements);
}

/**
 * SOL/USD for the discovery valuation path, replacing the hardcoded illustrative rate.
 *
 * Reads the cached observations (Pyth, Jupiter SOL) and takes the median of whatever is fresh;
 * with `options.fetch` it refreshes them first. When no oracle is reachable the response is the
 * illustrative devnet constant, explicitly labelled and with confidence 0.2, so an unconfigured
 * deployment behaves as it did before while every configured one stops guessing.
 */
export async function getSolUsd(env: RuntimeEnv, options: OracleOptions = {}): Promise<SolUsdQuote> {
  const vars = resolveVars(env);
  const now = options.now ?? Math.floor(Date.now() / 1_000);
  const fetcher = options.fetch ?? null;

  if (vars.solUsdOverride !== null) {
    return {
      priceUsd: vars.solUsdOverride,
      source: "config-override",
      observedAt: now,
      fetchedAt: now,
      cached: false,
      confidence: 1,
      stale: false,
      fromOracle: true,
      sources: [{ source: "config-override", priceUsd: vars.solUsdOverride, observedAt: now }],
    };
  }

  if (fetcher) {
    try {
      await refreshSolUsd(env, options, fetcher, vars, now);
    } catch (error) {
      console.error(JSON.stringify({ event: "oracle.sol_refresh_failed", error: String(error) }));
    }
  }

  const rows = (await readSolRows(env)).filter(
    (row) =>
      Number.isFinite(row.price_usd) &&
      row.price_usd > 0 &&
      now - row.observed_at <= ORACLE_LIMITS.maxStalenessSeconds &&
      row.observed_at <= now + 5,
  );
  if (rows.length === 0) {
    return {
      priceUsd: ILLUSTRATIVE_DEVNET_SOL_USD,
      source: "illustrative-devnet-fallback",
      observedAt: now,
      fetchedAt: now,
      cached: false,
      confidence: 0.2,
      stale: true,
      fromOracle: false,
      sources: [],
    };
  }

  const sorted = [...rows].sort((a, b) => a.price_usd - b.price_usd);
  const median = sorted[Math.floor((sorted.length - 1) / 2)].price_usd;
  const observedAt = rows.reduce((newest, row) => Math.max(newest, row.observed_at), 0);
  let maxDeviationBps = 0;
  for (const row of rows) {
    const deviation = (Math.abs(row.price_usd - median) / median) * 10_000;
    if (deviation > maxDeviationBps) maxDeviationBps = deviation;
  }
  const agreement = Math.max(0, 1 - maxDeviationBps / 1_000);
  const age = Math.max(0, now - observedAt);
  const freshness = Math.max(
    0,
    Math.min(1, 1 - Math.max(0, age - ORACLE_LIMITS.freshSeconds) / (ORACLE_LIMITS.maxStalenessSeconds - ORACLE_LIMITS.freshSeconds)),
  );
  const reliability = rows.reduce((sum, row) => sum + (row.reliability ?? 1), 0) / rows.length;
  return {
    priceUsd: median,
    source: rows.length > 1 ? "median" : rows[0].source,
    observedAt,
    fetchedAt: rows.reduce((newest, row) => Math.max(newest, row.fetched_at), 0),
    cached: true,
    confidence: Math.max(0, Math.min(1, agreement * freshness * reliability)),
    stale: age > ORACLE_LIMITS.solTtlSeconds,
    fromOracle: true,
    sources: rows.map((row) => ({ source: row.source, priceUsd: row.price_usd, observedAt: row.observed_at })),
  };
}

/** Refreshes the cached SOL/USD observations from Pyth and Jupiter. Never throws. */
export async function refreshSolUsd(
  env: RuntimeEnv,
  options: OracleOptions,
  fetcher: typeof fetch,
  vars: ResolvedVars,
  now: number,
): Promise<PriceQuote[]> {
  const quotes: PriceQuote[] = [];
  const attempts = await Promise.allSettled([
    fetchPythSolUsd(vars, options, fetcher),
    fetchJupiterQuote(WRAPPED_SOL_MINT, now, vars, options, fetcher),
  ]);
  attempts.forEach((attempt, index) => {
    const name = index === 0 ? "pyth-sol" : "jupiter-sol";
    if (attempt.status !== "fulfilled") {
      console.error(JSON.stringify({ event: "oracle.sol_source_failed", source: name, error: String(attempt.reason) }));
      return;
    }
    if (attempt.value) quotes.push({ ...attempt.value, source: name });
  });
  if (quotes.length > 0) {
    await storeSolQuotes(env, quotes, now);
    await metric(env, "oracle.sol_usd_refreshed", quotes.length, { sources: quotes.map((q) => q.source).join(",") });
  }
  return quotes;
}

// --- external quote cache -------------------------------------------------------------------------

interface ExternalRow {
  source: string;
  price_usd: number;
  observed_at: number;
  fetched_at: number;
  weight_usd: number;
  reliability: number;
}

async function readExternalQuotes(env: RuntimeEnv, mint: string): Promise<PriceQuote[]> {
  const result = await env.DB.prepare(
    `SELECT source, price_usd, observed_at, fetched_at, weight_usd, reliability
       FROM oracle_price_cache WHERE mint = ?1`,
  )
    .bind(mint)
    .all<ExternalRow>();
  return (result.results ?? []).map((row) => ({
    source: row.source,
    priceUsd: row.price_usd,
    observedAt: row.observed_at,
    weightUsd: row.weight_usd > 0 ? row.weight_usd : undefined,
    reliability: row.reliability,
    cached: true,
  }));
}

async function storeExternalQuote(env: RuntimeEnv, mint: string, quote: PriceQuote, now: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO oracle_price_cache (mint, source, price_usd, observed_at, fetched_at, weight_usd, reliability)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT(mint, source) DO UPDATE SET
       price_usd = excluded.price_usd,
       observed_at = excluded.observed_at,
       fetched_at = excluded.fetched_at,
       weight_usd = excluded.weight_usd,
       reliability = excluded.reliability`,
  )
    .bind(mint, quote.source, quote.priceUsd, quote.observedAt, now, quote.weightUsd ?? 0, quote.reliability ?? 1)
    .run();
}

async function isGraduated(env: RuntimeEnv, mint: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT status FROM tokens WHERE mint = ?1")
    .bind(mint)
    .first<{ status: string }>();
  // LAUNCHING mines trade on the bonding curve only, where an aggregator has no market to quote.
  return row !== null && row.status !== "LAUNCHING";
}

export interface OracleRefreshResult {
  mint: string;
  graduated: boolean;
  stored: string[];
  failed: OracleSourceRejection[];
}

/**
 * Fetches and caches the external observations for one mint. Called from the indexing path and
 * from cron; never throws, because a third-party outage must not fail an epoch sync.
 */
export async function refreshExternalQuotes(
  env: RuntimeEnv,
  mint: string,
  options: OracleOptions = {},
): Promise<OracleRefreshResult> {
  const vars = resolveVars(env);
  const now = options.now ?? Math.floor(Date.now() / 1_000);
  const fetcher = options.fetch ?? null;
  const graduated = options.graduated ?? (await isGraduated(env, mint));
  const result: OracleRefreshResult = { mint, graduated, stored: [], failed: [] };
  if (!fetcher) return result;

  // One mint, one quote per refresh window: the queue consumer and cron can both land here for the
  // same mint, and the aggregator does not need to see both.
  const newestFetched = (await readExternalQuotes(env, mint)).reduce(
    (newest, quote) => Math.max(newest, quote.observedAt),
    0,
  );
  if (graduated && now - newestFetched > ORACLE_LIMITS.externalRefreshSeconds) {
    try {
      const quote = await fetchJupiterQuote(mint, now, vars, options, fetcher);
      if (quote) {
        await storeExternalQuote(env, mint, quote, now);
        result.stored.push(quote.source);
      } else {
        result.failed.push({ source: "jupiter", reason: "no_quote" });
      }
    } catch (error) {
      result.failed.push({ source: "jupiter", reason: String(error).slice(0, 120) });
    }
  }

  // SOL/USD is global; refresh it only when the cached read has aged past its TTL.
  const solRows = await readSolRows(env);
  const newestSolFetch = solRows.reduce((newest, row) => Math.max(newest, row.fetched_at), 0);
  if (now - newestSolFetch > ORACLE_LIMITS.solTtlSeconds) {
    const quotes = await refreshSolUsd(env, options, fetcher, vars, now);
    result.stored.push(...quotes.map((quote) => quote.source));
  }

  await metric(env, "oracle.refresh", result.stored.length, {
    mint,
    graduated: String(graduated),
    failed: String(result.failed.length),
  });
  return result;
}

/** Refreshes external quotes for one mint without letting a failure escape. */
export async function refreshExternalQuotesSafely(
  env: RuntimeEnv,
  mint: string,
  options: OracleOptions = {},
): Promise<void> {
  try {
    await refreshExternalQuotes(env, mint, options);
  } catch (error) {
    console.error(JSON.stringify({ event: "oracle.refresh_failed", mint, error: String(error) }));
  }
}

// --- the combined price ---------------------------------------------------------------------------

function quoteCacheKey(mint: string): string {
  return `${ORACLE_QUOTE_CACHE_PREFIX}${mint}`;
}

async function readCachedQuote(env: RuntimeEnv, mint: string, now: number): Promise<OracleQuote | null> {
  if (!env.TOKEN_CACHE) return null;
  try {
    const raw = await env.TOKEN_CACHE.get(quoteCacheKey(mint));
    if (typeof raw !== "string") return null;
    const cached = JSON.parse(raw) as OracleQuote;
    if (cached.mint !== mint) return null;
    if (now - cached.fetchedAt > ORACLE_LIMITS.quoteTtlSeconds) return null;
    if (now - cached.observedAt > ORACLE_LIMITS.maxStalenessSeconds) return null;
    if (!Number.isFinite(cached.priceUsd) || cached.priceUsd <= 0) return null;
    return { ...cached, cached: true };
  } catch {
    return null;
  }
}

async function writeCachedQuote(env: RuntimeEnv, quote: OracleQuote): Promise<void> {
  if (!env.TOKEN_CACHE) return;
  try {
    await env.TOKEN_CACHE.put(quoteCacheKey(quote.mint), JSON.stringify(quote), {
      expirationTtl: ORACLE_LIMITS.quoteTtlSeconds * 2,
    });
  } catch (error) {
    console.error(JSON.stringify({ event: "oracle.cache_write_failed", mint: quote.mint, error: String(error) }));
  }
}

/**
 * The robust USD price for one mint: weighted median across the internal history, the recorded
 * trade VWAP, Jupiter (for a graduated mint) and the cached external observations, with the
 * staleness and deviation gates applied across sources.
 *
 * Returns null - and the caller therefore pays nothing - when the internal history is missing or
 * too noisy, when the sources disagree beyond the configured band, when every usable observation is
 * older than the staleness limit, or when the combined confidence is below the configured minimum.
 */
export async function getRobustPrice(
  env: RuntimeEnv,
  mint: string,
  options: OracleOptions = {},
): Promise<OracleQuote | null> {
  const config = options.config ?? DIGGO_CONFIG;
  const vars = resolveVars(env);
  const now = options.now ?? Math.floor(Date.now() / 1_000);
  const rules: Partial<SourcePriceRules> = {
    maxStalenessSeconds: ORACLE_LIMITS.maxStalenessSeconds,
    freshSeconds: ORACLE_LIMITS.freshSeconds,
    minimumConfidence: Math.max(ORACLE_LIMITS.minimumConfidence, config.discovery.minimumPriceConfidence),
    minimumExternalSources: vars.minimumExternalSources,
    ...options.rules,
  };

  if (options.useCache !== false) {
    const cached = await readCachedQuote(env, mint, now);
    if (cached) {
      await metric(env, "oracle.quote_cached", 1, { mint });
      return cached;
    }
  }

  const unavailable: OracleSourceRejection[] = [];

  // A caller that passes fetch explicitly wants a live refresh (tests, admin probes); the roll path
  // does not, so a player request never blocks on a third-party API.
  if (options.fetch) {
    try {
      const refresh = await refreshExternalQuotes(env, mint, { ...options, now });
      unavailable.push(...refresh.failed);
    } catch (error) {
      unavailable.push({ source: "oracle", reason: String(error).slice(0, 120) });
      console.error(JSON.stringify({ event: "oracle.refresh_failed", mint, error: String(error) }));
    }
  }

  const internal = await internalSource(env, mint, now, config);
  // Without our own history there is nothing to anchor an external quote to: a lone aggregator
  // price on a thin pool is exactly the manipulation this module exists to refuse.
  if (!internal) {
    await metric(env, "oracle.quote_unavailable", 1, { mint, reason: "no_internal_history" });
    return null;
  }

  const external: PriceQuote[] = [];
  const tradeQuote = await tradeTwapQuote(env, mint, now, config);
  if (tradeQuote) external.push(tradeQuote);
  external.push(...(await readExternalQuotes(env, mint)));

  const sol = await getSolUsd(env, { now, config });
  const combined = combinePriceSources({ internal, external }, now, config, rules);
  if (!combined) {
    // Labelling only - the staleness gate itself lives in combinePriceSources - so an operator can
    // tell "the history is too old" apart from "the sources disagree" without a second code path.
    const internalStale = now - internal.observedAt > sourcePriceRules(config, rules).maxStalenessSeconds;
    await metric(env, "oracle.quote_unavailable", 1, {
      mint,
      reason: internalStale ? "stale_history" : "sources",
    });
    return null;
  }

  const quote: OracleQuote = {
    ...combined,
    mint,
    solUsd: sol.priceUsd,
    solUsdSource: sol.source,
    cached: false,
    fetchedAt: now,
    unavailable,
  };
  await writeCachedQuote(env, quote);
  await metric(env, "oracle.quote", 1, {
    mint,
    sources: combined.sources.join(","),
    solUsdSource: sol.source,
  });
  return quote;
}
