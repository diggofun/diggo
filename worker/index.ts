import {
  DurableObject,
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";

import type {
  IndexingEvent,
  LaunchRequest,
  MarketSnapshot,
  MarketTrade,
  TokenStatus,
  TokenSummary,
} from "../shared/types";

interface SecretBindings {
  TURNSTILE_SECRET?: string;
  HELIUS_WEBHOOK_AUTH?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
}

interface CloudflareSubtleCrypto extends SubtleCrypto {
  timingSafeEqual(a: ArrayBufferView, b: ArrayBufferView): boolean;
}

type RuntimeEnv = Env & SecretBindings;

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
  change_24h: number;
  market_cap_usd: number;
  reserve_remaining: number;
  reserve_total: number;
  reward_per_block: number;
  network_power: number;
  next_block_at: number;
  next_epoch_at: number;
  created_at: number;
}

interface ChallengeRecord {
  wallet: string;
  message: string;
}

interface EpochParams {
  source?: string;
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

const TOKEN_CACHE_KEY = "tokens:v2:1000";
const MAX_BOOTSTRAP_TOKENS = 1_000;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const SUPABASE_MEDIA_BUCKET = "token-media";
const IMAGE_CONTENT_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const textEncoder = new TextEncoder();

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { ...JSON_HEADERS, ...init.headers },
  });
}

function apiError(message: string, status = 400): Response {
  return json({ error: message }, { status });
}

function mapToken(row: TokenRow): TokenSummary {
  const now = Math.floor(Date.now() / 1_000);
  const nextBlockAt =
    row.next_block_at > now ? row.next_block_at : now + (300 - ((now - row.next_block_at) % 300));
  const nextEpochAt =
    row.next_epoch_at > now
      ? row.next_epoch_at
      : now + (604_800 - ((now - row.next_epoch_at) % 604_800));
  return {
    mint: row.mint,
    slug: row.slug,
    name: row.name,
    symbol: row.symbol,
    description: row.description,
    creator: row.creator,
    imageUrl: row.image_key ? `/media/${row.image_key}` : null,
    status: row.status,
    priceUsd: row.price_usd,
    change24h: row.change_24h,
    marketCapUsd: row.market_cap_usd,
    reserveRemaining: row.reserve_remaining,
    reserveTotal: row.reserve_total,
    rewardPerBlock: row.reward_per_block,
    networkPower: row.network_power,
    nextBlockAt,
    nextEpochAt,
    createdAt: row.created_at,
  };
}

function isBase58Address(value: unknown): value is string {
  return typeof value === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

function sameSecret(received: string | null, expected: string | undefined): boolean {
  if (!received || !expected) return false;
  const left = textEncoder.encode(received);
  const right = textEncoder.encode(expected);
  const subtle = crypto.subtle as CloudflareSubtleCrypto;
  return left.byteLength === right.byteLength && subtle.timingSafeEqual(left, right);
}

async function readJson<T>(request: Request, maxBytes = 32_768): Promise<T> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > maxBytes) throw new Error("Payload too large");
  const raw = await request.text();
  if (raw.length > maxBytes) throw new Error("Payload too large");
  return JSON.parse(raw) as T;
}

async function checkRateLimit(request: Request, env: RuntimeEnv, bucket: string): Promise<boolean> {
  const ip = request.headers.get("cf-connecting-ip") ?? "local";
  const windowId = Math.floor(Date.now() / 60_000);
  const key = `rate:${bucket}:${ip}:${windowId}`;
  const count = Number((await env.TOKEN_CACHE.get(key)) ?? "0");
  if (count >= 12) return false;
  await env.TOKEN_CACHE.put(key, String(count + 1), { expirationTtl: 120 });
  return true;
}

async function verifyTurnstile(
  token: string,
  request: Request,
  env: RuntimeEnv,
): Promise<boolean> {
  const hostname = new URL(request.url).hostname;
  if ((hostname === "localhost" || hostname === "127.0.0.1") && token === "dev-bypass") {
    return true;
  }
  if (!env.TURNSTILE_SECRET || !token) return false;
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      secret: env.TURNSTILE_SECRET,
      response: token,
      remoteip: request.headers.get("cf-connecting-ip") ?? undefined,
      idempotency_key: crypto.randomUUID(),
    }),
  });
  const result = (await response.json()) as { success?: boolean; hostname?: string };
  return result.success === true;
}

