/**
 * OHLCV candles from real indexed swaps.
 *
 * Every candle here is built only from swaps the indexer read off the chain: each swap's own
 * execution price (SOL paid per whole token) and its SOL volume. Intervals with no swap have no
 * candle - nothing is interpolated or carried forward - so an empty market draws an empty chart.
 */

export const CANDLE_INTERVALS = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3_600,
  "4h": 14_400,
  "1d": 86_400,
} as const;

export type CandleInterval = keyof typeof CANDLE_INTERVALS;

export const DEFAULT_CANDLE_INTERVAL: CandleInterval = "15m";

/** How many buckets of history one request covers, per interval. */
export const CANDLE_HISTORY_BUCKETS = 500;

export interface Candle {
  /** Bucket start, unix seconds (UTC). */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** SOL traded in the bucket. */
  volumeSol: number;
  /** Swaps in the bucket. */
  trades: number;
}

export interface PricedSwap {
  /** Unix seconds. */
  time: number;
  priceSol: number;
  volumeSol: number;
}

/** One indexed Meteora swap row, as meteora_swaps stores it. */
export interface MeteoraSwapRow {
  side: string;
  amount_in: string;
  amount_out: string;
  sol_amount_lamports: string;
  block_time: number | null;
}

const LAMPORTS_PER_SOL = 1_000_000_000;

export function parseCandleInterval(value: string | null | undefined): CandleInterval | null {
  return value !== null && value !== undefined && Object.prototype.hasOwnProperty.call(CANDLE_INTERVALS, value)
    ? (value as CandleInterval)
    : null;
}

/**
 * The execution price and SOL volume of one swap, or null when the row cannot be priced: a buy
 * pays lamports in and receives tokens, a sell pays tokens in and receives lamports.
 */
export function pricedSwap(row: MeteoraSwapRow, decimals: number): PricedSwap | null {
  const time = Number(row.block_time);
  if (!Number.isFinite(time) || time <= 0) return null;
  const buy = row.side === "buy";
  if (!buy && row.side !== "sell") return null;
  const lamports = Number(buy ? row.amount_in : row.amount_out);
  const tokens = Number(buy ? row.amount_out : row.amount_in) / 10 ** decimals;
  if (!(lamports > 0) || !(tokens > 0) || !Number.isFinite(lamports) || !Number.isFinite(tokens)) return null;
  const volumeLamports = Number(row.sol_amount_lamports);
  return {
    time: Math.floor(time),
    priceSol: lamports / LAMPORTS_PER_SOL / tokens,
    volumeSol: (Number.isFinite(volumeLamports) && volumeLamports > 0 ? volumeLamports : lamports) / LAMPORTS_PER_SOL,
  };
}

/**
 * Buckets priced swaps into OHLCV candles of intervalSeconds, oldest first.
 *
 * Swaps are ordered by time; swaps sharing a second keep their input order (the caller orders by
 * slot and event index), so open and close are the first and last trade the chain recorded.
 */
export function aggregateCandles(swaps: readonly PricedSwap[], intervalSeconds: number): Candle[] {
  if (!(intervalSeconds > 0)) throw new Error("interval must be positive");
  const ordered = swaps
    .map((swap, index) => ({ swap, index }))
    .filter(({ swap }) => Number.isFinite(swap.time) && Number.isFinite(swap.priceSol) && swap.priceSol > 0)
    .sort((a, b) => a.swap.time - b.swap.time || a.index - b.index);
  const candles: Candle[] = [];
  for (const { swap } of ordered) {
    const time = Math.floor(swap.time / intervalSeconds) * intervalSeconds;
    const volume = Number.isFinite(swap.volumeSol) && swap.volumeSol > 0 ? swap.volumeSol : 0;
    const last = candles[candles.length - 1];
    if (last && last.time === time) {
      last.high = Math.max(last.high, swap.priceSol);
      last.low = Math.min(last.low, swap.priceSol);
      last.close = swap.priceSol;
      last.volumeSol += volume;
      last.trades += 1;
    } else {
      candles.push({ time, open: swap.priceSol, high: swap.priceSol, low: swap.priceSol, close: swap.priceSol, volumeSol: volume, trades: 1 });
    }
  }
  return candles;
}

const SUBSCRIPT_DIGITS = ["₀", "₁", "₂", "₃", "₄", "₅", "₆", "₇", "₈", "₉"];

/**
 * A price readable at any size. Prices under 0.001 use the zero-count notation memecoin charts
 * use, so 0.0000000729 reads "0.0₇729" instead of a wall of zeros or an exponent.
 */
export function formatChartPrice(price: number, significant = 4): string {
  if (!Number.isFinite(price)) return "—";
  if (price === 0) return "0";
  const sign = price < 0 ? "-" : "";
  const value = Math.abs(price);
  if (value >= 1_000) return sign + value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (value >= 0.001) return sign + Number(value.toPrecision(significant)).toString();
  const zeros = Math.floor(-Math.log10(value));
  const rounded = Math.round(value * 10 ** (zeros + significant)).toString();
  if (rounded.length > significant) {
    // Rounding carried into a new leading digit (e.g. 0.00009999 -> 0.0001): one fewer zero.
    return sign + formatChartPrice(Number(value.toPrecision(significant)), significant);
  }
  const digits = rounded.replace(/0+$/, "") || "0";
  const subscript = String(zeros).split("").map((digit) => SUBSCRIPT_DIGITS[Number(digit)]).join("");
  return sign + "0.0" + subscript + digits;
}

/** A chart minMove fine enough to resolve the smallest price shown, to four significant digits. */
export function chartMinMove(prices: readonly number[]): number {
  const positive = prices.filter((price) => Number.isFinite(price) && price > 0);
  if (positive.length === 0) return 0.01;
  const smallest = Math.min(...positive);
  const exponent = Math.floor(Math.log10(smallest)) - 3;
  return Math.min(0.01, Number((10 ** exponent).toPrecision(1)));
}
