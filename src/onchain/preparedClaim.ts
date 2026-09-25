/**
 * Collecting a vault-prepared mining payout.
 *
 * The Meteora vault cannot be spent by the browser. The Worker builds the legacy SPL transfer,
 * signs it in the vault authority's own slot, and sends the result to the client as base64
 * (`PreparedClaimBatch` in api.ts; see the Worker claim-all preparation route). The client
 * owes that transaction exactly one thing: the player's own signature, in the player's slot, and
 * then the send. The vault signature is already in the bytes and has to survive that step - losing
 * it is the difference between a payout and a transaction the network rejects.
 *
 * What lives here is the step that was missing from the client: a prepared transaction arrived from
 * the Worker, was decoded, and was then discarded, so the claim could never be paid. Nothing in
 * this file decides an amount or an outcome. The instruction bytes, blockhash, fee payer and
 * amount all come from the Worker, and the Worker is what verifies the resulting signature before a
 * claim is recorded as paid.
 *
 * The prepared batch covers every eligible payout in one transaction, so this adds the single player
 * signature the Worker cannot provide.
 */
import {
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  isTransactionPartialSigner,
  isTransactionSendingSigner,
  type SignatureBytes,
  type Address,
  type Transaction,
  type TransactionWithinSizeLimit,
  type TransactionWithLifetime,
  type TransactionPartialSigner,
} from "@solana/kit";
import { getTransactionDecoder } from "@solana/transactions";
import type { PreparedClaimBatch } from "../api";
import { awaitConfirmation, isWalletConnectHandle, rpc, type DiggoWallet, type SubmissionStatus } from "./tx";

export interface PreparedClaimSubmission {
  /** The transaction's signature. Preserved even when confirmation has not landed yet. */
  signature: string;
  status: SubmissionStatus;
  confirmed: boolean;
  error?: string;
}

/** True when the Worker's own deadline has passed, so signing would only produce a failed transaction. */
export function isPreparedClaimExpired(payout: PreparedClaimBatch, nowSeconds: number): boolean {
  return Number(payout.expiresAt) <= nowSeconds;
}

/**
 * Decodes the base64 wire transaction the Worker sent.
 *
 * The bytes are untrusted input - a proxy, a stale deploy, a truncated response - and anything that
 * is not a decodable transaction must fail before a wallet is asked to sign it. A wallet cannot be
 * shown a transaction this function has not parsed, because then it could not be shown what it is
 * signing.
 */
export function decodePreparedTransaction(base64: string): Transaction {
  let bytes: Uint8Array;
  try {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
      throw new Error("Invalid base64");
    }
    bytes = new Uint8Array(Buffer.from(base64, "base64"));
  } catch {
    throw new Error("The prepared payout could not be decoded. Ask for a fresh one.");
  }
  try {
    return getTransactionDecoder().decode(bytes);
  } catch {
    throw new Error("The prepared payout is not a valid transaction. Ask for a fresh one.");
  }
}

/** Which signers the transaction still needs, and which it already carries. */
export function signatureStateOf(transaction: Transaction): { missing: string[]; present: string[] } {
  const missing: string[] = [];
  const present: string[] = [];
  const signatures = transaction.signatures as Readonly<Record<string, SignatureBytes | null>>;
  for (const [signer, signature] of Object.entries(signatures)) {
    if (signature === null) missing.push(signer);
    else present.push(signer);
  }
  return { missing, present };
}

/**
 * Folds one signature into a prepared transaction, leaving every other signature untouched.
 *
 * The vault signature is in `transaction.signatures` already; spreading the map rather than
 * rebuilding it is what keeps it. A signature for an address the message does not list is not this
 * transaction's signature and the wire codec would drop it, so it is rejected instead of ignored.
 */
export function mergeSignature(
  transaction: Transaction,
  signer: string,
  signature: SignatureBytes,
): Transaction {
  const signatures = transaction.signatures as Readonly<Record<string, SignatureBytes | null>>;
  if (!(signer in signatures)) {
    throw new Error("The wallet signed with an address this payout does not use.");
  }
  return { ...transaction, signatures: { ...signatures, [signer]: signature } } as Transaction;
}

/**
 * Signs a prepared payout with the player's wallet, sends it, and returns the signature.
 *
 * The signature comes back even when confirmation has not landed: the backend verifies the
 * transaction itself, so a payout that is merely slow must never be resubmitted. That is why this
 * returns a status instead of a bare string.
 */
export async function signPreparedClaim(params: {
  wallet: DiggoWallet;
  payout: PreparedClaimBatch;
  nowSeconds: number;
}): Promise<PreparedClaimSubmission> {
  const { wallet, payout } = params;
  if (isPreparedClaimExpired(payout, params.nowSeconds)) {
    throw new Error("This payout has expired. Request a fresh one.");
  }
  const transaction = decodePreparedTransaction(payout.transaction);
  const state = signatureStateOf(transaction);
  if (state.missing.length === 0) {
    // The Worker signed in every slot, so there is nothing left for the player to authorise.
    // Submitting it anyway would be a decision the client should not make on its own.
    throw new Error("This payout is already fully signed. Ask the backend to verify it.");
  }
  const player = String(wallet.address);
  if (state.missing.length !== 1 || state.missing[0] !== player) {
    throw new Error("This payout is not addressed to the connected wallet.");
  }

  let signature: string;
  if (isWalletConnectHandle(wallet)) {
    // WalletConnect speaks web3.js transactions, so the wire bytes are handed over as-is. It signs
    // and submits in one call, and the returned signature is the transaction id.
    const { Transaction: Web3Transaction } = await import("@solana/web3.js");
    const signed = await wallet.provider.signAndSendTransaction(
      Web3Transaction.from(Buffer.from(payout.transaction, "base64")),
    );
    signature = signed;
    return settle(signature);
  }

  if (isTransactionSendingSigner(wallet)) {
    // A sending signer submits as part of signing, so the wire bytes must already be complete. The
    // vault signature is present, so the only slot left is the player's.
    const [sent] = await wallet.signAndSendTransactions([transaction]);
    if (!sent) throw new Error("The wallet did not return a signature.");
    signature = getBase58Decoder().decode(sent);
    return settle(signature);
  }

  if (!isTransactionPartialSigner(wallet)) {
    throw new Error("The connected wallet cannot sign this prepared payout.");
  }
  const signable = transaction as Transaction & TransactionWithinSizeLimit & TransactionWithLifetime;
  const [dictionary] = await (wallet as TransactionPartialSigner).signTransactions([signable]);
  const playerSignature = dictionary?.[String(wallet.address) as Address];
  if (!playerSignature) throw new Error("The wallet did not return a signature.");
  const merged = mergeSignature(transaction, wallet.address, playerSignature);
  signature = getSignatureFromTransaction(merged);
  await rpc.sendTransaction(getBase64EncodedWireTransaction(merged), {
    encoding: "base64",
    preflightCommitment: "confirmed",
  }).send();
  return settle(signature);

  async function settle(value: string): Promise<PreparedClaimSubmission> {
    try {
      const confirmed = await awaitConfirmation(value);
      return confirmed
        ? { signature: value, status: "confirmed", confirmed: true }
        : {
            signature: value,
            status: "pending",
            confirmed: false,
            error: "Confirmation is still pending.",
          };
    } catch (error) {
      return {
        signature: value,
        status: "pending",
        confirmed: false,
        error: error instanceof Error ? error.message : "The RPC could not confirm this transaction yet.",
      };
    }
  }
}
