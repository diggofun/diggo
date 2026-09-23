/**
 * Test-only harness for the mining, crew, streak and reward-claim loop.
 *
 * The D1, KV, queue and migration-runner doubles all live in ./d1-sqlite.ts - the single
 * SQLite-backed test double in this directory (node:sqlite, every migration applied in order, so
 * the CHECK/UNIQUE constraints and the conditional-UPDATE semantics the Worker relies on are the
 * real thing). This file adds only what the mining tests need on top of them: signed wallets,
 * session cookies, request builders and row readers.
 *
 * Time is not faked here: tests drive it with vi.setSystemTime, which is all the mining code
 * reads (Date.now()).
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";
import { DatabaseSync } from "node:sqlite";
import type { IndexingEvent, MineAuthority, TokenStatus } from "../../shared/types";
import type { RuntimeEnv } from "../env";
import {
  rowToMineState,
  type MineState,
  type PositionRow,
  type RewardClaimRow,
  type RewardClaimStatus,
} from "../mining";
import type { PlayerRow } from "../player";
import { FakeKv, FakeQueue, SqliteD1, applyMigrations } from "./d1-sqlite";

export interface TestWallet {
  /** base58 public key: the wallet address the Worker sees. */
  address: string;
  secretKey: Uint8Array;
}

export interface Harness {
  env: RuntimeEnv;
  /** The D1 double itself, for tests that want to read a row without a worker helper. */
  db: SqliteD1;
  queue: IndexingEvent[];
  createWallet(): TestWallet;
  sign(wallet: TestWallet, message: string): string;
  /** Registers a session in KV and returns the cookie header for it. */
  sessionFor(address: string): Promise<Record<string, string>>;
  close(): void;
}

export async function createHarness(): Promise<Harness> {
  const database = new SqliteD1(new DatabaseSync(":memory:"));
  applyMigrations(database.db);
  const kv = new FakeKv();
  const queue = new FakeQueue();
  const env = {
    DB: database,
    TOKEN_CACHE: kv,
    INDEXING_QUEUE: queue,
    // Left undefined on purpose: with no program id and no chain sync a mine is OFFCHAIN, the
    // branch where these tables are the accounting source.
    DIGGO_PROGRAM_ID: undefined,
    SOLANA_CLUSTER: "devnet",
  } as unknown as RuntimeEnv;

  return {
    env,
    db: database,
    queue: queue.messages,
    createWallet(): TestWallet {
      const secretKey = ed25519.utils.randomSecretKey();
      return { address: bs58.encode(ed25519.getPublicKey(secretKey)), secretKey };
    },
    sign(wallet: TestWallet, message: string): string {
      return bs58.encode(ed25519.sign(new TextEncoder().encode(message), wallet.secretKey));
    },
    async sessionFor(address: string): Promise<Record<string, string>> {
      const token = "session-" + crypto.randomUUID();
      await kv.put("auth:session:" + token, address, { expirationTtl: 3_600 });
      return { cookie: "diggo_session=" + token };
    },
    close(): void {
      database.close();
    },
  };
}

let ipCounter = 0;

function nextIp(prefix: string): string {
  ipCounter += 1;
  return prefix + "." + Math.floor(ipCounter / 250) + "." + (ipCounter % 250);
}

