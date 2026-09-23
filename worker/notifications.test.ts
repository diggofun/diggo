/// <reference types="node" />
/**
 * Notifications: the discovery read, the bell endpoint and the sweep candidates.
 *
 * Everything here runs against real SQLite with every migration applied, because the failure this
 * file pins down was a SQL one. migrations/0021_indexer_only.sql drops the old "discoveries" table
 * and replaces it with "discovery_events", which stores rarity as the program's numeric tier index
 * rather than as a name. A read that still asked for "discoveries" raised "no such table", which
 * turned GET /api/notifications into a 500 for every indexed wallet.
 *
 * Fixtures are real rows in the real schema, so the assertions are about the SQL the Worker runs
 * rather than about a mock of it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DIGGO_CONFIG } from "../shared/config";
import type { RuntimeEnv } from "./env";
import { SESSION_COOKIE } from "./http";
import {
  dueCandidatesQuery,
  getNotifications,
  loadNotificationInput,
  sweepNotifications,
} from "./notifications";

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
}

class SqliteD1 {
  constructor(readonly db: DatabaseSync) {}

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.db, sql);
  }

  /** D1 resolves a batch to one result per statement, so each run is awaited here too. */
  async batch(statements: readonly SqliteStatement[]): Promise<unknown[]> {
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

/** A KV stand-in that can be pre-seeded, which is how a test gets a wallet session. */
class FakeKv {
  private readonly store = new Map<string, string>();

  async get<T>(key: string): Promise<T | string | null> {
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

interface Harness {
  db: DatabaseSync;
  env: RuntimeEnv;
  kv: FakeKv;
}

/** Every migration, in order, onto an empty in-memory database. */
function harness(): Harness {
  const db = new DatabaseSync(":memory:");
  const directory = fileURLToPath(new URL("../migrations/", import.meta.url));
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(directory, file), "utf8"));
  }
  const kv = new FakeKv();
  const env = { DB: new SqliteD1(db), TOKEN_CACHE: kv } as unknown as RuntimeEnv;
  return { db, env, kv };
}

/** The handler dates itself from the wall clock, so the fixtures are anchored to it. */
const NOW = Math.floor(Date.now() / 1_000);
const DAY = 86_400;

const RARE_WALLET = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const COMMON_WALLET = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
const HELD_WALLET = "6Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j2";

/** The tiers the program rolls, in DIGGO_CONFIG.rarity.tiers order. */
const COMMON = 0;
const UNCOMMON = 1;
const RARE = 2;
const EPIC = 3;

function addPlayer(db: DatabaseSync, wallet: string, riskState = "NORMAL"): void {
  db.prepare("INSERT INTO players (wallet, created_at, risk_state, streak) VALUES (?1, ?2, ?3, 0)")
    .run(...bindable([wallet, NOW - DAY, riskState]));
}

interface DiscoveryFixture {
  id: string;
  wallet: string;
  /** The program's numeric tier; null for a roll that has not settled. */
  rarity: number | null;
  status?: string;
  /** When the roll was indexed. */
  rolledAt: number;
  /** The settle transaction's block time; 0 means the chain read carried none. */
  settledAt: number;
}

function addDiscovery(db: DatabaseSync, fixture: DiscoveryFixture): void {
  db.prepare(
    "INSERT INTO discovery_events (id, opportunity, coin, wallet, window_index, day_index," +
      " epoch_index, status, rarity, signature, slot, block_time, created_at)" +
      " VALUES (?1, ?1, ?2, ?3, 0, 0, 0, ?4, ?5, ?6, 0, ?7, ?8)",
  ).run(
    ...bindable([
      fixture.id,
      "coin-" + fixture.id,
      fixture.wallet,
      fixture.status ?? (fixture.rarity === null ? "PENDING" : "SETTLED"),
      fixture.rarity,
      "sig-" + fixture.id,
      fixture.settledAt,
      fixture.rolledAt,
    ]),
  );
}

