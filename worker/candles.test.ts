import { describe, expect, it } from "vitest";
import type { RuntimeEnv } from "./env";
import { meteoraCandles } from "./candles";

const MINT = "12cens35GKeZH8is6R1gdbJ1faktyLrXgHvHyBB6veb7";

function fixture(rows: object[], poolExists = true) {
  const queries: { sql: string; args: unknown[] }[] = [];
  const env = {
    METEORA_DBC_CONFIG: "dbc-config",
    ORACLE_SOL_USD_OVERRIDE: "100",
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            queries.push({ sql, args });
            return {
              async first() { return poolExists ? { pool: "pool-1", decimals: 9 } : null; },
              async all() { return { results: rows }; },
            };
          },
        };
      },
    },
  } as unknown as RuntimeEnv;
  return { env, queries };
}

describe("Meteora candle API", () => {
  it("rejects invalid mints and intervals before querying", async () => {
    const { env, queries } = fixture([]);
    expect((await meteoraCandles(env, "bad", "1m")).status).toBe(400);
    expect((await meteoraCandles(env, MINT, "2h")).status).toBe(400);
    expect(queries).toHaveLength(0);
  });

  it("returns 404 for a mint outside the configured pool", async () => {
    const { env } = fixture([], false);
    expect((await meteoraCandles(env, MINT, "1m")).status).toBe(404);
  });

  it("returns an honest empty series when no swaps are indexed", async () => {
    const { env } = fixture([]);
    const response = await meteoraCandles(env, MINT, "1m");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ candles: [], trades: 0, interval: "1m", solUsd: 100 });
  });

  it("reads the latest swaps, then restores execution order for OHLCV", async () => {
    const minute = Math.floor(Date.now() / 60_000) * 60;
    const { env, queries } = fixture([
      { side: "sell", amount_in: "1000000000", amount_out: "300000000", sol_amount_lamports: "300000000", block_time: minute + 2 },
      { side: "buy", amount_in: "200000000", amount_out: "1000000000", sol_amount_lamports: "200000000", block_time: minute + 1 },
    ]);
    const response = await meteoraCandles(env, MINT, "1m");
    const body = await response.json() as { trades: number; candles: { open: number; high: number; low: number; close: number; volumeSol: number; trades: number }[] };
    expect(body.trades).toBe(2);
    expect(body.candles).toEqual([{ time: minute, open: 0.2, high: 0.3, low: 0.2, close: 0.3, volumeSol: 0.5, trades: 2 }]);
    expect(queries[1]!.sql).toContain("ORDER BY block_time DESC");
    expect(queries[1]!.args[0]).toBe("pool-1");
  });
});
