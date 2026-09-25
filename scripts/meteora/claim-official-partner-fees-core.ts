import BN from "bn.js";
import { deriveDbcPoolAddress, type PoolConfig, type VirtualPool } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { PublicKey, Transaction } from "@solana/web3.js";
import { DBC_PROGRAM_ID, NATIVE_SOL_MINT, PLATFORM_FEE_WALLET } from "./common.ts";

export const OFFICIAL_MINT = new PublicKey("12cens35GKeZH8is6R1gdbJ1faktyLrXgHvHyBB6veb7");
export const OFFICIAL_CONFIG = new PublicKey("5yxCKEmi1rc5ebKmWdHbzj2pEe7caqS8xqvQh5V8duMF");
export const OFFICIAL_POOL = deriveDbcPoolAddress(new PublicKey(NATIVE_SOL_MINT), OFFICIAL_MINT, OFFICIAL_CONFIG);
export const FEE_RECEIVER = new PublicKey(PLATFORM_FEE_WALLET);
export const DBC_PROGRAM = new PublicKey(DBC_PROGRAM_ID);

// Meteora DBC PoolState::creation_fee_bits uses bit 1 for the partner claim.
export const PARTNER_CREATION_FEE_CLAIMED_MASK = 0b10;
export const MAX_CLAIM_AMOUNT = new BN("18446744073709551615");

export interface ClaimOptions {
  send: boolean;
  payerKeypair?: string;
  payerPubkey?: string;
  feeClaimerKeypair?: string;
  rpcUrl?: string;
}

export function parseClaimOptions(args: string[]): ClaimOptions {
  const values = new Map<string, string>();
  let send = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--send") {
      if (send) throw new Error("--send may appear only once");
      send = true;
      continue;
    }
    if (!["--pool", "--mint", "--config", "--receiver", "--payer-keypair", "--payer-pubkey", "--fee-claimer-keypair", "--rpc-url"].includes(flag)) {
      throw new Error(`Unknown option: ${flag}`);
    }
    const value = args[++index];
    if (!value || value.startsWith("--") || values.has(flag)) throw new Error(`${flag} needs one value`);
    values.set(flag, value);
  }
  for (const [flag, expected] of [
    ["--pool", OFFICIAL_POOL],
    ["--mint", OFFICIAL_MINT],
    ["--config", OFFICIAL_CONFIG],
    ["--receiver", FEE_RECEIVER],
  ] as const) {
    const value = values.get(flag);
    if (value && value !== expected.toBase58()) throw new Error(`${flag} must be ${expected.toBase58()}`);
  }
  const payerKeypair = values.get("--payer-keypair");
  const payerPubkey = values.get("--payer-pubkey");
  const feeClaimerKeypair = values.get("--fee-claimer-keypair");
  if (!payerKeypair && !payerPubkey) throw new Error("Provide --payer-pubkey for dry-run or --payer-keypair");
  if (send && (!payerKeypair || !feeClaimerKeypair)) {
    throw new Error("--send requires both --payer-keypair and --fee-claimer-keypair");
  }
  return { send, payerKeypair, payerPubkey, feeClaimerKeypair, rpcUrl: values.get("--rpc-url") };
}

export interface ClaimPlan {
  tradingBase: BN;
  tradingQuote: BN;
  creationFeeLamports: bigint;
  claimTrading: boolean;
  claimCreation: boolean;
}

export function planOfficialClaim(
  poolAddress: PublicKey,
  poolOwner: PublicKey,
  configOwner: PublicKey,
  pool: VirtualPool,
  config: PoolConfig,
): ClaimPlan {
  if (!poolAddress.equals(OFFICIAL_POOL) || !poolOwner.equals(DBC_PROGRAM) || !configOwner.equals(DBC_PROGRAM)) {
    throw new Error("Pool or config does not belong to the official DBC pool");
  }
  const state = pool.poolState;
  if (!state.baseMint.equals(OFFICIAL_MINT) || !state.config.equals(OFFICIAL_CONFIG)) {
    throw new Error("Pool mint or config differs from the official DIGGO pool");
  }
  if (!deriveDbcPoolAddress(config.quoteMint, state.baseMint, state.config).equals(poolAddress) ||
      !config.quoteMint.equals(new PublicKey(NATIVE_SOL_MINT)) ||
      !config.feeClaimer.equals(FEE_RECEIVER)) {
    throw new Error("Pool derivation, quote mint, or on-chain fee claimer does not match DIGGO");
  }
  const tradingBase = state.partnerBaseFee;
  const tradingQuote = state.partnerQuoteFee;
  if (tradingBase.isNeg() || tradingQuote.isNeg()) throw new Error("Invalid negative partner trading fee");
  const creationFeeLamports = BigInt(config.poolCreationFee.toString());
  return {
    tradingBase,
    tradingQuote,
    creationFeeLamports,
    claimTrading: !tradingBase.isZero() || !tradingQuote.isZero(),
    claimCreation: creationFeeLamports > 0n && (state.creationFeeBits & PARTNER_CREATION_FEE_CLAIMED_MASK) === 0,
  };
}

export function combineClaimTransactions(trading?: Transaction, creation?: Transaction): Transaction | null {
  if (!trading && !creation) return null;
  const transaction = new Transaction();
  if (trading) transaction.add(trading);
  if (creation) transaction.add(creation);
  return transaction;
}

export function assertClaimSigners(transaction: Transaction, payer: PublicKey): void {
  transaction.feePayer = payer;
  const message = transaction.compileMessage();
  const actual = message.accountKeys.slice(0, message.header.numRequiredSignatures).map((key) => key.toBase58()).sort();
  const expected = [...new Set([payer.toBase58(), FEE_RECEIVER.toBase58()])].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected transaction signers: ${actual.join(", ")}`);
  }
}
