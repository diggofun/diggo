/**
 * Graduation trigger and venue-priced trade indexing (spec 36, docs/ONCHAIN.md §6).
 *
 * The indexing loop is what actually graduates a market: nothing else calls graduate_market, so
 * these tests drive processQueueEvent directly against a real (in-memory SQLite) D1 and assert
 * that exactly the markets that need it are graduated, that the call is idempotent, that a keeper
 * failure is counted and retried on the next pass instead of failing the pass, and that a fill is
 * indexed at the price of the venue that backed it.
 *
 * Graduation is deliberately not gated on the worker's own model of the mine's ledger: a mine the
 * program never walks (no power to divide a block reward by) looks permanently behind to any
 * cursor arithmetic, and gating on that deferred every tick and never formed a pool. The program's
 * SyncBehind answer is the retryable authority instead, so a disagreement can cost a transaction
 * but never a market that never graduates.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IndexingEvent, MarketTrade, TokenSummary } from "../../shared/types";
import type { RuntimeEnv } from "../env";
import type { ChainSyncedToken } from "../chain";
import { keeperGraduateMarket } from "../keeper";
import { keeperAdvanceMine } from "../keeper";
import { readTokenFromChain, syncTokenWithVenue } from "../chain";
import { recordPriceSample } from "../discovery";
import { metric } from "../telemetry";
import { getSolUsd, refreshExternalQuotesSafely } from "../oracle";
import { processQueueEvent } from "../indexing";
import { createTestHarness, seedToken, type TestHarness } from "./d1-sqlite";

// Plain factories rather than partial re-exports of the real modules: this job is the unit under
// test, and everything it reaches out to (RPC reads, the keeper, the oracle, the roll path, the
// risk gate) is a collaborator whose *calls* are what these tests assert.
vi.mock("../keeper", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../keeper")>();
  return {
    keeperAdvanceMine: vi.fn(),
    keeperGraduateMarket: vi.fn(),
    keeperClaimDiscovery: vi.fn(),
    keeperDiscoveryReceiptExists: vi.fn(),
    keeperSyncCrewPower: vi.fn(),
    // The real matcher, not a stub: how the loop reacts to the program's own SyncBehind answer is
    // part of what these tests exercise.
    isSyncBehindError: actual.isSyncBehindError,
  };
});
vi.mock("../chain", () => ({
  syncTokenWithVenue: vi.fn(),
  readTokenFromChain: vi.fn(),
}));
vi.mock("../discovery", () => ({
  recordPriceSample: vi.fn(),
  recoverEligibleDiscovery: vi.fn(),
}));
vi.mock("../oracle", () => ({
  getSolUsd: vi.fn(),
  refreshExternalQuotesSafely: vi.fn(),
}));
vi.mock("../telemetry", () => ({ metric: vi.fn() }));
vi.mock("../mining", () => ({ settleRewardClaim: vi.fn() }));
vi.mock("../player", () => ({ crewLevelsOf: vi.fn() }));

const MINT = "4rT8mQ2vN6kY3cW9pF1sJ7aB5eH8uL2xG6zP9diggo";
const START = 1_800_000_000;

const graduate = vi.mocked(keeperGraduateMarket);
const advanceMine = vi.mocked(keeperAdvanceMine);
const syncWithVenue = vi.mocked(syncTokenWithVenue);
const readChainToken = vi.mocked(readTokenFromChain);
const recordSample = vi.mocked(recordPriceSample);
const countMetric = vi.mocked(metric);
const solUsdQuote = vi.mocked(getSolUsd);

let h: TestHarness;
let env: RuntimeEnv;
let appliedTrades: MarketTrade[];

beforeEach(() => {
  h = createTestHarness();
  appliedTrades = [];
  env = {
    ...h.env,
    MARKETS: {
      getByName: () => ({
        applyTrade: async (trade: MarketTrade) => {
          appliedTrades.push(trade);
        },
      }),
    },
  } as unknown as RuntimeEnv;

  vi.clearAllMocks();
  graduate.mockResolvedValue(null);
  // By default the mine's ledger is current, so the catch-up is a read and nothing more.
  advanceMine.mockResolvedValue({ mint: MINT, behindSegments: 0, signatures: [], caughtUp: true });
  recordSample.mockResolvedValue(undefined);
  vi.mocked(refreshExternalQuotesSafely).mockResolvedValue(undefined);
  solUsdQuote.mockResolvedValue({
    priceUsd: 150,
    source: "pyth-sol",
    observedAt: START,
    fetchedAt: START,
    cached: false,
    confidence: 0.9,
    stale: false,
    fromOracle: true,
    sources: [{ source: "pyth-sol", priceUsd: 150, observedAt: START }],
  });
  syncWithVenue.mockResolvedValue({ token: tokenSummary(), chain: chainToken() });
  readChainToken.mockRejectedValue(new Error("no rpc in this test"));
});

afterEach(() => {
  h.d1.close();
});

function tokenSummary(overrides: Partial<TokenSummary> = {}): TokenSummary {
  return {
    mint: MINT,
    slug: "stone-4rt8",
    name: "Stone Coin",
    symbol: "STONE",
    description: "",
    creator: "creator",
    imageUrl: null,
    status: "MINING_ACTIVE",
    priceSol: 5e-5,
    priceUsd: 0.0075,
    change24h: null,
    volume24hUsd: 0,
    trades24h: 0,
    curveMining: {
      open: false,
      onCurve: false,
      cap: 0,
      mined: 0,
      remaining: 0,
      progress: 0,
      blockReward: 0,
      unpaid: 0,
    },
    sellCapacity: { sol: 0, tokens: 0 },
    marketCapUsd: 7_500_000,
    reserveRemaining: 500_000_000,
    reserveTotal: 1_000_000_000,
    rewardPerBlock: 1_000,
    networkPower: 250_000,
    nextBlockAt: START + 60,
    nextEpochAt: START + 86_400,
    createdAt: START,
    decimals: 6,
    ...overrides,
  };
}

function chainToken(overrides: Partial<ChainSyncedToken> = {}): ChainSyncedToken {
  return {
    mint: MINT,
    name: "Stone Coin",
    symbol: "STONE",
    creator: "creator",
    status: "MINING_ACTIVE",
    priceSol: 5e-5,
    priceUsd: 0.0075,
    marketCapUsd: 7_500_000,
    reserveRemaining: 500_000_000,
    reserveTotal: 1_000_000_000,
    rewardPerBlock: 1_000,
    networkPower: 250_000,
    nextBlockAt: START + 60,
    nextEpochAt: START + 86_400,
    decimals: 6,
    discoveryReserveRemaining: 5_000_000,
    discoveryReserveTotal: 10_000_000,
    discoveryEpochBudget: 1_000,
    discoveryEpochSpent: 0,
    discoveryEpochEndsAt: START + 86_400,
    discoveryPaused: false,
    liquidityUsd: 6_750,
    venue: "pool",
    liquidityLamports: 45_000_000_000n,
    graduationReady: false,
    mintAuthorityRevoked: true,
    freezeAuthorityRevoked: true,
    liquidityLocked: true,
    change24h: null,
    change24hAt: 0,
    volume24hUsd: 0,
    trades24h: 0,
    curveMining: {
      open: false,
      onCurve: false,
      cap: 0,
      mined: 0,
      remaining: 0,
      progress: 0,
      blockReward: 0,
      unpaid: 0,
    },
    sellCapacity: { sol: 0, tokens: 0 },
    ...overrides,
  };
}

function epochSync(): IndexingEvent {
  return { type: "epoch_sync", mint: MINT, timestamp: START };
}

/**
 * The program's own refusal, in the shape a keeper call really fails with: anchor logs the error
 * name and the numeric code, and the transaction error carries the code in its message too.
 */
