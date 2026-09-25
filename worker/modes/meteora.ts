import { address } from "@solana/kit";
import { sessionWallet } from "../auth";
import { d1GameStore } from "../game/d1-store";
import {
  getPlayerGameState,
  handleActivate,
  handleActivationChallenge,
  handleClaim,
  handleClaimAll,
  handleClaimAllConfirm,
  handleClaimConfirmation,
  handleDiscovery,
  handleUpgrade,
  settlePlayerMining,
  type GameHandlerContext,
  type PlayerGameState,
} from "../game/service";
import { gameChainMode, type GameCoin, type GameCoinSource, type GameEnv, type GamePlayerState, type GamePortfolioSource, type GameServices, type GameWalletSource, type MiningPayout } from "../game/contracts";
import { getSolUsd } from "../oracle";
import { apiError, checkRateLimit, checkWalletRateLimit, isBase58Address, json } from "../http";
import { getChainRpc, LAMPORTS_PER_SOL } from "../chainV2";
import { confirmClaimBatch, confirmMiningClaim, prepareClaimBatch, prepareMiningClaim, runMeteoraIndexer, runVaultSweep } from "../meteora";
import { decodeTokenAccountAmount, deriveAssociatedTokenAddress, readAccount, readSignatures } from "../meteora/rpc";
import { recordJobRun } from "../indexStore";
import { optionalBinding } from "../env";
import { officialMintFromEnv } from "../../shared/officialMint";

type RuntimeEnvLike = GameEnv;
const lastGoodStates = new Map<string, PlayerGameState>();

