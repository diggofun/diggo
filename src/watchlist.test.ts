/**
 * The watchlist list algebra.
 *
 * The claim these tests make is the one the star depends on: the browser copy and the server copy
 * merge in exactly one direction, the cap is enforced locally before the Worker ever sees the
 * request, and a mint the index does not know renders as unknown rather than as a row of zeros.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import bs58 from "bs58";
import type { TokenSummary } from "../shared/types";

// The module is imported for its list algebra, not its network calls: the wallet plugin, the API
// client and the device id are all mocked so the test exercises this file alone.
vi.mock("./wallet", () => ({ useDiggoWallet: () => null, OPEN_WALLET_EVENT: "diggo:open-wallet", requestWalletMenu: () => {} }));
vi.mock("./api", () => ({ getWalletSession: async () => null }));
vi.mock("./device", () => ({ DEVICE_HEADER: "X-Diggo-Device", deviceId: () => "test-device" }));

import {
  WATCHLIST_MAX,
  WATCHLIST_STORAGE_KEY,
  addWatchlistMint,
  isWatchlistMint,
  mergeWatchlists,
  normalizeWatchlist,
  readLocalWatchlist,
  removeWatchlistMint,
  toggleWatchlistMint,
  tokenToWatchlistCoin,
  watchlistRows,
  writeLocalWatchlist,
  type WatchlistCoin,
} from "./watchlist";

/** Two well-formed mints, which is all the shape check asks for. */
const MINT_A = "So11111111111111111111111111111111111111112";
const MINT_B = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const MINT_C = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

/** A distinct, valid base58 mint for each index, so a generated list is never silently filtered. */
function mintAt(index: number): string {
  return bs58.encode(new Uint8Array(32).fill(index % 256));
}

function coin(mint: string, overrides: Partial<WatchlistCoin> = {}): WatchlistCoin {
  return {
    mint,
    coin: "coin-" + mint,
    slug: mint,
    name: "Coin",
    symbol: "C" + mint.slice(0, 2),
    imageUrl: null,
    status: "MINING_ACTIVE",
    venue: "curve",
    graduated: false,
    priceSol: 0.001,
    priceUsd: 0.15,
    marketCapUsd: 150_000,
    change24h: 4.2,
    volume24hUsd: 1_000,
    trades24h: 12,
    mining: { open: true, cap: 100, mined: 25, remaining: 75, progress: 0.25, rewardPerBlock: 1, unpaid: 2 },
    addedAt: 1_700_000_000,
    ...overrides,
  };
}

function token(mint: string, overrides: Partial<TokenSummary> = {}): TokenSummary {
  return {
    mint,
    slug: mint,
    name: "Coin",
    symbol: "TKN",
    description: "",
    creator: "creator",
    imageUrl: null,
    status: "MINING_ACTIVE",
    priceSol: 0.002,
    priceUsd: 0.3,
    change24h: null,
    volume24hUsd: 0,
    trades24h: 0,
    curveMining: {
      open: true,
      onCurve: true,
      cap: 1_000,
      mined: 400,
      remaining: 600,
      progress: 0.4,
      blockReward: 5,
      unpaid: 9,
    },
    sellCapacity: { sol: 1, solAfterFees: 0.9, priceImpact: 0, note: "" } as unknown as TokenSummary["sellCapacity"],
    marketCapUsd: 200_000,
    reserveRemaining: 1,
    reserveTotal: 2,
    rewardPerBlock: 5,
    networkPower: 10,
    nextBlockAt: 0,
    nextEpochAt: 0,
    createdAt: 1_700_000_000,
    decimals: 6,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isWatchlistMint", () => {
  it("accepts a base58 address and refuses anything else", () => {
    expect(isWatchlistMint(MINT_A)).toBe(true);
    expect(isWatchlistMint("")).toBe(false);
    expect(isWatchlistMint("not a mint")).toBe(false);
    // A 0 is not base58, so an address-shaped string with one is not an address.
    expect(isWatchlistMint("0o1111111111111111111111111111111111111111")).toBe(false);
    expect(isWatchlistMint(42)).toBe(false);
    expect(isWatchlistMint(null)).toBe(false);
  });
});

describe("normalizeWatchlist", () => {
  it("keeps valid mints in order, drops duplicates and junk", () => {
    expect(normalizeWatchlist([MINT_A, MINT_B, MINT_A, "junk", MINT_C])).toEqual([MINT_A, MINT_B, MINT_C]);
  });

  it("caps the list at the same ceiling the Worker enforces", () => {
    const many = Array.from({ length: WATCHLIST_MAX + 25 }, (_value, index) => mintAt(index));
    expect(normalizeWatchlist(many)).toHaveLength(WATCHLIST_MAX);
  });
});

