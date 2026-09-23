/// <reference types="node" />
/**
 * The indexed discovery, as cosmetics, admin, telemetry and risk read it.
 *
 * Migration 0021 dropped `discoveries` and replaced it with `discovery_events`, which is written
 * from the program's own events: one PENDING row per `create_discovery_roll`, then SETTLED or
 * EXPIRED when the roll is resolved. Two facts about that table decide every number below.
 *
 *   - `rarity` is the program's **0-based tier index**, so tier 0 (the cheapest tier) is a real
 *     discovery and never means "nothing". A roll the seed gives no outcome to settles at tier 0
 *     with zero units, exactly like one the coin's own eligibility floors downgrade away, so the
 *     payout - not the tier - is what says whether a discovery happened.
 *   - `value_lamports` is the only value column. The USD figures the metric set and the admin view
 *     report are conversions of it at the display rate, and the rate's availability is reported
 *     beside them instead of a zero that reads like a measurement.
 *
 * The tests run the real handlers against real SQLite with every migration applied, so the SQL
 * these modules issue is the SQL the Worker runs against the v2 schema.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DIGGO_CONFIG } from "../shared/config";
import { RISK_OPS } from "../shared/riskOps";
import { adminAbuse } from "./admin";
import { syncAchievements } from "./cosmetics";
import type { RuntimeEnv } from "./env";
import { refreshAccountRisk } from "./risk";
import { collectMetrics } from "./telemetry";

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

  /**
   * D1 answers a batched statement with both its rows and its change count, and callers read
   * either one: the metrics batch is all reads, the achievement batch is all writes.
   */
  async result(): Promise<{ results: unknown[]; success: boolean; meta: { changes: number } }> {
    const statement = this.db.prepare(this.sql);
    if (!/^\s*(select|with)/i.test(this.sql)) {
      const info = statement.run(...this.bound);
      return { results: [], success: true, meta: { changes: Number(info.changes) } };
    }
    return { results: statement.all(...this.bound) as unknown[], success: true, meta: { changes: 0 } };
  }
}

class SqliteD1 {
  constructor(readonly db: DatabaseSync) {}

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.db, sql);
  }

  async batch(statements: readonly SqliteStatement[]): Promise<unknown[]> {
    return Promise.all(statements.map((statement) => statement.result()));
  }
}

class FakeKv {
  private readonly store = new Map<string, string>();

  constructor(entries: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(entries)) this.store.set(key, value);
  }

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

/** A cache that is down, which is how the display rate becomes unavailable without a network. */
class UnavailableKv {
  async get(): Promise<never> {
    throw new Error("kv unavailable");
  }

  async put(): Promise<void> {}

  async delete(): Promise<void> {}
}

interface Harness {
  db: DatabaseSync;
  env: RuntimeEnv;
}

function harness(overrides: Partial<RuntimeEnv> = {}): Harness {
  const db = new DatabaseSync(":memory:");
  const directory = fileURLToPath(new URL("../migrations/", import.meta.url));
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(directory, file), "utf8"));
  }
  const env = { DB: new SqliteD1(db), TOKEN_CACHE: new FakeKv(), ...overrides } as unknown as RuntimeEnv;
  return { db, env };
}

const WALLET = "So11111111111111111111111111111111111111112";
const OTHER_WALLET = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ADMIN_WALLET = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SOL = 1_000_000_000;
const NOW = 1_800_000_000;

interface RollFixture {
  opportunity: string;
  status: "PENDING" | "SETTLED" | "EXPIRED";
  wallet?: string;
  /** The program's 0-based tier index; tier 0 is a real discovery, not "no discovery". */
  rarity?: number | null;
  units?: string | null;
  valueLamports?: string | null;
  blockTime?: number;
}

