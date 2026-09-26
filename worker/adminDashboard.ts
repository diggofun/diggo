import { address } from "@solana/kit";
import bs58 from "bs58";
import type {
  AdminDashboardClaimCounts,
  AdminDashboardCount,
  AdminDashboardFee,
  AdminDashboardFees,
  AdminDashboardJob,
  AdminDashboardPayload,
  AdminDashboardReferrals,
  AdminDashboardVault,
  AdminDashboardVaultBalance,
  AdminDashboardVolume,
} from "../shared/adminDashboard";
import {
  METEORA_FEE_CLAIMER,
  METEORA_WRAPPED_SOL_MINT,
  normalizeChainMode,
  normalizeMeteoraConfigPubkey,
  normalizeMeteoraCluster,
} from "../shared/meteora";
import { adminActor } from "./admin";
import { getChainRpc } from "./chainV2";
import { optionalBinding, type RuntimeEnv } from "./env";
import { apiError, json } from "./http";
import {
  METEORA_CONFIG_OFFSET,
  VIRTUAL_POOL_DISCRIMINATOR,
  readAccount,
  readProgramAccounts,
  type MeteoraRpcAccount,
} from "./meteora/rpc";

const CACHE_TTL_MS = 30_000;
const LAMPORTS_PER_SOL = 1_000_000_000n;
/** On-chain fee reads are shared by every admin and refreshed at most once a minute. */
const FEE_CACHE_TTL_MS = 60_000;
/** A failed read is retried sooner, but not on every dashboard load. */
const FEE_FAILURE_TTL_MS = 15_000;
const FEE_READ_TIMEOUT_MS = 8_000;

// Meteora DBC account layouts (IDL of @meteora-ag/dynamic-bonding-curve-sdk 1.5.13), offsets
// include the 8-byte Anchor discriminator. adminDashboard.test.ts checks them against the SDK coder.
const POOL_PROTOCOL_QUOTE_FEE_OFFSET = 256;
const POOL_PARTNER_QUOTE_FEE_OFFSET = 272;
const POOL_TOTAL_PROTOCOL_QUOTE_FEE_OFFSET = 320;
const POOL_TOTAL_TRADING_QUOTE_FEE_OFFSET = 336;
const POOL_CREATION_FEE_BITS_OFFSET = 369;
const POOL_ACCOUNT_MIN_LENGTH = 370;
const CONFIG_QUOTE_MINT_OFFSET = 8;
const CONFIG_CREATOR_TRADING_FEE_PERCENTAGE_OFFSET = 245;
const CONFIG_POOL_CREATION_FEE_OFFSET = 368;
const CONFIG_ACCOUNT_MIN_LENGTH = 376;
/** PoolState::creation_fee_bits sets bit 1 once the partner has claimed its creation fee. */
const PARTNER_CREATION_FEE_CLAIMED_MASK = 0b10;
/** The DBC program keeps this share of every pool creation fee for Meteora. */
const PROTOCOL_POOL_CREATION_FEE_PERCENT = 10n;

type Scalar = string | number | bigint | ArrayBuffer | null;

interface CacheEntry {
  expiresAt: number;
  payload: AdminDashboardPayload;
}

interface CountRow { value: number }
interface VolumeRow { lamports: number | string | null }
interface VaultBalanceRow { mint: string; token_account: string; amount: string; updated_at: number }

const cache = new Map<string, CacheEntry>();
let feeCache: { key: string; expiresAt: number; fees: AdminDashboardFees } | null = null;

export function resetAdminDashboardCache(): void {
  cache.clear();
  feeCache = null;
}

function envText(env: RuntimeEnv, name: string): string | null {
  const value = optionalBinding<unknown>(env, name);
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function sqlValue(value: unknown): Scalar {
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") return value;
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  }
  return null;
}

async function first<T>(env: RuntimeEnv, sql: string, values: readonly unknown[] = []): Promise<T | null> {
  try {
    const statement = env.DB.prepare(sql);
    return values.length > 0
      ? await statement.bind(...values.map(sqlValue)).first<T>()
      : await statement.first<T>();
  } catch {
    return null;
  }
}

