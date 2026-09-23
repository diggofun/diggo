/**
 * Token/mine reads and writes: the cached token list, per-slug lookup, launch registration,
 * artwork upload/delivery and trade recording. On-chain reads via ./chain stay authoritative;
 * D1 and KV are only ever a cache of them.
 */
import type { TokenStatus, TokenSummary } from "../shared/types";
import { sessionWallet } from "./auth";
import { getChainRpc, readTokenFromChain, syncTokenToD1 } from "./chain";
import type { RuntimeEnv } from "./env";
import { apiError, checkRateLimit, isBase58Address, json, readJson } from "./http";

interface TokenRow {
  mint: string;
  slug: string;
  name: string;
  symbol: string;
  description: string;
  creator: string;
  image_key: string | null;
  status: TokenStatus;
  price_usd: number;
  price_sol: number;
  change_24h: number;
  market_cap_usd: number;
  reserve_remaining: number;
  reserve_total: number;
  reward_per_block: number;
  network_power: number;
  next_block_at: number;
  next_epoch_at: number;
  created_at: number;
  decimals: number;
}

export const TOKEN_CACHE_KEY = "tokens:v2:1000";
const MAX_BOOTSTRAP_TOKENS = 1_000;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const SUPABASE_MEDIA_BUCKET = "token-media";
const IMAGE_CONTENT_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

function mapToken(row: TokenRow): TokenSummary {
  // next_block_at / next_epoch_at are real on-chain timestamps refreshed every 5 minutes by
  // the cron sync (see syncAllTokensFromChain) — they are not advanced synthetically here.
  return {
    mint: row.mint,
    slug: row.slug,
    name: row.name,
    symbol: row.symbol,
    description: row.description,
    creator: row.creator,
    imageUrl: row.image_key ? `/media/${row.image_key}` : null,
    status: row.status,
    priceSol: row.price_sol,
    priceUsd: row.price_usd,
    change24h: row.change_24h,
    marketCapUsd: row.market_cap_usd,
    reserveRemaining: row.reserve_remaining,
    reserveTotal: row.reserve_total,
    rewardPerBlock: row.reward_per_block,
    networkPower: row.network_power,
    nextBlockAt: row.next_block_at,
    nextEpochAt: row.next_epoch_at,
    createdAt: row.created_at,
    decimals: row.decimals,
  };
}

export function tokenLimit(value: string | null): number {
  const parsed = Number(value ?? MAX_BOOTSTRAP_TOKENS);
  if (!Number.isFinite(parsed)) return MAX_BOOTSTRAP_TOKENS;
  return Math.min(Math.max(Math.trunc(parsed), 1), MAX_BOOTSTRAP_TOKENS);
}

export async function loadTokens(
  env: RuntimeEnv,
  ctx: ExecutionContext,
  limit: number,
): Promise<{ tokens: TokenSummary[]; source: "kv" | "d1" }> {
  const cached = await env.TOKEN_CACHE.get<TokenSummary[]>(TOKEN_CACHE_KEY, "json");
  if (cached) return { tokens: cached.slice(0, limit), source: "kv" };
  const result = await env.DB.prepare(
    "SELECT * FROM tokens ORDER BY CASE status WHEN 'MINING_ACTIVE' THEN 0 WHEN 'LAUNCHING' THEN 1 ELSE 2 END, market_cap_usd DESC LIMIT ?1",
  ).bind(MAX_BOOTSTRAP_TOKENS).all<TokenRow>();
  const tokens = result.results.map(mapToken);
  ctx.waitUntil(env.TOKEN_CACHE.put(TOKEN_CACHE_KEY, JSON.stringify(tokens), { expirationTtl: 60 }));
  return { tokens: tokens.slice(0, limit), source: "d1" };
}

export async function listTokens(
  env: RuntimeEnv,
  ctx: ExecutionContext,
  limit: number,
): Promise<Response> {
  return json(await loadTokens(env, ctx, limit));
}

