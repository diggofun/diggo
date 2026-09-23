/**
 * Venue routing and pool indexing regression tests (spec 36, docs/ONCHAIN.md §6).
 *
 * A graduated market keeps its LaunchMarket account but every reserve in it is zero — the real
 * liquidity is in the program-owned pool — so every read path that prices a token, quotes a trade
 * or indexes a fill has to pick the venue first. These tests pin the three seams that decide it:
 * the swap form's router and quotes (src/solanaProgram.ts, which is imported here because this is
 * the vitest project the frontend and worker share), the chain read that prices a token
 * (worker/chain.ts) and the trade index (worker/indexing.ts).
 *
 * The quotes are asserted against the shared mirrors of the program's own math composed exactly
 * the way lib.rs composes them — fees off the top of a buy, out of the gross of a sell — so a
 * mismatch between the number the form shows and the floor the chain enforces fails here.
 */
import { describe, expect, it } from "vitest";
import { type Address } from "@solana/kit";
import { PublicKey } from "@solana/web3.js";
import {
  bondingCurveSpotPriceLamports,
  buildBuyInstruction,
  buildPoolBuyInstruction,
  buildPoolSellInstruction,
  buildSellInstruction,
  netAfterFees,
  poolQuoteBuy,
  poolQuoteSell,
  poolSpotPriceLamports,
  quoteBuy,
  quoteSell,
  type DecodedLaunchMarket,
  type DecodedLiquidityPool,
  type DecodedMine,
  type MineAddresses,
  type PoolAddresses,
} from "../../shared/program";
import {
  DEFAULT_SLIPPAGE_BPS,
  buildSwapInstruction,
  quoteSwap,
  resolveSwapVenue,
  venueSpotPriceSol,
} from "../../src/solanaProgram";
import {
  buildSyncedToken,
  needsGraduation,
  venueLiquidityLamports,
  venueSpotPriceLamports,
} from "../chain";
import type { MarketVenue } from "../keeper";
import { priceTrade } from "../indexing";

const LAMPORTS = 1_000_000_000n;
const DECIMALS = 6;
const RAW = 10n ** BigInt(DECIMALS);
/** Every mine's fee schedule in these tests: 1% to the creator, 0.5% to the protocol. */
const CREATOR_FEE_BPS = 100;
const PLATFORM_FEE_BPS = 50;

/** Distinct, well-formed 32-byte addresses; these are opaque labels, never derived from. */
const addr = (fill: number): Address => new PublicKey(new Uint8Array(32).fill(fill)).toBase58() as Address;

const MINT = addr(1);
const TRADER = addr(2);
const TRADER_TOKENS = addr(3);
const PROGRAM = addr(4);

const MINE_ADDRESSES: MineAddresses = {
  mint: MINT,
  mine: addr(5),
  market: addr(6),
  marketVault: addr(7),
  reserveVault: addr(8),
  discoveryVault: addr(9),
};

const POOL_ADDRESSES: PoolAddresses = {
  mint: MINT,
  pool: addr(10),
  poolTokenVault: addr(11),
  poolSolVault: addr(12),
};

function market(overrides: Partial<DecodedLaunchMarket> = {}): DecodedLaunchMarket {
  return {
    mine: MINE_ADDRESSES.mine,
    tokenReserve: 1_000_000n * RAW,
    solReserve: 30n * LAMPORTS,
    virtualSolReserve: 5n * LAMPORTS,
    graduationTarget: 85n * LAMPORTS,
    graduated: false,
    creatorFeeClaimable: 0n,
    platformFeeClaimable: 0n,
    creatorFeeBps: CREATOR_FEE_BPS,
    platformFeeBps: PLATFORM_FEE_BPS,
    bump: 255,
    version: 1,
    ...overrides,
  };
}

/** A market that has graduated: the flag is set and both curve reserves are zero by design. */
function graduatedMarket(overrides: Partial<DecodedLaunchMarket> = {}): DecodedLaunchMarket {
  return market({ graduated: true, tokenReserve: 0n, solReserve: 0n, ...overrides });
}

