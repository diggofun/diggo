/**
 * The coin read API: `/api/tokens`, `/api/bootstrap`, `/api/tokens/:slug`, media, and the
 * off-chain display metadata a coin may carry.
 *
 * Everything value-bearing here is read from the index, which is itself a copy of a program
 * account. Nothing in this module can write to the chain, and the only writes it makes to D1 are
 * the display metadata columns - a name, a description and an image key - which no instruction
 * reads. A client can no longer report a trade either: trades are indexed from the trade
 * instructions the program actually executed.
 */
import type { RuntimeEnv } from "./env";
import { apiError, checkRateLimit, isBase58Address, json, readJson } from "./http";
import { sessionWallet } from "./auth";
import { TOKEN_CACHE_KEY, nowSeconds } from "./indexStore";
import type { CoinListResponse, CoinSummary, CoinTrade } from "./v2/types";

export { TOKEN_CACHE_KEY };

/** The maximum number of coins one list response returns. */
export const TOKEN_LIMIT_MAX = 500;
export const TOKEN_LIMIT_DEFAULT = 100;

export function tokenLimit(value: string | null): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return TOKEN_LIMIT_DEFAULT;
  return Math.min(TOKEN_LIMIT_MAX, parsed);
}

interface TokenRow {
  mint: string;
  coin: string;
  slug: string;
  name: string;
  symbol: string;
  description: string;
  creator: string;
  image_key: string | null;
  decimals: number;
  status: string;
  price_sol: number;
  price_usd: number;
  usd_price_available: number;
  market_cap_usd: number;
  liquidity_sol: number;
  liquidity_usd: number;
  reserve_remaining: number;
  reserve_total: number;
  discovery_reserve_remaining: number;
  discovery_reserve_total: number;
  reward_per_block: number;
  network_power: number;
  bonded_power: number;
  starter_power: number;
  venue: string;
  next_block_at: number;
  next_epoch_at: number;
  epoch_index: number;
  epoch_seed_epoch: number;
  epoch_seed_committed: number;
  graduated: number;
  discovery_paused: number;
  change_24h: number;
  change_24h_at: number;
  volume_24h_usd: number;
  trades_24h: number;
  synced_at: number;
  created_at: number;
  liquidity_lamports: string;
  curve_mining_cap: string;
  curve_mining_mined: string;
  curve_mining_unpaid: string;
  curve_mining_block_reward: string;
  curve_mining_open: number;
}

/**
 * The read model joined back to the raw `coins` row it was derived from.
 *
 * The join is what lets the response carry both: the program's own values as strings, and the
 * labelled display conversions as numbers. A client never has to guess which one it is holding.
 */
const TOKEN_SELECT = `SELECT t.*,
       CASE WHEN t.venue = 'pool' AND p.sol_reserve IS NOT NULL THEN p.sol_reserve
            ELSE c.sol_reserve END AS liquidity_lamports,
       c.curve_mining_cap, c.curve_mining_mined, c.curve_mining_unpaid,
       c.curve_mining_block_reward, c.curve_mining_open
  FROM tokens t
  JOIN coins c ON c.mint = t.mint
  LEFT JOIN pools p ON p.mint = t.mint`;

function rowToSummary(row: TokenRow): CoinSummary {
  const cap = Number(row.curve_mining_cap);
  const mined = Number(row.curve_mining_mined);
  return {
    mint: row.mint,
    coin: row.coin,
    slug: row.slug,
    name: row.name,
    symbol: row.symbol,
    description: row.description,
    creator: row.creator,
    imageUrl: row.image_key ? `/media/${row.image_key}` : null,
    decimals: row.decimals,
    status: row.status as CoinSummary["status"],
    venue: row.venue as CoinSummary["venue"],
    graduated: row.graduated === 1,
    priceSol: row.price_sol,
    priceUsd: row.price_usd,
    usdPriceAvailable: row.usd_price_available === 1,
    marketCapUsd: row.market_cap_usd,
    liquiditySol: row.liquidity_sol,
    liquidityUsd: row.liquidity_usd,
    liquidityLamports: row.liquidity_lamports,
    reserveRemaining: row.reserve_remaining,
    reserveTotal: row.reserve_total,
    discoveryReserveRemaining: row.discovery_reserve_remaining,
    discoveryReserveTotal: row.discovery_reserve_total,
    rewardPerBlock: row.reward_per_block,
    networkPower: row.network_power,
    bondedPower: row.bonded_power,
    starterPower: row.starter_power,
    nextBlockAt: row.next_block_at,
    nextEpochAt: row.next_epoch_at,
    epochIndex: row.epoch_index,
    epochSeedEpoch: row.epoch_seed_epoch,
    epochSeedCommitted: row.epoch_seed_committed === 1,
    discoveryPaused: row.discovery_paused === 1,
    curveMining: {
      open: row.curve_mining_open === 1 && row.graduated !== 1,
      cap,
      mined,
      remaining: Math.max(0, cap - mined),
      progress: cap === 0 ? 0 : mined / cap,
      blockReward: Number(row.curve_mining_block_reward),
      unpaid: Number(row.curve_mining_unpaid),
    },
    change24h: row.change_24h_at > 0 ? row.change_24h : null,
    volume24hUsd: row.volume_24h_usd,
    trades24h: row.trades_24h,
    createdAt: row.created_at,
    syncedAt: row.synced_at,
  };
}

