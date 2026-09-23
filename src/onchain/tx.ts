/**
 * Wallet plumbing: turning built instructions into a confirmed transaction, whichever way the
 * player connected.
 *
 * Two connection shapes exist and only this module branches on them. Wallet Standard (desktop
 * extensions, most in-app browsers) is a @solana/kit `TransactionSigner`. WalletConnect
 * (QR-paired wallets) is a Reown `Provider` whose signing methods take @solana/web3.js
 * `Transaction`s. Both expose `.address`, so PDA derivation and instruction building never
 * branch — only submission does.
 *
 * Every write in this module is signed by the connected wallet. No backend key exists on any
 * path, which is the property the whole v2 design is built around.
 */
import {
  createSolanaRpc,
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  signTransactionMessageWithSigners,
  signAndSendTransactionMessageWithSigners,
  isTransactionSendingSigner,
  getSignatureFromTransaction,
  getBase64EncodedWireTransaction,
  getBase58Decoder,
  pipe,
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import { Buffer } from "buffer";
import { PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import type { Provider as WalletConnectSolanaProvider } from "@reown/appkit-adapter-solana/react";
import { describeDiggoError, diggoErrorName } from "../../shared/program";

/** A `{ InstructionError: [index, { Custom: code }] }`-shaped RPC error. */
function customErrorCode(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const instructionError = (error as { InstructionError?: unknown }).InstructionError;
  if (!Array.isArray(instructionError)) return null;
  const detail = instructionError[1];
  if (typeof detail === "object" && detail !== null && "Custom" in detail) {
    const code = (detail as { Custom: unknown }).Custom;
    if (typeof code === "number") return code;
  }
  return null;
}

/**
 * The sentence to show for whatever the RPC reported. A program refusal becomes the sentence
 * shared/program.ts holds for that variant; anything else becomes a plain description, so a
 * caller never renders a bare error number.
 */
export function describeTransactionError(error: unknown): string {
  const code = customErrorCode(error);
  if (code !== null) {
    const name = diggoErrorName(code);
    return name ? describeDiggoError(code) : `The program refused that (error ${code}).`;
  }
  if (typeof error === "string") return error;
  return `The transaction failed: ${JSON.stringify(error)}`;
}

/**
 * The Worker's RPC proxy. Reads and writes both go through it so no RPC provider API key is
 * ever embedded in the browser bundle. Exported so a caller that needs a different endpoint
 * (a test, or a cluster without the proxy) can build its own client from the same factory.
 */
export const RPC_ENDPOINT = "/api/rpc";

export const rpc = createSolanaRpc(RPC_ENDPOINT);

export interface WalletConnectHandle {
  kind: "walletconnect";
  address: Address;
  provider: WalletConnectSolanaProvider;
}

export type DiggoWallet = TransactionSigner | WalletConnectHandle;

export function isWalletConnectHandle(wallet: DiggoWallet): wallet is WalletConnectHandle {
  return (wallet as WalletConnectHandle).kind === "walletconnect";
}

/** The wallet's address, whichever shape it is. */
export function walletAddress(wallet: DiggoWallet): Address {
  return wallet.address;
}

export type SubmissionStatus = "submitted" | "confirmed" | "pending" | "rejected";

/**
 * A submitted transaction and the state known at the time this result is returned.
 *
 * `pending` means the signature is valid and the network had not confirmed it before the
 * deadline. It must not be treated as a failed submission: the transaction may still land.
 */
export interface SubmissionResult {
  signature: string;
  status: SubmissionStatus;
  confirmed: boolean;
  error?: string;
}

/**
 * A submitted transaction whose confirmation did not arrive before the polling deadline.
 *
 * Legacy string-returning callers must not receive a signature on this path because they have
 * no way to distinguish it from confirmed success. The signature is carried on the error so a
 * UI can show a pending transaction and check it later without inviting a blind retry.
 */
export class PendingTransactionError extends Error {
  readonly name = "PendingTransactionError";
  readonly signature: string;
  readonly status = "pending" as const;
  readonly confirmed = false;
  /** Action-specific recovery data, such as the launch mint already derived for this signature. */
  mint?: string;

  constructor(signature: string, mint?: string) {
    super(`Transaction submitted but still pending. Signature: ${signature}`);
    this.signature = signature;
    this.mint = mint;
  }
}

/** The chain explicitly reported an execution error for a signature. */
export class RejectedTransactionError extends Error {
  readonly name = "RejectedTransactionError";
  readonly signature: string;

  constructor(signature: string, message: string) {
    super(message);
    this.signature = signature;
  }
}

export function isPendingTransactionError(error: unknown): error is PendingTransactionError {
  return error instanceof PendingTransactionError || (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "PendingTransactionError" &&
    typeof (error as { signature?: unknown }).signature === "string"
  );
}

/** @solana/kit's AccountRole is bit-flagged: bit0 writable, bit1 signer. */
function toWeb3Instruction(ix: Instruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programAddress),
    keys: (ix.accounts ?? []).map((account) => ({
      pubkey: new PublicKey(account.address),
      isSigner: (account.role & 2) !== 0,
      isWritable: (account.role & 1) !== 0,
    })),
    data: Buffer.from(ix.data ?? new Uint8Array()),
  });
}