async function sessionWallet(request: Request, env: RuntimeEnv): Promise<string | null> {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return env.TOKEN_CACHE.get(`auth:session:${header.slice(7)}`);
}

function tokenLimit(value: string | null): number {
  const parsed = Number(value ?? MAX_BOOTSTRAP_TOKENS);
  if (!Number.isFinite(parsed)) return MAX_BOOTSTRAP_TOKENS;
  return Math.min(Math.max(Math.trunc(parsed), 1), MAX_BOOTSTRAP_TOKENS);
}

async function loadTokens(
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

async function listTokens(
  env: RuntimeEnv,
  ctx: ExecutionContext,
  limit: number,
): Promise<Response> {
  return json(await loadTokens(env, ctx, limit));
}

async function bootstrap(
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
      vanitySuffix: env.VANITY_SUFFIX,
    },
  });
}

async function tokenBySlug(slug: string, env: RuntimeEnv): Promise<Response> {
  const row = await env.DB.prepare("SELECT * FROM tokens WHERE slug = ?1 OR mint = ?1")
    .bind(slug)
    .first<TokenRow>();
  return row ? json({ token: mapToken(row) }) : apiError("Token not found", 404);
}

async function createChallenge(request: Request, env: RuntimeEnv): Promise<Response> {
  if (!(await checkRateLimit(request, env, "auth"))) return apiError("Too many requests", 429);
  const { wallet } = await readJson<{ wallet?: string }>(request);
  if (!isBase58Address(wallet)) return apiError("Invalid Solana wallet");
  const nonce = crypto.randomUUID();
  const message = [
    "Sign in to Diggo.fun",
    `Wallet: ${wallet}`,
    `Nonce: ${nonce}`,
    "This request does not trigger a blockchain transaction.",
  ].join("\n");
  await env.TOKEN_CACHE.put(
    `auth:challenge:${nonce}`,
    JSON.stringify({ wallet, message } satisfies ChallengeRecord),
    { expirationTtl: 300 },
  );
  return json({ nonce, message });
}

async function verifyWallet(request: Request, env: RuntimeEnv): Promise<Response> {
  if (!(await checkRateLimit(request, env, "auth"))) return apiError("Too many requests", 429);
  const body = await readJson<{ wallet?: string; nonce?: string; signature?: string }>(request);
  if (!isBase58Address(body.wallet) || !body.nonce || !body.signature) {
    return apiError("Incomplete wallet proof");
  }
  const challenge = await env.TOKEN_CACHE.get<ChallengeRecord>(
    `auth:challenge:${body.nonce}`,
    "json",
  );
  if (!challenge || challenge.wallet !== body.wallet) return apiError("Challenge expired", 401);
  let valid = false;
  try {
    valid = ed25519.verify(
      bs58.decode(body.signature),
      textEncoder.encode(challenge.message),
      bs58.decode(body.wallet),
    );
  } catch {
    valid = false;
  }
  if (!valid) return apiError("Invalid wallet signature", 401);
  await env.TOKEN_CACHE.delete(`auth:challenge:${body.nonce}`);
  const session = crypto.randomUUID().replaceAll("-", "");
  await env.TOKEN_CACHE.put(`auth:session:${session}`, body.wallet, { expirationTtl: 3_600 });
  return json({ session, wallet: body.wallet, expiresIn: 3_600 });
}