function liquidityPool(overrides: Partial<DecodedLiquidityPool> = {}): DecodedLiquidityPool {
  return {
    mine: MINE_ADDRESSES.mine,
    mint: MINT,
    tokenVault: POOL_ADDRESSES.poolTokenVault,
    solVault: POOL_ADDRESSES.poolSolVault,
    tokenReserve: 900_000n * RAW,
    solReserve: 45n * LAMPORTS,
    graduatedAt: 1_800_000_000n,
    bump: 254,
    ...overrides,
  };
}

function venue(pool: DecodedLiquidityPool | null, overrides: Partial<DecodedLaunchMarket> = {}): MarketVenue {
  const decoded = overrides.graduated ? graduatedMarket(overrides) : market(overrides);
  return { graduated: decoded.graduated, market: decoded, pool };
}

function mine(overrides: Partial<DecodedMine> = {}): DecodedMine {
  return {
    mint: MINT,
    creator: TRADER,
    reserveVault: MINE_ADDRESSES.reserveVault,
    discoveryVault: MINE_ADDRESSES.discoveryVault,
    marketVault: MINE_ADDRESSES.marketVault,
    feeVault: addr(13),
    totalSupply: 1_000_000_000n * RAW,
    remainingReserve: 500_000_000n * RAW,
    remainingDiscoveryReserve: 5_000_000n * RAW,
    cumulativeDistributed: 0n,
    totalPower: 250_000n,
    rewardIndex: 0n,
    currentBlockReward: 1_000n * RAW,
    blockInterval: 60n,
    nextBlockAt: 1_800_000_060n,
    epoch: 3n,
    epochLength: 86_400n,
    epochEndsAt: 1_800_086_400n,
    reductionBps: 500,
    minimumReward: 10n * RAW,
    status: "MiningActive",
    name: "Stone Coin",
    symbol: "STONE",
    uri: "",
    discoveryReserveTotal: 10_000_000n * RAW,
    discoveryEpochBudget: 1_000n * RAW,
    discoveryEpochSpent: 0n,
    discoveryEpochEndsAt: 1_800_086_400n,
    discoveryPaused: false,
    bump: 253,
    version: 1,
    ...overrides,
  };
}

