import { Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { SwapMode, ActivationType, getCurrentPoint, type SwapQuoteConfig } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { deriveMeteoraPoolAddresses } from "../../shared/meteora/pool";
import { requireMeteoraConfigPubkey } from "../../shared/meteora/config";
import type { DiggoWallet } from "../onchain/tx";
import { assertMeteoraConfig, createMeteoraClient, sendMeteoraTransaction } from "./client";

export interface MeteoraLaunchInput {
  wallet: DiggoWallet;
  name: string;
  symbol: string;
  metadataUri: string;
  configPubkey: string;
  initialBuySol?: number;
}

export interface MeteoraLaunchResult {
  mint: string;
  pool: string;
  signature: string;
  confirmed: boolean;
  status: "confirmed" | "pending";
}

export async function launchMeteoraCoin(input: MeteoraLaunchInput): Promise<MeteoraLaunchResult> {
  const config = assertMeteoraConfig(requireMeteoraConfigPubkey(input.configPubkey));
  const creator = new PublicKey(input.wallet.address);
  const mint = Keypair.generate();
  const client = createMeteoraClient();
  const buyLamports = Math.max(0, Math.floor((input.initialBuySol ?? 0) * 1_000_000_000));
  const firstBuy = buyLamports > 0 ? await buildFirstBuy(client, config, mint.publicKey, creator, buyLamports) : null;
  const transaction = await client.creator.createPoolWithFirstBuy({
    createPoolParam: {
      name: input.name,
      symbol: input.symbol.toUpperCase(),
      uri: input.metadataUri,
      payer: creator,
      poolCreator: creator,
      config,
      baseMint: mint.publicKey,
    },
    ...(firstBuy ? { firstBuyParam: firstBuy } : {}),
  });
  const submission = await sendMeteoraTransaction(input.wallet, transaction);
  return {
    mint: mint.publicKey.toBase58(),
    pool: deriveMeteoraPoolAddresses(mint.publicKey.toBase58(), config.toBase58()).pool,
    signature: submission.signature,
    confirmed: submission.confirmed,
    status: submission.status === "confirmed" ? "confirmed" : "pending",
  };
}

async function buildFirstBuy(
  client: ReturnType<typeof createMeteoraClient>,
  config: PublicKey,
  baseMint: PublicKey,
  buyer: PublicKey,
  buyLamports: number,
) {
  const poolConfig = await client.state.getPoolConfig(config);
  if (!poolConfig) throw new Error("The Meteora config does not exist on this cluster.");
  const activationType = poolConfig.activationType === ActivationType.Slot
    ? ActivationType.Slot
    : ActivationType.Timestamp;
  const currentPoint = await getCurrentPoint(client.connection, activationType);
  // The SDK's simulation normalizes an on-chain PoolConfig to this shape. The cast is kept at
  // the boundary because the SDK does not export the normalizer as a standalone function.
  const quoteConfig = poolConfig as unknown as SwapQuoteConfig;
  const quote = client.pool.getQuoteFromInputAmount({
    config: quoteConfig,
    swapBaseForQuote: false,
    amountIn: new BN(buyLamports),
    swapMode: SwapMode.ExactIn,
    slippageBps: 100,
    hasReferral: false,
    eligibleForFirstSwapWithMinFee: false,
    currentPoint,
  });
  if (!quote.minimumAmountOut || quote.minimumAmountOut.isZero()) {
    throw new Error("The live first-buy quote produced no slippage floor; the launch was not sent.");
  }
  return {
    buyer,
    receiver: buyer,
    buyAmount: new BN(buyLamports),
    minimumAmountOut: quote.minimumAmountOut,
    referralTokenAccount: null,
  };
}
