import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { METEORA_DBC_PROGRAM_ID } from "../../shared/meteora";
import {
  assertClaimTransaction,
  assertPlatformFeeClaimer,
  claimerFunding,
  describeClaimError,
  formatSol,
  isPlatformFeeClaimer,
  partnerClaimAccounts,
  partnerCreationFee,
  planPartnerFeeClaim,
  type PartnerFeePool,
} from "./platformFees";

const CLAIMER = "6HHEkX5MxsoQwyCJZHvLnewmnsaw19vGT9Y8jhqH7GuJ";
const OTHER = "GkCYyWzSjhSFEjKNx1ebWThtVLzQj7L84ktAHe31MBSx";
const DBC = new PublicKey(METEORA_DBC_PROGRAM_ID);
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

function pool(overrides: Partial<PartnerFeePool> = {}): PartnerFeePool {
  return {
    pool: "4g7i7aWVvwnSn6K6VKyvzG5UFf2nFCXgYJ7uJUymhhMB",
    baseMint: "12cens35GKeZH8is6R1gdbJ1faktyLrXgHvHyBB6veb7",
    tradingQuoteLamports: 274_084_940n,
    tradingBaseUnits: 0n,
    creationFeeLamports: 9_000_000n,
    creationFeeClaimed: false,
    ...overrides,
  };
}

