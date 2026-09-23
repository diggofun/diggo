/**
 * Test-only doubles for D1 and KV.
 *
* The anti-abuse layer is almost entirely SQL-driven, so the tests run the real migrations
* against an in-memory SQLite database (node:sqlite) instead of mocking the storage layer. That
* keeps the queries, the CHECK constraints and the ON CONFLICT upserts honest: a broken
* statement or a wrong column name fails the test the same way it would fail in D1.
 *
 * The D1, KV, queue and migration-runner doubles themselves live in ./d1-sqlite.ts; this file adds
 * the anti-abuse fixtures on top of them (signal seeding, restriction and breaker helpers, request
 * builders). The KV double here is the one exception: these tests assert on the raw key map.
 */
import { DatabaseSync } from "node:sqlite";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";
import type { RuntimeEnv } from "../env";
import { FakeQueue, SqliteD1, applyMigrations } from "./d1-sqlite";

type BindValue = string | number | null | bigint | Uint8Array;

function kvDouble(store: Map<string, string>): KVNamespace {
  return {
    get: async (key: string, type?: string) => {
      const value = store.get(key);
      if (value === undefined) return null;
      return type === "json" ? JSON.parse(value) : value;
    },
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async () => ({
      keys: Array.from(store.keys(), (name) => ({ name })),
      list_complete: true,
      cacheStatus: null,
    }),
    getWithMetadata: async (key: string) => ({ value: store.get(key) ?? null, metadata: null, cacheStatus: null }),
  } as unknown as KVNamespace;
}



export interface TestEnvOptions {
  /** Skip applying migrations (for storage-error tests). */
  migrate?: boolean;
  variables?: Record<string, string>;
}

export interface TestEnv {
  env: RuntimeEnv;
  db: DatabaseSync;
  kv: Map<string, string>;
  close(): void;
}

export function createTestEnv(options: TestEnvOptions = {}): TestEnv {
  const db = new DatabaseSync(":memory:");
  if (options.migrate !== false) applyMigrations(db);
  const kv = new Map<string, string>();
  const env = {
    DB: new SqliteD1(db),
    TOKEN_CACHE: kvDouble(kv),
    INDEXING_QUEUE: new FakeQueue(),
    ...options.variables,
  } as unknown as RuntimeEnv;
  return { env, db, kv, close: () => db.close() };
}

export function countRows(db: DatabaseSync, sql: string, ...params: BindValue[]): number {
  const row = db.prepare(sql).get(...params) as { n: number } | undefined;
  return row?.n ?? 0;
}

export function queryRows<T>(db: DatabaseSync, sql: string, ...params: BindValue[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export interface RequestOptions {
  wallet?: string;
  device?: string;
  ip?: string;
  asn?: number;
  colo?: string;
  country?: string;
  session?: string;
  method?: string;
  url?: string;
  body?: unknown;
}

/**
 * Builds a request with Cloudflare-style metadata so the fingerprinting path (CF headers plus
 * request.cf) is exercised exactly as it is in production.
 */
export function makeRequest(options: RequestOptions = {}): Request {
  const headers = new Headers();
  if (options.ip) headers.set("cf-connecting-ip", options.ip);
  if (options.device) headers.set("x-diggo-device", options.device);
  if (options.session) headers.set("cookie", "diggo_session=" + options.session);
  const method = options.method ?? "POST";
  const hasBody = options.body !== undefined && method !== "GET" && method !== "HEAD";
  if (hasBody) headers.set("content-type", "application/json");
  const request = new Request(options.url ?? "https://diggo.fun/api/test", {
    method,
    headers,
    body: hasBody ? JSON.stringify(options.body) : undefined,
  });
  Object.assign(request, {
    cf: {
      asn: options.asn ?? 12_345,
      colo: options.colo ?? "WAW",
      country: options.country ?? "PL",
    },
  });
  return request;
}

export interface SeedPlayerOptions {
  createdAt?: number;
  activeDays?: number;
  streak?: number;
  lastActivationAt?: number | null;
  activeMint?: string | null;
  oreBalance?: number;
}

export function seedPlayer(
  test: TestEnv,
  wallet: string,
  options: SeedPlayerOptions = {},
): void {
  const now = Math.floor(Date.now() / 1_000);
  test.db
    .prepare(
      "INSERT OR REPLACE INTO players (wallet, created_at, active_days, streak, last_activation_at, active_mint, ore_balance) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      wallet,
      options.createdAt ?? now - 30 * 86_400,
      options.activeDays ?? 20,
      options.streak ?? 10,
      options.lastActivationAt === undefined ? now - 3_600 : options.lastActivationAt,
      options.activeMint ?? null,
      options.oreBalance ?? 0,
    );
}

export interface SeedSignalInput {
  wallet: string;
  deviceHash?: string | null;
  networkHash?: string | null;
  ipHash?: string | null;
  sessionId?: string | null;
  action?: string;
  outcome?: string;
  ts?: number;
}

/** Raw signal insert, for building clusters without going through the hashing path. */
export function seedSignal(test: TestEnv, input: SeedSignalInput): void {
  test.db
    .prepare(
      "INSERT INTO account_signals (wallet, ts, action, ip_hash, network_hash, device_hash, session_id, outcome) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      input.wallet,
      input.ts ?? Math.floor(Date.now() / 1_000),
      input.action ?? "activate",
      input.ipHash ?? null,
      input.networkHash ?? null,
      input.deviceHash ?? null,
      input.sessionId ?? null,
      input.outcome ?? "ok",
    );
}

export interface SeedDiscoveryInput {
  wallet: string;
  mint?: string;
  symbol?: string;
  rarity?: string;
  valueUsd?: number;
  status?: string;
  createdAt?: number;
}

export function seedDiscovery(test: TestEnv, input: SeedDiscoveryInput): void {
  test.db
    .prepare(
      "INSERT INTO discoveries (id, event_id, wallet, window, window_index, mint, symbol, rarity, visual_event, " +
        "token_amount, value_usd, price_usd, eligibility_score, status, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      crypto.randomUUID(),
      crypto.randomUUID(),
      input.wallet,
      "test-window",
      0,
      input.mint ?? "4rT8mQ2vN6kY3cW9pF1sJ7aB5eH8uL2xG6zP9diggo",
      input.symbol ?? "STONE",
      input.rarity ?? "common",
      "Stone",
      1,
      input.valueUsd ?? 1,
      0.001,
      0,
      input.status ?? "ELIGIBLE",
      input.createdAt ?? Math.floor(Date.now() / 1_000),
    );
}

/** A real ed25519 keypair plus a signer, so signature paths are tested, not stubbed. */
export function newWallet(): { wallet: string; sign(message: string): string } {
  const secretKey = ed25519.utils.randomSecretKey();
  const publicKey = ed25519.getPublicKey(secretKey);
  return {
    wallet: bs58.encode(publicKey),
    sign: (message: string) => bs58.encode(ed25519.sign(new TextEncoder().encode(message), secretKey)),
  };
}

/** Puts a signed-in session for wallet into the KV double and returns its session id. */
export async function openSession(test: TestEnv, wallet: string): Promise<string> {
  const session = crypto.randomUUID().replaceAll("-", "");
  await test.env.TOKEN_CACHE.put("auth:session:" + session, wallet, { expirationTtl: 3_600 });
  return session;
}
