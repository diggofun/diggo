import { afterEach, describe, expect, it, vi } from "vitest";
import { MINING_RESERVE, type GameCoin, type GamePlayerState, type GameServices } from "./contracts";
import { MINING_SECONDS, releasedMiningAllocation, settleShiftOre, shiftOreAfter } from "./rules";
import { settleActiveShifts, settleMining, settlePlayerMining, settlePlayerOre, type GameHandlerContext } from "./service";
import { MemoryGameStore, starterCrew } from "./store";

const MINT = "So11111111111111111111111111111111111111112";
const ALICE = "11111111111111111111111111111111";
const BOB = "22222222222222222222222222222222";
const DAY = 86_400;
const T0 = 1_790_361_719;

function coin(startsAt: number): GameCoin {
  return { mint: MINT, symbol: "DIGGO", name: "Diggo", createdAt: startsAt, miningStartsAt: startsAt, graduated: false };
}

function context(store: MemoryGameStore, mine: GameCoin, now?: number): GameHandlerContext {
  const services: GameServices = {
    coins: {
      async listActiveMines() { return [mine]; },
      async getMine(mint) { return mint === mine.mint ? mine : null; },
    },
    payout: {
      async prepare() { throw new Error("not used"); },
      async confirm() { return false; },
      async prepareBatch() { throw new Error("not used"); },
      async confirmBatch() { return []; },
      async vaultInventory() { return null; },
    },
  };
  return { env: {} as never, services, store, ...(now === undefined ? {} : { now: () => now }) };
}

/** A player whose crew was activated at `activatedAt` for one 24h shift on MINT. */
async function activePlayer(store: MemoryGameStore, wallet: string, activatedAt: number, overrides: Partial<GamePlayerState> = {}) {
  const created = await store.ensurePlayer(wallet, activatedAt - 30 * DAY, starterCrew());
  const player: GamePlayerState = {
    ...created,
    activatedAt,
    activeUntil: activatedAt + DAY,
    lastActivationAt: activatedAt,
    lastOreAt: activatedAt,
    streak: 1,
    longestStreak: 1,
    activeDays: 1,
    validActivations: 1,
    activeMine: MINT,
    activeMiningPower: 100,
    ...overrides,
  };
  expect(await store.savePlayer(player, await store.playerVersion(wallet))).toBe(true);
  await store.saveBalance({ wallet, mint: MINT, claimable: 0n, lastSettledAt: activatedAt }, 0n);
  return player;
}

afterEach(() => { vi.useRealTimers(); });

describe("shift ORE settlement", () => {
  it("books the same ORE whether settled every five minutes or once at the end", async () => {
    const stepped = new MemoryGameStore();
    const once = new MemoryGameStore();
    await activePlayer(stepped, ALICE, T0);
    await activePlayer(once, ALICE, T0);
    for (let now = T0 + 300; now <= T0 + DAY; now += 300) await settlePlayerOre(context(stepped, coin(T0), now), (await stepped.getPlayer(ALICE))!);
    await settlePlayerOre(context(once, coin(T0), T0 + DAY), (await once.getPlayer(ALICE))!);
    const a = (await stepped.getPlayer(ALICE))!;
    const b = (await once.getPlayer(ALICE))!;
    // A 30-day-old account at full maturity with a level-1 crew digs 30 ORE per active hour.
    expect(b.oreBalance).toBe(720);
    expect(a.oreBalance).toBe(b.oreBalance);
    expect(a.oreEarned).toBe(720);
    expect(a.lastOreAt).toBe(T0 + DAY);
  });

  it("stops at the end of the shift and books nothing twice", async () => {
    const store = new MemoryGameStore();
    await activePlayer(store, ALICE, T0);
    await settlePlayerOre(context(store, coin(T0), T0 + 3 * DAY), (await store.getPlayer(ALICE))!);
    await settlePlayerOre(context(store, coin(T0), T0 + 4 * DAY), (await store.getPlayer(ALICE))!);
    const player = (await store.getPlayer(ALICE))!;
    expect(player.oreBalance).toBe(720);
    expect(player.lastOreAt).toBe(T0 + DAY);
  });

  it("clamps to storage capacity and reports the overflow", () => {
    const player = { wallet: ALICE, createdAt: T0 - 30 * DAY, activatedAt: T0, activeUntil: T0 + DAY, lastOreAt: T0, oreBalance: 2_000, oreEarned: 2_000, crew: starterCrew() } as GamePlayerState;
    const settled = settleShiftOre(player, T0 + DAY)!;
    expect(settled.oreBalance).toBe(2_340);
    expect(settled.stored).toBe(340);
    expect(settled.overflow).toBe(720 - 340);
  });

  it("ignores rows that still carry millisecond timestamps", () => {
    const player = { wallet: ALICE, createdAt: T0 * 1000, activatedAt: T0 * 1000, activeUntil: T0 * 1000 + DAY, lastOreAt: 0, oreBalance: 0, oreEarned: 0, crew: starterCrew() } as GamePlayerState;
    expect(settleShiftOre(player, T0 + 3_600)).toBeNull();
    expect(shiftOreAfter(player, 3_600)).toBeGreaterThanOrEqual(0);
  });

  it("uses a seconds clock when no test clock is injected", async () => {
    vi.useFakeTimers();
    vi.setSystemTime((T0 + 3_600) * 1000);
    const store = new MemoryGameStore();
    await activePlayer(store, ALICE, T0);
    const settled = await settlePlayerOre(context(store, coin(T0)), (await store.getPlayer(ALICE))!);
    // Before the fix the default clock was Date.now() in milliseconds, which read as "the shift is
    // long over" and booked the whole day after one hour.
    expect(settled.lastOreAt).toBe(T0 + 3_600);
    expect(settled.oreBalance).toBe(30);
  });
});

