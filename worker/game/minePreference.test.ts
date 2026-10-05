import { describe, expect, it } from "vitest";
import type { GameCoin, GamePlayerState, GameServices } from "./contracts";
import { ensurePlayerMine, settlePlayerMining, type GameHandlerContext } from "./service";
import { MemoryGameStore, starterCrew } from "./store";

const A = "So11111111111111111111111111111111111111112";
const B = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const ALICE = "11111111111111111111111111111111";
const DAY = 86_400;
const T0 = 1_790_361_719;

const coin = (mint: string, graduated = false): GameCoin => ({ mint, symbol: mint.slice(0, 3), name: mint, createdAt: T0 - DAY, miningStartsAt: T0 - DAY, graduated });

function context(store: MemoryGameStore, coins: GameCoin[], now: number): GameHandlerContext {
  const services: GameServices = {
    coins: { async listActiveMines() { return coins.filter((entry) => !entry.graduated); }, async getMine(mint) { return coins.find((entry) => entry.mint === mint) ?? null; } },
    payout: {
      async prepare() { throw new Error("not used"); },
      async confirm() { return false; },
      async prepareBatch() { throw new Error("not used"); },
      async confirmBatch() { return []; },
      async vaultInventory() { return null; },
    },
  };
  return { env: {} as never, services, store, now: () => now };
}

/** Alice on a shift that started at T0, digging A since then. */
async function onShift(store: MemoryGameStore): Promise<GamePlayerState> {
  const created = await store.ensurePlayer(ALICE, T0 - 30 * DAY, starterCrew());
  const player: GamePlayerState = { ...created, activatedAt: T0, activeUntil: T0 + DAY, lastActivationAt: T0, lastOreAt: T0, activeMine: A, activeMiningPower: 100 };
  expect(await store.savePlayer(player, await store.playerVersion(ALICE))).toBe(true);
  await store.saveBalance({ wallet: ALICE, mint: A, claimable: 0n, lastSettledAt: T0 }, 0n);
  return (await store.getPlayer(ALICE))!;
}

describe("mine links", () => {
  it("moves the crew to the linked mine, paying the old one up to now and starting the new one now", async () => {
    const store = new MemoryGameStore();
    const now = T0 + 3_600;
    await onShift(store);
    // An old balance row on B from an earlier shift must not be paid again for the time spent on A.
    await store.saveBalance({ wallet: ALICE, mint: B, claimable: 5n, lastSettledAt: T0 - 10 * DAY }, 0n);
    await store.setPreferredMine(ALICE, B);
    const ctx = context(store, [coin(A), coin(B)], now);
    await settlePlayerMining(ctx, (await store.getPlayer(ALICE))!);
    const player = (await store.getPlayer(ALICE))!;
    expect(player.activeMine).toBe(B);
    expect((await store.getBalance(ALICE, A)).lastSettledAt).toBe(now);
    expect((await store.getBalance(ALICE, A)).claimable).toBeGreaterThan(0n);
    expect(await store.getBalance(ALICE, B)).toMatchObject({ claimable: 5n, lastSettledAt: now });
  });

  it("keeps the current mine when the linked one is closed", async () => {
    const store = new MemoryGameStore();
    await onShift(store);
    await store.setPreferredMine(ALICE, B);
    const player = await ensurePlayerMine(context(store, [coin(A), coin(B, true)], T0 + 60), (await store.getPlayer(ALICE))!);
    expect(player.activeMine).toBe(A);
  });

  it("assigns the linked mine to a crew without one", async () => {
    const store = new MemoryGameStore();
    const shift = await onShift(store);
    expect(await store.savePlayer({ ...shift, activeMine: null }, await store.playerVersion(ALICE))).toBe(true);
    await store.setPreferredMine(ALICE, B);
    const player = await ensurePlayerMine(context(store, [coin(A), coin(B)], T0 + 60), (await store.getPlayer(ALICE))!);
    expect(player.activeMine).toBe(B);
  });

  it("does nothing outside a shift", async () => {
    const store = new MemoryGameStore();
    await onShift(store);
    await store.setPreferredMine(ALICE, B);
    const player = await ensurePlayerMine(context(store, [coin(A), coin(B)], T0 + 2 * DAY), (await store.getPlayer(ALICE))!);
    expect(player.activeMine).toBe(A);
  });
});
