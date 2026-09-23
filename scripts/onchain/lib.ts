/**
 * Shared plumbing for the one-off on-chain operations under scripts/onchain. Kept
 * dependency-free on purpose: everything it needs is already a project dependency, and the
 * scripts are meant to be run directly with Node (node scripts/onchain/<name>.ts), which
 * strips the TypeScript types natively.
 *
 * Every script here is dry-run by default and only acts when passed --execute, because each
 * one changes who controls real money. Nothing in here is imported by the Worker or the
 * frontend: these are operator tools, not runtime code.
 */
import {
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import bs58 from "bs58";

export const DEFAULT_RPC_URL = process.env.DIGGO_RPC_URL ?? "https://api.mainnet-beta.solana.com";

export type CliOptions = Record<string, string | boolean>;

/** Minimal --flag / --key value parser. Unknown flags are rejected, not ignored. */
export function parseArgs(argv: string[], known: string[]): CliOptions {
  const options: CliOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) throw new Error("unexpected argument: " + token);
    const name = token.slice(2);
    if (!known.includes(name)) throw new Error("unknown flag: --" + name);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      options[name] = true;
    } else {
      options[name] = next;
      i++;
    }
  }
  return options;
}

export function flag(options: CliOptions, name: string): boolean {
  return options[name] === true;
}

export function optional(options: CliOptions, name: string): string | undefined {
  const value = options[name];
  return typeof value === "string" ? value : undefined;
}

export function required(options: CliOptions, name: string): string {
  const value = optional(options, name);
  if (!value) throw new Error("--" + name + " is required");
  return value;
}

export function expandHome(path: string): string {
  return path.startsWith("~/") ? homedir() + path.slice(1) : path;
}

/**
 * Loads a Solana CLI keypair file: either the JSON array of 64 bytes the CLI writes, or a
 * base58 secret key. Only the operator running the script ever sees these bytes.
 */
export async function loadKeypairSigner(path: string): Promise<KeyPairSigner> {
  const raw = readFileSync(expandHome(path), "utf8").trim();
  const bytes = raw.startsWith("[")
    ? Uint8Array.from(JSON.parse(raw) as number[])
    : bs58.decode(raw);
  if (bytes.length !== 64) {
    throw new Error(
      "expected a 64-byte keypair at " + path + " but found " + bytes.length + " bytes",
    );
  }
  return createKeyPairSignerFromBytes(bytes);
}

/**
 * Same as loadKeypairSigner, but returns null instead of throwing when the file is missing
 * or malformed. The dry run reads on-chain state first and does not need any key at all, so
 * a plan can be reviewed before the operator goes looking for the right keypair.
 */
export async function tryLoadKeypairSigner(path: string): Promise<KeyPairSigner | null> {
  try {
    return await loadKeypairSigner(path);
  } catch (error) {
    console.error("note: could not load keypair " + path + " (" + String(error) + ")");
    return null;
  }
}

export function rpcFor(url: string): Rpc<SolanaRpcApi> {
  return createSolanaRpc(url);
}

/** Signs, sends and waits for one transaction to confirm. Returns its signature. */
export async function sendAndConfirm(
  rpc: Rpc<SolanaRpcApi>,
  feePayer: KeyPairSigner,
  instructions: Instruction[],
): Promise<string> {
  const { value: latestBlockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(signed);
  await rpc
    .sendTransaction(getBase64EncodedWireTransaction(signed), {
      encoding: "base64",
      preflightCommitment: "confirmed",
    })
    .send();

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const status = value[0];
    if (status?.err) throw new Error("transaction failed: " + JSON.stringify(status.err));
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      return signature;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("timed out waiting for " + signature + " to confirm");
}

export interface AccountSnapshot {
  address: Address;
  owner: Address;
  lamports: bigint;
  dataLength: number;
  data: Uint8Array;
}

/** Reads one account, or null when it does not exist. */
export async function readAccount(
  rpc: Rpc<SolanaRpcApi>,
  account: Address,
): Promise<AccountSnapshot | null> {
  const { value } = await rpc
    .getAccountInfo(account, { commitment: "confirmed", encoding: "base64" })
    .send();
  if (!value) return null;
  return {
    address: account,
    owner: address(value.owner),
    lamports: BigInt(value.lamports),
    dataLength: value.data.length,
    data: base64ToBytes(value.data[0]),
  };
}

export function base64ToBytes(base64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(base64, "base64"));
}

export function shortAddress(value: string): string {
  return value.slice(0, 4) + "..." + value.slice(-4);
}

export function heading(title: string): void {
  console.log("");
  console.log(title);
  console.log("-".repeat(title.length));
}

export function row(label: string, value: string): void {
  console.log("  " + label.padEnd(26) + value);
}

/** Thrown by abort(); the top-level handler turns it into a non-zero exit code. */
export class Aborted extends Error {}

/**
 * Stops the script with a clear message. It throws rather than calling process.exit so the
 * runtime can close its handles normally — exiting mid-flight makes Node print a spurious
 * libuv assertion on the way out.
 */
export function abort(message: string): never {
  console.error("");
  console.error("ABORTED: " + message);
  throw new Aborted(message);
}

/** Standard entrypoint wrapper: quiet for a deliberate abort, loud for a real error. */
export function run(main: () => Promise<void>): void {
  main().catch((error: unknown) => {
    if (!(error instanceof Aborted)) console.error(String(error));
    process.exitCode = 1;
  });
}
