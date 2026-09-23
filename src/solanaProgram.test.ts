/**
 * Regression tests for the trade path that must never be sent without a slippage floor.
 *
 * The bug these cover: the swap form built its `min_tokens_out` / `min_sol_out` as
 * `quote?.minOutRaw ?? 0n`, so a market read or a pool read that failed produced a signed trade
 * with zero slippage protection — an open offer to be filled at any price. The fix moved that
 * decision into planSwap(), which refuses to produce amounts without a live quote, and into
 * executeSwap(), which re-reads the venue and prices the trade again immediately before signing.
 * Both are pure/injectable, so the failure modes are testable without a wallet or an RPC.
 */
import { describe, expect, it, vi } from "vitest";
import type { Address } from "@solana/kit";
import type { DecodedLaunchMarket, DecodedLiquidityPool, DecodedMine } from "../shared/program";
import {
  buyOnChain,
  executeSwap,
  planSwap,
  quoteSwap,
  QuoteUnavailableError,
  rawAmountToDecimal,
  sellOnChain,
  swapAmountRaw,
  type DiggoWallet,
  type MarketVenueState,
} from "./solanaProgram";

const LAMPORTS = 1_000_000_000n;
const DECIMALS = 6;
const RAW = 10n ** BigInt(DECIMALS);
const PROGRAM = "Diggo111111111111111111111111111111111111" as Address;
const MINT = "Mint1111111111111111111111111111111111111" as Address;
const WALLET = { address: "Wallet11111111111111111111111111111111111" } as unknown as DiggoWallet;

function addr(value: string): Address {
  return value as Address;
}

function market(overrides: Partial<DecodedLaunchMarket> = {}): DecodedLaunchMarket {
  return {
    mine: addr("Mine1111111111111111111111111111111111111"),
    tokenReserve: 1_000_000n * RAW,
    solReserve: 100n * LAMPORTS,
    virtualSolReserve: 30n * LAMPORTS,
    graduationTarget: 500n * LAMPORTS,
    graduated: false,
    creatorFeeClaimable: 0n,
    platformFeeClaimable: 0n,
    creatorFeeBps: 50,
    platformFeeBps: 50,
    bump: 255,
    version: 1,
    // A market launched without a pre-graduation budget: the documented legacy default.
    curveMiningCap: 0n,
    curveMiningMined: 0n,
    curveMiningUnpaid: 0n,
    curveMiningBlockReward: 0n,
    ...overrides,
  };
}

function lockedPool(overrides: Partial<DecodedLiquidityPool> = {}): DecodedLiquidityPool {
  return {
    mine: addr("Mine1111111111111111111111111111111111111"),
    mint: MINT,
    tokenVault: addr("TokenVault111111111111111111111111111111111"),
    solVault: addr("SolVault1111111111111111111111111111111111"),
    tokenReserve: 1_000_000n * RAW,
    solReserve: 500n * LAMPORTS,
    graduatedAt: 1n,
    bump: 254,
    ...overrides,
  };
}

/** Only the market and pool feed the swap path; the mine is carried along untouched. */
function venueState(
  overrides: { market?: DecodedLaunchMarket; pool?: DecodedLiquidityPool | null } = {},
): MarketVenueState {
  const decoded = overrides.market ?? market();
  return {
    mine: { mint: decoded.mine } as unknown as DecodedMine,
    market: decoded,
    pool: overrides.pool ?? null,
    venue: decoded.graduated ? "pool" : "curve",
  };
}

/** Fakes typed against the real on-chain calls, so assertions read the arguments they were given. */
function buyMock() {
  return vi.fn<typeof buyOnChain>(async () => ({ signature: "buy-signature" }));
}

function sellMock() {
  return vi.fn<typeof sellOnChain>(async () => ({ signature: "sell-signature" }));
}

describe("swapAmountRaw", () => {
  it("counts a buy in lamports and a sell in the token's own base units", () => {
    expect(swapAmountRaw(1, "buy", DECIMALS)).toBe(LAMPORTS);
    expect(swapAmountRaw(2.5, "sell", DECIMALS)).toBe(2_500_000n);
    expect(swapAmountRaw(1, "sell", 9)).toBe(LAMPORTS);
  });

  it("has no raw amount for a missing or non-positive input", () => {
    expect(swapAmountRaw(0, "buy", DECIMALS)).toBe(0n);
    expect(swapAmountRaw(-1, "sell", DECIMALS)).toBe(0n);
    expect(swapAmountRaw(Number.NaN, "buy", DECIMALS)).toBe(0n);
  });
});

