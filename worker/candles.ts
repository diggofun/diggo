/**
 * GET /api/tokens/:mint/candles?interval=1m|5m|15m|1h|4h|1d
 *
 * OHLCV candles for one Meteora coin, aggregated from its indexed swaps (meteora_swaps) with
 * shared/candles.ts. Prices are SOL per whole token; solUsd is the live oracle quote, or null when
 * the oracle is unavailable, so a client can offer USD without inventing a rate.
 */
import { aggregateCandles, CANDLE_HISTORY_BUCKETS, CANDLE_INTERVALS, DEFAULT_CANDLE_INTERVAL, parseCandleInterval, pricedSwap, type MeteoraSwapRow, type PricedSwap } from "../shared/candles";
import type { RuntimeEnv } from "./env";
import { apiError, isBase58Address, json } from "./http";
import { getSolUsd } from "./oracle";

/** Upper bound on swaps read per request; the window is capped anyway, this bounds a hot pool. */
const MAX_SWAPS = 20_000;

export async function meteoraCandles(env: RuntimeEnv, mint: string, intervalParam: string | null): Promise<Response> {
  if (!isBase58Address(mint)) return apiError("Invalid mint");
  const interval = intervalParam === null || intervalParam === "" ? DEFAULT_CANDLE_INTERVAL : parseCandleInterval(intervalParam);
  if (!interval) return apiError("interval must be one of " + Object.keys(CANDLE_INTERVALS).join(", "));
  const seconds = CANDLE_INTERVALS[interval];
  const pool = await env.DB.prepare("SELECT pool, decimals FROM meteora_pools WHERE base_mint=?1 AND config=?2")
    .bind(mint, String(env.METEORA_DBC_CONFIG || ""))
    .first<{ pool: string; decimals: number | null }>();
  if (!pool) return apiError("Token not found", 404);
  const decimals = Number.isInteger(pool.decimals) && pool.decimals !== null && pool.decimals >= 0 && pool.decimals <= 18 ? pool.decimals : 9;
  const now = Math.floor(Date.now() / 1000);
  const since = (Math.floor(now / seconds) - CANDLE_HISTORY_BUCKETS + 1) * seconds;
  const [rows, solUsd] = await Promise.all([
    env.DB.prepare(
      "SELECT side, amount_in, amount_out, sol_amount_lamports, block_time FROM meteora_swaps" +
        " WHERE pool=?1 AND block_time IS NOT NULL AND block_time >= ?2" +
        " ORDER BY block_time DESC, CAST(slot AS INTEGER) DESC, event_index DESC LIMIT ?3",
    )
      .bind(pool.pool, since, MAX_SWAPS)
      .all<MeteoraSwapRow>(),
    getSolUsd(env as never).catch(() => null),
  ]);
  // Limit the latest indexed swaps, then restore chain order for open and close.
  const swaps = (rows.results ?? []).reverse().map((row) => pricedSwap(row, decimals)).filter((swap): swap is PricedSwap => swap !== null);
  return json(
    {
      mint,
      pool: pool.pool,
      interval,
      intervalSeconds: seconds,
      candles: aggregateCandles(swaps, seconds),
      trades: swaps.length,
      truncated: (rows.results?.length ?? 0) === MAX_SWAPS,
      solUsd: solUsd?.available && solUsd.priceUsd > 0 ? solUsd.priceUsd : null,
      note: "Built only from indexed on-chain swaps; intervals without a swap have no candle.",
    },
    { headers: { "cache-control": "public, max-age=10" } },
  );
}
