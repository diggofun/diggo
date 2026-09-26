import {
  addSignersToTransactionMessage,
  createKeyPairSignerFromBytes,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  isTransactionSendingSigner,
  setTransactionMessageFeePayerSigner,
  signAndSendTransactionMessageWithSigners,
  signTransactionMessageWithSigners,
  type Address,
} from "@solana/kit";
import { decompileTransactionMessage as decompileMessage } from "@solana/transaction-messages";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { Connection, PublicKey, Transaction, type Keypair } from "@solana/web3.js";
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

export interface SendMeteoraTransactionOptions {
  /** How long to wait for confirmation before returning a pending result. */
  timeoutMs?: number;
  /** Keypairs the transaction also needs, such as the freshly generated mint of a launch. */
  additionalSigners?: Keypair[];
  /** Noun used in user-facing errors: "trade", "launch", "claim". */
  action?: string;
  /** Connection used for the blockhash read. Defaults to the same-origin RPC proxy. */
  connection?: Pick<Connection, "getLatestBlockhash">;
}

export interface SimulationResult {
  err: unknown;
  logs: string[];
}

/**
 * Signs and sends a transaction built by the Meteora SDK.
 *
 * The SDK builds its transactions with Anchor's ".transaction()", which leaves recentBlockhash
 * and feePayer unset. Serializing such a transaction throws "Transaction recentBlockhash
 * required" before the wallet ever sees it, so every attempt copies the instructions into a new
 * transaction with a blockhash read immediately before signing, the connected wallet as fee
 * payer, and the blockhash's lastValidBlockHeight. The unsigned transaction is simulated first
 * so an on-chain failure is reported without a wallet prompt, and an attempt whose blockhash
 * expired (typically while the wallet popup waited) is rebuilt and retried once.
 */
export async function sendMeteoraTransaction(
  wallet: DiggoWallet,
  transaction: Transaction,
  options: SendMeteoraTransactionOptions = {},
): Promise<SubmissionResult> {
  const {
    timeoutMs = 60_000,
    additionalSigners = [],
    action = "transaction",
    connection = createMeteoraConnection(),
  } = options;
  const feePayer = new PublicKey(wallet.address);
  for (let attempt = 1; ; attempt += 1) {
    const canRetry = attempt < 2;
    const prepared = await withFreshLifetime(connection, transaction, feePayer);
    const simulation = await simulateUnsignedTransaction(prepared, action);
    if (simulation.err !== null && simulation.err !== undefined) {
      if (canRetry && isBlockhashExpiry(simulation.err)) continue;
      throw new Error(describeSimulationFailure(action, simulation.err, simulation.logs));
    }
    let signature: string;
    try {
      signature = await signAndSend(wallet, prepared, additionalSigners);
    } catch (failure) {
      if (canRetry && isBlockhashExpiry(failure)) continue;
      throw new Error(describeSendFailure(action, failure), { cause: failure });
    }
    return settle(signature, timeoutMs);
  }
}

/**
 * A copy of the transaction's instructions with a fresh lifetime and the wallet as fee payer.
 * Copying (instead of mutating) also drops any signature from an earlier attempt.
 */
export async function withFreshLifetime(
  connection: Pick<Connection, "getLatestBlockhash">,
  source: Transaction,
  feePayer: PublicKey,
): Promise<Transaction> {
  if (source.instructions.length === 0) throw new Error("The transaction has no instructions.");
  const latest = await connection.getLatestBlockhash("confirmed");
  if (!latest?.blockhash || !Number.isFinite(latest.lastValidBlockHeight)) {
    throw new Error("Could not read a recent blockhash from the network. Try again.");
  }
  const prepared = new Transaction({
    feePayer,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  });
  prepared.add(...source.instructions);
  return prepared;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

/**
 * Simulates the transaction before any signature exists. The Worker proxy only accepts an
 * unsigned simulation for the signed-in session wallet, which must also be the fee payer.
 */
export async function simulateUnsignedTransaction(transaction: Transaction, action = "transaction"): Promise<SimulationResult> {
  const wire = bytesToBase64(new Uint8Array(transaction.serialize({ requireAllSignatures: false, verifySignatures: false })));
  const response = await fetch(RPC_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "simulateTransaction",
      params: [wire, { encoding: "base64", commitment: "confirmed", sigVerify: false, replaceRecentBlockhash: false }],
    }),
  });
  if (response.status === 401) {
    throw new Error("Sign in with your wallet first, then try the " + action + " again.");
  }
  const payload = (await response.json().catch(() => null)) as
    | { result?: { value?: { err?: unknown; logs?: string[] | null } }; error?: { message?: string } }
    | null;
  if (!response.ok || !payload?.result?.value) {
    const reason = payload?.error?.message ?? "status " + response.status;
    throw new Error("The " + action + " could not be checked before signing (" + reason + "). Nothing was sent.");
  }
  return { err: payload.result.value.err ?? null, logs: payload.result.value.logs ?? [] };
}

