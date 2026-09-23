/**
 * A SQLite-backed D1 double for the oracle tests.
 *
 * The oracle's interesting behaviour is in how it reads what is already stored - the external quote
 * cache, the SOL/USD rows, the token price samples - and in how it refuses a valuation. Mocking D1
 * away would test none of that, so this harness runs the real migrations (including
 * 0013_oracle_commit_reveal.sql) against in-memory SQLite and seeds rows the way the indexing path
 * would. The storage doubles come from ./d1-sqlite.ts, the one SQLite-backed double in this
 * directory.
 */
import { DatabaseSync } from "node:sqlite";
import type { RuntimeEnv } from "../env";
import { FakeKv, SqliteD1, applyMigrations } from "./d1-sqlite";

/** The D1 double the oracle seeds write fixtures through directly. */
export class OracleD1Database extends SqliteD1 {
  constructor() {
    super(new DatabaseSync(":memory:"));
  }
}

export interface OracleTestHarness {
  env: RuntimeEnv;
  db: OracleD1Database;
  kv: FakeKv;
  close(): void;
}

/** Keeps seeded sample ids unique even when two samples share a timestamp and a price. */
let sampleSequence = 0;

export interface OracleHarnessOptions {
  /** Extra env vars, e.g. JUPITER_PRICE_URL or ORACLE_MIN_EXTERNAL_SOURCES. */
  vars?: Record<string, string>;
}

export function createOracleHarness(options: OracleHarnessOptions = {}): OracleTestHarness {
  const db = new OracleD1Database();
  // The shared runner applies every migration in filename order, exactly as wrangler does.
  applyMigrations(db.db);
  const kv = new FakeKv();
  const env = {
    DB: db,
    TOKEN_CACHE: kv,
    SOLANA_CLUSTER: "devnet",
    DISCOVERY_SECRET: "test-discovery-secret-0123456789",
    ...(options.vars ?? {}),
  } as unknown as RuntimeEnv;
  return { env, db, kv, close: () => db.close() };
}

/** One observed price, as the chain sync would append it after a successful read. */
export function seedSample(
  env: RuntimeEnv,
  mint: string,
  priceUsd: number,
  observedAt: number,
  volumeUsd = 1_000,
): void {
  sampleSequence += 1;
  (env.DB as unknown as OracleD1Database)
    .prepare(
      "INSERT INTO token_price_samples (id, mint, price_usd, volume_usd, observed_at) VALUES (?1, ?2, ?3, ?4, ?5)",
    )
    .bind("sample-" + sampleSequence + "-" + mint, mint, priceUsd, volumeUsd, observedAt)
    .run();
}

/** One recorded trade, which is what the oracle's trade VWAP source reads. */
export function seedTrade(
  env: RuntimeEnv,
  mint: string,
  priceUsd: number,
  amount: number,
  blockTime: number,
): void {
  (env.DB as unknown as OracleD1Database)
    .prepare(
      "INSERT OR REPLACE INTO trades (signature, mint, side, price_usd, price_sol, amount, block_time)" +
        " VALUES (?1, ?2, 'buy', ?3, 0, ?4, ?5)",
    )
    .bind("sig-" + mint + "-" + blockTime + "-" + amount, mint, priceUsd, amount, blockTime)
    .run();
}

/** A minimal token row; the oracle only reads status from it (LAUNCHING vs graduated). */
export function seedToken(env: RuntimeEnv, mint: string, status = "MINING_ACTIVE"): void {
  (env.DB as unknown as OracleD1Database)
    .prepare(
      "INSERT OR REPLACE INTO tokens (mint, slug, name, symbol, description, creator, status," +
        " price_usd, price_sol, reserve_remaining, reserve_total, reward_per_block, next_block_at, next_epoch_at)" +
        " VALUES (?1, ?2, ?3, 'MINE', 'seeded', 'creator', ?4, 0.01, 0.0001, 0, 0, 0, 0, 0)",
    )
    .bind(mint, "slug-" + mint.slice(0, 6).toLowerCase(), mint, status)
    .run();
}

/** One external observation, as a completed refresh would have stored it. */
export function seedCachedQuote(
  env: RuntimeEnv,
  mint: string,
  source: string,
  priceUsd: number,
  observedAt: number,
  fetchedAt = observedAt,
  weightUsd = 0,
): void {
  (env.DB as unknown as OracleD1Database)
    .prepare(
      "INSERT OR REPLACE INTO oracle_price_cache (mint, source, price_usd, observed_at, fetched_at, weight_usd, reliability)" +
        " VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0.9)",
    )
    .bind(mint, source, priceUsd, observedAt, fetchedAt, weightUsd)
    .run();
}

/** One cached SOL/USD observation. */
export function seedSolUsd(
  env: RuntimeEnv,
  source: string,
  priceUsd: number,
  observedAt: number,
  fetchedAt = observedAt,
): void {
  (env.DB as unknown as OracleD1Database)
    .prepare(
      "INSERT OR REPLACE INTO oracle_sol_usd (source, price_usd, observed_at, fetched_at, reliability)" +
        " VALUES (?1, ?2, ?3, ?4, 0.95)",
    )
    .bind(source, priceUsd, observedAt, fetchedAt)
    .run();
}

/** Reads one column from one row, synchronously, for terse assertions. */
export function readValue<T>(env: RuntimeEnv, sql: string, column: string): T | null {
  const rows = (env.DB as unknown as OracleD1Database).all(sql);
  if (rows.length === 0) return null;
  return (rows[0][column] as T) ?? null;
}

/** Counts rows matching a WHERE clause, synchronously. */
export function countWhere(env: RuntimeEnv, sql: string): number {
  const rows = (env.DB as unknown as OracleD1Database).all(sql);
  return Number(rows[0]?.total ?? 0);
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export interface MockFetch {
  fetch: typeof fetch;
  /** Every URL the oracle asked for, in order, so a test can assert what it did and did not call. */
  urls: string[];
  /** How many requests went to a mint id, used to prove the refresh guard and the graduated check. */
  mintRequests: (mint: string) => number;
}

/**
 * An injectable fetch. The handler returns either a Response or a JSON body; an unhandled URL
 * answers `{}`, which every parser in worker/oracle.ts treats as "no usable quote".
 */
export function mockFetch(handler: (url: string) => unknown): MockFetch {
  const urls: string[] = [];
  const impl = async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    const result = handler(url);
    return result instanceof Response ? result : jsonResponse(result ?? {});
  };
  return {
    fetch: impl as unknown as typeof fetch,
    urls,
    mintRequests: (mint: string) => urls.filter((url) => url.includes(mint)).length,
  };
}
