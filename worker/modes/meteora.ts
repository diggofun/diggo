import { address } from "@solana/kit";
import { sessionWallet } from "../auth";
import { d1GameStore } from "../game/d1-store";
import {
  getPlayerGameState,
  handleActivate,
  handleActivationChallenge,
  handleClaim,
  handleDiscovery,
  handleUpgrade,
  type GameHandlerContext,
  type PlayerGameState,
} from "../game/service";
import { gameChainMode, type GameCoin, type GameCoinSource, type GameEnv, type GamePlayerState, type GamePortfolioSource, type GameServices, type GameWalletSource, type MiningPayout } from "../game/contracts";
import { accrueMining, playerCrewPower, releasedMiningAllocation } from "../game/rules";
import { getSolUsd } from "../oracle";
import { apiError, checkRateLimit, checkWalletRateLimit, isBase58Address, json } from "../http";
import { getChainRpc, LAMPORTS_PER_SOL } from "../chainV2";
import { payMiningClaim, runMeteoraIndexer, runVaultSweep } from "../meteora";
import { readSignatures } from "../meteora/rpc";

const METEORA_RPC_FALLBACK = "https://api.devnet.solana.com";
type RuntimeEnvLike = GameEnv;
const lastGoodStates = new Map<string, PlayerGameState>();

function stateCacheKey(env: RuntimeEnvLike, wallet: string): string {
  return [String(env.SOLANA_CLUSTER || "devnet"), String(env.METEORA_DBC_CONFIG || ""), wallet].join(":");
}

function offlineContext(env: RuntimeEnvLike): GameHandlerContext {
  const context = meteoraGameContext(env);
  return {
    ...context,
    services: {
      ...context.services,
      wallet: { async walletCreatedAt() { return null; } },
      portfolio: { async portfolioUsd() { return 0; } },
    },
  };
}

function emptyPlayerState(env: RuntimeEnvLike, wallet: string): PlayerGameState {
  const player: GamePlayerState = {
    wallet,
    createdAt: nowSeconds(),
    oreBalance: 0,
    oreEarned: 0,
    streak: 0,
    longestStreak: 0,
    streakFreezes: 0,
    activeUntil: 0,
    lastActivationAt: 0,
    activatedAt: 0,
    lastOreAt: 0,
    activeDays: 0,
    validActivations: 0,
    activeMine: null,
    activeMiningPower: 0,
    crew: { miners: 1, drills: 1, carts: 1, foreman: 1, storage: 1 },
  };
  return {
    ...player,
    chainMode: gameChainMode(env),
    activation: { active: false, activeUntil: 0 },
    discovery: { eligible: false, epoch: 0, portfolioUsd: 0 },
    activeMine: null,
    claims: [],
  };
}

async function readPlayerState(env: RuntimeEnvLike, wallet: string): Promise<{ state: PlayerGameState; stale: boolean }> {
  const key = stateCacheKey(env, wallet);
  try {
    const state = await getPlayerGameState(meteoraGameContext(env), wallet);
    lastGoodStates.set(key, state);
    return { state, stale: false };
  } catch (error) {
    console.warn("Meteora player read failed; serving cached state", { wallet, error });
    const cached = lastGoodStates.get(key);
    if (cached) return { state: cached, stale: true };
    try {
      const offline = await getPlayerGameState(offlineContext(env), wallet);
      return { state: offline, stale: true };
    } catch (offlineError) {
      console.warn("Meteora offline player read failed; serving an empty stale state", { wallet, error: offlineError });
      return { state: emptyPlayerState(env, wallet), stale: true };
    }
  }
}

function staleHeaders(stale: boolean): HeadersInit {
  return stale ? { "cache-control": "public, max-age=10", "x-diggo-stale": "1" } : { "cache-control": "public, max-age=10" };
}

