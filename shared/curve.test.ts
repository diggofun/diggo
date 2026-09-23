import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DIGGO_CONFIG } from "./config";
import {
  CURVE_MINING_MIN_BLOCKS,
  DEFAULT_DISCOVERY_RESERVE_BPS,
  DEFAULT_RESERVE_BPS,
  DEFAULT_VIRTUAL_SOL_BPS,
  PRICE_SCALE,
  QuoteError,
  SLOTS_PER_SECOND,
  activeMineBudget,
  accumulatePrice,
  curveBuyOut,
  curveSellOut,
  curveSpotPriceLamportsPerUnit,
  curveMiningBlockReward,
  curveMiningCapFor,
  curveMiningDaysRemaining,
  curveMiningLedgerFor,
  curveMiningProgress,
  curveMiningRoom,
  curveMiningRunwayBlocks,
  curveMiningRunwayIsValid,
  curveMiningStateOf,
  curveSellCapacity,
  initialBlockReward,
  isCurveMiningCapReached,
  isCurveMiningDisabled,
  isCurveMiningOpen,
  lamportsForUnits,
  launchRentLamports,
  maxCrankTip,
  mulBps,
  mulBpsV2,
  netAfterTradeFees,
  poolBuyOut,
  poolSellOut,
  poolSpotPriceLamportsPerUnit,
  priceLamportsPerUnit,
  quoteCurveBuy,
  quoteCurveSell,
  quotePoolBuy,
  quotePoolSell,
  splitFees,
  splitPlatformBucket,
  splitSupply,
  splitTradeFees,
  twapAverage,
  unitsForLamports,
  virtualSolReserve,
  type CurveMiningState,
  type CurveMiningLedgerFields,
  type CurveVenueReserves,
} from "./curve";
import { CONTRACT } from "./parity/vectors.contract.generated";
import {
  DEFAULT_CURVE_MINING_BPS,
  DEFAULT_CURVE_MINING_RUNWAY_DAYS,
  MAX_CURVE_MINING_BPS,
  MAX_CURVE_MINING_RUNWAY_DAYS,
  type DecodedCoin,
  type DecodedLiquidityPool,
} from "./program";

/** A 950,000,000 base-unit curve inventory, i.e. 950 whole tokens at 6 decimals. */
const INVENTORY = 950_000_000n;
/** 5% of it, which is the launch default. */
const CAP = 47_500_000n;
/** 30 days of 300-second blocks. */
const RUNWAY_BLOCKS = 8_640n;
/** ceil(47,500,000 / 8,640). */
const RATE = 5_498n;

/** The curve ledger and reserve pair these tests read, which a decoded Coin also satisfies. */
type TestMarket = CurveMiningLedgerFields & CurveVenueReserves;

function market(overrides: Partial<TestMarket> = {}): TestMarket {
  return {
    tokenReserve: INVENTORY,
    solReserve: 30_000_000_000n,
    virtualSolReserve: 5_000_000_000n,
    graduated: false,
    curveMiningCap: CAP,
    curveMiningMined: 0n,
    curveMiningUnpaid: 0n,
    curveMiningBlockReward: RATE,
    ...overrides,
  };
}

/** The same ledger in round numbers, for the arithmetic that does not care about units. */
function ledger(overrides: Partial<CurveMiningState> = {}): CurveMiningState {
  return { graduated: false, cap: 47_500n, mined: 0n, unpaid: 0n, blockReward: 6n, ...overrides };
}

