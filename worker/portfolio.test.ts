/// <reference types="node" />
/**
 * The portfolio: what it derives, and what it refuses to.
 *
 * Two kinds of test. The derivation tests are pure - every input is a fixture - and they are where
 * the accounting lives: a cost basis comes only from the wallet own indexed buys, a fill with no
 * measured received side is unknown rather than priced, and a section whose read failed is reported
 * as unavailable rather than as empty. The endpoint tests run against real SQLite with every
 * migration applied and a stubbed chain, so the SQL the handler issues is the SQL the Worker runs.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { DIGGO_CONFIG, crewPower, crewTier, oreCapacity } from "../shared/economics";
import type { RuntimeEnv } from "./env";
import {
  derivePortfolio,
  portfolioForWallet,
  type ChainReads,
  type HoldingRow,
  type PortfolioSources,
  type WalletTradeRow,
  withheldFees,
} from "./portfolio";
import type { PlayerAccountRow } from "./player";

type SqlValue = string | number | bigint | null | Uint8Array;

/** node:sqlite binds a JS number as a REAL; D1 binds a safe integer as an INTEGER. */
function bindable(values: readonly unknown[]): SqlValue[] {
  return values.map((value): SqlValue => {
    if (value === undefined) return null;
    if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
    if (typeof value === "boolean") return value ? 1n : 0n;
    return value as SqlValue;
  });
}

class SqliteStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly bound: readonly SqlValue[] = [],
  ) {}

  bind(...values: unknown[]): SqliteStatement {
    return new SqliteStatement(this.db, this.sql, bindable(values));
  }

  async first<T>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.bound) as T | undefined;
    return row ?? null;
  }

  async all<T>(): Promise<{ results: T[]; success: boolean; meta: { changes: number } }> {
    const results = this.db.prepare(this.sql).all(...this.bound) as T[];
    return { results, success: true, meta: { changes: 0 } };
  }

  async run(): Promise<{ success: boolean; meta: { changes: number } }> {
    const info = this.db.prepare(this.sql).run(...this.bound);
    return { success: true, meta: { changes: Number(info.changes) } };
  }
}

class SqliteD1 {
  constructor(readonly db: DatabaseSync) {}

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.db, sql);
  }

  async batch(statements: readonly SqliteStatement[]): Promise<unknown[]> {
    return statements.map((statement) => statement.run());
  }
}

class FakeKv {
  private readonly store = new Map<string, string>();

  async get<T>(key: string): Promise<T | string | null> {
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

interface Harness {
  db: DatabaseSync;
  env: RuntimeEnv;
}

function harness(): Harness {
  const db = new DatabaseSync(":memory:");
  const directory = fileURLToPath(new URL("../migrations/", import.meta.url));
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(directory, file), "utf8"));
  }
  const env = { DB: new SqliteD1(db), TOKEN_CACHE: new FakeKv() } as unknown as RuntimeEnv;
  return { db, env };
}

/** A chain read that answers nothing, so a test can state exactly which side it is exercising. */
function chain(overrides: Partial<ChainReads> = {}): ChainReads {
  return {
    walletSignatures: async () => [],
    tokenAccounts: async () => [],
    ...overrides,
  };
}

const WALLET = "So11111111111111111111111111111111111111112";
const MINT_A = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const MINT_B = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const COIN_A = "coinAAA";
const COIN_B = "coinBBB";
const SOL = 1_000_000_000;

describe("withheldFees", () => {
  it("extracts Token-2022 withheld transfer fees without treating configuration as held value", () => {
    expect(withheldFees({
      extensions: [
        { extension: "transferFeeConfig", state: { withheldAmount: "999" } },
        { extension: "transferFeeAmount", state: { withheldAmount: "12" } },
        { extension: "transferFeeAmount", state: { withheldAmount: "3" } },
      ],
    })).toBe(15n);
  });
});

/** A complete mirrored PlayerAccount, with only the fields a test cares about overridden. */
function playerAccount(overrides: Partial<PlayerAccountRow> = {}): PlayerAccountRow {
  return {
    player: "player-pda",
    wallet: WALLET,
    created_slot: "1",
    created_at: 1_700_000_000,
    active_until: 1_700_086_400,
    last_activation_at: 1_699_000_000,
    streak: 7,
    longest_streak: 11,
    valid_activations: 9,
    active_days: 42,
    streak_freezes: 2,
    miners_level: 3,
    drills_level: 2,
    carts_level: 1,
    foreman_level: 1,
    storage_level: 4,
    ore_balance: "12345",
    ore_earned: "90000",
    ore_spent: "77655",
    active_mine: COIN_A,
    day_index: 20_000,
    week_index: 2_857,
    spent_day_lamports: "0",
    spent_week_lamports: "0",
    roll_window: 3,
    roll_count: 3,
    last_roll_at: 1_699_900_000,
    bond_lamports: "70000000",
    bond_locked_at: 1_699_000_000,
    unbond_available_at: 0,
    bond_source: 0,
    bond_sponsor_vault: "",
    indexed_at: 1_700_000_100,
    ...overrides,
  };
}