describe("planSwap", () => {
  it("refuses a trade whose venue could not be read instead of falling back to a zero floor", () => {
    const graduated = market({ graduated: true });
    expect(() => planSwap({ market: graduated, pool: null }, "buy", LAMPORTS)).toThrow(QuoteUnavailableError);
    expect(() => planSwap({ market: graduated, pool: null }, "sell", 100n * RAW)).toThrow(QuoteUnavailableError);
  });

  it("refuses an empty amount", () => {
    expect(() => planSwap({ market: market(), pool: null }, "buy", 0n)).toThrow(QuoteUnavailableError);
  });

  it("keeps a positive floor on both sides of both venues", () => {
    const curve = { market: market(), pool: null };
    const graduated = { market: market({ graduated: true }), pool: lockedPool() };
    expect(planSwap(curve, "buy", 10n * LAMPORTS).minOutRaw).toBeGreaterThan(0n);
    expect(planSwap(curve, "sell", 1_000n * RAW).minOutRaw).toBeGreaterThan(0n);
    expect(planSwap(graduated, "buy", 10n * LAMPORTS).minOutRaw).toBeGreaterThan(0n);
    expect(planSwap(graduated, "sell", 1_000n * RAW).minOutRaw).toBeGreaterThan(0n);
  });

  it("derives the floor from the quote at the caller's own slippage, for a sell as well as a buy", () => {
    const curve = { market: market(), pool: null };
    for (const side of ["buy", "sell"] as const) {
      const amount = side === "buy" ? 10n * LAMPORTS : 1_000n * RAW;
      const quoted = quoteSwap(curve, side, amount, 500)!;
      expect(planSwap(curve, side, amount, 500).minOutRaw).toBe(quoted.minOutRaw);
      expect(planSwap(curve, side, amount, 500).minOutRaw).toBeLessThan(
        planSwap(curve, side, amount, 100).minOutRaw,
      );
    }
  });

  it("refuses a trade whose quoted output is too small to keep any floor at all", () => {
    // A one-base-unit sell against these reserves prices at exactly one lamport, and 1 - 2% of one
    // lamport truncates to zero: sending that would be an unprotected trade.
    const dust = market({ solReserve: 2_000_000n, virtualSolReserve: 0n, tokenReserve: 1_000_000n, creatorFeeBps: 0, platformFeeBps: 0 });
    expect(quoteSwap({ market: dust, pool: null }, "sell", 1n)!.outRaw).toBe(1n);
    expect(() => planSwap({ market: dust, pool: null }, "sell", 1n)).toThrow(QuoteUnavailableError);
  });
});

describe("the on-chain trade calls themselves", () => {
  it("refuses a zero floor before anything is signed", async () => {
    // The last line of defence: even a caller that bypasses planSwap cannot send an unprotected
    // trade, because a zero floor is a standing offer to be filled at any price. The refusal happens
    // before any account read, so nothing here needs an RPC or a wallet that can sign.
    await expect(buyOnChain(PROGRAM, WALLET, MINT, 1, 0n)).rejects.toThrow(QuoteUnavailableError);
    await expect(buyOnChain(PROGRAM, WALLET, MINT, 1, -1n)).rejects.toThrow(QuoteUnavailableError);
    await expect(sellOnChain(PROGRAM, WALLET, MINT, 1_000n, 0n)).rejects.toThrow(QuoteUnavailableError);
  });
});

describe("rawAmountToDecimal", () => {
  it("keeps a raw amount exact where a JS Number would round it", () => {
    const raw = 9_007_199_254_740_993n; // 2^53 + 1: the first integer a float cannot represent
    expect(rawAmountToDecimal(raw, 6)).toBe("9007199254.740993");
    // What the old Number(raw) / 10 ** decimals did with the same figure.
    expect(String(Number(raw) / 10 ** 6)).not.toBe("9007199254.740993");
  });

  it("writes whole amounts and trims the fraction", () => {
    expect(rawAmountToDecimal(2_500_000n, 6)).toBe("2.5");
    expect(rawAmountToDecimal(1_000_000n, 6)).toBe("1");
    expect(rawAmountToDecimal(1n, 6)).toBe("0.000001");
    expect(rawAmountToDecimal(0n, 6)).toBe("0");
  });
});