describe("curve-phase mining parameters", () => {
  it("keeps the config's defaults and bounds in step with the program's own constants", () => {
    // A default the program would reject is a launch that cannot land, so the two copies of
    // these numbers are pinned to each other rather than trusted to stay in step.
    expect(DIGGO_CONFIG.curve.defaultMiningBps).toBe(DEFAULT_CURVE_MINING_BPS);
    expect(DIGGO_CONFIG.curve.maxMiningBps).toBe(MAX_CURVE_MINING_BPS);
    expect(DIGGO_CONFIG.curve.defaultRunwayDays).toBe(DEFAULT_CURVE_MINING_RUNWAY_DAYS);
    expect(DIGGO_CONFIG.curve.maxRunwayDays).toBe(MAX_CURVE_MINING_RUNWAY_DAYS);
    expect(DEFAULT_CURVE_MINING_BPS).toBe(500);
    expect(MAX_CURVE_MINING_BPS).toBe(1_000);
    expect(MAX_CURVE_MINING_RUNWAY_DAYS).toBe(3_650);
    expect(CURVE_MINING_MIN_BLOCKS).toBe(48);
  });

  it("requires a runway to be a schedule rather than a single block", () => {
    // The program refuses a curve share whose runway holds fewer than MIN_CURVE_MINING_BLOCKS
    // blocks, because the flat rate would otherwise emit the whole cap at block one. The mirror
    // has to agree, or a launch the UI offers would be rejected on chain.
    expect(curveMiningRunwayIsValid(300, 30, 500)).toBe(true);
    expect(curveMiningRunwayIsValid(86_400, 1, 500)).toBe(false);
    expect(curveMiningRunwayIsValid(86_400, 47, 500)).toBe(false);
    expect(curveMiningRunwayIsValid(86_400, 48, 500)).toBe(true);
    // A launch that asks for no curve share has no runway to bound.
    expect(curveMiningRunwayIsValid(86_400, 1, 0)).toBe(true);
  });

  it("takes the cap as a share of the curve's own initial inventory", () => {
    expect(curveMiningCapFor(INVENTORY, 500)).toBe(CAP);
    expect(curveMiningCapFor(INVENTORY, 1_000)).toBe(95_000_000n);
    // A zero share is legal: the pre-curve rule of a mine that only emits after graduation.
    expect(curveMiningCapFor(INVENTORY, 0)).toBe(0n);
    expect(curveMiningCapFor(0n, 500)).toBe(0n);
  });

  it("spreads the cap over the launch runway instead of paying it out in hours", () => {
    expect(curveMiningRunwayBlocks(300, 30)).toBe(RUNWAY_BLOCKS);
    expect(curveMiningBlockReward(CAP, 300, 30)).toBe(RATE);
    // Finishable at that rate, and rounding up is the only overshoot.
    expect(RATE * RUNWAY_BLOCKS).toBeGreaterThanOrEqual(CAP);
    expect((RATE - 1n) * RUNWAY_BLOCKS).toBeLessThan(CAP);
    // The mine's own reserve schedule pays whole tokens per block (a flagship launch is 7,500
    // of them, i.e. 7,500,000,000 base units), so it would have spent this budget in hours.
    const flagshipReserveRate = 7_500n * 1_000_000n;
    expect(flagshipReserveRate / RATE).toBeGreaterThan(1_000_000n);
    expect(CAP / flagshipReserveRate).toBeLessThan(10n);
    // A cap too small to divide still spreads over its runway, one base unit at a time.
    expect(curveMiningBlockReward(1n, 300, 30)).toBe(1n);
    expect(curveMiningBlockReward(0n, 300, 30)).toBe(0n);
  });

  it("builds the whole launch-time ledger from the launch parameters", () => {
    const built = curveMiningLedgerFor({
      initialCurveInventory: INVENTORY,
      miningBps: 500,
      blockIntervalSeconds: 300,
      runwayDays: 30,
    });
    expect(built).toEqual({
      graduated: false,
      cap: CAP,
      mined: 0n,
      unpaid: 0n,
      blockReward: RATE,
    });
    expect(isCurveMiningOpen(built)).toBe(true);
  });

  it("clamps what a launch may ask for to the configured bounds", () => {
    const over = curveMiningLedgerFor({
      initialCurveInventory: INVENTORY,
      miningBps: 5_000,
      blockIntervalSeconds: 300,
      runwayDays: 30,
    });
    // A 50% ask is clamped to the 10% ceiling.
    expect(over.cap).toBe(95_000_000n);
    const noRunway = curveMiningLedgerFor({
      initialCurveInventory: INVENTORY,
      miningBps: 500,
      blockIntervalSeconds: 300,
      runwayDays: 0,
    });
    expect(noRunway.blockReward).toBeGreaterThan(0n);
  });
});