/**
 * The coin list. It is served from the index, and the index is refreshed by the cron sweep, so a
 * just-launched coin can lag by one pass. The response says when it was synced rather than
 * pretending to be live.
 */
export async function listTokens(
  env: RuntimeEnv,
  ctx: ExecutionContext,
  limit = TOKEN_LIMIT_DEFAULT,
): Promise<Response> {
  const cached = await env.TOKEN_CACHE.get<CoinListResponse>(cacheKey(limit), "json");
  if (cached) return json(cached, { headers: { "cache-control": "public, max-age=15" } });
  const rows = await env.DB.prepare(
    `${TOKEN_SELECT} ORDER BY t.created_at DESC LIMIT ?1`,
  )
    .bind(limit)
    .all<TokenRow>();
  const body: CoinListResponse = {
    tokens: (rows.results ?? []).map(rowToSummary),
    syncedAt: nowSeconds(),
  };
  ctx.waitUntil(env.TOKEN_CACHE.put(cacheKey(limit), JSON.stringify(body), { expirationTtl: 60 }));
  return json(body, { headers: { "cache-control": "public, max-age=15" } });
}

function cacheKey(limit: number): string {
  return `${TOKEN_CACHE_KEY}:${limit}`;
}

/** The same list the frontend bootstraps from, plus the config it needs to render at all. */
export async function bootstrap(
  env: RuntimeEnv,
  ctx: ExecutionContext,
  limit = TOKEN_LIMIT_DEFAULT,
): Promise<Response> {
  const [list, protocol] = await Promise.all([
    listTokens(env, ctx, limit).then((response) => response.json() as Promise<CoinListResponse>),
    protocolView(env),
  ]);
  return json({
    ...list,
    protocol,
    cluster: env.SOLANA_CLUSTER,
    programId: env.DIGGO_PROGRAM_ID,
    posthogApiKey: env.POSTHOG_API_KEY,
    posthogHost: env.POSTHOG_HOST,
    turnstileSiteKey: env.TURNSTILE_SITE_KEY,
    vanitySuffix: env.VANITY_SUFFIX,
  });
}

/**
 * The governance parameters the UI shows, straight from the indexed ProtocolConfig.
 *
 * The bond price and the starter-efficiency factors are deliberately not served. The program
 * retires them (`BOND_LAMPORTS` in its constants: no new bond may be posted and nothing a player
 * does costs a lamport beyond rent and the transaction fee), so quoting a deposit here would put
 * a price tag back on access that no wallet has to pay. The mirrored columns stay in D1, where a
 * value written before the retirement is still readable without being advertised.
 */
export async function protocolView(env: RuntimeEnv): Promise<Record<string, unknown> | null> {
  const row = await env.DB.prepare("SELECT * FROM protocol_config WHERE id = 1").first<
    Record<string, unknown>
  >();
  if (!row) return null;
  return {
    authority: row.authority,
    treasury: row.treasury,
    crankPool: row.crank_pool,
    creatorFeeBps: row.creator_fee_bps,
    platformFeeBps: row.platform_fee_bps,
    crankPoolFeeBps: row.crank_pool_fee_bps,
    discoveryDailyCapLamports: row.discovery_daily_cap_lamports,
    discoveryWeeklyCapLamports: row.discovery_weekly_cap_lamports,
    discoveryGlobalDailyCapLamports: row.discovery_global_daily_cap_lamports,
    discoveryEpochBudgetLamports: row.discovery_epoch_budget_lamports,
    pausedFlags: row.paused_flags,
    pausedUntil: row.paused_until,
    indexedAt: row.indexed_at,
  };
}

export async function tokenBySlug(slug: string, env: RuntimeEnv): Promise<Response> {
  const row = await env.DB.prepare(`${TOKEN_SELECT} WHERE t.slug = ?1`)
    .bind(slug)
    .first<TokenRow>();
  if (!row) return apiError("Token not found", 404);
  return json({ token: rowToSummary(row) });
}