async function uploadMedia(request: Request, env: RuntimeEnv): Promise<Response> {
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

async function createLaunch(request: Request, env: RuntimeEnv): Promise<Response> {
  if (!(await checkRateLimit(request, env, "launch"))) return apiError("Too many requests", 429);
  const wallet = await sessionWallet(request, env);
  if (!wallet) return apiError("Wallet authentication required", 401);
  const body = await readJson<Partial<LaunchRequest>>(request);
  if (body.creator !== wallet) return apiError("Creator must match authenticated wallet", 403);
  if (!body.name || body.name.length > 32) return apiError("Name must be 1–32 characters");
  if (!body.symbol || !/^[A-Z0-9]{2,10}$/.test(body.symbol)) {
    return apiError("Ticker must contain 2–10 uppercase letters or digits");
  }
  if (!body.description || body.description.length > 280) {
    return apiError("Description must be 1–280 characters");
  }
  if (!(await verifyTurnstile(body.turnstileToken ?? "", request, env))) {
    return apiError("Turnstile verification failed", 403);
  }
  const id = crypto.randomUUID();
  const imageKey = body.imageUrl?.startsWith("/media/") ? body.imageUrl.slice(7) : null;
  await env.DB.prepare(
    "INSERT INTO launch_requests (id, creator, name, symbol, description, image_key, vanity_suffix) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
  )
    .bind(id, wallet, body.name.trim(), body.symbol, body.description.trim(), imageKey, env.VANITY_SUFFIX)
    .run();
  console.log(JSON.stringify({ event: "launch.queued", id, wallet, symbol: body.symbol }));
  return json(
    {
      id,
      status: "QUEUED",
      vanitySuffix: env.VANITY_SUFFIX,
      message: `Vanity mint generation queued. The final address must end in ${env.VANITY_SUFFIX}.`,
    },
    { status: 202 },
  );
}

async function heliusWebhook(request: Request, env: RuntimeEnv): Promise<Response> {
  if (!sameSecret(request.headers.get("authorization"), env.HELIUS_WEBHOOK_AUTH)) {
    return apiError("Unauthorized", 401);
  }
  const payload = await readJson<unknown>(request, 1_000_000);
  const events = Array.isArray(payload) ? payload : [payload];
  await env.INDEXING_QUEUE.sendBatch(
    events.map((item) => ({
      body: {
        type: "helius",
        payload: typeof item === "object" && item !== null ? item : { value: item },
      } satisfies IndexingEvent,
    })),
  );
  return json({ accepted: events.length }, { status: 202 });
}

async function serveMedia(pathname: string, env: RuntimeEnv): Promise<Response> {
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

async function handleFetch(request: Request, env: RuntimeEnv, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  try {
    if (request.method === "GET" && pathname === "/api/config") {
      return json({
        cluster: env.SOLANA_CLUSTER,
        posthogApiKey: env.POSTHOG_API_KEY,
        posthogHost: env.POSTHOG_HOST,
        turnstileSiteKey: env.TURNSTILE_SITE_KEY,
        vanitySuffix: env.VANITY_SUFFIX,
      });
    }
    if (request.method === "GET" && pathname === "/api/bootstrap") {
      return bootstrap(env, ctx, tokenLimit(url.searchParams.get("limit")));
    }
    if (request.method === "GET" && pathname === "/api/tokens") {
      return listTokens(env, ctx, tokenLimit(url.searchParams.get("limit")));
    }
    const tokenMatch = pathname.match(/^\/api\/tokens\/([^/]+)$/);
    if (request.method === "GET" && tokenMatch) return tokenBySlug(tokenMatch[1], env);
    const liveMatch = pathname.match(/^\/api\/tokens\/([^/]+)\/live$/);
    if (request.method === "GET" && liveMatch) {
      const market = env.MARKETS.getByName(liveMatch[1]);
      return market.fetch(request);
    }
    if (request.method === "POST" && pathname === "/api/auth/challenge") {
      return createChallenge(request, env);
    }
    if (request.method === "POST" && pathname === "/api/auth/verify") {
      return verifyWallet(request, env);
    }
    if (request.method === "POST" && pathname === "/api/media") return uploadMedia(request, env);
    if (request.method === "POST" && pathname === "/api/tokens") return createLaunch(request, env);
    if (request.method === "POST" && pathname === "/webhooks/helius") {
      return heliusWebhook(request, env);
    }
    if (request.method === "GET" && pathname.startsWith("/media/")) return serveMedia(pathname, env);
    if (pathname.startsWith("/api/") || pathname.startsWith("/webhooks/")) {
      return apiError("Route not found", 404);
    }
    return env.ASSETS.fetch(request);
  } catch (error) {
    const requestId = crypto.randomUUID();
    console.error(JSON.stringify({ event: "request.failed", requestId, pathname, error: String(error) }));
    return json({ error: "Request failed", requestId }, { status: 500 });
  }
}

async function processQueueEvent(event: IndexingEvent, env: RuntimeEnv): Promise<void> {
  if (event.type === "trade") {
    const { trade, mint } = event;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO trades (signature, mint, side, price_usd, amount, block_time) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      ).bind(trade.signature, mint, trade.side, trade.priceUsd, trade.amount, trade.timestamp),
      env.DB.prepare("UPDATE tokens SET price_usd = ?1 WHERE mint = ?2").bind(trade.priceUsd, mint),
    ]);
    const market = env.MARKETS.getByName(mint);
    await market.applyTrade(trade);
    await env.TOKEN_CACHE.delete(TOKEN_CACHE_KEY);
    return;
  }
  if (event.type === "helius") {
    const signature = typeof event.payload.signature === "string" ? event.payload.signature : crypto.randomUUID();
    const mint = typeof event.payload.mint === "string" ? event.payload.mint : "unknown";
    const blockTime = typeof event.payload.timestamp === "number" ? event.payload.timestamp : null;
    await env.DB.prepare(
      "INSERT OR IGNORE INTO chain_events (signature, event_type, mint, payload, block_time) VALUES (?1, 'HELIUS', ?2, ?3, ?4)",
    )
      .bind(signature, mint, JSON.stringify(event.payload), blockTime)
      .run();
    return;
  }
  await env.TOKEN_CACHE.delete(TOKEN_CACHE_KEY);
  console.log(JSON.stringify({ event: "epoch.sync", mint: event.mint, timestamp: event.timestamp }));
}

