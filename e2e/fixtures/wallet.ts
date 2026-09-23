/**
 * The ed25519 identity the e2e suite signs with.
 *
 * One wallet per Playwright worker process: the files run in parallel and each worker owning its
 * own wallet keeps the players/positions rows they create in the local D1 from colliding. A fresh
 * key per run also means the mining loop always starts from a first-run crew, which is the state
 * the activation test needs to assert.
 *
 * Signing happens in Node, through a Playwright binding the injected wallet calls (see
 * e2e/support/mockWallet.ts), and never in the page: only message and transaction bytes cross into
 * the browser, so the private key is unreachable from the page under test.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";

export interface E2eWallet {
  secretKey: Uint8Array;
  /** Raw 32-byte public key, as a Wallet Standard account exposes it. */
  publicKey: Uint8Array;
  /** Base58 address: what the Worker stores and what the header displays. */
  address: string;
}

export function createWallet(): E2eWallet {
  const secretKey = ed25519.utils.randomSecretKey();
  const publicKey = ed25519.getPublicKey(secretKey);
  return { secretKey, publicKey, address: bs58.encode(publicKey) };
}

/** This worker process's wallet: created once and reused by every test in the file. */
export const wallet: E2eWallet = createWallet();

/** Signs one message the way worker/auth.ts verifies it: ed25519 over the raw UTF-8 bytes. */
export function signMessageBytes(message: Uint8Array): Uint8Array {
  return ed25519.sign(message, wallet.secretKey);
}

/**
 * Signs a serialized legacy transaction. The signature covers the message bytes, everything after
 * the signatures block, and lands in the fee payer's slot, which is slot 0 in the layout
 * @solana/kit and @solana/web3.js produce for this app's transactions.
 *
 * Versioned transactions and partial multi-signer signing are out of scope for the mock; a
 * transaction with no signature slot fails loudly instead of being signed incorrectly.
 */
export function signTransactionBytes(transaction: Uint8Array): Uint8Array {
  const header = readSignatureHeader(transaction);
  const signature = ed25519.sign(transaction.subarray(header.end), wallet.secretKey);
  const signed = Uint8Array.from(transaction);
  signed.set(signature, header.start);
  return signed;
}

/** Reads the compact-u16 signature count of a legacy transaction and where the block ends. */
function readSignatureHeader(transaction: Uint8Array): { count: number; start: number; end: number } {
  let count = 0;
  let shift = 0;
  let offset = 0;
  while (offset < transaction.length && offset < 3) {
    const byte = transaction[offset] as number;
    count |= (byte & 0x7f) << shift;
    shift += 7;
    offset += 1;
    if ((byte & 0x80) === 0) break;
  }
  if (count < 1) throw new Error("E2E wallet: the transaction has no signature slot for the fee payer");
  if (offset + count * 64 > transaction.length) throw new Error("E2E wallet: malformed transaction bytes");
  return { count, start: offset, end: offset + count * 64 };
}

/** How the header renders a connected wallet: first 4 characters, ellipsis, last 5. */
export function shortAddress(address: string): string {
  return address.slice(0, 4) + "\u2026" + address.slice(-5);
}
