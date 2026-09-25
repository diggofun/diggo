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

/** Largest coin image the media store accepts, in bytes. */
export const MEDIA_MAX_BYTES = 2_000_000;

/** Multipart framing overhead allowed on top of the image budget before we refuse to parse. */
const MEDIA_MULTIPART_SLACK_BYTES = 65_536;

const MEDIA_TOO_LARGE_MESSAGE = "Image too large (2 MB maximum)";
const MEDIA_ONLY_IMAGES_MESSAGE = "Only images may be uploaded";

interface SniffedImage {
  contentType: string;
  extension: string;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let index = start; index < end; index += 1) out += String.fromCharCode(bytes[index]);
  return out;
}

/**
 * Identifies an image from its leading bytes, ignoring whatever the client claimed.
 *
 * A browser sends `multipart/form-data` for a picked file, and the file part's own `type` is
 * either empty or occasionally wrong (Safari hands back `image/tiff`, some drag-and-drop paths
 * produce an empty string), so the declared MIME type cannot be the gate. The four raster
 * containers coin art actually arrives in are matched by their fixed signatures:
 *
 * - PNG:  89 50 4E 47 0D 0A 1A 0A
 * - JPEG: FF D8 FF (three markers, not two: FF D8 alone also prefixes JFIF/EXIF-less oddities)
 * - GIF:  `GIF87a` or `GIF89a`
 * - WebP: a RIFF container whose form type at offset 8 is `WEBP`
 *
 * SVG is deliberately absent. It is an XML document that executes script when a browser
 * navigates to it, and this store is served from the site's own origin (see serveMedia), so a
 * user-supplied SVG would be a stored-XSS primitive aimed at the same session cookie.
 */
export function sniffImageFormat(bytes: Uint8Array): SniffedImage | null {
  if (bytes.byteLength >= 8 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return { contentType: "image/png", extension: "png" };
  }
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { contentType: "image/jpeg", extension: "jpg" };
  }
  if (bytes.byteLength >= 6 && ascii(bytes, 0, 3) === "GIF" &&
      (ascii(bytes, 3, 6) === "87a" || ascii(bytes, 3, 6) === "89a")) {
    return { contentType: "image/gif", extension: "gif" };
  }
  if (bytes.byteLength >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") {
    return { contentType: "image/webp", extension: "webp" };
  }
  return null;
}

interface MediaUploadResult {
  bytes: Uint8Array;
  /** The file part's declared MIME type, or null when the client sent no type at all. */
  declaredContentType: string | null;
}

function isFileLike(value: unknown): value is Blob {
  return typeof value === "object" && value !== null &&
    typeof (value as Blob).arrayBuffer === "function" &&
    typeof (value as Blob).size === "number";
}

/**
 * Pulls the image bytes out of the request body, whatever envelope the client used.
 *
 * The browser client posts a `FormData`, so the request's own content type is
 * `multipart/form-data; boundary=...` and the image MIME type only exists on the file part. The
 * previous code demanded the request's own content type be `image/*`, which rejected every
 * upload a browser could make. A raw `image/*` body is still accepted for non-browser callers.
 */
export async function readMediaUpload(request: Request): Promise<MediaUploadResult | Response> {
  const declared = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (declared === "multipart/form-data") {
    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) &&
        declaredLength > MEDIA_MAX_BYTES + MEDIA_MULTIPART_SLACK_BYTES) {
      return apiError(MEDIA_TOO_LARGE_MESSAGE, 413);
    }
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return apiError("Malformed upload", 400);
    }
    let file: Blob | null = null;
    for (const field of ["file", "image", "file0"]) {
      const candidate = form.get(field);
      if (isFileLike(candidate)) {
        file = candidate;
        break;
      }
    }
    if (!file) {
      const entries: Blob[] = [];
      (form as unknown as { forEach?: (cb: (value: unknown) => void) => void }).forEach?.(
        (value) => entries.push(value as Blob),
      );
      for (const candidate of entries) {
        if (isFileLike(candidate)) {
          file = candidate;
          break;
        }
      }
    }
    if (!file) return apiError("No image was uploaded");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const partType = (file as File).type;
    return { bytes, declaredContentType: typeof partType === "string" && partType ? partType : null };
  }
  if (declared.startsWith("image/")) {
    return {
      bytes: new Uint8Array(await request.arrayBuffer()),
      declaredContentType: declared,
    };
  }
  return apiError(MEDIA_ONLY_IMAGES_MESSAGE);
}

/**
 * Uploads one image to the media store. Cosmetics and coin art only; nothing value-bearing.
 *
 * The accepted format is decided by the bytes, never by the client's declared type, so an
 * extension-less or mislabelled PNG uploads exactly like a well-formed one and a non-image
 * renamed to `.png` still fails.
 */
export async function uploadMedia(request: Request, env: RuntimeEnv): Promise<Response> {
  if (!(await checkRateLimit(request, env, "media", 12))) return apiError("Too many requests", 429);
  const wallet = await sessionWallet(request, env);
  if (!wallet) return apiError("Wallet session required", 401);
  const upload = await readMediaUpload(request);
  if (upload instanceof Response) return upload;
  const { bytes, declaredContentType } = upload;
  if (bytes.byteLength === 0) return apiError("Empty upload");
  if (bytes.byteLength > MEDIA_MAX_BYTES) return apiError(MEDIA_TOO_LARGE_MESSAGE, 413);
  if (declaredContentType?.toLowerCase() === "image/svg+xml") {
    return apiError("SVG is not supported; upload a PNG, JPEG, WebP or GIF");
  }
  const image = sniffImageFormat(bytes);
  if (!image) return apiError(MEDIA_ONLY_IMAGES_MESSAGE);
  const key = `${wallet.slice(0, 8)}-${crypto.randomUUID()}.${image.extension}`;
  await env.TOKEN_CACHE.put(`media:${key}`, bytes, {
    metadata: { contentType: image.contentType, wallet, uploadedAt: nowSeconds() },
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
