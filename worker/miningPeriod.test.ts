/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RuntimeEnv } from "./env";
import { MINING_RESERVE, type GameCoin } from "./game/contracts";
import { MINING_SECONDS, miningEndsAt, releasedMiningAllocation, releasedOnSchedule, rescheduleMining } from "./game/rules";
import { applyMiningPeriod } from "./miningPeriod";
import { meteoraCoinSource } from "./modes/meteora";
import type { GameEnv } from "./game/contracts";

const DAY = 86_400;
const T0 = 1_790_000_000;
const MINT = "So11111111111111111111111111111111111111112";
const CREATOR = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const STRANGER = "11111111111111111111111111111111";
const ADMIN = "6HHEkX5MxsoQwyCJZHvLnewmnsaw19vGT9Y8jhqH7GuJ";
const SPONSOR = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const CONFIG = "Cfg1111111111111111111111111111111111111111";

const coin = (schedule?: GameCoin["schedule"]): GameCoin => ({ mint: MINT, symbol: "D", name: "D", createdAt: T0, miningStartsAt: T0, graduated: false, ...(schedule ? { schedule } : {}) });

describe("releasedOnSchedule", () => {
  it("matches the plain linear release when nobody changed the period", () => {
    for (const t of [T0, T0 + DAY, T0 + 400 * DAY, T0 + MINING_SECONDS + 1]) {
      expect(releasedOnSchedule(t, coin(), MINING_RESERVE)).toBe(releasedMiningAllocation(t, T0, MINING_RESERVE));
    }
  });

  it("keeps what was released and spreads the rest over the new period", () => {
    const changeAt = T0 + 10 * DAY;
    const before = releasedOnSchedule(changeAt, coin(), MINING_RESERVE);
    const schedule = rescheduleMining(coin(), MINING_RESERVE, 0n, changeAt, 30);
    const changed = coin(schedule);
    expect(schedule.endsAt).toBe(changeAt + 30 * DAY);
    // Continuous at the change, and nothing before it moves.
    expect(releasedOnSchedule(changeAt, changed, MINING_RESERVE)).toBe(before);
    expect(releasedOnSchedule(T0 + 5 * DAY, changed, MINING_RESERVE)).toBe(releasedOnSchedule(T0 + 5 * DAY, coin(), MINING_RESERVE));
    // Halfway through the new period, half of what was left is out; at the end, all of it.
    expect(releasedOnSchedule(changeAt + 15 * DAY, changed, MINING_RESERVE)).toBe(before + (MINING_RESERVE - before) / 2n);
    expect(releasedOnSchedule(schedule.endsAt, changed, MINING_RESERVE)).toBe(MINING_RESERVE);
    expect(releasedOnSchedule(schedule.endsAt + 99 * DAY, changed, MINING_RESERVE)).toBe(MINING_RESERVE);
    expect(miningEndsAt(changed)).toBe(schedule.endsAt);
  });

  it("never goes down, whether the period is shortened or lengthened, across several changes", () => {
    let current = coin();
    let previous = 0n;
    const changes: [number, number][] = [[3, 7], [5, 3650], [40, 1], [41, 365]];
    for (let t = T0; t <= T0 + 400 * DAY; t += DAY / 4) {
      const due = changes.find(([day]) => T0 + day * DAY === t);
      if (due) current = coin(rescheduleMining(current, MINING_RESERVE, releasedOnSchedule(t, current, MINING_RESERVE), t, due[1]));
      const released = releasedOnSchedule(t, current, MINING_RESERVE);
      expect(released).toBeGreaterThanOrEqual(previous);
      expect(released).toBeLessThanOrEqual(MINING_RESERVE);
      previous = released;
    }
  });

  it("anchors on the ledger when more was already handed out than the curve says", () => {
    const schedule = rescheduleMining(coin(), MINING_RESERVE, 5n * 10n ** 15n, T0 + DAY, 30);
    expect(BigInt(schedule.anchorReleased)).toBe(5n * 10n ** 15n);
    expect(BigInt(rescheduleMining(coin(), 100n, 500n, T0 + DAY, 30).anchorReleased)).toBe(100n);
  });
});

type SqlValue = string | number | bigint | null;
class Statement {
  constructor(private db: DatabaseSync, private sql: string, private values: readonly SqlValue[] = []) {}
  bind(...values: unknown[]) { return new Statement(this.db, this.sql, values.map((value) => value === undefined ? null : value as SqlValue)); }
  async first<T>() { return (this.db.prepare(this.sql).get(...this.values) as T | undefined) ?? null; }
  async all<T>() { return { results: this.db.prepare(this.sql).all(...this.values) as T[], success: true, meta: { changes: 0 } }; }
  async run() { const result = this.db.prepare(this.sql).run(...this.values); return { success: true, meta: { changes: Number(result.changes) } }; }
}
class D1 {
  constructor(readonly db: DatabaseSync) {}
  prepare(sql: string) { return new Statement(this.db, sql); }
  async batch(statements: readonly Statement[]) { return Promise.all(statements.map((statement) => statement.run())); }
}

