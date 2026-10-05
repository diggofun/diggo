import { describe, expect, it } from "vitest";
import { coinReserve, isPayableCoin, wholeAmount, type GameCoin, type GamePlayerState, type GameServices } from "./contracts";
import { MINING_SECONDS, releasedMiningAllocation } from "./rules";
import { collectClaimable, discoveryAmount, settleMining, type GameHandlerContext } from "./service";
import { MemoryGameStore, mineConservation, starterCrew } from "./store";
import { sponsoredCoin, type SponsoredMineRow } from "../sponsored";

const MINT = "So11111111111111111111111111111111111111112";
const ALICE = "11111111111111111111111111111111";
const DAY = 86_400;
const T0 = 1_790_361_719;
/** 1,000 whole tokens of a 6-decimal (pump.fun style) mint, released over one day. */
const RESERVE = 1_000n * 1_000_000n;

function row(overrides: Partial<SponsoredMineRow> = {}): SponsoredMineRow {
  return {
    mint: MINT, symbol: "PUMP", name: "Pump Coin", decimals: 6, reserve: RESERVE.toString(), sponsor: "Pump team",
    sponsor_url: null, mining_starts_at: T0, mining_seconds: DAY, status: "ACTIVE", created_at: T0, ...overrides,
  };
}

function context(store: MemoryGameStore, mine: GameCoin, now: number, available = RESERVE): GameHandlerContext {
  const services: GameServices = {
    coins: {
      async listActiveMines() { return [mine]; },
      async getMine(mint) { return mint === mine.mint ? mine : null; },
    },
    wallet: { async walletCreatedAt() { return now - 30 * DAY; } },
    portfolio: { async portfolioUsd() { return 25; } },
    payout: {
      async prepare() { throw new Error("not used"); },
      async confirm() { return false; },
      async prepareBatch() { throw new Error("not used"); },
      async confirmBatch() { return []; },
      async vaultInventory() { return { available, account: null }; },
    },
  };
  return { env: {} as never, services, store, now: () => now };
}

async function activePlayer(store: MemoryGameStore, wallet: string, activatedAt: number) {
  const created = await store.ensurePlayer(wallet, activatedAt - 30 * DAY, starterCrew());
  const player: GamePlayerState = {
    ...created, activatedAt, activeUntil: activatedAt + DAY, lastActivationAt: activatedAt, lastOreAt: activatedAt,
    streak: 1, longestStreak: 1, activeDays: 5, validActivations: 5, activeMine: MINT, activeMiningPower: 100,
  };
  expect(await store.savePlayer(player, await store.playerVersion(wallet))).toBe(true);
  await store.saveBalance({ wallet, mint: MINT, claimable: 0n, lastSettledAt: activatedAt }, 0n);
  return player;
}

