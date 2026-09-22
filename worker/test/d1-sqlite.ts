/**
 * The one D1-compatible fake backed by Node's built-in SQLite, plus the KV and queue doubles that
 * go with it, for tests of D1-dependent worker logic.
 *
 * It implements the slice of the D1 API the worker uses (prepare/bind/first/all/run/batch plus a KV
 * stub) over a real SQLite database, and applies every file in migrations/ in order, so a test
 * exercises the same schema the Worker sees - including the UNIQUE indexes that make notification
 * dedupe and achievement awarding idempotent.
 *
 * worker/test/mining-d1.ts, discovery-d1.ts and risk-d1.ts all build their harnesses on these
 * classes rather than each carrying their own SQLite-backed double: there is exactly one place that
 * knows how a D1 statement maps onto node:sqlite, so a change here cannot leave one suite testing
 * different storage semantics than another.
 *
 * Test-only: nothing here is imported by the Worker entry point.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { IndexingEvent } from "../../shared/types";
import type { RuntimeEnv } from "../env";

export interface D1MetaLike {
  changes: number;
  last_row_id: number;
  duration: number;
}

export interface D1ResultLike<T> {
  results: T[];
  success: boolean;
  meta: D1MetaLike;
}

function normalizeParams(values: readonly unknown[]): unknown[] {
  return values.map((value) => {
    if (value === undefined) return null;
    // D1 binds an integral JS number as a SQLite INTEGER. node:sqlite would bind it as a REAL,
    // which a TEXT-affinity column then stores as "100.0" - a string the Worker's BigInt-based
    // accounting refuses to parse. Binding safe integers as BigInt keeps this double faithful to
    // D1 instead of quietly changing the storage type underneath every caller.
    if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
    if (typeof value === "boolean") return value ? 1n : 0n;
    return value;
  });
}

export class SqliteD1Statement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly params: readonly unknown[] = [],
  ) {}

  bind(...values: unknown[]): SqliteD1Statement {
    return new SqliteD1Statement(this.db, this.sql, normalizeParams(values));
  }

  async first<T>(column?: string): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.params) as Record<string, unknown> | undefined;
    if (row === undefined || row === null) return null;
    if (typeof column === "string") return (row[column] as T) ?? null;
    return row as T;
  }

  async all<T>(): Promise<D1ResultLike<T>> {
    const rows = this.db.prepare(this.sql).all(...this.params) as T[];
    return { results: rows, success: true, meta: { changes: 0, last_row_id: 0, duration: 0 } };
  }

  async run(): Promise<D1ResultLike<never>> {
    const info = this.db.prepare(this.sql).run(...this.params);
    return {
      results: [],
      success: true,
      meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid), duration: 0 },
    };
  }

  /**
   * D1's batch reports each statement's rows *and* its meta, so this reads the rows and then asks
   * SQLite for the change count. Reading rows is what makes a batched SELECT usable (the breaker
   * check batches its SELECTs); without it a batch would silently look like it matched nothing.
   */
  async allWithMeta<T>(): Promise<D1ResultLike<T>> {
    const rows = this.db.prepare(this.sql).all(...this.params) as T[];
    const changes = this.db.prepare("SELECT changes() AS c").get() as { c: number } | undefined;
    return {
      results: rows,
      success: true,
      meta: { changes: Number(changes?.c ?? 0), last_row_id: 0, duration: 0 },
    };
  }
}

export class SqliteD1 {
  constructor(readonly db: DatabaseSync) {}

  prepare(sql: string): SqliteD1Statement {
    return new SqliteD1Statement(this.db, sql);
  }

  async batch(statements: readonly SqliteD1Statement[]): Promise<D1ResultLike<never>[]> {
    const results: D1ResultLike<never>[] = [];
    for (const statement of statements) results.push(await statement.allWithMeta());
    return results;
  }

  async exec(sql: string): Promise<{ count: number; duration: number }> {
    this.db.exec(sql);
    return { count: 0, duration: 0 };
  }

  /** Applies raw SQL (migrations, test fixtures). Not part of the D1 API. */
  apply(sql: string): void {
    this.db.exec(sql);
  }

  /** Reads rows synchronously, so a test can assert state without going through the promise API. */
  all(sql: string): Record<string, unknown>[] {
    return this.db.prepare(sql).all() as Record<string, unknown>[];
  }

  close(): void {
    this.db.close();
  }
}

/** In-memory TOKEN_CACHE with the TTL semantics the Worker relies on for single-use nonces. */
export class FakeKv {
  private readonly store = new Map<string, { value: string; expiresAt: number | null }>();

  async get<T>(key: string, type?: string): Promise<T | string | null> {
    const entry = this.store.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= Math.floor(Date.now() / 1_000)) {
      this.store.delete(key);
      return null;
    }
    return type === "json" ? (JSON.parse(entry.value) as T) : entry.value;
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

/** Captures queue jobs, so a test can assert what a handler handed to the keeper pipeline. */
export class FakeQueue {
  readonly messages: IndexingEvent[] = [];

  async send(body: IndexingEvent): Promise<void> {
    this.messages.push(body);
  }