/** A transaction shaped like the SDK's SOL-quoted partner claim, with switchable wrong parts. */
function claimTransaction(claimer: PublicKey, options: {
  payer?: PublicKey;
  extraSigner?: PublicKey;
  ataOwner?: PublicKey;
  closeDestination?: PublicKey;
  program?: PublicKey;
  transferTo?: PublicKey;
} = {}): Transaction {
  const wsol = Keypair.generate().publicKey;
  const transaction = new Transaction({ feePayer: options.payer ?? claimer, recentBlockhash: PublicKey.default.toBase58() });
  transaction.add(new TransactionInstruction({
    programId: ATA,
    keys: [
      { pubkey: claimer, isSigner: true, isWritable: true },
      { pubkey: wsol, isSigner: false, isWritable: true },
      { pubkey: options.ataOwner ?? claimer, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  }));
  transaction.add(new TransactionInstruction({
    programId: options.program ?? DBC,
    keys: [
      { pubkey: claimer, isSigner: true, isWritable: false },
      { pubkey: wsol, isSigner: false, isWritable: true },
      ...(options.extraSigner ? [{ pubkey: options.extraSigner, isSigner: true, isWritable: false }] : []),
    ],
    data: Buffer.from([8, 0]),
  }));
  transaction.add(new TransactionInstruction({
    programId: TOKEN,
    keys: [
      { pubkey: wsol, isSigner: false, isWritable: true },
      { pubkey: options.closeDestination ?? claimer, isSigner: false, isWritable: true },
      { pubkey: claimer, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([9]),
  }));
  if (options.transferTo) {
    transaction.add(SystemProgram.transfer({ fromPubkey: claimer, toPubkey: options.transferTo, lamports: 1 }));
  }
  return transaction;
}

describe("platform fee claimer guard", () => {
  it("shows the card only to the exact on-chain fee claimer", () => {
    expect(isPlatformFeeClaimer(CLAIMER, CLAIMER)).toBe(true);
    expect(isPlatformFeeClaimer(" " + CLAIMER + " ", CLAIMER)).toBe(true);
    expect(isPlatformFeeClaimer(OTHER, CLAIMER)).toBe(false);
    expect(isPlatformFeeClaimer(null, CLAIMER)).toBe(false);
    expect(isPlatformFeeClaimer(CLAIMER, null)).toBe(false);
    expect(isPlatformFeeClaimer(CLAIMER, undefined)).toBe(false);
    expect(isPlatformFeeClaimer("", "")).toBe(false);
    expect(isPlatformFeeClaimer("not-a-key", "not-a-key")).toBe(false);
  });

  it("refuses to build a claim for anyone but the claimer", () => {
    expect(() => assertPlatformFeeClaimer(OTHER, CLAIMER)).toThrow(/fee claimer/);
    expect(() => assertPlatformFeeClaimer(null, CLAIMER)).toThrow(/fee claimer/);
    expect(() => assertPlatformFeeClaimer(CLAIMER, CLAIMER)).not.toThrow();
  });

  it("uses the claimer as signer, payer, trading receiver and creation fee receiver", () => {
    const claimer = new PublicKey(CLAIMER);
    const accounts = partnerClaimAccounts(claimer);
    for (const key of [accounts.feeClaimer, accounts.payer, accounts.receiver, accounts.feeReceiver]) {
      expect(key.equals(claimer)).toBe(true);
    }
  });
});

describe("partner fee planning", () => {
  it("takes the partner share of the creation fee and reads the claimed bit", () => {
    expect(partnerCreationFee(10_000_000n, 0)).toEqual({ lamports: 9_000_000n, claimed: false });
    expect(partnerCreationFee(10_000_000n, 0b01)).toEqual({ lamports: 9_000_000n, claimed: false });
    expect(partnerCreationFee(10_000_000n, 0b10).claimed).toBe(true);
    expect(partnerCreationFee(10_000_000n, 0b11).claimed).toBe(true);
    expect(partnerCreationFee(0n, 0)).toEqual({ lamports: 0n, claimed: false });
  });

  it("claims both fees in one plan when both are available", () => {
    expect(planPartnerFeeClaim(pool())).toEqual({ claimTrading: true, claimCreation: true, claimableLamports: 283_084_940n });
  });

  it("skips an already claimed creation fee", () => {
    expect(planPartnerFeeClaim(pool({ creationFeeClaimed: true }))).toEqual({
      claimTrading: true,
      claimCreation: false,
      claimableLamports: 274_084_940n,
    });
  });

  it("has nothing to claim when every fee is zero or claimed", () => {
    expect(planPartnerFeeClaim(pool({ tradingQuoteLamports: 0n, creationFeeClaimed: true }))).toEqual({
      claimTrading: false,
      claimCreation: false,
      claimableLamports: 0n,
    });
    expect(planPartnerFeeClaim(pool({ tradingQuoteLamports: 0n, creationFeeLamports: 0n })).claimCreation).toBe(false);
  });

  it("still claims base-token trading fees with no SOL fee", () => {
    const plan = planPartnerFeeClaim(pool({ tradingQuoteLamports: 0n, tradingBaseUnits: 5n, creationFeeClaimed: true }));
    expect(plan.claimTrading).toBe(true);
    expect(plan.claimableLamports).toBe(0n);
  });

  it("rejects negative fees", () => {
    expect(() => planPartnerFeeClaim(pool({ tradingQuoteLamports: -1n }))).toThrow();
  });
});

describe("claimer funding", () => {
  it("asks an empty claimer wallet to fund the fee and rent, recommending 0.005 SOL", () => {
    const funding = claimerFunding({ balanceLamports: 0n, missingTokenAccounts: 2, rentPerTokenAccountLamports: 1_488_440n });
    expect(funding).toEqual({
      requiredLamports: 2_981_880n,
      recommendedLamports: 5_000_000n,
      sufficient: false,
      shortfallLamports: 2_981_880n,
    });
    expect(formatSol(funding.recommendedLamports)).toBe("0.005 SOL");
  });

  it("accepts a wallet that holds exactly the upfront cost", () => {
    expect(claimerFunding({ balanceLamports: 5_000n, missingTokenAccounts: 0, rentPerTokenAccountLamports: 2_039_280n }).sufficient).toBe(true);
    expect(claimerFunding({ balanceLamports: 4_999n, missingTokenAccounts: 0, rentPerTokenAccountLamports: 2_039_280n }).shortfallLamports).toBe(1n);
  });
});

describe("claim transaction guard", () => {
  const claimer = new PublicKey(CLAIMER);
  const other = new PublicKey(OTHER);

  it("accepts a claim signed, paid and received by the claimer", () => {
    expect(() => assertClaimTransaction(claimTransaction(claimer), claimer)).not.toThrow();
  });

  it("rejects another fee payer or an extra signer", () => {
    expect(() => assertClaimTransaction(claimTransaction(claimer, { payer: other }), claimer)).toThrow();
    expect(() => assertClaimTransaction(claimTransaction(claimer, { extraSigner: other }), claimer)).toThrow(/alone/);
  });

  it("rejects token accounts or refunds that belong to another wallet", () => {
    expect(() => assertClaimTransaction(claimTransaction(claimer, { ataOwner: other }), claimer)).toThrow(/another wallet/);
    expect(() => assertClaimTransaction(claimTransaction(claimer, { closeDestination: other }), claimer)).toThrow(/refunds another wallet/);
  });

  it("rejects SOL transfers to other wallets and unexpected programs", () => {
    expect(() => assertClaimTransaction(claimTransaction(claimer, { transferTo: other }), claimer)).toThrow(/transfers SOL/);
    expect(() => assertClaimTransaction(claimTransaction(claimer, { program: Keypair.generate().publicKey }), claimer)).toThrow(/unexpected program/);
  });
});

describe("claim error messages", () => {
  it("explains a wallet rejection without claiming anything was sent", () => {
    expect(describeClaimError(new Error("User rejected the request."))).toMatch(/cancelled/);
    expect(describeClaimError({ code: 4001, message: "" })).toMatch(/cancelled/);
  });

  it("points an unfunded claimer at the SOL it needs", () => {
    expect(describeClaimError(new Error("Transaction simulation failed: AccountNotFound"))).toMatch(/0\.005 SOL/);
  });
});