/** One coin's indexed trades, newest first. Read-only: the chain is where they come from. */
export async function coinTrades(
  env: RuntimeEnv,
  mint: string,
  limit = 100,
): Promise<Response> {
  if (!isBase58Address(mint)) return apiError("Invalid mint");
  const rows = await env.DB.prepare(
    "SELECT signature, side, price_sol, amount_in, amount_out, fill_source, block_time, venue" +
      " FROM trades" +
      " WHERE mint = ?1 ORDER BY block_time DESC LIMIT ?2",
  )
    .bind(mint, Math.min(500, Math.max(1, limit)))
    .all<{
      signature: string;
      side: string;
      price_sol: number;
      amount_in: string;
      amount_out: string;
      fill_source: string;
      block_time: number;
      venue: string;
    }>();
  const trades: CoinTrade[] = (rows.results ?? []).map((row) => ({
    signature: row.signature,
    side: row.side === "BUY" ? "BUY" : "SELL",
    priceSol: row.price_sol,
    priceUsd: 0,
    amount: Number(row.amount_in),
    amountOut: Number(row.amount_out),
    fillSource: row.fill_source === "meta" || row.fill_source === "event" ? row.fill_source : "instruction",
    blockTime: row.block_time,
  }));
  return json({
    mint,
    trades,
    note:
      "amount is what the trader offered and amountOut what they received, read from the " +
      "transaction's balance table; price_sol is the venue's observed spot price at that slot",
  });
}

/**
 * Attaches off-chain display metadata to an already-indexed coin.
 *
 * The launch itself is on-chain and this endpoint cannot create a coin: it refuses a mint the
 * indexer has never seen. That is the difference from v4, where a client-reported launch created
 * a row - a coin that does not exist on chain now has no row to attach metadata to.
 */
export async function registerLaunchedToken(request: Request, env: RuntimeEnv): Promise<Response> {
  if (!(await checkRateLimit(request, env, "register", 12))) return apiError("Too many requests", 429);
  const wallet = await sessionWallet(request, env);
  if (!wallet) return apiError("Wallet session required", 401);
  const body = await readJson<{
    mint?: string;
    description?: string;
    imageKey?: string | null;
  }>(request, 32_768);
  if (!isBase58Address(body.mint)) return apiError("Invalid mint");
  const coin = await env.DB.prepare("SELECT creator, slug FROM coins WHERE mint = ?1")
    .bind(body.mint)
    .first<{ creator: string; slug: string }>();
  if (!coin) {
    return apiError("That mint has not been indexed yet; launch it on-chain first", 404);
  }
  if (coin.creator !== wallet) return apiError("Only the coin's creator may set its metadata", 403);
  const description = (body.description ?? "").slice(0, 512);
  const imageKey = typeof body.imageKey === "string" ? body.imageKey.slice(0, 200) : null;
  await env.DB.prepare(
    "UPDATE tokens SET description = ?1, image_key = ?2 WHERE mint = ?3",
  )
    .bind(description, imageKey, body.mint)
    .run();
  await env.TOKEN_CACHE.delete(TOKEN_CACHE_KEY);
  return json({ mint: body.mint, slug: coin.slug, description, imageKey });
}

/** Uploads one image to the media store. Cosmetics and coin art only; nothing value-bearing. */
export async function uploadMedia(request: Request, env: RuntimeEnv): Promise<Response> {
  if (!(await checkRateLimit(request, env, "media", 12))) return apiError("Too many requests", 429);
  const wallet = await sessionWallet(request, env);
  if (!wallet) return apiError("Wallet session required", 401);
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/")) return apiError("Only images may be uploaded");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0) return apiError("Empty upload");
  if (bytes.byteLength > 2_000_000) return apiError("Image too large (2 MB maximum)", 413);
  const extension = contentType.split("/")[1]?.split(";")[0] ?? "bin";
  const key = `${wallet.slice(0, 8)}-${crypto.randomUUID()}.${extension.replace(/[^a-z0-9]/g, "")}`;
  await env.TOKEN_CACHE.put(`media:${key}`, bytes, {
    metadata: { contentType, wallet, uploadedAt: nowSeconds() },
    expirationTtl: 60 * 60 * 24 * 365,
  });
  return json({ imageKey: key, url: `/media/${key}` });
}

/** Serves an uploaded image from the media store. */
export async function serveMedia(pathname: string, env: RuntimeEnv): Promise<Response> {
  const key = pathname.replace(/^\/media\//, "");
  if (!/^[A-Za-z0-9._-]+$/.test(key)) return apiError("Not found", 404);
  const stored = await env.TOKEN_CACHE.getWithMetadata<{ contentType?: string }>(
    `media:${key}`,
    "arrayBuffer",
  );
  if (!stored.value) return apiError("Not found", 404);
  return new Response(stored.value, {
    headers: {
      "content-type": stored.metadata?.contentType ?? "application/octet-stream",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
