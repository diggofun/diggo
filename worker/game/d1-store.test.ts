/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MINING_RESERVE } from "./contracts";
import { D1GameStore } from "./d1-store";
import { starterCrew } from "./store";

type SqlValue = string | number | bigint | null;

function bindable(values: readonly unknown[]): SqlValue[] {
  return values.map((value) => {
    if (value === undefined) return null;
    return typeof value === "number" && Number.isSafeInteger(value) ? BigInt(value) : value as SqlValue;
  });
}

class Statement {
  constructor(private readonly db: DatabaseSync, private readonly sql: string, private readonly values: readonly SqlValue[] = []) {}

  bind(...values: unknown[]): Statement {
    return new Statement(this.db, this.sql, bindable(values));
  }

  async first<T>(): Promise<T | null> {
    const statement = this.db.prepare(this.sql);
    statement.setReadBigInts(true);
    return (statement.get(...this.values) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[]; success: true; meta: { changes: number } }> {
    return { results: this.db.prepare(this.sql).all(...this.values) as T[], success: true, meta: { changes: 0 } };
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const result = this.db.prepare(this.sql).run(...this.values);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

class D1 {
  constructor(readonly db: DatabaseSync) {}

  prepare(sql: string): Statement {
    return new Statement(this.db, sql);
  }

  async batch(statements: readonly Statement[]): Promise<Array<{ success: true; meta: { changes: number } }>> {
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

function harness(): D1GameStore {
  const db = new DatabaseSync(":memory:");
  const directory = fileURLToPath(new URL("../../migrations/", import.meta.url));
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(directory, file), "utf8"));
  }
  return new D1GameStore(new D1(db) as unknown as D1Database);
}

const MINT = "So11111111111111111111111111111111111111112";
const WALLET = "11111111111111111111111111111111";
const REFERRER = "22222222222222222222222222222222";

describe("D1 game store", () => {
  it("settles the mine and wallet balance together without exceeding the reserve", async () => {
    const store = harness();
    const mine = await store.ensureMine(MINT, 0, 10, 1);
    const balance = { wallet: WALLET, mint: MINT, claimable: 0n, lastSettledAt: 1 };
    expect(await store.settleMining(
      { ...mine, released: 100n, remaining: MINING_RESERVE - 96n, committed: 96n },
      { ...balance, claimable: 14n, lastSettledAt: 2 },
      mine.version,
      0n,
      2,
    )).toBe(true);
    expect(await store.getBalance(WALLET, MINT)).toMatchObject({ claimable: 14n, lastSettledAt: 2 });
    expect(await store.getMine(MINT)).toMatchObject({ released: 100n, committed: 96n, remaining: MINING_RESERVE - 96n });
  });

  it("keeps settling after the first commitment", async () => {
    // Regression: the ledger guard compared the stored remainder with the full reserve, so every
    // settlement after a mine's first one was rejected and pending balances stopped growing.
    const store = harness();
    let mine = await store.ensureMine(MINT, 0, 10, 1);
    let claimable = 0n;
    for (let step = 1n; step <= 3n; step += 1n) {
      const committed = mine.committed + 50n;
      expect(await store.settleMining(
        { ...mine, released: step * 100n, committed, remaining: MINING_RESERVE - committed },
        { wallet: WALLET, mint: MINT, claimable: claimable + 50n, lastSettledAt: Number(step) },
        mine.version,
        claimable,
        Number(step),
      )).toBe(true);
      claimable += 50n;
      mine = (await store.getMine(MINT))!;
    }
    expect(mine).toMatchObject({ committed: 150n, remaining: MINING_RESERVE - 150n, version: 3 });
    expect(await store.getBalance(WALLET, MINT)).toMatchObject({ claimable: 150n, lastSettledAt: 3 });
    // A stale version is still rejected.
    expect(await store.settleMining(
      { ...mine, released: 400n, committed: 200n, remaining: MINING_RESERVE - 200n },
      { wallet: WALLET, mint: MINT, claimable: 200n, lastSettledAt: 4 },
      mine.version - 1,
      150n,
      4,
    )).toBe(false);
    expect(await store.saveMine({ ...mine, released: 400n, committed: 150n, remaining: MINING_RESERVE - 150n }, mine.version)).toBe(true);
  });

  it("counts only active, already-activated players with positive power", async () => {
    const store = harness();
    const now = 200;
    const base = await store.ensurePlayer(WALLET, 0, starterCrew());
    const players = [
      { ...base, activeMine: MINT, activatedAt: 100, activeUntil: 300, activeMiningPower: 3 },
      { ...base, wallet: "22222222222222222222222222222222", activeMine: MINT, activatedAt: 100, activeUntil: 199, activeMiningPower: 100 },
      { ...base, wallet: "33333333333333333333333333333333", activeMine: MINT, activatedAt: 201, activeUntil: 300, activeMiningPower: 100 },
      { ...base, wallet: "44444444444444444444444444444444", activeMine: MINT, activatedAt: 100, activeUntil: 300, activeMiningPower: 0 },
    ];
    for (const player of players) {
      await store.ensurePlayer(player.wallet, 0, starterCrew());
      await store.savePlayer(player, 0);
    }
    expect(await store.getEligiblePower(MINT, now)).toBe(3);
  });

  it("debits a claim once and keeps it pending until marked paid", async () => {
    const store = harness();
    const mine = await store.ensureMine(MINT, 0, 1, 1);
    await store.settleMining(
      { ...mine, released: 10n, remaining: MINING_RESERVE - 10n, committed: 10n },
      { wallet: WALLET, mint: MINT, claimable: 10n, lastSettledAt: 1 },
      mine.version,
      0n,
      1,
    );
    const claim = { id: "claim-1", wallet: WALLET, mint: MINT, amount: 10n, kind: "MINING" as const, status: "PENDING" as const, signature: null, createdAt: 2 };
    expect(await store.createClaim(claim, 10n)).toMatchObject({ status: "PENDING" });
    expect(await store.createClaim(claim, 10n)).toMatchObject({ status: "PENDING" });
    expect((await store.getBalance(WALLET, MINT)).claimable).toBe(0n);
    expect(await store.markClaimPaid(claim.id, "sig-1")).toBe(true);
    expect(await store.getClaim(claim.id)).toMatchObject({ status: "PAID", signature: "sig-1" });
    expect((await store.getMine(MINT))?.paid).toBe(10n);
  });

  it("dispatches discovery atomically and preserves idempotency", async () => {
    const store = harness();
    await store.ensureMine(MINT, 0, 1, 1);
    const record = { id: "discovery-1", wallet: WALLET, mint: MINT, amount: 1_000_000n, claimId: "discovery-claim-1", epoch: 1, createdAt: 2 };
    expect(await store.createDiscovery(record, MINING_RESERVE)).toMatchObject({ status: "PENDING" });
    expect(await store.createDiscovery(record, MINING_RESERVE - 1_000_000n)).toMatchObject({ status: "PENDING" });
    expect((await store.getMine(MINT))?.committed).toBe(1_000_000n);
    expect((await store.getMine(MINT))?.remaining).toBe(MINING_RESERVE - 1_000_000n);
  });

  it("enforces referral idempotency and both weekly caps", async () => {
    const store = harness();
    await store.ensurePlayer(REFERRER, 1, starterCrew());
    for (let i = 0; i < 25; i += 1) {
      expect(await store.applyReferralCredit({ id: `ref-${i}`, referrer: REFERRER, referee: `referee-${i}`, amount: 250, week: 1, createdAt: i })).toBe(true);
    }
    expect(await store.applyReferralCredit({ id: "ref-25", referrer: REFERRER, referee: "referee-25", amount: 250, week: 1, createdAt: 25 })).toBe(false);
    expect(await store.applyReferralCredit({ id: "ref-3", referrer: REFERRER, referee: "referee-3", amount: 250, week: 1, createdAt: 11 })).toBe(false);
    expect(await store.applyReferralCredit({ id: "ref-3-new", referrer: REFERRER, referee: "referee-3", amount: 250, week: 1, createdAt: 12 })).toBe(false);
    expect(await store.applyReferralCredit({ id: "ref-over", referrer: REFERRER, referee: "referee-over", amount: 251, week: 2, createdAt: 26 })).toBe(false);
    expect(await store.referralWeekTotals(REFERRER, 1)).toEqual({ count: 25, ore: 6250 });
    expect((await store.getPlayer(REFERRER))?.oreBalance).toBe(6250);
  });
});