describe("swap venue detection", () => {
  it("follows the market's own graduated flag", () => {
    expect(resolveSwapVenue(market())).toBe("curve");
    expect(resolveSwapVenue(graduatedMarket())).toBe("pool");
  });

  it("routes a graduated market to pool_buy, matching the shared mirror instruction for instruction", () => {
    const built = buildSwapInstruction({
      programAddress: PROGRAM,
      trader: TRADER,
      traderTokens: TRADER_TOKENS,
      mine: MINE_ADDRESSES,
      pool: POOL_ADDRESSES,
      venue: "pool",
      side: "buy",
      amountRaw: 2n * LAMPORTS,
      minOutRaw: 123n,
    });
    const expected = buildPoolBuyInstruction({
      programAddress: PROGRAM,
      buyer: TRADER,
      buyerTokens: TRADER_TOKENS,
      mine: MINE_ADDRESSES.mine,
      market: MINE_ADDRESSES.market,
      mint: MINT,
      pool: POOL_ADDRESSES.pool,
      tokenVault: POOL_ADDRESSES.poolTokenVault,
      solVault: POOL_ADDRESSES.poolSolVault,
      solIn: 2n * LAMPORTS,
      minTokensOut: 123n,
    });
    expect(built).toEqual(expected);
    // And it is emphatically not the curve instruction the same call used to build.
    expect(built.data).not.toEqual(
      buildBuyInstruction({
        programAddress: PROGRAM,
        buyer: TRADER,
        buyerTokens: TRADER_TOKENS,
        solIn: 2n * LAMPORTS,
        minTokensOut: 123n,
        ...MINE_ADDRESSES,
      }).data,
    );
  });

  it("routes a graduated sell to pool_sell and an ungraduated one to the curve's sell", () => {
    const poolSell = buildSwapInstruction({
      programAddress: PROGRAM,
      trader: TRADER,
      traderTokens: TRADER_TOKENS,
      mine: MINE_ADDRESSES,
      pool: POOL_ADDRESSES,
      venue: "pool",
      side: "sell",
      amountRaw: 7n * RAW,
      minOutRaw: 456n,
    });
    expect(poolSell).toEqual(
      buildPoolSellInstruction({
        programAddress: PROGRAM,
        seller: TRADER,
        sellerTokens: TRADER_TOKENS,
        mine: MINE_ADDRESSES.mine,
        market: MINE_ADDRESSES.market,
        mint: MINT,
        pool: POOL_ADDRESSES.pool,
        tokenVault: POOL_ADDRESSES.poolTokenVault,
        solVault: POOL_ADDRESSES.poolSolVault,
        tokensIn: 7n * RAW,
        minSolOut: 456n,
      }),
    );

    const curveSell = buildSwapInstruction({
      programAddress: PROGRAM,
      trader: TRADER,
      traderTokens: TRADER_TOKENS,
      mine: MINE_ADDRESSES,
      pool: null,
      venue: "curve",
      side: "sell",
      amountRaw: 7n * RAW,
      minOutRaw: 456n,
    });
    expect(curveSell).toEqual(
      buildSellInstruction({
        programAddress: PROGRAM,
        seller: TRADER,
        sellerTokens: TRADER_TOKENS,
        tokensIn: 7n * RAW,
        minSolOut: 456n,
        ...MINE_ADDRESSES,
      }),
    );
  });

  it("refuses to build a pool trade without the pool's own addresses", () => {
    expect(() =>
      buildSwapInstruction({
        programAddress: PROGRAM,
        trader: TRADER,
        traderTokens: TRADER_TOKENS,
        mine: MINE_ADDRESSES,
        pool: null,
        venue: "pool",
        side: "buy",
        amountRaw: LAMPORTS,
        minOutRaw: 0n,
      }),
    ).toThrow(/pool addresses/);
  });

  it("prices a graduated market from the pool and reports nothing when the pool was not read", () => {
    const read = { market: graduatedMarket(), pool: liquidityPool() };
    expect(venueSpotPriceSol(read, DECIMALS)).toBeCloseTo(5e-5, 12);
    expect(venueSpotPriceSol({ market: graduatedMarket(), pool: null }, DECIMALS)).toBeNull();
  });
});

