import { DurableObject } from "cloudflare:workers";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";
import { normalizeHeliusEvent } from "../shared/helius";
import {
  DISCOVERY_DEFAULTS,
  GAMEPLAY_DEFAULTS,
  crewPower,
  crewTier,
  discoveryEligible,
  discoveryTokenAmount,
  discoveryValueUsd,
  maturityBps,
  nextStreak,
  oreCapacity,
  oreForActiveSeconds,
  rollDiscoveryRarity,
  upgradeOreCost,
  type CrewComponent,
  type CrewLevels,
} from "../shared/economics";

import type {
  ActivationState,
  DiscoveryRecord,
  IndexingEvent,
  LaunchRequest,
  MarketSnapshot,
  MarketTrade,
  MiningReport,
  PlayerProfile,
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

interface PlayerRow {
  wallet: string;
  created_at: number;
  miners_level: number;
  drills_level: number;
  carts_level: number;
  foreman_level: number;
  storage_level: number;
  ore_balance: number;
  streak: number;
  streak_freezes: number;
  active_days: number;
  active_mint: string | null;
  last_activation_at: number | null;
  activation_expires_at: number | null;
  ore_collected_at: number | null;
  risk_state: "NORMAL" | "UNDER_REVIEW" | "HELD" | "BLOCKED";
  risk_score: number;
}

function crewLevelsOf(row: PlayerRow): CrewLevels {
  return {
    miners: row.miners_level,
    drills: row.drills_level,
    carts: row.carts_level,
    foreman: row.foreman_level,
    storage: row.storage_level,
  };
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

/**
 * A second, independent rate-limit dimension keyed by wallet rather than IP.
 * Anti-bot invariant: a single wallet cannot hammer daily-activation, crew
 * upgrade or discovery endpoints just because it rotates source IPs, and a
 * single IP/device cannot be the only signal that gates many wallets either
 * — see checkRateLimit for the IP dimension. Both must pass.
 */
async function checkWalletRateLimit(
  env: RuntimeEnv,
  wallet: string,
  bucket: string,
  limit: number,
  windowSeconds = 60,
): Promise<boolean> {
  const windowId = Math.floor(Date.now() / (windowSeconds * 1_000));
  const key = `rate:${bucket}:${wallet}:${windowId}`;
  const count = Number((await env.TOKEN_CACHE.get(key)) ?? "0");
  if (count >= limit) return false;
  await env.TOKEN_CACHE.put(key, String(count + 1), { expirationTtl: windowSeconds * 2 });
  return true;
}

async function recordRiskEvent(env: RuntimeEnv, wallet: string, kind: string, detail?: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO risk_events (id, wallet, kind, detail) VALUES (?1, ?2, ?3, ?4)",
  )
    .bind(crypto.randomUUID(), wallet, kind, detail ?? null)
    .run();
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
      programId: env.DIGGO_PROGRAM_ID,
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
  const normalized = events.map(normalizeHeliusEvent).filter((event) => event !== null);
  if (normalized.length !== events.length || normalized.length === 0) {
    return apiError("Invalid Helius event payload", 400);
  }
  for (let index = 0; index < normalized.length; index += 100) {
    await env.INDEXING_QUEUE.sendBatch(
      normalized.slice(index, index + 100).map((body) => ({ body })),
    );
  }
  return json({ accepted: normalized.length });
}

// ---------------------------------------------------------------------------
// Mining Crew game loop (ORE, daily activation, discoveries).
//
// ORE and Crew progression are internal, non-transferable game state — they
// are never sold and never bought with SOL, USDC or a memecoin (see
// docs/ARCHITECTURE.md). This backend IS the authority for that state, same
// as it already is for launch queueing and wallet sessions above; it is
// still never authoritative for a player's actual token balance, which only
// ever moves through the Solana program (see docs/SECURITY.md).
// ---------------------------------------------------------------------------

async function getOrCreatePlayer(env: RuntimeEnv, wallet: string): Promise<PlayerRow> {
  const existing = await env.DB.prepare("SELECT * FROM players WHERE wallet = ?1").bind(wallet).first<PlayerRow>();
  if (existing) return existing;
  await env.DB.prepare("INSERT OR IGNORE INTO players (wallet) VALUES (?1)").bind(wallet).run();
  const created = await env.DB.prepare("SELECT * FROM players WHERE wallet = ?1").bind(wallet).first<PlayerRow>();
  if (!created) throw new Error("Failed to initialize player");
  return created;
}

function activationStateOf(row: PlayerRow, now: number): ActivationState {
  if (row.last_activation_at === null) return "NEVER_ACTIVATED";
  return row.activation_expires_at !== null && now < row.activation_expires_at ? "ACTIVE" : "PAUSED";
}

function rowToProfile(row: PlayerRow, now: number): PlayerProfile {
  const levels = crewLevelsOf(row);
  const accountAgeSeconds = Math.max(0, now - row.created_at);
  return {
    wallet: row.wallet,
    createdAt: row.created_at,
    crewLevels: levels,
    power: crewPower(levels),
    oreBalance: row.ore_balance,
    oreCapacity: oreCapacity(levels),
    streak: row.streak,
    streakFreezes: row.streak_freezes,
    activationState: activationStateOf(row, now),
    lastActivationAt: row.last_activation_at,
    activationExpiresAt: row.activation_expires_at,
    activeMint: row.active_mint,
    accountAgeSeconds,
    maturityBps: maturityBps(accountAgeSeconds),
    discoveryEligible: discoveryEligible(accountAgeSeconds, row.active_days, crewTier(levels).tier),
    riskState: row.risk_state,
  };
}

async function activateChallenge(request: Request, env: RuntimeEnv): Promise<Response> {
  if (!(await checkRateLimit(request, env, "mine-activate"))) return apiError("Too many requests", 429);
  const { wallet } = await readJson<{ wallet?: string }>(request);
  if (!isBase58Address(wallet)) return apiError("Invalid Solana wallet");
  if (!(await checkWalletRateLimit(env, wallet, "mine-activate", 6, 300))) {
    return apiError("Too many activation attempts, slow down", 429);
  }
  const nonce = crypto.randomUUID();
  const message = [
    "Activate Diggo Mining Crew",
    `Wallet: ${wallet}`,
    `Nonce: ${nonce}`,
    "This request does not trigger a blockchain transaction.",
  ].join("\n");
  await env.TOKEN_CACHE.put(
    `activate:challenge:${nonce}`,
    JSON.stringify({ wallet, message } satisfies ChallengeRecord),
    { expirationTtl: 300 },
  );
  return json({ nonce, message });
}

async function pickDiscoveryTarget(
  env: RuntimeEnv,
  excludeMint: string | null,
): Promise<{ mint: string; symbol: string; priceUsd: number } | null> {
  const row = await env.DB.prepare(
    "SELECT mint, symbol, price_usd FROM tokens WHERE status = 'MINING_ACTIVE' AND market_cap_usd >= ?1 AND mint != ?2 ORDER BY RANDOM() LIMIT 1",
  )
    .bind(DISCOVERY_DEFAULTS.minimumMarketCapUsd, excludeMint ?? "")
    .first<{ mint: string; symbol: string; price_usd: number }>();
  return row ? { mint: row.mint, symbol: row.symbol, priceUsd: row.price_usd } : null;
}

async function discoveryBudgetRemainingUsd(
  env: RuntimeEnv,
  wallet: string,
  mint: string,
): Promise<{ ok: boolean; reason?: string }> {
  const now = Math.floor(Date.now() / 1_000);
  const [dailyWallet, weeklyWallet, dailyToken, dailyGlobal] = await env.DB.batch<{ total: number | null }>([
    env.DB.prepare("SELECT COALESCE(SUM(value_usd), 0) AS total FROM discoveries WHERE wallet = ?1 AND created_at >= ?2")
      .bind(wallet, now - 86_400),
    env.DB.prepare("SELECT COALESCE(SUM(value_usd), 0) AS total FROM discoveries WHERE wallet = ?1 AND created_at >= ?2")
      .bind(wallet, now - 604_800),
    env.DB.prepare("SELECT COALESCE(SUM(value_usd), 0) AS total FROM discoveries WHERE mint = ?1 AND created_at >= ?2")
      .bind(mint, now - 86_400),
    env.DB.prepare("SELECT COALESCE(SUM(value_usd), 0) AS total FROM discoveries WHERE created_at >= ?1")
      .bind(now - 86_400),
  ]);
  const dailyWalletUsed = dailyWallet.results[0]?.total ?? 0;
  const weeklyWalletUsed = weeklyWallet.results[0]?.total ?? 0;
  const dailyTokenUsed = dailyToken.results[0]?.total ?? 0;
  const dailyGlobalUsed = dailyGlobal.results[0]?.total ?? 0;
  if (dailyWalletUsed >= DISCOVERY_DEFAULTS.accountDailyCapUsd) return { ok: false, reason: "account_daily_cap" };
  if (weeklyWalletUsed >= DISCOVERY_DEFAULTS.accountWeeklyCapUsd) return { ok: false, reason: "account_weekly_cap" };
  if (dailyTokenUsed >= DISCOVERY_DEFAULTS.tokenDailyCapUsd) return { ok: false, reason: "token_daily_cap" };
  if (dailyGlobalUsed >= DISCOVERY_DEFAULTS.globalDailyCapUsd) return { ok: false, reason: "global_daily_cap" };
  return { ok: true };
}

/**
 * Rolls a server-authoritative discovery for an already-eligible, budget-clear
 * player. RNG uses crypto.getRandomValues — never frontend Math.random() —
 * because this decides a real, if small, memecoin reward (see
 * ARCHITECTURE.md "RNG security"). Returns null when no discovery target
 * qualifies or the roll simply misses (most rolls are not a discovery at all;
 * the rarity table's "common" tier is itself a small real reward, so a
 * discovery record is only created for an actual hit — see note below).
 */
async function rollDiscovery(
  env: RuntimeEnv,
  wallet: string,
  activeMint: string | null,
  discoveryChance: number,
): Promise<DiscoveryRecord | null> {
  const draw = crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
  if (draw >= discoveryChance) return null;

  const target = await pickDiscoveryTarget(env, activeMint);
  if (!target || target.priceUsd <= 0) return null;

  const budget = await discoveryBudgetRemainingUsd(env, wallet, target.mint);
  if (!budget.ok) {
    await recordRiskEvent(env, wallet, "discovery_budget_blocked", budget.reason);
    return null;
  }

  const rarityDraw = crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
  const rarity = rollDiscoveryRarity(rarityDraw);
  const valueUsd = Math.min(discoveryValueUsd(rarity), DISCOVERY_DEFAULTS.tokenDailyCapUsd);
  const tokenAmount = discoveryTokenAmount(valueUsd, target.priceUsd);
  if (tokenAmount <= 0) return null;

  const id = crypto.randomUUID();
  const createdAt = Math.floor(Date.now() / 1_000);
  await env.DB.prepare(
    "INSERT INTO discoveries (id, wallet, mint, symbol, rarity, token_amount, value_usd, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'ELIGIBLE', ?8)",
  )
    .bind(id, wallet, target.mint, target.symbol, rarity, tokenAmount, valueUsd, createdAt)
    .run();

  return {
    id,
    mint: target.mint,
    symbol: target.symbol,
    rarity,
    tokenAmount,
    valueUsd,
    status: "ELIGIBLE",
    createdAt,
  };
}

async function activateMine(request: Request, env: RuntimeEnv): Promise<Response> {
  if (!(await checkRateLimit(request, env, "mine-activate"))) return apiError("Too many requests", 429);
  const body = await readJson<{ wallet?: string; nonce?: string; signature?: string; mint?: string }>(request);
  if (!isBase58Address(body.wallet) || !body.nonce || !body.signature) {
    return apiError("Incomplete activation proof");
  }
  if (!(await checkWalletRateLimit(env, body.wallet, "mine-activate", 6, 300))) {
    return apiError("Too many activation attempts, slow down", 429);
  }
  const challengeKey = `activate:challenge:${body.nonce}`;
  const challenge = await env.TOKEN_CACHE.get<ChallengeRecord>(challengeKey, "json");
  if (!challenge || challenge.wallet !== body.wallet) return apiError("Challenge expired", 401);
  let validSignature = false;
  try {
    validSignature = ed25519.verify(
      bs58.decode(body.signature),
      textEncoder.encode(challenge.message),
      bs58.decode(body.wallet),
    );
  } catch {
    validSignature = false;
  }
  if (!validSignature) return apiError("Invalid wallet signature", 401);
  await env.TOKEN_CACHE.delete(challengeKey); // single-use: replay protection

  const wallet = body.wallet;
  const row = await getOrCreatePlayer(env, wallet);
  const now = Math.floor(Date.now() / 1_000);

  if (row.last_activation_at !== null && now - row.last_activation_at < GAMEPLAY_DEFAULTS.minimumReactivationSeconds) {
    return apiError(
      `Mine still active. You can reactivate in ${row.last_activation_at + GAMEPLAY_DEFAULTS.minimumReactivationSeconds - now}s.`,
      409,
    );
  }
  if (row.risk_state === "BLOCKED") return apiError("This account cannot activate mining", 403);

  const accountAgeSeconds = Math.max(0, now - row.created_at);
  const activeWindowEnd = row.activation_expires_at !== null ? Math.min(now, row.activation_expires_at) : now;
  const collectFrom = row.ore_collected_at ?? row.last_activation_at ?? now;
  const activeSeconds = Math.max(0, activeWindowEnd - collectFrom);

  const streakResult = nextStreak(row.last_activation_at, now, row.streak, row.streak_freezes);
  const levels = crewLevelsOf(row);
  const capacity = oreCapacity(levels);
  const maturity = maturityBps(accountAgeSeconds);
  const activationBonus = Math.floor((GAMEPLAY_DEFAULTS.activationOre * maturity) / 10_000);
  const oreFromMining = oreForActiveSeconds(activeSeconds, accountAgeSeconds);
  const oreGained = oreFromMining + activationBonus;
  const newOreBalance = Math.min(row.ore_balance + oreGained, capacity);
  const activeMint = body.mint ?? row.active_mint;
  const nextActiveDays = row.active_days + 1;

  let discovery: DiscoveryRecord | null = null;
  const hadPriorActiveWindow = row.last_activation_at !== null && activeSeconds >= GAMEPLAY_DEFAULTS.activationSeconds * 0.5;
  if (
    hadPriorActiveWindow &&
    row.risk_state === "NORMAL" &&
    discoveryEligible(accountAgeSeconds, nextActiveDays, crewTier(levels).tier)
  ) {
    discovery = await rollDiscovery(env, wallet, activeMint, 0.12);
  }

  await env.DB.prepare(
    `UPDATE players SET
       ore_balance = ?1,
       streak = ?2,
       streak_freezes = ?3,
       active_days = ?4,
       active_mint = ?5,
       last_activation_at = ?6,
       activation_expires_at = ?7,
       ore_collected_at = ?6
     WHERE wallet = ?8`,
  )
    .bind(
      newOreBalance,
      streakResult.streak,
      streakResult.freezes,
      nextActiveDays,
      activeMint,
      now,
      now + GAMEPLAY_DEFAULTS.activationSeconds,
      wallet,
    )
    .run();

  const report: MiningReport = {
    activeSeconds,
    oreGained: newOreBalance - row.ore_balance,
    streak: streakResult.streak,
    streakFreezes: streakResult.freezes,
    usedFreeze: streakResult.usedFreeze,
    discovery,
  };
  const updated = await env.DB.prepare("SELECT * FROM players WHERE wallet = ?1").bind(wallet).first<PlayerRow>();
  return json({ report, player: rowToProfile(updated ?? { ...row, ore_balance: newOreBalance }, now) });
}

async function crewUpgrade(request: Request, env: RuntimeEnv): Promise<Response> {
  const wallet = await sessionWallet(request, env);
  if (!wallet) return apiError("Wallet authentication required", 401);
  if (!(await checkWalletRateLimit(env, wallet, "crew-upgrade", 20, 60))) {
    return apiError("Too many upgrade requests, slow down", 429);
  }
  const { component } = await readJson<{ component?: string }>(request);
  const validComponents: CrewComponent[] = ["miners", "drills", "carts", "foreman", "storage"];
  if (!validComponents.includes(component as CrewComponent)) return apiError("Invalid crew component");

  const row = await getOrCreatePlayer(env, wallet);
  const column = `${component}_level` as const;
  const currentLevel = row[column as keyof PlayerRow] as number;
  if (currentLevel >= 100) return apiError("This crew component is already at its maximum level");
  const cost = upgradeOreCost(component as CrewComponent, currentLevel);

  const result = await env.DB.prepare(
    `UPDATE players SET ore_balance = ore_balance - ?1, ${column} = ${column} + 1
     WHERE wallet = ?2 AND ore_balance >= ?1 AND ${column} = ?3`,
  )
    .bind(cost, wallet, currentLevel)
    .run();
  if (!result.meta.changes) {
    return apiError("Not enough ORE for this upgrade, or crew state changed — try again", 409);
  }

  const updated = await env.DB.prepare("SELECT * FROM players WHERE wallet = ?1").bind(wallet).first<PlayerRow>();
  if (!updated) return apiError("Upgrade failed", 500);
  return json({ player: rowToProfile(updated, Math.floor(Date.now() / 1_000)), spent: cost });
}

async function switchMine(request: Request, env: RuntimeEnv): Promise<Response> {
  const wallet = await sessionWallet(request, env);
  if (!wallet) return apiError("Wallet authentication required", 401);
  const { mint } = await readJson<{ mint?: string }>(request);
  if (!mint) return apiError("Missing mint");
  const token = await env.DB.prepare("SELECT mint FROM tokens WHERE mint = ?1 AND status != 'FULLY_MINED'")
    .bind(mint)
    .first<{ mint: string }>();
  if (!token) return apiError("Unknown or fully mined mine", 404);

  const row = await getOrCreatePlayer(env, wallet);
  const now = Math.floor(Date.now() / 1_000);
  if (activationStateOf(row, now) !== "ACTIVE") {
    return apiError("Activate your Mining Crew before switching mines", 409);
  }
  await env.DB.prepare("UPDATE players SET active_mint = ?1 WHERE wallet = ?2").bind(mint, wallet).run();
  const updated = await env.DB.prepare("SELECT * FROM players WHERE wallet = ?1").bind(wallet).first<PlayerRow>();
  if (!updated) return apiError("Switch failed", 500);
  return json({ player: rowToProfile(updated, now) });
}

async function playerProfile(request: Request, env: RuntimeEnv, wallet: string): Promise<Response> {
  const authenticated = await sessionWallet(request, env);
  if (!authenticated || authenticated !== wallet) return apiError("Wallet authentication required", 401);
  const row = await getOrCreatePlayer(env, wallet);
  return json({ player: rowToProfile(row, Math.floor(Date.now() / 1_000)) });
}

async function listDiscoveries(request: Request, env: RuntimeEnv, wallet: string): Promise<Response> {
  const authenticated = await sessionWallet(request, env);
  if (!authenticated || authenticated !== wallet) return apiError("Wallet authentication required", 401);
  const result = await env.DB.prepare(
    "SELECT id, mint, symbol, rarity, token_amount, value_usd, status, created_at FROM discoveries WHERE wallet = ?1 ORDER BY created_at DESC LIMIT 50",
  )
    .bind(wallet)
    .all<{
      id: string;
      mint: string;
      symbol: string;
      rarity: string;
      token_amount: number;
      value_usd: number;
      status: "PENDING" | "ELIGIBLE";
      created_at: number;
    }>();
  const discoveries: DiscoveryRecord[] = result.results.map((row) => ({
    id: row.id,
    mint: row.mint,
    symbol: row.symbol,
    rarity: row.rarity,
    tokenAmount: row.token_amount,
    valueUsd: row.value_usd,
    status: row.status,
    createdAt: row.created_at,
  }));
  return json({ discoveries });
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
        programId: env.DIGGO_PROGRAM_ID,
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
    if (request.method === "POST" && pathname === "/api/mine/activate/challenge") {
      return activateChallenge(request, env);
    }
    if (request.method === "POST" && pathname === "/api/mine/activate") {
      return activateMine(request, env);
    }
    if (request.method === "POST" && pathname === "/api/crew/upgrade") {
      return crewUpgrade(request, env);
    }
    if (request.method === "POST" && pathname === "/api/mine/switch") {
      return switchMine(request, env);
    }
    const playerMatch = pathname.match(/^\/api\/player\/([^/]+)$/);
    if (request.method === "GET" && playerMatch) return playerProfile(request, env, playerMatch[1]);
    const discoveriesMatch = pathname.match(/^\/api\/player\/([^/]+)\/discoveries$/);
    if (request.method === "GET" && discoveriesMatch) return listDiscoveries(request, env, discoveriesMatch[1]);
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
    await env.DB.prepare(
      "INSERT OR IGNORE INTO chain_events (signature, event_type, mint, payload, block_time) VALUES (?1, ?2, ?3, ?4, ?5)",
    )
      .bind(
        event.signature,
        `HELIUS_${event.eventType}`,
        event.mint,
        JSON.stringify({ ...event.payload, diggoSource: event.source, diggoSlot: event.slot }),
        event.timestamp,
      )
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

async function queueEpochSync(env: RuntimeEnv): Promise<number> {
  const result = await env.DB.prepare("SELECT mint FROM tokens WHERE status = 'MINING_ACTIVE'").all<{
    mint: string;
  }>();
  const timestamp = Date.now();
  for (let index = 0; index < result.results.length; index += 100) {
    await env.INDEXING_QUEUE.sendBatch(
      result.results.slice(index, index + 100).map(({ mint }) => ({
        body: { type: "epoch_sync", mint, timestamp } satisfies IndexingEvent,
      })),
    );
  }
  return result.results.length;
}

export default {
  fetch: handleFetch,
  async scheduled(_controller: ScheduledController, env: RuntimeEnv): Promise<void> {
    const queued = await queueEpochSync(env);
    console.log(JSON.stringify({ event: "epoch.cron", queued }));
  },
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