/** A JSON request with a unique source IP, so per-IP rate limits never bleed across tests. */
export function jsonRequest(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://diggo.fun" + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": nextIp("10.0"),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

export function getRequest(path: string, headers: Record<string, string> = {}): Request {
  return new Request("https://diggo.fun" + path, {
    method: "GET",
    headers: { "cf-connecting-ip": nextIp("10.1"), ...headers },
  });
}

export interface TokenSeed {
  mint: string;
  symbol?: string;
  status?: TokenStatus;
  reserveRemaining?: number;
  reserveTotal?: number;
  rewardPerBlock?: number;
  syncedAt?: number;
  /**
   * Which venue the market is on. Defaults to the graduated pool, because the accounting these
   * tests exercise is the reserve phase: a mine on its curve pays out of the curve's own cap
   * instead (see worker/test/curve-mining.test.ts), and a market on the curve with no cap pays
   * nothing at all.
   */
  venue?: "curve" | "pool";
  /** The curve-mining ledger, for a test that wants the curve phase instead of the reserve. */
  curveMining?: { cap?: number; mined?: number; blockReward?: number; unpaid?: number };
}

export async function seedToken(env: RuntimeEnv, seed: TokenSeed): Promise<void> {
  const db = env.DB as unknown as SqliteD1;
  const now = Math.floor(Date.now() / 1_000);
  const curve = seed.curveMining ?? {};
  await db
    .prepare(
      "INSERT INTO tokens (mint, slug, name, symbol, description, creator, status, reserve_remaining, " +
        "reserve_total, reward_per_block, next_block_at, next_epoch_at, synced_at, venue, " +
        "curve_mining_open, curve_mining_cap, curve_mining_mined, curve_mining_unpaid, curve_mining_block_reward) " +
        "VALUES (?1, ?2, ?3, ?4, 'test', 'creator', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
    )
    .bind(
      seed.mint,
      "slug-" + seed.mint,
      "Token " + seed.mint,
      seed.symbol ?? seed.mint.slice(0, 4).toUpperCase(),
      seed.status ?? "MINING_ACTIVE",
      seed.reserveRemaining ?? 1_000_000,
      seed.reserveTotal ?? 1_000_000,
      seed.rewardPerBlock ?? 1_000,
      now + 300,
      now + 604_800,
      seed.syncedAt ?? 0,
      seed.venue ?? "pool",
      (curve.cap ?? 0) > (curve.mined ?? 0) ? 1 : 0,
      curve.cap ?? 0,
      curve.mined ?? 0,
      curve.unpaid ?? 0,
      curve.blockReward ?? 0,
    )
    .run();
}

export async function seedPlayer(
  env: RuntimeEnv,
  wallet: string,
  patch: Record<string, number | string | null> = {},
): Promise<void> {
  const db = env.DB as unknown as SqliteD1;
  await db.prepare("INSERT OR IGNORE INTO players (wallet) VALUES (?1)").bind(wallet).run();
  for (const [column, value] of Object.entries(patch)) {
    await db.prepare("UPDATE players SET " + column + " = ?1 WHERE wallet = ?2").bind(value, wallet).run();
  }
}

export async function readPlayer(env: RuntimeEnv, wallet: string): Promise<PlayerRow> {
  const db = env.DB as unknown as SqliteD1;
  const row = await db.prepare("SELECT * FROM players WHERE wallet = ?1").bind(wallet).first<PlayerRow>();
  if (!row) throw new Error("missing player " + wallet);
  return row;
}

export async function readMineState(env: RuntimeEnv, mint: string): Promise<MineState> {
  const db = env.DB as unknown as SqliteD1;
  const row = await db.prepare("SELECT * FROM mine_reward_state WHERE mint = ?1").bind(mint).first<Record<string, unknown>>();
  if (!row) throw new Error("missing mine state " + mint);
  return rowToMineState(row as unknown as Parameters<typeof rowToMineState>[0]);
}

export async function readPosition(
  env: RuntimeEnv,
  wallet: string,
  mint: string,
): Promise<PositionRow | null> {
  const db = env.DB as unknown as SqliteD1;
  return db
    .prepare("SELECT * FROM mining_positions WHERE wallet = ?1 AND mint = ?2")
    .bind(wallet, mint)
    .first<PositionRow>();
}

export async function readClaims(env: RuntimeEnv, wallet: string): Promise<RewardClaimRow[]> {
  const db = env.DB as unknown as SqliteD1;
  const result = await db
    .prepare("SELECT * FROM reward_claims WHERE wallet = ?1 ORDER BY created_at ASC")
    .bind(wallet)
    .all<RewardClaimRow>();
  return result.results;
}

export interface SocialMetricsRow {
  blocks_won: number;
  mine_switches: number;
  fully_mined_witnessed: number;
}

/**
 * The achievement counters mining bumps (spec 68). An absent row reads as all zero, which is
 * exactly how worker/cosmetics.ts reads it, so a test can assert before any counter exists.
 */
export async function readSocialMetrics(env: RuntimeEnv, wallet: string): Promise<SocialMetricsRow> {
  const db = env.DB as unknown as SqliteD1;
  const row = await db
    .prepare("SELECT blocks_won, mine_switches, fully_mined_witnessed FROM player_social_metrics WHERE wallet = ?1")
    .bind(wallet)
    .first<SocialMetricsRow>();
  return row ?? { blocks_won: 0, mine_switches: 0, fully_mined_witnessed: 0 };
}

export async function readTokenStatus(env: RuntimeEnv, mint: string): Promise<TokenStatus | null> {
  const db = env.DB as unknown as SqliteD1;
  const row = await db.prepare("SELECT status FROM tokens WHERE mint = ?1").bind(mint).first<{ status: TokenStatus }>();
  return row?.status ?? null;
}

/** Forces a condition on a claim row (expiry, HELD, ...) without going through the API. */
export async function patchClaim(
  env: RuntimeEnv,
  claimId: string,
  patch: Record<string, number | string | null>,
): Promise<void> {
  const db = env.DB as unknown as SqliteD1;
  for (const [column, value] of Object.entries(patch)) {
    await db.prepare("UPDATE reward_claims SET " + column + " = ?1 WHERE id = ?2").bind(value, claimId).run();
  }
}

export async function openBreaker(env: RuntimeEnv, scope: string, mint: string | null = null): Promise<void> {
  const db = env.DB as unknown as SqliteD1;
  await db
    .prepare(
      "INSERT INTO circuit_breakers (id, scope, mint, open, reason, actor, updated_at) VALUES (?1, ?2, ?3, 1, 'test', 'test', ?4)",
    )
    .bind(scope + ":" + (mint ?? "*"), scope, mint, Math.floor(Date.now() / 1_000))
    .run();
}

/**
 * Places one admin-style restriction (spec 63). The real gate reads account_restrictions, so
 * this is how a test puts a wallet into CHALLENGE_REQUIRED or a claim under CLAIM_HOLD.
 */
export async function seedRestriction(env: RuntimeEnv, wallet: string, kind: string): Promise<void> {
  const db = env.DB as unknown as SqliteD1;
  await db
    .prepare(
      "INSERT INTO account_restrictions (wallet, kind, reason_code, created_at, expires_at, created_by) " +
        "VALUES (?1, ?2, 'test', ?3, NULL, 'test') ON CONFLICT(wallet, kind) DO UPDATE SET expires_at = NULL",
    )
    .bind(wallet, kind, Math.floor(Date.now() / 1_000))
    .run();
}

export async function clearRestriction(env: RuntimeEnv, wallet: string, kind: string): Promise<void> {
  const db = env.DB as unknown as SqliteD1;
  await db.prepare("DELETE FROM account_restrictions WHERE wallet = ?1 AND kind = ?2").bind(wallet, kind).run();
}

/** Inserts a settled claim row directly, for claim-endpoint tests that skip the mining loop. */
export async function seedClaim(
  env: RuntimeEnv,
  input: {
    id: string;
    wallet: string;
    mint: string;
    amount: string;
    eligibleUntil: number;
    status?: RewardClaimStatus;
    settlementSeq?: number;
    authority?: MineAuthority;
  },
): Promise<void> {
  const db = env.DB as unknown as SqliteD1;
  await db
    .prepare(
      "INSERT INTO reward_claims (id, wallet, mint, amount, status, created_at, eligible_until, " +
        "settlement_seq, authority) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
    )
    .bind(
      input.id,
      input.wallet,
      input.mint,
      input.amount,
      input.status ?? "ELIGIBLE",
      Math.floor(Date.now() / 1_000),
      input.eligibleUntil,
      input.settlementSeq ?? 1,
      input.authority ?? "OFFCHAIN",
    )
    .run();
}
