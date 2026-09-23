/**
 * Rent reclaim: the fee arithmetic, the batching and the invariant that matters most.
 *
 * The invariant is the first test group: an account with a balance is never closed. Everything else
 * here is about the numbers a player is shown before they sign - the 1% that goes to the treasury,
 * what they keep, and how the work is split across transactions that actually fit.
 */
import { address } from "@solana/kit";
import bs58 from "bs58";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SYSTEM_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS } from "../../shared/program";

const signSendConfirm = vi.fn();
const awaitConfirmation = vi.fn();

vi.mock("./tx", () => ({
  rpc: { getTokenAccountsByOwner: () => ({ send: async () => ({ value: [] }) }) },
  signSendConfirm: (...args: unknown[]) => signSendConfirm(...args),
  awaitConfirmation: (...args: unknown[]) => awaitConfirmation(...args),
  describeTransactionError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

import {
  LEGACY_TX_SIZE_LIMIT,
  MAX_CLOSES_PER_TX,
  PLATFORM_FEE_BPS,
  buildBatchInstructions,
  buildCloseAccountInstruction,
  estimateTransactionSize,
  planReclaim,
  platformFeeOf,
  reclaimRent,
  resolvePendingReclaim,
  hasPendingReclaim,
  skipReason,
  type TokenAccountSnapshot,
} from "./rentReclaim";

/** A distinct, valid base58 address for each seed. */
function key(seed: number): ReturnType<typeof address> {
  return address(bs58.encode(new Uint8Array(32).fill(seed % 256)));
}

const OWNER = key(1);
const TREASURY = key(2);
const MINT = key(3);

function account(overrides: Partial<TokenAccountSnapshot> & { seed: number }): TokenAccountSnapshot {
  const { seed, ...rest } = overrides;
  return {
    account: key(seed),
    mint: MINT,
    owner: OWNER,
    program: TOKEN_2022_PROGRAM_ADDRESS,
    lamports: 2_039_280n,
    amount: 0n,
    decimals: 6,
    state: "initialized",
    isNative: false,
    withheldFees: 0n,
    closeAuthority: null,
    ...rest,
  };
}

/** n empty accounts, each with its own address. */
function empties(n: number): TokenAccountSnapshot[] {
  return Array.from({ length: n }, (_value, index) => account({ seed: 10 + index }));
}

function plan(accounts: TokenAccountSnapshot[]) {
  return planReclaim(accounts, { owner: OWNER, treasury: TREASURY });
}

beforeEach(() => {
  signSendConfirm.mockReset();
  signSendConfirm.mockResolvedValue("signature");
  awaitConfirmation.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("platformFeeOf", () => {
  it("is one percent, floored, in integer lamports", () => {
    expect(PLATFORM_FEE_BPS).toBe(100);
    expect(platformFeeOf(1_000_000_000n)).toBe(10_000_000n);
    expect(platformFeeOf(100n)).toBe(1n);
    // Flooring, never rounding up: 199 lamports at 1% is 1, not 2.
    expect(platformFeeOf(199n)).toBe(1n);
    expect(platformFeeOf(99n)).toBe(0n);
    expect(platformFeeOf(0n)).toBe(0n);
    expect(platformFeeOf(-5n)).toBe(0n);
  });

  it("honours an explicit rate", () => {
    expect(platformFeeOf(1_000_000n, 250)).toBe(25_000n);
    expect(platformFeeOf(1_000_000n, 0)).toBe(0n);
  });
});

describe("what may be closed", () => {
  it("allows an empty, unfrozen, fee-free account", () => {
    expect(skipReason(account({ seed: 11 }))).toBeNull();
  });

  it("refuses an account with a balance", () => {
    expect(skipReason(account({ seed: 12, amount: 1n }))).toContain("balance");
    expect(skipReason(account({ seed: 13, amount: 1_000_000n }))).toContain("balance");
  });

  it("refuses an account withholding a Token-2022 transfer fee, even at zero balance", () => {
    expect(skipReason(account({ seed: 14, withheldFees: 1n }))).toContain("withhold");
  });

  it("refuses a frozen account", () => {
    expect(skipReason(account({ seed: 15, state: "frozen" }))).toContain("frozen");
    expect(skipReason(account({ seed: 16, state: "Frozen" }))).toContain("frozen");
  });

  it("refuses a native account that still holds wrapped SOL", () => {
    expect(skipReason(account({ seed: 17, isNative: true, amount: 5n }))).toContain("wrapped SOL");
    // An empty wrapped-SOL account is just an empty account and may be closed.
    expect(skipReason(account({ seed: 18, isNative: true, amount: 0n }))).toBeNull();
  });

  it("refuses an account somebody else can close, and allows one the owner can", () => {
    expect(skipReason(account({ seed: 19, closeAuthority: key(99) }))).toContain("close authority");
    expect(skipReason(account({ seed: 20, closeAuthority: OWNER }))).toBeNull();
  });

  it("refuses an account with no rent to return", () => {
    expect(skipReason(account({ seed: 21, lamports: 0n }))).toContain("no rent");
  });

  it("never allows a balance, even for a named dust mint", () => {
    const dust = account({ seed: 22, amount: 500n });
    expect(skipReason(dust)).not.toBeNull();
  });
});

describe("planReclaim", () => {
  it("never closes an account with a balance, and says why it was left alone", () => {
    const empty = account({ seed: 30 });
    const holding = account({ seed: 31, amount: 1n });
    const frozen = account({ seed: 32, state: "frozen" });
    const withheld = account({ seed: 33, withheldFees: 7n });
    const built = plan([empty, holding, frozen, withheld]);

    expect(built.accounts).toBe(1);
    expect(built.batches).toHaveLength(1);
    expect(built.batches[0]!.accounts.map((entry) => entry.account)).toEqual([empty.account]);
    expect(built.skipped.map((entry) => entry.account)).toEqual([
      holding.account,
      frozen.account,
      withheld.account,
    ]);
    // Nothing in any batch may carry a balance, which is the invariant stated as an assertion.
    for (const batch of built.batches) {
      for (const entry of batch.accounts) expect(entry.amount).toBe(0n);
    }
  });

  it("leaves a dust balance alone", () => {
    const dust = account({ seed: 34, amount: 1_234n });
    const built = plan([dust]);
    expect(built.batches).toHaveLength(0);
    expect(built.skipped[0]!.reason).toContain("balance");
  });

  it("splits the work into transactions that fit the legacy size limit", () => {
    const built = plan(empties(60));
    expect(built.accounts).toBe(60);
    expect(built.batches.length).toBeGreaterThan(1);
    for (const batch of built.batches) {
      expect(batch.accounts.length).toBeLessThanOrEqual(MAX_CLOSES_PER_TX);
      const instructions = buildBatchInstructions(batch, { owner: OWNER, treasury: TREASURY });
      expect(estimateTransactionSize(instructions, OWNER)).toBeLessThanOrEqual(LEGACY_TX_SIZE_LIMIT);
    }
    // Nothing was dropped in the split.
    const packed = built.batches.reduce((sum, batch) => sum + batch.accounts.length, 0);
    expect(packed).toBe(60);
    expect(built.skipped).toHaveLength(0);
  });

  it("packs a batch as full as the byte limit allows", () => {
    const built = plan(empties(20));
    // Five closes plus the fee transfer is 1,123 bytes; a sixth would be 1,286 and the runtime
    // rejects anything above 1,232. The 20 ceiling is a guard, not a target: bytes bind first.
    expect(built.batches[0]!.accounts.length).toBe(5);
    expect(built.batches[0]!.accounts.length).toBeLessThan(MAX_CLOSES_PER_TX);
    expect(built.batches).toHaveLength(4);
    expect(built.batches.reduce((sum, batch) => sum + batch.accounts.length, 0)).toBe(20);
  });

  it("fits one more close when there is no fee transfer to carry", () => {
    const tiny = Array.from({ length: 6 }, (_value, index) =>
      account({ seed: 80 + index, lamports: 1n }),
    );
    const built = plan(tiny);
    expect(built.batches[0]!.platformFeeLamports).toBe(0n);
    expect(built.batches[0]!.accounts.length).toBe(6);
    expect(built.batches).toHaveLength(1);
    const instructions = buildBatchInstructions(built.batches[0]!, { owner: OWNER, treasury: TREASURY });
    expect(estimateTransactionSize(instructions, OWNER)).toBeLessThanOrEqual(LEGACY_TX_SIZE_LIMIT);
  });

  it("pays one percent, floored per transaction, and the batches add up to the total", () => {
    const built = plan(empties(30));
    let lamports = 0n;
    let fees = 0n;
    for (const batch of built.batches) {
      expect(batch.platformFeeLamports).toBe(platformFeeOf(batch.lamports));
      expect(batch.userReceivesLamports).toBe(batch.lamports - batch.platformFeeLamports);
      lamports += batch.lamports;
      fees += batch.platformFeeLamports;
    }
    expect(built.totalLamports).toBe(lamports);
    expect(built.platformFeeLamports).toBe(fees);
    expect(built.userReceivesLamports).toBe(lamports - fees);
    expect(built.platformFeeBps).toBe(PLATFORM_FEE_BPS);
  });

  it("plans nothing when every account is refused", () => {
    const built = plan([account({ seed: 40, amount: 9n })]);
    expect(built.accounts).toBe(0);
    expect(built.batches).toHaveLength(0);
    expect(built.totalLamports).toBe(0n);
    expect(built.platformFeeLamports).toBe(0n);
    expect(built.userReceivesLamports).toBe(0n);
  });
});

describe("the instructions a batch becomes", () => {
  it("closes to the owner and transfers the fee to the treasury once", () => {
    const built = plan(empties(2));
    const batch = built.batches[0]!;
    const instructions = buildBatchInstructions(batch, { owner: OWNER, treasury: TREASURY });
    expect(instructions).toHaveLength(3);

    for (const instruction of instructions.slice(0, 2)) {
      expect(instruction.programAddress).toBe(TOKEN_2022_PROGRAM_ADDRESS);
      // [account, destination, owner]: the destination is the wallet, so the rent comes back to it.
      expect(instruction.accounts![1]!.address).toBe(OWNER);
      expect(instruction.accounts![2]!.address).toBe(OWNER);
    }

    const transfer = instructions[2]!;
    expect(transfer.programAddress).toBe(SYSTEM_PROGRAM_ADDRESS);
    expect(transfer.accounts![1]!.address).toBe(TREASURY);
    // A System Program transfer carries a 4-byte instruction index then the lamport amount.
    const view = new DataView(
      transfer.data!.buffer,
      transfer.data!.byteOffset,
      transfer.data!.byteLength,
    );
    expect(view.getUint32(0, true)).toBe(2);
    expect(view.getBigUint64(4, true)).toBe(batch.platformFeeLamports);
  });

  it("leaves the transfer out when a batch returns too little to owe a fee", () => {
    const built = plan([account({ seed: 50, lamports: 50n })]);
    expect(built.batches[0]!.platformFeeLamports).toBe(0n);
    const instructions = buildBatchInstructions(built.batches[0]!, { owner: OWNER, treasury: TREASURY });
    expect(instructions).toHaveLength(1);
    expect(instructions[0]!.programAddress).toBe(TOKEN_2022_PROGRAM_ADDRESS);
  });

  it("uses the account own token program, so an SPL Token account is closed by SPL Token", () => {
    const built = plan([account({ seed: 51, program: TOKEN_PROGRAM_ADDRESS })]);
    const instructions = buildBatchInstructions(built.batches[0]!, { owner: OWNER, treasury: TREASURY });
    expect(instructions[0]!.programAddress).toBe(TOKEN_PROGRAM_ADDRESS);
  });
});

describe("estimateTransactionSize", () => {
  it("counts one close, its three keys and one signature exactly", () => {
    const instruction = buildCloseAccountInstruction({
      account: key(60),
      destination: OWNER,
      owner: OWNER,
      program: TOKEN_PROGRAM_ADDRESS,
    });
    // 1 + 64 signature, 3 header, 1 + 3x32 keys (owner, token program, account), 32 blockhash,
    // 1 instruction count, then 1 + 32 + 1 + 3x32 + 1 for the instruction itself.
    expect(estimateTransactionSize([instruction], OWNER)).toBe(65 + 3 + 97 + 32 + 1 + 131);
  });

  it("grows with every account added and stays inside the limit for a full batch", () => {
    const one = plan(empties(1)).batches[0]!;
    const ten = plan(empties(10)).batches[0]!;
    const small = estimateTransactionSize(
      buildBatchInstructions(one, { owner: OWNER, treasury: TREASURY }),
      OWNER,
    );
    const large = estimateTransactionSize(
      buildBatchInstructions(ten, { owner: OWNER, treasury: TREASURY }),
      OWNER,
    );
    expect(large).toBeGreaterThan(small);
    expect(small).toBeLessThanOrEqual(LEGACY_TX_SIZE_LIMIT);
  });
});

describe("reclaimRent", () => {
  const wallet = { address: OWNER } as never;

  it("signs one transaction per batch and totals only what landed", async () => {
    const built = plan(empties(30));
    expect(built.batches.length).toBeGreaterThan(1);
    signSendConfirm
      .mockResolvedValueOnce("sig-0")
      .mockRejectedValueOnce(new Error("Account is not empty"))
      .mockResolvedValue("sig-2");

    const result = await reclaimRent({ wallet, treasury: TREASURY, plan: built });

    expect(result.results).toHaveLength(built.batches.length);
    expect(result.failures).toBe(1);
    expect(result.results[0]!.signature).toBe("sig-0");
    expect(result.results[1]!.signature).toBeNull();
    expect(result.results[1]!.error).toContain("not empty");
    // The failed batch contributes nothing to what the player received.
    const landed = built.batches.filter((_batch, index) => index !== 1);
    expect(result.reclaimedLamports).toBe(landed.reduce((sum, batch) => sum + batch.lamports, 0n));
    expect(result.platformFeeLamports).toBe(
      landed.reduce((sum, batch) => sum + batch.platformFeeLamports, 0n),
    );
    expect(result.userReceivesLamports).toBe(result.reclaimedLamports - result.platformFeeLamports);
    expect(signSendConfirm).toHaveBeenCalledTimes(built.batches.length);
  });

  it("never hands the chain a close for an account that still holds a balance", async () => {
    const holding = account({ seed: 70, amount: 1_000n });
    const empty = account({ seed: 71 });
    const result = await reclaimRent({ wallet, treasury: TREASURY, plan: plan([holding, empty]) });
    const sent = signSendConfirm.mock.calls.flatMap(
      (call) => call[1] as { accounts?: { address: string }[] }[],
    );
    const touched = sent.flatMap((instruction) =>
      (instruction.accounts ?? []).map((entry) => entry.address),
    );
    expect(touched).toContain(String(empty.account));
    expect(touched).not.toContain(String(holding.account));
    expect(result.plan.skipped.map((entry) => entry.account)).toEqual([holding.account]);
  });

  it("reports the batch as failed when the wallet refuses it", async () => {
    signSendConfirm.mockRejectedValue(new Error("User rejected the request"));
    const result = await reclaimRent({ wallet, treasury: TREASURY, plan: plan(empties(3)) });
    expect(result.failures).toBe(1);
    expect(result.reclaimedLamports).toBe(0n);
    expect(result.userReceivesLamports).toBe(0n);
    expect(result.results[0]!.error).toContain("rejected");
  });

  it("does nothing at all when there is nothing to close", async () => {
    const result = await reclaimRent({ wallet, treasury: TREASURY, plan: plan([]) });
    expect(signSendConfirm).not.toHaveBeenCalled();
    expect(result.results).toHaveLength(0);
    expect(result.failures).toBe(0);
  });

  it("preserves a timed-out signature, counts zero until it lands, then confirms the reclaim", async () => {
    const built = plan(empties(1));
    signSendConfirm.mockResolvedValue({
      signature: "landed-after-timeout",
      status: "pending",
      confirmed: false,
      error: "Confirmation is still pending.",
    });
    awaitConfirmation.mockResolvedValue(true);

    const pending = await reclaimRent({ wallet, treasury: TREASURY, plan: built });
    expect(pending.results[0]).toMatchObject({
      signature: "landed-after-timeout",
      status: "pending",
    });
    expect(pending.reclaimedLamports).toBe(0n);
    expect(pending.userReceivesLamports).toBe(0n);
    expect(hasPendingReclaim(pending)).toBe(true);
    expect(signSendConfirm).toHaveBeenCalledTimes(1);

    const confirmed = await resolvePendingReclaim(pending);
    expect(awaitConfirmation).toHaveBeenCalledWith("landed-after-timeout");
    expect(confirmed.results[0]).toMatchObject({
      signature: "landed-after-timeout",
      status: "confirmed",
      error: null,
    });
    expect(confirmed.reclaimedLamports).toBe(built.batches[0]!.lamports);
    expect(confirmed.platformFeeLamports).toBe(built.batches[0]!.platformFeeLamports);
    expect(confirmed.userReceivesLamports).toBe(built.batches[0]!.userReceivesLamports);
    expect(hasPendingReclaim(confirmed)).toBe(false);
    // Resolving a late signature only reads status; it never submits the close again.
    expect(signSendConfirm).toHaveBeenCalledTimes(1);
  });

  it("keeps retry protection until a pending signature is resolved", async () => {
    const built = plan(empties(1));
    signSendConfirm.mockResolvedValue({
      signature: "still-pending",
      status: "pending",
      confirmed: false,
      error: "Confirmation is still pending.",
    });
    awaitConfirmation.mockResolvedValue(false);

    const first = await reclaimRent({ wallet, treasury: TREASURY, plan: built });
    expect(hasPendingReclaim(first)).toBe(true);

    const checked = await resolvePendingReclaim(first);
    expect(hasPendingReclaim(checked)).toBe(true);
    expect(checked.results[0]!.signature).toBe("still-pending");
    expect(checked.reclaimedLamports).toBe(0n);
    expect(signSendConfirm).toHaveBeenCalledTimes(1);
  });
});
