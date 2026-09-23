/**
 * The watchlist: the coins one wallet is following.
 *
 * A watchlist is off-chain by design. No instruction reads it, no payout path consults it, and
 * nothing in this module can move a token, a lamport, a reward or a claim. What it holds is a
 * set of mints a player asked to see again; what it serves is that set joined to the indexer's
 * own read model, so a panel can show a price, a 24h change and a mining status without one
 * request per coin.
 *
 * Three rules run through the module:
 *
 *   - the wallet comes from the signed session and never from the body, so no caller can read
 *     or edit another wallet's list;
 *   - a mint has to have been indexed already, so the table cannot be used as free storage;
 *   - the list is capped per wallet, so it stays a list of coins someone cares about.
 *
 * Every number below is copied from `tokens`/`coins`, which are themselves copies of a program
 * account. Nothing here is computed by the Worker, and `change24h` is null rather than zero when
 * the coin has no measured trade window to compare against.
 */
import { sessionWallet } from "./auth";
import type { RuntimeEnv } from "./env";
import {
  apiError,
  checkRateLimit,
  checkWalletRateLimit,
  isBase58Address,
  json,
  readJson,
} from "./http";
import { nowSeconds } from "./indexStore";
import type { CoinStatus, CoinVenue } from "./v2/types";

/** The cap the design puts on one wallet's list. */
export const WATCHLIST_MAX = 200;
/** Requests per minute per IP for the whole watchlist surface. */
export const WATCHLIST_RATE_LIMIT = 60;
/** Writes per minute per wallet, so one session cannot churn the table. */
export const WATCHLIST_WALLET_RATE_LIMIT = 30;
/** Mints one merge request may carry, which is the cap itself. */
export const WATCHLIST_MERGE_MAX = WATCHLIST_MAX;

/** One watched coin, as the panel renders it. */
export interface WatchlistCoin {
  mint: string;
  coin: string;
  slug: string;
  name: string;
  symbol: string;
  imageUrl: string | null;
  status: CoinStatus;
  venue: CoinVenue;
  graduated: boolean;
  priceSol: number;
  priceUsd: number;
  marketCapUsd: number;
  /** Measured from the coin's own indexed trades. Null is unknown, never zero. */
  change24h: number | null;
  volume24hUsd: number;
  trades24h: number;
  /** The coin's mining status, so a panel can say whether it is still being mined. */
  mining: {
    open: boolean;
    cap: number;
    mined: number;
    remaining: number;
    progress: number;
    rewardPerBlock: number;
    unpaid: number;
  };
  addedAt: number;
}

export interface WatchlistView {
  wallet: string;
  /** The watched mints exactly as stored, so a star is correct even for a coin the index lags. */
  mints: string[];
  /** The same mints joined to the index. A mint with no indexed coin row is simply absent here. */
  coins: WatchlistCoin[];
  limit: number;
  syncedAt: number;
}

interface WatchlistRow {
  mint: string;
  added_at: number;
  coin: string;
  slug: string;
  name: string;
  symbol: string;
  image_key: string | null;
  status: string;
  venue: string;
  graduated: number;
  price_sol: number;
  price_usd: number;
  market_cap_usd: number;
  change_24h: number;
  change_24h_at: number;
  volume_24h_usd: number;
  trades_24h: number;
  reward_per_block: number;
  curve_mining_cap: string;
  curve_mining_mined: string;
  curve_mining_unpaid: string;
  curve_mining_open: number;
}

/**
 * The watchlist joined to the public read model. The join is inner on both tables on purpose:
 * a watched mint the indexer has never seen has no price to show, and the mints array above is
 * what keeps the star itself correct.
 */
const WATCHLIST_SELECT = `SELECT w.mint, w.added_at, t.coin, t.slug, t.name, t.symbol,
       t.image_key, t.status, t.venue, t.graduated, t.price_sol, t.price_usd,
       t.market_cap_usd, t.change_24h, t.change_24h_at, t.volume_24h_usd, t.trades_24h,
       t.reward_per_block, c.curve_mining_cap, c.curve_mining_mined, c.curve_mining_unpaid,
       c.curve_mining_open
  FROM watchlist w
  JOIN tokens t ON t.mint = w.mint
  JOIN coins c ON c.mint = w.mint
 WHERE w.wallet = ?1
 ORDER BY w.added_at DESC, w.mint ASC`;

