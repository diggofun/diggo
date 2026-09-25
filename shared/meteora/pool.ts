import { PublicKey } from "@solana/web3.js";
import { deriveDbcPoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import {
  METEORA_TOKEN,
  METEORA_WRAPPED_SOL_MINT,
  migrationThresholdLamports,
} from "./config";

export interface MeteoraPoolState {
  baseMint: string;
  config: string;
  baseReserve: bigint;
  quoteReserve: bigint;
  isMigrated: boolean;
  migrationProgress: number;
}

export interface MeteoraPoolAddresses {
  baseMint: string;
  quoteMint: string;
  pool: string;
}

export interface MeteoraPoolMetrics {
  progress: number;
  progressBps: number;
  graduated: boolean;
  priceSol: number;
  priceSolPerToken: number;
  marketCapSol: number;
}

export function deriveMeteoraPoolAddresses(baseMint: string, config: string): MeteoraPoolAddresses {
  const base = new PublicKey(baseMint);
  const quote = new PublicKey(METEORA_WRAPPED_SOL_MINT);
  const poolConfig = new PublicKey(config);
  return {
    baseMint: base.toBase58(),
    quoteMint: quote.toBase58(),
    pool: deriveDbcPoolAddress(quote, base, poolConfig).toBase58(),
  };
}

export function decodeMeteoraPoolState(raw: {
  baseMint: PublicKey;
  config: PublicKey;
  baseReserve: bigint;
  quoteReserve: bigint;
  isMigrated: number;
  migrationProgress: number;
}): MeteoraPoolState {
  return {
    baseMint: raw.baseMint.toBase58(),
    config: raw.config.toBase58(),
    baseReserve: BigInt(raw.baseReserve),
    quoteReserve: BigInt(raw.quoteReserve),
    isMigrated: raw.isMigrated !== 0,
    migrationProgress: raw.migrationProgress,
  };
}

export function graduationProgress(
  quoteReserve: bigint,
  threshold: bigint,
  migrated = false,
): number {
  if (migrated) return 1;
  if (threshold <= 0n) return 0;
  const progress = Number((quoteReserve * 10_000n) / threshold) / 10_000;
  return Math.min(1, Math.max(0, progress));
}

export function poolMetrics(
  state: Pick<MeteoraPoolState, "baseReserve" | "quoteReserve" | "isMigrated">,
  threshold: bigint,
): MeteoraPoolMetrics {
  const progress = graduationProgress(state.quoteReserve, threshold, state.isMigrated);
  const baseWhole = Number(state.baseReserve) / 10 ** METEORA_TOKEN.decimals;
  const quoteSol = Number(state.quoteReserve) / 1_000_000_000;
  const priceSol = baseWhole > 0 ? quoteSol / baseWhole : 0;
  return {
    progress,
    progressBps: Math.round(progress * 10_000),
    graduated: state.isMigrated || progress >= 1,
    priceSol,
    priceSolPerToken: priceSol,
    marketCapSol: priceSol * Number(METEORA_TOKEN.curveSupply),
  };
}

export function expectedGraduationThresholdLamports(cluster: string): bigint {
  return migrationThresholdLamports(cluster);
}
