/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519.js";
import { MINING_RESERVE, TOKEN_SCALE, type GameCoin, type GameServices } from "./contracts";
import type { RuntimeEnv } from "../env";
import { accrueMining, discoveryId, isPortfolioEligible, releasedMiningAllocation } from "./rules";
import { ensurePlayerMine, getPlayerGameStateDetail, handleActivate, handleActivationChallenge, handleClaimAll, handleClaimAllConfirm, settleMining, settlePlayerMining } from "./service";
import { MemoryGameStore, mineConservation, starterCrew } from "./store";

const MINT = "So11111111111111111111111111111111111111112";
const WALLET = "11111111111111111111111111111111";
// Confirmation is stubbed here, but request validation must still receive a real 64-byte Solana
// transaction signature rather than a 32-byte wallet address.
const SIGNATURE = bs58.encode(Uint8Array.from({ length: 64 }, (_, index) => index + 1));

function coin(startsAt: number, graduated = false) {
  return { mint: MINT, symbol: "D", name: "Diggo", createdAt: startsAt, miningStartsAt: startsAt, graduated };
}

function gameContext(store: MemoryGameStore, coinSource: GameCoin | readonly GameCoin[], now: number, env: unknown = {}) {
  const coins = Array.isArray(coinSource) ? coinSource : [coinSource as GameCoin];
  const services: GameServices = {
    coins: {
      async listActiveMines() { return coins; },
      async getMine(mint) { return coins.find((entry) => entry.mint === mint) ?? null; },
    },
    payout: {
      async prepare() { throw new Error("not used"); },
      async confirm() { return false; },
      async prepareBatch() { throw new Error("not used"); },
      async confirmBatch() { return []; },
    },
  };
  return { env: env as never, services, store, now: () => now };
}