function syncBehindRefusal(): Error {
  const error = new Error(
    "Transaction simulation failed: Error processing Instruction 0: custom program error: 0x179c",
  );
  (error as { logs?: string[] }).logs = [
    "Program log: AnchorError caused by account: mine. Error Code: SyncBehind. Error Number: 6044. Error Message: This mine is behind and must be advanced with advance_mine before its positions can settle.",
  ];
  return error;
}

function tradeEvent(trade: Partial<MarketTrade> = {}): IndexingEvent {
  return {
    type: "trade",
    mint: MINT,
    trade: {
      signature: "5".repeat(64),
      side: "buy",
      priceSol: 0,
      priceUsd: 0,
      amount: 1_000,
      timestamp: START,
      ...trade,
    },
  };
}

function metricCalls(name: string): number {
  return countMetric.mock.calls.filter((call) => call[1] === name).length;
}

describe("graduation from the indexing loop", () => {
  it("catches the mine's on-chain ledger up before reading it", async () => {
    advanceMine.mockResolvedValue({
      mint: MINT,
      behindSegments: 400,
      signatures: ["advance-1", "advance-2", "advance-3", "advance-4"],
      caughtUp: false,
    });

    await processQueueEvent(epochSync(), env);

    // The permissionless advance_mine call is what unblocks a player's own claim_rewards after a
    // mine sat idle, so the sync pass has to make it - and count the calls it made.
    expect(advanceMine).toHaveBeenCalledWith(env, MINT);
    expect(metricCalls("keeper.mine_advanced")).toBe(1);
    expect(recordSample).toHaveBeenCalledTimes(1);
  });

  it("keeps indexing when the ledger catch-up fails", async () => {
    advanceMine.mockRejectedValue(new Error("rpc unavailable"));

    await processQueueEvent(epochSync(), env);

    // A catch-up that could not be sent is not a failed sync pass: the price sample and the rest of
    // the pass still happened.
    expect(recordSample).toHaveBeenCalledTimes(1);
    expect(metricCalls("keeper.mine_advanced")).toBe(0);
  });

  it("graduates a zero-power market that reached its SOL target, instead of deferring for ever", async () => {
    // The regression this pins: the loop refused to ask while its own model said the mine was
    // behind, and a mine with no power is one the program never walks - advance_mine answers
    // CaughtUp without moving the cursor - so the worker's model reported it tens of thousands of
    // segments behind on every single tick. Graduation was deferred for ever and the pool never
    // formed. The program is the authority on whether a ledger is caught up, so the call is made
    // and its answer is what defers.
    advanceMine.mockResolvedValue({
      mint: MINT,
      behindSegments: 80_000,
      signatures: [],
      caughtUp: false,
    });
    syncWithVenue.mockResolvedValue({
      token: tokenSummary(),
      chain: chainToken({ venue: "curve", graduationReady: true }),
    });
    graduate.mockResolvedValue("5KeeperSignature");

    await processQueueEvent(epochSync(), env);

    expect(graduate).toHaveBeenCalledTimes(1);
    expect(metricCalls("chain.market_graduated")).toBe(1);
    expect(metricCalls("chain.graduation_deferred")).toBe(0);
    // And the rest of the pass is unaffected: the catch-up and the price sample still happened.
    expect(recordSample).toHaveBeenCalledTimes(1);
    expect(syncWithVenue).toHaveBeenCalledTimes(2);
  });

  it("treats the program's SyncBehind answer as the retryable deferral, and retries next tick", async () => {
    syncWithVenue.mockResolvedValue({
      token: tokenSummary(),
      chain: chainToken({ venue: "curve", graduationReady: true }),
    });
    // graduate_market walks the mine to the present under the curve phase before it ends that
    // phase, and refuses with SyncBehind while the mine is further behind than one bounded walk
    // can cover. That refusal is retryable: this tick already advanced the mine as far as its
    // budget allowed, so the next one continues from there.
    graduate.mockRejectedValue(syncBehindRefusal());

    await expect(processQueueEvent(epochSync(), env)).resolves.toBeUndefined();

    expect(metricCalls("chain.graduation_deferred")).toBe(1);
    expect(metricCalls("chain.graduation_failed")).toBe(0);
    expect(metricCalls("chain.market_graduated")).toBe(0);
    // Not a queue retry: the price sample this pass already wrote is not idempotent.
    expect(recordSample).toHaveBeenCalledTimes(1);

    graduate.mockResolvedValue("5KeeperSignature");
    await processQueueEvent(epochSync(), env);
    expect(metricCalls("chain.market_graduated")).toBe(1);
  });

  it("keeps asking while the mine is behind, and graduates on the pass that catches it up", async () => {
    advanceMine.mockResolvedValue({
      mint: MINT,
      behindSegments: 400,
      signatures: ["advance-1"],
      caughtUp: false,
    });
    syncWithVenue.mockResolvedValue({
      token: tokenSummary(),
      chain: chainToken({ venue: "curve", graduationReady: true }),
    });

    // The mine is still behind, so the program refuses and the keeper's own no-op answer stands
    // for that refusal here: the pass stays alive and the next one asks again.
    await processQueueEvent(epochSync(), env);
    expect(graduate).toHaveBeenCalledTimes(1);
    expect(metricCalls("chain.market_graduated")).toBe(0);

    advanceMine.mockResolvedValue({
      mint: MINT,
      behindSegments: 400,
      signatures: [],
      caughtUp: true,
    });
    graduate.mockResolvedValue("5KeeperSignature");

    await processQueueEvent(epochSync(), env);
    expect(graduate).toHaveBeenCalledTimes(2);
    expect(metricCalls("chain.market_graduated")).toBe(1);
  });

  it("re-reads the token row once graduation has landed", async () => {
    syncWithVenue.mockResolvedValue({
      token: tokenSummary({ status: "LAUNCHING" }),
      chain: chainToken({ venue: "curve", status: "LAUNCHING", graduationReady: true }),
    });
    graduate.mockResolvedValue("5KeeperSignature");

    await processQueueEvent(epochSync(), env);

    // The first read describes the curve, and the row it wrote carries that venue, those reserves
    // and that price. Graduation has just moved all of it into the pool, so the row is rewritten
    // from a read taken after it - otherwise the API serves a curve price for up to five minutes
    // after the pool took the liquidity.
    expect(syncWithVenue).toHaveBeenCalledTimes(2);
    expect(syncWithVenue.mock.calls[1][1]).toBe(MINT);
    expect(syncWithVenue.mock.invocationCallOrder[1]).toBeGreaterThan(
      graduate.mock.invocationCallOrder[0],
    );
  });

  it("does not re-read the row when nothing graduated", async () => {
    syncWithVenue.mockResolvedValue({
      token: tokenSummary(),
      chain: chainToken({ venue: "curve", graduationReady: true }),
    });
    // The keeper's own no-op: there was nothing to graduate.
    graduate.mockResolvedValue(null);

    await processQueueEvent(epochSync(), env);

    expect(graduate).toHaveBeenCalledTimes(1);
    expect(syncWithVenue).toHaveBeenCalledTimes(1);
  });

  it("keeps the pass alive when the post-graduation re-read fails", async () => {
    syncWithVenue
      .mockResolvedValueOnce({
        token: tokenSummary(),
        chain: chainToken({ venue: "curve", graduationReady: true }),
      })
      .mockRejectedValueOnce(new Error("rpc unavailable"));
    graduate.mockResolvedValue("5KeeperSignature");

    // The fresh row is a bonus, not the point of the pass: a read that fails costs the row and
    // nothing else, and the next pass re-reads anyway.
    await expect(processQueueEvent(epochSync(), env)).resolves.toBeUndefined();
    expect(metricCalls("chain.market_graduated")).toBe(1);
  });

  it("leaves a market that is short of its target alone", async () => {
    await processQueueEvent(epochSync(), env);
    expect(graduate).not.toHaveBeenCalled();
    expect(metricCalls("chain.market_graduated")).toBe(0);
    expect(metricCalls("chain.graduation_noop")).toBe(0);
    expect(recordSample).toHaveBeenCalledTimes(1);
  });

  it("graduates a market that has reached its target and counts it", async () => {
    graduate.mockResolvedValue("5KeeperSignature");
    syncWithVenue.mockResolvedValue({
      token: tokenSummary({ status: "LAUNCHING" }),
      chain: chainToken({ venue: "curve", status: "LAUNCHING", graduationReady: true }),
    });

    await processQueueEvent(epochSync(), env);

    expect(graduate).toHaveBeenCalledTimes(1);
    expect(graduate.mock.calls[0][1]).toBe(MINT);
    expect(metricCalls("chain.market_graduated")).toBe(1);
    expect(metricCalls("chain.graduation_failed")).toBe(0);
  });

  it("asks only after the pass has recorded its own work", async () => {
    graduate.mockResolvedValue("5KeeperSignature");
    syncWithVenue.mockResolvedValue({
      token: tokenSummary(),
      chain: chainToken({ graduationReady: true }),
    });

    await processQueueEvent(epochSync(), env);

    expect(recordSample).toHaveBeenCalledTimes(1);
    expect(recordSample.mock.invocationCallOrder[0]).toBeLessThan(
      graduate.mock.invocationCallOrder[0],
    );
  });

  it("treats a keeper no-op as a no-op, and stays idempotent across passes", async () => {
    // The keeper returns null for every state it has nothing to do in: no market, already
    // graduated, short of target, or a pool that already exists. None of those is an error.
    syncWithVenue.mockResolvedValue({
      token: tokenSummary(),
      chain: chainToken({ graduationReady: true }),
    });

    await processQueueEvent(epochSync(), env);
    await processQueueEvent(epochSync(), env);

    expect(graduate).toHaveBeenCalledTimes(2);
    expect(metricCalls("chain.graduation_noop")).toBe(2);
    expect(metricCalls("chain.market_graduated")).toBe(0);
    expect(metricCalls("chain.graduation_failed")).toBe(0);
  });

  it("counts a keeper failure, keeps the pass alive and retries on the next one", async () => {
    graduate.mockRejectedValue(new Error("keeper transaction confirmation timed out"));
    syncWithVenue.mockResolvedValue({
      token: tokenSummary(),
      chain: chainToken({ graduationReady: true }),
    });

    await expect(processQueueEvent(epochSync(), env)).resolves.toBeUndefined();
    expect(metricCalls("chain.graduation_failed")).toBe(1);
    expect(metricCalls("chain.market_graduated")).toBe(0);
    // The price sample this pass had already written is not idempotent, so the failure must not
    // throw the job into a queue retry; the next scheduled pass is the retry.
    expect(recordSample).toHaveBeenCalledTimes(1);

    graduate.mockResolvedValue("5KeeperSignature");
    await processQueueEvent(epochSync(), env);
    expect(metricCalls("chain.market_graduated")).toBe(1);
  });
});

