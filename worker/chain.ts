/**
 * Reads live state directly from the diggo_protocol Solana program and keeps D1's `tokens`
 * table as an honest cache of it. Nothing here fabricates data — every numeric field comes
 * from decoding a real account fetched over RPC (see shared/program.ts).
 */
import {
  type Address,
  address,
  createSolanaRpc,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";
import {
  decodeLaunchMarket,
  decodeMine,
  deriveMineAddresses,
  bondingCurveSpotPriceLamports,
  type DecodedMine,
  type DecodedLaunchMarket,
} from "../shared/program";
import type { TokenStatus, TokenSummary } from "../shared/types";

export const DEFAULT_DEVNET_RPC = "https://api.devnet.solana.com";

/**
 * Illustrative-only SOL/USD conversion for display. Devnet SOL has no real value and this
 * project has no live price oracle wired up yet — see docs/ARCHITECTURE.md. Never treat
 * priceUsd as authoritative; priceSol (read straight from the bonding curve) is the real value.
 */
export const ILLUSTRATIVE_DEVNET_SOL_USD = 150;

let cachedRpc: Rpc<SolanaRpcApi> | null = null;
let cachedRpcUrl: string | null = null;

export function getChainRpc(env: { DIGGO_RPC_URL?: string }): Rpc<SolanaRpcApi> {
  const url = env.DIGGO_RPC_URL || DEFAULT_DEVNET_RPC;
  if (cachedRpc && cachedRpcUrl === url) return cachedRpc;
  cachedRpc = createSolanaRpc(url);
  cachedRpcUrl = url;
  return cachedRpc;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export interface MintInfo {
  decimals: number;
  /**
   * A revoked mint authority means no new supply can ever be created, which is what makes a mine's
   * fixed supply honest. Read straight from the SPL mint, not assumed.
   */
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
}

function readU32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0
  );
}

/**
 * SPL Token Mint account layout: mintAuthorityOption (u32) 0, mintAuthority 4..36, supply 36..44,
 * decimals 44, isInitialized 45, freezeAuthorityOption (u32) 46..50, freezeAuthority 50..82.
 * A COption is "Some" when its tag is 1, so authority revoked === tag 0.
 *
 * An unrecognised (too short) layout reports the authorities as NOT revoked: unknown is treated as
 * worse health, so an unreadable mint can only ever lower a discovery's rarity, never raise it.
 */
export async function readMintInfo(rpc: Rpc<SolanaRpcApi>, mint: Address): Promise<MintInfo> {
  const info = await rpc.getAccountInfo(mint, { commitment: "confirmed", encoding: "base64" }).send();
  if (!info.value) throw new Error(`Mint account not found: ${mint}`);
  const bytes = base64ToBytes(info.value.data[0]);
  const recognized = bytes.length >= 82;
  return {
    decimals: bytes[44] ?? 6,
    mintAuthorityRevoked: recognized && readU32LE(bytes, 0) === 0,
    freezeAuthorityRevoked: recognized && readU32LE(bytes, 46) === 0,
  };
}

function mineStatusToTokenStatus(mine: DecodedMine, market: DecodedLaunchMarket): TokenStatus {
  if (mine.status === "FullyMined") return "FULLY_MINED";
  if (mine.status === "MiningActive" || market.graduated) return "MINING_ACTIVE";
  return "LAUNCHING";
}

export interface ChainSyncedToken {
  mint: string;
  name: string;
  symbol: string;
  creator: string;
  status: TokenStatus;
  priceSol: number;
  priceUsd: number;
  marketCapUsd: number;
  reserveRemaining: number;
  reserveTotal: number;
  rewardPerBlock: number;
  networkPower: number;
  nextBlockAt: number;
  nextEpochAt: number;
  decimals: number;
  /** Program-controlled Discovery Reserve, in whole tokens (spec 23). */
  discoveryReserveRemaining: number;
  discoveryReserveTotal: number;
  discoveryEpochBudget: number;
  discoveryEpochSpent: number;
  discoveryEpochEndsAt: number;
  /** The program's own per-mine discovery circuit breaker (spec 65). */
  discoveryPaused: boolean;
  /** Program-controlled liquidity backing the price, in USD at the illustrative SOL rate. */
  liquidityUsd: number;
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  /**
   * Always true for this protocol: the bonding-curve SOL and the post-graduation LP are held in
   * program PDAs, so no creator or admin can withdraw them (spec 35, 36).
   */
  liquidityLocked: boolean;
}