async function all<T>(env: RuntimeEnv, sql: string, values: readonly unknown[] = []): Promise<T[] | null> {
  try {
    const statement = env.DB.prepare(sql);
    const result = values.length > 0
      ? await statement.bind(...values.map(sqlValue)).all<T>()
      : await statement.all<T>();
    return result.results ?? [];
  } catch {
    return null;
  }
}

function countValue(value: unknown): number | null {
  const result = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(result) && result >= 0 ? result : null;
}

function unavailableVolume(): AdminDashboardVolume {
  return { sol: null, estimated: false };
}

function unavailableFee(): AdminDashboardFee {
  return { claimableSol: null, lifetimeSol: null, claimedSol: null };
}

export function unavailableFees(config: string | null, error: string): AdminDashboardFees {
  return {
    status: "unavailable",
    claimableSol: null,
    partnerTrading: unavailableFee(),
    creation: unavailableFee(),
    protocol: { tradingLifetimeSol: null, tradingUnclaimedSol: null, creationLifetimeSol: null },
    pools: null,
    config,
    readAt: null,
    error,
  };
}

async function readCount(env: RuntimeEnv, sql: string, values: readonly unknown[] = []): Promise<number | null> {
  const row = await first<CountRow>(env, sql, values);
  return row === null ? null : countValue(row.value);
}

function summarize([total, last24h, last7d]: readonly [number | null, number | null, number | null]): AdminDashboardCount {
  return { total, last24h, last7d };
}

async function countOverTime(env: RuntimeEnv, table: "tokens" | "meteora_pools" | "game_players"): Promise<AdminDashboardCount> {
  const now = Math.floor(Date.now() / 1_000);
  return summarize(await Promise.all([
    readCount(env, `SELECT COUNT(*) AS value FROM ${table}`),
    readCount(env, `SELECT COUNT(*) AS value FROM ${table} WHERE created_at >= ?1`, [now - 86_400]),
    readCount(env, `SELECT COUNT(*) AS value FROM ${table} WHERE created_at >= ?1`, [now - 604_800]),
  ]));
}

function combineCounts(left: AdminDashboardCount, right: AdminDashboardCount): AdminDashboardCount {
  const sum = (a: number | null, b: number | null): number | null => a === null || b === null ? null : a + b;
  return { total: sum(left.total, right.total), last24h: sum(left.last24h, right.last24h), last7d: sum(left.last7d, right.last7d) };
}

async function readLaunches(env: RuntimeEnv): Promise<{ launches: AdminDashboardCount; graduated: AdminDashboardCount }> {
  const now = Math.floor(Date.now() / 1_000);
  const [nativeLaunches, meteoraLaunches, nativeGraduated, meteoraGraduated] = await Promise.all([
    countOverTime(env, "tokens"),
    countOverTime(env, "meteora_pools"),
    summarize(await Promise.all([
      readCount(env, "SELECT COUNT(*) AS value FROM tokens WHERE graduated = 1"),
      readCount(env, "SELECT COUNT(*) AS value FROM tokens WHERE graduated = 1 AND created_at >= ?1", [now - 86_400]),
      readCount(env, "SELECT COUNT(*) AS value FROM tokens WHERE graduated = 1 AND created_at >= ?1", [now - 604_800]),
    ])),
    summarize(await Promise.all([
      readCount(env, "SELECT COUNT(*) AS value FROM meteora_pools WHERE is_migrated = 1"),
      readCount(env, "SELECT COUNT(*) AS value FROM meteora_pools WHERE is_migrated = 1 AND created_at >= ?1", [now - 86_400]),
      readCount(env, "SELECT COUNT(*) AS value FROM meteora_pools WHERE is_migrated = 1 AND created_at >= ?1", [now - 604_800]),
    ])),
  ]);
  return { launches: combineCounts(nativeLaunches, meteoraLaunches), graduated: combineCounts(nativeGraduated, meteoraGraduated) };
}

