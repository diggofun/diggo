import { describe, expect, it } from "vitest";
import { meteoraTokenBySlug, swapPriceSol } from "./meteora";

const MINT = "12cens35GKeZH8is6R1gdbJ1faktyLrXgHvHyBB6veb7";
const POOL = "4g7i7aWVvwnSn6K6VKyvzG5UFf2nFCXgYJ7uJUymhhMB";
const CONFIG = "5yxCKEmi1rc5ebKmWdHbzj2pEe7caqS8xqvQh5V8duMF";

function env(swaps: { latest?: object; baseline?: object; window?: object }, pool: object | null) {
  const prepare = (sql: string) => {
    const statement = {
      bind: () => statement,
      first: async () => {
        if (sql.includes("FROM meteora_pools")) return pool;
        if (sql.includes("COUNT(*)")) return swaps.window ?? { trades: 0, lamports: 0 };
        if (sql.includes("block_time <=")) return swaps.baseline ?? null;
        return swaps.latest ?? null;
      },
    };
    return statement;
  };
  return { DB: { prepare }, METEORA_DBC_CONFIG: CONFIG, ORACLE_SOL_USD_OVERRIDE: "200", DIGGO_RPC_URL: "" } as never;
}

const row = {
  pool: POOL, base_mint: MINT, config: CONFIG, creator: "GkCYyWzSjhSFEjKNx1ebWThtVLzQj7L84ktAHe31MBSx",
  name: "Diggo", symbol: "DIGGO", uri: "https://diggo.fun/media/official-diggo-logo-v1.png", decimals: 6,
  quote_reserve: "7940336", migration_quote_threshold: "85000000000", is_graduated: 0, created_at: 1790360000,
};

describe("Meteora token summary", () => {
  it("prices a buy and a sell as SOL per whole token", () => {
    expect(swapPriceSol({ side: "buy", amount_in: "1000000000", amount_out: "2000000" }, 6)).toBeCloseTo(0.5);
    expect(swapPriceSol({ side: "sell", amount_in: "4000000", amount_out: "1000000000" }, 6)).toBeCloseTo(0.25);
    expect(swapPriceSol({ side: "buy", amount_in: "0", amount_out: "1" }, 6)).toBe(0);
    expect(swapPriceSol(null, 6)).toBe(0);
  });

  it("serves an indexed pool as a complete TokenSummary", async () => {
    const response = await meteoraTokenBySlug(env({
      latest: { side: "buy", amount_in: "1000000", amount_out: "2000000000" },
      baseline: { side: "buy", amount_in: "1000000", amount_out: "4000000000" },
      window: { trades: 3, lamports: 500000000 },
    }, row), MINT);
    expect(response.status).toBe(200);
    const { token } = await response.json() as { token: Record<string, unknown> };
    expect(token).toMatchObject({
      mint: MINT, slug: MINT, name: "Diggo", symbol: "DIGGO", imageUrl: row.uri, status: "MINING_ACTIVE",
      trades24h: 3, volume24hUsd: 100, venue: "meteora", decimals: 6, quoteReserve: "7940336",
    });
    expect(token.priceSol).toBeCloseTo(0.0005);
    expect(token.change24h).toBeCloseTo(100);
    expect(token.curveMining).toMatchObject({ disabled: true, onCurve: true });
  });

  it("reports unknown change and zero price before any trade, and 404 for an unknown coin", async () => {
    const response = await meteoraTokenBySlug(env({}, row), MINT);
    const { token } = await response.json() as { token: Record<string, unknown> };
    expect([token.priceSol, token.change24h, token.trades24h]).toEqual([0, null, 0]);
    expect((await meteoraTokenBySlug(env({}, null), MINT)).status).toBe(404);
  });
});

