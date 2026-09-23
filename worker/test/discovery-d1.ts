/**
 * A SQLite-backed D1 double for discovery tests.
 *
 * Discovery correctness lives in SQL as much as in TypeScript: UNIQUE(wallet, window_index) is the
 * anti-reroll guard, UNIQUE(event_id) is the single-grant guard, and the PENDING -> ELIGIBLE
 * transition is a guarded UPDATE whose changes count is the concurrency control. Mocking D1 away
 * would test none of that, so this harness runs the real migrations against in-memory SQLite and
 * speaks the parts of the D1 API the Worker actually uses.
 *
 * The storage doubles themselves come from ./d1-sqlite.ts - the one SQLite-backed double in this
 * directory - so every suite exercises the same statement, batch and KV semantics. This file adds
 * the discovery fixtures on top: a healthy mine, price samples, trades and discovery rows.
 */
import { DatabaseSync } from "node:sqlite";
import type { RuntimeEnv } from "../env";
import type { TokenStatus } from "../../shared/types";
import { FakeKv, FakeQueue, SqliteD1, applyMigrations } from "./d1-sqlite";

type SqlValue = string | number | bigint | null | Uint8Array;

/** The shared doubles, under the names this suite has always used. */
export { FakeKv as FakeKV, FakeQueue };

/** The D1 double the discovery seeds write fixtures through directly. */
export class FakeD1Database extends SqliteD1 {
  constructor() {
    super(new DatabaseSync(":memory:"));
  }
}

export interface DiscoveryTestHarness {
  env: RuntimeEnv;
  db: FakeD1Database;
  kv: FakeKv;
  queue: FakeQueue;
  close(): void;
}

export interface HarnessOptions {
  /** Server RNG secret; pass null to exercise the fail-closed path. */
  discoverySecret?: string | null;
  windowSeconds?: number;
  rollChanceBps?: number;
}

/**
 * Builds a fresh in-memory environment with every migration applied. The default secret and
 * 100%-hit roll chance make the RNG path deterministic for tests that are about gating rather than
 * about probability.
 */
export function createHarness(options: HarnessOptions = {}): DiscoveryTestHarness {
  const db = new FakeD1Database();
  // The shared runner applies every migration in filename order, exactly as `wrangler d1
  // migrations apply` does.
  applyMigrations(db.db);
  const kv = new FakeKv();
  const queue = new FakeQueue();
  const secret = options.discoverySecret === undefined ? "test-discovery-secret-0123456789" : options.discoverySecret;
  const env = {
    DB: db,
    TOKEN_CACHE: kv,
    INDEXING_QUEUE: queue,
    DIGGO_PROGRAM_ID: "48WgfSPnEPitiasXV5B3aLpeAWtUisSt6YSR6djDZebC",
    DIGGO_KEEPER: "G3QELLuGprfRBYxoh3P5v4ZkGFyNXGLjATsNYZx6xWu8",
    SOLANA_CLUSTER: "devnet",
    ENVIRONMENT: "production",
    ...(secret === null ? {} : { DISCOVERY_SECRET: secret }),
    DISCOVERY_ROLL_CHANCE_BPS: String(options.rollChanceBps ?? 10_000),
    DISCOVERY_WINDOW_SECONDS: String(options.windowSeconds ?? 3_600),
  } as unknown as RuntimeEnv;
  return { env, db, kv, queue, close: () => db.close() };
}

export const DAY = 86_400;

export interface SeedPlayerOptions {
  accountAgeDays?: number;
  activeDays?: number;
  riskState?: "NORMAL" | "UNDER_REVIEW" | "HELD" | "BLOCKED";
  riskScore?: number;
  crewLevels?: { miners: number; drills: number; carts: number; foreman: number; storage: number };
  /** Seconds from now until the 24h activation lapses; null means never activated. */
  activeForSeconds?: number | null;
  activeMint?: string | null;
}

/**
 * Seeds a player that satisfies every discovery eligibility rule by default (spec 44): old enough,
 * enough active days, crew tier 2+, account maturity at 100%, NORMAL risk state, Crew active.
 */
export function seedPlayer(
  env: RuntimeEnv,
  wallet: string,
  options: SeedPlayerOptions = {},
  now = Math.floor(Date.now() / 1_000),
): void {
  const levels = options.crewLevels ?? { miners: 5, drills: 3, carts: 3, foreman: 2, storage: 2 };
  const activeFor = options.activeForSeconds === undefined ? DAY : options.activeForSeconds;
  const db = env.DB as unknown as FakeD1Database;
  db.prepare(
    `INSERT OR REPLACE INTO players
       (wallet, created_at, miners_level, drills_level, carts_level, foreman_level, storage_level,
        streak, active_days, active_mint, last_activation_at, activation_expires_at, ore_collected_at,
        risk_state, risk_score)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12, ?13, ?14)`,
  )
    .bind(
      wallet,
      now - Math.round((options.accountAgeDays ?? 10) * DAY),
      levels.miners,
      levels.drills,
      levels.carts,
      levels.foreman,
      levels.storage,
      options.activeDays ?? 8,
      options.activeDays ?? 8,
      options.activeMint ?? null,
      activeFor === null ? null : now,
      activeFor === null ? null : now + activeFor,
      options.riskState ?? "NORMAL",
      options.riskScore ?? 0,
    )
    .run();
}

export interface SeedTokenOptions {
  mint?: string;
  symbol?: string;
  status?: TokenStatus;
  priceUsd?: number;
  marketCapUsd?: number;
  liquidityUsd?: number;
  discoveryReserveRemaining?: number;
  discoveryReserveTotal?: number;
  discoveryEpochBudget?: number;
  discoveryEpochSpent?: number;
  discoveryEpochEndsAt?: number;
  discoveryPaused?: number;
  mintAuthorityRevoked?: number;
  freezeAuthorityRevoked?: number;
  liquidityLocked?: number;
  decimals?: number;
}

