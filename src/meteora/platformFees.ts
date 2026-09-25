/**
 * Pure guard and planning logic for the wallet-signed "Claim platform fees" flow.
 *
 * The platform earns Meteora DBC partner fees on every pool created under its config: a share of
 * each trade (partner trading fee) and 90% of the pool creation fee. Only the config's on-chain
 * fee claimer can collect them, so everything here keys off that address. The functions are kept
 * free of network access so the rules that decide who sees the card, where the SOL goes, and
 * whether the wallet can afford the transaction are unit-tested in isolation.
 */
import { PublicKey, SystemProgram, type Transaction } from "@solana/web3.js";
import { METEORA_DBC_PROGRAM_ID } from "../../shared/meteora";

/** Meteora DBC PoolState::creation_fee_bits sets bit 1 once the partner has claimed. */
export const PARTNER_CREATION_FEE_CLAIMED_MASK = 0b10;
/** The DBC program keeps this share of every pool creation fee for the protocol. */
export const PROTOCOL_POOL_CREATION_FEE_PERCENT = 10n;
/** u64::MAX makes the trading claim take everything, even fees accrued after the read. */
export const MAX_CLAIM_AMOUNT = "18446744073709551615";
/** Base network fee per signature. The claim is signed only by the fee claimer. */
export const SIGNATURE_FEE_LAMPORTS = 5_000n;
/** Balance we ask the claimer to keep so fees and temporary token-account rent always fit. */
export const RECOMMENDED_CLAIMER_BALANCE_LAMPORTS = 5_000_000n;
export const LAMPORTS_PER_SOL = 1_000_000_000n;

const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
const SYSTEM_PROGRAM_ID = SystemProgram.programId.toBase58();
const ALLOWED_PROGRAMS = new Set([
  METEORA_DBC_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  COMPUTE_BUDGET_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
]);
/** SPL Token CloseAccount instruction tag; its accounts are [account, destination, owner]. */
const TOKEN_CLOSE_ACCOUNT = 9;

function normalizedAddress(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return null;
  try {
    return new PublicKey(trimmed).toBase58();
  } catch {
    return null;
  }
}

/**
 * True only when a wallet is connected and it is exactly the on-chain config fee claimer. An
 * unknown claimer (config not loaded yet, read failed) never matches, so the card stays hidden.
 */
export function isPlatformFeeClaimer(wallet: string | null | undefined, onChainFeeClaimer: string | null | undefined): boolean {
  const connected = normalizedAddress(wallet);
  const claimer = normalizedAddress(onChainFeeClaimer);
  return connected !== null && claimer !== null && connected === claimer;
}

export function assertPlatformFeeClaimer(wallet: string | null | undefined, onChainFeeClaimer: string | null | undefined): void {
  if (!isPlatformFeeClaimer(wallet, onChainFeeClaimer)) {
    throw new Error("Only the config fee claimer wallet can claim platform fees.");
  }
}

/**
 * Every account role in the SDK claim builders is the claimer: it signs, pays, and receives both
 * the trading fee and the creation fee. There is deliberately no parameter for another receiver.
 */
export function partnerClaimAccounts(claimer: PublicKey): {
  feeClaimer: PublicKey;
  payer: PublicKey;
  receiver: PublicKey;
  feeReceiver: PublicKey;
} {
  return { feeClaimer: claimer, payer: claimer, receiver: claimer, feeReceiver: claimer };
}

export interface PartnerCreationFee {
  lamports: bigint;
  claimed: boolean;
}

/** The partner share of the creation fee, and whether this pool has already paid it out. */
export function partnerCreationFee(poolCreationFeeLamports: bigint, creationFeeBits: number): PartnerCreationFee {
  if (poolCreationFeeLamports < 0n) throw new Error("Invalid pool creation fee");
  const protocolShare = (poolCreationFeeLamports * PROTOCOL_POOL_CREATION_FEE_PERCENT) / 100n;
  return {
    lamports: poolCreationFeeLamports - protocolShare,
    claimed: (creationFeeBits & PARTNER_CREATION_FEE_CLAIMED_MASK) !== 0,
  };
}

export interface PartnerFeePool {
  pool: string;
  baseMint: string;
  /** Unclaimed partner trading fee in the quote token (lamports for SOL-quoted pools). */
  tradingQuoteLamports: bigint;
  /** Unclaimed partner trading fee in base-token units; zero for quote-only fee collection. */
  tradingBaseUnits: bigint;
  creationFeeLamports: bigint;
  creationFeeClaimed: boolean;
}

export interface PartnerClaimPlan {
  claimTrading: boolean;
  claimCreation: boolean;
  /** SOL the claimer receives from this pool (trading quote fee + unclaimed creation fee). */
  claimableLamports: bigint;
}

export function planPartnerFeeClaim(pool: PartnerFeePool): PartnerClaimPlan {
  if (pool.tradingQuoteLamports < 0n || pool.tradingBaseUnits < 0n || pool.creationFeeLamports < 0n) {
    throw new Error("Invalid negative partner fee");
  }
  const claimTrading = pool.tradingQuoteLamports > 0n || pool.tradingBaseUnits > 0n;
  const claimCreation = !pool.creationFeeClaimed && pool.creationFeeLamports > 0n;
  return {
    claimTrading,
    claimCreation,
    claimableLamports: pool.tradingQuoteLamports + (claimCreation ? pool.creationFeeLamports : 0n),
  };
}

