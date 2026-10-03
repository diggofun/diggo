/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { MINING_RESERVE } from "../game/contracts";
import { wholeTokens } from "../game/store";
import { meteoraBootstrap, meteoraMineInfo } from "./meteora";

const CONFIG = "diggo-config";
const MINT = "AvsnWvXkgKqfD1ciFFJyVkgjz3CeGPz38e2KS8uDPawN";
const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function harness(remaining: bigint | null) {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const directory = new URL("../../migrations/", import.meta.url);
  for (const file of readdirSync(directory).filter((file) => file.endsWith(".sql")).sort()) {
    db.exec(readFileSync(new URL(file, directory), "utf8"));
  }
  db.prepare("INSERT INTO meteora_pools (pool, config, creator, base_mint, base_vault, quote_mint, name, symbol) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("pool", CONFIG, "creator", MINT, "vault", "quote", "Diggo", "DIGGO");
  db.prepare("INSERT INTO meteora_pools (pool, config, creator, base_mint, base_vault, quote_mint) VALUES (?, ?, ?, ?, ?, ?)")
    .run("other-pool", "other-config", "creator", "other-mint", "vault", "quote");
  if (remaining !== null) {
    const committed = MINING_RESERVE - remaining;
    db.prepare("INSERT INTO game_mines (mint, mining_starts_at, initial_reserve, remaining, released, committed) VALUES (?, 0, ?, ?, ?, ?)")
      .run(MINT, MINING_RESERVE.toString(), remaining.toString(), committed.toString(), committed.toString());
  }
  const prepare = (sql: string, values: (string | number)[] = []) => ({
    bind: (...bound: (string | number)[]) => prepare(sql, bound),
    all: async () => ({ results: db.prepare(sql).all(...values) }),
    first: async () => db.prepare(sql).get(...values) ?? null,
  });
  return { DB: { prepare }, METEORA_DBC_CONFIG: CONFIG } as never;
}

describe("Meteora bootstrap mining reserve", () => {
  it.each([MINING_RESERVE, 199614036597622840n, 0n, null])(
    "serves the same reserve as mine info, including zero and a newly indexed pool: %s",
    async (remaining) => {
      const env = harness(remaining);
      const ctx = { waitUntil: () => undefined } as unknown as ExecutionContext;
      const response = await meteoraBootstrap(env, ctx);
      expect(response.status).toBe(200);
      const { tokens } = await response.json() as { tokens: Record<string, unknown>[] };
      expect(tokens).toHaveLength(1);
      expect(tokens[0]).toMatchObject({
        mint: MINT,
        reserveTotal: 200000000,
        reserveRemaining: wholeTokens(remaining ?? MINING_RESERVE),
      });
      const { mine } = await (await meteoraMineInfo(env, MINT, null)).json() as { mine: Record<string, unknown> };
      expect(tokens[0]!.reserveTotal).toBe(mine.reserveTotal);
      expect(tokens[0]!.reserveRemaining).toBe(mine.remainingReserve);
    },
  );
});
