import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { ActivationType, SwapMode, getCurrentPoint } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { migrationThresholdLamports, type MeteoraPoolState } from "../../shared/meteora";
import { poolMetrics } from "../../shared/meteora/pool";
import type { DiggoWallet } from "../onchain/tx";
import { createMeteoraClient, sendMeteoraTransaction } from "./client";

export type MeteoraSwapSide = "buy" | "sell";

export interface MeteoraSwapQuote {
  side: MeteoraSwapSide;
  amountIn: bigint;
  amountOut: bigint;
  minimumAmountOut: bigint;
  feeAmount: bigint;
  priceSol: number;
}

export interface MeteoraSwapExecution {
  signature: string;
  confirmed: boolean;
  status: "confirmed" | "pending";
  amountOut: bigint;
}

export interface MeteoraPoolSnapshot {
  pool: MeteoraPoolState;
  metrics: ReturnType<typeof poolMetrics>;
}

export async function loadMeteoraPoolSnapshot(
  poolAddress: string,
  cluster: string,
): Promise<MeteoraPoolSnapshot> {
  const client = createMeteoraClient();
  const pool = new PublicKey(poolAddress);
  const state = await client.state.getPool(pool);
  const config = state ? await client.state.getPoolConfig(state.poolState.config) : null;
  if (!state || !config) throw new Error("Meteora pool state is not available yet.");
  const decoded = {
    baseMint: state.poolState.baseMint.toBase58(),
    config: state.poolState.config.toBase58(),
    baseReserve: BigInt(state.poolState.baseReserve.toString()),
    quoteReserve: BigInt(state.poolState.quoteReserve.toString()),
    isMigrated: state.poolState.isMigrated !== 0,
    migrationProgress: state.poolState.migrationProgress,
  } satisfies MeteoraPoolState;
  return {
    pool: decoded,
    metrics: poolMetrics(decoded, BigInt(config.migrationQuoteThreshold.toString()) || migrationThresholdLamports(cluster)),
  };
}

export async function quoteMeteoraSwap(
  poolAddress: string,
  side: MeteoraSwapSide,
  amount: bigint,
  slippageBps: number,
): Promise<MeteoraSwapQuote> {
  const client = createMeteoraClient();
  const pool = new PublicKey(poolAddress);
  const state = await client.state.getPool(pool);
  const config = state ? await client.state.getPoolConfig(state.poolState.config) : null;
  if (!state || !config) throw new Error("Meteora pool state is not available yet.");
  const currentPoint = await getCurrentPoint(client.connection, ActivationType.Timestamp);
  const quote = client.pool.swapQuote2({
    virtualPool: state,
    config,
    swapBaseForQuote: side === "sell",
    hasReferral: false,
    eligibleForFirstSwapWithMinFee: false,
    currentPoint,
    slippageBps,
    swapMode: SwapMode.ExactIn,
    amountIn: new BN(amount.toString()),
  });
  return {
    side,
    amountIn: amount,
    amountOut: BigInt(quote.outputAmount.toString()),
    minimumAmountOut: BigInt((quote.minimumAmountOut ?? new BN(0)).toString()),
    feeAmount: BigInt(quote.tradingFee.toString()),
    priceSol: quote.outputAmount.isZero()
      ? 0
      : side === "buy"
        ? Number(amount.toString()) / Number(quote.outputAmount.toString())
        : Number(quote.outputAmount.toString()) / Number(amount.toString()),
  };
}

export async function executeMeteoraSwap(input: {
  wallet: DiggoWallet;
  poolAddress: string;
  side: MeteoraSwapSide;
  amount: bigint;
  slippageBps: number;
}): Promise<MeteoraSwapExecution> {
  if (input.amount <= 0n) throw new Error("Enter an amount.");
  const client = createMeteoraClient();
  const pool = new PublicKey(input.poolAddress);
  const state = await client.state.getPool(pool);
  if (!state) throw new Error("Meteora pool state is not available yet.");
  const config = await client.state.getPoolConfig(state.poolState.config);
  if (!config) throw new Error("Meteora config is not available yet.");
  const currentPoint = await getCurrentPoint(client.connection, ActivationType.Timestamp);
  const quote = client.pool.swapQuote2({
    virtualPool: state,
    config,
    swapBaseForQuote: input.side === "sell",
    hasReferral: false,
    eligibleForFirstSwapWithMinFee: false,
    currentPoint,
    slippageBps: input.slippageBps,
    swapMode: SwapMode.ExactIn,
    amountIn: new BN(input.amount.toString()),
  });
  const minimumAmountOut = quote.minimumAmountOut;
  if (!minimumAmountOut || minimumAmountOut.isZero()) {
    throw new Error("The live quote produced no slippage floor; the trade was not sent.");
  }
  const transaction = await client.pool.swap2({
    owner: new PublicKey(input.wallet.address),
    pool,
    swapBaseForQuote: input.side === "sell",
    referralTokenAccount: null,
    swapMode: SwapMode.ExactIn,
    amountIn: new BN(input.amount.toString()),
    minimumAmountOut,
  });
  const submission = await sendMeteoraTransaction(input.wallet, transaction, { action: "trade", connection: client.connection });
  return {
    signature: submission.signature,
    confirmed: submission.confirmed,
    status: submission.status === "confirmed" ? "confirmed" : "pending",
    amountOut: BigInt(quote.outputAmount.toString()),
  };
}