/** One indexed discovery event, exactly as the indexer writes it from the program's events. */
function recordRoll(db: DatabaseSync, fixture: RollFixture): void {
  db.prepare(
    "INSERT INTO discovery_events (id, opportunity, coin, wallet, window_index, day_index, epoch_index," +
      " status, rarity, units, value_lamports, budget_lamports, signature, slot, block_time, created_at)" +
      " VALUES (?, ?, 'coin', ?, 0, 0, 0, ?, ?, ?, ?, '0', ?, 1, ?, ?)",
  ).run(
    fixture.opportunity,
    fixture.opportunity,
    fixture.wallet ?? WALLET,
    fixture.status,
    fixture.rarity === undefined || fixture.rarity === null ? null : BigInt(fixture.rarity),
    fixture.units ?? null,
    fixture.valueLamports ?? null,
    "sig-" + fixture.opportunity,
    BigInt(fixture.blockTime ?? NOW),
    BigInt(fixture.blockTime ?? NOW),
  );
}

describe("the v2 discovery index", () => {
  it("has discovery_events and no longer has the dropped discoveries table", () => {
    const { db } = harness();
    expect(() => db.prepare("SELECT COUNT(*) FROM discoveries").get()).toThrow(/no such table/);
    expect(Number((db.prepare("SELECT COUNT(*) AS n FROM discovery_events").get() as { n: number }).n)).toBe(0);
  });
});

describe("achievements count discoveries, not rolls", () => {
  it("awards First Find for a settled roll that paid, including the cheapest tier", async () => {
    const { db, env } = harness();
    // A wallet that can roll has an activated PlayerAccount, so the index holds its crew mirror.
    const starter = DIGGO_CONFIG.crew.starterLevels;
    db.prepare(
      "INSERT INTO player_accounts (player, wallet, miners_level, drills_level, carts_level, foreman_level," +
        " storage_level) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "player-pda",
      WALLET,
      BigInt(starter.miners),
      BigInt(starter.drills),
      BigInt(starter.carts),
      BigInt(starter.foreman),
      BigInt(starter.storage),
    );
    recordRoll(db, { opportunity: "op-common", status: "SETTLED", rarity: 0, units: "1000", valueLamports: "1000000" });
    recordRoll(db, { opportunity: "op-epic", status: "SETTLED", rarity: 4, units: "2000", valueLamports: "2000000" });

    const result = await syncAchievements(env, WALLET, NOW);

    expect(result.awarded.map((entry) => entry.id)).toContain("FIRST_DISCOVERY");
  });

  it("counts no discovery for a roll that never paid, however it ended", async () => {
    const { db, env } = harness();
    // A roll the seed gave no outcome to: the program settles it at tier 0 and pays nothing.
    recordRoll(db, { opportunity: "op-empty", status: "SETTLED", rarity: 0, units: "0", valueLamports: "0" });
    recordRoll(db, { opportunity: "op-pending", status: "PENDING" });
    recordRoll(db, { opportunity: "op-expired", status: "EXPIRED" });

    const result = await syncAchievements(env, WALLET, NOW);

    expect(result.awarded.map((entry) => entry.id)).not.toContain("FIRST_DISCOVERY");
    expect(result.awarded).toEqual([]);
  });

  /**
   * The index can settle a roll before the indexer has written the wallet's PlayerAccount mirror,
   * and the two halves of an award are not one write: the row is inserted with the ORE it granted
   * already recorded, and only then is that ORE credited against the crew's storage capacity. A
   * crew that has not been indexed yet reads as all zeros, which is below the crew floor, so
   * crediting the ORE throws - after the achievement row has landed. The award is therefore
   * deferred whole until the mirror exists, rather than being written with ORE the crew cannot be
   * shown to hold.
   */
  it("defers a newly earned award until the crew mirror behind it is indexed, then pays it once", async () => {
    const { db, env } = harness();
    recordRoll(db, { opportunity: "op-early", status: "SETTLED", rarity: 0, units: "1000", valueLamports: "1000000" });

    const deferred = await syncAchievements(env, WALLET, NOW);

    expect(deferred).toEqual({ awarded: [], oreGranted: 0 });
    expect(Number((db.prepare("SELECT COUNT(*) AS n FROM player_achievements WHERE wallet = ?").get(WALLET) as { n: number }).n)).toBe(0);
    const balanceBefore = db.prepare("SELECT ore_balance AS ore FROM players WHERE wallet = ?").get(WALLET) as { ore: string | null };
    expect(balanceBefore.ore).toBeNull();

    // The indexer catches up: it writes the PlayerAccount row and the denormalised profile mirror
    // together, which is the pair worker/indexStore.ts refreshes in one statement.
    const starter = DIGGO_CONFIG.crew.starterLevels;
    db.prepare(
      "INSERT INTO player_accounts (player, wallet, miners_level, drills_level, carts_level, foreman_level," +
        " storage_level) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "player-pda",
      WALLET,
      BigInt(starter.miners),
      BigInt(starter.drills),
      BigInt(starter.carts),
      BigInt(starter.foreman),
      BigInt(starter.storage),
    );
    db.prepare("UPDATE players SET indexed_at = ?1, ore_balance = '0' WHERE wallet = ?2").run(BigInt(NOW), WALLET);

    // The deferral wrote nothing, so the next sweep owes the same award and pays it against the
    // crew's storage capacity.
    const paid = await syncAchievements(env, WALLET, NOW);

    expect(paid.awarded.map((entry) => entry.id)).toContain("FIRST_DISCOVERY");
    expect(paid.oreGranted).toBeGreaterThan(0);
    const credited = Number((db.prepare("SELECT ore_balance AS ore FROM players WHERE wallet = ?").get(WALLET) as { ore: string }).ore);
    expect(credited).toBe(paid.oreGranted);

    // Idempotent: the deferred sweep left no row behind and the paid sweep is not repeated.
    expect(await syncAchievements(env, WALLET, NOW)).toEqual({ awarded: [], oreGranted: 0 });
    expect(Number((db.prepare("SELECT ore_balance AS ore FROM players WHERE wallet = ?").get(WALLET) as { ore: string }).ore)).toBe(credited);
  });

  it("treats a mirror row that states no crew as unusable rather than pricing an award from it", async () => {
    const { db, env } = harness();
    // Every level column defaults to 0, which is below the crew floor: a row like this states no
    // crew and therefore no capacity, so the award waits for a row that does.
    db.prepare("INSERT INTO player_accounts (player, wallet) VALUES (?, ?)").run("player-pda", WALLET);
    recordRoll(db, { opportunity: "op-early", status: "SETTLED", rarity: 0, units: "1000", valueLamports: "1000000" });

    expect(await syncAchievements(env, WALLET, NOW)).toEqual({ awarded: [], oreGranted: 0 });
    expect(Number((db.prepare("SELECT COUNT(*) AS n FROM player_achievements WHERE wallet = ?").get(WALLET) as { n: number }).n)).toBe(0);
  });
});

