/**
 * Candlestick price chart for one coin, drawn with TradingView Lightweight Charts.
 *
 * Every candle comes from GET /api/tokens/:mint/candles, which aggregates the coin's indexed
 * on-chain swaps. An interval with no swaps shows an empty state. USD values use the current
 * SOL/USD oracle quote the endpoint returns and are unavailable when it has none.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ColorType,
  CrosshairMode,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type UTCTimestamp,
} from "lightweight-charts";
import { CANDLE_INTERVALS, DEFAULT_CANDLE_INTERVAL, chartMinMove, formatChartPrice, type Candle, type CandleInterval } from "../../shared/candles";
import { getCandles, type CandlesResponse } from "../api";
import { solAmount } from "../format";

const POLL_MS = 15_000;
const INTERVALS = Object.keys(CANDLE_INTERVALS) as CandleInterval[];
const UP = "#10b981";
const DOWN = "#f43f5e";

type Currency = "SOL" | "USD";

function scaled(candle: Candle, rate: number): Candle {
  return rate === 1
    ? candle
    : { ...candle, open: candle.open * rate, high: candle.high * rate, low: candle.low * rate, close: candle.close * rate, volumeSol: candle.volumeSol * rate };
}

export function CandleChart({ mint, symbol }: { mint: string; symbol: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const fittedRef = useRef("");
  const [interval, setInterval_] = useState<CandleInterval>(DEFAULT_CANDLE_INTERVAL);
  const [currency, setCurrency] = useState<Currency>("SOL");
  const [data, setData] = useState<CandlesResponse | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [hoveredTime, setHoveredTime] = useState<number | null>(null);

  const requestKey = mint + ":" + interval;
  const activeData = data?.mint === mint && data.interval === interval ? data : null;
  const failed = failedKey === requestKey;
  const rate = currency === "USD" && activeData?.solUsd ? activeData.solUsd : 1;
  const unit = currency === "USD" && activeData?.solUsd ? "USD" : "SOL";
  const candles = useMemo(() => (activeData?.candles ?? []).map((candle) => scaled(candle, rate)), [activeData, rate]);
  const hasCandles = candles.length > 0;

  const load = useCallback(async (signal: { cancelled: boolean }) => {
    try {
      const next = await getCandles(mint, interval);
      if (signal.cancelled) return;
      setData(next);
      setFailedKey(null);
    } catch {
      if (!signal.cancelled) setFailedKey(mint + ":" + interval);
    }
  }, [interval, mint]);

  // Fetch on mount and on every interval change, then poll while the tab is visible.
  useEffect(() => {
    const signal = { cancelled: false };
    queueMicrotask(() => { if (!signal.cancelled) void load(signal); });
    const timer = window.setInterval(() => {
      if (typeof document === "undefined" || !document.hidden) void load(signal);
    }, POLL_MS);
    const onVisible = () => { if (!document.hidden) void load(signal); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      signal.cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  // The chart itself: created once per mount, sized by its container.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const chart = createChart(container, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#a1a1aa", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: 10 },
      grid: { vertLines: { color: "rgba(255,255,255,.04)" }, horzLines: { color: "rgba(255,255,255,.06)" } },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "rgba(255,255,255,.35)", labelBackgroundColor: "#2a2a2a" },
        horzLine: { color: "rgba(255,255,255,.35)", labelBackgroundColor: "#2a2a2a" },
      },
      rightPriceScale: { borderColor: "rgba(255,255,255,.08)", scaleMargins: { top: 0.08, bottom: 0.26 } },
      timeScale: { borderColor: "rgba(255,255,255,.08)", timeVisible: true, secondsVisible: false, rightOffset: 4 },
      localization: { priceFormatter: (price: number) => formatChartPrice(price) },
      handleScale: { axisPressedMouseMove: { time: true, price: false } },
    });
    const candleSeries = chart.addCandlestickSeries({
      upColor: UP,
      downColor: DOWN,
      borderUpColor: UP,
      borderDownColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
      priceLineColor: "#a855f7",
    });
    const volumeSeries = chart.addHistogramSeries({
      priceScaleId: "volume",
      priceFormat: { type: "volume" },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 }, visible: false });
    const onMove = (param: MouseEventParams) => {
      setHoveredTime(typeof param.time === "number" && param.seriesData.has(candleSeries) ? param.time : null);
    };
    chart.subscribeCrosshairMove(onMove);
    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;
    return () => {
      chart.unsubscribeCrosshairMove(onMove);
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      fittedRef.current = "";
    };
  }, []);

  // Feed data; refit only when the interval or currency changes, so polling keeps the user's zoom.
  useEffect(() => {
    const chart = chartRef.current;
    const candleSeries = candleSeriesRef.current;
    const volumeSeries = volumeSeriesRef.current;
    if (!chart || !candleSeries || !volumeSeries) return;
    const shown = hasCandles ? candles : [];
    const minMove = chartMinMove(shown.flatMap((candle) => [candle.low, candle.high]));
    candleSeries.applyOptions({
      priceFormat: { type: "custom", minMove, formatter: (price: number) => formatChartPrice(price) },
    });
    candleSeries.setData(shown.map((candle) => ({
      time: candle.time as UTCTimestamp,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
    })));
    volumeSeries.setData(shown.map((candle) => ({
      time: candle.time as UTCTimestamp,
      value: candle.volumeSol,
      color: candle.close >= candle.open ? "rgba(16,185,129,.35)" : "rgba(244,63,94,.35)",
    })));
    chart.timeScale().applyOptions({ secondsVisible: false, timeVisible: CANDLE_INTERVALS[interval] < 86_400 });
    const key = interval + ":" + unit + ":" + (shown.length > 0);
    if (fittedRef.current !== key && shown.length > 0) {
      chart.timeScale().fitContent();
      fittedRef.current = key;
    }
  }, [candles, hasCandles, interval, unit]);

  const last = candles[candles.length - 1];
  const shownLegend = hasCandles ? (candles.find((candle) => candle.time === hoveredTime) ?? last) : undefined;
  const prefix = unit === "USD" ? "$" : "";
  const suffix = unit === "SOL" ? " SOL" : "";

  return (
    <div className="candle-chart" aria-label={"$" + symbol + " price chart"}>
      <div className="candle-toolbar">
        <div className="candle-intervals" role="group" aria-label="Chart interval">
          {INTERVALS.map((value) => (
            <button key={value} type="button" className={value === interval ? "active" : ""} aria-pressed={value === interval} onClick={() => setInterval_(value)}>
              {value}
            </button>
          ))}
        </div>
        <div className="candle-currency" role="group" aria-label="Price currency">
          {(["SOL", "USD"] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={value === currency ? "active" : ""}
              aria-pressed={value === currency}
              disabled={value === "USD" && !activeData?.solUsd}
              title={value === "USD" && !activeData?.solUsd ? "SOL/USD price unavailable" : undefined}
              onClick={() => setCurrency(value)}
            >
              {value}
            </button>
          ))}
        </div>
      </div>
      <div className="candle-legend" aria-live="off">
        {shownLegend ? (
          <>
            <span>O <b>{prefix}{formatChartPrice(shownLegend.open)}</b></span>
            <span>H <b>{prefix}{formatChartPrice(shownLegend.high)}</b></span>
            <span>L <b>{prefix}{formatChartPrice(shownLegend.low)}</b></span>
            <span>C <b className={shownLegend.close >= shownLegend.open ? "up" : "down"}>{prefix}{formatChartPrice(shownLegend.close)}{suffix}</b></span>
            <span>VOL <b>{prefix}{solAmount(shownLegend.volumeSol)}{suffix}</b></span>
          </>
        ) : (
          <span>{"$" + symbol + " / " + unit}</span>
        )}
      </div>
      <div className="candle-stage">
        <div ref={containerRef} className="candle-canvas" />
        {!hasCandles && (
          <div className="candle-empty" role="status">
            {failed ? "Chart data is unavailable right now." : !activeData ? "Loading trades…" : "No indexed swaps in this timeframe yet."}
          </div>
        )}
      </div>
      {failed && hasCandles && <small className="candle-update-error" role="status">Latest chart update unavailable; showing previously indexed trades.</small>}
      {activeData?.truncated && <small className="candle-update-error">Chart shows the latest {activeData.trades.toLocaleString("en-US")} indexed swaps in this timeframe.</small>}
      <a className="candle-attribution" href="https://www.tradingview.com/" target="_blank" rel="noreferrer">
        Charts by TradingView
      </a>
    </div>
  );
}
