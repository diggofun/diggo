import { describe, expect, it } from "vitest";
import type { MeteoraTransaction } from "./meteora/rpc";
import { paidBoost, systemTransferInstruction } from "./boosts";
import { BOOST_TIERS, boostTier, boostWindow, solLabel } from "../shared/boost";

const PAYER = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const FEE = "6HHEkX5MxsoQwyCJZHvLnewmnsaw19vGT9Y8jhqH7GuJ";
const OTHER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

function payment(lamports: bigint, overrides: Partial<MeteoraTransaction> = {}): MeteoraTransaction {
  return {
    signature: "s", slot: 1n, blockTime: 1, failed: false, signatures: ["s"], instructions: [], logs: [],
    preTokenBalances: [], postTokenBalances: [],
    accountKeys: [PAYER, FEE, "11111111111111111111111111111111"],
    preBalances: [1_000_000_000n, 5n, 1n],
    postBalances: [1_000_000_000n - lamports - 5_000n, 5n + lamports, 1n],
    ...overrides,
  };
}

describe("boost payments", () => {
  const tier = boostTier("1d")!;

  it("accepts the full price paid into the fee wallet by the signed-in wallet", () => {
    expect(paidBoost(payment(tier.lamports), { payer: PAYER, feeWallet: FEE, lamports: tier.lamports })).toBe(true);
    expect(paidBoost(payment(tier.lamports + 1n), { payer: PAYER, feeWallet: FEE, lamports: tier.lamports })).toBe(true);
  });

  it("refuses an underpayment, a failed transaction, someone else's payment and another destination", () => {
    const expected = { payer: PAYER, feeWallet: FEE, lamports: tier.lamports };
    expect(paidBoost(payment(tier.lamports - 1n), expected)).toBe(false);
    expect(paidBoost(payment(tier.lamports, { failed: true }), expected)).toBe(false);
    expect(paidBoost(payment(tier.lamports), { ...expected, payer: OTHER })).toBe(false);
    expect(paidBoost(payment(tier.lamports), { ...expected, feeWallet: OTHER })).toBe(false);
    expect(paidBoost(payment(tier.lamports, { preBalances: undefined }), expected)).toBe(false);
  });

  it("encodes SystemProgram.transfer: index 2 and little-endian lamports", () => {
    const instruction = systemTransferInstruction(PAYER, FEE, 100_000_000n);
    expect(Array.from(instruction.data ?? [])).toEqual([2, 0, 0, 0, 0x00, 0xe1, 0xf5, 0x05, 0, 0, 0, 0]);
    expect(instruction.accounts?.map((account) => account.address)).toEqual([PAYER, FEE]);
  });

  it("prices and labels the tiers", () => {
    expect(BOOST_TIERS.map((entry) => [entry.id, solLabel(entry.lamports)])).toEqual([["1d", "0.1 SOL"], ["3d", "0.25 SOL"], ["7d", "0.5 SOL"]]);
    expect(boostTier("forever")).toBeNull();
  });

  it("stacks a new boost after the current one", () => {
    expect(boostWindow(1_000, null, 1)).toEqual({ startsAt: 1_000, endsAt: 1_000 + 86_400 });
    expect(boostWindow(1_000, 500, 1)).toEqual({ startsAt: 1_000, endsAt: 1_000 + 86_400 });
    expect(boostWindow(1_000, 50_000, 3)).toEqual({ startsAt: 50_000, endsAt: 50_000 + 3 * 86_400 });
  });
});