describe("the curve phase's budget", () => {
  it("is open only while the market is on its curve with budget left", () => {
    expect(isCurveMiningOpen(ledger())).toBe(true);
    expect(isCurveMiningOpen(ledger({ mined: 47_500n }))).toBe(false);
    expect(isCurveMiningOpen(ledger({ graduated: true }))).toBe(false);
    expect(isCurveMiningOpen(ledger({ cap: 0n }))).toBe(false);
    expect(curveMiningRoom(ledger({ mined: 47_000n }))).toBe(500n);
    // A row whose mined total has somehow passed the cap never reads negative.
    expect(curveMiningRoom(ledger({ mined: 60_000n }))).toBe(0n);
    expect(curveMiningProgress(ledger({ mined: 23_750n }))).toBeCloseTo(0.5, 10);
    expect(curveMiningProgress(ledger({ cap: 0n }))).toBe(0);
  });

  it("separates an idle cap from a market that never had one", () => {
    // Idle: the budget was granted and is spent. Awaiting graduation, not finished.
    expect(isCurveMiningCapReached(ledger({ mined: 47_500n }))).toBe(true);
    expect(isCurveMiningDisabled(ledger({ mined: 47_500n }))).toBe(false);
    // Disabled: no budget was ever granted - a zero-share launch, or a legacy market, whose cap a
    // migration can only default to zero. The UI has to say "mining starts at graduation" here
    // rather than draw an empty progress bar over a budget that never existed.
    expect(isCurveMiningDisabled(ledger({ cap: 0n }))).toBe(true);
    expect(isCurveMiningCapReached(ledger({ cap: 0n }))).toBe(false);
    // Neither applies while the cap has room, or once the market has graduated and the Mining
    // Reserve is the side that pays.
    expect(isCurveMiningCapReached(ledger())).toBe(false);
    expect(isCurveMiningDisabled(ledger())).toBe(false);
    expect(isCurveMiningCapReached(ledger({ mined: 47_500n, graduated: true }))).toBe(false);
    expect(isCurveMiningDisabled(ledger({ cap: 0n, graduated: true }))).toBe(false);
  });

  it("reports how long the remaining budget lasts, and null when nothing can be said", () => {
    // 43,200 of the 47,500 budget left at 6 per block is 7,200 blocks, i.e. 25 days.
    const remaining = ledger({ mined: 4_300n });
    expect(curveMiningDaysRemaining(remaining, 300)).toBeCloseTo(
      (43_200 / 6) * (300 / 86_400),
      6,
    );
    expect(curveMiningDaysRemaining(remaining, 300)).toBeCloseTo(25, 6);
    expect(curveMiningDaysRemaining(ledger({ mined: 47_500n }), 300)).toBeNull();
    expect(curveMiningDaysRemaining(ledger({ blockReward: 0n }), 300)).toBeNull();
    expect(curveMiningDaysRemaining(ledger(), 0)).toBeNull();
  });

  it("pays from the curve until graduation and from the reserve after it", () => {
    const input = {
      curve: ledger(),
      reserveRemaining: 500_000n,
      reserveTotal: 1_000_000n,
      reserveBlockReward: 1_000n,
    };
    const onCurve = activeMineBudget(input);
    expect(onCurve).toEqual({
      source: "CURVE",
      initialReserve: 47_500n,
      remainingReserve: 47_500n,
      rewardPerBlock: 6n,
    });

    const spent = activeMineBudget({ ...input, curve: ledger({ mined: 47_500n }) });
    expect(spent.source).toBe("CURVE");
    // A spent cap pays nothing rather than quietly falling back on the reserve.
    expect(spent.remainingReserve).toBe(0n);

    const graduated = activeMineBudget({ ...input, curve: ledger({ graduated: true }) });
    expect(graduated).toEqual({
      source: "RESERVE",
      initialReserve: 1_000_000n,
      remainingReserve: 500_000n,
      rewardPerBlock: 1_000n,
    });
  });
});