describe("sponsored mines", () => {
  it("maps a registered row to a game coin with its own reserve, decimals and period", () => {
    const coin = sponsoredCoin(row());
    expect(coin).toMatchObject({ mint: MINT, sponsored: true, graduated: false, decimals: 6, miningSeconds: DAY, reserve: RESERVE.toString() });
    expect(coinReserve(coin)).toBe(RESERVE);
    // JSON-safe: the coin is sent to the client as is.
    expect(() => JSON.stringify(coin)).not.toThrow();
  });

  it("pays out without graduating, and keeps paying after it is closed", () => {
    expect(isPayableCoin(sponsoredCoin(row()))).toBe(true);
    const closed = sponsoredCoin(row({ status: "CLOSED" }));
    // Closed: no crew is assigned to it any more (the game reads it as graduated), rewards stay payable.
    expect(closed.graduated).toBe(true);
    expect(isPayableCoin(closed)).toBe(true);
    expect(isPayableCoin({ graduated: false })).toBe(false);
    expect(isPayableCoin(null)).toBe(false);
  });

  it("releases the reserve over the mine's own period", () => {
    expect(releasedMiningAllocation(T0 + DAY / 2, T0, RESERVE, DAY)).toBe(RESERVE / 2n);
    expect(releasedMiningAllocation(T0 + 5 * DAY, T0, RESERVE, DAY)).toBe(RESERVE);
    // Without a period it falls back to the launch allocation's ten years.
    expect(releasedMiningAllocation(T0 + DAY, T0, RESERVE)).toBe((RESERVE * BigInt(DAY)) / BigInt(MINING_SECONDS));
    expect(releasedMiningAllocation(T0 + DAY, T0, RESERVE, 0)).toBe((RESERVE * BigInt(DAY)) / BigInt(MINING_SECONDS));
  });

  it("mines against the sponsored reserve and never past it", async () => {
    const store = new MemoryGameStore();
    const coin = sponsoredCoin(row());
    await activePlayer(store, ALICE, T0);
    await settleMining(context(store, coin, T0 + DAY), (await store.getPlayer(ALICE))!, coin);
    const mine = (await store.getMine(MINT))!;
    const balance = await store.getBalance(ALICE, MINT);
    expect(mine.initialReserve).toBe(RESERVE);
    expect(balance.claimable).toBeGreaterThan(0n);
    expect(balance.claimable).toBeLessThanOrEqual(RESERVE);
    expect(mine.remaining).toBe(RESERVE - mine.committed);
    expect(mineConservation(mine, balance.claimable, 0n)).toBe(true);
    // A later settlement cannot mint more than the reserve, however long the gap.
    await settleMining(context(store, coin, T0 + 30 * DAY), (await store.getPlayer(ALICE))!, coin);
    expect((await store.getBalance(ALICE, MINT)).claimable).toBeLessThanOrEqual(RESERVE);
  });

  it("puts a sponsored balance straight into the claim batch, with the mint's decimals", async () => {
    const store = new MemoryGameStore();
    const coin = sponsoredCoin(row());
    const now = T0 + 100;
    await store.ensurePlayer(ALICE, 0, starterCrew());
    await store.saveBalance({ wallet: ALICE, mint: MINT, claimable: 2_500_000n, lastSettledAt: 10 }, 0n);
    const result = await collectClaimable(context(store, coin, now), ALICE, now);
    expect(result.pending).toEqual([]);
    expect(result.items).toEqual([expect.objectContaining({ mint: MINT, amount: 2_500_000n, decimals: 6, symbol: "PUMP" })]);
  });

  it("still holds a sponsored reward the vault cannot cover", async () => {
    const store = new MemoryGameStore();
    const coin = sponsoredCoin(row());
    const now = T0 + 100;
    await store.ensurePlayer(ALICE, 0, starterCrew());
    await store.saveBalance({ wallet: ALICE, mint: MINT, claimable: 2_500_000n, lastSettledAt: 10 }, 0n);
    const result = await collectClaimable(context(store, coin, now, 1n), ALICE, now);
    expect(result.items).toEqual([]);
    expect(result.pending).toEqual([expect.objectContaining({ mint: MINT, reason: "vault_unfunded" })]);
  });

  it("refuses to change a mine's reserve once it exists", async () => {
    const store = new MemoryGameStore();
    const mine = await store.ensureMine(MINT, T0, 1, T0, RESERVE);
    expect(mine.initialReserve).toBe(RESERVE);
    // A second ensure with another reserve returns the existing ledger untouched.
    expect((await store.ensureMine(MINT, T0, 1, T0, RESERVE * 10n)).initialReserve).toBe(RESERVE);
    expect(await store.saveMine({ ...mine, initialReserve: RESERVE * 10n, remaining: RESERVE * 10n }, mine.version)).toBe(false);
    await expect(store.ensureMine("other", T0, 1, T0, 0n)).rejects.toThrow();
  });

  it("scales discoveries and display amounts to the mint's decimals", () => {
    expect(discoveryAmount({ decimals: 9 })).toBe(1_000_000n);
    expect(discoveryAmount({ decimals: 6 })).toBe(1_000n);
    expect(discoveryAmount({ decimals: 0 })).toBe(1n);
    expect(discoveryAmount({})).toBe(1_000_000n);
    expect(wholeAmount(2_500_000n, { decimals: 6 })).toBe(2.5);
    expect(wholeAmount(2_500_000_000n, null)).toBe(2.5);
  });
});