/**
 * Fetches a mine's Mine + LaunchMarket accounts (and its mint's decimals) directly from the
 * chain and returns the fields diggo's `tokens` cache needs. Throws if the mine has not
 * actually been launched on-chain — callers should not silently fall back to fabricated data.
 */
export async function readTokenFromChain(
  env: { DIGGO_RPC_URL?: string; DIGGO_PROGRAM_ID: string },
  mintAddress: string,
): Promise<ChainSyncedToken> {
  const rpc = getChainRpc(env);
  const programAddress = address(env.DIGGO_PROGRAM_ID);
  const mint = address(mintAddress);
  const { mine, market } = await deriveMineAddresses(programAddress, mint);

  const [mineInfo, marketInfo, mintInfo] = await Promise.all([
    rpc.getAccountInfo(mine, { commitment: "confirmed", encoding: "base64" }).send(),
    rpc.getAccountInfo(market, { commitment: "confirmed", encoding: "base64" }).send(),
    readMintInfo(rpc, mint),
  ]);
  if (!mineInfo.value) throw new Error(`Mine account not found on-chain for mint ${mintAddress}`);
  if (!marketInfo.value) throw new Error(`Market account not found on-chain for mint ${mintAddress}`);

  const decodedMine = decodeMine(base64ToBytes(mineInfo.value.data[0]));
  const decodedMarket = decodeLaunchMarket(base64ToBytes(marketInfo.value.data[0]));
  const decimals = mintInfo.decimals;
  const scale = 10 ** decimals;

  const priceSol = bondingCurveSpotPriceLamports(decodedMarket, decimals) / 1_000_000_000;
  const priceUsd = priceSol * ILLUSTRATIVE_DEVNET_SOL_USD;
  const totalSupplyWhole = Number(decodedMine.totalSupply) / scale;
  const reserveTotal = Number(decodedMine.remainingReserve + decodedMine.cumulativeDistributed) / scale;

  return {
    mint: mintAddress,
    name: decodedMine.name,
    symbol: decodedMine.symbol,
    creator: decodedMine.creator,
    status: mineStatusToTokenStatus(decodedMine, decodedMarket),
    priceSol,
    priceUsd,
    marketCapUsd: priceUsd * totalSupplyWhole,
    reserveRemaining: Number(decodedMine.remainingReserve) / scale,
    reserveTotal,
    rewardPerBlock: Number(decodedMine.currentBlockReward) / scale,
    networkPower: Number(decodedMine.totalPower),
    nextBlockAt: Number(decodedMine.nextBlockAt),
    nextEpochAt: Number(decodedMine.epochEndsAt),
    decimals,
    discoveryReserveRemaining: Number(decodedMine.remainingDiscoveryReserve) / scale,
    discoveryReserveTotal: Number(decodedMine.discoveryReserveTotal) / scale,
    discoveryEpochBudget: Number(decodedMine.discoveryEpochBudget) / scale,
    discoveryEpochSpent: Number(decodedMine.discoveryEpochSpent) / scale,
    discoveryEpochEndsAt: Number(decodedMine.discoveryEpochEndsAt),
    discoveryPaused: decodedMine.discoveryPaused,
    liquidityUsd: (Number(decodedMarket.solReserve) / 1_000_000_000) * ILLUSTRATIVE_DEVNET_SOL_USD,
    mintAuthorityRevoked: mintInfo.mintAuthorityRevoked,
    freezeAuthorityRevoked: mintInfo.freezeAuthorityRevoked,
    liquidityLocked: true,
  };
}

function slugify(symbol: string, mint: string): string {
  const base = symbol.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return base ? `${base}-${mint.slice(0, 4).toLowerCase()}` : mint.toLowerCase();
}

/**
 * Re-reads a mine from chain and upserts D1's cache row. `imageKey`/`description` are only
 * ever used to fill in display metadata the chain doesn't store — every numeric/status field
 * always comes from the fresh on-chain read, never from the caller.
 */
