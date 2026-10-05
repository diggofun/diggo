/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RuntimeEnv } from "./env";
import { creatorMines } from "./creatorMines";
import type { CreatorMineView } from "../shared/creatorMines";

const ME = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const PLAYER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const LAUNCH = "So11111111111111111111111111111111111111112";
const ADDED = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const SOMEONE_ELSES = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const CONFIG = "Cfg1111111111111111111111111111111111111111";

class Statement {
  constructor(private db: DatabaseSync, private sql: string, private values: unknown[] = []) {}
  bind(...values: unknown[]) { return new Statement(this.db, this.sql, values); }
  async first<T>() { return (this.db.prepare(this.sql).get(...(this.values as never[])) as T | undefined) ?? null; }
  async all<T>() { return { results: this.db.prepare(this.sql).all(...(this.values as never[])) as T[] }; }
  async run() { const result = this.db.prepare(this.sql).run(...(this.values as never[])); return { meta: { changes: Number(result.changes) } }; }
}

function environment() {
  const db = new DatabaseSync(":memory:");
  const directory = fileURLToPath(new URL("../migrations/", import.meta.url));
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) db.exec(readFileSync(join(directory, file), "utf8"));
  const now = Math.floor(Date.now() / 1_000);
  db.prepare("INSERT INTO meteora_pools (pool, config, creator, base_mint, base_vault, quote_mint, symbol, name, created_at) VALUES ('p1', ?, ?, ?, 'v', 'q', 'DIG', 'Dig', ?)").run(CONFIG, ME, LAUNCH, now);
  db.prepare("INSERT INTO sponsored_mines (mint, symbol, name, decimals, reserve, sponsor, mining_starts_at, mining_seconds, created_by, created_at, updated_at, sponsor_wallet) VALUES (?, 'PUMP', 'Pump', 6, '1000000000', 'Team', ?, 2592000, ?, ?, ?, ?)")
    .run(ADDED, now, ME, now, now, ME);
  db.prepare("INSERT INTO sponsored_mines (mint, symbol, name, decimals, reserve, sponsor, mining_starts_at, mining_seconds, created_by, created_at, updated_at) VALUES (?, 'OTHER', 'Other', 6, '1000', 'Them', ?, 2592000, ?, ?, ?)")
    .run(SOMEONE_ELSES, now, PLAYER, now, now);
  db.prepare("INSERT INTO game_claims (id, wallet, mint, kind, amount, status, idempotency_key, created_at) VALUES ('c1', ?, ?, 'MINING', '2500000', 'PAID', 'k1', ?)").run(PLAYER, ADDED, now);
  db.prepare("INSERT INTO game_claims (id, wallet, mint, kind, amount, status, idempotency_key, created_at) VALUES ('c2', ?, ?, 'MINING', '9000000', 'PENDING', 'k2', ?)").run(ME, ADDED, now);
  const env = {
    DB: { prepare: (sql: string) => new Statement(db, sql), batch: async () => [] },
    TOKEN_CACHE: { get: async (key: string) => (key === "auth:session:s" ? ME : null) },
    METEORA_DBC_CONFIG: CONFIG,
    CHAIN_MODE: "meteora",
  } as unknown as RuntimeEnv;
  return env;
}

const request = (session: boolean) => new Request("https://diggo.fun/api/creator/mines", { headers: session ? { authorization: "Bearer s" } : {} });

describe("creator dashboard", () => {
  it("needs a signed-in wallet", async () => {
    expect((await creatorMines(request(false), environment())).status).toBe(401);
  });

  it("lists the coins this wallet added and launched, never someone else's, with paid-out holders", async () => {
    const response = await creatorMines(request(true), environment());
    const { mines } = await response.json() as { mines: CreatorMineView[] };
    expect(mines.map((mine) => [mine.symbol, mine.kind]).sort()).toEqual([["DIG", "launch"], ["PUMP", "added"]]);
    const pump = mines.find((mine) => mine.symbol === "PUMP")!;
    // Only PAID claims count: one wallet received 2.5 PUMP.
    expect(pump).toMatchObject({ holdersPaid: 1, paidOut: 2.5, reserve: 1000, remaining: 1000, open: true });
  });
});