describe("the read-only sell capacity of a curve", () => {
  it("is the real SOL the curve holds, and does not grow when a mine emits", () => {
    const before = market();
    const capacity = curveSellCapacity(before);
    expect(capacity.realSolLamports).toBe(30_000_000_000n);
    // quote_sell caps every payout at the real reserve and mining adds no lamport to it, so the
    // same capacity holds however much of the curve the mine has emitted.
    const after = market({
      tokenReserve: before.tokenReserve - 1_000_000n,
      curveMiningMined: 1_000_000n,
      curveMiningUnpaid: 400_000n,
    });
    expect(curveSellCapacity(after).realSolLamports).toBe(capacity.realSolLamports);
    // t = sol * tokens / virtual takes the uncapped curve's whole real reserve.
    expect(capacity.tokensForFullCapacity).toBe((30_000_000_000n * INVENTORY) / 5_000_000_000n);
    expect(capacity.tokensForFullCapacity).toBe(5_700_000_000n);
  });

  it("has no finite token amount when the curve has no virtual SOL reserve", () => {
    expect(curveSellCapacity(market({ virtualSolReserve: 0n })).tokensForFullCapacity).toBeNull();
  });

  it("is zero for a graduated market, whose liquidity is the pool's", () => {
    const graduated = curveSellCapacity(market({ graduated: true, solReserve: 0n }));
    expect(graduated.realSolLamports).toBe(0n);
    expect(graduated.tokensForFullCapacity).toBe(0n);
  });

  it("reads the ledger straight off a decoded market", () => {
    const state = curveMiningStateOf(
      market({ curveMiningMined: 1_000_000n, curveMiningUnpaid: 400_000n }),
    );
    expect(state).toEqual({
      graduated: false,
      cap: CAP,
      mined: 1_000_000n,
      unpaid: 400_000n,
      blockReward: RATE,
    });
  });
});

/**
 * The v2 coin vectors, generated from the Rust side and asserted here. When a value differs the
 * Rust value wins and this file is the bug: the chain is what pays.
 */