interface StoredNotification {
  kind: string;
  dedupe_key: string;
  payload: string;
}

function storedNotifications(db: DatabaseSync, wallet: string): StoredNotification[] {
  return db
    .prepare("SELECT kind, dedupe_key, payload FROM notifications WHERE wallet = ?1 ORDER BY id")
    .all(...bindable([wallet])) as unknown as StoredNotification[];
}

function sessionFor(wallet: string): string {
  return "session-" + wallet;
}

async function signIn(kv: FakeKv, wallet: string): Promise<void> {
  await kv.put("auth:session:" + sessionFor(wallet), wallet);
}

function bellRequest(wallet: string): Request {
  return new Request("https://diggo.fun/api/notifications", {
    headers: { cookie: SESSION_COOKIE + "=" + sessionFor(wallet) },
  });
}

interface BellBody {
  notifications: { kind: string; payload: Record<string, unknown>; createdAt: number }[];
  unread: number;
  total: number;
}

describe("the indexed discovery projection", () => {
  it("keeps the tier order the notification code translates the numeric rarity through", () => {
    // discovery_events.rarity is the program's tier index (programs/diggo-protocol/src/math/rarity.rs),
    // so the names DIGGO_CONFIG gives those indexes are the only thing that can turn 2 into "rare".
    // Reordering or renaming a tier changes what the stored numbers mean; this is the tripwire.
    expect(DIGGO_CONFIG.rarity.tiers.map((tier) => tier.rarity)).toEqual([
      "common",
      "uncommon",
      "rare",
      "epic",
      "legendary",
      "mythic",
    ]);
  });

  it("names a settled rare find from its numeric tier", async () => {
    const { db, env } = harness();
    addPlayer(db, RARE_WALLET);
    addDiscovery(db, { id: "opp-epic", wallet: RARE_WALLET, rarity: EPIC, rolledAt: NOW - 120, settledAt: NOW - 60 });

    const input = await loadNotificationInput(env, RARE_WALLET, NOW);

    expect(input?.discoveries).toEqual([{ id: "opp-epic", rarity: "epic", createdAt: NOW - 60 }]);
  });

  it("dates a find from the settle, so a roll that sat pending past the window still counts", async () => {
    const { db, env } = harness();
    addPlayer(db, RARE_WALLET);
    addDiscovery(db, {
      id: "opp-late",
      wallet: RARE_WALLET,
      rarity: RARE,
      rolledAt: NOW - 3 * DAY,
      settledAt: NOW - 30,
    });

    const input = await loadNotificationInput(env, RARE_WALLET, NOW);

    expect(input?.discoveries).toEqual([{ id: "opp-late", rarity: "rare", createdAt: NOW - 30 }]);
  });

  it("falls back to the index time when the settle stored no block time", async () => {
    const { db, env } = harness();
    addPlayer(db, RARE_WALLET);
    addDiscovery(db, { id: "opp-nobt", wallet: RARE_WALLET, rarity: RARE, rolledAt: NOW - 600, settledAt: 0 });

    const input = await loadNotificationInput(env, RARE_WALLET, NOW);

    expect(input?.discoveries).toEqual([{ id: "opp-nobt", rarity: "rare", createdAt: NOW - 600 }]);
  });

  it("ignores pending rolls, non-rare tiers and finds older than the window", async () => {
    const { db, env } = harness();
    addPlayer(db, RARE_WALLET);
    addDiscovery(db, { id: "pending", wallet: RARE_WALLET, rarity: null, rolledAt: NOW - 60, settledAt: NOW - 60 });
    addDiscovery(db, { id: "common", wallet: RARE_WALLET, rarity: COMMON, rolledAt: NOW - 60, settledAt: NOW - 60 });
    addDiscovery(db, { id: "uncommon", wallet: RARE_WALLET, rarity: UNCOMMON, rolledAt: NOW - 60, settledAt: NOW - 60 });
    addDiscovery(db, {
      id: "stale",
      wallet: RARE_WALLET,
      rarity: RARE,
      rolledAt: NOW - 2 * DAY,
      settledAt: NOW - 2 * DAY,
    });
    addDiscovery(db, { id: "rare", wallet: RARE_WALLET, rarity: RARE, rolledAt: NOW - 300, settledAt: NOW - 240 });

    const input = await loadNotificationInput(env, RARE_WALLET, NOW);

    expect(input?.discoveries).toEqual([{ id: "rare", rarity: "rare", createdAt: NOW - 240 }]);
  });

  it("orders the newest find first, breaking ties by id", async () => {
    const { db, env } = harness();
    addPlayer(db, RARE_WALLET);
    addDiscovery(db, { id: "tie-b", wallet: RARE_WALLET, rarity: RARE, rolledAt: NOW - 60, settledAt: NOW - 60 });
    addDiscovery(db, { id: "newer", wallet: RARE_WALLET, rarity: EPIC, rolledAt: NOW - 10, settledAt: NOW - 10 });
    addDiscovery(db, { id: "tie-a", wallet: RARE_WALLET, rarity: RARE, rolledAt: NOW - 60, settledAt: NOW - 60 });

    const input = await loadNotificationInput(env, RARE_WALLET, NOW);

    expect(input?.discoveries.map((entry) => entry.id)).toEqual(["newer", "tie-a", "tie-b"]);
  });
});