describe("mergeWatchlists", () => {
  it("keeps the server list first and appends what only the browser knew", () => {
    expect(mergeWatchlists([MINT_B, MINT_C], [MINT_A])).toEqual([MINT_A, MINT_B, MINT_C]);
  });

  it("does not duplicate a mint both sides know", () => {
    expect(mergeWatchlists([MINT_A, MINT_B], [MINT_A])).toEqual([MINT_A, MINT_B]);
  });

  it("drops the local tail when the merge would exceed the cap", () => {
    const server = Array.from({ length: WATCHLIST_MAX }, (_value, index) => mintAt(index));
    expect(mergeWatchlists([MINT_A], server)).toHaveLength(WATCHLIST_MAX);
    expect(mergeWatchlists([MINT_A], server)).not.toContain(MINT_A);
  });
});

describe("add, remove and toggle", () => {
  it("adds to the front, ignores a duplicate and refuses a malformed mint", () => {
    expect(addWatchlistMint([MINT_B], MINT_A)).toEqual([MINT_A, MINT_B]);
    expect(addWatchlistMint([MINT_A], MINT_A)).toEqual([MINT_A]);
    expect(addWatchlistMint([MINT_A], "junk")).toEqual([MINT_A]);
  });

  it("removes only the mint asked for", () => {
    expect(removeWatchlistMint([MINT_A, MINT_B], MINT_A)).toEqual([MINT_B]);
    expect(removeWatchlistMint([MINT_A], MINT_C)).toEqual([MINT_A]);
  });

  it("toggles both ways", () => {
    expect(toggleWatchlistMint([MINT_A], MINT_B)).toEqual([MINT_B, MINT_A]);
    expect(toggleWatchlistMint([MINT_A, MINT_B], MINT_B)).toEqual([MINT_A]);
  });
});

describe("the local copy", () => {
  it("is empty when storage refuses to exist", () => {
    // No window at all: readLocalWatchlist must not throw, because a star still has to render.
    expect(readLocalWatchlist()).toEqual([]);
    expect(() => writeLocalWatchlist([MINT_A])).not.toThrow();
  });

  it("round-trips through localStorage and repairs a malformed value", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
      },
    });
    writeLocalWatchlist([MINT_A, "junk", MINT_A]);
    expect(JSON.parse(store.get(WATCHLIST_STORAGE_KEY)!)).toEqual([MINT_A]);
    expect(readLocalWatchlist()).toEqual([MINT_A]);
    store.set(WATCHLIST_STORAGE_KEY, "{not json");
    expect(readLocalWatchlist()).toEqual([]);
    store.set(WATCHLIST_STORAGE_KEY, JSON.stringify({ mint: MINT_A }));
    expect(readLocalWatchlist()).toEqual([]);
  });
});

describe("watchlistRows", () => {
  it("prefers the indexed answer over the bootstrapped token list", () => {
    const rows = watchlistRows([MINT_A], [coin(MINT_A, { priceSol: 0.009 })], [token(MINT_A)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.coin?.priceSol).toBe(0.009);
  });

  it("falls back to the bootstrapped list when there is no session", () => {
    const rows = watchlistRows([MINT_A], [], [token(MINT_A)]);
    expect(rows[0]!.coin?.priceSol).toBe(0.002);
    // The token list has no honest 24h change for this coin, so the row keeps null rather than 0.
    expect(rows[0]!.coin?.change24h).toBeNull();
  });

  it("reports a mint neither source knows as unknown", () => {
    const rows = watchlistRows([MINT_C], [], []);
    expect(rows[0]!.mint).toBe(MINT_C);
    expect(rows[0]!.coin).toBeNull();
  });

  it("keeps the list own order", () => {
    const rows = watchlistRows([MINT_C, MINT_A], [coin(MINT_A)], []);
    expect(rows.map((row) => row.mint)).toEqual([MINT_C, MINT_A]);
  });
});

describe("tokenToWatchlistCoin", () => {
  it("carries the curve state across without inventing a change", () => {
    const adapted = tokenToWatchlistCoin(token(MINT_A), 1_700_000_123);
    expect(adapted.venue).toBe("curve");
    expect(adapted.graduated).toBe(false);
    expect(adapted.mining.cap).toBe(1_000);
    expect(adapted.mining.unpaid).toBe(9);
    expect(adapted.change24h).toBeNull();
    expect(adapted.addedAt).toBe(1_700_000_123);
  });

  it("reports a graduated market as a pool venue", () => {
    const graduated = token(MINT_A, {
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
    });
    expect(tokenToWatchlistCoin(graduated, 0).venue).toBe("pool");
    expect(tokenToWatchlistCoin(graduated, 0).graduated).toBe(true);
  });
});