/** A request carrying a bearer session, so the handlers see the wallet it resolves to. */
function sessionRequest(wallet: string, body: unknown = {}): Request {
  return new Request("https://diggo.fun/api/game/claim/all", {
    method: "POST",
    headers: { authorization: `Bearer session-${wallet}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

type SqlValue = string | number | bigint | null;
function bindable(values: readonly unknown[]): SqlValue[] {
  return values.map((value) => value === undefined ? null : typeof value === "number" && Number.isSafeInteger(value) ? BigInt(value) : value as SqlValue);
}
class Statement {
  constructor(private db: DatabaseSync, private sql: string, private values: readonly SqlValue[] = []) {}
  bind(...values: unknown[]) { return new Statement(this.db, this.sql, bindable(values)); }
  async first<T>() { return (this.db.prepare(this.sql).get(...this.values) as T | undefined) ?? null; }
  async all<T>() { return { results: this.db.prepare(this.sql).all(...this.values) as T[], success: true, meta: { changes: 0 } }; }
  async run() { const result = this.db.prepare(this.sql).run(...this.values); return { success: true, meta: { changes: Number(result.changes) } }; }
}
class D1 {
  constructor(readonly db: DatabaseSync) {}
  prepare(sql: string) { return new Statement(this.db, sql); }
  async batch(statements: readonly Statement[]) { return Promise.all(statements.map((statement) => statement.run())); }
}
class KV {
  private values = new Map<string, string>();
  async get(key: string, type?: string) {
    const value = this.values.get(key) ?? null;
    return type === "json" && value !== null ? JSON.parse(value) : value;
  }
  async put(key: string, value: string) { this.values.set(key, value); }
  async delete(key: string) { this.values.delete(key); }
}
function authenticatedEnv(wallet: string) {
  const db = new DatabaseSync(":memory:");
  const directory = fileURLToPath(new URL("../../migrations/", import.meta.url));
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(directory, file), "utf8"));
  }
  const env = { DB: new D1(db), TOKEN_CACHE: new KV(), CHAIN_MODE: "meteora" } as unknown as RuntimeEnv;
  const cache = env.TOKEN_CACHE as unknown as KV;
  return { env, put: (key: string, value: string) => cache.put(key, value), wallet };
}

describe("off-chain game rules", () => {
  it("releases the 200M reserve lazily and never beyond the cap", () => {
    const start = 1_000_000;
    const half = start + 3_650 * 86_400 / 2;
    expect(releasedMiningAllocation(start, start)).toBe(0n);
    expect(releasedMiningAllocation(half, start)).toBe(MINING_RESERVE / 2n);
    expect(releasedMiningAllocation(start + 3_650 * 86_400 * 100, start)).toBe(MINING_RESERVE);
  });

  it("accrues proportionally with integer rounding", () => {
    const result = accrueMining({
      mine: coin(0), wallet: WALLET, now: 2, lastSettledAt: 1, assignedPower: 1, totalEligiblePower: 3,
      releasedBefore: 0n, releasedNow: 10n, claimableBefore: 2n, reserveRemainingBefore: MINING_RESERVE,
      committedBefore: 0n,
    });
    expect(result.claimable).toBe(5n);
    expect(result.committed).toBe(3n);
    expect(result.reserveRemaining).toBe(MINING_RESERVE - 3n);
  });

  it("keeps claims idempotent and pending until payout", async () => {
    const store = new MemoryGameStore();
    await store.ensurePlayer(WALLET, 0, starterCrew());
    const mine = await store.ensureMine(MINT, 0, 1, 1);
    await store.saveMine({ ...mine, released: 10n, committed: 10n, remaining: MINING_RESERVE - 10n }, 0);
    await store.saveBalance({ wallet: WALLET, mint: MINT, claimable: 10n, lastSettledAt: 2 }, 0n);
    const claim = { id: "claim-1", wallet: WALLET, mint: MINT, amount: 10n, kind: "MINING" as const, status: "PENDING" as const, signature: null, createdAt: 3 };
    expect(await store.createClaim(claim, 10n)).toMatchObject({ status: "PENDING" });
    expect(await store.createClaim(claim, 10n)).toMatchObject({ status: "PENDING" });
    expect((await store.getBalance(WALLET, MINT)).claimable).toBe(0n);
    expect(store.claims.size).toBe(1);
    expect(await store.markClaimPaid(claim.id, "sig")).toBe(true);
    expect((await store.getClaim(claim.id))?.status).toBe("PAID");
    expect((await store.getMine(MINT))?.paid).toBe(10n);
  });

  it("never lets outstanding balances plus paid exceed committed", async () => {
    const store = new MemoryGameStore();
    const mine = await store.ensureMine(MINT, 0, 1, 1);
    await store.saveMine({ ...mine, released: 100n, committed: 100n, remaining: MINING_RESERVE - 100n }, 0);
    const saved = (await store.getMine(MINT))!;
    expect(mineConservation(saved, 0n, 0n)).toBe(true);
    expect(saved.committed).toBeLessThanOrEqual(MINING_RESERVE);
  });

  it("applies referral caps and deterministic discovery seeds", async () => {
    const store = new MemoryGameStore();
    for (let i = 0; i < 25; i += 1) {
      expect(await store.applyReferralCredit({ id: `r${i}`, referrer: "ref", referee: `user${i}`, amount: 250, week: 1, createdAt: i })).toBe(true);
    }
    expect(await store.applyReferralCredit({ id: "r25", referrer: "ref", referee: "user25", amount: 250, week: 1, createdAt: 25 })).toBe(false);
    expect(await store.applyReferralCredit({ id: "r-over", referrer: "ref", referee: "user-over", amount: 251, week: 2, createdAt: 26 })).toBe(false);
    expect(discoveryId({ secret: "s", epoch: 1, wallet: WALLET })).toBe(discoveryId({ secret: "s", epoch: 1, wallet: WALLET }));
    expect(isPortfolioEligible(10)).toBe(true);
    expect(isPortfolioEligible(9.99)).toBe(false);
    expect(TOKEN_SCALE).toBe(1_000_000_000n);
  });

  it("uses all currently active, activated power instead of a stale first-miner denominator", async () => {
    const store = new MemoryGameStore();
    const startsAt = 1_000;
    const now = startsAt + 3_650 * 86_400;
    const first = await store.ensurePlayer(WALLET, 0, starterCrew());
    const second = { ...first, wallet: "22222222222222222222222222222222", activeMine: MINT, activatedAt: startsAt, activeUntil: now + 100, activeMiningPower: 2 };
    await store.savePlayer({ ...first, activeMine: MINT, activatedAt: startsAt, activeUntil: now + 100, activeMiningPower: 2 }, 0);
    await store.ensurePlayer(second.wallet, 0, starterCrew());
    await store.savePlayer(second, 0);
    const half = startsAt + 3_650 * 86_400 / 2;
    const staleMine = await store.ensureMine(MINT, startsAt, 2, startsAt);
    const halfReleased = releasedMiningAllocation(half, startsAt);
    expect(await store.saveMine({ ...staleMine, released: halfReleased, committed: halfReleased, remaining: MINING_RESERVE - halfReleased }, 0)).toBe(true);
    await store.saveBalance({ wallet: second.wallet, mint: MINT, claimable: 0n, lastSettledAt: half }, 0n);
    await settleMining(gameContext(store, coin(startsAt), now), second, coin(startsAt));
    expect((await store.getBalance(second.wallet, MINT)).claimable).toBeGreaterThan(0n);
    expect((await store.getMine(MINT))?.totalEligiblePower).toBe(4);
  });

  it("excludes inactive, not-yet-activated and non-positive power from the denominator", async () => {
    const store = new MemoryGameStore();
    const startsAt = 1_000;
    const now = startsAt + 10;
    const base = await store.ensurePlayer(WALLET, 0, starterCrew());
    await store.savePlayer({ ...base, activeMine: MINT, activatedAt: startsAt, activeUntil: now + 100, activeMiningPower: 3 }, 0);
    for (const state of [
      { ...base, wallet: "22222222222222222222222222222222", activeMine: MINT, activatedAt: startsAt, activeUntil: now - 1, activeMiningPower: 100 },
      { ...base, wallet: "33333333333333333333333333333333", activeMine: MINT, activatedAt: now + 1, activeUntil: now + 100, activeMiningPower: 100 },
      { ...base, wallet: "44444444444444444444444444444444", activeMine: MINT, activatedAt: startsAt, activeUntil: now + 100, activeMiningPower: 0 },
    ]) {
      await store.ensurePlayer(state.wallet, 0, starterCrew());
      await store.savePlayer(state, 0);
    }
    expect(await store.getEligiblePower(MINT, now)).toBe(3);
  });

  it("assigns a mine during ordinary activation and later accrues its memecoin", async () => {
    const store = new MemoryGameStore();
    const now = 1_000_000;
    const later = now + 1_000;
    const secretKey = ed25519.utils.randomSecretKey();
    const wallet = bs58.encode(ed25519.getPublicKey(secretKey));
    const launched = { ...coin(now - 10_000), mint: MINT };
    const { env, put } = authenticatedEnv(wallet);
    await put(`auth:session:session-${wallet}`, wallet);
    await store.ensurePlayer(wallet, now - 1_000, starterCrew());
    const challengeContext = gameContext(store, launched, now, env);
    const challengeResponse = await handleActivationChallenge(challengeContext, new Request("https://diggo.fun/api/game/activation-challenge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet }),
    }));
    expect(challengeResponse.status).toBe(200);
    const challenge = await challengeResponse.json() as { nonce: string; message: string };
    const signature = bs58.encode(ed25519.sign(new TextEncoder().encode(challenge.message), secretKey));
    const activateContext = gameContext(store, launched, now, env);
    const response = await handleActivate(activateContext, sessionRequest(wallet, { nonce: challenge.nonce, signature }));
    expect(response.status).toBe(200);
    const body = await response.json() as { player: { activeMine: string | null; activeMiningPower: number } };
    expect(body.player.activeMine).toBe(MINT);
    expect(body.player.activeMiningPower).toBeGreaterThan(0);
    expect((await store.getBalance(wallet, MINT)).lastSettledAt).toBe(now);

    await settlePlayerMining(gameContext(store, launched, later, env), (await store.getPlayer(wallet))!);
    expect((await store.getBalance(wallet, MINT)).claimable).toBeGreaterThan(0n);
  });

  it("keeps a viable server assignment across repeated settlement calls", async () => {
    const store = new MemoryGameStore();
    const now = 2_000;
    const first = { ...coin(now - 100), mint: MINT };
    const second = { ...coin(now - 100), mint: "22222222222222222222222222222222" };
    const player = await store.ensurePlayer(WALLET, now - 1_000, starterCrew());
    await store.savePlayer({ ...player, activeMine: first.mint, activeMiningPower: 100, activatedAt: now - 10, activeUntil: now + 1_000 }, 0);
    const context = gameContext(store, [first, second], now);
    const assigned = await ensurePlayerMine(context, (await store.getPlayer(WALLET))!);
    expect(assigned.activeMine).toBe(first.mint);
    expect((await settlePlayerMining(context, assigned)).activeMine).toBe(first.mint);
    expect((await settlePlayerMining(context, (await store.getPlayer(WALLET))!)).activeMine).toBe(first.mint);
  });

  it("moves to an eligible fallback when the current mine is exhausted or graduated", async () => {
    const store = new MemoryGameStore();
    const now = 3_000;
    const exhausted = { ...coin(now - 100), mint: MINT };
    const fallback = { ...coin(now - 100), mint: "22222222222222222222222222222222" };
    const player = await store.ensurePlayer(WALLET, now - 1_000, starterCrew());
    await store.savePlayer({ ...player, activeMine: exhausted.mint, activeMiningPower: 100, activatedAt: now - 10, activeUntil: now + 1_000 }, 0);
    const ledger = await store.ensureMine(exhausted.mint, exhausted.miningStartsAt, 100, now);
    await store.saveMine({ ...ledger, released: MINING_RESERVE, committed: MINING_RESERVE, remaining: 0n }, 0);
    const context = gameContext(store, [exhausted, fallback], now);
    const moved = await ensurePlayerMine(context, (await store.getPlayer(WALLET))!);
    expect(moved.activeMine).toBe(fallback.mint);
    expect(moved.activeMiningPower).toBeGreaterThan(0);

    const graduated = { ...fallback, graduated: true };
    await store.savePlayer({ ...moved, activeMine: fallback.mint, activeMiningPower: 100 }, await store.playerVersion(WALLET));
    const afterGraduation = await ensurePlayerMine(gameContext(store, [exhausted, graduated], now), (await store.getPlayer(WALLET))!);
    expect(afterGraduation.activeMine).toBeNull();
    expect(afterGraduation.activeMiningPower).toBe(0);
  });

  it("uses unbiased server selection instead of a fixed mine order", async () => {
    const store = new MemoryGameStore();
    const now = 4_000;
    const first = { ...coin(now - 100), mint: MINT };
    const second = { ...coin(now - 100), mint: "22222222222222222222222222222222" };
    const random = vi.spyOn(crypto, "getRandomValues");
    try {
      for (const [index, value] of [0, 1].entries()) {
        random.mockImplementationOnce((values) => {
          (values as Uint32Array)[0] = value;
          return values;
        });
        const wallet = `${index + 3}`.repeat(32).slice(0, 32);
        const player = await store.ensurePlayer(wallet, now - 1_000, starterCrew());
        await store.savePlayer({ ...player, activatedAt: now - 10, activeUntil: now + 1_000 }, 0);
        const assigned = await ensurePlayerMine(gameContext(store, [first, second], now), (await store.getPlayer(wallet))!);
        expect(assigned.activeMine).toBe(index === 0 ? first.mint : second.mint);
      }
    } finally {
      random.mockRestore();
    }
  });

  it("returns wallet-wide reward balances with coin names for Discoveries", async () => {
    const store = new MemoryGameStore();
    await store.ensurePlayer(WALLET, 0, starterCrew());
    await store.saveBalance({ wallet: WALLET, mint: MINT, claimable: TOKEN_SCALE * 3n, lastSettledAt: 1 }, 0n);
    const state = await getPlayerGameStateDetail(gameContext(store, coin(1, true), 2), WALLET);
    expect(state.balances).toEqual([expect.objectContaining({ mint: MINT, name: "Diggo", symbol: "D", claimable: (TOKEN_SCALE * 3n).toString(), amountWhole: 3 })]);
    expect(state.claimAll).toEqual({ supported: true, count: 1, signatures: 1, maxItems: 12 });
  });

  it("prepares one signature for every accrued mint and names each discovery reward", async () => {
    const store = new MemoryGameStore();
    const now = 500;
    const { env, put } = authenticatedEnv(WALLET);
    await put(`auth:session:session-${WALLET}`, WALLET);
    await store.ensurePlayer(WALLET, 0, starterCrew());
    await store.saveBalance({ wallet: WALLET, mint: MINT, claimable: TOKEN_SCALE * 4n, lastSettledAt: 100 }, 0n);
    const other = "22222222222222222222222222222222";
    await store.ensurePlayer(other, 0, starterCrew());
    await store.saveBalance({ wallet: other, mint: MINT, claimable: TOKEN_SCALE * 2n, lastSettledAt: 100 }, 0n);
    // A reserved discovery reward must reach the player in the same batch as mined balances.
    await store.ensureMine(MINT, 1, 1, 1);
    await store.createDiscovery({ id: "d1", wallet: WALLET, mint: MINT, amount: 1_000_000n, claimId: "discovery:1", epoch: 1, createdAt: 200 }, MINING_RESERVE);

    const prepared: unknown[] = [];
    const context = gameContext(store, coin(1, true), now, env);
    context.services.payout.prepareBatch = async (wallet, items) => {
      prepared.push(...items);
      return { id: "batch-1", transaction: "base64", expiresAt: 590, items };
    };
    const response = await handleClaimAll(context, sessionRequest(WALLET));
    expect(response.status).toBe(200);
    const body = await response.json() as { batch: { id: string; expiresAt: string }; items: { claimIds: string[]; name: string; amountWhole: string }[]; signatureCount: number; totalItems: number; remainingItems: number; complete: boolean };
    expect(body.signatureCount).toBe(1);
    // The second player's balance is never touched: the batch is scoped to the session wallet.
    expect((await store.getBalance(other, MINT)).claimable).toBe(TOKEN_SCALE * 2n);
    // One transfer for the mint settles both the mined balance and the discovery reward together.
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.claimIds.sort()).toEqual(["claimall:" + WALLET + ":" + MINT + ":100", "discovery:1"]);
    // 4 mined + 0.001 discovery, summed into a single transfer.
    expect(Number(body.items[0]!.amountWhole)).toBeCloseTo(4.001, 6);
    expect(body.batch.expiresAt).toMatch(/^\d+$/);
    expect({ totalItems: body.totalItems, remainingItems: body.remainingItems, complete: body.complete }).toEqual({ totalItems: 1, remainingItems: 0, complete: true });
    for (const item of body.items) {
      expect(item.name).toBe("Diggo");
    }
    expect(prepared).toHaveLength(1);
  });

  it("settles every claim in a confirmed batch and leaves an unconfirmed batch unpaid", async () => {
    const store = new MemoryGameStore();
    const now = 500;
    const { env, put } = authenticatedEnv(WALLET);
    await put(`auth:session:session-${WALLET}`, WALLET);
    await store.ensurePlayer(WALLET, 0, starterCrew());
    await store.saveBalance({ wallet: WALLET, mint: MINT, claimable: TOKEN_SCALE * 3n, lastSettledAt: 100 }, 0n);
    const mine = await store.ensureMine(MINT, 1, 1, 1);
    const committed = TOKEN_SCALE * 4n;
    expect(await store.saveMine({ ...mine, released: committed, committed, remaining: MINING_RESERVE - committed }, 0)).toBe(true);
    await store.createDiscovery({ id: "d1", wallet: WALLET, mint: MINT, amount: 1_000_000n, claimId: "discovery:1", epoch: 1, createdAt: 200 }, MINING_RESERVE - committed);
    const context = gameContext(store, coin(1, true), now, env);
    await handleClaimAll(context, sessionRequest(WALLET));
    const claims = (await store.listClaims(WALLET, 10)).sort((a, b) => a.id.localeCompare(b.id));
    expect(claims.every((claim) => claim.status === "PENDING")).toBe(true);

    // Chain has not confirmed yet: the player must not be shown as paid.
    context.services.payout.confirmBatch = async () => [];
    const pending = await handleClaimAllConfirm(context, sessionRequest(WALLET, { batchId: "b", signature: SIGNATURE }));
    expect(pending.status).toBe(200);
    expect((await pending.json() as { claims: unknown[] }).claims).toEqual([]);
    expect((await store.listClaims(WALLET, 10)).every((claim) => claim.status === "PENDING")).toBe(true);

    context.services.payout.confirmBatch = async () => [{ claimIds: claims.map((claim) => claim.id), mint: MINT, amount: TOKEN_SCALE * 3n + 1_000_000n }];
    const settled = await handleClaimAllConfirm(context, sessionRequest(WALLET, { batchId: "b", signature: SIGNATURE }));
    expect(settled.status).toBe(200);
    const body = await settled.json() as { batch: { status: string }; claims: { claimId: string; status: string; name: string; amountWhole: string }[] };
    expect(body.batch.status).toBe("SETTLED");
    expect(body.claims).toHaveLength(2);
    expect(body.claims.every((claim) => claim.status === "PAID" && claim.name === "Diggo")).toBe(true);
    // Conservation: what left the balances is exactly what the mine recorded as paid.
    const settledMine = await store.getMine(MINT);
    expect((await store.getBalance(WALLET, MINT)).claimable).toBe(0n);
    expect(settledMine?.paid).toBe(TOKEN_SCALE * 3n + 1_000_000n);
  });

  it("pays one explicit slice and reports the continuation when a wallet exceeds the item ceiling", async () => {
    const store = new MemoryGameStore();
    const now = 500;
    const { env, put } = authenticatedEnv(WALLET);
    await put(`auth:session:session-${WALLET}`, WALLET);
    const prepared: unknown[] = [];
    const mines = Array.from({ length: 13 }, (_, index) => ({ ...coin(1), mint: `${index}`.repeat(43).slice(0, 44) }));
    await store.ensurePlayer(WALLET, 0, starterCrew());
    for (const entry of mines) await store.saveBalance({ wallet: WALLET, mint: entry.mint, claimable: TOKEN_SCALE, lastSettledAt: 1 }, 0n);
    const base = gameContext(store, coin(1, true), now, env);
    const context = {
      ...base,
      services: {
        ...base.services,
        coins: { async listActiveMines() { return mines; }, async getMine(mint: string) { return mines.find((entry) => entry.mint === mint) ?? null; } },
        payout: { ...base.services.payout, async prepareBatch(_w: string, items: { claimIds: string[]; mint: string; amount: bigint }[]) { prepared.push(...items); return { id: "batch-1", transaction: "base64", expiresAt: 590, items }; } },
      },
    };
    const response = await handleClaimAll(context, sessionRequest(WALLET));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ totalItems: 13, remainingItems: 1, complete: false });
    expect(prepared).toHaveLength(12);
  });
});