function rowToCoin(row: WatchlistRow): WatchlistCoin {
  const cap = Number(row.curve_mining_cap);
  const mined = Number(row.curve_mining_mined);
  return {
    mint: row.mint,
    coin: row.coin,
    slug: row.slug,
    name: row.name,
    symbol: row.symbol,
    imageUrl: row.image_key ? `/media/${row.image_key}` : null,
    status: row.status as CoinStatus,
    venue: row.venue as CoinVenue,
    graduated: row.graduated === 1,
    priceSol: row.price_sol,
    priceUsd: row.price_usd,
    marketCapUsd: row.market_cap_usd,
    change24h: row.change_24h_at > 0 ? row.change_24h : null,
    volume24hUsd: row.volume_24h_usd,
    trades24h: row.trades_24h,
    mining: {
      open: row.curve_mining_open === 1 && row.graduated !== 1,
      cap,
      mined,
      remaining: Math.max(0, cap - mined),
      progress: cap === 0 ? 0 : mined / cap,
      rewardPerBlock: row.reward_per_block,
      unpaid: Number(row.curve_mining_unpaid),
    },
    addedAt: row.added_at,
  };
}

/** A wallet's watched mints, newest first. Read-only and session-scoped by the caller. */
export async function watchlistMints(env: RuntimeEnv, wallet: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    "SELECT mint FROM watchlist WHERE wallet = ?1 ORDER BY added_at DESC, mint ASC",
  )
    .bind(wallet)
    .all<{ mint: string }>();
  return (rows.results ?? []).map((row) => row.mint);
}

/** The whole view: the stored mints plus everything the index knows about them. */
export async function watchlistView(env: RuntimeEnv, wallet: string): Promise<WatchlistView> {
  const [mints, rows] = await Promise.all([
    watchlistMints(env, wallet),
    env.DB.prepare(WATCHLIST_SELECT).bind(wallet).all<WatchlistRow>(),
  ]);
  return {
    wallet,
    mints,
    coins: (rows.results ?? []).map(rowToCoin),
    limit: WATCHLIST_MAX,
    syncedAt: nowSeconds(),
  };
}

/**
 * Adds one mint, or merges a whole list in one request.
 *
 * The merge form exists for sign-in: a player who watched ten coins while signed out should not
 * need ten round trips to keep them. Both forms take the same door - the session decides the
 * wallet, every mint has to be indexed, and the cap is enforced before anything is written.
 */
export async function addToWatchlist(request: Request, env: RuntimeEnv): Promise<Response> {
  if (!(await checkRateLimit(request, env, "watchlist", WATCHLIST_RATE_LIMIT))) {
    return apiError("Too many requests", 429);
  }
  const wallet = await sessionWallet(request, env);
  if (!wallet) return apiError("Wallet session required", 401);
  if (!(await checkWalletRateLimit(env, wallet, "watchlist-write", WATCHLIST_WALLET_RATE_LIMIT, 60))) {
    return apiError("Too many requests", 429);
  }

  const body = await readJson<{ mint?: unknown; mints?: unknown }>(request);
  const requested = normalizeMints(body);
  if (requested === null) return apiError("A base58 mint is required");
  if (requested.length === 0) return apiError("No mints to add");
  if (requested.length > WATCHLIST_MERGE_MAX) {
    return apiError(`At most ${WATCHLIST_MERGE_MAX} mints per request`);
  }

  const existing = await watchlistMints(env, wallet);
  const known = new Set(existing);
  const fresh = requested.filter((mint) => !known.has(mint));
  if (known.size + fresh.length > WATCHLIST_MAX) {
    return apiError(`A watchlist holds at most ${WATCHLIST_MAX} coins`, 409);
  }

  // Every mint has to exist in the index. `/api/tokens/register` refuses an unseen mint for the
  // same reason: a coin that does not exist on chain has no row to attach anything to, and a
  // watchlist that could hold arbitrary strings is free storage for anyone with a session.
  const indexed = await indexedMints(env, requested);
  const missing = requested.filter((mint) => !indexed.has(mint));
  if (missing.length > 0) {
    return apiError("That mint has not been indexed yet", 404);
  }

  const now = nowSeconds();
  if (fresh.length > 0) {
    await env.DB.batch(
      fresh.map((mint) =>
        env.DB.prepare(
          "INSERT OR IGNORE INTO watchlist (wallet, mint, added_at) VALUES (?1, ?2, ?3)",
        ).bind(wallet, mint, now),
      ),
    );
  }
  return json(await watchlistView(env, wallet), { headers: { "cache-control": "no-store" } });
}