function environment() {
  const db = new DatabaseSync(":memory:");
  const directory = fileURLToPath(new URL("../migrations/", import.meta.url));
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) db.exec(readFileSync(join(directory, file), "utf8"));
  db.prepare("INSERT INTO meteora_pools (pool, config, creator, base_mint, base_vault, quote_mint, symbol, name, created_at) VALUES (?, ?, ?, ?, 'v', 'q', 'D', 'D', ?)")
    .run("pool1", CONFIG, CREATOR, MINT, T0);
  return { env: { DB: new D1(db), METEORA_DBC_CONFIG: CONFIG, CHAIN_MODE: "meteora" } as unknown as RuntimeEnv, db };
}

describe("applyMiningPeriod", () => {
  it("lets the creator set the period, and the game reads it back", async () => {
    const { env } = environment();
    const result = await applyMiningPeriod(env, { mint: MINT, days: 30, actor: CREATOR, now: T0 + DAY });
    expect(result).toEqual({ ok: true, mint: MINT, days: 30, endsAt: T0 + 31 * DAY });
    const mine = await meteoraCoinSource(env as unknown as GameEnv).getMine(MINT);
    expect(mine?.schedule?.endsAt).toBe(T0 + 31 * DAY);
  });

  it("refuses anyone else, and lets an admin through", async () => {
    const { env } = environment();
    expect(await applyMiningPeriod(env, { mint: MINT, days: 30, actor: STRANGER, now: T0 })).toMatchObject({ ok: false, status: 403 });
    expect(await applyMiningPeriod(env, { mint: MINT, days: 30, actor: ADMIN, now: T0 })).toMatchObject({ ok: true });
  });

  it("allows one change a day", async () => {
    const { env } = environment();
    expect(await applyMiningPeriod(env, { mint: MINT, days: 30, actor: CREATOR, now: T0 + DAY })).toMatchObject({ ok: true });
    expect(await applyMiningPeriod(env, { mint: MINT, days: 7, actor: CREATOR, now: T0 + DAY + 3_600 })).toMatchObject({ ok: false, status: 429 });
    expect(await applyMiningPeriod(env, { mint: MINT, days: 7, actor: CREATOR, now: T0 + 2 * DAY })).toMatchObject({ ok: true, endsAt: T0 + 9 * DAY });
  });

  it("rejects bad periods, unknown mines and graduated coins", async () => {
    const { env, db } = environment();
    for (const days of [0, 3651, 1.5, "abc", null]) {
      expect(await applyMiningPeriod(env, { mint: MINT, days, actor: CREATOR, now: T0 })).toMatchObject({ ok: false, status: 400 });
    }
    expect(await applyMiningPeriod(env, { mint: STRANGER, days: 30, actor: CREATOR, now: T0 })).toMatchObject({ ok: false, status: 404 });
    db.exec("UPDATE meteora_pools SET is_graduated = 1");
    expect(await applyMiningPeriod(env, { mint: MINT, days: 30, actor: CREATOR, now: T0 })).toMatchObject({ ok: false, status: 409 });
  });

  it("lets a sponsored mine's sponsor wallet change it, not the coin's creator", async () => {
    const { env, db } = environment();
    const sponsored = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
    db.prepare("INSERT INTO sponsored_mines (mint, symbol, name, decimals, reserve, sponsor, mining_starts_at, mining_seconds, created_by, created_at, updated_at, sponsor_wallet) VALUES (?, 'S', 'S', 6, '1000000', 'Team', ?, ?, ?, ?, ?, ?)")
      .run(sponsored, T0, 30 * DAY, ADMIN, T0, T0, SPONSOR);
    expect(await applyMiningPeriod(env, { mint: sponsored, days: 7, actor: CREATOR, now: T0 })).toMatchObject({ ok: false, status: 403 });
    expect(await applyMiningPeriod(env, { mint: sponsored, days: 7, actor: SPONSOR, now: T0 + DAY })).toMatchObject({ ok: true, endsAt: T0 + 8 * DAY });
    db.exec("UPDATE sponsored_mines SET status = 'CLOSED'");
    expect(await applyMiningPeriod(env, { mint: sponsored, days: 30, actor: ADMIN, now: T0 + 3 * DAY })).toMatchObject({ ok: false, status: 409 });
  });
});