/** Portfolio sources with nothing in them, so each test states only what it is about. */
function sources(overrides: Partial<PortfolioSources> = {}): PortfolioSources {
  return {
    player: { created_at: 1_700_000_000 },
    account: playerAccount(),
    positions: [],
    activeMine: { coin: COIN_A, mint: MINT_A, slug: "slug-a", symbol: "AAA" },
    createdCoins: [],
    discoveryGrants: [],
    discoveryGrantsPending: 0,
    rewardsClaimed: [],
    holdings: [],
    trades: [],
    tradeHistoryComplete: true,
    signaturesScanned: 0,
    mints: new Map(),
    ...overrides,
  };
}

function holding(overrides: Partial<HoldingRow> & { mint: string }): HoldingRow {
  return {
    account: "token-account-" + overrides.mint,
    program: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    amount: "0",
    withheld: "0",
    decimals: 6,
    state: "initialized",
    ...overrides,
  };
}

function trade(overrides: Partial<WalletTradeRow> & { mint: string; side: string }): WalletTradeRow {
  return {
    signature: "sig",
    amountIn: "0",
    amountOut: "0",
    fillSource: "meta",
    priceSol: 0,
    blockTime: 1_700_000_000,
    ...overrides,
  };
}

function meta(priceSol: number, decimals = 6) {
  return { coin: null, slug: null, name: null, symbol: null, decimals, priceSol, priceUsd: priceSol * 150 };
}

const NOW = 1_700_000_500;

/** The tier a wallet with no crew sits at, which is what an unpriced crew block reports. */
const BASE_TIER = DIGGO_CONFIG.crew.tiers[0].name;

describe("derivePortfolio: positions", () => {
  it("prices an open position but leaves basis and PnL unknown without a complete lot ledger", () => {
    const view = derivePortfolio(WALLET, NOW, "miner", sources({
      holdings: [holding({ mint: MINT_A, amount: "1000000000" })],
      trades: [
        trade({ mint: MINT_A, side: "BUY", amountIn: String(SOL), amountOut: "1000000000" }),
      ],
      mints: new Map([[MINT_A, meta(0.002)]]),
    }));

    expect(view.positions.source).toBe("chain");
    expect(view.positions.open).toHaveLength(1);
    const position = view.positions.open[0]!;
    expect(position.balanceWhole).toBe(1_000);
    expect(position.valueSol).toBeCloseTo(2, 9);
    expect(position.avgEntrySol).toBeNull();
    expect(position.costBasisSol).toBeNull();
    expect(position.unrealizedPnlSol).toBeNull();
    expect(position.unrealizedPnlPct).toBeNull();
    expect(view.stats.unrealizedPnlSol).toBeNull();
  });

  it("sums several accounts of the same mint into one position", () => {
    const view = derivePortfolio(WALLET, NOW, null, sources({
      holdings: [
        holding({ mint: MINT_A, account: "acct-1", amount: "500000000" }),
        holding({ mint: MINT_A, account: "acct-2", amount: "500000000" }),
      ],
      mints: new Map([[MINT_A, meta(0.001)]]),
    }));
    expect(view.positions.open).toHaveLength(1);
    expect(view.positions.open[0]!.balanceWhole).toBe(1_000);
    expect(view.positions.open[0]!.valueSol).toBeCloseTo(1, 9);
  });

  it("keeps Token-2022 withheld units separate from spendable units", () => {
    const view = derivePortfolio(WALLET, NOW, null, sources({
      holdings: [holding({ mint: MINT_A, amount: "700", withheld: "300" })],
      mints: new Map([[MINT_A, meta(0.002)]]),
    }));
    expect(view.positions.open[0]!.balanceWhole).toBeCloseTo(0.0007, 12);
    expect(view.positions.open[0]!.withheldWhole).toBeCloseTo(0.0003, 12);
  });

  it("ignores an account that holds nothing, and one whose mint the index does not know", () => {
    const view = derivePortfolio(WALLET, NOW, null, sources({
      holdings: [holding({ mint: MINT_A, amount: "0" }), holding({ mint: MINT_B, amount: "1000000" })],
      mints: new Map([[MINT_A, meta(0.001)]]),
    }));
    expect(view.positions.open.map((entry) => entry.mint)).toEqual([MINT_B]);
    // The unknown mint keeps its real balance, but its valuation is unknown rather than zero.
    expect(view.positions.open[0]!.priceSol).toBeNull();
    expect(view.positions.open[0]!.valueSol).toBeNull();
    expect(view.positions.open[0]!.valueUsd).toBeNull();
    expect(view.positions.open[0]!.avgEntrySol).toBeNull();
    expect(view.positions.open[0]!.unrealizedPnlSol).toBeNull();
  });

  it("never invents a basis for tokens that were mined rather than bought", () => {
    const view = derivePortfolio(WALLET, NOW, null, sources({
      holdings: [holding({ mint: MINT_A, amount: "1000000" })],
      trades: [trade({ mint: MINT_A, side: "BUY", amountIn: String(SOL), amountOut: "0", fillSource: "instruction" })],
      mints: new Map([[MINT_A, meta(0.5)]]),
    }));
    expect(view.positions.open[0]!.avgEntrySol).toBeNull();
    expect(view.positions.open[0]!.unrealizedPnlSol).toBeNull();
    // The SOL input was still recorded, so the volume it contributed is real.
    expect(view.stats.volumeBoughtSol).toBeCloseTo(1, 9);
  });

  it("does not infer a FIFO lot across an unindexed inbound transfer", () => {
    const view = derivePortfolio(WALLET, NOW, null, sources({
      holdings: [holding({ mint: MINT_A, amount: "2000000" })],
      trades: [trade({ mint: MINT_A, side: "BUY", amountIn: String(SOL), amountOut: "1000000" })],
      mints: new Map([[MINT_A, meta(0.002)]]),
    }));
    expect(view.positions.open[0]!.avgEntrySol).toBeNull();
    expect(view.positions.open[0]!.costBasisSol).toBeNull();
    expect(view.positions.open[0]!.unrealizedPnlSol).toBeNull();
  });

  it("reports positions as unavailable when the chain read fails, not as empty", () => {
    const view = derivePortfolio(WALLET, NOW, null, sources({ holdings: null, trades: null }));
    expect(view.positions.source).toBe("unavailable");
    expect(view.positions.open).toEqual([]);
    expect(view.positions.closed).toEqual([]);
    expect(view.stats.unrealizedPnlSol).toBeNull();
  });
});