/** Removes one mint. Removing something that is not there is not an error: the list ends right. */
export async function removeFromWatchlist(
  request: Request,
  env: RuntimeEnv,
  mint: string,
): Promise<Response> {
  if (!(await checkRateLimit(request, env, "watchlist", WATCHLIST_RATE_LIMIT))) {
    return apiError("Too many requests", 429);
  }
  const wallet = await sessionWallet(request, env);
  if (!wallet) return apiError("Wallet session required", 401);
  if (!isBase58Address(mint)) return apiError("Invalid mint");
  await env.DB.prepare("DELETE FROM watchlist WHERE wallet = ?1 AND mint = ?2")
    .bind(wallet, mint)
    .run();
  return json(await watchlistView(env, wallet), { headers: { "cache-control": "no-store" } });
}

/** GET /api/watchlist. Session-scoped, so it is never cached. */
export async function listWatchlist(request: Request, env: RuntimeEnv): Promise<Response> {
  if (!(await checkRateLimit(request, env, "watchlist", WATCHLIST_RATE_LIMIT))) {
    return apiError("Too many requests", 429);
  }
  const wallet = await sessionWallet(request, env);
  if (!wallet) return apiError("Wallet session required", 401);
  return json(await watchlistView(env, wallet), { headers: { "cache-control": "no-store" } });
}

/**
 * The three watchlist routes, dispatched from the one `/api/watchlist` prefix the router hands
 * over. Keeping the shape here means the router grows one line rather than four.
 */
export async function watchlistRoute(
  request: Request,
  env: RuntimeEnv,
  pathname: string,
): Promise<Response> {
  if (pathname === "/api/watchlist") {
    if (request.method === "GET") return listWatchlist(request, env);
    if (request.method === "POST") return addToWatchlist(request, env);
    return apiError("Method not allowed", 405);
  }
  const match = pathname.match(/^\/api\/watchlist\/([^/]+)$/);
  if (match && request.method === "DELETE") return removeFromWatchlist(request, env, match[1]!);
  return apiError("Route not found", 404);
}

/** One mint from `mint`, or a whole list from `mints`. Null when the shape is unusable. */
function normalizeMints(body: { mint?: unknown; mints?: unknown }): string[] | null {
  if (typeof body.mint === "string") return isBase58Address(body.mint) ? [body.mint] : null;
  if (Array.isArray(body.mints)) {
    const values = body.mints.filter((value): value is string => typeof value === "string");
    if (values.length !== body.mints.length) return null;
    if (!values.every(isBase58Address)) return null;
    // Duplicates are collapsed so a merge cannot spend two of the 200 slots on one coin.
    return [...new Set(values)];
  }
  return null;
}

/**
 * Which of these mints the indexer has already seen, as a set.
 *
 * Chunked because a merge can carry 200 mints and D1 bounds the parameters one statement may
 * bind; 50 keeps every query well inside that bound and the chunk count trivial.
 */
const MINT_LOOKUP_CHUNK = 50;

async function indexedMints(env: RuntimeEnv, mints: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let start = 0; start < mints.length; start += MINT_LOOKUP_CHUNK) {
    const chunk = mints.slice(start, start + MINT_LOOKUP_CHUNK);
    const placeholders = chunk.map((_, index) => `?${index + 1}`).join(", ");
    const rows = await env.DB.prepare(`SELECT mint FROM coins WHERE mint IN (${placeholders})`)
      .bind(...chunk)
      .all<{ mint: string }>();
    for (const row of rows.results ?? []) found.add(row.mint);
  }
  return found;
}
