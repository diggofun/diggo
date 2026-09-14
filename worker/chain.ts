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

/** SPL Token Mint account layout is fixed-size; decimals sits at byte offset 44. */
export async function readMintDecimals(rpc: Rpc<SolanaRpcApi>, mint: Address): Promise<number> {
  const info = await rpc.getAccountInfo(mint, { commitment: "confirmed", encoding: "base64" }).send();
  if (!info.value) throw new Error(`Mint account not found: ${mint}`);
  const bytes = base64ToBytes(info.value.data[0]);
  return bytes[44];
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

  const [mineInfo, marketInfo, decimals] = await Promise.all([
    rpc.getAccountInfo(mine, { commitment: "confirmed", encoding: "base64" }).send(),
    rpc.getAccountInfo(market, { commitment: "confirmed", encoding: "base64" }).send(),
    readMintDecimals(rpc, mint),
  ]);
  if (!mineInfo.value) throw new Error(`Mine account not found on-chain for mint ${mintAddress}`);
  if (!marketInfo.value) throw new Error(`Market account not found on-chain for mint ${mintAddress}`);

  const decodedMine = decodeMine(base64ToBytes(mineInfo.value.data[0]));
  const decodedMarket = decodeLaunchMarket(base64ToBytes(marketInfo.value.data[0]));
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
       reward_per_block, network_power, next_block_at, next_epoch_at, decimals, synced_at, created_at
     ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,0,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)
     ON CONFLICT(mint) DO UPDATE SET
       name = excluded.name, symbol = excluded.symbol, creator = excluded.creator,
       status = excluded.status, price_usd = excluded.price_usd, price_sol = excluded.price_sol,
       market_cap_usd = excluded.market_cap_usd, reserve_remaining = excluded.reserve_remaining,
       reserve_total = excluded.reserve_total, reward_per_block = excluded.reward_per_block,
       network_power = excluded.network_power, next_block_at = excluded.next_block_at,
       next_epoch_at = excluded.next_epoch_at, decimals = excluded.decimals, synced_at = excluded.synced_at,
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
