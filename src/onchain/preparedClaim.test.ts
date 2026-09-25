/**
 * Prepared claims: the merge, and the guards around it.
 *
 * The invariant that matters is in the first group: a prepared transaction arrives with the vault's
 * signature already in it, and adding the player's signature must leave that one exactly where it
 * was. The rest covers what the client refuses to do - signing expired bytes, signing for a wallet
 * the payout is not addressed to, and signing a transaction that needs nothing.
 */
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Blockhash,
  type SignatureBytes,
  type Transaction,
} from '@solana/kit';
import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';

import {
  decodePreparedTransaction,
  isPreparedClaimExpired,
  mergeSignature,
  signatureStateOf,
} from './preparedClaim';

function key(seed: number): ReturnType<typeof address> {
  return address(bs58.encode(new Uint8Array(32).fill(seed)));
}

const PLAYER = key(1);
const VAULT = key(2);
const BLOCKHASH = bs58.encode(new Uint8Array(32).fill(7)) as Blockhash;

/** 64 bytes, the width of an Ed25519 signature. The content is irrelevant; the identity is not. */
function sig(seed: number): SignatureBytes {
  return new Uint8Array(64).fill(seed) as SignatureBytes;
}

/** A transaction as the Worker leaves it: the vault signed, the player's slot still empty. */
function prepared(overrides: Partial<Transaction> = {}): Transaction {
  const message = pipe(
    createTransactionMessage({ version: 'legacy' }),
    (m) => setTransactionMessageFeePayer(VAULT, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: BLOCKHASH, lastValidBlockHeight: 100n }, m),
    (m) => appendTransactionMessageInstructions([
      { programAddress: key(3), accounts: [{ address: PLAYER, role: 3 }], data: new Uint8Array() },
    ], m),
  );
  return {
    ...compileTransaction(message),
    signatures: { [VAULT]: sig(9), [PLAYER]: null },
    ...overrides,
  } as Transaction;
}

describe('prepared payout decoding', () => {
  it('round-trips a transaction through the wire format the Worker sends', () => {
    const decoded = decodePreparedTransaction(getBase64EncodedWireTransaction(prepared()));
    expect(signatureStateOf(decoded).present).toEqual([String(VAULT)]);
    expect(signatureStateOf(decoded).missing).toEqual([String(PLAYER)]);
  });

  it('refuses bytes that are not a transaction rather than showing them to a wallet', () => {
    expect(() => decodePreparedTransaction('not base64 at all !!')).toThrow(/could not be decoded/i);
    // Valid base64, but not a transaction: a short buffer cannot carry a signature count.
    expect(() => decodePreparedTransaction(Buffer.from([1, 2, 3]).toString('base64'))).toThrow(
      /not a valid transaction/i,
    );
  });

  it('round-trips the Worker\'s string expiry value', () => {
    expect(isPreparedClaimExpired({ id: 'batch-1', transaction: 'AA==', expiresAt: '1000' }, 999)).toBe(false);
    expect(isPreparedClaimExpired({ id: 'batch-1', transaction: 'AA==', expiresAt: '1000' }, 1_000)).toBe(true);
  });
});

describe('merging the player signature', () => {
  it('keeps the vault signature exactly as it was', () => {
    const before = prepared();
    const signatures = before.signatures as Readonly<Record<string, SignatureBytes | null>>;
    const vaultSignatureBefore = signatures[String(VAULT)];
    const merged = mergeSignature(before, PLAYER, sig(4));
    const mergedSignatures = merged.signatures as Readonly<Record<string, SignatureBytes | null>>;
    expect(mergedSignatures[String(VAULT)]).toBe(vaultSignatureBefore);
    expect(mergedSignatures[String(PLAYER)]).toEqual(sig(4));
    // The original is not mutated, so a retry still sees the vault-only transaction.
    expect(signatures[String(PLAYER)]).toBeNull();
  });

  it('survives the wire round-trip with both signatures present', () => {
    const merged = mergeSignature(prepared(), PLAYER, sig(4));
    const decoded = decodePreparedTransaction(getBase64EncodedWireTransaction(merged));
    expect(signatureStateOf(decoded).missing).toEqual([]);
    expect(signatureStateOf(decoded).present).toHaveLength(2);
  });

  it('rejects a signature from an address the transaction does not list', () => {
    expect(() => mergeSignature(prepared(), key(9), sig(4))).toThrow(/does not use/i);
  });
});

describe('expiry', () => {
  const payout = { id: 'batch-1', transaction: 'AA==', expiresAt: '1000' };

  it('is expired at and after the Worker deadline', () => {
    expect(isPreparedClaimExpired(payout, 999)).toBe(false);
    expect(isPreparedClaimExpired(payout, 1_000)).toBe(true);
    expect(isPreparedClaimExpired(payout, 1_001)).toBe(true);
  });
});