async function signAndSend(wallet: DiggoWallet, transaction: Transaction, additionalSigners: Keypair[]): Promise<string> {
  assertReadyForWallet(transaction, wallet.address);
  if (isWalletConnectHandle(wallet)) {
    if (additionalSigners.length > 0) transaction.partialSign(...additionalSigners);
    return wallet.provider.signAndSendTransaction(transaction);
  }

  // The pinned Meteora SDK builds Web3.js transactions. Decompiling the message lets the
  // existing Wallet Standard signer keep its own key; the raw private key never crosses the
  // client boundary or the Worker proxy.
  const compiled = getCompiledTransactionMessageDecoder().decode(new Uint8Array(transaction.serializeMessage()));
  const message = decompileMessage(compiled as never, {
    lastValidBlockHeight: BigInt(transaction.lastValidBlockHeight ?? 0),
  });
  let kitMessage = setTransactionMessageFeePayerSigner(wallet, message as never);
  if (additionalSigners.length > 0) {
    const signers = await Promise.all(additionalSigners.map((keypair) => createKeyPairSignerFromBytes(keypair.secretKey)));
    kitMessage = addSignersToTransactionMessage(signers, kitMessage) as typeof kitMessage;
  }
  if (isTransactionSendingSigner(wallet)) {
    const signatureBytes = await signAndSendTransactionMessageWithSigners(kitMessage as never);
    return getBase58Decoder().decode(signatureBytes);
  }
  const signed = await signTransactionMessageWithSigners(kitMessage as never);
  const signature = getSignatureFromTransaction(signed);
  await sendWireTransaction(getBase64EncodedWireTransaction(signed));
  return signature;
}

/** The wallet must never receive a transaction it cannot sign or that the network will reject. */
export function assertReadyForWallet(transaction: Transaction, walletAddress: string): void {
  if (!transaction.recentBlockhash) throw new Error("Transaction recentBlockhash required");
  if (!transaction.lastValidBlockHeight) throw new Error("Transaction lastValidBlockHeight required");
  if (transaction.feePayer?.toBase58() !== walletAddress) throw new Error("The connected wallet must pay for this transaction.");
}

async function sendWireTransaction(wireTransaction: string): Promise<void> {
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

function errorText(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** True for the ways a node or wallet reports that the transaction's blockhash is no longer usable. */
export function isBlockhashExpiry(value: unknown): boolean {
  if (value instanceof Error && value.name === "TransactionExpiredBlockheightExceededError") return true;
  return /blockhash ?not ?found|block ?height exceeded|blockhash.*expired|expired.*blockhash|transaction.*has expired/i.test(errorText(value));
}

export function describeSimulationFailure(action: string, err: unknown, logs: string[]): string {
  const joined = logs.join("\n");
  const reason = errorText(err);
  if (/insufficient lamports|insufficient funds|InsufficientFundsFor/i.test(joined + reason)) {
    return "This wallet does not have enough SOL for this " + action + " plus network fees. Nothing was sent.";
  }
  const anchor = /Error Message: ([^\n]+)/.exec(joined);
  if (anchor) return "The " + action + " would fail on-chain: " + anchor[1].replace(/\.$/, "") + ". Nothing was sent.";
  return "The " + action + " simulation failed (" + reason + "). Nothing was sent.";
}

function describeSendFailure(action: string, failure: unknown): string {
  const message = errorText(failure);
  if (/user rejected|rejected the request|denied|cancel/i.test(message)) {
    return "You cancelled the " + action + " in your wallet.";
  }
  if (isBlockhashExpiry(failure)) {
    return "The " + action + " expired before it was approved. Nothing was sent; try again.";
  }
  return message || "The " + action + " could not be sent.";
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