describe("quote parity with the program's own math", () => {
  it("takes the program's fees off the top of a pool buy", () => {
    const decoded = graduatedMarket();
    const locked = liquidityPool();
    const solIn = 3n * LAMPORTS;
    const quote = quoteSwap({ market: decoded, pool: locked }, "buy", solIn);

    const { net, creatorFee, platformFee } = netAfterFees(solIn, CREATOR_FEE_BPS, PLATFORM_FEE_BPS);
    expect(quote).not.toBeNull();
    expect(quote!.venue).toBe("pool");
    expect(quote!.inRaw).toBe(solIn);
    // lib.rs: pool_quote_buy(pool.token_reserve, pool.sol_reserve, net_after_fees(sol_in).net)
    expect(quote!.outRaw).toEqual(poolQuoteBuy(locked, net));
    expect(quote!.feeRaw).toEqual(creatorFee + platformFee);
    expect(quote!.creatorFeeRaw).toEqual(creatorFee);
    expect(quote!.platformFeeRaw).toEqual(platformFee);
    expect(net).toBeLessThan(solIn);
  });

  it("deducts the program's fees from the gross output of a pool sell", () => {
    const decoded = graduatedMarket();
    const locked = liquidityPool();
    const tokensIn = 12_000n * RAW;
    const quote = quoteSwap({ market: decoded, pool: locked }, "sell", tokensIn);

    const gross = poolQuoteSell(locked, tokensIn);
    const { net, creatorFee, platformFee } = netAfterFees(gross, CREATOR_FEE_BPS, PLATFORM_FEE_BPS);
    expect(quote!.outRaw).toEqual(net);
    expect(quote!.outRaw).toBeLessThan(gross);
    expect(quote!.feeRaw).toEqual(creatorFee + platformFee);
    expect(quote!.minOutRaw).toEqual((net * (10_000n - BigInt(DEFAULT_SLIPPAGE_BPS))) / 10_000n);
  });

  it("matches the curve mirrors before graduation, with the same fee order", () => {
    const decoded = market();
    const solIn = 2n * LAMPORTS;
    const buy = quoteSwap({ market: decoded, pool: null }, "buy", solIn);
    const buyFees = netAfterFees(solIn, CREATOR_FEE_BPS, PLATFORM_FEE_BPS);
    expect(buy!.venue).toBe("curve");
    expect(buy!.outRaw).toEqual(quoteBuy(decoded, buyFees.net));

    const tokensIn = 40_000n * RAW;
    const sell = quoteSwap({ market: decoded, pool: null }, "sell", tokensIn);
    const sellFees = netAfterFees(quoteSell(decoded, tokensIn), CREATOR_FEE_BPS, PLATFORM_FEE_BPS);
    expect(sell!.outRaw).toEqual(sellFees.net);
  });

  it("applies the slippage floor to the output, never to the input", () => {
    const quote = quoteSwap({ market: market(), pool: null }, "buy", 1n * LAMPORTS, 200);
    expect(DEFAULT_SLIPPAGE_BPS).toBe(200);
    expect(quote!.minOutRaw).toBe((quote!.outRaw * 9_800n) / 10_000n);
    expect(quote!.minOutRaw).toBeLessThan(quote!.outRaw);
    expect(quote!.slippageBps).toBe(200);
  });

  it("never quotes an output that could empty a reserve", () => {
    const locked = liquidityPool();
    // A buy of the pool's entire SOL reserve, and then some.
    const hugeBuy = quoteSwap({ market: graduatedMarket(), pool: locked }, "buy", 1_000n * LAMPORTS);
    expect(hugeBuy!.outRaw).toBeGreaterThan(0n);
    expect(hugeBuy!.outRaw).toBeLessThan(locked.tokenReserve);

    const hugeSell = quoteSwap({ market: graduatedMarket(), pool: locked }, "sell", 100_000_000n * RAW);
    expect(hugeSell!.outRaw).toBeGreaterThan(0n);
    // The pool's SOL reserve caps the gross, and the fees come out of that gross.
    expect(hugeSell!.outRaw).toBeLessThan(locked.solReserve);
  });

  it("has no quote for a non-positive amount or an unreadable pool", () => {
    expect(quoteSwap({ market: market(), pool: null }, "buy", 0n)).toBeNull();
    expect(quoteSwap({ market: market(), pool: null }, "buy", -1n)).toBeNull();
    expect(quoteSwap({ market: graduatedMarket(), pool: null }, "buy", LAMPORTS)).toBeNull();
    expect(quoteSwap({ market: graduatedMarket(), pool: null }, "sell", RAW)).toBeNull();
  });
});