export async function bootstrap(
  env: RuntimeEnv,
  ctx: ExecutionContext,
  limit: number,
): Promise<Response> {
  const tokenData = await loadTokens(env, ctx, limit);
  return json({
    ...tokenData,
    config: {
      cluster: env.SOLANA_CLUSTER,
      posthogApiKey: env.POSTHOG_API_KEY,
      posthogHost: env.POSTHOG_HOST,
      turnstileSiteKey: env.TURNSTILE_SITE_KEY,
      programId: env.DIGGO_PROGRAM_ID,
      vanitySuffix: env.VANITY_SUFFIX,
    },
  });
}

export async function tokenBySlug(slug: string, env: RuntimeEnv): Promise<Response> {
  const row = await env.DB.prepare("SELECT * FROM tokens WHERE slug = ?1 OR mint = ?1")
    .bind(slug)
    .first<TokenRow>();
  return row ? json({ token: mapToken(row) }) : apiError("Token not found", 404);
}

export async function uploadMedia(request: Request, env: RuntimeEnv): Promise<Response> {
  const wallet = await sessionWallet(request, env);
  if (!wallet) return apiError("Wallet authentication required", 401);
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File) || !IMAGE_CONTENT_TYPES.has(file.type)) {
    return apiError("Select a PNG, JPEG, or WebP image");
  }
  if (file.size > MAX_IMAGE_BYTES) return apiError("Image must be 2 MB or smaller", 413);
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return apiError("Token artwork uploads are not configured", 503);
  const extension = file.name.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") || "bin";
  const key = `uploads/${wallet}/${crypto.randomUUID()}.${extension}`;
  const response = await fetch(`${env.SUPABASE_URL}/storage/v1/object/${SUPABASE_MEDIA_BUCKET}/${key}`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": file.type,
      "x-upsert": "false",
    },
    body: file.stream(),
  });
  if (!response.ok) {
    console.warn(JSON.stringify({ event: "media.upload_failed", status: response.status }));
    return apiError("Artwork upload failed", 502);
  }
  return json({ key, url: `/media/${key}` }, { status: 201 });
}

/**
 * Registers a token the caller's own wallet just launched directly on-chain (see
 * src/solanaProgram.ts — the frontend builds and sends the launch_token transaction itself;
 * there is no server-side vanity-mint queue any more, since the mint is a PDA and cannot be
 * ground for a vanity suffix). This endpoint never invents data: it reads the Mine/LaunchMarket
 * accounts straight from chain and refuses to proceed if they don't exist yet, and it only
 * accepts creator-supplied metadata (description/artwork) after confirming the session wallet
 * matches the on-chain creator recorded in the Mine account.
 */
export async function registerLaunchedToken(request: Request, env: RuntimeEnv): Promise<Response> {
  if (!(await checkRateLimit(request, env, "register"))) return apiError("Too many requests", 429);
  const wallet = await sessionWallet(request, env);
  if (!wallet) return apiError("Wallet authentication required", 401);
  const body = await readJson<{ mint?: string; description?: string; imageUrl?: string }>(request);
  if (!isBase58Address(body.mint)) return apiError("Invalid mint address");
  if (body.description !== undefined && body.description.length > 280) {
    return apiError("Description must be 280 characters or fewer");
  }

  let chainCreator: string;
  try {
    chainCreator = (await readTokenFromChain(env, body.mint)).creator;
  } catch {
    return apiError("This mint has not launched on-chain yet — wait for the transaction to confirm and retry", 404);
  }
  if (chainCreator !== wallet) return apiError("Only the launch creator can register this token", 403);

  const imageKey = body.imageUrl?.startsWith("/media/") ? body.imageUrl.slice(7) : null;
  const token = await syncTokenToD1(env, body.mint, {
    description: body.description?.trim() ?? "",
    imageKey,
  });
  await env.DB.prepare(
    "INSERT INTO launch_requests (id, creator, name, symbol, description, image_key, vanity_suffix, status, mint) VALUES (?1,?2,?3,?4,?5,?6,?7,'LAUNCHED',?8)",
  )
    .bind(crypto.randomUUID(), wallet, token.name, token.symbol, token.description, imageKey, env.VANITY_SUFFIX, body.mint)
    .run();
  await env.TOKEN_CACHE.delete(TOKEN_CACHE_KEY);
  console.log(JSON.stringify({ event: "launch.registered", wallet, mint: body.mint, symbol: token.symbol }));
  return json({ token }, { status: 201 });
}