/**
 * Checks the built transaction before it is simulated or shown to the wallet: the claimer is the
 * fee payer and the only signer, only the DBC program and core token/system helpers are called,
 * every token account it creates belongs to the claimer, every temporary token account it closes
 * refunds the claimer, and any SOL it moves goes to the claimer or the claimer's own token account.
 */
export function assertClaimTransaction(transaction: Transaction, claimer: PublicKey): void {
  if (!transaction.feePayer?.equals(claimer)) throw new Error("The fee claimer must pay for the claim transaction.");
  const message = transaction.compileMessage();
  const signers = message.accountKeys.slice(0, message.header.numRequiredSignatures).map((key) => key.toBase58());
  if (signers.length !== 1 || signers[0] !== claimer.toBase58()) {
    throw new Error("The claim transaction must be signed by the fee claimer alone.");
  }
  if (transaction.instructions.length === 0) throw new Error("The claim transaction has no instructions.");
  const claimerTokenAccounts = new Set(
    transaction.instructions
      .filter((instruction) => instruction.programId.toBase58() === ASSOCIATED_TOKEN_PROGRAM_ID)
      .map((instruction) => instruction.keys[1]?.pubkey.toBase58())
      .filter((key): key is string => Boolean(key)),
  );
  for (const instruction of transaction.instructions) {
    const program = instruction.programId.toBase58();
    if (!ALLOWED_PROGRAMS.has(program)) throw new Error("The claim transaction calls an unexpected program.");
    if (program === ASSOCIATED_TOKEN_PROGRAM_ID && !instruction.keys[2]?.pubkey.equals(claimer)) {
      throw new Error("The claim transaction creates a token account for another wallet.");
    }
    if ((program === TOKEN_PROGRAM_ID || program === TOKEN_2022_PROGRAM_ID) && instruction.data[0] === TOKEN_CLOSE_ACCOUNT) {
      if (!instruction.keys[1]?.pubkey.equals(claimer)) throw new Error("The claim transaction refunds another wallet.");
    }
    if (program === SYSTEM_PROGRAM_ID) {
      const destination = instruction.keys[1]?.pubkey;
      if (destination && !destination.equals(claimer) && !claimerTokenAccounts.has(destination.toBase58())) {
        throw new Error("The claim transaction transfers SOL to another wallet.");
      }
    }
  }
}

export interface ClaimerFunding {
  requiredLamports: bigint;
  recommendedLamports: bigint;
  sufficient: boolean;
  shortfallLamports: bigint;
}

/**
 * What the claimer must hold before the wallet is asked to sign: the network fee plus rent for any
 * token accounts the claim creates (wrapped SOL is closed again in the same transaction, but the
 * rent must be available while it exists).
 */
export function claimerFunding(input: {
  balanceLamports: bigint;
  signatures?: number;
  missingTokenAccounts: number;
  rentPerTokenAccountLamports: bigint;
}): ClaimerFunding {
  const signatures = BigInt(Math.max(1, input.signatures ?? 1));
  const requiredLamports =
    signatures * SIGNATURE_FEE_LAMPORTS + BigInt(Math.max(0, input.missingTokenAccounts)) * input.rentPerTokenAccountLamports;
  const recommendedLamports =
    requiredLamports > RECOMMENDED_CLAIMER_BALANCE_LAMPORTS ? requiredLamports : RECOMMENDED_CLAIMER_BALANCE_LAMPORTS;
  const sufficient = input.balanceLamports >= requiredLamports;
  return {
    requiredLamports,
    recommendedLamports,
    sufficient,
    shortfallLamports: sufficient ? 0n : requiredLamports - input.balanceLamports,
  };
}

export function formatSol(lamports: bigint, digits = 6): string {
  const negative = lamports < 0n;
  const absolute = negative ? -lamports : lamports;
  const whole = absolute / LAMPORTS_PER_SOL;
  const fraction = (absolute % LAMPORTS_PER_SOL).toString().padStart(9, "0").slice(0, digits);
  const trimmed = fraction.replace(/0+$/, "");
  return (negative ? "-" : "") + whole.toString() + (trimmed ? "." + trimmed : "") + " SOL";
}

export function solscanTransactionUrl(signature: string, cluster: string): string {
  const suffix = cluster === "devnet" ? "?cluster=devnet" : "";
  return "https://solscan.io/tx/" + encodeURIComponent(signature) + suffix;
}

export function describeClaimError(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
  if (code === 4001 || /reject|denied|declin|cancel/i.test(message)) {
    return "You cancelled the request in your wallet. Nothing was sent.";
  }
  if (/insufficient (funds|lamports)|AccountNotFound|InsufficientFundsForRent/i.test(message)) {
    return "The fee claimer wallet does not have enough SOL for the network fee and token-account rent. Send it about 0.005 SOL and try again.";
  }
  return message || "The claim could not be completed.";
}