describe("discovery metrics", () => {
  it("counts and values settled discoveries in the units the program used", async () => {
    const { db, env } = harness({ ORACLE_SOL_USD_OVERRIDE: "150" });
    recordRoll(db, { opportunity: "op-1", status: "SETTLED", rarity: 0, units: "5", valueLamports: String(2 * SOL) });
    recordRoll(db, { opportunity: "op-2", status: "SETTLED", rarity: 4, units: "9", valueLamports: String(SOL) });
    recordRoll(db, { opportunity: "op-3", status: "SETTLED", rarity: 0, units: "0", valueLamports: "0" });
    recordRoll(db, { opportunity: "op-4", status: "EXPIRED" });
    recordRoll(db, { opportunity: "op-5", status: "PENDING" });
    recordRoll(db, {
      opportunity: "op-old",
      status: "SETTLED",
      rarity: 2,
      units: "3",
      valueLamports: String(50 * SOL),
      blockTime: NOW - RISK_OPS.clusterWindowSeconds - 60,
    });

    const report = await collectMetrics(env, NOW);

    expect(report.snapshot.discoveriesPerHour).toBe(2);
    expect(report.discoveriesInWindow).toBe(2);
    expect(report.reserveDrainedInWindowLamports).toBe(String(3 * SOL));
    expect(report.reserveDrainedInWindowUsd).toBeCloseTo(450, 6);
    expect(report.snapshot.avgDiscoveryValueUsd).toBeCloseTo(225, 6);
    expect(report.snapshot.reserveDrainVelocityUsdPerHour).toBeCloseTo(450, 6);
    expect(report.snapshot.reserveDrainedFraction).toBeGreaterThan(0);
    expect(report.usdPriceAvailable).toBe(true);
  });

  it("keeps the lamport truth and flags the USD figures when no rate is available", async () => {
    const { db, env } = harness({ TOKEN_CACHE: new UnavailableKv() as unknown as RuntimeEnv["TOKEN_CACHE"] });
    recordRoll(db, { opportunity: "op-1", status: "SETTLED", rarity: 1, units: "7", valueLamports: String(4 * SOL) });

    const report = await collectMetrics(env, NOW);

    expect(report.usdPriceAvailable).toBe(false);
    expect(report.reserveDrainedInWindowLamports).toBe(String(4 * SOL));
    expect(report.reserveDrainedInWindowUsd).toBe(0);
    expect(report.snapshot.reserveDrainVelocityUsdPerHour).toBe(0);
    expect(report.discoveriesInWindow).toBe(1);
  });
});