describe("derivePortfolio: closed positions", () => {
  it("reports realized PnL as unknown for multi-buy and partial-sell histories", () => {
    const view = derivePortfolio(WALLET, NOW, null, sources({
      holdings: [],
      trades: [
        trade({ mint: MINT_A, side: "BUY", amountIn: String(SOL), amountOut: "1000000000" }),
        trade({ mint: MINT_A, side: "BUY", amountIn: String(2 * SOL), amountOut: "2000000000" }),
        trade({ mint: MINT_A, side: "SELL", amountIn: "500000000", amountOut: String(SOL) }),
      ],
      mints: new Map([[MINT_A, meta(0.003)]]),
    }));

    expect(view.positions.closed).toHaveLength(1);
    const closed = view.positions.closed[0]!;
    expect(closed.soldTokens).toBeCloseTo(500, 9);
    expect(closed.soldSol).toBeCloseTo(1, 9);
    expect(closed.avgEntrySol).toBeNull();
    expect(closed.realizedPnlSol).toBeNull();
    expect(closed.realizedPnlPct).toBeNull();
    expect(view.stats.realizedPnlSol).toBeNull();
  });

  it("lists a fully sold mint whose tokens were mined, with no realized figure", () => {
    const view = derivePortfolio(WALLET, NOW, null, sources({
      holdings: [],
      trades: [trade({ mint: MINT_A, side: "SELL", amountIn: "500000000", amountOut: String(SOL) })],
      mints: new Map([[MINT_A, meta(0.003)]]),
    }));
    expect(view.positions.closed).toHaveLength(1);
    expect(view.positions.closed[0]!.avgEntrySol).toBeNull();
    expect(view.positions.closed[0]!.realizedPnlSol).toBeNull();
    // One closed position with no computable basis is unknown, not zero.
    expect(view.stats.realizedPnlSol).toBeNull();
  });

  it("does not call a mint closed while the wallet still holds it", () => {
    const view = derivePortfolio(WALLET, NOW, null, sources({
      holdings: [holding({ mint: MINT_A, amount: "1000000" })],
      trades: [trade({ mint: MINT_A, side: "SELL", amountIn: "500000000", amountOut: String(SOL) })],
      mints: new Map([[MINT_A, meta(0.003)]]),
    }));
    expect(view.positions.closed).toEqual([]);
    expect(view.positions.open).toHaveLength(1);
    expect(view.stats.realizedPnlSol).toBeNull();
  });

  it("needs the holdings read to decide what is closed", () => {
    const view = derivePortfolio(WALLET, NOW, null, sources({
      holdings: null,
      trades: [trade({ mint: MINT_A, side: "SELL", amountIn: "500000000", amountOut: String(SOL) })],
      mints: new Map([[MINT_A, meta(0.003)]]),
    }));
    expect(view.positions.closed).toEqual([]);
    // A sold mint may still be held without the holdings read, so nothing is known to be closed.
    expect(view.stats.realizedPnlSol).toBeNull();
  });

  it("does not present a partial sum when only some sell fills are measured", () => {
    const view = derivePortfolio(WALLET, NOW, null, sources({
      holdings: [],
      trades: [
        trade({ mint: MINT_A, side: "BUY", amountIn: String(SOL), amountOut: "1000000000" }),
        trade({ mint: MINT_A, side: "SELL", amountIn: "200000000", amountOut: String(SOL / 2) }),
        trade({ mint: MINT_A, side: "SELL", amountIn: "300000000", amountOut: "0", fillSource: "instruction" }),
      ],
      mints: new Map([[MINT_A, meta(0.003)]]),
    }));

    expect(view.positions.closed[0]!.soldSol).toBeNull();
    expect(view.positions.closed[0]!.realizedPnlSol).toBeNull();
    expect(view.stats.volumeSoldSol).toBeNull();
    expect(view.stats.realizedPnlSol).toBeNull();
  });

  it("does not turn a mix of known and unknown open valuations into an aggregate", () => {
    const view = derivePortfolio(WALLET, NOW, null, sources({
      holdings: [
        holding({ mint: MINT_A, account: "acct-a", amount: "1000000" }),
        holding({ mint: MINT_B, account: "acct-b", amount: "1000000" }),
      ],
      trades: [
        trade({ mint: MINT_A, side: "BUY", amountIn: String(SOL), amountOut: "1000000" }),
        trade({ mint: MINT_B, side: "BUY", amountIn: String(SOL), amountOut: "1000000" }),
      ],
      mints: new Map([[MINT_A, meta(0.002)]]),
    }));

    expect(view.positions.open[0]!.valueSol).not.toBeNull();
    expect(view.positions.open.some((entry) => entry.valueSol === null)).toBe(true);
    expect(view.stats.unrealizedPnlSol).toBeNull();
  });
});