describe("executeSwap", () => {
  it("sends nothing when the market cannot be read, so a zero floor is never signed", async () => {
    const buy = buyMock();
    const sell = sellMock();
    await expect(
      executeSwap({
        programAddress: PROGRAM,
        wallet: WALLET,
        mint: MINT,
        side: "buy",
        amount: 1,
        decimals: DECIMALS,
        deps: { readVenue: async () => null, buy, sell },
      }),
    ).rejects.toBeInstanceOf(QuoteUnavailableError);
    expect(buy).not.toHaveBeenCalled();
    expect(sell).not.toHaveBeenCalled();
  });

  it("prices the buy again from the read it makes just before signing", async () => {
    const buy = buyMock();
    const sell = sellMock();
    const fresh = venueState();
    const execution = await executeSwap({
      programAddress: PROGRAM,
      wallet: WALLET,
      mint: MINT,
      side: "buy",
      amount: 1,
      decimals: DECIMALS,
      deps: { readVenue: async () => fresh, buy, sell },
    });
    const expectedFloor = quoteSwap(fresh, "buy", LAMPORTS)!.minOutRaw;
    expect(execution.plan.minOutRaw).toBe(expectedFloor);
    expect(execution.plan.minOutRaw).toBeGreaterThan(0n);
    expect(execution.plan.venue).toBe("curve");
    expect(execution.state).toBe(fresh);
    expect(buy).toHaveBeenCalledTimes(1);
    expect(buy.mock.calls[0][3]).toBe(1);
    expect(buy.mock.calls[0][4]).toBe(expectedFloor);
    expect(buy.mock.calls[0][5]).toEqual({ venue: "curve" });
    expect(sell).not.toHaveBeenCalled();
  });

  it("guards a sell symmetrically, on the venue the fresh read reports", async () => {
    const buy = buyMock();
    const sell = sellMock();
    const fresh = venueState({ market: market({ graduated: true }), pool: lockedPool() });
    const execution = await executeSwap({
      programAddress: PROGRAM,
      wallet: WALLET,
      mint: MINT,
      side: "sell",
      amount: 1_000,
      decimals: DECIMALS,
      deps: { readVenue: async () => fresh, buy, sell },
    });
    const expectedFloor = quoteSwap(fresh, "sell", 1_000n * RAW)!.minOutRaw;
    expect(execution.plan.minOutRaw).toBe(expectedFloor);
    expect(execution.plan.minOutRaw).toBeGreaterThan(0n);
    expect(sell).toHaveBeenCalledTimes(1);
    expect(sell.mock.calls[0][3]).toBe(1_000n * RAW);
    expect(sell.mock.calls[0][4]).toBe(expectedFloor);
    expect(sell.mock.calls[0][5]).toEqual({ venue: "pool" });
    expect(buy).not.toHaveBeenCalled();
  });

  it("refuses a trade the form still shows a quote for when the fresh read has no pool", async () => {
    const buy = buyMock();
    const sell = sellMock();
    // What the panel had cached vs. what the chain says now: a graduated market whose pool account
    // did not read back. The stale quote must not become the transaction's floor.
    const unreadablePool = venueState({ market: market({ graduated: true }), pool: null });
    expect(quoteSwap(venueState({ market: market({ graduated: true }), pool: lockedPool() }), "sell", 1_000n * RAW)).not.toBeNull();
    await expect(
      executeSwap({
        programAddress: PROGRAM,
        wallet: WALLET,
        mint: MINT,
        side: "sell",
        amount: 1_000,
        decimals: DECIMALS,
        deps: { readVenue: async () => unreadablePool, buy, sell },
      }),
    ).rejects.toBeInstanceOf(QuoteUnavailableError);
    expect(sell).not.toHaveBeenCalled();
  });

  it("applies the caller's slippage to the floor it sends", async () => {
    const buy = buyMock();
    const tight = await executeSwap({
      programAddress: PROGRAM,
      wallet: WALLET,
      mint: MINT,
      side: "buy",
      amount: 1,
      decimals: DECIMALS,
      slippageBps: 100,
      deps: { readVenue: async () => venueState(), buy, sell: sellMock() },
    });
    const loose = await executeSwap({
      programAddress: PROGRAM,
      wallet: WALLET,
      mint: MINT,
      side: "buy",
      amount: 1,
      decimals: DECIMALS,
      slippageBps: 500,
      deps: { readVenue: async () => venueState(), buy, sell: sellMock() },
    });
    expect(tight.plan.slippageBps).toBe(100);
    expect(loose.plan.slippageBps).toBe(500);
    expect(loose.plan.minOutRaw).toBeLessThan(tight.plan.minOutRaw);
    expect(buy.mock.calls[0][4]).toBe(tight.plan.minOutRaw);
    expect(buy.mock.calls[1][4]).toBe(loose.plan.minOutRaw);
  });
});