describe("risk signals", () => {
  it("reads settled discoveries as valid claims and empty rolls as none", async () => {
    const { db, env } = harness();
    for (let index = 0; index < 10; index += 1) {
      recordRoll(db, {
        opportunity: "paid-" + index,
        status: "SETTLED",
        rarity: 1,
        units: "10",
        valueLamports: String(SOL),
        wallet: WALLET,
      });
      recordRoll(db, {
        opportunity: "empty-" + index,
        status: "SETTLED",
        rarity: 0,
        units: "0",
        valueLamports: "0",
        wallet: OTHER_WALLET,
      });
      recordRoll(db, { opportunity: "expired-" + index, status: "EXPIRED", wallet: OTHER_WALLET });
    }

    const paid = await refreshAccountRisk(env, WALLET, { now: NOW });
    const empty = await refreshAccountRisk(env, OTHER_WALLET, { now: NOW });

    expect(paid.trust).toBeGreaterThan(empty.trust);
  });
});

describe("the admin abuse view", () => {
  it("reports discoveries, lamports and the crew level from the v2 mirrors", async () => {
    const session = "admin-session";
    const { db, env } = harness({
      ADMIN_WALLETS: ADMIN_WALLET,
      ORACLE_SOL_USD_OVERRIDE: "150",
      TOKEN_CACHE: new FakeKv({ ["auth:session:" + session]: ADMIN_WALLET }) as unknown as RuntimeEnv["TOKEN_CACHE"],
    });
    db.prepare(
      "INSERT INTO players (wallet, created_at, risk_state, risk_score, active_days, streak)" +
        " VALUES (?, ?, 'NORMAL', 0, ?, ?)",
    ).run(WALLET, BigInt(NOW - 86_400), BigInt(12), BigInt(3));
    db.prepare(
      "INSERT INTO player_accounts (player, wallet, miners_level, drills_level, carts_level, foreman_level," +
        " storage_level) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("player-pda", WALLET, BigInt(3), BigInt(2), BigInt(1), BigInt(0), BigInt(4));
    recordRoll(db, { opportunity: "op-1", status: "SETTLED", rarity: 0, units: "5", valueLamports: String(2 * SOL) });
    recordRoll(db, { opportunity: "op-2", status: "SETTLED", rarity: 5, units: "9", valueLamports: String(SOL) });
    recordRoll(db, { opportunity: "op-3", status: "SETTLED", rarity: 0, units: "0", valueLamports: "0" });
    recordRoll(db, { opportunity: "op-4", status: "EXPIRED" });

    const response = await adminAbuse(
      new Request("https://diggo.fun/api/admin/abuse?wallet=" + WALLET, {
        headers: { authorization: "Bearer " + session },
      }),
      env,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      accounts: Array<{
        wallet: string;
        discoveries: number;
        claimedValueLamports: string;
        claimedValueUsd: number;
        usdPriceAvailable: boolean;
        crewLevel: number;
      }>;
    };
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0].wallet).toBe(WALLET);
    expect(body.accounts[0].discoveries).toBe(2);
    expect(body.accounts[0].claimedValueLamports).toBe(String(3 * SOL));
    expect(body.accounts[0].claimedValueUsd).toBeCloseTo(450, 6);
    expect(body.accounts[0].usdPriceAvailable).toBe(true);
    expect(body.accounts[0].crewLevel).toBe(10);
  });
});
