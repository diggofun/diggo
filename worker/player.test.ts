/// <reference types="node" />
/**
 * The player profile: what it reports for a wallet the indexer has not reached, and what it refuses
 * to invent.
 *
 * The regression this file is written around was a live one. `GET /api/player/:wallet` answered 500
 * "Invalid crew levels" for every wallet without a mirrored PlayerAccount, because the profile
 * priced a zeroed crew with `crewPower`: the mirror's default for each level is 0, and the shared
 * tables are defined for `crew.minLevel..maxLevel` only, so they reject it. The endpoint tests run
 * against real SQLite with every migration applied, so the row the handler reads is the row D1
 * holds; the derivation tests pin what an unusable mirror reports.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  DIGGO_CONFIG,
  crewPower,
  crewTier,
  oreCapacity,
  type CrewLevels,
} from "../shared/economics";
import { DEVNET_PROGRAM_ID } from "./chainV2";
import type { RuntimeEnv } from "./env";
import {
  crewLevelsOf,
  crewLevelsUsable,
  crewStatsOf,
  playerAccountView,
  playerProfile,
} from "./player";
import type { CrewLevelsView, PlayerProfileView } from "./v2/types";

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

  async batch(statements: readonly SqliteStatement[]): Promise<unknown[]> {
    return statements.map((statement) => statement.run());
  }
}

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

/** The database the Worker sees: every migration, in order, against in-memory SQLite. */
function harness(): { db: DatabaseSync; env: RuntimeEnv } {
  const db = new DatabaseSync(":memory:");
  const directory = fileURLToPath(new URL("../migrations/", import.meta.url));
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(directory, file), "utf8"));
  }
  const env = {
    DB: new SqliteD1(db),
    TOKEN_CACHE: new FakeKv(),
    DIGGO_PROGRAM_ID: DEVNET_PROGRAM_ID,
  } as unknown as RuntimeEnv;
  return { db, env };
}

/** The wallet from the live 500: a profile row, no mirrored PlayerAccount, and a zeroed crew. */
const WALLET = "7XqAYxzX8rdiZUFMXpveryvaWpmp327TNAEpPUsEA4nL";
const NOW = 1_700_000_000;

/** The crew every player starts with, from the config the program is deployed with. */
const STARTER: CrewLevels = DIGGO_CONFIG.crew.starterLevels;

/** The profile's own crew view of a set of levels. */
function crewViewOf(levels: CrewLevels): CrewLevelsView {
  return crewLevelsOf({
    miners_level: levels.miners,
    drills_level: levels.drills,
    carts_level: levels.carts,
    foreman_level: levels.foreman,
    storage_level: levels.storage,
  });
}

/** What a wallet with no mirrored account is read as. */
const NO_CREW = crewViewOf({ miners: 0, drills: 0, carts: 0, foreman: 0, storage: 0 });

/** The lowest tier, which is what a crew that cannot be priced is reported as. */
const BASE_TIER = DIGGO_CONFIG.crew.tiers[0].name;

/** Whether the shared power table will price these levels - the question the predicate answers. */
function powerTablePrices(levels: CrewLevels): boolean {
  try {
    crewPower(levels);
    return true;
  } catch {
    return false;
  }
}

function seedProfile(db: DatabaseSync): void {
  db.prepare(
    "INSERT INTO players (wallet, created_at, risk_state, risk_score)" +
      " VALUES (?1, ?2, 'NORMAL', 0)",
  ).run(WALLET, NOW - 86_400);
}

/** A mirrored PlayerAccount with only the levels a test states; the rest takes its column default. */
function seedAccount(db: DatabaseSync, levels: CrewLevels, oreBalance = "0"): void {
  db.prepare(
    "INSERT INTO player_accounts (player, wallet, miners_level, drills_level, carts_level," +
      " foreman_level, storage_level, ore_balance) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
  ).run(
    "player-pda",
    WALLET,
    levels.miners,
    levels.drills,
    levels.carts,
    levels.foreman,
    levels.storage,
    oreBalance,
  );
}

describe("crewLevelsUsable", () => {
  it("accepts the levels the program can hold, at both ends of the range", () => {
    expect(crewLevelsUsable(STARTER)).toBe(true);
    expect(crewLevelsUsable({ miners: 1, drills: 1, carts: 1, foreman: 1, storage: 1 })).toBe(true);
    expect(crewLevelsUsable({ miners: 100, drills: 100, carts: 100, foreman: 100, storage: 100 })).toBe(
      true,
    );
  });

  it("rejects a zeroed mirror, a level past the ceiling and a level that is not whole", () => {
    expect(crewLevelsUsable({ miners: 0, drills: 0, carts: 0, foreman: 0, storage: 0 })).toBe(false);
    expect(crewLevelsUsable({ ...STARTER, storage: 101 })).toBe(false);
    expect(crewLevelsUsable({ ...STARTER, drills: 2.5 })).toBe(false);
  });

  it("agrees with the shared power table about every level it is asked about", () => {
    // The predicate exists so a caller can decide whether a crew is priceable without a throw. If
    // the tables ever move their floor or their ceiling, this is where the two stop agreeing.
    for (const level of [0, 1, 2, 100, 101]) {
      const levels = { miners: level, drills: level, carts: level, foreman: level, storage: level };
      expect(crewLevelsUsable(levels)).toBe(powerTablePrices(levels));
    }
  });
});