function stateCacheKey(env: RuntimeEnvLike, wallet: string): string {
  return [String(env.SOLANA_CLUSTER || "mainnet-beta"), String(env.METEORA_DBC_CONFIG || ""), wallet].join(":");
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
    balances: [],
  claimAll: { supported: true, count: 0, signatures: 1, maxItems: 12 },
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
  return { ...env, DIGGO_RPC_URL: String(env.DIGGO_RPC_URL || "") };
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
    async prepare(mint, wallet, amount, idempotencyKey) {
      const result = await prepareMiningClaim({ env: rpcEnv(env), mint, wallet, amount, idempotencyKey });
      return { transaction: result.transaction, expiresAt: result.expiresAt };
    },
    async confirm(claimId, signature) {
      return confirmMiningClaim(rpcEnv(env), claimId, signature);
    },
    async prepareBatch(wallet, items, batchId) {
      return prepareClaimBatch({ env: rpcEnv(env), wallet, items, batchId });
    },
    async confirmBatch(wallet, batchId, signature) {
      return confirmClaimBatch(rpcEnv(env), wallet, batchId, signature);
    },
    async vaultInventory(mint) {
      // A read needs no signing key, so the configured vault address is enough. This is the same
      // associated token account `prepareClaimBatch` funds from, and the same token-account layout
      // it decodes, so a positive result here is a real proof that the batch can be paid. A missing
      // account is reported as zero rather than unknown: the vault demonstrably holds nothing, which
      // is exactly the case `prepareClaimBatch` refuses. Only a failed read is unknown.
      const vault = String(env.MINING_VAULT_PUBLIC_KEY || "").trim();
      if (!vault) return null;
      let account: string;
      try {
        account = deriveAssociatedTokenAddress(mint, vault);
      } catch {
        return null;
      }
      let data: Uint8Array;
      try {
        const found = await readAccount(rpcEnv(env), account);
        if (!found) return { available: 0n, account };
        data = found.data;
      } catch (error) {
        console.warn("Vault inventory read failed; treating the mint as unproven", { mint, error });
        return null;
      }
      try {
        return { available: decodeTokenAccountAmount(data), account };
      } catch (error) {
        console.warn("Vault token account could not be decoded; treating the mint as unproven", { mint, error });
        return null;
      }
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
  let indexed: Awaited<ReturnType<typeof runMeteoraIndexer>>;
  try {
    indexed = await runMeteoraIndexer(rpcEnv(env));
    await recordJobRun(env, "meteora:index", "OK", {
      accounts: indexed.pools,
      events: indexed.events,
    });
  } catch (error) {
    await recordJobRun(env, "meteora:index", "FAILED", { accounts: 0, events: 0, detail: String(error) });
    throw error;
  }
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
  let sweep: Awaited<ReturnType<typeof runVaultSweep>> | { checked: number; withdrawn: number; failed: number; balances: number; skipped: true };
  try {
    sweep = String(env.MINING_VAULT_SECRET || "")
      ? await runVaultSweep(rpcEnv(env))
      : { checked: 0, withdrawn: 0, failed: 0, balances: 0, skipped: true as const };
    await recordJobRun(env, "meteora:vault-sweep", "OK", {
      accounts: sweep.checked,
      events: sweep.withdrawn,
    });
  } catch (error) {
    await recordJobRun(env, "meteora:vault-sweep", "FAILED", { accounts: 0, events: 0, detail: String(error) });
    throw error;
  }
  return { indexed, sweep };
}

export function meteoraConfig(env: RuntimeEnvLike) {
  return {
    chainMode: gameChainMode(env),
    cluster: String(env.SOLANA_CLUSTER || "mainnet-beta"),
    meteoraConfig: String(env.METEORA_DBC_CONFIG || "") || null,
    meteoraDbcConfig: String(env.METEORA_DBC_CONFIG || "") || null,
    // The official coin's mint, validated rather than passed through: a blank or mistyped
    // DIGGO_OFFICIAL_MINT reads as "not launched" (null) so the UI shows its empty state
    // (shared/officialMint.ts).
    officialMint: officialMintFromEnv(optionalBinding<string>(env, "DIGGO_OFFICIAL_MINT")),
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
  const context = meteoraGameContext(env);
  const store = d1GameStore(env.DB);
  const now = nowSeconds();
  const player = await store.ensurePlayer(wallet, now, { miners: 1, drills: 1, carts: 1, foreman: 1, storage: 1 });
  const settled = await settlePlayerMining(context, player);
  const mine = settled.activeMine ? await context.services.coins.getMine(settled.activeMine) : null;
  return json({
    player: settled,
    mine,
    changed: settled.activeMine !== player.activeMine || settled.activeMiningPower !== player.activeMiningPower,
  });
}

export async function handleMeteoraGameRoute(request: Request, env: RuntimeEnvLike, pathname: string): Promise<Response | null> {
  const context = meteoraGameContext(env);
  if (request.method === "POST" && pathname === "/api/game/activation-challenge") return mutationResponse(() => handleActivationChallenge(context, request));
  if (request.method === "POST" && pathname === "/api/game/activate") return mutationResponse(() => handleActivate(context, request));
  if (request.method === "POST" && pathname === "/api/game/upgrade") return mutationResponse(() => handleUpgrade(context, request));
  if (request.method === "POST" && pathname === "/api/game/claim") return mutationResponse(() => handleClaim(context, request));
  if (request.method === "POST" && pathname === "/api/game/claim/all") return mutationResponse(() => handleClaimAll(context, request));
  if (request.method === "POST" && pathname === "/api/game/claim/all/confirm") return mutationResponse(() => handleClaimAllConfirm(context, request));
  if (request.method === "POST" && pathname === "/api/game/claim/confirm") return mutationResponse(() => handleClaimConfirmation(context, request));
  if (request.method === "POST" && pathname === "/api/game/discovery") return mutationResponse(() => handleDiscovery(context, request));
  if (request.method === "POST" && pathname === "/api/game/mine") return mutationResponse(() => meteoraSwitchMine(request, env));
  if (request.method === "GET" && pathname.startsWith("/api/game/player/")) return meteoraPlayerProfile(env, pathname.slice("/api/game/player/".length));
  return null;
}
