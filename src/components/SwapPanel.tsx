/**
 * DiggoSwap: real buys and sells against a mine's own bonding curve, with a live price chart fed
 * by the Worker's WebSocket. Loaded lazily so lightweight-charts and the Solana program client
 * only ship on the pages that trade.
 */
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { Check, Radio, TrendingUp, Wallet, Zap } from "lucide-react";
import type { MarketTrade, TokenSummary } from "../../shared/types";
import type { DecodedLaunchMarket, DecodedMine } from "../../shared/program";
import { recordTrade } from "../api";
import { track } from "../analytics";
import { compact } from "../format";
import { requestWalletMenu } from "../wallet";
import {
  address,
  bondingCurveSpotPriceLamports,
  buyOnChain,
  fetchMineAndMarket,
  fetchSolBalance,
  fetchTokenBalance,
  quoteBuy,
  quoteSell,
  sellOnChain,
  type DiggoWallet,
} from "../solanaProgram";

function formatTokenAmount(raw: bigint, decimals: number): string {
  const whole = Number(raw) / 10 ** decimals;
  return whole.toLocaleString(undefined, { maximumFractionDigits: whole < 1 ? 6 : 2 });
}

export function SwapPanel({
  token,
  programAddress,
  signer,
  onTraded,
}: {
  token: TokenSummary;
  programAddress: string;
  signer: DiggoWallet | null;
  onTraded(): void;
}) {
  const walletAddress = signer?.address ?? null;
  const chartContainerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Area"> | null>(null);
  const [tradeCount, setTradeCount] = useState(0);
  const [recentTrades, setRecentTrades] = useState<MarketTrade[]>([]);
  const [lastSignature, setLastSignature] = useState("");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [solBalance, setSolBalance] = useState<bigint | null>(null);
  const [tokenBalance, setTokenBalance] = useState<bigint | null>(null);
  const [chainState, setChainState] = useState<{ mine: DecodedMine; market: DecodedLaunchMarket } | null>(null);

  // chart setup — created once per mount, data re-seeded whenever the mint changes
  useEffect(() => {
    if (!chartContainerRef.current) return;
    const chart = createChart(chartContainerRef.current, {
      height: 260,
      layout: { background: { color: "transparent" }, textColor: "#79796e", fontFamily: "monospace", fontSize: 10 },
      grid: { vertLines: { visible: false }, horzLines: { color: "rgba(23,24,19,.08)" } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: true },
      crosshair: { horzLine: { visible: false }, vertLine: { visible: false } },
    });
    const series = chart.addAreaSeries({
      lineColor: "#7657ff",
      topColor: "rgba(118,87,255,.28)",
      bottomColor: "rgba(118,87,255,.02)",
      lineWidth: 2,
      priceFormat: { type: "price", precision: 9, minMove: 0.000000001 },
    });
    chartRef.current = chart;
    seriesRef.current = series;
    const resize = () => chart.applyOptions({ width: chartContainerRef.current?.clientWidth ?? 0 });
    resize();
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // live trades over WebSocket, seeded from the snapshot the Worker/Durable Object already has
  useEffect(() => {
    setTradeCount(0);
    setRecentTrades([]);
    setChainState(null);
    const protocol = "wss:";
    const host = window.location.host;
    const proto = window.location.protocol === "https:" ? protocol : "ws:";
    const ws = new WebSocket(`${proto}//${host}/api/tokens/${token.mint}/live`);
    ws.onmessage = (event) => {
      const payload = JSON.parse(event.data) as
        | { type: "snapshot"; snapshot: { recentTrades: MarketTrade[] } }
        | { type: "trade"; trade: MarketTrade };
      const series = seriesRef.current;
      if (!series) return;
      if (payload.type === "snapshot") {
        const points = payload.snapshot.recentTrades
          .filter((t) => t.priceSol > 0)
          .slice()
          .reverse()
          .map((t) => ({ time: t.timestamp as UTCTimestamp, value: t.priceSol }));
        if (points.length > 0) {
          series.setData(points);
          chartRef.current?.timeScale().fitContent();
        }
        setTradeCount(points.length);
        setRecentTrades(payload.snapshot.recentTrades.slice(0, 12));
      } else if (payload.type === "trade" && payload.trade.priceSol > 0) {
        series.update({ time: payload.trade.timestamp as UTCTimestamp, value: payload.trade.priceSol });
        setTradeCount((count) => count + 1);
        setRecentTrades((current) => [payload.trade, ...current.filter((trade) => trade.signature !== payload.trade.signature)].slice(0, 12));
      }
    };
    return () => ws.close();
  }, [token.mint]);

  const refreshChainState = useCallback(async () => {
    try {
      const result = await fetchMineAndMarket(address(programAddress), address(token.mint));
      setChainState(result);
    } catch {
      setChainState(null);
    }
  }, [programAddress, token.mint]);

  useEffect(() => {
    void refreshChainState();
  }, [refreshChainState]);

  useEffect(() => {
    if (!walletAddress) {
      setSolBalance(null);
      setTokenBalance(null);
      return;
    }
    const owner = address(walletAddress);
    fetchSolBalance(owner).then(setSolBalance).catch(() => setSolBalance(null));
    fetchTokenBalance(owner, address(token.mint)).then(setTokenBalance).catch(() => setTokenBalance(null));
  }, [walletAddress, token.mint, tradeCount]);

  const decimals = token.decimals;
  const parsedAmount = Number(amount);
  const quoteOut = useMemo(() => {
    if (!chainState || !Number.isFinite(parsedAmount) || parsedAmount <= 0) return null;
    if (side === "buy") {
      const lamportsIn = BigInt(Math.round(parsedAmount * 1_000_000_000));
      return quoteBuy(chainState.market, lamportsIn);
    }
    const rawIn = BigInt(Math.round(parsedAmount * 10 ** decimals));
    return quoteSell(chainState.market, rawIn);
  }, [chainState, parsedAmount, side, decimals]);

  async function submitTrade(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (!signer) {
      setError("Connect a wallet that can sign transactions first.");
      return;
    }
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      setError("Enter an amount.");
      return;
    }
    setBusy(true);
    try {
      const programAddr = address(programAddress);
      const mint = address(token.mint);
      let result: { signature: string };
      let recordedAmount: number;
      if (side === "buy") {
        const minOut = quoteOut !== null ? (quoteOut * 98n) / 100n : 0n;
        result = await buyOnChain(programAddr, signer, mint, parsedAmount, minOut);
        recordedAmount = quoteOut !== null ? Number(quoteOut) / 10 ** decimals : 0;
      } else {
        const rawIn = BigInt(Math.round(parsedAmount * 10 ** decimals));
        const minOutLamports = quoteOut !== null ? (quoteOut * 98n) / 100n : 0n;
        result = await sellOnChain(programAddr, signer, mint, rawIn, minOutLamports);
        recordedAmount = parsedAmount;
      }
      await recordTrade(token.mint, { signature: result.signature, side, amount: recordedAmount });
      setLastSignature(result.signature);
      track(side === "buy" ? "swap_buy" : "swap_sell", { network: "solana-devnet" });
      setAmount("");
      await refreshChainState();
      onTraded();
    } catch (tradeError) {
      setError(tradeError instanceof Error ? tradeError.message : "Trade failed");
    } finally {
      setBusy(false);
    }
  }

  const spotPriceSol = chainState ? bondingCurveSpotPriceLamports(chainState.market, decimals) / 1_000_000_000 : token.priceSol;

  return (
    <section className="swap-terminal page-shell" id="swap">
      <div className="section-heading">
        <div><div className="eyebrow"><TrendingUp size={14} /> DiggoSwap</div><h2>TRADE<br />${token.symbol}.</h2></div>
        <div className="swap-price-tag">
          <span>SPOT PRICE</span>
          <strong>{spotPriceSol < 0.000001 ? spotPriceSol.toExponential(3) : spotPriceSol.toFixed(9)} SOL</strong>
        </div>
      </div>
      <div className="swap-grid">
        <div className="swap-chart-panel">
          <div ref={chartContainerRef} className="swap-chart" />
          {tradeCount < 2 && (
            <div className="swap-chart-empty">
              <Radio size={16} /> Not enough trade history yet — every real buy/sell plots here live.
            </div>
          )}
          <div className="trade-tape">
            <div className="trade-tape-head"><span>Side</span><span>Price (SOL)</span><span>Amount</span><span>Txn</span></div>
            {recentTrades.map((trade) => (
              <div className="trade-tape-row" key={trade.signature}>
                <b className={trade.side}>{trade.side}</b>
                <span>{trade.priceSol.toExponential(4)}</span>
                <span>{compact(trade.amount)}</span>
                <a href={`https://explorer.solana.com/tx/${trade.signature}?cluster=devnet`} target="_blank" rel="noreferrer">{trade.signature.slice(0, 5)}…</a>
              </div>
            ))}
          </div>
        </div>
        <form className="swap-form" onSubmit={submitTrade}>
          <div className="swap-tabs">
            <button type="button" className={side === "buy" ? "active" : ""} onClick={() => setSide("buy")}>Buy</button>
            <button type="button" className={side === "sell" ? "active" : ""} onClick={() => setSide("sell")}>Sell</button>
          </div>
          <label>
            {side === "buy" ? "Pay (SOL)" : `Sell ($${token.symbol})`}
            <input
              type="number"
              min="0"
              step="any"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          </label>
          <div className="swap-quote">
            <span>YOU RECEIVE (EST., 2% SLIPPAGE FLOOR)</span>
            <strong>
              {quoteOut !== null
                ? side === "buy"
                  ? `${formatTokenAmount(quoteOut, decimals)} $${token.symbol}`
                  : `${(Number(quoteOut) / 1_000_000_000).toFixed(6)} SOL`
                : "—"}
            </strong>
          </div>
          {walletAddress && (
            <div className="swap-balances">
              <span>{solBalance !== null ? (Number(solBalance) / 1_000_000_000).toFixed(4) : "…"} SOL</span>
              <span>{tokenBalance !== null ? formatTokenAmount(tokenBalance, decimals) : "…"} ${token.symbol}</span>
            </div>
          )}
          {error && <p className="form-message" role="alert">{error}</p>}
          {lastSignature && <a className="tx-success" href={`https://explorer.solana.com/tx/${lastSignature}?cluster=devnet`} target="_blank" rel="noreferrer"><Check size={13} /> Confirmed on devnet · View transaction</a>}
          {signer ? (
            <button className="primary-button swap-submit" disabled={busy}>
              {busy ? "Confirming…" : side === "buy" ? "Buy on-chain" : "Sell on-chain"} <Zap size={16} />
            </button>
          ) : (
            <button type="button" className="primary-button swap-submit" onClick={requestWalletMenu}>
              Connect wallet <Wallet size={16} />
            </button>
          )}
          <p className="swap-note">
            Real SOL moves through the mine's own bonding curve — this is the same liquidity a
            graduation threshold is measured against. Nothing here is simulated.
          </p>
        </form>
      </div>
    </section>
  );
}
