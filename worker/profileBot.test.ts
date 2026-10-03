/**
 * Profile bots: saved with a signed session, validated against the shared lists, served on the
 * public profile and joined into every leaderboard row. Runs against every migration in SQLite.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "./env";

const auth = vi.hoisted(() => ({ wallet: null as string | null }));
vi.mock("./auth", () => ({ sessionWallet: async () => auth.wallet }));

const { publicProfile, setProfileBot } = await import("./profile");
const { gameLeaderboards } = await import("./leaderboard");

type SqlValue = string | number | bigint | null | Uint8Array;

function bindable(values: readonly unknown[]): SqlValue[] {
  return values.map((value): SqlValue => {
    if (value === undefined) return null;
    if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
    return value as SqlValue;
  });
}

class SqliteStatement {
  constructor(private readonly db: DatabaseSync, private readonly sql: string, private readonly bound: readonly SqlValue[] = []) {}
  bind(...values: unknown[]): SqliteStatement {
    return new SqliteStatement(this.db, this.sql, bindable(values));
  }
  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...this.bound) as T | undefined) ?? null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...this.bound) as T[] };
  }
  async run(): Promise<{ success: boolean; meta: { changes: number } }> {
    const info = this.db.prepare(this.sql).run(...this.bound);
    return { success: true, meta: { changes: Number(info.changes) } };
  }
}

function harness(): { db: DatabaseSync; env: RuntimeEnv } {
  const db = new DatabaseSync(":memory:");
  const directory = fileURLToPath(new URL("../migrations/", import.meta.url));
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(directory, file), "utf8"));
  }
  const kv = new Map<string, string>();
  const env = {
    DB: { prepare: (sql: string) => new SqliteStatement(db, sql) },
    TOKEN_CACHE: {
      get: async (key: string) => kv.get(key) ?? null,
      put: async (key: string, value: string) => void kv.set(key, value),
    },
  } as unknown as RuntimeEnv;
  return { db, env };
}

const WALLET = "7XqAYxzX8rdiZUFMXpveryvaWpmp327TNAEpPUsEA4nL";
const OTHER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

function post(bot: unknown): Request {
  return new Request("https://diggo.test/api/profile/bot", { method: "POST", body: JSON.stringify({ bot }) });
}

async function profileOf(env: RuntimeEnv, wallet: string) {
  const response = await publicProfile(new Request("https://diggo.test/api/profile/" + wallet), env, wallet);
  return (await response.json()) as { username: string | null; bot: unknown };
}

describe("profile bots", () => {
  let env: RuntimeEnv;
  let db: DatabaseSync;
  beforeEach(() => {
    ({ env, db } = harness());
    auth.wallet = WALLET;
  });

  it("needs a signed session", async () => {
    auth.wallet = null;
    const response = await setProfileBot(post({ shape: "star", color: "#3b82f6", accessory: "none" }), env);
    expect(response.status).toBe(401);
  });

  it("saves, serves, changes and forgets the session wallet's bot", async () => {
    expect((await profileOf(env, WALLET)).bot).toBeNull();
    const saved = await setProfileBot(post({ shape: "ghost", color: "#3B82F6", accessory: "hat:crown" }), env);
    expect(saved.status).toBe(200);
    expect((await profileOf(env, WALLET)).bot).toEqual({ shape: "ghost", color: "#3b82f6", accessory: "hat:crown" });

    await setProfileBot(post({ shape: "star", color: "#ff6a00", accessory: "eyewear:shades" }), env);
    expect((await profileOf(env, WALLET)).bot).toEqual({ shape: "star", color: "#ff6a00", accessory: "eyewear:shades" });
    expect((await profileOf(env, OTHER)).bot).toBeNull();

    expect((await setProfileBot(post(null), env)).status).toBe(200);
    expect((await profileOf(env, WALLET)).bot).toBeNull();
  });

  it("refuses a look outside the lists or with a second accessory", async () => {
    for (const bot of [
      { shape: "dragon", color: "#ff6a00" },
      { shape: "star", color: "#123456" },
      { shape: "star", color: "#ff6a00", accessory: "hat:crown,eyewear:shades" },
      { shape: "star", color: "#ff6a00", hat: "crown", accessory: ["hat:crown", "eyewear:shades"] },
      "star",
    ]) {
      expect((await setProfileBot(post(bot), env)).status).toBe(400);
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM profile_bots").get()).toEqual({ n: 0 });
  });

  it("puts each player's bot and name on the Meteora leaderboards", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const insert = db.prepare(
      "INSERT INTO game_players (wallet, created_at, ore_earned, longest_streak, active_until, active_mining_power, miners_level) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run(WALLET, now, "500", 4, now + 3_600, "300", 3);
    insert.run(OTHER, now, "900", 2, now - 10, "800", 1);
    await setProfileBot(post({ shape: "heart", color: "#ec4899", accessory: "eyewear:goggles" }), env);
    db.prepare("INSERT INTO usernames (wallet, username, username_normalized, created_at, updated_at) VALUES (?, 'digger', 'digger', ?, ?)").run(WALLET, now, now);

    const response = await gameLeaderboards(new Request("https://diggo.test/api/leaderboards"), env, 25);
    const body = (await response.json()) as { boards: { key: string; entries: { wallet: string; username: string | null; bot: unknown; metric: number }[] }[] };
    const board = (key: string) => body.boards.find((entry) => entry.key === key)!.entries;

    expect(board("ore").map((entry) => entry.wallet)).toEqual([OTHER, WALLET]);
    expect(board("ore")[1]).toMatchObject({ username: "digger", bot: { shape: "heart", color: "#ec4899", accessory: "eyewear:goggles" } });
    expect(board("ore")[0]).toMatchObject({ username: null, bot: null });
    // Power only counts during a live shift, so the wallet whose shift ended drops off that board.
    expect(board("power").map((entry) => [entry.wallet, entry.metric])).toEqual([[WALLET, 300]]);
    expect(board("streak").map((entry) => entry.wallet)).toEqual([WALLET, OTHER]);
  });
});