describe("trade indexing by venue", () => {
  it("indexes a fill at the pool's price instead of the event's stale curve price", async () => {
    seedToken(h.db, { mint: MINT });
    readChainToken.mockResolvedValue(chainToken({ venue: "pool", priceSol: 5e-5, priceUsd: 0.0075 }));

    await processQueueEvent(tradeEvent({ priceSol: 0, priceUsd: 0 }), env);

    const trade = h.db
      .prepare("SELECT price_sol, price_usd FROM trades WHERE mint = ?1")
      .get(MINT) as { price_sol: number; price_usd: number };
    expect(trade.price_sol).toBeCloseTo(5e-5, 12);
    expect(trade.price_usd).toBeCloseTo(0.0075, 12);

    const token = h.db.prepare("SELECT price_sol FROM tokens WHERE mint = ?1").get(MINT) as {
      price_sol: number;
    };
    expect(token.price_sol).toBeCloseTo(5e-5, 12);

    // The Durable Object is told the same price the row carries.
    expect(appliedTrades).toHaveLength(1);
    expect(appliedTrades[0].priceSol).toBeCloseTo(5e-5, 12);
  });

  it("still indexes the fill at its event price when the venue cannot be read", async () => {
    seedToken(h.db, { mint: MINT });

    await processQueueEvent(tradeEvent({ priceSol: 0.002, priceUsd: 0.3 }), env);

    const trade = h.db
      .prepare("SELECT price_sol FROM trades WHERE mint = ?1")
      .get(MINT) as { price_sol: number };
    expect(trade.price_sol).toBeCloseTo(0.002, 12);
  });
});