export async function syncTokenToD1(
  env: { DB: D1Database; DIGGO_RPC_URL?: string; DIGGO_PROGRAM_ID: string },
  mintAddress: string,
  metadata?: { description?: string; imageKey?: string | null },
): Promise<TokenSummary> {
  const chain = await readTokenFromChain(env, mintAddress);
  const existing = await env.DB.prepare("SELECT slug, description, image_key, created_at FROM tokens WHERE mint = ?1")
    .bind(mintAddress)
    .first<{ slug: string; description: string; image_key: string | null; created_at: number }>();

  const slug = existing?.slug ?? slugify(chain.symbol, mintAddress);
  const description = metadata?.description ?? existing?.description ?? "";
  const imageKey = metadata?.imageKey !== undefined ? metadata.imageKey : (existing?.image_key ?? null);
  const now = Math.floor(Date.now() / 1_000);
  const createdAt = existing?.created_at ?? now;

  await env.DB.prepare(
    `INSERT INTO tokens (
       mint, slug, name, symbol, description, creator, image_key, status,
       price_usd, price_sol, change_24h, market_cap_usd, reserve_remaining, reserve_total,
       reward_per_block, network_power, next_block_at, next_epoch_at, decimals, synced_at, created_at,
       discovery_reserve_remaining, discovery_reserve_total, discovery_epoch_budget,
       discovery_epoch_spent, discovery_epoch_ends_at, discovery_paused, liquidity_usd,
       mint_authority_revoked, freeze_authority_revoked, liquidity_locked, discovery_synced_at
     ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,0,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,
               ?23,?24,?25,?26,?27,?28,?29,?30,?31,?32,?33)
     ON CONFLICT(mint) DO UPDATE SET
       name = excluded.name, symbol = excluded.symbol, creator = excluded.creator,
       status = excluded.status, price_usd = excluded.price_usd, price_sol = excluded.price_sol,
       market_cap_usd = excluded.market_cap_usd, reserve_remaining = excluded.reserve_remaining,
       reserve_total = excluded.reserve_total, reward_per_block = excluded.reward_per_block,
       network_power = excluded.network_power, next_block_at = excluded.next_block_at,
       next_epoch_at = excluded.next_epoch_at, decimals = excluded.decimals, synced_at = excluded.synced_at,
       discovery_reserve_remaining = excluded.discovery_reserve_remaining,
       discovery_reserve_total = excluded.discovery_reserve_total,
       discovery_epoch_budget = excluded.discovery_epoch_budget,
       discovery_epoch_spent = excluded.discovery_epoch_spent,
       discovery_epoch_ends_at = excluded.discovery_epoch_ends_at,
       discovery_paused = excluded.discovery_paused,
       liquidity_usd = excluded.liquidity_usd,
       mint_authority_revoked = excluded.mint_authority_revoked,
       freeze_authority_revoked = excluded.freeze_authority_revoked,
       liquidity_locked = excluded.liquidity_locked,
       discovery_synced_at = excluded.discovery_synced_at,
       description = CASE WHEN ?21 THEN excluded.description ELSE tokens.description END,
       image_key = CASE WHEN ?22 THEN excluded.image_key ELSE tokens.image_key END`,
  )
    .bind(
      mintAddress, slug, chain.name, chain.symbol, description, chain.creator, imageKey, chain.status,
      chain.priceUsd, chain.priceSol, chain.marketCapUsd, chain.reserveRemaining, chain.reserveTotal,
      chain.rewardPerBlock, chain.networkPower, chain.nextBlockAt, chain.nextEpochAt, chain.decimals,
      now, createdAt,
      metadata?.description !== undefined ? 1 : 0,
      metadata?.imageKey !== undefined ? 1 : 0,
      chain.discoveryReserveRemaining,
      chain.discoveryReserveTotal,
      chain.discoveryEpochBudget,
      chain.discoveryEpochSpent,
      chain.discoveryEpochEndsAt,
      chain.discoveryPaused ? 1 : 0,
      chain.liquidityUsd,
      chain.mintAuthorityRevoked ? 1 : 0,
      chain.freezeAuthorityRevoked ? 1 : 0,
      chain.liquidityLocked ? 1 : 0,
      now,
    )
    .run();

  return {
    mint: mintAddress,
    slug,
    name: chain.name,
    symbol: chain.symbol,
    description,
    creator: chain.creator,
    imageUrl: imageKey ? `/media/${imageKey}` : null,
    status: chain.status,
    priceSol: chain.priceSol,
    priceUsd: chain.priceUsd,
    change24h: 0,
    marketCapUsd: chain.marketCapUsd,
    reserveRemaining: chain.reserveRemaining,
    reserveTotal: chain.reserveTotal,
    rewardPerBlock: chain.rewardPerBlock,
    networkPower: chain.networkPower,
    nextBlockAt: chain.nextBlockAt,
    nextEpochAt: chain.nextEpochAt,
    createdAt,
    decimals: chain.decimals,
  };
}