describe("mining token settlement", () => {
  it("pays a shift that ended while the player was offline, up to the shift end", async () => {
    const store = new MemoryGameStore();
    const mine = coin(T0);
    await activePlayer(store, ALICE, T0);
    await settleMining(context(store, mine, T0 + 2 * DAY), (await store.getPlayer(ALICE))!, mine);
    const balance = await store.getBalance(ALICE, MINT);
    expect(balance.claimable).toBe(releasedMiningAllocation(T0 + DAY, T0));
    expect(balance.claimable).toBe((MINING_RESERVE * BigInt(DAY)) / BigInt(MINING_SECONDS));
    expect(balance.lastSettledAt).toBe(T0 + DAY);
    const ledger = (await store.getMine(MINT))!;
    expect(ledger.committed).toBe(balance.claimable);
    expect(ledger.remaining).toBe(MINING_RESERVE - balance.claimable);
  });

  it("never pays the gap between two shifts", async () => {
    const store = new MemoryGameStore();
    const mine = coin(T0);
    await activePlayer(store, ALICE, T0);
    await settleMining(context(store, mine, T0 + DAY), (await store.getPlayer(ALICE))!, mine);
    const first = (await store.getBalance(ALICE, MINT)).claimable;
    const secondStart = T0 + 3 * DAY;
    const player = (await store.getPlayer(ALICE))!;
    await store.savePlayer({ ...player, activatedAt: secondStart, activeUntil: secondStart + DAY, lastOreAt: secondStart }, await store.playerVersion(ALICE));
    await settleMining(context(store, mine, secondStart + 3_600), (await store.getPlayer(ALICE))!, mine);
    const paid = (await store.getBalance(ALICE, MINT)).claimable - first;
    expect(paid).toBe(releasedMiningAllocation(secondStart + 3_600, T0) - releasedMiningAllocation(secondStart, T0));
  });

  it("splits the release by power between concurrent crews", async () => {
    const store = new MemoryGameStore();
    const mine = coin(T0);
    await activePlayer(store, ALICE, T0);
    await activePlayer(store, BOB, T0);
    const ctx = context(store, mine, T0 + 3_600);
    await settleMining(ctx, (await store.getPlayer(ALICE))!, mine);
    await settleMining(ctx, (await store.getPlayer(BOB))!, mine);
    const hour = releasedMiningAllocation(T0 + 3_600, T0);
    expect((await store.getBalance(ALICE, MINT)).claimable).toBe(hour / 2n);
    expect((await store.getBalance(BOB, MINT)).claimable).toBe(hour / 2n);
  });
});

describe("scheduled shift sweep", () => {
  it("settles offline crews, skips legacy millisecond rows and is idempotent", async () => {
    const store = new MemoryGameStore();
    const mine = coin(T0);
    await activePlayer(store, ALICE, T0);
    const legacy = await store.ensurePlayer(BOB, T0 * 1000, starterCrew());
    await store.savePlayer({ ...legacy, activatedAt: T0 * 1000, activeUntil: T0 * 1000 + DAY, lastActivationAt: T0 * 1000, activeMine: MINT }, await store.playerVersion(BOB));
    const first = await settleActiveShifts(context(store, mine, T0 + 7_200));
    expect(first).toMatchObject({ checked: 1, settled: 1, failed: 0, oreBooked: 60 });
    const alice = (await store.getPlayer(ALICE))!;
    expect(alice.oreBalance).toBe(60);
    expect((await store.getBalance(ALICE, MINT)).claimable).toBe(releasedMiningAllocation(T0 + 7_200, T0));
    const again = await settleActiveShifts(context(store, mine, T0 + 7_200));
    expect(again.oreBooked).toBe(0);
    expect((await store.getPlayer(ALICE))!.oreBalance).toBe(60);
    expect((await store.getPlayer(BOB))!.oreBalance).toBe(0);
    await settlePlayerMining(context(store, mine, T0 + 2 * DAY), (await store.getPlayer(ALICE))!);
    expect(await store.listWalletsToSettle(T0 + 2 * DAY, 10)).toEqual([]);
  });
});

