import { describe, expect, it } from "vitest";
import { address, type Instruction } from "@solana/kit";
import {
  INSTRUCTION_DISCRIMINATORS,
  LAUNCH_RENT_LAMPORTS,
  type DecodedCoin,
  type DecodedSponsorEvent,
} from "../shared/program";
import {
  QuoteUnavailableError,
  availableCrankActions,
  buildSwapInstruction,
  findLaunchSubsidy,
  launchCostLamports,
  planSwap,
  rawAmountToDecimal,
  selectSponsorEvent,
  sponsorEventActive,
  swapAmountRaw,
  type SponsorEventView,
} from "./solanaProgram";
import type { CoinVenueState } from "./onchain";

/**
 * The frontend's job in v2 is to build transactions the program will accept and to protect the
 * trader with a floor it actually derived. These pin the two places that can go wrong silently:
 * the routing between the curve and the pool, and the slippage floor.
 */

const PROGRAM = address("H3Y8GgTnvwv5U1bajfzj386YSPC48vvwjFroXYyHZFj5");
const MINT = address("So11111111111111111111111111111111111111112");

function venueState(overrides: Partial<DecodedCoin> = {}, venue: "curve" | "pool" = "curve"): CoinVenueState {
  const coin = {
    tokenReserve: 1_000_000n,
    solReserve: 30_000_000_000n,
    virtualSolReserve: 1_000_000_000n,
    creatorFeeBps: 50,
    platformFeeBps: 50,
    graduated: venue === "pool",
    ...overrides,
  } as DecodedCoin;
  return {
    coin,
    pool:
      venue === "pool"
        ? ({ tokenReserve: 1_000_000n, solReserve: 30_000_000_000n } as never)
        : null,
    venue,
    crankPoolFeeBps: 0,
  };
}

describe("swapAmountRaw", () => {
  it("counts a buy in lamports and a sell in the token's own base units", () => {
    expect(swapAmountRaw(1, "buy", 6)).toBe(1_000_000_000n);
    expect(swapAmountRaw(1, "sell", 6)).toBe(1_000_000n);
  });

  it("has no raw amount for a missing or non-positive input", () => {
    expect(swapAmountRaw(0, "buy", 6)).toBe(0n);
    expect(swapAmountRaw(-1, "sell", 6)).toBe(0n);
    expect(swapAmountRaw(Number.NaN, "buy", 6)).toBe(0n);
  });
});

describe("planSwap", () => {
  it("refuses a graduated coin whose pool could not be read, instead of falling back to the curve", () => {
    const state = venueState({}, "pool");
    state.pool = null;
    expect(() => planSwap(state, "buy", 1_000_000_000n)).toThrow(QuoteUnavailableError);
  });

  it("refuses an empty amount", () => {
    expect(() => planSwap(venueState(), "buy", 0n)).toThrow(QuoteUnavailableError);
  });

  it("keeps a positive floor on both sides of both venues", () => {
    for (const venue of ["curve", "pool"] as const) {
      const state = venueState({}, venue);
      expect(planSwap(state, "buy", 1_000_000_000n).minOutRaw).toBeGreaterThan(0n);
      expect(planSwap(state, "sell", 10_000n).minOutRaw).toBeGreaterThan(0n);
    }
  });

  it("derives the floor from the quote at the caller's own slippage, for a sell as well as a buy", () => {
    const state = venueState();
    // A 1 SOL buy pays 1% of explicit fees, so the curve sees 990_000_000 and returns 30_947
    // tokens; 1% slippage floors that at 30_637.
    expect(planSwap(state, "buy", 1_000_000_000n, 100).minOutRaw).toBe(30_637n);
    // A 10_000 base-unit sell grosses 306_930_693 lamports, the same 1% of fees leaves
    // 303_861_387, and 1% slippage floors that at 300_822_773.
    const sell = planSwap(state, "sell", 10_000n, 100);
    expect(sell.minOutRaw).toBe(300_822_773n);
    expect(sell.minOutRaw).toBeLessThan(sell.expectedOutRaw);
  });

  it("refuses a trade whose quoted output is too small to keep any floor at all", () => {
    // A one-lamport buy quotes far below the 100 base units that 2% slippage would need.
    expect(() => planSwap(venueState(), "buy", 1n)).toThrow(QuoteUnavailableError);
  });
});