/**
 * Seeds a mine that is a legitimate discovery target: real market cap, real liquidity, unlocked
 * program-owned liquidity and revoked authorities.
 */
export function seedToken(env: RuntimeEnv, options: SeedTokenOptions = {}): string {
  const mint = options.mint ?? "HeaLthyMint1111111111111111111111111111111";
  const db = env.DB as unknown as FakeD1Database;
  db.prepare(
    `INSERT OR REPLACE INTO tokens
       (mint, slug, name, symbol, description, creator, status, price_usd, price_sol, market_cap_usd,
        reserve_remaining, reserve_total, reward_per_block, network_power, next_block_at, next_epoch_at,
        decimals, discovery_reserve_remaining, discovery_reserve_total, discovery_epoch_budget,
        discovery_epoch_spent, discovery_epoch_ends_at, discovery_paused, liquidity_usd,
        mint_authority_revoked, freeze_authority_revoked, liquidity_locked)
     VALUES (?1, ?2, ?2, ?3, 'seeded', 'Cr8tor111111111111111111111111111111111111', ?4, ?5, 0.001, ?6,
             1000, 5000, 10, 100, 0, 0, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)`,
  )
    .bind(
      mint,
      `slug-${mint.slice(0, 6).toLowerCase()}`,
      options.symbol ?? "MINE",
      options.status ?? "MINING_ACTIVE",
      options.priceUsd ?? 0.01,
      options.marketCapUsd ?? 1_000_000,
      options.decimals ?? 6,
      options.discoveryReserveRemaining ?? 5_000,
      options.discoveryReserveTotal ?? 10_000,
      options.discoveryEpochBudget ?? 1_000,
      options.discoveryEpochSpent ?? 0,
      options.discoveryEpochEndsAt ?? 0,
      options.discoveryPaused ?? 0,
      options.liquidityUsd ?? 250_000,
      options.mintAuthorityRevoked ?? 1,
      options.freezeAuthorityRevoked ?? 1,
      options.liquidityLocked ?? 1,
    )
    .run();
  return mint;
}

/** One real observed price, as the indexing path would append it after a chain sync. */
export function seedPriceSample(
  env: RuntimeEnv,
  mint: string,
  priceUsd: number,
  observedAt: number,
  volumeUsd = 1_000,
): void {
  const db = env.DB as unknown as FakeD1Database;
  db.prepare(
    "INSERT INTO token_price_samples (id, mint, price_usd, volume_usd, observed_at) VALUES (?1, ?2, ?3, ?4, ?5)",
  )
    .bind(`sample-${mint}-${observedAt}-${Math.round(priceUsd * 1e6)}`, mint, priceUsd, volumeUsd, observedAt)
    .run();
}

/** Seeds a trade so 24h volume and trade count are real, not fabricated. */
export function seedTrade(
  env: RuntimeEnv,
  mint: string,
  priceUsd: number,
  amount: number,
  blockTime: number,
  signature = `sig-${mint}-${blockTime}-${Math.round(amount)}`,
): void {
  const db = env.DB as unknown as FakeD1Database;
  db.prepare(
    "INSERT OR REPLACE INTO trades (signature, mint, side, price_usd, price_sol, amount, block_time) VALUES (?1, ?2, 'buy', ?3, 0, ?4, ?5)",
  )
    .bind(signature, mint, priceUsd, amount, blockTime)
    .run();
}

export interface SeedDiscoveryOptions {
  id?: string;
  eventId?: string;
  wallet: string;
  mint: string;
  valueUsd: number;
  tokenAmount?: number;
  rarity?: string;
  status?: "PENDING" | "ELIGIBLE" | "CLAIMED" | "HELD" | "REJECTED";
  createdAt?: number;
}

/** Inserts a discovery row directly, for exercising the multi-level budget caps. */
export function seedDiscovery(env: RuntimeEnv, options: SeedDiscoveryOptions): string {
  const id = options.id ?? `seed-${crypto.randomUUID()}`;
  const db = env.DB as unknown as FakeD1Database;
  db.prepare(
    `INSERT INTO discoveries
       (id, event_id, wallet, window, window_index, mint, symbol, rarity, visual_event,
        token_amount, value_usd, price_usd, eligibility_score, status, created_at)
     VALUES (?1, ?2, ?3, 'seed', 0, ?4, 'MINE', ?5, 'Stone', ?6, ?7, 0.01, 0, ?8, ?9)`,
  )
    .bind(
      id,
      options.eventId ?? `seed-evt-${id}`,
      options.wallet,
      options.mint,
      options.rarity ?? "common",
      options.tokenAmount ?? 100,
      options.valueUsd,
      options.status ?? "PENDING",
      options.createdAt ?? Math.floor(Date.now() / 1_000),
    )
    .run();
  return id;
}

/**
 * Reads a COUNT(*) synchronously. The fake's async API is backed by a synchronous driver, so
 * assertions can read state directly instead of going through the D1 promise shapes.
 */
export function countRows(env: RuntimeEnv, sql: string): number {
  const rows = (env.DB as unknown as FakeD1Database).all(sql);
  return Number(rows[0]?.total ?? 0);
}

/** Reads one column from one row, synchronously, for terse assertions. */
export function readValue<T extends SqlValue>(
  env: RuntimeEnv,
  sql: string,
  column: string,
): T | null {
  const db = env.DB as unknown as FakeD1Database;
  const rows = db.all(sql);
  if (rows.length === 0) return null;
  return (rows[0][column] as T) ?? null;
}