describe("indexing a graduated market from its pool", () => {
  const solUsd = 150;

  it("prices the token from the pool, because the market's own reserves are zero", () => {
    const decoded = graduatedMarket();
    const locked = liquidityPool({ tokenReserve: 900_000n * RAW, solReserve: 45n * LAMPORTS });
    const synced = buildSyncedToken({
      mintAddress: MINT,
      mine: mine(),
      venue: { graduated: true, market: decoded, pool: locked },
      mintInfo: { decimals: DECIMALS, mintAuthorityRevoked: true, freezeAuthorityRevoked: true },
      decimals: DECIMALS,
      solUsd,
    });

    // Pricing from the market account alone is exactly the bug this replaces.
    expect(bondingCurveSpotPriceLamports(decoded, DECIMALS)).toBe(0);
    expect(venueSpotPriceLamports({ graduated: true, market: decoded, pool: locked }, DECIMALS)).toBe(
      poolSpotPriceLamports(locked, DECIMALS),
    );
    expect(synced.venue).toBe("pool");
    expect(synced.priceSol).toBeCloseTo(45 / 900_000, 12);
    expect(synced.priceUsd).toBeCloseTo((45 / 900_000) * solUsd, 10);
    // 1,000,000,000 whole tokens at that price.
    expect(synced.marketCapUsd).toBeCloseTo((45 / 900_000) * solUsd * 1_000_000_000, 4);
    expect(synced.marketCapUsd).toBeGreaterThan(0);
  });

  it("reports the pool's liquidity after graduation and the curve's before it", () => {
    const locked = liquidityPool({ solReserve: 45n * LAMPORTS });
    expect(venueLiquidityLamports({ graduated: true, market: graduatedMarket(), pool: locked })).toBe(
      45n * LAMPORTS,
    );
    expect(venueLiquidityLamports(venue(null))).toBe(30n * LAMPORTS);
  });

  it("takes the liquidity it displays from the pool, not the empty market", () => {
    const synced = buildSyncedToken({
      mintAddress: MINT,
      mine: mine(),
      venue: { graduated: true, market: graduatedMarket(), pool: liquidityPool({ solReserve: 45n * LAMPORTS }) },
      mintInfo: { decimals: DECIMALS, mintAuthorityRevoked: false, freezeAuthorityRevoked: false },
      decimals: DECIMALS,
      solUsd,
    });
    expect(synced.liquidityLamports).toBe(45n * LAMPORTS);
    expect(synced.liquidityUsd).toBeCloseTo(45 * solUsd, 6);
    expect(synced.liquidityLocked).toBe(true);
  });

  it("flags exactly the markets that still need graduating", () => {
    const reached = venue(null, { solReserve: 85n * LAMPORTS, graduationTarget: 85n * LAMPORTS });
    expect(needsGraduation(reached)).toBe(true);
    expect(buildSyncedToken({
      mintAddress: MINT,
      mine: mine(),
      venue: reached,
      mintInfo: { decimals: DECIMALS, mintAuthorityRevoked: false, freezeAuthorityRevoked: false },
      decimals: DECIMALS,
      solUsd,
    }).graduationReady).toBe(true);

    // Short of the target, already graduated, and holding a pool all mean "nothing to do".
    expect(needsGraduation(venue(null, { solReserve: 84n * LAMPORTS, graduationTarget: 85n * LAMPORTS }))).toBe(false);
    expect(needsGraduation({ graduated: true, market: graduatedMarket(), pool: liquidityPool() })).toBe(false);
    expect(needsGraduation(venue(liquidityPool(), { solReserve: 200n * LAMPORTS }))).toBe(false);
    // A zero target is not a graduation target.
    expect(needsGraduation(venue(null, { solReserve: 5n * LAMPORTS, graduationTarget: 0n }))).toBe(false);
  });

  it("indexes a fill at the venue's price and keeps the event's own price when the read fails", () => {
    const trade = {
      signature: "5".repeat(64),
      side: "buy" as const,
      priceSol: 0,
      priceUsd: 0,
      amount: 1_000,
      timestamp: 1_800_000_000,
    };
    const priced = priceTrade(trade, { priceSol: 5e-5, priceUsd: 0.0075 });
    expect(priced.priceSol).toBe(5e-5);
    expect(priced.priceUsd).toBe(0.0075);
    expect(priced.signature).toBe(trade.signature);

    expect(priceTrade(trade, null)).toEqual(trade);
    expect(priceTrade(trade, { priceSol: 0, priceUsd: 0 })).toEqual(trade);
  });
});