describe("crewStatsOf", () => {
  it("reports a zeroed mirror as no crew rather than throwing", () => {
    expect(crewStatsOf(NO_CREW, false)).toEqual({ power: 0, capacity: 0, tier: BASE_TIER });
  });

  it("prices a real crew with the protocol's own tables", () => {
    const stats = crewStatsOf(crewViewOf(STARTER), true);
    expect(stats.power).toBe(crewPower(STARTER));
    expect(stats.power).toBeGreaterThan(0);
    expect(stats.capacity).toBe(oreCapacity(STARTER));
    expect(stats.tier).toBe(crewTier(STARTER).name);
  });

  it("logs a mirror that states no crew, because a row that exists is not a new player", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      crewStatsOf(NO_CREW, true);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0][0])).toContain("player.crew_mirror_unusable");
    } finally {
      spy.mockRestore();
    }
  });

  it("stays quiet for a wallet that simply has no PlayerAccount", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      crewStatsOf(NO_CREW, false);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("playerAccountView", () => {
  it("answers for a wallet the indexer has not reached, with a zero crew", async () => {
    // The live failure: the profile row exists, the PlayerAccount mirror does not, and every level
    // the profile reported was 0.
    const { env, db } = harness();
    seedProfile(db);
    const account = await playerAccountView(env, WALLET, NOW);
    expect(account.indexed).toBe(false);
    expect(account.crewLevels).toEqual({
      miners: 0,
      drills: 0,
      carts: 0,
      foreman: 0,
      storage: 0,
      total: 0,
    });
    expect(account.crewPower).toBe(0);
    expect(account.oreCapacity).toBe(0);
    expect(account.crewTier).toBe(BASE_TIER);
    expect(account.activationState).toBe("NEVER_ACTIVATED");
    expect(account.riskState).toBe("NORMAL");
    expect(account.player).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });

  it("mirrors a real crew and prices it with the shared tables", async () => {
    const { env, db } = harness();
    seedAccount(db, STARTER, "4200");
    const account = await playerAccountView(env, WALLET, NOW);
    expect(account.indexed).toBe(true);
    expect(account.crewLevels).toEqual({ ...STARTER, total: 6 });
    expect(account.crewPower).toBe(crewPower(STARTER));
    expect(account.crewPower).toBeGreaterThan(0);
    expect(account.oreCapacity).toBe(oreCapacity(STARTER));
    expect(account.crewTier).toBe(crewTier(STARTER).name);
    expect(account.oreBalance).toBe(4200);
    expect(account.player).toBe("player-pda");
  });

  it("reports a mirror that states no crew as a zero crew, keeping its levels visible", async () => {
    // A decode or indexing fault writes levels the program cannot hold. They are reported exactly
    // as mirrored so the fault stays visible, and priced at zero rather than clamped up to a level
    // the wallet never bought.
    const { env, db } = harness();
    seedAccount(db, { miners: 5_000, drills: 0, carts: 1, foreman: 1, storage: 1 });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const account = await playerAccountView(env, WALLET, NOW);
      expect(account.indexed).toBe(true);
      expect(account.crewLevels).toEqual({
        miners: 5_000,
        drills: 0,
        carts: 1,
        foreman: 1,
        storage: 1,
        total: 5_003,
      });
      expect(account.crewPower).toBe(0);
      expect(account.oreCapacity).toBe(0);
      expect(account.crewTier).toBe(BASE_TIER);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("GET /api/player/:wallet", () => {
  function request(wallet: string): Request {
    return new Request("https://diggo.test/api/player/" + wallet);
  }

  it("answers instead of failing for a wallet with no mirrored PlayerAccount", async () => {
    const { env, db } = harness();
    seedProfile(db);
    const response = await playerProfile(request(WALLET), env, WALLET);
    expect(response.status).toBe(200);
    const { profile } = (await response.json()) as { profile: PlayerProfileView };
    // The shape the client already reads, unchanged.
    expect(Object.keys(profile).sort()).toEqual([
      "account",
      "achievements",
      "cosmetics",
      "positions",
      "season",
      "username",
      "wallet",
    ]);
    expect(profile.wallet).toBe(WALLET);
    expect(profile.username).toBeNull();
    expect(profile.positions).toEqual([]);
    expect(profile.account.indexed).toBe(false);
    expect(profile.account.crewLevels.total).toBe(0);
    expect(profile.account.crewPower).toBe(0);
    expect(profile.account.oreCapacity).toBe(0);
  });

  it("answers for an indexed wallet whose crew mirror cannot be priced", async () => {
    const { env, db } = harness();
    seedProfile(db);
    seedAccount(db, { miners: 0, drills: 0, carts: 0, foreman: 0, storage: 0 });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await playerProfile(request(WALLET), env, WALLET);
      expect(response.status).toBe(200);
      const { profile } = (await response.json()) as { profile: PlayerProfileView };
      expect(profile.account.indexed).toBe(true);
      expect(profile.account.crewPower).toBe(0);
      expect(profile.account.oreCapacity).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("still refuses a wallet that is not an address", async () => {
    const { env } = harness();
    const response = await playerProfile(request("not-an-address"), env, "not-an-address");
    expect(response.status).toBe(400);
  });
});