describe("derivePortfolio: stats", () => {
  it("counts the trades it could attribute and prices only the fills that measured a received side", () => {
    const view = derivePortfolio(WALLET, NOW, null, sources({
      holdings: [],
      trades: [
        trade({ mint: MINT_A, side: "BUY", amountIn: String(SOL), amountOut: "1000000000" }),
        trade({ mint: MINT_A, side: "SELL", amountIn: "500000000", amountOut: "0", fillSource: "instruction" }),
      ],
      mints: new Map([[MINT_A, meta(0.003)]]),
    }));
    expect(view.stats.tradeAttribution).toBe("signature");
    expect(view.stats.trades).toBe(2);
    expect(view.stats.tradesPriced).toBe(1);
    expect(view.stats.tradesUnpriced).toBe(1);
    expect(view.stats.volumeBoughtSol).toBeCloseTo(1, 9);
    // The only sell had no measured proceeds, so the sold column is unknown rather than zero.
    expect(view.stats.volumeSoldSol).toBeNull();
  });

  it("reports the trade columns as unknown when the attribution did not answer", () => {
    const view = derivePortfolio(WALLET, NOW, null, sources({ trades: null }));
    expect(view.stats.tradeAttribution).toBe("unavailable");
    expect(view.stats.trades).toBeNull();
    expect(view.stats.volumeBoughtSol).toBeNull();
    expect(view.stats.volumeSoldSol).toBeNull();
    expect(view.stats.realizedPnlSol).toBeNull();
  });

  it("marks a 400-signature scan as partial and labels volume accordingly", () => {
    const view = derivePortfolio(WALLET, NOW, null, sources({
      trades: [trade({ mint: MINT_A, side: "BUY", amountIn: String(SOL), amountOut: "1000000" })],
      tradeHistoryComplete: false,
      signaturesScanned: 400,
    }));
    expect(view.stats.tradeHistoryComplete).toBe(false);
    expect(view.stats.signaturesScanned).toBe(400);
    expect(view.stats.signatureScanLimit).toBe(400);
    expect(view.stats.volumeScope).toBe("latest-signatures");
    expect(view.stats.volumeBoughtSol).toBeCloseTo(1, 9);
  });

  it("keeps reward claims separate by coin and uses each token's indexed decimals", () => {
    const view = derivePortfolio(WALLET, NOW, null, sources({
      rewardsClaimed: [
        { coin: COIN_A, mint: MINT_A, symbol: "AAA", decimals: 6, amount: "1000", events: 1 },
        { coin: COIN_B, mint: MINT_B, symbol: "BBB", decimals: 2, amount: "2500", events: 1 },
      ],
      createdCoins: [
        {
          coin: COIN_A,
          mint: MINT_A,
          slug: "slug-a",
          name: "AAA coin",
          symbol: "AAA",
          status: "MINING_ACTIVE",
          graduated: 0,
          price_sol: 0.01,
          market_cap_usd: 500_000,
          creator_fee_claimable: "50000000",
        },
        {
          coin: COIN_B,
          mint: MINT_B,
          slug: "slug-b",
          name: "BBB coin",
          symbol: "BBB",
          status: "MINING_ACTIVE",
          graduated: 1,
          price_sol: 0.02,
          market_cap_usd: 900_000,
          creator_fee_claimable: "25000000",
        },
      ],
    }));
    expect(view.stats.rewardsClaimed).toEqual([
      { coin: COIN_A, mint: MINT_A, symbol: "AAA", amount: "1000", amountWhole: 0.001, events: 1 },
      { coin: COIN_B, mint: MINT_B, symbol: "BBB", amount: "2500", amountWhole: 25, events: 1 },
    ]);
    expect(view.stats.coinsCreated).toBe(2);
    expect(view.stats.creatorFeesClaimableLamports).toBe("75000000");
    expect(view.stats.creatorFeesClaimableSol).toBeCloseTo(0.075, 12);
    expect(view.creator.claimableLamports).toBe("75000000");
    expect(view.creator.coins.map((coin) => coin.symbol)).toEqual(["AAA", "BBB"]);
    expect(view.creator.coins[1]!.graduated).toBe(true);
  });

  it("carries the username and the join date through, and reports an unseen wallet as such", () => {
    const seen = derivePortfolio(WALLET, NOW, "miner", sources());
    expect(seen.username).toBe("miner");
    expect(seen.joined).toBe(1_700_000_000);
    expect(seen.indexed).toBe(true);

    const unseen = derivePortfolio(WALLET, NOW, null, sources({ player: null, account: null }));
    expect(unseen.username).toBeNull();
    expect(unseen.joined).toBeNull();
    expect(unseen.indexed).toBe(false);
    expect(unseen.mining.activation).toBe("NEVER_ACTIVATED");
  });
});

