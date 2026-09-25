import BN from "bn.js";
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import type { PoolConfig, VirtualPool } from "@meteora-ag/dynamic-bonding-curve-sdk";
import {
  DBC_PROGRAM,
  FEE_RECEIVER,
  MAX_CLAIM_AMOUNT,
  OFFICIAL_CONFIG,
  OFFICIAL_MINT,
  OFFICIAL_POOL,
  assertClaimSigners,
  combineClaimTransactions,
  parseClaimOptions,
  planOfficialClaim,
} from "./claim-official-partner-fees-core.ts";
import { NATIVE_SOL_MINT } from "./common.ts";

function fixture(base = "0", quote = "274084940", creationBits = 0, creationFee = "10000000") {
  const pool = { poolState: {
    baseMint: OFFICIAL_MINT,
    config: OFFICIAL_CONFIG,
    partnerBaseFee: new BN(base),
    partnerQuoteFee: new BN(quote),
    creationFeeBits: creationBits,
  } } as VirtualPool;
  const config = {
    quoteMint: new PublicKey(NATIVE_SOL_MINT),
    feeClaimer: FEE_RECEIVER,
    poolCreationFee: new BN(creationFee),
  } as PoolConfig;
  return { pool, config };
}

describe("official partner claim safety", () => {
  it("is dry-run by default and requires both signer files to send", () => {
    expect(parseClaimOptions(["--payer-pubkey", Keypair.generate().publicKey.toBase58()]).send).toBe(false);
    expect(() => parseClaimOptions(["--send", "--payer-pubkey", Keypair.generate().publicKey.toBase58()])).toThrow("requires both");
    expect(() => parseClaimOptions(["--payer-pubkey", Keypair.generate().publicKey.toBase58(), "--send=false"])).toThrow("Unknown option");
    expect(parseClaimOptions(["--send", "--payer-keypair", "payer.json", "--fee-claimer-keypair", "claimer.json"]).send).toBe(true);
  });

  it("rejects attempts to redirect or switch pool, mint, config, or receiver", () => {
    const payer = Keypair.generate().publicKey.toBase58();
    for (const flag of ["--pool", "--mint", "--config", "--receiver"]) {
      expect(() => parseClaimOptions(["--payer-pubkey", payer, flag, Keypair.generate().publicKey.toBase58()])).toThrow(`must be`);
    }
    const { pool, config } = fixture();
    expect(() => planOfficialClaim(OFFICIAL_POOL, Keypair.generate().publicKey, DBC_PROGRAM, pool, config)).toThrow();
    expect(() => planOfficialClaim(OFFICIAL_POOL, DBC_PROGRAM, DBC_PROGRAM, pool, { ...config, feeClaimer: Keypair.generate().publicKey })).toThrow();
    expect(() => planOfficialClaim(OFFICIAL_POOL, DBC_PROGRAM, DBC_PROGRAM, { poolState: { ...pool.poolState, baseMint: Keypair.generate().publicKey } }, config)).toThrow();
  });

  it("claims both available fee types, skips zeros and already-claimed creation fee", () => {
    expect(MAX_CLAIM_AMOUNT.toString()).toBe("18446744073709551615");
    const both = fixture();
    expect(planOfficialClaim(OFFICIAL_POOL, DBC_PROGRAM, DBC_PROGRAM, both.pool, both.config)).toMatchObject({
      claimTrading: true,
      claimCreation: true,
      creationFeeLamports: 10000000n,
    });
    const zero = fixture("0", "0", 0, "0");
    expect(planOfficialClaim(OFFICIAL_POOL, DBC_PROGRAM, DBC_PROGRAM, zero.pool, zero.config)).toMatchObject({ claimTrading: false, claimCreation: false });
    const claimed = fixture("0", "4", 0b10);
    expect(planOfficialClaim(OFFICIAL_POOL, DBC_PROGRAM, DBC_PROGRAM, claimed.pool, claimed.config)).toMatchObject({ claimTrading: true, claimCreation: false });
    const protocolClaimed = fixture("0", "0", 0b01);
    expect(planOfficialClaim(OFFICIAL_POOL, DBC_PROGRAM, DBC_PROGRAM, protocolClaimed.pool, protocolClaimed.config).claimCreation).toBe(true);
  });

  it("combines instruction order and refuses an unexpected signer", () => {
    const payer = Keypair.generate().publicKey;
    const trading = new Transaction().add(new TransactionInstruction({
      keys: [{ pubkey: FEE_RECEIVER, isSigner: true, isWritable: false }],
      programId: DBC_PROGRAM,
      data: Buffer.from([1]),
    }));
    const creation = new Transaction().add(new TransactionInstruction({
      keys: [{ pubkey: FEE_RECEIVER, isSigner: true, isWritable: false }],
      programId: DBC_PROGRAM,
      data: Buffer.from([2]),
    }));
    const combined = combineClaimTransactions(trading, creation)!;
    combined.recentBlockhash = Keypair.generate().publicKey.toBase58();
    expect(combined.instructions.map((ix) => ix.data[0])).toEqual([1, 2]);
    expect(() => assertClaimSigners(combined, payer)).not.toThrow();
    combined.add(new TransactionInstruction({
      keys: [{ pubkey: Keypair.generate().publicKey, isSigner: true, isWritable: false }],
      programId: DBC_PROGRAM,
      data: Buffer.alloc(0),
    }));
    expect(() => assertClaimSigners(combined, payer)).toThrow("Unexpected transaction signers");
  });
});
