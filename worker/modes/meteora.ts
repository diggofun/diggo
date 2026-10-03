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
  settleActiveShifts,
  settlePlayerMining,
  type GameHandlerContext,
  type PlayerGameState,
} from "../game/service";
import { gameChainMode, MINING_RESERVE, type GameCoin, type GameCoinSource, type GameEnv, type GamePlayerState, type GamePortfolioSource, type GameServices, type GameWalletSource, type MiningPayout } from "../game/contracts";
import { wholeTokens } from "../game/store";
import { MINING_ALLOCATION_DAYS } from "../game/rules";
import { getSolUsd } from "../oracle";
import { apiError, checkRateLimit, checkWalletRateLimit, isBase58Address, json } from "../http";
import { getChainRpc, LAMPORTS_PER_SOL } from "../chainV2";
import { confirmClaimBatch, confirmMiningClaim, prepareClaimBatch, prepareMiningClaim, runMeteoraIndexer, runVaultSweep } from "../meteora";
import { decodeTokenAccountAmount, decodeTokenMint, deriveAssociatedTokenAddress, readAccount, readSignatures } from "../meteora/rpc";
import type { TokenSummary } from "../../shared/types";
import { recordJobRun } from "../indexStore";
import { optionalBinding } from "../env";
import { officialMintFromEnv } from "../../shared/officialMint";

type RuntimeEnvLike = GameEnv;
const lastGoodStates = new Map<string, PlayerGameState>();
const TIME_MINING_EMISSION = { kind: "TIME", durationDays: MINING_ALLOCATION_DAYS } as const;

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
    claim: { met: false, walletAge: false, activeDays: false, activations: false, portfolio: false, portfolioUsd: 0 },
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

/**
 * The five-minute settlement pass: books ORE and pending mining tokens for every shift with
 * unsettled time, and rolls the day's discovery for eligible active crews. It runs after the
 * indexer so a newly indexed pool is already a mine it can assign.
 */
export async function runMeteoraSettlement(env: RuntimeEnvLike) {
  try {
    const result = await settleActiveShifts(meteoraGameContext(env));
    await recordJobRun(env, "meteora:settle", result.failed > 0 ? "FAILED" : "OK", {
      accounts: result.settled,
      events: result.oreBooked,
      detail: result.failed > 0 ? `${result.failed} wallet(s) failed to settle` : undefined,
    });
    return result;
  } catch (error) {
    await recordJobRun(env, "meteora:settle", "FAILED", { accounts: 0, events: 0, detail: String(error) });
    throw error;
  }
}

/** The off-chain mining ledger for a mine, in whole tokens, plus the power digging it now. */
async function mineLedgerView(env: RuntimeEnvLike, mint: string) {
  const store = d1GameStore(env.DB);
  const now = Math.floor(Date.now() / 1_000);
  const [ledger, power] = await Promise.all([store.getMine(mint), store.getEligiblePower(mint, now)]);
  const initial = ledger?.initialReserve ?? MINING_RESERVE;
  const remaining = ledger?.remaining ?? MINING_RESERVE;
  const committed = ledger?.committed ?? 0n;
  return {
    reserveTotal: wholeTokens(initial),
    reserveRemaining: wholeTokens(remaining),
    committed: wholeTokens(committed),
    progress: initial > 0n ? Number((committed * 1_000_000n) / initial) / 1_000_000 : 0,
    power,
  };
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
    // Public PostHog project key (not a secret) and the first-party proxy path the SDK talks to
    // (worker/posthogProxy.ts). The client loads PostHog only after analytics consent.
    posthogApiKey: optionalBinding<string>(env, "POSTHOG_API_KEY") || undefined,
    posthogHost: optionalBinding<string>(env, "POSTHOG_HOST") || undefined,
    miningVault: String(env.MINING_VAULT_PUBLIC_KEY || "") || null,
    miningClaimCaps: {
      perClaim: String(env.MINING_CLAIM_PER_CLAIM || "") || null,
      perDay: String(env.MINING_CLAIM_PER_DAY || "") || null,
    },
  };
}