describe("GET /api/notifications", () => {
  it("answers for an indexed wallet with a rare find, and stores it once", async () => {
    const { db, env, kv } = harness();
    addPlayer(db, RARE_WALLET);
    addDiscovery(db, { id: "opp-1", wallet: RARE_WALLET, rarity: RARE, rolledAt: NOW - 120, settledAt: NOW - 60 });
    await signIn(kv, RARE_WALLET);

    const response = await getNotifications(bellRequest(RARE_WALLET), env);

    expect(response.status).toBe(200);
    const listed = (await response.json()) as BellBody;
    expect(listed.notifications).toHaveLength(1);
    expect(listed.notifications[0].kind).toBe("RARE_DISCOVERY_FOUND");
    expect(listed.notifications[0].payload).toMatchObject({ discoveryId: "opp-1", rarity: "rare" });
    expect(listed.unread).toBe(1);
    expect(storedNotifications(db, RARE_WALLET).map((row) => row.kind)).toEqual(["RARE_DISCOVERY_FOUND"]);

    // The bell is polled. A second read must find the same row rather than a duplicate.
    const again = await getNotifications(bellRequest(RARE_WALLET), env);
    expect(again.status).toBe(200);
    expect(((await again.json()) as BellBody).notifications).toHaveLength(1);
    expect(storedNotifications(db, RARE_WALLET)).toHaveLength(1);
  });

  it("reports an indexed wallet with nothing due as empty rather than failing", async () => {
    const { db, env, kv } = harness();
    addPlayer(db, COMMON_WALLET);
    addDiscovery(db, { id: "opp-c", wallet: COMMON_WALLET, rarity: COMMON, rolledAt: NOW - 60, settledAt: NOW - 60 });
    await signIn(kv, COMMON_WALLET);

    const response = await getNotifications(bellRequest(COMMON_WALLET), env);

    expect(response.status).toBe(200);
    expect(((await response.json()) as BellBody).notifications).toEqual([]);
    expect(storedNotifications(db, COMMON_WALLET)).toEqual([]);
  });

  it("still requires a wallet session", async () => {
    const { env } = harness();

    const response = await getNotifications(new Request("https://diggo.fun/api/notifications"), env);

    expect(response.status).toBe(401);
  });
});

