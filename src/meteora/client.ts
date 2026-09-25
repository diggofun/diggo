import {
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  signTransactionMessageWithSigners,
  type Address,
} from "@solana/kit";
import { decompileTransactionMessage as decompileMessage } from "@solana/transaction-messages";
import { DynamicBondingCurveClient, getCurrentPoint, ActivationType } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import type { DiggoWallet } from "../onchain/tx";
import { awaitConfirmation, isWalletConnectHandle, RPC_ENDPOINT, type SubmissionResult } from "../onchain/tx";
import { isMeteoraConfigPubkey } from "../../shared/meteora";

export const METEORA_RPC_ENDPOINT = RPC_ENDPOINT;

export function createMeteoraConnection(): Connection {
  // Web3.js requires an absolute HTTP(S) endpoint; the proxy path is relative so it stays
  // on the current origin without putting a provider URL or API key in the browser bundle.
  const endpoint = new URL(METEORA_RPC_ENDPOINT, globalThis.location.href).toString();
  return new Connection(endpoint, "confirmed");
}

export function createMeteoraClient(connection = createMeteoraConnection()): DynamicBondingCurveClient {
  return DynamicBondingCurveClient.create(connection, "confirmed");
}

export function assertMeteoraConfig(configPubkey: string): PublicKey {
  if (!isMeteoraConfigPubkey(configPubkey)) {
    throw new Error("Launching soon: the Meteora mainnet config is not ready yet.");
  }
  return new PublicKey(configPubkey.trim());
}

export async function sendMeteoraTransaction(
  wallet: DiggoWallet,
  transaction: Transaction,
  timeoutMs = 60_000,
): Promise<SubmissionResult> {
  if (isWalletConnectHandle(wallet)) {
    const signature = await wallet.provider.signAndSendTransaction(transaction);
    return settle(signature, timeoutMs);
  }

  // The pinned Meteora SDK builds Web3.js transactions. Decompiling the message lets the
  // existing Wallet Standard signer keep its own key; the raw private key never crosses the
  // client boundary or the Worker proxy.
  const compiled = getCompiledTransactionMessageDecoder().decode(new Uint8Array(transaction.serializeMessage()));
  const message = decompileMessage(compiled as never);
  const kitMessage = pipe(
    message,
    (current) => setTransactionMessageFeePayerSigner(wallet, current),
  );
  const signed = await signTransactionMessageWithSigners(kitMessage);
  const signature = getSignatureFromTransaction(signed);
  const wire = getBase64EncodedWireTransaction(signed);
  await createSolanaRpcSend(wire);
  return settle(signature, timeoutMs);
}

async function createSolanaRpcSend(wireTransaction: string): Promise<void> {
  const response = await fetch(METEORA_RPC_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "sendTransaction",
      params: [wireTransaction, { encoding: "base64", preflightCommitment: "confirmed" }],
    }),
    credentials: "same-origin",
  });
  const payload = (await response.json().catch(() => null)) as { result?: string; error?: { message?: string } } | null;
  if (!response.ok || !payload?.result) {
    throw new Error(payload?.error?.message ?? `RPC rejected the transaction (${response.status}).`);
  }
}

async function settle(signature: string, timeoutMs: number): Promise<SubmissionResult> {
  const confirmed = await awaitConfirmation(signature, timeoutMs);
  return {
    signature,
    status: confirmed ? "confirmed" : "pending",
    confirmed,
    ...(!confirmed ? { error: "Confirmation is still pending." } : {}),
  };
}

export function toAddress(value: string): Address {
  return value as Address;
}