describe("v2 coin parity (shared/parity/coin.json)", () => {
  const vectors = JSON.parse(
    readFileSync(new URL("./parity/coin.json", import.meta.url), "utf8"),
  ) as {
    supplySplit: {
      totalSupply: string;
      reserveBps: number;
      discoveryReserveBps: number;
      reserve: string;
      discovery: string;
      curve: string;
    }[];
    curve: {
      tokenReserve: string;
      solReserve: string;
      virtualSolReserve: string;
      netSol?: string;
      tokensIn?: string;
      tokensOut?: string;
      grossSol?: string;
    }[];
    pool: {
      tokenReserve: string;
      solReserve: string;
      netSol?: string;
      tokensIn?: string;
      tokensOut?: string;
      grossSol?: string;
    }[];
    tradeFees: {
      gross: string;
      creatorFeeBps: number;
      platformFeeBps: number;
      creator: string;
      platform: string;
      net: string;
    }[];
    platformBucket: {
      platformLamports: string;
      crankPoolFeeBps: number;
      crankPool: string;
      treasury: string;
    }[];
    crankTip: { platformLamports: string; maxCrankTip: string }[];
    twap: {
      solReserve: string;
      tokenReserve: string;
      priceLamportsPerUnit: string;
      cumAfter10Slots: string;
      average20SlotsAt1xThen2x: string;
    };
    value: {
      direction: "unitsToLamports" | "lamportsToUnits";
      priceLamportsPerUnit: string;
      units?: string;
      lamports?: string;
    }[];
    launchRent: { mintLamports: string; coinLamports: string; vaultLamports: string; totalLamports: string };
    mining: {
      reserveRemaining: string;
      epochLength: number;
      blockInterval: number;
      minimumReward: string;
      initialBlockReward: string;
      curveTokenInventory: string;
      curveMiningBps: number;
      curveMiningCap: string;
      virtualSolBps: number;
      virtualSolReserve: string;
    };
  };

  it("splits a launch supply so the three parts add up to the whole", () => {
    for (const vector of vectors.supplySplit) {
      const split = splitSupply(
        BigInt(vector.totalSupply),
        vector.reserveBps,
        vector.discoveryReserveBps,
      );
      expect(split.reserve).toBe(BigInt(vector.reserve));
      expect(split.discovery).toBe(BigInt(vector.discovery));
      expect(split.curve).toBe(BigInt(vector.curve));
      expect(split.reserve + split.discovery + split.curve).toBe(BigInt(vector.totalSupply));
    }
  });

  it("quotes the bonding curve the way the program pays it", () => {
    for (const vector of vectors.curve) {
      const tokenReserve = BigInt(vector.tokenReserve);
      const solReserve = BigInt(vector.solReserve);
      const virtualSolReserve = BigInt(vector.virtualSolReserve);
      if (vector.tokensOut !== undefined) {
        expect(curveBuyOut(tokenReserve, solReserve, virtualSolReserve, BigInt(vector.netSol!))).toBe(
          BigInt(vector.tokensOut),
        );
      } else {
        expect(
          curveSellOut(tokenReserve, solReserve, virtualSolReserve, BigInt(vector.tokensIn!)),
        ).toBe(BigInt(vector.grossSol!));
      }
    }
  });

  it("quotes the locked pool and never drains a side", () => {
    for (const vector of vectors.pool) {
      const tokenReserve = BigInt(vector.tokenReserve);
      const solReserve = BigInt(vector.solReserve);
      if (vector.tokensOut !== undefined) {
        const out = poolBuyOut(tokenReserve, solReserve, BigInt(vector.netSol!));
        expect(out).toBe(BigInt(vector.tokensOut));
        expect(out).toBeLessThan(tokenReserve);
      } else {
        const gross = poolSellOut(tokenReserve, solReserve, BigInt(vector.tokensIn!));
        expect(gross).toBe(BigInt(vector.grossSol!));
        expect(gross).toBeLessThanOrEqual(solReserve);
      }
    }
  });

  it("splits a trade's fee without creating or losing a lamport", () => {
    for (const vector of vectors.tradeFees) {
      const gross = BigInt(vector.gross);
      const fees = splitTradeFees(gross, vector.creatorFeeBps, vector.platformFeeBps);
      expect(fees.creator).toBe(BigInt(vector.creator));
      expect(fees.platform).toBe(BigInt(vector.platform));
      expect(netAfterTradeFees(gross, fees)).toBe(BigInt(vector.net));
      expect(netAfterTradeFees(gross, fees) + fees.creator + fees.platform).toBe(gross);
    }
    // The two shares together may never exceed the protocol cap, so a trade is never all fee.
    expect(() => splitTradeFees(1_000n, 60, 60)).not.toThrow();
    expect(splitTradeFees(1_000n, 60, 60).creator + splitTradeFees(1_000n, 60, 60).platform).toBe(
      12n,
    );
  });

  it("splits the protocol bucket between the treasury and the crank pool exactly", () => {
    for (const vector of vectors.platformBucket) {
      const bucket = BigInt(vector.platformLamports);
      const split = splitPlatformBucket(bucket, vector.crankPoolFeeBps);
      expect(split.crankPool).toBe(BigInt(vector.crankPool));
      expect(split.treasury).toBe(BigInt(vector.treasury));
      expect(split.crankPool + split.treasury).toBe(bucket);
    }
    for (const vector of vectors.crankTip) {
      expect(maxCrankTip(BigInt(vector.platformLamports))).toBe(BigInt(vector.maxCrankTip));
    }
  });

  it("prices the pool's own TWAP and never adopts a spot price outright", () => {
    const { solReserve, tokenReserve, priceLamportsPerUnit: expected } = vectors.twap;
    const price = priceLamportsPerUnit(BigInt(solReserve), BigInt(tokenReserve));
    expect(price).toBe(BigInt(expected));
    const cum = accumulatePrice(0n, price, 10n);
    expect(cum).toBe(BigInt(vectors.twap.cumAfter10Slots));
    const doubled = accumulatePrice(cum, price * 2n, 10n);
    expect(twapAverage(doubled, 20n)).toBe(BigInt(vectors.twap.average20SlotsAt1xThen2x));
  });

  it("normalises a discovery's value by that price, rounding down", () => {
    for (const vector of vectors.value) {
      const price = BigInt(vector.priceLamportsPerUnit);
      if (vector.direction === "unitsToLamports") {
        expect(lamportsForUnits(BigInt(vector.units!), price)).toBe(BigInt(vector.lamports!));
      } else {
        expect(unitsForLamports(BigInt(vector.lamports!), price)).toBe(BigInt(vector.units!));
      }
    }
  });

  it("costs one launch exactly what the creator pays", () => {
    const rent = launchRentLamports();
    const rustCoin = CONTRACT.accounts.find((account) => account.name === "Coin");
    const rustMint = CONTRACT.accounts.find((account) => account.name === "Mint");
    expect(rustCoin).toEqual({ name: "Coin", size: 464, rentLamports: 4_120_320 });
    expect(rustMint).toEqual({ name: "Mint", size: 438, rentLamports: 3_939_360 });
    expect(rent.coin).toBe(BigInt(rustCoin!.rentLamports));
    expect(rent.coin).toBe(4_120_320n);
    expect(rent.mint).toBe(BigInt(rustMint!.rentLamports));
    expect(rent.mint).toBe(3_939_360n);
    expect(rent.total).toBe(10_098_960n);
    expect(rent.mint).toBe(BigInt(vectors.launchRent.mintLamports));
    expect(rent.coin).toBe(BigInt(vectors.launchRent.coinLamports));
    expect(rent.vault).toBe(BigInt(vectors.launchRent.vaultLamports));
    expect(rent.total).toBe(BigInt(vectors.launchRent.totalLamports));
    // About a cent of SOL, which is the product constraint the whole design bends to.
    expect(rent.total).toBeLessThan(10_500_000n);
  });

  it("spreads one epoch of the Mining Reserve over its blocks", () => {
    const mining = vectors.mining;
    expect(
      initialBlockReward(
        BigInt(mining.reserveRemaining),
        mining.epochLength,
        mining.blockInterval,
        BigInt(mining.minimumReward),
      ),
    ).toBe(BigInt(mining.initialBlockReward));
    expect(mulBpsV2(BigInt(mining.curveTokenInventory), mining.curveMiningBps)).toBe(
      BigInt(mining.curveMiningCap),
    );
    expect(virtualSolReserve(BigInt("85000000000"))).toBe(BigInt(mining.virtualSolReserve));
    expect(DEFAULT_VIRTUAL_SOL_BPS).toBe(mining.virtualSolBps);
    expect(PRICE_SCALE).toBe(1_000_000_000_000n);
    expect(SLOTS_PER_SECOND).toBe(2n);
  });
});