describe("the sweep candidates", () => {
  it("selects the rare tiers by numeric index and ignores every other tier", () => {
    const { db } = harness();
    addPlayer(db, RARE_WALLET);
    addDiscovery(db, { id: "opp-rare", wallet: RARE_WALLET, rarity: RARE, rolledAt: NOW - 60, settledAt: NOW - 60 });
    addPlayer(db, COMMON_WALLET);
    addDiscovery(db, { id: "opp-common", wallet: COMMON_WALLET, rarity: COMMON, rolledAt: NOW - 60, settledAt: NOW - 60 });

    const { sql, params } = dueCandidatesQuery(NOW, 50);
    const rows = db.prepare(sql).all(...bindable(params)) as { wallet: string }[];

    expect(rows.map((row) => row.wallet)).toEqual([RARE_WALLET]);
  });

  it("selects a rare find that settled after sitting pending past the window", () => {
    const { db } = harness();
    addPlayer(db, RARE_WALLET);
    addDiscovery(db, {
      id: "opp-late",
      wallet: RARE_WALLET,
      rarity: RARE,
      rolledAt: NOW - 3 * DAY,
      settledAt: NOW - 30,
    });

    const { sql, params } = dueCandidatesQuery(NOW, 50);
    const rows = db.prepare(sql).all(...bindable(params)) as { wallet: string }[];

    expect(rows.map((row) => row.wallet)).toEqual([RARE_WALLET]);
  });
});

describe("the sweep", () => {
  it("generates the rare notification for an indexed wallet exactly once", async () => {
    const { db, env } = harness();
    addPlayer(db, RARE_WALLET);
    addDiscovery(db, { id: "opp-1", wallet: RARE_WALLET, rarity: RARE, rolledAt: NOW - 120, settledAt: NOW - 60 });

    expect(await sweepNotifications(env, NOW)).toBe(1);
    expect(storedNotifications(db, RARE_WALLET).map((row) => row.kind)).toEqual(["RARE_DISCOVERY_FOUND"]);
    expect(await sweepNotifications(env, NOW)).toBe(0);
    expect(storedNotifications(db, RARE_WALLET)).toHaveLength(1);
  });

  it("skips a find that is already announced", async () => {
    const { db, env } = harness();
    addPlayer(db, RARE_WALLET);
    addDiscovery(db, { id: "opp-1", wallet: RARE_WALLET, rarity: RARE, rolledAt: NOW - 120, settledAt: NOW - 60 });
    await env.DB.prepare(
      "INSERT INTO notifications (wallet, kind, payload, dedupe_key, created_at)" +
        " VALUES (?1, 'RARE_DISCOVERY_FOUND', '{}', ?2, ?3)",
    )
      .bind(RARE_WALLET, RARE_WALLET + ":RARE_DISCOVERY_FOUND:opp-1", NOW - 60)
      .run();

    expect(await sweepNotifications(env, NOW)).toBe(0);
    expect(storedNotifications(db, RARE_WALLET)).toHaveLength(1);
  });

  it("leaves a wallet with only common finds, a stale find and a restricted account alone", async () => {
    const { db, env } = harness();
    addPlayer(db, COMMON_WALLET);
    addDiscovery(db, { id: "opp-common", wallet: COMMON_WALLET, rarity: COMMON, rolledAt: NOW - 60, settledAt: NOW - 60 });
    addDiscovery(db, {
      id: "opp-stale",
      wallet: COMMON_WALLET,
      rarity: RARE,
      rolledAt: NOW - 2 * DAY,
      settledAt: NOW - 2 * DAY,
    });
    addPlayer(db, HELD_WALLET, "HELD");
    addDiscovery(db, { id: "opp-held", wallet: HELD_WALLET, rarity: RARE, rolledAt: NOW - 60, settledAt: NOW - 60 });

    expect(await sweepNotifications(env, NOW)).toBe(0);
    expect(storedNotifications(db, COMMON_WALLET)).toEqual([]);
    expect(storedNotifications(db, HELD_WALLET)).toEqual([]);
  });
});
