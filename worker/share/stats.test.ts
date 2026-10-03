/** Share card numbers, read through every migration in SQLite the way D1 runs them. */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import type { RuntimeEnv } from "../env";
import { shareStats, walletForShareCode } from "./stats";

type SqlValue = string | number | bigint | null | Uint8Array;
const bindable = (values: readonly unknown[]): SqlValue[] =>
  values.map((value) => (typeof value === "number" && Number.isSafeInteger(value) ? BigInt(value) : (value ?? null) as SqlValue));

class Statement {
  constructor(private readonly db: DatabaseSync, private readonly sql: string, private readonly bound: SqlValue[] = []) {}
  bind(...values: unknown[]) { return new Statement(this.db, this.sql, bindable(values)); }
  async first<T>() { return (this.db.prepare(this.sql).get(...this.bound) as T | undefined) ?? null; }
  async all<T>() { return { results: this.db.prepare(this.sql).all(...this.bound) as T[] }; }
  async run() { const info = this.db.prepare(this.sql).run(...this.bound); return { success: true, meta: { changes: Number(info.changes) } }; }
}

const WALLET = "7XqAYxzX8rdiZUFMXpveryvaWpmp327TNAEpPUsEA4nL";
const MOLE = "MoLe1111111111111111111111111111111111111111";
const ROCK = "RoCk1111111111111111111111111111111111111111";

describe("share stats", () => {
  let db: DatabaseSync;
  let env: RuntimeEnv;
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    const directory = fileURLToPath(new URL("../../migrations/", import.meta.url));
    for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) db.exec(readFileSync(join(directory, file), "utf8"));
    env = { DB: { prepare: (sql: string) => new Statement(db, sql) } } as unknown as RuntimeEnv;
    db.prepare("INSERT INTO referral_codes (code, wallet, created_at) VALUES ('digger', ?, 0)").run(WALLET);
  });

  it("finds the wallet behind a code, case-insensitively, and rejects junk", async () => {
    expect(await walletForShareCode(env, "DIGGER")).toEqual({ wallet: WALLET, code: "digger" });
    expect(await walletForShareCode(env, "nobody")).toBeNull();
    expect(await walletForShareCode(env, "../../etc")).toBeNull();
    expect(await walletForShareCode(env, "")).toBeNull();
  });

  it("adds what is in the mine, in a claim and paid out, per coin, and picks the biggest", async () => {
    const pool = db.prepare("INSERT INTO meteora_pools (pool, config, creator, base_mint, base_vault, quote_mint, symbol, decimals) VALUES (?, 'c', 'k', ?, 'v', 'q', ?, ?)");
    pool.run("pool-mole", MOLE, "MOLE", 6);
    pool.run("pool-rock", ROCK, "ROCK", 9);
    db.prepare("INSERT INTO game_players (wallet, created_at, ore_earned, longest_streak) VALUES (?, 0, '4320', 12)").run(WALLET);
    db.prepare("INSERT INTO game_balances (wallet, mint, claimable) VALUES (?, ?, '2000000000')").run(WALLET, MOLE); // 2,000 MOLE
    db.prepare("INSERT INTO game_balances (wallet, mint, claimable) VALUES (?, ?, '1500000000000')").run(WALLET, ROCK); // 1,500 ROCK
    const claim = db.prepare("INSERT INTO game_claims (id, wallet, mint, kind, amount, status, idempotency_key, created_at) VALUES (?, ?, ?, 'MINING', ?, ?, ?, 0)");
    claim.run("c1", WALLET, MOLE, "1000000000", "PAID", "c1"); // +1,000 MOLE already paid out
    claim.run("c2", WALLET, ROCK, "500000000000", "PENDING", "c2"); // +500 ROCK on its way out (left the balance)

    const stats = await shareStats(env, WALLET);
    expect(stats.top).toEqual({ symbol: "MOLE", amount: 3000 });
    expect(stats.coins).toBe(2);
    expect(stats.oreEarned).toBe(4320);
    expect(stats.longestStreak).toBe(12);
    expect(stats.username).toBeNull();
    expect(stats.bot).toBeNull();
  });

  it("is an empty card for a wallet that never mined", async () => {
    expect(await shareStats(env, WALLET)).toMatchObject({ top: null, coins: 0, oreEarned: 0, longestStreak: 0 });
  });
});