function lamportsToSol(value: bigint): string {
  const whole = value / LAMPORTS_PER_SOL;
  const fraction = (value % LAMPORTS_PER_SOL).toString().padStart(9, "0").replace(/0+$/, "");
  return fraction.length > 0 ? `${whole}.${fraction}` : whole.toString();
}

function rowLamports(value: unknown): bigint | null {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") return null;
  try {
    const result = BigInt(value);
    return result >= 0n ? result : null;
  } catch {
    return null;
  }
}

function combineVolumes(values: readonly (VolumeRow | null)[], estimated: boolean): AdminDashboardVolume {
  if (values.some((row) => row === null)) return unavailableVolume();
  let total = 0n;
  for (const row of values) {
    const lamports = rowLamports(row?.lamports);
    if (lamports === null) return unavailableVolume();
    total += lamports;
  }
  return { sol: lamportsToSol(total), estimated };
}

async function volumeQuery(env: RuntimeEnv, sql: string, values: readonly unknown[] = []): Promise<VolumeRow | null> {
  return first<VolumeRow>(env, sql, values);
}

async function readVolume(env: RuntimeEnv): Promise<AdminDashboardPayload["tradingVolume"]> {
  const now = Math.floor(Date.now() / 1_000);
  const windows = [null, now - 86_400, now - 604_800] as const;
  const rows = await Promise.all(windows.flatMap((cutoff) => [
    volumeQuery(env, "SELECT COALESCE(SUM(CAST(sol_amount_lamports AS INTEGER)), 0) AS lamports FROM meteora_swaps" + (cutoff === null ? "" : " WHERE block_time >= ?1"), cutoff === null ? [] : [cutoff]),
    volumeQuery(env, "SELECT CAST(COALESCE(SUM(price_sol * CAST(amount_in AS REAL)), 0) * 1000000000 AS INTEGER) AS lamports FROM trades" + (cutoff === null ? "" : " WHERE block_time >= ?1"), cutoff === null ? [] : [cutoff]),
  ]));
  return {
    all: combineVolumes([rows[0], rows[1]], true),
    last24h: combineVolumes([rows[2], rows[3]], true),
    last7d: combineVolumes([rows[4], rows[5]], true),
  };
}

function readU64Le(data: Uint8Array, offset: number): bigint {
  if (offset + 8 > data.length) throw new Error("truncated u64");
  let value = 0n;
  for (let index = 7; index >= 0; index -= 1) value = (value << 8n) | BigInt(data[offset + index]);
  return value;
}

export interface DbcFeeConfig {
  quoteMint: string;
  creatorTradingFeePercentage: number;
  poolCreationFeeLamports: bigint;
}

export interface DbcPoolFees {
  pool: string;
  /** Unclaimed partner trading fee in the quote token (lamports for SOL-quoted pools). */
  partnerQuoteFee: bigint;
  protocolQuoteFee: bigint;
  /** Lifetime partner + creator trading fee (PoolMetrics::total_trading_quote_fee). */
  totalTradingQuoteFee: bigint;
  totalProtocolQuoteFee: bigint;
  creationFeeBits: number;
}

export function decodeDbcFeeConfig(data: Uint8Array): DbcFeeConfig {
  if (data.length < CONFIG_ACCOUNT_MIN_LENGTH) throw new Error("truncated PoolConfig account");
  const percentage = data[CONFIG_CREATOR_TRADING_FEE_PERCENTAGE_OFFSET];
  if (percentage > 100) throw new Error("invalid creator trading fee percentage");
  return {
    quoteMint: bs58.encode(data.subarray(CONFIG_QUOTE_MINT_OFFSET, CONFIG_QUOTE_MINT_OFFSET + 32)),
    creatorTradingFeePercentage: percentage,
    poolCreationFeeLamports: readU64Le(data, CONFIG_POOL_CREATION_FEE_OFFSET),
  };
}