async function mutationResponse(action: () => Promise<Response>): Promise<Response> {
  try {
    return await action();
  } catch (error) {
    console.error("Meteora mutation failed because an upstream dependency is unavailable", error);
    return json({ error: "The Solana RPC is temporarily unavailable. Please retry." }, { status: 503, headers: { "retry-after": "5" } });
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function rpcEnv(env: RuntimeEnvLike) {
  const cluster = String(env.SOLANA_CLUSTER || "devnet");
  return { ...env, DIGGO_RPC_URL: String(env.DIGGO_RPC_URL || (cluster === "mainnet-beta" ? "" : METEORA_RPC_FALLBACK)) };
}

function poolRow(row: Record<string, unknown>): GameCoin {
  const mint = String(row.base_mint);
  const createdAt = Number(row.created_at) || nowSeconds();
  return {
    mint,
    symbol: String(row.symbol || mint.slice(0, 6)),
    name: String(row.name || row.symbol || mint.slice(0, 6)),
    createdAt,
    miningStartsAt: createdAt,
    graduated: Number(row.is_graduated) === 1,
  };
}

export function meteoraCoinSource(env: GameEnv): GameCoinSource {
  const config = () => String(env.METEORA_DBC_CONFIG || "");
  return {
    async listActiveMines() {
      if (!config()) return [];
      const result = await env.DB.prepare(
        "SELECT base_mint, name, symbol, created_at, is_graduated FROM meteora_pools WHERE config=?1 AND is_graduated=0 ORDER BY created_at DESC",
      ).bind(config()).all<Record<string, unknown>>();
      return (result.results ?? []).map(poolRow);
    },
    async getMine(mint) {
      if (!config()) return null;
      const row = await env.DB.prepare(
        "SELECT base_mint, name, symbol, created_at, is_graduated FROM meteora_pools WHERE config=?1 AND base_mint=?2",
      ).bind(config(), mint).first<Record<string, unknown>>();
      return row ? poolRow(row) : null;
    },
  };
}

export function meteoraPayout(env: GameEnv): MiningPayout {
  return {
    async pay(mint, wallet, amount, idempotencyKey) {
      const result = await payMiningClaim({ env: rpcEnv(env), mint, wallet, amount, idempotencyKey });
      if (!result.signature) throw new Error(result.error || "Meteora payout has no signature");
      return { signature: result.signature };
    },
  };
}

export function meteoraWalletSource(env: GameEnv): GameWalletSource {
  return {
    async walletCreatedAt(wallet) {
      const cached = await env.DB.prepare(
        "SELECT created_at FROM meteora_wallet_age WHERE wallet=?1",
      ).bind(wallet).first<{ created_at: number | null }>();
      if (cached?.created_at) return cached.created_at;
      let before: string | undefined;
      let oldest: number | null = null;
      for (let page = 0; page < 20; page += 1) {
        const rows = await readSignatures(rpcEnv(env), wallet, { limit: 1000, ...(before ? { before } : {}) });
        for (const row of rows) if (row.blockTime !== null && (oldest === null || row.blockTime < oldest)) oldest = row.blockTime;
        if (rows.length < 1000) break;
        before = rows[rows.length - 1]?.signature;
      }
      if (oldest === null) return null;
      await env.DB.prepare(
        "INSERT INTO meteora_wallet_age (wallet, oldest_signature, created_at, checked_at) VALUES (?1, ?2, ?3, ?4) " +
        "ON CONFLICT(wallet) DO UPDATE SET oldest_signature=excluded.oldest_signature, created_at=excluded.created_at, checked_at=excluded.checked_at",
      ).bind(wallet, before ?? null, oldest, nowSeconds()).run();
      return oldest;
    },
  };
}

export function meteoraPortfolioSource(env: GameEnv): GamePortfolioSource {
  return {
    async portfolioUsd(wallet) {
      const rpc = getChainRpc(rpcEnv(env));
      const balance = await rpc.getBalance(address(wallet) as never, { commitment: "confirmed" }).send();
      const quote = await getSolUsd(env);
      return (Number(balance.value) / LAMPORTS_PER_SOL) * quote.priceUsd;
    },
  };
}

export function meteoraGameContext(env: RuntimeEnvLike): GameHandlerContext {
  const gameEnv = env as GameEnv;
  const services: GameServices = {
    coins: meteoraCoinSource(gameEnv),
    payout: meteoraPayout(gameEnv),
    wallet: meteoraWalletSource(gameEnv),
    portfolio: meteoraPortfolioSource(gameEnv),
  };
  return { env: gameEnv, services };
}

export async function runMeteoraScheduled(env: RuntimeEnvLike) {
  const indexed = await runMeteoraIndexer(rpcEnv(env));
  const now = nowSeconds();
  const config = String(env.METEORA_DBC_CONFIG || "");
  await env.DB.prepare(
    "INSERT OR IGNORE INTO game_mines (mint, mining_starts_at, initial_reserve, remaining, graduated, updated_at) " +
    "SELECT base_mint, CASE WHEN created_at > 0 THEN created_at ELSE ?2 END, '200000000000000000', '200000000000000000', is_graduated, ?2 " +
    "FROM meteora_pools WHERE config=?1",
  ).bind(config, now).run();
  await env.DB.prepare(
    "UPDATE game_mines SET graduated=(SELECT is_graduated FROM meteora_pools WHERE meteora_pools.base_mint=game_mines.mint AND meteora_pools.config=?1), updated_at=?2 " +
    "WHERE EXISTS (SELECT 1 FROM meteora_pools WHERE meteora_pools.base_mint=game_mines.mint AND meteora_pools.config=?1)",
  ).bind(config, now).run();
  const sweep = String(env.MINING_VAULT_SECRET || "")
    ? await runVaultSweep(rpcEnv(env))
    : { checked: 0, withdrawn: 0, failed: 0, balances: 0, skipped: true as const };
  return { indexed, sweep };
}

export function meteoraConfig(env: RuntimeEnvLike) {
  return {
    chainMode: gameChainMode(env),
    cluster: String(env.SOLANA_CLUSTER || "devnet"),
    meteoraConfig: String(env.METEORA_DBC_CONFIG || "") || null,
    meteoraDbcConfig: String(env.METEORA_DBC_CONFIG || "") || null,
    miningVault: String(env.MINING_VAULT_PUBLIC_KEY || "") || null,
    miningClaimCaps: {
      perClaim: String(env.MINING_CLAIM_PER_CLAIM || "") || null,
      perDay: String(env.MINING_CLAIM_PER_DAY || "") || null,
    },
  };
}

export async function meteoraBootstrap(env: RuntimeEnvLike, ctx: ExecutionContext) {
  const result = await env.DB.prepare(
    "SELECT pool, base_mint, name, symbol, created_at, quote_reserve, migration_quote_threshold, is_graduated FROM meteora_pools WHERE config=?1 ORDER BY created_at DESC",
  ).bind(String(env.METEORA_DBC_CONFIG || "")).all<Record<string, unknown>>();
  ctx.waitUntil(Promise.resolve());
  return json({
    tokens: (result.results ?? []).map((row) => ({
      mint: String(row.base_mint), pool: String(row.pool), name: String(row.name || row.symbol || row.base_mint),
      symbol: String(row.symbol || String(row.base_mint).slice(0, 6)), slug: String(row.base_mint),
      createdAt: Number(row.created_at) || 0, status: Number(row.is_graduated) === 1 ? "graduated" : "active",
      venue: "meteora", graduated: Number(row.is_graduated) === 1,
      quoteReserve: String(row.quote_reserve), migrationQuoteThreshold: String(row.migration_quote_threshold),
    })),
    syncedAt: nowSeconds(),
    ...meteoraConfig(env),
  });
}

export async function meteoraPlayerProfile(env: RuntimeEnvLike, wallet: string) {
  if (!isBase58Address(wallet)) return apiError("Invalid wallet");
  const result = await readPlayerState(env, wallet);
  return json({ profile: { wallet, game: { ...result.state, stale: result.stale } } }, { headers: staleHeaders(result.stale) });
}

export async function meteoraPortfolio(env: RuntimeEnvLike, wallet: string) {
  if (!isBase58Address(wallet)) return apiError("Invalid wallet");
  const result = await readPlayerState(env, wallet);
  const state = result.state;
  const graduated = state.activeMine?.coin?.graduated ?? false;
  const claimable = state.activeMine?.balance.claimable ?? "0";
  return json({ portfolio: { wallet, game: { ...state, stale: result.stale }, claimable, pendingUntilGraduation: graduated ? "0" : claimable, graduated, stale: result.stale } }, { headers: staleHeaders(result.stale) });
}

export async function meteoraMineInfo(env: RuntimeEnvLike, slug: string, wallet: string | null) {
  const row = await env.DB.prepare("SELECT * FROM meteora_pools WHERE config=?1 AND (base_mint=?2 OR pool=?2)")
    .bind(String(env.METEORA_DBC_CONFIG || ""), slug).first<Record<string, unknown>>();
  if (!row) return apiError("Mine not found", 404);
  const mint = String(row.base_mint);
  const state = wallet && isBase58Address(wallet) ? (await readPlayerState(env, wallet)).state : null;
  const balance = state?.activeMine?.coin?.mint === mint ? state.activeMine.balance : { claimable: "0" };
  const graduated = Number(row.is_graduated) === 1;
  return json({ mine: {
    mint, pool: String(row.pool), symbol: String(row.symbol || mint.slice(0, 6)), name: String(row.name || row.symbol || mint),
    status: graduated ? "graduated" : "active", venue: "meteora", graduated,
    claimable: balance.claimable, pendingUntilGraduation: graduated ? "0" : balance.claimable,
    quoteReserve: String(row.quote_reserve), migrationQuoteThreshold: String(row.migration_quote_threshold),
  } });
}

export async function meteoraSwitchMine(request: Request, env: RuntimeEnvLike) {
  const wallet = await sessionWallet(request, env);
  if (!wallet) return apiError("Wallet authentication required", 401);
  if (!(await checkRateLimit(request, env, "game-mine", 30)) ||
    !(await checkWalletRateLimit(env, wallet, "game-mine", 30, 60))) {
    return apiError("Too many requests", 429);
  }
  const body = await request.json().catch(() => ({})) as { mint?: string };
  const context = meteoraGameContext(env);
  const store = d1GameStore(env.DB);
  const player = await store.ensurePlayer(wallet, nowSeconds(), { miners: 1, drills: 1, carts: 1, foreman: 1, storage: 1 });
  const requested = body.mint && isBase58Address(body.mint) ? body.mint : null;
  if (body.mint && !requested) return apiError("Invalid mint");
  const row = requested
    ? await env.DB.prepare("SELECT base_mint FROM meteora_pools WHERE config=?1 AND base_mint=?2").bind(String(env.METEORA_DBC_CONFIG || ""), requested).first<{ base_mint: string }>()
    : await env.DB.prepare("SELECT s.mint AS base_mint FROM meteora_swaps s JOIN meteora_pools p ON p.pool=s.pool WHERE s.trader_wallet=?1 AND p.config=?2 ORDER BY s.created_at DESC LIMIT 1").bind(wallet, String(env.METEORA_DBC_CONFIG || "")).first<{ base_mint: string }>();
  const mine = row?.base_mint ? await context.services.coins.getMine(row.base_mint) : null;
  if (!mine) return apiError("Mine not found", 404);
  if (player.activeMine && player.activeMine !== mine.mint) {
    const oldCoin = await context.services.coins.getMine(player.activeMine);
    if (oldCoin) {
      const balance = await store.getBalance(wallet, oldCoin.mint);
      const ledger = await store.ensureMine(oldCoin.mint, oldCoin.miningStartsAt, 1, nowSeconds());
      const now = nowSeconds();
      const next = accrueMining({ mine: oldCoin, wallet, now, lastSettledAt: balance.lastSettledAt || oldCoin.miningStartsAt, assignedPower: player.activeMiningPower || playerCrewPower(player), totalEligiblePower: ledger.totalEligiblePower, releasedBefore: releasedMiningAllocation(balance.lastSettledAt || oldCoin.miningStartsAt, oldCoin.miningStartsAt), releasedNow: releasedMiningAllocation(now, oldCoin.miningStartsAt), claimableBefore: balance.claimable, reserveRemainingBefore: ledger.remaining, committedBefore: ledger.committed });
      if (next.claimable !== balance.claimable) await store.settleMining({ ...ledger, released: releasedMiningAllocation(now, oldCoin.miningStartsAt), remaining: next.reserveRemaining, committed: next.committed }, { ...balance, claimable: next.claimable, lastSettledAt: now }, ledger.version, balance.claimable, now);
    }
  }
  const version = await store.playerVersion(wallet);
  const updated = { ...player, activeMine: mine.mint, activeMiningPower: player.activeUntil > nowSeconds() ? playerCrewPower(player) : 0 };
  if (!(await store.savePlayer(updated, version))) return apiError("Game state changed; retry", 409);
  return json({ player: await store.getPlayer(wallet), mine });
}

export async function handleMeteoraGameRoute(request: Request, env: RuntimeEnvLike, pathname: string): Promise<Response | null> {
  const context = meteoraGameContext(env);
  if (request.method === "POST" && pathname === "/api/game/activation-challenge") return mutationResponse(() => handleActivationChallenge(context, request));
  if (request.method === "POST" && pathname === "/api/game/activate") return mutationResponse(() => handleActivate(context, request));
  if (request.method === "POST" && pathname === "/api/game/upgrade") return mutationResponse(() => handleUpgrade(context, request));
  if (request.method === "POST" && pathname === "/api/game/claim") return mutationResponse(() => handleClaim(context, request));
  if (request.method === "POST" && pathname === "/api/game/discovery") return mutationResponse(() => handleDiscovery(context, request));
  if (request.method === "POST" && pathname === "/api/game/mine") return mutationResponse(() => meteoraSwitchMine(request, env));
  if (request.method === "GET" && pathname.startsWith("/api/game/player/")) return meteoraPlayerProfile(env, pathname.slice("/api/game/player/".length));
  return null;
}