describe("derivePortfolio: mining and creator", () => {
  it("sums the assigned power and lists only the coins with something to claim", () => {
    const view = derivePortfolio(WALLET, NOW, null, sources({
      positions: [
        { position: "pos-a", coin: COIN_A, assigned_power: "1200", pending_reward: "5000000", mint: MINT_A, symbol: "AAA", decimals: 6 },
        { position: "pos-b", coin: COIN_B, assigned_power: "800", pending_reward: "0", mint: MINT_B, symbol: "BBB", decimals: 2 },
      ],
    }));
    expect(view.mining.power).toBe("2000");
    expect(view.mining.powerWhole).toBe(2_000);
    expect(view.mining.rewards.map((reward) => reward.position)).toEqual(["pos-a"]);
    expect(view.mining.rewards[0]!.pendingRewardWhole).toBe(5);
  });

  it("mirrors the bond, the streak and the crew from the player account", () => {
    const view = derivePortfolio(WALLET, NOW, null, sources());
    expect(view.mining.activation).toBe("ACTIVE");
    expect(view.mining.streak).toBe(7);
    expect(view.mining.longestStreak).toBe(11);
    expect(view.mining.activeDays).toBe(42);
    expect(view.mining.streakFreezes).toBe(2);
    expect(view.mining.bond.posted).toBe(true);
    expect(view.mining.bond.sol).toBeCloseTo(0.07, 12);
    expect(view.mining.bond.source).toBe("SELF");
    expect(view.mining.crew.miners).toBe(3);
    expect(view.mining.crew.total).toBe(11);
    expect(view.mining.crewPower).toBeGreaterThan(0);
    expect(view.mining.crewTier.length).toBeGreaterThan(0);
    expect(view.mining.crewSource).toBe("mirror");
    expect(view.mining.oreWhole).toBe(12_345);
    expect(view.mining.activeMine?.symbol).toBe("AAA");
  });

  it("lists the discovery rolls that are still pending", () => {
    const view = derivePortfolio(WALLET, NOW, null, sources({
      discoveryGrants: [
        {
          opportunity: "opp-1",
          coin: COIN_A,
          window_index: 7,
          day_index: 20_000,
          created_at: 1_700_000_000,
          mint: MINT_A,
          symbol: "AAA",
        },
      ],
      discoveryGrantsPending: 1,
    }));
    expect(view.mining.discoveryGrants).toHaveLength(1);
    expect(view.mining.discoveryGrants[0]!.windowIndex).toBe(7);
    expect(view.stats.discoveryGrantsPending).toBe(1);
  });

  it("counts all pending grants while bounding the preview", () => {
    const grants = Array.from({ length: 51 }, (_, index) => ({
      opportunity: "opp-" + index,
      coin: COIN_A,
      window_index: index,
      day_index: 20_000 + index,
      created_at: NOW - index,
      mint: MINT_A,
      symbol: "AAA",
    }));
    const view = derivePortfolio(WALLET, NOW, null, sources({
      discoveryGrants: grants.slice(0, 50),
      discoveryGrantsPending: 51,
    }));
    expect(view.mining.discoveryGrants).toHaveLength(50);
    expect(view.stats.discoveryGrantsPending).toBe(51);
    expect(view.stats.discoveryGrantsPreviewTruncated).toBe(true);
    expect(view.stats.discoveryGrantsPreviewLimit).toBe(50);
  });
});

/**
 * The crew block for a wallet with no usable mirror.
 *
 * The regression these pin: the portfolio used to clamp a crew it could not read - no mirror at all,
 * or levels the program cannot hold - up to `crew.minLevel`, so a wallet that had never initialized
 * its PlayerAccount was reported with starter Mining Power and ORE capacity it does not have, and a
 * mirror holding a level 0 was reported one level above what it states. The profile refuses both
 * (`worker/player.ts`), and the two views answer for the same wallet, so they have to agree.
 */