/**
 * Waits for a signature to reach confirmed. Returns false when the deadline passes, and
 * throws when the chain reports the transaction as failed: "not seen yet" and "rejected" are
 * different outcomes, and only the first one is the caller's choice. A rejection is turned
 * into the program's own sentence through `describeTransactionError`.
 */
export async function awaitConfirmation(signature: string, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value } = await rpc.getSignatureStatuses([signature as never]).send();
    const status = value[0];
    if (status?.err) throw new RejectedTransactionError(signature, describeTransactionError(status.err));
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  return false;
}

/**
 * Submits instructions, signed by the connected wallet, and returns once they are confirmed.
 *
 * A confirmation timeout returns a pending result with its signature, because a transaction
 * that landed must not be lost to a slow RPC. The `tolerantConfirmation` argument is retained for
 * compatibility: all results now preserve the signature, while structured callers can handle
 * `pending` and `rejected` explicitly.
 *
 * Legacy messages are used deliberately. The v2 discovery and player instructions fit well
 * inside 1,232 bytes with no lookup table, and browser wallets (notably OKX) decode legacy
 * account changes reliably where they showed a versioned v0 message as "Unknown transaction"
 * with the confirm button disabled even though the instruction bytes were valid. The one
 * exception is `launch_token`, whose account list is long enough that callers should pass a
 * lookup table; see submitWithLookupTable.
 */
export async function submit(
  feePayer: DiggoWallet,
  instructions: Instruction[],
  tolerantConfirmation = false,
): Promise<SubmissionResult> {
  const settle = async (signature: string, timeoutMs?: number): Promise<SubmissionResult> => {
    try {
      const confirmed = await awaitConfirmation(signature, timeoutMs);
      if (!confirmed && !tolerantConfirmation) {
        return {
          signature,
          status: "pending",
          confirmed: false,
          error: "Confirmation is still pending.",
        };
      }
      return {
        signature,
        status: confirmed ? "confirmed" : "pending",
        confirmed,
        ...(!confirmed ? { error: "Confirmation is still pending." } : {}),
      };
    } catch (failure) {
      if (!(failure instanceof RejectedTransactionError)) {
        return {
          signature,
          status: "pending",
          confirmed: false,
          error: failure instanceof Error ? failure.message : "The RPC could not confirm this transaction yet.",
        };
      }
      return {
        signature,
        status: "rejected",
        confirmed: false,
        error: describeTransactionError(failure),
      };
    }
  };

  if (isWalletConnectHandle(feePayer)) {
    const { value: latestBlockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
    const tx = new Transaction();
    tx.feePayer = new PublicKey(feePayer.address);
    tx.recentBlockhash = latestBlockhash.blockhash;
    for (const ix of instructions) tx.add(toWeb3Instruction(ix));
    const signature = await feePayer.provider.signAndSendTransaction(tx);
    return settle(signature, 60_000);
  }

  const { value: latestBlockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const message = pipe(
    createTransactionMessage({ version: "legacy" }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );

  if (isTransactionSendingSigner(feePayer)) {
    const signatureBytes = await signAndSendTransactionMessageWithSigners(message);
    const signature = getBase58Decoder().decode(signatureBytes) as string;
    // Send-capable signers return as soon as the RPC accepts the transaction. The next API
    // call reads the newly-created PDAs, so wait for confirmed state rather than racing the
    // indexer and leaving an already-launched coin invisible in the dashboard.
    return settle(signature, 60_000);
  }

  const signedTx = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(signedTx);
  const wireTransaction = getBase64EncodedWireTransaction(signedTx);
  await rpc.sendTransaction(wireTransaction, { encoding: "base64", preflightCommitment: "confirmed" }).send();
  return settle(signature);
}

export interface SignSendConfirmOptions {
  /** Return the full submission state instead of the legacy signature string. */
  returnResult?: boolean;
}

/**
 * Submits a transaction and returns its signature.
 *
 * The legacy string form remains source-compatible with existing action modules. It resolves
 * only after confirmation; a timeout throws `PendingTransactionError` with the signature, so a
 * string return can never be mistaken for confirmed success. Callers that can present structured
 * states can request the full result with `{ returnResult: true }`.
 */
export async function signSendConfirm(
  feePayer: DiggoWallet,
  instructions: Instruction[],
  options: SignSendConfirmOptions & { returnResult: true },
): Promise<SubmissionResult>;
export async function signSendConfirm(
  feePayer: DiggoWallet,
  instructions: Instruction[],
  options?: SignSendConfirmOptions,
): Promise<string>;
export async function signSendConfirm(
  feePayer: DiggoWallet,
  instructions: Instruction[],
  options: SignSendConfirmOptions = {},
): Promise<string | SubmissionResult> {
  const result = await submit(feePayer, instructions, true);
  if (options.returnResult) return result;
  if (result.status === "rejected") throw new Error(result.error ?? "The transaction was rejected.");
  if (result.status === "pending") throw new PendingTransactionError(result.signature);
  return result.signature;
}
