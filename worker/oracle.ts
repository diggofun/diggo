/**
 * The price oracle, now display-only.
 *
 * In v4 the oracle was a settlement input: a discovery's value was normalised to USD at a rate
 * read from Jupiter and Pyth, and a robust-price history decided the amount. v2 removed that
 * entirely - discovery value is normalised by the coin's **own pool TWAP**, a price the program
 * observed itself, so no external source is consulted anywhere in a payout path.
 *
 * What is left is what the design keeps off-chain on purpose: a SOL/USD rate for the USD columns
 * of a page. A wrong rate here moves a number on a screen and nothing else, which is why the
 * missing rate is reported as unavailable rather than replaced with an invented value.
 */
import type { OracleBindings, RuntimeEnv } from "./env";

export const JUPITER_PRICE_V3_URL = "https://lite-api.jup.ag/price/v3";
export const JUPITER_PRICE_V2_URL = "https://lite-api.jup.ag/price/v2";
export const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
export const PYTH_HERMES_URL = "https://hermes.pyth.network";
export const PYTH_SOL_USD_FEED_ID =
  "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

export const ORACLE_SOL_CACHE_KEY = "oracle:v2:sol-usd";

export type OracleEnv = RuntimeEnv & OracleBindings;

export interface SolUsdQuote {
  priceUsd: number;
  source: string;
  /** Whether priceUsd can be used for display conversions. */
  available: boolean;
  /** False for an explicit local override rather than an external observation. */
  fromOracle: boolean;
  fetchedAt: number;
}

/**
 * SOL/USD for display, cached briefly in KV.
 *
 * Two sources are consulted and the first usable one wins: Jupiter's price for wrapped SOL, then
 * Pyth's published SOL/USD feed. A failure of both is not an error condition - it is the
 * unavailable result with `available: false`, which every caller is expected to surface.
 */
export async function getSolUsd(env: OracleEnv, options: { now?: number } = {}): Promise<SolUsdQuote> {
  const now = options.now ?? Math.floor(Date.now() / 1_000);
  const pinned = Number.parseFloat(env.ORACLE_SOL_USD_OVERRIDE ?? "");
  if (Number.isFinite(pinned) && pinned > 0) {
    return { priceUsd: pinned, source: "override", available: true, fromOracle: false, fetchedAt: now };
  }
  const cached = await env.TOKEN_CACHE.get<Partial<SolUsdQuote>>(ORACLE_SOL_CACHE_KEY, "json");
  const cachedPrice = typeof cached?.priceUsd === "number" && Number.isFinite(cached.priceUsd)
    ? cached.priceUsd
    : 0;
  const cachedQuote: SolUsdQuote | null = cached && cachedPrice > 0
    ? {
        priceUsd: cachedPrice,
        source: typeof cached.source === "string" ? cached.source : "cache",
        available: true,
        fromOracle: false,
        fetchedAt: typeof cached.fetchedAt === "number" ? cached.fetchedAt : 0,
      }
    : null;
  if (cachedQuote && now - cachedQuote.fetchedAt < 300) return cachedQuote;
  const jupiter = await fetchJupiterSolUsd(env).catch(() => null);
  if (jupiter !== null) {
    const quote: SolUsdQuote = { priceUsd: jupiter, source: "jupiter", available: true, fromOracle: true, fetchedAt: now };
    await env.TOKEN_CACHE.put(ORACLE_SOL_CACHE_KEY, JSON.stringify(quote), { expirationTtl: 600 });
    return quote;
  }
  const pyth = await fetchPythSolUsd(env).catch(() => null);
  if (pyth !== null) {
    const quote: SolUsdQuote = { priceUsd: pyth, source: "pyth", available: true, fromOracle: true, fetchedAt: now };
    await env.TOKEN_CACHE.put(ORACLE_SOL_CACHE_KEY, JSON.stringify(quote), { expirationTtl: 600 });
    return quote;
  }
  if (cachedQuote) return cachedQuote;
  return { priceUsd: 0, source: "unavailable", available: false, fromOracle: false, fetchedAt: now };
}

async function fetchJupiterSolUsd(env: OracleEnv): Promise<number | null> {
  const url = `${env.JUPITER_PRICE_URL || JUPITER_PRICE_V3_URL}?ids=${WRAPPED_SOL_MINT}`;
  const response = await fetch(url, {
    headers: env.JUPITER_API_KEY ? { "x-api-key": env.JUPITER_API_KEY } : {},
  });
  if (!response.ok) return null;
  const payload = (await response.json()) as Record<string, unknown>;
  const entry = payload[WRAPPED_SOL_MINT] as { usdPrice?: number; price?: number } | undefined;
  const price = entry?.usdPrice ?? entry?.price;
  return typeof price === "number" && price > 0 ? price : null;
}

/** Reads Pyth's published SOL/USD feed. The exponent is applied exactly as Pyth publishes it. */
export async function fetchPythSolUsd(env: OracleEnv): Promise<number | null> {
  const base = env.PYTH_HERMES_URL || PYTH_HERMES_URL;
  const feedId = env.PYTH_SOL_USD_FEED_ID || PYTH_SOL_USD_FEED_ID;
  const response = await fetch(`${base}/v2/updates/price/latest?ids[]=${feedId}`, {
    headers: env.PYTH_API_KEY ? { authorization: `Bearer ${env.PYTH_API_KEY}` } : {},
  });
  if (!response.ok) return null;
  const payload = (await response.json()) as {
    parsed?: readonly { price?: { price?: string; expo?: number } }[];
  };
  const parsed = payload.parsed?.[0]?.price;
  if (!parsed?.price) return null;
  const value = Number(parsed.price) * 10 ** (parsed.expo ?? 0);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Warms the cache. Called from cron so a page never pays for the fetch. */
export async function refreshSolUsd(env: OracleEnv): Promise<SolUsdQuote> {
  await env.TOKEN_CACHE.delete(ORACLE_SOL_CACHE_KEY);
  return getSolUsd(env);
}