describe("derivePortfolio: crew", () => {
  const MIRRORED = { miners: 3, drills: 2, carts: 1, foreman: 1, storage: 4 };

  it("prices a mirror the program can hold with the shared tables", () => {
    const view = derivePortfolio(WALLET, NOW, null, sources());
    expect(view.mining.crew).toEqual({ ...MIRRORED, total: 11 });
    expect(view.mining.crewPower).toBe(crewPower(MIRRORED));
    expect(view.mining.oreCapacity).toBe(oreCapacity(MIRRORED));
    expect(view.mining.crewTier).toBe(crewTier(MIRRORED).name);
    expect(view.mining.crewSource).toBe("mirror");
  });

  it("reports a wallet with no mirror as a zero crew rather than the minimum one", () => {
    // A profile row without a PlayerAccount is what the index holds for a wallet that has never
    // sent initialize_player. It has no crew, which is zero everywhere - not level one everywhere.
    const view = derivePortfolio(WALLET, NOW, null, sources({ account: null }));
    expect(view.indexed).toBe(false);
    expect(view.mining.activation).toBe("NEVER_ACTIVATED");
    expect(view.mining.crew).toEqual({
      miners: 0,
      drills: 0,
      carts: 0,
      foreman: 0,
      storage: 0,
      total: 0,
    });
    expect(view.mining.crewPower).toBe(0);
    expect(view.mining.oreCapacity).toBe(0);
    expect(view.mining.crewTier).toBe(BASE_TIER);
    expect(view.mining.crewSource).toBe("unavailable");
  });

  it("keeps a mirror the program cannot price visible, at zero power and capacity", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const belowFloor = derivePortfolio(
        WALLET,
        NOW,
        null,
        sources({ account: playerAccount({ foreman_level: 0 }) }),
      );
      expect(belowFloor.indexed).toBe(true);
      // Exactly as mirrored. The 0 is not rounded up to the minimum level, which would report an
      // upgrade nobody bought and a total the wallet does not hold.
      expect(belowFloor.mining.crew).toEqual({
        miners: 3,
        drills: 2,
        carts: 1,
        foreman: 0,
        storage: 4,
        total: 10,
      });
      expect(belowFloor.mining.crewPower).toBe(0);
      expect(belowFloor.mining.oreCapacity).toBe(0);
      expect(belowFloor.mining.crewTier).toBe(BASE_TIER);
      expect(belowFloor.mining.crewSource).toBe("unavailable");

      // A level above the ceiling is the same kind of fault and gets the same answer.
      const aboveCeiling = derivePortfolio(
        WALLET,
        NOW,
        null,
        sources({ account: playerAccount({ miners_level: 5_000 }) }),
      );
      expect(aboveCeiling.mining.crew.miners).toBe(5_000);
      expect(aboveCeiling.mining.crewPower).toBe(0);
      expect(aboveCeiling.mining.crewSource).toBe("unavailable");
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("GET /api/portfolio/:wallet", () => {
  function request(): Request {
    return new Request("https://diggo.test/api/portfolio/" + WALLET);
  }

  /** A wallet with a crew, a mine, a coin it created, a pending roll and one signed trade. */
  function seedWallet(db: DatabaseSync): void {
    db.prepare("INSERT INTO players (wallet, created_at) VALUES (?1, ?2)").run(WALLET, 1_699_000_000);
    db.prepare(
      "INSERT INTO usernames (wallet, username, username_normalized, created_at, updated_at, change_count)" +
        " VALUES (?1, ?2, ?3, ?4, ?4, 1)",
    ).run(WALLET, "shaftboss", "shaftboss", 1_699_000_000);
    db.prepare(
      "INSERT INTO player_accounts (player, wallet, created_at, active_until, streak, longest_streak," +
        " active_days, streak_freezes, miners_level, drills_level, carts_level, foreman_level," +
        " storage_level, ore_balance, ore_earned, active_mine, bond_lamports, bond_source)" +
        " VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
    ).run(
      "player-pda",
      WALLET,
      1_699_000_000,
      NOW + 10_000,
      5,
      9,
      30,
      1,
      2,
      3,
      1,
      1,
      4,
      "1000",
      "5000",
      COIN_A,
      "70000000",
      0,
    );
    db.prepare(
      "INSERT INTO coins (coin, mint, slug, creator, vault, symbol, status, creator_fee_claimable," +
        " graduated, indexed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
    ).run(COIN_A, MINT_A, "slug-a", WALLET, "vault-a", "AAA", "MINING_ACTIVE", "40000000", 0, 1_700_000_100);
    db.prepare(
      "INSERT INTO coins (coin, mint, slug, creator, vault, symbol, status, creator_fee_claimable," +
        " graduated, indexed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
    ).run(COIN_B, MINT_B, "slug-b", "someone-else", "vault-b", "BBB", "MINING_ACTIVE", "90000000", 0, 1_700_000_100);
    db.prepare(
      "INSERT INTO tokens (mint, coin, slug, name, symbol, creator, status, price_sol, price_usd," +
        " market_cap_usd, decimals) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
    ).run(MINT_A, COIN_A, "slug-a", "AAA coin", "AAA", WALLET, "MINING_ACTIVE", 0.002, 0.3, 150_000, 6);
    db.prepare(
      "INSERT INTO mining_positions_v2 (position, coin, owner, assigned_power, pending_reward, tranche)" +
        " VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    ).run("pos-a", COIN_A, WALLET, "1200", "2000000", 0);
    db.prepare(
      "INSERT INTO mining_positions_v2 (position, coin, owner, assigned_power, pending_reward, tranche)" +
        " VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    ).run("pos-b", COIN_A, WALLET, "300", "0", 1);
    db.prepare(
      "INSERT INTO discovery_events (id, opportunity, coin, wallet, window_index, day_index, status," +
        " signature, slot, block_time, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
    ).run("opp-1", "opp-1", COIN_A, WALLET, 7, 20_000, "PENDING", "sig-roll", 1, 1_700_000_000, 1_700_000_000);
    db.prepare(
      "INSERT INTO discovery_events (id, opportunity, coin, wallet, window_index, day_index, status," +
        " signature, slot, block_time, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
    ).run("opp-2", "opp-2", COIN_A, WALLET, 6, 19_999, "SETTLED", "sig-settled", 1, 1_699_000_000, 1_699_000_000);
    db.prepare(
      "INSERT INTO reward_events (signature, event_index, coin, wallet, amount, slot, block_time," +
        " created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    ).run("sig-claim", 0, COIN_A, WALLET, "5000", 1, 1_699_500_000, 1_699_500_000);
    // One trade the wallet signed and one it did not: the index cannot tell them apart, which is
    // exactly why the attribution intersects with the wallet own signatures.
    db.prepare(
      "INSERT INTO trades (signature, instruction_index, mint, coin, side, venue, amount_in," +
        " amount_out, fill_source, price_sol, block_time, slot, indexed_at)" +
        " VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
    ).run("sig-mine", 0, MINT_A, COIN_A, "BUY", "curve", String(SOL), "1000000000", "meta", 0.002, 1_700_000_000, 1, 1);
    db.prepare(
      "INSERT INTO trades (signature, instruction_index, mint, coin, side, venue, amount_in," +
        " amount_out, fill_source, price_sol, block_time, slot, indexed_at)" +
        " VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
    ).run("sig-someone-else", 0, MINT_A, COIN_A, "SELL", "curve", "500000000", String(SOL), "meta", 0.003, 1_700_000_100, 1, 1);
  }

  it("refuses a wallet that is not an address", async () => {
    const { env } = harness();
    const response = await portfolioForWallet(request(), env, "not-an-address", chain());
    expect(response.status).toBe(400);
  });

  it("answers for a wallet it has never seen, with nulls rather than zeros", async () => {
    const { env } = harness();
    const response = await portfolioForWallet(
      request(),
      env,
      WALLET,
      chain({ tokenAccounts: async () => null, walletSignatures: async () => null }),
    );
    expect(response.status).toBe(200);
    const { portfolio } = (await response.json()) as { portfolio: ReturnType<typeof derivePortfolio> };
    expect(portfolio.indexed).toBe(false);
    expect(portfolio.joined).toBeNull();
    expect(portfolio.stats.trades).toBeNull();
    expect(portfolio.stats.volumeBoughtSol).toBeNull();
    expect(portfolio.positions.source).toBe("unavailable");
    expect(portfolio.mining.activation).toBe("NEVER_ACTIVATED");
    expect(portfolio.stats.coinsCreated).toBe(0);
    expect(portfolio.stats.rewardsClaimed).toEqual([]);
  });

  it("derives the whole view from the index and the wallet own signatures", async () => {
    const { env, db } = harness();
    seedWallet(db);
    const response = await portfolioForWallet(
      request(),
      env,
      WALLET,
      chain({
        walletSignatures: async () => ["sig-mine"],
        tokenAccounts: async () => [holding({ mint: MINT_A, amount: "1000000000" })],
      }),
    );
    expect(response.status).toBe(200);
    const { portfolio } = (await response.json()) as { portfolio: ReturnType<typeof derivePortfolio> };

    expect(portfolio.username).toBe("shaftboss");
    expect(portfolio.joined).toBe(1_699_000_000);
    expect(portfolio.indexed).toBe(true);

    // Only the trade this wallet signed is attributed to it.
    expect(portfolio.stats.trades).toBe(1);
    expect(portfolio.stats.volumeBoughtSol).toBeCloseTo(1, 9);
    expect(portfolio.stats.volumeSoldSol).toBe(0);

    // The one open position is the holding, valued at the indexed price with a basis from the buy.
    expect(portfolio.positions.source).toBe("chain");
    expect(portfolio.positions.open).toHaveLength(1);
    expect(portfolio.positions.open[0]!.symbol).toBe("AAA");
    expect(portfolio.positions.open[0]!.valueSol).toBeCloseTo(2, 9);
    expect(portfolio.positions.open[0]!.unrealizedPnlSol).toBeNull();
    expect(portfolio.stats.unrealizedPnlSol).toBeNull();

    // Mining: two positions, one of them with something to claim.
    expect(portfolio.mining.activeMine?.symbol).toBe("AAA");
    expect(portfolio.mining.power).toBe("1500");
    expect(portfolio.mining.oreWhole).toBe(1_000);
    expect(portfolio.mining.rewards).toHaveLength(1);
    expect(portfolio.mining.rewards[0]!.pendingRewardWhole).toBe(2);
    expect(portfolio.mining.streak).toBe(5);
    expect(portfolio.mining.bond.posted).toBe(true);
    // The crew is the mirrored one, priced by the shared tables rather than by a second opinion.
    expect(portfolio.mining.crewSource).toBe("mirror");
    expect(portfolio.mining.crewPower).toBe(
      crewPower({ miners: 2, drills: 3, carts: 1, foreman: 1, storage: 4 }),
    );
    expect(portfolio.mining.oreCapacity).toBe(
      oreCapacity({ miners: 2, drills: 3, carts: 1, foreman: 1, storage: 4 }),
    );
    expect(portfolio.mining.discoveryGrants).toHaveLength(1);
    expect(portfolio.mining.discoveryGrants[0]!.windowIndex).toBe(7);
    expect(portfolio.stats.discoveryGrantsPending).toBe(1);
    expect(portfolio.stats.discoveryGrantsPreviewTruncated).toBe(false);

    // Only the coin this wallet created is in the creator block, with its own claimable fees.
    expect(portfolio.stats.coinsCreated).toBe(1);
    expect(portfolio.creator.coins[0]!.mint).toBe(MINT_A);
    expect(portfolio.creator.claimableLamports).toBe("40000000");
    expect(portfolio.stats.creatorFeesClaimableSol).toBeCloseTo(0.04, 12);
    expect(portfolio.stats.rewardsClaimed).toEqual([
      { coin: COIN_A, mint: MINT_A, symbol: "AAA", amount: "5000", amountWhole: 0.005, events: 1 },
    ]);
  });

  it("uses COUNT for pending grants and limits the preview to 50 rows", async () => {
    const { env, db } = harness();
    seedWallet(db);
    const insert = db.prepare(
      "INSERT INTO discovery_events (id, opportunity, coin, wallet, window_index, day_index, status," +
        " signature, slot, block_time, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'PENDING', ?7, 1, ?8, ?8)",
    );
    for (let index = 2; index <= 51; index += 1) {
      insert.run(
        "bulk-" + index,
        "bulk-" + index,
        COIN_A,
        WALLET,
        index,
        20_000 + index,
        "sig-bulk-" + index,
        NOW - index,
      );
    }
    const response = await portfolioForWallet(request(), env, WALLET, chain());
    const { portfolio } = (await response.json()) as { portfolio: ReturnType<typeof derivePortfolio> };
    expect(portfolio.stats.discoveryGrantsPending).toBe(51);
    expect(portfolio.mining.discoveryGrants).toHaveLength(50);
    expect(portfolio.stats.discoveryGrantsPreviewTruncated).toBe(true);
    expect(portfolio.stats.discoveryGrantsPreviewLimit).toBe(50);
  });

  it("keeps the indexed mining numbers when the chain reads fail", async () => {
    const { env, db } = harness();
    seedWallet(db);
    const response = await portfolioForWallet(
      request(),
      env,
      WALLET,
      chain({ tokenAccounts: async () => null, walletSignatures: async () => null }),
    );
    const { portfolio } = (await response.json()) as { portfolio: ReturnType<typeof derivePortfolio> };
    expect(portfolio.positions.source).toBe("unavailable");
    expect(portfolio.stats.tradeAttribution).toBe("unavailable");
    expect(portfolio.stats.trades).toBeNull();
    // The mining block is a mirror of an indexed account, so a failed chain read cannot affect it.
    expect(portfolio.mining.power).toBe("1500");
    expect(portfolio.mining.rewards).toHaveLength(1);
    expect(portfolio.stats.coinsCreated).toBe(1);
  });

  it("keeps the positions and the volume of a wallet whose PlayerAccount is not indexed", async () => {
    const { env, db } = harness();
    seedWallet(db);
    // The same wallet with its mirror removed: the profile, the positions and the trades are
    // indexed, the PlayerAccount is not. Its crew is nothing rather than the minimum level, and the
    // facts that are not about the crew are unaffected.
    db.prepare("DELETE FROM player_accounts WHERE wallet = ?1").run(WALLET);
    const response = await portfolioForWallet(
      request(),
      env,
      WALLET,
      chain({
        walletSignatures: async () => ["sig-mine"],
        tokenAccounts: async () => [holding({ mint: MINT_A, amount: "1000000000" })],
      }),
    );
    expect(response.status).toBe(200);
    const { portfolio } = (await response.json()) as { portfolio: ReturnType<typeof derivePortfolio> };
    expect(portfolio.indexed).toBe(false);
    expect(portfolio.mining.crew).toEqual({
      miners: 0,
      drills: 0,
      carts: 0,
      foreman: 0,
      storage: 0,
      total: 0,
    });
    expect(portfolio.mining.crewPower).toBe(0);
    expect(portfolio.mining.oreCapacity).toBe(0);
    expect(portfolio.mining.crewTier).toBe(BASE_TIER);
    expect(portfolio.mining.crewSource).toBe("unavailable");
    // The MiningPositions and the wallet own signed trades are index facts of their own.
    expect(portfolio.mining.power).toBe("1500");
    expect(portfolio.positions.open).toHaveLength(1);
    expect(portfolio.positions.open[0]!.balanceWhole).toBe(1_000);
    expect(portfolio.positions.open[0]!.valueSol).toBeCloseTo(2, 9);
    expect(portfolio.stats.trades).toBe(1);
    expect(portfolio.stats.volumeBoughtSol).toBeCloseTo(1, 9);
  });

  it("answers for an indexed mirror holding levels the program cannot write", async () => {
    const { env, db } = harness();
    seedWallet(db);
    // A decode or indexing fault: the program cannot hold a foreman below minLevel.
    db.prepare("UPDATE player_accounts SET foreman_level = 0 WHERE wallet = ?1").run(WALLET);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await portfolioForWallet(request(), env, WALLET, chain());
      expect(response.status).toBe(200);
      const { portfolio } = (await response.json()) as { portfolio: ReturnType<typeof derivePortfolio> };
      expect(portfolio.indexed).toBe(true);
      expect(portfolio.mining.crew.foreman).toBe(0);
      expect(portfolio.mining.crew.total).toBe(10);
      expect(portfolio.mining.crewPower).toBe(0);
      expect(portfolio.mining.oreCapacity).toBe(0);
      expect(portfolio.mining.crewSource).toBe("unavailable");
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("never caches a portfolio", async () => {
    const { env } = harness();
    const response = await portfolioForWallet(request(), env, WALLET, chain());
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