/**
 * Records a trade the caller's own wallet just executed on-chain (buy or sell against a mine's
 * bonding curve — see src/solanaProgram.ts) so the DiggoSwap chart has something to draw. This
 * only feeds display data, never account/reward state, so verification is deliberately light:
 * confirm the signature is a real, successful, recent transaction before trusting its side/amount.
 * price/market_cap in the `tokens` row are always re-derived from a fresh on-chain read, never
 * from the client-supplied price.
 */
export async function recordTrade(request: Request, env: RuntimeEnv, mint: string): Promise<Response> {
  if (!(await checkRateLimit(request, env, "trade-record", 60))) return apiError("Too many requests", 429);
  const body = await readJson<{ signature?: string; side?: "buy" | "sell"; amount?: number }>(request);
  if (!body.signature || (body.side !== "buy" && body.side !== "sell") || typeof body.amount !== "number") {
    return apiError("Invalid trade payload");
  }
  const rpc = getChainRpc(env);
  let confirmed = false;
  try {
    const status = await rpc
      .getSignatureStatuses([body.signature as never])
      .send();
    const value = status.value[0];
    confirmed = value !== null && value.err === null && value.confirmationStatus !== null;
  } catch {
    // A failed RPC leaves confirmed false, so the trade is rejected below.
  }
  if (!confirmed) return apiError("Transaction is not a confirmed on-chain signature", 400);

  let chain;
  try {
    chain = await readTokenFromChain(env, mint);
  } catch {
    return apiError("Unknown mint", 404);
  }

  const timestamp = Math.floor(Date.now() / 1_000);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO trades (signature, mint, side, price_usd, price_sol, amount, block_time) VALUES (?1,?2,?3,?4,?5,?6,?7)",
    ).bind(body.signature, mint, body.side, chain.priceUsd, chain.priceSol, body.amount, timestamp),
    env.DB.prepare("UPDATE tokens SET price_usd = ?1, price_sol = ?2, market_cap_usd = ?3 WHERE mint = ?4").bind(
      chain.priceUsd,
      chain.priceSol,
      chain.marketCapUsd,
      mint,
    ),
  ]);
  const market = env.MARKETS.getByName(mint);
  await market.applyTrade({
    signature: body.signature,
    side: body.side,
    priceSol: chain.priceSol,
    priceUsd: chain.priceUsd,
    amount: body.amount,
    timestamp,
  });
  await env.TOKEN_CACHE.delete(TOKEN_CACHE_KEY);
  return json({ ok: true, priceUsd: chain.priceUsd, priceSol: chain.priceSol });
}

export async function serveMedia(pathname: string, env: RuntimeEnv): Promise<Response> {
  const key = decodeURIComponent(pathname.slice("/media/".length));
  if (!key || key.includes("..")) return apiError("Invalid media key");
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return apiError("Media delivery is not configured", 503);
  const response = await fetch(`${env.SUPABASE_URL}/storage/v1/object/${SUPABASE_MEDIA_BUCKET}/${key}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (response.status === 404) return apiError("Media not found", 404);
  if (!response.ok) return apiError("Media delivery failed", 502);
  const headers = new Headers();
  headers.set("content-type", response.headers.get("content-type") ?? "application/octet-stream");
  const etag = response.headers.get("etag");
  if (etag) headers.set("etag", etag);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  return new Response(response.body, { headers });
}
