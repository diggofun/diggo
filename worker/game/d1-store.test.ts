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

  it("dispatches discovery through the migration trigger and preserves idempotency", async () => {
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
    expect(await store.applyReferralCredit({ id: "ref-over", referrer: REFERRER, referee: "referee-over", amount: 251, week: 2, createdAt: 26 })).toBe(false);
    expect(await store.referralWeekTotals(REFERRER, 1)).toEqual({ count: 25, ore: 6250 });
    expect((await store.getPlayer(REFERRER))?.oreBalance).toBe(6250);
  });
});