export class TokenMarket extends DurableObject<RuntimeEnv> {
  constructor(ctx: DurableObjectState, env: RuntimeEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS trades (
          signature TEXT PRIMARY KEY,
          side TEXT NOT NULL,
          price_usd REAL NOT NULL,
          amount REAL NOT NULL,
          timestamp INTEGER NOT NULL
        )
      `);
    });
  }

  async applyTrade(trade: MarketTrade): Promise<void> {
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO trades VALUES (?, ?, ?, ?, ?)",
      trade.signature,
      trade.side,
      trade.priceUsd,
      trade.amount,
      trade.timestamp,
    );
    const message = JSON.stringify({ type: "trade", trade });
    for (const socket of this.ctx.getWebSockets()) socket.send(message);
  }

  async snapshot(): Promise<MarketSnapshot> {
    const trades = this.ctx.storage.sql
      .exec<{
        signature: string;
        side: "buy" | "sell";
        price_usd: number;
        amount: number;
        timestamp: number;
      }>("SELECT * FROM trades ORDER BY timestamp DESC LIMIT 25")
      .toArray();
    const recentTrades = trades.map((trade) => ({
      signature: trade.signature,
      side: trade.side,
      priceUsd: trade.price_usd,
      amount: trade.amount,
      timestamp: trade.timestamp,
    }));
    return {
      mint: this.ctx.id.toString(),
      priceUsd: recentTrades[0]?.priceUsd ?? 0,
      volume24h: recentTrades.reduce((sum, trade) => sum + trade.amount * trade.priceUsd, 0),
      lastTradeAt: recentTrades[0]?.timestamp ?? null,
      recentTrades,
    };
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade") !== "websocket") return apiError("WebSocket required", 426);
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].send(JSON.stringify({ type: "snapshot", snapshot: await this.snapshot() }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  webSocketMessage(socket: WebSocket, message: ArrayBuffer | string): void {
    if (message === "ping") socket.send("pong");
  }
}

export class EpochWorkflow extends WorkflowEntrypoint<RuntimeEnv, EpochParams> {
  async run(_event: WorkflowEvent<EpochParams>, step: WorkflowStep): Promise<{ queued: number }> {
    const mints = await step.do("load active mines", async () => {
      const result = await this.env.DB.prepare(
        "SELECT mint FROM tokens WHERE status = 'MINING_ACTIVE'",
      ).all<{ mint: string }>();
      return result.results.map((row) => row.mint);
    });
    await step.do("request chain synchronization", async () => {
      await this.env.INDEXING_QUEUE.sendBatch(
        mints.map((mint) => ({
          body: { type: "epoch_sync", mint, timestamp: Date.now() } satisfies IndexingEvent,
        })),
      );
    });
    return { queued: mints.length };
  }
}

export default {
  fetch: handleFetch,
  async queue(batch: MessageBatch<IndexingEvent>, env: RuntimeEnv): Promise<void> {
    for (const message of batch.messages) {
      try {
        await processQueueEvent(message.body, env);
        message.ack();
      } catch (error) {
        console.error(JSON.stringify({ event: "queue.failed", id: message.id, error: String(error) }));
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<RuntimeEnv, IndexingEvent>;