export function decodeDbcPoolFees(pool: string, data: Uint8Array): DbcPoolFees {
  if (data.length < POOL_ACCOUNT_MIN_LENGTH) throw new Error("truncated VirtualPool account");
  return {
    pool,
    partnerQuoteFee: readU64Le(data, POOL_PARTNER_QUOTE_FEE_OFFSET),
    protocolQuoteFee: readU64Le(data, POOL_PROTOCOL_QUOTE_FEE_OFFSET),
    totalTradingQuoteFee: readU64Le(data, POOL_TOTAL_TRADING_QUOTE_FEE_OFFSET),
    totalProtocolQuoteFee: readU64Le(data, POOL_TOTAL_PROTOCOL_QUOTE_FEE_OFFSET),
    creationFeeBits: data[POOL_CREATION_FEE_BITS_OFFSET],
  };
}

function feeAmounts(claimable: bigint, lifetime: bigint): AdminDashboardFee {
  const claimed = lifetime > claimable ? lifetime - claimable : 0n;
  return { claimableSol: lamportsToSol(claimable), lifetimeSol: lamportsToSol(lifetime), claimedSol: lamportsToSol(claimed) };
}

/**
 * Totals the partner's fees the way the DBC SDK's getPoolFeeBreakdown does per pool: the creator
 * takes creator_trading_fee_percentage of the lifetime trading fee and the partner the rest; what
 * is still in partner_quote_fee is claimable, the difference has been claimed. Each pool also owes
 * the partner 90% of the config's creation fee until creation_fee_bits records the claim.
 */
export function summarizePartnerFees(
  configAddress: string,
  config: DbcFeeConfig,
  pools: readonly DbcPoolFees[],
  readAt: number,
): AdminDashboardFees {
  if (config.quoteMint !== METEORA_WRAPPED_SOL_MINT) return unavailableFees(configAddress, "Config is not SOL-quoted");
  const creatorPercent = BigInt(config.creatorTradingFeePercentage);
  const protocolCreationFee = config.poolCreationFeeLamports * PROTOCOL_POOL_CREATION_FEE_PERCENT / 100n;
  const partnerCreationFee = config.poolCreationFeeLamports - protocolCreationFee;
  let tradingClaimable = 0n;
  let tradingLifetime = 0n;
  let creationClaimable = 0n;
  let protocolTradingLifetime = 0n;
  let protocolTradingUnclaimed = 0n;
  for (const pool of pools) {
    const creatorShare = pool.totalTradingQuoteFee * creatorPercent / 100n;
    tradingLifetime += pool.totalTradingQuoteFee - creatorShare;
    tradingClaimable += pool.partnerQuoteFee;
    if ((pool.creationFeeBits & PARTNER_CREATION_FEE_CLAIMED_MASK) === 0) creationClaimable += partnerCreationFee;
    protocolTradingLifetime += pool.totalProtocolQuoteFee;
    protocolTradingUnclaimed += pool.protocolQuoteFee;
  }
  const poolCount = BigInt(pools.length);
  return {
    status: "live",
    claimableSol: lamportsToSol(tradingClaimable + creationClaimable),
    partnerTrading: feeAmounts(tradingClaimable, tradingLifetime),
    creation: feeAmounts(creationClaimable, partnerCreationFee * poolCount),
    protocol: {
      tradingLifetimeSol: lamportsToSol(protocolTradingLifetime),
      tradingUnclaimedSol: lamportsToSol(protocolTradingUnclaimed),
      creationLifetimeSol: lamportsToSol(protocolCreationFee * poolCount),
    },
    pools: pools.length,
    config: configAddress,
    readAt,
    error: null,
  };
}