describe("buildSwapInstruction", () => {
  const params = {
    programAddress: PROGRAM,
    trader: address("11111111111111111111111111111111"),
    traderTokens: address("11111111111111111111111111111111"),
    mint: MINT,
    amountRaw: 1_000_000_000n,
    minOutRaw: 1n,
  };

  const bytesOf = (ix: Instruction) => ix.data ?? new Uint8Array();
  const firstEight = (ix: Instruction) => Array.from(bytesOf(ix).slice(0, 8));

  /** A little-endian u64 out of the instruction payload, read byte by byte. */
  const readU64LE = (ix: Instruction, offset: number) => {
    const data = bytesOf(ix);
    let value = 0n;
    for (let i = 7; i >= 0; i -= 1) value = (value << 8n) | BigInt(data[offset + i]);
    return value;
  };

  it("routes a pre-graduation trade to the curve instructions", () => {
    const buy = buildSwapInstruction({ ...params, venue: "curve", side: "buy" });
    const sell = buildSwapInstruction({ ...params, venue: "curve", side: "sell" });
    expect(firstEight(buy)).toEqual(Array.from(INSTRUCTION_DISCRIMINATORS.buy));
    expect(firstEight(sell)).toEqual(Array.from(INSTRUCTION_DISCRIMINATORS.sell));
  });

  it("routes a graduated trade to the pool instructions", () => {
    const buy = buildSwapInstruction({ ...params, venue: "pool", side: "buy" });
    const sell = buildSwapInstruction({ ...params, venue: "pool", side: "sell" });
    expect(firstEight(buy)).toEqual(Array.from(INSTRUCTION_DISCRIMINATORS.pool_buy));
    expect(firstEight(sell)).toEqual(Array.from(INSTRUCTION_DISCRIMINATORS.pool_sell));
  });

  it("carries the floor the caller derived, as the second u64 of the payload", () => {
    const ix = buildSwapInstruction({ ...params, venue: "curve", side: "buy", minOutRaw: 42n });
    expect(readU64LE(ix, 8)).toBe(1_000_000_000n);
    expect(readU64LE(ix, 16)).toBe(42n);
  });
});

describe("rawAmountToDecimal", () => {
  it("keeps a raw amount exact where a JS Number would round it", () => {
    expect(rawAmountToDecimal(9_007_199_254_740_993n, 9)).toBe("9007199.254740993");
  });

  it("writes whole amounts and trims the fraction", () => {
    expect(rawAmountToDecimal(1_000_000_000n, 9)).toBe("1");
    expect(rawAmountToDecimal(1_500_000_000n, 9)).toBe("1.5");
  });
});

describe("launchCostLamports", () => {
  it("charges the three accounts' rent plus the network fee when the creator pays", () => {
    const cost = launchCostLamports({ sponsored: false });
    expect(cost.rentLamports).toBe(LAUNCH_RENT_LAMPORTS);
    expect(cost.totalLamports).toBe(cost.rentLamports + cost.feeLamports);
  });

  it("leaves the creator only the network fee when a LaunchRentSubsidy event covers the rent", () => {
    const cost = launchCostLamports({ sponsored: true });
    expect(cost.rentLamports).toBe(0n);
    expect(cost.totalLamports).toBe(cost.feeLamports);
  });
});

/* Sponsorship can move rent and fees and nothing else, so the only question the UI asks of an
   event is whether it is spending right now and how much budget it has left. The bond subsidy is
   gone with the bond, so no event can pay a deposit any more. */

const NOW = 1_800_000_000;

function sponsorEvent(overrides: Partial<DecodedSponsorEvent> = {}): DecodedSponsorEvent {
  return {
    vault: address("11111111111111111111111111111111"),
    kind: 0,
    kindName: null,
    startAt: BigInt(NOW - 3_600),
    endAt: BigInt(NOW + 3_600),
    budgetLamports: 10_000_000_000n,
    spentLamports: 0n,
    perCoinLimitLamports: LAUNCH_RENT_LAMPORTS,
    perWalletLimitLamports: 70_000_000n,
    paused: false,
    bump: 255,
    version: 5,
    ...overrides,
  };
}