export async function meteoraBootstrap(env: RuntimeEnvLike, ctx: ExecutionContext) {
  const result = await env.DB.prepare(
    "SELECT p.pool, p.base_mint, p.name, p.symbol, p.uri, p.created_at, p.quote_reserve, p.migration_quote_threshold, p.is_graduated, " +
    "m.initial_reserve, m.remaining FROM meteora_pools p LEFT JOIN game_mines m ON m.mint=p.base_mint " +
    "WHERE p.config=?1 ORDER BY p.created_at DESC",
  ).bind(String(env.METEORA_DBC_CONFIG || "")).all<Record<string, unknown>>();
  ctx.waitUntil(Promise.resolve());
  return json({
    tokens: (result.results ?? []).map((row) => ({
      mint: String(row.base_mint), pool: String(row.pool), name: String(row.name || row.symbol || row.base_mint),
      symbol: String(row.symbol || String(row.base_mint).slice(0, 6)), slug: String(row.base_mint),
      imageUrl: imageUrl(row.uri),
      createdAt: Number(row.created_at) || 0, status: Number(row.is_graduated) === 1 ? "graduated" : "active",
      venue: "meteora", graduated: Number(row.is_graduated) === 1,
      quoteReserve: String(row.quote_reserve), migrationQuoteThreshold: String(row.migration_quote_threshold),
      // Match mineLedgerView, including a new pool whose ledger has not been initialized yet.
      reserveTotal: wholeTokens(BigInt(String(row.initial_reserve ?? MINING_RESERVE))),
      reserveRemaining: wholeTokens(BigInt(String(row.remaining ?? MINING_RESERVE))),
      miningEmission: TIME_MINING_EMISSION,
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
  const ledger = await mineLedgerView(env, mint);
  const playerPower = state ? (state.activeMine?.coin?.mint === mint && state.activation.active ? state.activeMiningPower : 0) : null;
  return json({ mine: {
    mint, pool: String(row.pool), symbol: String(row.symbol || mint.slice(0, 6)), name: String(row.name || row.symbol || mint),
    status: graduated ? "graduated" : "active", venue: "meteora", graduated,
    claimable: balance.claimable, pendingUntilGraduation: graduated ? "0" : balance.claimable,
    quoteReserve: String(row.quote_reserve), migrationQuoteThreshold: String(row.migration_quote_threshold),
    // The Mining Reserve is an off-chain ledger (game_mines): rewards accrue as pending balances and
    // are paid from the mining vault after graduation, so these figures come from that ledger.
    remainingReserve: ledger.reserveRemaining,
    reserveTotal: ledger.reserveTotal,
    fullyMinedProgress: ledger.progress,
    totalMiningPower: ledger.power,
    playerPower,
    estimatedShare: playerPower !== null && ledger.power > 0 ? Math.min(1, playerPower / ledger.power) : null,
    emissionSource: "RESERVE",
    miningEmission: TIME_MINING_EMISSION,
    // Before graduation the mining vault is empty by design: the pool's 20% leftover (200M) only
    // reaches it at migration. Rewards accrue as pending against that allocation meanwhile.
    accounting: { source: "OFFCHAIN", authoritative: false, label: "Pending reserve: accrues now, paid from the 200M leftover after graduation" },
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

function imageUrl(value: unknown): string | null {
  return typeof value === "string" && /^https:\/\//iu.test(value) ? value : null;
}

type SwapPriceRow = { side: string; amount_in: string; amount_out: string };

/** SOL per whole token paid in one indexed swap; 0 when the row cannot price anything. */
export function swapPriceSol(row: SwapPriceRow | null, decimals: number): number {
  if (!row) return 0;
  const buy = row.side === "buy";
  const lamports = Number(buy ? row.amount_in : row.amount_out);
  const tokens = Number(buy ? row.amount_out : row.amount_in) / 10 ** decimals;
  return lamports > 0 && tokens > 0 ? lamports / LAMPORTS_PER_SOL / tokens : 0;
}

/**
 * One Meteora coin as the shared TokenSummary, from indexed pools and swaps.
 *
 * Price is the latest indexed trade, the 24h change compares it with the last trade at least a
 * day old (null when there is none), and USD values use the SOL/USD oracle only when it is
 * available. The live curve price is still quoted by the swap panel from the chain.
 */
export async function meteoraTokenBySlug(env: RuntimeEnvLike, slug: string): Promise<Response> {
  const row = await env.DB.prepare("SELECT * FROM meteora_pools WHERE config=?1 AND (base_mint=?2 OR pool=?2)")
    .bind(String(env.METEORA_DBC_CONFIG || ""), slug).first<Record<string, unknown>>();
  if (!row) return apiError("Token not found", 404);
  const mint = String(row.base_mint);
  const pool = String(row.pool);
  const decimals = Number(row.decimals) || 9;
  const since = nowSeconds() - 86_400;
  const priceSql = "SELECT side, amount_in, amount_out FROM meteora_swaps WHERE pool=?1";
  const order = " ORDER BY CAST(slot AS INTEGER) DESC, event_index DESC LIMIT 1";
  const [latest, baseline, window, solUsd, mintAccount] = await Promise.all([
    env.DB.prepare(priceSql + order).bind(pool).first<SwapPriceRow>(),
    env.DB.prepare(priceSql + " AND block_time <= ?2" + order).bind(pool, since).first<SwapPriceRow>(),
    env.DB.prepare("SELECT COUNT(*) AS trades, COALESCE(SUM(CAST(sol_amount_lamports AS INTEGER)), 0) AS lamports FROM meteora_swaps WHERE pool=?1 AND block_time > ?2")
      .bind(pool, since).first<{ trades: number; lamports: number }>(),
    getSolUsd(env as never).catch(() => null),
    readAccount(rpcEnv(env), mint).catch(() => null),
  ]);
  const priceSol = swapPriceSol(latest, decimals);
  const basePrice = swapPriceSol(baseline, decimals);
  const usd = solUsd?.available ? solUsd.priceUsd : 0;
  const supply = mintAccount ? Number(decodeTokenMint(mintAccount.data).supply) / 10 ** decimals : 0;
  const graduated = Number(row.is_graduated) === 1;
  const createdAt = Number(row.created_at) || 0;
  const ledger = await mineLedgerView(env, mint);
  const token: TokenSummary = {
    mint, slug: mint,
    name: String(row.name || row.symbol || mint), symbol: String(row.symbol || mint.slice(0, 6)),
    description: "", creator: String(row.creator || ""), imageUrl: imageUrl(row.uri),
    status: graduated ? "CURVE_CAP_REACHED" : "MINING_ACTIVE",
    priceSol, priceUsd: priceSol * usd,
    change24h: priceSol > 0 && basePrice > 0 ? (priceSol / basePrice - 1) * 100 : null,
    volume24hUsd: (Number(window?.lamports ?? 0) / LAMPORTS_PER_SOL) * usd,
    trades24h: Number(window?.trades ?? 0),
    curveMining: { open: false, disabled: true, onCurve: !graduated, cap: 0, mined: 0, remaining: 0, progress: 0, blockReward: 0, unpaid: 0 },
    sellCapacity: { sol: graduated ? 0 : Number(row.quote_reserve ?? 0) / LAMPORTS_PER_SOL, tokens: null },
    marketCapUsd: priceSol * usd * supply,
    reserveRemaining: ledger.reserveRemaining, reserveTotal: ledger.reserveTotal, rewardPerBlock: 0, networkPower: ledger.power,
    miningEmission: TIME_MINING_EMISSION,
    nextBlockAt: 0, nextEpochAt: 0,
    createdAt, decimals, venue: "meteora",
    quoteReserve: String(row.quote_reserve ?? "0"), migrationQuoteThreshold: String(row.migration_quote_threshold ?? "0"),
  };
  return json({ token });
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
