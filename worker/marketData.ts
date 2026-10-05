/**
 * Market data for the trade screen, read from Dexscreener's public API and cached at the edge.
 *
 * GET /api/market/tokens?mints=a,b,c   up to 30 mints
 * GET /api/market/search?q=…           a ticker, a name or a mint; Solana only
 */
import { apiError, isBase58Address, json } from "./http";
import { marketTokensFromPairs } from "../shared/marketToken";

const DEXSCREENER = "https://api.dexscreener.com";
const CACHE_SECONDS = 30;

async function cachedJson(ctx: ExecutionContext, url: string): Promise<unknown> {
  const cache = (caches as unknown as { default: Cache }).default;
  const key = new Request(url, { method: "GET" });
  const hit = await cache.match(key).catch(() => undefined);
  if (hit) return hit.json();
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error("market data " + response.status);
  const body = await response.text();
  const stored = new Response(body, { headers: { "content-type": "application/json", "cache-control": `public, max-age=${CACHE_SECONDS}` } });
  ctx.waitUntil(cache.put(key, stored).catch(() => undefined));
  return JSON.parse(body);
}

export async function marketTokens(request: Request, ctx: ExecutionContext): Promise<Response> {
  const mints = [...new Set((new URL(request.url).searchParams.get("mints") ?? "").split(",").map((mint) => mint.trim()).filter(isBase58Address))].slice(0, 30);
  if (mints.length === 0) return json({ tokens: [] });
  try {
    const pairs = await cachedJson(ctx, `${DEXSCREENER}/tokens/v1/solana/${mints.join(",")}`);
    return json({ tokens: marketTokensFromPairs(pairs) }, { headers: { "cache-control": `public, max-age=${CACHE_SECONDS}` } });
  } catch {
    return apiError("Market data is unavailable right now", 502);
  }
}

export async function marketSearch(request: Request, ctx: ExecutionContext): Promise<Response> {
  const q = (new URL(request.url).searchParams.get("q") ?? "").trim().replace(/^\$/, "").slice(0, 64);
  if (q.length < 2) return json({ tokens: [] });
  try {
    const body = await cachedJson(ctx, `${DEXSCREENER}/latest/dex/search?q=${encodeURIComponent(q)}`) as { pairs?: unknown };
    const tokens = marketTokensFromPairs(body?.pairs)
      .sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))
      .slice(0, 12);
    return json({ tokens }, { headers: { "cache-control": `public, max-age=${CACHE_SECONDS}` } });
  } catch {
    return apiError("Search is unavailable right now", 502);
  }
}