/**
 * The quote mirror (CCR-F4), which used to live in src/onchain/quotes.ts. It is only useful if it
 * is exact, so these pin the arithmetic against hand-computed values with the same integer widths
 * and the same truncation the Rust does. A change here is a change to what a form will sign.
 */
describe("the trade quotes", () => {
  const curveCoin = (overrides: Partial<DecodedCoin> = {}) =>
    ({
      tokenReserve: 1_000_000n,
      solReserve: 30_000_000_000n,
      virtualSolReserve: 1_000_000_000n,
      ...overrides,
    }) as DecodedCoin;

  const pool = (overrides: Partial<DecodedLiquidityPool> = {}) =>
    ({
      tokenReserve: 1_000_000n,
      solReserve: 30_000_000_000n,
      ...overrides,
    }) as DecodedLiquidityPool;

  it("truncates mul_bps, so a fee can never round up against the trader", () => {
    // 101 * 50 / 10_000 is 0.505, and the program charges 0.
    expect(mulBps(101n, 50)).toBe(0n);
    expect(mulBps(1_000_000_000n, 50)).toBe(5_000_000n);
    expect(mulBps).toBe(mulBpsV2);
  });

  it("takes the creator and platform shares off the top of a gross amount", () => {
    const fees = splitFees(1_000_000_000n, { creatorFeeBps: 50, platformFeeBps: 50 });
    expect(fees.creatorFee).toBe(5_000_000n);
    expect(fees.platformFee).toBe(5_000_000n);
    expect(fees.totalFee).toBe(10_000_000n);
    expect(fees.net).toBe(990_000_000n);
    expect(fees.net + fees.totalFee).toBe(1_000_000_000n);
  });

  it("charges the trader two fees only: the crank pool comes out of the protocol's bucket", () => {
    // CCR-F2: crank_pool_fee_bps is a ProtocolConfig field carved out of the platform share at
    // sweep time, not a third fee on the trade. A trader's net is the gross minus two shares
    // whatever that field says, and the bucket then splits exactly between crank pool and treasury.
    const fees = splitFees(1_000_000_000n, { creatorFeeBps: 50, platformFeeBps: 50 });
    const bucket = splitPlatformBucket(fees.platformFee, 2_500);
    expect(bucket.crankPool + bucket.treasury).toBe(fees.platformFee);
    expect(fees.net).toBe(1_000_000_000n - fees.totalFee);
  });

  it("prices a curve buy off the virtual reserve and floors the result", () => {
    // 1_000_000 * 1e9 / (30e9 + 1e9 + 1e9) = 31_250 exactly.
    expect(quoteCurveBuy(curveCoin(), 1_000_000_000n)).toBe(31_250n);
    // A non-exact division floors: 1_000_000 * 3 / 32_000_000_003 is 0.09, so it refuses.
    expect(() => quoteCurveBuy(curveCoin(), 3n)).toThrow(QuoteError);
  });

  it("caps a curve sell at the curve's real SOL, never at the virtual reserve", () => {
    // 31e9 * 10_000 / (1_000_000 + 10_000) floors to 306_930_693.
    expect(quoteCurveSell(curveCoin(), 10_000n)).toBe(306_930_693n);
    // A token input large enough to want more than the curve holds is capped at sol_reserve.
    expect(quoteCurveSell(curveCoin(), 1_000_000_000n)).toBe(30_000_000_000n);
  });

  it("refuses a buy that would take the curve's last base unit", () => {
    // token_reserve 1 means every buy either returns 0 or would empty the inventory.
    expect(() => quoteCurveBuy(curveCoin({ tokenReserve: 1n }), 1_000_000_000n)).toThrow(QuoteError);
  });

  it("refuses an exhausted curve and an empty sell side", () => {
    expect(() => quoteCurveBuy(curveCoin({ tokenReserve: 0n }), 1_000_000_000n)).toThrow(QuoteError);
    expect(() => quoteCurveSell(curveCoin({ solReserve: 0n }), 10_000n)).toThrow(QuoteError);
  });

  it("prices a pool buy as x*y / (y + in), floored", () => {
    // 1_000_000 * 1e9 / 31e9 floors to 32_258.
    expect(quotePoolBuy(pool(), 1_000_000_000n)).toBe(32_258n);
  });

  it("prices a pool sell as y*x / (x + in), capped at the pool's SOL", () => {
    // 30e9 * 10_000 / 1_010_000 floors to 297_029_702.
    expect(quotePoolSell(pool(), 10_000n)).toBe(297_029_702n);
    // A pool sell can never reach the pool's whole SOL side, because x / (x + in) is strictly
    // below 1. The program's min() is a belt on top of that, and this is the number it guards.
    expect(quotePoolSell(pool(), 1_000_000_000n)).toBe(29_970_029_970n);
    expect(quotePoolSell(pool(), 1_000_000_000n)).toBeLessThan(30_000_000_000n);
  });

  it("refuses an uninitialised pool rather than quoting a zero", () => {
    expect(() => quotePoolBuy(pool({ tokenReserve: 0n }), 1_000_000_000n)).toThrow(QuoteError);
    expect(() => quotePoolSell(pool({ solReserve: 0n }), 10_000n)).toThrow(QuoteError);
  });

  it("includes the virtual reserve on the curve and not in the pool", () => {
    expect(curveSpotPriceLamportsPerUnit(curveCoin())).toBeCloseTo(31_000, 6);
    expect(poolSpotPriceLamportsPerUnit(pool())).toBeCloseTo(30_000, 6);
  });

  it("returns null rather than a zero when the reserves are not readable", () => {
    expect(curveSpotPriceLamportsPerUnit(curveCoin({ tokenReserve: 0n }))).toBeNull();
    expect(poolSpotPriceLamportsPerUnit(pool({ solReserve: 0n }))).toBeNull();
  });

  it("keeps the launch split defaults in one place", () => {
    // CCR-F5: the form reads these rather than restating them, and the split they produce is the
    // one splitSupply hands to a launch.
    expect(DEFAULT_RESERVE_BPS).toBe(500);
    expect(DEFAULT_DISCOVERY_RESERVE_BPS).toBe(50);
    const split = splitSupply(1_000_000_000n, DEFAULT_RESERVE_BPS, DEFAULT_DISCOVERY_RESERVE_BPS);
    expect(split.reserve).toBe(50_000_000n);
    expect(split.discovery).toBe(5_000_000n);
    expect(split.reserve + split.discovery + split.curve).toBe(1_000_000_000n);
  });
});