function isVirtualPool(account: MeteoraRpcAccount): boolean {
  return account.data.length >= POOL_ACCOUNT_MIN_LENGTH
    && VIRTUAL_POOL_DISCRIMINATOR.every((byte, index) => account.data[index] === byte);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("On-chain fee read timed out")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function readFeesOnChain(env: RuntimeEnv, configAddress: string): Promise<AdminDashboardFees> {
  const rpcEnv = env as unknown as Parameters<typeof readAccount>[0];
  const [configAccount, poolAccounts] = await Promise.all([
    readAccount(rpcEnv, configAddress),
    readProgramAccounts(rpcEnv, { memcmpOffset: METEORA_CONFIG_OFFSET, memcmpBytes: bs58.decode(configAddress) }),
  ]);
  if (configAccount === null) throw new Error("Meteora config account not found");
  const config = decodeDbcFeeConfig(configAccount.data);
  const pools = poolAccounts.filter(isVirtualPool).map((account) => decodeDbcPoolFees(account.pubkey, account.data));
  return summarizePartnerFees(configAddress, config, pools, Math.floor(Date.now() / 1_000));
}

/** On-chain partner fees, cached for a minute. A failed read reports "unavailable", never a guess. */
export async function readFees(env: RuntimeEnv): Promise<AdminDashboardFees> {
  const configAddress = normalizeMeteoraConfigPubkey(envText(env, "METEORA_DBC_CONFIG"));
  if (!configAddress) return unavailableFees(null, "No Meteora config is published");
  const key = [configAddress, envText(env, "DIGGO_RPC_URL"), envText(env, "DIGGO_RPC_URLS")].join(":");
  const now = Date.now();
  if (feeCache !== null && feeCache.key === key && feeCache.expiresAt > now) return feeCache.fees;
  let fees: AdminDashboardFees;
  try {
    fees = await withTimeout(readFeesOnChain(env, configAddress), FEE_READ_TIMEOUT_MS);
  } catch (error) {
    console.error("Admin dashboard fee read failed", error);
    fees = unavailableFees(configAddress, "On-chain fee read failed");
  }
  feeCache = { key, expiresAt: now + (fees.status === "live" ? FEE_CACHE_TTL_MS : FEE_FAILURE_TTL_MS), fees };
  return fees;
}

async function readVaultSol(env: RuntimeEnv, vaultAddress: string | null): Promise<string | null> {
  if (vaultAddress === null) return null;
  try {
    const account = await getChainRpc(env).getBalance(address(vaultAddress)).send();
    return lamportsToSol(account.value);
  } catch {
    return null;
  }
}

async function readVault(env: RuntimeEnv, cluster: AdminDashboardPayload["cluster"]): Promise<AdminDashboardVault> {
  const vaultAddress = envText(env, "MINING_VAULT_PUBLIC_KEY");
  const [rows, solBalance] = await Promise.all([
    all<VaultBalanceRow>(env, "SELECT mint, token_account, amount, updated_at FROM meteora_vault_balances ORDER BY updated_at DESC LIMIT 50"),
    readVaultSol(env, vaultAddress),
  ]);
  const tokenBalances: AdminDashboardVaultBalance[] = rows === null ? [] : rows.map((row) => ({
    mint: String(row.mint),
    tokenAccount: String(row.token_account),
    amount: String(row.amount ?? "0"),
    updatedAt: countValue(row.updated_at) ?? 0,
  }));
  return { address: vaultAddress, solBalance, solscanUrl: vaultAddress === null ? null : solscanAddress(vaultAddress, cluster), tokenBalances };
}

async function readClaims(env: RuntimeEnv): Promise<AdminDashboardClaimCounts> {
  const game = await first<{ pending: number; paid: number }>(env, "SELECT SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) AS pending, SUM(CASE WHEN status = 'PAID' THEN 1 ELSE 0 END) AS paid FROM game_claims WHERE kind = 'MINING'");
  if (game !== null) return { pending: countValue(game.pending) ?? 0, paid: countValue(game.paid) ?? 0 };
  const meteora = await first<{ pending: number; paid: number }>(env, "SELECT SUM(CASE WHEN status IN ('PENDING','SENT') THEN 1 ELSE 0 END) AS pending, SUM(CASE WHEN status = 'SETTLED' THEN 1 ELSE 0 END) AS paid FROM meteora_vault_claims");
  return meteora === null ? { pending: null, paid: null } : { pending: countValue(meteora.pending) ?? 0, paid: countValue(meteora.paid) ?? 0 };
}

async function readPlayers(env: RuntimeEnv): Promise<AdminDashboardCount & { activeCrews: number | null }> {
  const now = Math.floor(Date.now() / 1_000);
  const [total, day, week, activeCrews] = await Promise.all([
    readCount(env, "SELECT COUNT(*) AS value FROM game_players"),
    readCount(env, "SELECT COUNT(*) AS value FROM game_players WHERE created_at >= ?1", [now - 86_400]),
    readCount(env, "SELECT COUNT(*) AS value FROM game_players WHERE created_at >= ?1", [now - 604_800]),
    readCount(env, "SELECT COUNT(*) AS value FROM game_players WHERE active_until > ?1", [now]),
  ]);
  return { total, last24h: day, last7d: week, activeCrews };
}

async function readReferrals(env: RuntimeEnv): Promise<AdminDashboardReferrals> {
  const attribution = await first<{ invited: number; qualified: number }>(env, "SELECT COUNT(*) AS invited, SUM(CASE WHEN status IN ('QUALIFIED','REWARDED') THEN 1 ELSE 0 END) AS qualified FROM referral_attributions");
  const gameOre = await first<{ ore: number }>(env, "SELECT SUM(CAST(ore_amount AS INTEGER)) AS ore FROM game_referral_credits");
  const legacyOre = gameOre === null ? await first<{ ore: number }>(env, "SELECT SUM(CAST(ore_amount AS INTEGER)) AS ore FROM referral_reward_events") : null;
  const oreRow = gameOre ?? legacyOre;
  return { invited: countValue(attribution?.invited), qualified: countValue(attribution?.qualified), oreCredited: oreRow === null ? null : String(countValue(oreRow.ore) ?? 0) };
}

async function readJobQueries(env: RuntimeEnv, successSql: string, errorSql: string): Promise<AdminDashboardJob> {
  const [success, error] = await Promise.all([
    first<{ at: number | null }>(env, successSql),
    first<{ at: number | null; detail: string | null }>(env, errorSql),
  ]);
  const lastSuccessfulAt = countValue(success?.at);
  const lastErrorAt = countValue(error?.at);
  const lastError = typeof error?.detail === "string" && lastSuccessfulAt !== null && lastErrorAt !== null && lastErrorAt > lastSuccessfulAt
    ? error.detail
    : null;
  return { lastSuccessfulAt: lastSuccessfulAt === 0 ? null : lastSuccessfulAt, lastError };
}

async function readJobs(env: RuntimeEnv): Promise<AdminDashboardPayload["jobs"]> {
  const [indexer, vaultSweep, cron] = await Promise.all([
    readJobQueries(env, "SELECT MAX(finished_at) AS at FROM indexer_runs WHERE kind = 'meteora:index' AND status = 'OK'", "SELECT finished_at AS at, detail FROM indexer_runs WHERE kind = 'meteora:index' AND status = 'FAILED' AND finished_at > 0 ORDER BY finished_at DESC LIMIT 1"),
    readJobQueries(env, "SELECT MAX(finished_at) AS at FROM indexer_runs WHERE kind = 'meteora:vault-sweep' AND status = 'OK'", "SELECT finished_at AS at, detail FROM indexer_runs WHERE kind = 'meteora:vault-sweep' AND status = 'FAILED' AND finished_at > 0 ORDER BY finished_at DESC LIMIT 1"),
    readJobQueries(env, "SELECT MAX(finished_at) AS at FROM indexer_runs WHERE kind = 'cron:meteora' AND status = 'OK'", "SELECT finished_at AS at, detail FROM indexer_runs WHERE kind = 'cron:meteora' AND status = 'FAILED' AND finished_at > 0 ORDER BY finished_at DESC LIMIT 1"),
  ]);
  return { indexer, vaultSweep, cron };
}

function solscanAddress(value: string, cluster: AdminDashboardPayload["cluster"]): string {
  return `https://solscan.io/account/${encodeURIComponent(value)}${cluster === "devnet" ? "?cluster=devnet" : ""}`;
}

function cacheKey(env: RuntimeEnv, actor: string, cluster: string, chainMode: string): string {
  return [actor, cluster, chainMode, envText(env, "DIGGO_TREASURY"), envText(env, "MINING_VAULT_PUBLIC_KEY")].join(":");
}

export async function adminDashboard(request: Request, env: RuntimeEnv): Promise<Response> {
  const actor = await adminActor(env, request);
  if (actor === null) return apiError("Admin session required", 403);
  const now = Date.now();
  const cluster = normalizeMeteoraCluster(env.SOLANA_CLUSTER);
  const chainMode = normalizeChainMode(envText(env, "CHAIN_MODE"));
  const key = cacheKey(env, actor, cluster, chainMode);
  const cached = cache.get(key);
  if (cached !== undefined && cached.expiresAt > now) return json(cached.payload, { headers: { "cache-control": "private, max-age=30" } });
  const treasury = envText(env, "DIGGO_TREASURY");
  const vaultAddress = envText(env, "MINING_VAULT_PUBLIC_KEY");
  let launches: Awaited<ReturnType<typeof readLaunches>>;
  let tradingVolume: AdminDashboardPayload["tradingVolume"];
  let fees: AdminDashboardPayload["fees"];
  let vault: AdminDashboardPayload["vault"];
  let claims: AdminDashboardPayload["claims"];
  let players: Awaited<ReturnType<typeof readPlayers>>;
  let referrals: AdminDashboardPayload["referrals"];
  let jobs: AdminDashboardPayload["jobs"];
  try {
    [launches, tradingVolume, fees, vault, claims, players, referrals, jobs] = await Promise.all([
      readLaunches(env), readVolume(env), readFees(env), readVault(env, cluster), readClaims(env), readPlayers(env), readReferrals(env), readJobs(env),
    ]);
  } catch (error) {
    console.error("Admin dashboard dependency failed", error);
    if (cached) return json(cached.payload, { headers: { "cache-control": "private, no-store", "x-diggo-dashboard-stale": "1" } });
    const unavailableCount: AdminDashboardCount = { total: null, last24h: null, last7d: null };
    const unavailablePayload: AdminDashboardPayload = {
      actor, generatedAt: Math.floor(now / 1_000), cachedUntil: Math.floor(now / 1_000), chainMode, cluster,
      launches: unavailableCount, graduated: unavailableCount, tradingVolume: { last24h: unavailableVolume(), last7d: unavailableVolume(), all: unavailableVolume() },
      fees: unavailableFees(null, "Dashboard dependency failed"), vault: { address: null, solBalance: null, solscanUrl: null, tokenBalances: [] },
      claims: { pending: null, paid: null }, players: unavailableCount, crews: { active24h: null },
      referrals: { invited: null, qualified: null, oreCredited: null }, jobs: { indexer: { lastSuccessfulAt: null, lastError: null }, vaultSweep: { lastSuccessfulAt: null, lastError: null }, cron: { lastSuccessfulAt: null, lastError: null } },
      addresses: { treasury: null, feeClaimer: METEORA_FEE_CLAIMER, vault: null },
      links: { treasury: null, feeClaimer: null, vault: null },
    };
    return json(unavailablePayload, { headers: { "cache-control": "private, no-store", "x-diggo-dashboard-stale": "1" } });
  }
  const payload: AdminDashboardPayload = {
    actor,
    generatedAt: Math.floor(now / 1_000),
    cachedUntil: Math.floor((now + CACHE_TTL_MS) / 1_000),
    chainMode,
    cluster,
    launches: launches.launches,
    graduated: launches.graduated,
    tradingVolume,
    fees,
    vault,
    claims,
    players: { total: players.total, last24h: players.last24h, last7d: players.last7d },
    crews: { active24h: players.activeCrews },
    referrals,
    jobs,
    addresses: { treasury, feeClaimer: METEORA_FEE_CLAIMER, vault: vaultAddress },
    links: {
      treasury: treasury === null ? null : solscanAddress(treasury, cluster),
      feeClaimer: solscanAddress(METEORA_FEE_CLAIMER, cluster),
      vault: vaultAddress === null ? null : solscanAddress(vaultAddress, cluster),
    },
  };
  cache.set(key, { expiresAt: now + CACHE_TTL_MS, payload });
  return json(payload, { headers: { "cache-control": "private, max-age=30" } });
}
