import { describe, expect, it } from "vitest";
import { DIGGO_CONFIG } from "./config";
import {
  CURVE_MINING_MIN_BLOCKS,
  activeMineBudget,
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
  isCurveMiningCapReached,
  isCurveMiningDisabled,
  isCurveMiningOpen,
  type CurveMiningState,
} from "./curve";
import {
  DEFAULT_CURVE_MINING_BPS,
  DEFAULT_CURVE_MINING_RUNWAY_DAYS,
  MAX_CURVE_MINING_BPS,
  MAX_CURVE_MINING_RUNWAY_DAYS,
  type DecodedLaunchMarket,
} from "./program";

/** A 950,000,000 base-unit curve inventory, i.e. 950 whole tokens at 6 decimals. */
const INVENTORY = 950_000_000n;
/** 5% of it, which is the launch default. */
const CAP = 47_500_000n;
/** 30 days of 300-second blocks. */
const RUNWAY_BLOCKS = 8_640n;
/** ceil(47,500,000 / 8,640). */
const RATE = 5_498n;

function market(overrides: Partial<DecodedLaunchMarket> = {}): DecodedLaunchMarket {
  return {
    mine: "Mine1111111111111111111111111111111111111111" as DecodedLaunchMarket["mine"],
    tokenReserve: INVENTORY,
    solReserve: 30_000_000_000n,
    virtualSolReserve: 5_000_000_000n,
    graduationTarget: 85_000_000_000n,
    graduated: false,
    creatorFeeClaimable: 0n,
    platformFeeClaimable: 0n,
    creatorFeeBps: 50,
    platformFeeBps: 50,
    bump: 255,
    version: 2,
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