function eventView(overrides: Partial<DecodedSponsorEvent> = {}, eventId = 0): SponsorEventView {
  return {
    eventId,
    address: address("11111111111111111111111111111111"),
    vault: address("11111111111111111111111111111111"),
    decoded: sponsorEvent(overrides),
  };
}

describe("sponsorEventActive", () => {
  it("is true only inside the window, unpaused and with budget left", () => {
    expect(sponsorEventActive(sponsorEvent(), NOW)).toBe(true);
    expect(sponsorEventActive(sponsorEvent({ paused: true }), NOW)).toBe(false);
    expect(sponsorEventActive(sponsorEvent({ spentLamports: 10_000_000_000n }), NOW)).toBe(false);
    expect(sponsorEventActive(sponsorEvent({ startAt: BigInt(NOW + 1) }), NOW)).toBe(false);
    expect(sponsorEventActive(sponsorEvent({ endAt: BigInt(NOW - 1) }), NOW)).toBe(false);
  });
});

describe("selectSponsorEvent", () => {
  it("picks the active event of the right kind with the most budget left", () => {
    const chosen = selectSponsorEvent(
      [
        eventView({ budgetLamports: 5_000_000_000n }, 0),
        eventView({ budgetLamports: 9_000_000_000n }, 1),
        eventView({ budgetLamports: 20_000_000_000n, kind: 1 }, 2),
        eventView({ budgetLamports: 30_000_000_000n, paused: true }, 3),
      ],
      0,
      NOW,
    );
    expect(chosen?.eventId).toBe(1);
  });

  it("returns null rather than a stopped event", () => {
    expect(selectSponsorEvent([eventView({ paused: true })], 0, NOW)).toBeNull();
    expect(selectSponsorEvent([], 0, NOW)).toBeNull();
  });
});

describe("findLaunchSubsidy", () => {
  it("accepts an event whose remaining budget covers one launch's rent", () => {
    expect(findLaunchSubsidy([eventView()], NOW)?.eventId).toBe(0);
  });

  it("refuses one whose per-coin limit is below a launch's rent", () => {
    const tooSmall = eventView({ perCoinLimitLamports: 1_000n, budgetLamports: 1_000n });
    expect(findLaunchSubsidy([tooSmall], NOW)).toBeNull();
  });

  it("ignores an event of the wrong kind", () => {
    expect(findLaunchSubsidy([eventView({ kind: 2 })], NOW)).toBeNull();
  });
});

describe("availableCrankActions", () => {
  const base = {
    graduated: false,
    epochSeedTargetSlot: 0n,
    epochSeedEpoch: 0,
    epochIndex: 0,
    solReserve: 0n,
    graduationTarget: 0n,
    creatorFeeClaimable: 0n,
    platformFeeClaimable: 0n,
  };

  it("always offers the ledger walk, because it is the one action that is never wrong", () => {
    expect(availableCrankActions(base, 100n)).toEqual(["advance"]);
  });

  it("offers the seed reveal only once the armed target slot has been produced", () => {
    const armed = { ...base, epochSeedTargetSlot: 500n, epochSeedEpoch: 0, epochIndex: 1 };
    expect(availableCrankActions(armed, 499n)).toEqual(["advance"]);
    expect(availableCrankActions(armed, 500n)).toEqual(["advance", "commitSeed"]);
  });

  it("offers graduation only once the on-chain condition is true", () => {
    const near = { ...base, graduationTarget: 1_000n, solReserve: 999n };
    expect(availableCrankActions(near, 1n)).toEqual(["advance"]);
    const met = { ...base, graduationTarget: 1_000n, solReserve: 1_000n };
    expect(availableCrankActions(met, 1n)).toEqual(["advance", "graduate"]);
  });

  it("offers the sweep and the tip together, and only when there is accrual to pay from", () => {
    const accruing = { ...base, creatorFeeClaimable: 5n };
    expect(availableCrankActions(accruing, 1n)).toEqual(["advance", "sweep", "tip"]);
  });
});
