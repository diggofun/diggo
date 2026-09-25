import { describe, expect, it } from "vitest";
import {
  aggregateCandles,
  CANDLE_INTERVALS,
  chartMinMove,
  formatChartPrice,
  parseCandleInterval,
  pricedSwap,
  type PricedSwap,
} from "./candles";

const swap = (time: number, priceSol: number, volumeSol = 1): PricedSwap => ({ time, priceSol, volumeSol });

describe("pricedSwap", () => {
  it("prices a buy as lamports paid per whole token received", () => {
    const priced = pricedSwap({ side: "buy", amount_in: "1000000000", amount_out: "13715000000000000", sol_amount_lamports: "1000000000", block_time: 1_790_360_500 }, 9)!;
    expect(priced.priceSol).toBeCloseTo(7.2913e-8, 12);
    expect(priced.volumeSol).toBe(1);
    expect(priced.time).toBe(1_790_360_500);
  });

  it("prices a sell as lamports received per whole token paid", () => {
    const priced = pricedSwap({ side: "sell", amount_in: "2000000000000", amount_out: "150000", sol_amount_lamports: "150000", block_time: 10 }, 9)!;
    expect(priced.priceSol).toBeCloseTo(7.5e-8, 15);
    expect(priced.volumeSol).toBeCloseTo(0.00015, 12);
  });

  it("rejects rows that cannot be priced", () => {
    const base = { amount_in: "1", amount_out: "1", sol_amount_lamports: "1" };
    expect(pricedSwap({ ...base, side: "buy", block_time: null }, 9)).toBeNull();
    expect(pricedSwap({ ...base, side: "mint", block_time: 1 }, 9)).toBeNull();
    expect(pricedSwap({ ...base, side: "buy", amount_out: "0", block_time: 1 }, 9)).toBeNull();
    expect(pricedSwap({ ...base, side: "sell", amount_in: "abc", block_time: 1 }, 9)).toBeNull();
  });
});

describe("aggregateCandles", () => {
  it("returns no candles without trades", () => {
    expect(aggregateCandles([], 60)).toEqual([]);
  });

  it("builds OHLCV per bucket from trades in chain order", () => {
    const candles = aggregateCandles([
      swap(125, 3, 0.5),
      swap(60, 2, 1),
      swap(61, 5, 2),
      swap(61, 1, 0.25),
      swap(119, 4, 1),
    ], 60);
    expect(candles).toEqual([
      { time: 60, open: 2, high: 5, low: 1, close: 4, volumeSol: 4.25, trades: 4 },
      { time: 120, open: 3, high: 3, low: 3, close: 3, volumeSol: 0.5, trades: 1 },
    ]);
  });

  it("keeps input order for trades in the same second", () => {
    const [candle] = aggregateCandles([swap(0, 7), swap(0, 9), swap(0, 8)], 60);
    expect(candle).toMatchObject({ open: 7, close: 8, high: 9, low: 7 });
  });

  it("leaves gaps empty instead of inventing candles", () => {
    const candles = aggregateCandles([swap(0, 1), swap(3 * 3_600, 2)], CANDLE_INTERVALS["1h"]);
    expect(candles.map((candle) => candle.time)).toEqual([0, 10_800]);
  });

  it("puts bucket boundaries on UTC multiples of the interval", () => {
    const day = CANDLE_INTERVALS["1d"];
    const [candle] = aggregateCandles([swap(day * 5 + 3_700, 1)], day);
    expect(candle!.time).toBe(day * 5);
  });

  it("drops unpriced trades and counts zero volume as zero", () => {
    const candles = aggregateCandles([swap(0, 0), swap(1, Number.NaN), swap(2, 1e-8, Number.NaN)], 60);
    expect(candles).toEqual([{ time: 0, open: 1e-8, high: 1e-8, low: 1e-8, close: 1e-8, volumeSol: 0, trades: 1 }]);
  });

  it("conserves volume and trade count across intervals", () => {
    const swaps = Array.from({ length: 50 }, (_, index) => swap(index * 97, 1 + (index % 7), 0.1 * (index + 1)));
    for (const seconds of Object.values(CANDLE_INTERVALS)) {
      const candles = aggregateCandles(swaps, seconds);
      expect(candles.reduce((sum, candle) => sum + candle.trades, 0)).toBe(50);
      expect(candles.reduce((sum, candle) => sum + candle.volumeSol, 0)).toBeCloseTo(127.5, 9);
      for (const candle of candles) {
        expect(candle.low).toBeLessThanOrEqual(Math.min(candle.open, candle.close));
        expect(candle.high).toBeGreaterThanOrEqual(Math.max(candle.open, candle.close));
      }
    }
  });

  it("rejects a non-positive interval", () => {
    expect(() => aggregateCandles([swap(0, 1)], 0)).toThrow();
  });
});

describe("parseCandleInterval", () => {
  it("accepts only the supported intervals", () => {
    expect(parseCandleInterval("1m")).toBe("1m");
    expect(parseCandleInterval("4h")).toBe("4h");
    expect(parseCandleInterval("2h")).toBeNull();
    expect(parseCandleInterval("toString")).toBeNull();
    expect(parseCandleInterval(null)).toBeNull();
  });
});

describe("chart price formatting", () => {
  it("shows tiny prices with a zero count", () => {
    expect(formatChartPrice(7.291e-8)).toBe("0.0₇7291");
    expect(formatChartPrice(0.0000123)).toBe("0.0₄123");
    expect(formatChartPrice(0.00099996)).toBe("0.001");
  });

  it("shows ordinary prices plainly", () => {
    expect(formatChartPrice(0)).toBe("0");
    expect(formatChartPrice(0.01234)).toBe("0.01234");
    expect(formatChartPrice(142.5)).toBe("142.5");
    expect(formatChartPrice(Number.NaN)).toBe("—");
  });

  it("picks a minMove that resolves the smallest price", () => {
    expect(chartMinMove([7.29e-8, 9e-8])).toBe(1e-11);
    expect(chartMinMove([150])).toBe(0.01);
    expect(chartMinMove([])).toBe(0.01);
  });
});