  async sendBatch(batch: readonly { body: IndexingEvent }[]): Promise<void> {
    for (const item of batch) this.messages.push(item.body);
  }
}

export const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

/** Applies every migration file in numeric order and returns the file names applied. */
export function applyMigrations(db: DatabaseSync, directory = MIGRATIONS_DIR): string[] {
  const files = readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files) db.exec(readFileSync(join(directory, file), "utf8"));
  return files;
}

export interface TestHarness {
  readonly db: DatabaseSync;
  readonly d1: SqliteD1;
  readonly kv: FakeKv;
  readonly env: RuntimeEnv;
  readonly migrations: string[];
}

/** A fresh in-memory database with every migration applied and a fake KV namespace. */
export function createTestHarness(): TestHarness {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const migrations = applyMigrations(db);
  const d1 = new SqliteD1(db);
  const kv = new FakeKv();
  const env = { DB: d1, TOKEN_CACHE: kv } as unknown as RuntimeEnv;
  return { db, d1, kv, env, migrations };
}

export interface SeedPlayerOptions {
  readonly wallet: string;
  readonly activeDays?: number;
  readonly streak?: number;
  readonly riskState?: "NORMAL" | "UNDER_REVIEW" | "HELD" | "BLOCKED";
  readonly lastActivationAt?: number | null;
  readonly activationExpiresAt?: number | null;
  readonly activeMint?: string | null;
  readonly minersLevel?: number;
  readonly oreBalance?: number;
  readonly createdAt?: number;
}

export function seedPlayer(db: DatabaseSync, options: SeedPlayerOptions): void {
  db.prepare(
    "INSERT INTO players (wallet, created_at, miners_level, active_days, streak, risk_state," +
      " last_activation_at, activation_expires_at, active_mint, ore_balance)" +
      " VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
  ).run(
    options.wallet,
    options.createdAt ?? 1_700_000_000,
    options.minersLevel ?? 2,
    options.activeDays ?? 0,
    options.streak ?? 0,
    options.riskState ?? "NORMAL",
    options.lastActivationAt ?? null,
    options.activationExpiresAt ?? null,
    options.activeMint ?? null,
    options.oreBalance ?? 0,
  );
}

export function seedToken(
  db: DatabaseSync,
  options: { mint: string; symbol?: string; status?: string; reserveRemaining?: number; reserveTotal?: number },
): void {
  db.prepare(
    "INSERT INTO tokens (mint, slug, name, symbol, description, creator, status, reserve_remaining," +
      " reserve_total, reward_per_block, next_block_at, next_epoch_at)" +
      " VALUES (?1, ?2, ?3, ?4, '', 'creator', ?5, ?6, ?7, 1000, 0, 0)",
  ).run(
    options.mint,
    options.mint,
    options.mint,
    options.symbol ?? "TEST",
    options.status ?? "MINING_ACTIVE",
    options.reserveRemaining ?? 10_000,
    options.reserveTotal ?? 10_000,
  );
}

export function seedDiscovery(
  db: DatabaseSync,
  options: { id: string; wallet: string; rarity: string; createdAt: number; mint?: string },
): void {
  // The discoveries table is owned by the discovery workstream and gains columns over time, so the
  // insert is built from the live schema: every NOT NULL column without a default is filled with a
  // type-appropriate placeholder unless the caller overrides it.
  const columns = db.prepare("PRAGMA table_info(discoveries)").all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
    pk: number;
  }[];
  const overrides: Record<string, unknown> = {
    id: options.id,
    event_id: "evt-" + options.id,
    wallet: options.wallet,
    window: "window-" + options.id,
    window_index: 1,
    mint: options.mint ?? "mint1",
    symbol: "TEST",
    rarity: options.rarity,
    visual_event: "sparkle",
    token_amount: 1,
    value_usd: 0.5,
    status: "ELIGIBLE",
    created_at: options.createdAt,
  };
  const names: string[] = [];
  const values: unknown[] = [];
  for (const column of columns) {
    if (column.name in overrides) {
      names.push(column.name);
      values.push(overrides[column.name]);
    } else if (column.notnull && column.dflt_value === null && !column.pk) {
      names.push(column.name);
      values.push(column.type.toUpperCase().includes("INT") ? 0 : column.type.toUpperCase().includes("REAL") ? 0 : "");
    }
  }
  const placeholders = names.map((_name, index) => "?" + (index + 1)).join(", ");
  db.prepare("INSERT INTO discoveries (" + names.join(", ") + ") VALUES (" + placeholders + ")").run(
    ...normalizeParams(values),
  );
}

export function countRows(db: DatabaseSync, table: string, where = "", ...params: unknown[]): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM " + table + " " + where).get(...normalizeParams(params)) as
    | { n: number }
    | undefined;
  return Number(row?.n ?? 0);
}

export function tableNames(db: DatabaseSync): string[] {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
    name: string;
  }[];
  return rows.map((row) => String(row.name));
}

/** Registers a session for the wallet in the fake KV and returns the session id. */
export async function createSession(
  harness: TestHarness,
  wallet: string,
  session = "test-session",
): Promise<string> {
  await harness.kv.put("auth:session:" + session, wallet);
  return session;
}

export function sessionRequest(
  url: string,
  session: string,
  init: { method?: string; body?: unknown } = {},
): Request {
  const headers: Record<string, string> = { authorization: "Bearer " + session };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return new Request(url, {
    method: init.method ?? "GET",
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}
