/// <reference types="node" />
/**
 * The watchlist endpoints.
 *
 * These run against a real SQLite database with every migration applied in order, so the table the
 * endpoints write is the table `npm run db:local` creates. The claims are the ones the surface is
 * built on: the session decides the wallet, an unindexed mint is refused, the cap is enforced before
 * anything is written, and one wallet cannot see or edit another list.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import bs58 from "bs58";
import type { RuntimeEnv } from "./env";
import { WATCHLIST_MAX, WATCHLIST_WALLET_RATE_LIMIT, watchlistRoute } from "./watchlist";

/** node:sqlite binds a JS number as a REAL; D1 binds a safe integer as an INTEGER. */
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

  /** D1 runs a batch as one transaction, so this double runs each statement without yielding. */
  runSync(): { results: unknown[]; success: boolean; meta: { changes: number } } {
    const results = this.db.prepare(this.sql).all(...this.bound) as unknown[];
    const row = this.db.prepare("SELECT changes() AS c").get() as { c: number } | undefined;
    return { results, success: true, meta: { changes: Number(row?.c ?? 0) } };
  }
}

class SqliteD1 {
  constructor(readonly db: DatabaseSync) {}

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.db, sql);
  }

  async batch(statements: readonly SqliteStatement[]): Promise<unknown[]> {
    this.db.exec("BEGIN");
    try {
      const results = statements.map((statement) => statement.runSync());
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

/** An in-memory TOKEN_CACHE with the TTL semantics the rate limiter and sessions rely on. */
class FakeKv {
  private readonly store = new Map<string, { value: string; expiresAt: number | null }>();

  async get<T>(key: string): Promise<T | string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= Math.floor(Date.now() / 1_000)) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async put(key: string, value: string, options: { expirationTtl?: number } = {}): Promise<void> {
    this.store.set(key, {
      value,
      expiresAt: options.expirationTtl ? Math.floor(Date.now() / 1_000) + options.expirationTtl : null,
    });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

interface Harness {
  db: DatabaseSync;
  env: RuntimeEnv;
  migrations: string[];
}

function harness(): Harness {
  const db = new DatabaseSync(":memory:");
  const directory = fileURLToPath(new URL("../migrations/", import.meta.url));
  const migrations = readdirSync(directory).filter((name) => name.endsWith(".sql")).sort();
  for (const file of migrations) db.exec(readFileSync(join(directory, file), "utf8"));
  const env = { DB: new SqliteD1(db), TOKEN_CACHE: new FakeKv() } as unknown as RuntimeEnv;
  return { db, env, migrations };
}

const WALLET = "So11111111111111111111111111111111111111112";
const OTHER = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const THIRD = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const UNSEEN = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

/** A distinct, valid base58 mint for each index, so a generated list is never silently filtered. */
function mintAt(index: number): string {
  return bs58.encode(new Uint8Array(32).fill(index % 256));
}

async function sessionFor(env: RuntimeEnv, wallet: string): Promise<string> {
  const id = "session-" + wallet.slice(0, 8);
  await (env.TOKEN_CACHE as unknown as FakeKv).put("auth:session:" + id, wallet);
  return id;
}

function call(
  url: string,
  init: { method?: string; session?: string; body?: unknown } = {},
): Request {
  const headers: Record<string, string> = {};
  if (init.session) headers.authorization = "Bearer " + init.session;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return new Request("https://diggo.test" + url, {
    method: init.method ?? "GET",
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

function route(env: RuntimeEnv, pathname: string, init: Parameters<typeof call>[1] = {}): Promise<Response> {
  return watchlistRoute(call(pathname, init), env, pathname);
}

/** One indexed coin, which is the precondition for watching it. */
function seedCoin(
  db: DatabaseSync,
  options: { mint: string; symbol?: string; priceSol?: number; change24h?: number; change24hAt?: number; status?: string },
): void {
  const symbol = options.symbol ?? "TKN";
  db.prepare(
    "INSERT INTO coins (coin, mint, slug, creator, vault, symbol, status)" +
      " VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
  ).run("coin-" + options.mint, options.mint, "slug-" + options.mint, "creator", "vault", symbol, options.status ?? "MiningActive");
  db.prepare(
    "INSERT INTO tokens (mint, coin, slug, name, symbol, creator, status, price_sol, price_usd," +
      " market_cap_usd, change_24h, change_24h_at, reward_per_block)" +
      " VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
  ).run(
    options.mint,
    "coin-" + options.mint,
    "slug-" + options.mint,
    symbol + " coin",
    symbol,
    "creator",
    "MINING_ACTIVE",
    options.priceSol ?? 0.001,
    (options.priceSol ?? 0.001) * 150,
    150_000,
    options.change24h ?? 0,
    options.change24hAt ?? 0,
    12,
  );
}

describe("the watchlist routes", () => {
  it("applies every migration, so the table under test is the one the repo creates", () => {
    const { migrations, db } = harness();
    expect(migrations).toContain("0022_watchlist_portfolio.sql");
    const columns = db.prepare("PRAGMA table_info(watchlist)").all() as { name: string; pk: number }[];
    expect(columns.map((column) => column.name)).toEqual(["wallet", "mint", "added_at"]);
    // A composite primary key, so both columns are part of it.
    expect(columns.filter((column) => column.pk > 0).map((column) => column.name)).toEqual([
      "wallet",
      "mint",
    ]);
  });

  it("refuses every verb without a session", async () => {
    const { env } = harness();
    expect((await route(env, "/api/watchlist")).status).toBe(401);
    expect((await route(env, "/api/watchlist", { method: "POST", body: { mint: WALLET } })).status).toBe(401);
    expect((await route(env, "/api/watchlist/" + WALLET, { method: "DELETE" })).status).toBe(401);
  });

  it("starts empty and adds an indexed mint", async () => {
    const { env, db } = harness();
    seedCoin(db, { mint: OTHER, symbol: "AAA" });
    const session = await sessionFor(env, WALLET);

    const empty = (await (await route(env, "/api/watchlist", { session })).json()) as { mints: string[] };
    expect(empty.mints).toEqual([]);

    const added = (await (
      await route(env, "/api/watchlist", { method: "POST", session, body: { mint: OTHER } })
    ).json()) as { mints: string[]; coins: { mint: string; symbol: string; change24h: number | null }[] };
    expect(added.mints).toEqual([OTHER]);
    expect(added.coins).toHaveLength(1);
    expect(added.coins[0]!.symbol).toBe("AAA");
    // The coin has no measured trade window, so its 24h change is unknown rather than zero.
    expect(added.coins[0]!.change24h).toBeNull();
  });

  it("carries the measured 24h change through when there is one", async () => {
    const { env, db } = harness();
    seedCoin(db, { mint: OTHER, change24h: 4.2, change24hAt: 1_700_000_000, priceSol: 0.002 });
    const session = await sessionFor(env, WALLET);
    await route(env, "/api/watchlist", { method: "POST", session, body: { mint: OTHER } });
    const body = (await (await route(env, "/api/watchlist", { session })).json()) as {
      coins: { change24h: number | null; priceSol: number }[];
    };
    expect(body.coins[0]!.change24h).toBe(4.2);
    expect(body.coins[0]!.priceSol).toBe(0.002);
  });

  it("is idempotent, and keeps the newest addition first", async () => {
    const { env, db } = harness();
    seedCoin(db, { mint: OTHER });
    seedCoin(db, { mint: THIRD });
    const session = await sessionFor(env, WALLET);
    await route(env, "/api/watchlist", { method: "POST", session, body: { mint: OTHER } });
    await route(env, "/api/watchlist", { method: "POST", session, body: { mint: THIRD } });
    const twice = (await (
      await route(env, "/api/watchlist", { method: "POST", session, body: { mint: OTHER } })
    ).json()) as { mints: string[] };
    expect(twice.mints).toEqual([THIRD, OTHER]);
  });

  it("refuses a mint the indexer has never seen", async () => {
    const { env } = harness();
    const session = await sessionFor(env, WALLET);
    const response = await route(env, "/api/watchlist", { method: "POST", session, body: { mint: UNSEEN } });
    expect(response.status).toBe(404);
  });

  it("refuses a malformed mint before it looks anything up", async () => {
    const { env } = harness();
    const session = await sessionFor(env, WALLET);
    expect((await route(env, "/api/watchlist", { method: "POST", session, body: { mint: "nope" } })).status).toBe(400);
    expect((await route(env, "/api/watchlist", { method: "POST", session, body: {} })).status).toBe(400);
    expect((await route(env, "/api/watchlist", { method: "POST", session, body: { mints: [1, 2] } })).status).toBe(400);
  });

  it("merges a whole list in one request, without duplicates", async () => {
    const { env, db } = harness();
    seedCoin(db, { mint: OTHER });
    seedCoin(db, { mint: THIRD });
    const session = await sessionFor(env, WALLET);
    const merged = (await (
      await route(env, "/api/watchlist", {
        method: "POST",
        session,
        body: { mints: [OTHER, THIRD, OTHER] },
      })
    ).json()) as { mints: string[] };
    expect(merged.mints).toHaveLength(2);
    expect(new Set(merged.mints)).toEqual(new Set([OTHER, THIRD]));
  });

  it("refuses the whole merge when one mint in it is unindexed", async () => {
    const { env, db } = harness();
    seedCoin(db, { mint: OTHER });
    const session = await sessionFor(env, WALLET);
    const response = await route(env, "/api/watchlist", {
      method: "POST",
      session,
      body: { mints: [OTHER, UNSEEN] },
    });
    expect(response.status).toBe(404);
    // Nothing was written, so the list is still empty rather than half-merged.
    const body = (await (await route(env, "/api/watchlist", { session })).json()) as { mints: string[] };
    expect(body.mints).toEqual([]);
  });

  it("enforces the cap before it writes anything", async () => {
    const { env, db } = harness();
    const mints = Array.from({ length: WATCHLIST_MAX }, (_value, index) => mintAt(index));
    for (const mint of mints) seedCoin(db, { mint });
    seedCoin(db, { mint: UNSEEN });
    const session = await sessionFor(env, WALLET);

    const full = await route(env, "/api/watchlist", { method: "POST", session, body: { mints } });
    expect(full.status).toBe(200);
    expect(((await full.json()) as { mints: string[] }).mints).toHaveLength(WATCHLIST_MAX);

    const overflow = await route(env, "/api/watchlist", { method: "POST", session, body: { mint: UNSEEN } });
    expect(overflow.status).toBe(409);
    const rows = db.prepare("SELECT COUNT(*) AS n FROM watchlist WHERE wallet = ?1").get(WALLET) as {
      n: number;
    };
    expect(Number(rows.n)).toBe(WATCHLIST_MAX);
  });

  it("removes one mint, and removing an absent one is not an error", async () => {
    const { env, db } = harness();
    seedCoin(db, { mint: OTHER });
    const session = await sessionFor(env, WALLET);
    await route(env, "/api/watchlist", { method: "POST", session, body: { mint: OTHER } });
    const removed = (await (
      await route(env, "/api/watchlist/" + OTHER, { method: "DELETE", session })
    ).json()) as { mints: string[] };
    expect(removed.mints).toEqual([]);
    const again = await route(env, "/api/watchlist/" + OTHER, { method: "DELETE", session });
    expect(again.status).toBe(200);
    expect((await route(env, "/api/watchlist/not-a-mint", { method: "DELETE", session })).status).toBe(400);
  });

  it("keeps one wallet out of another list", async () => {
    const { env, db } = harness();
    seedCoin(db, { mint: OTHER });
    seedCoin(db, { mint: THIRD });
    const mine = await sessionFor(env, WALLET);
    const theirs = await sessionFor(env, OTHER);
    await route(env, "/api/watchlist", { method: "POST", session: mine, body: { mint: OTHER } });
    await route(env, "/api/watchlist", { method: "POST", session: theirs, body: { mint: THIRD } });

    const mineBody = (await (await route(env, "/api/watchlist", { session: mine })).json()) as {
      mints: string[];
      wallet: string;
    };
    expect(mineBody.wallet).toBe(WALLET);
    expect(mineBody.mints).toEqual([OTHER]);

    // A delete on the other wallet session must not touch this one list.
    await route(env, "/api/watchlist/" + OTHER, { method: "DELETE", session: theirs });
    const after = (await (await route(env, "/api/watchlist", { session: mine })).json()) as {
      mints: string[];
    };
    expect(after.mints).toEqual([OTHER]);
  });

  it("rate limits writes per wallet", async () => {
    const { env, db } = harness();
    seedCoin(db, { mint: OTHER });
    const session = await sessionFor(env, WALLET);
    for (let index = 0; index < WATCHLIST_WALLET_RATE_LIMIT; index += 1) {
      const response = await route(env, "/api/watchlist", { method: "POST", session, body: { mint: OTHER } });
      expect(response.status).toBe(200);
    }
    const blocked = await route(env, "/api/watchlist", { method: "POST", session, body: { mint: OTHER } });
    expect(blocked.status).toBe(429);
  });

  it("answers an unknown watchlist verb and path with a not-found", async () => {
    const { env } = harness();
    const session = await sessionFor(env, WALLET);
    expect((await route(env, "/api/watchlist", { method: "PUT", session })).status).toBe(405);
    expect((await route(env, "/api/watchlist/a/b", { session })).status).toBe(404);
    expect((await route(env, "/api/watchlist/" + OTHER, { session })).status).toBe(404);
  });
});
