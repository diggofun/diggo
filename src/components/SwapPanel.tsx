/**
 * DiggoSwap: real buys and sells against a mine's own trading venue, with a live price chart fed
 * by the Worker's WebSocket. Loaded lazily so lightweight-charts and the Solana program client
 * only ship on the pages that trade.
 *
 * The venue is read from the decoded Coin account on every load and after every trade: a coin
 * trades its bonding curve until `graduate_market` moves that liquidity into the program-owned
 * locked pool, and after that the program only accepts pool buys and sells. The quote and the
 * slippage floor shown here come from the shared mirror of the program's own math, so what the
 * form promises is what the program will enforce.
 *
 * The trade itself is one wallet-signed transaction, priced again from a fresh account read
 * immediately before signing. A form's quote can be seconds old, and a stale floor is the failure
 * this panel exists to avoid: every path through executeSwap either sends a floor derived from the
 * read it just made, or sends nothing.
 */
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import type { MarketTrade, TokenSummary } from "../../shared/types";
import { recordTrade } from "../api";
import { track } from "../analytics";
import { compact, solAmount } from "../format";
import { requestWalletMenu } from "../wallet";
import {
  address,
  DEFAULT_SLIPPAGE_BPS,
  executeSwap,
  fetchCoinVenue,
  fetchSolBalance,
  fetchTokenBalance,
  quoteSwap,
  swapAmountRaw,
  venueSpotPriceSol,
  type DiggoWallet,
  type CoinVenueState,
} from "../solanaProgram";
import { usePendingTransaction } from "../onchain";
import { IconSwap, IconWallet } from "../icons";

function formatTokenAmount(raw: bigint, decimals: number): string {
  const whole = Number(raw) / 10 ** decimals;
  return whole.toLocaleString(undefined, { maximumFractionDigits: whole < 1 ? 6 : 2 });
}

/** A fee in basis points as a percentage label: 100 -> "1", 250 -> "2.5". */
function formatFeeBps(bps: number): string {
  const percent = bps / 100;
  return Number.isInteger(percent) ? String(percent) : percent.toFixed(2).replace(/0+$/, "");
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
  const [venueState, setVenueState] = useState<CoinVenueState | null>(null);
  const pendingTransaction = usePendingTransaction();

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
    setVenueState(null);
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
      const result = await fetchCoinVenue(address(programAddress), address(token.mint));
      setVenueState(result);
    } catch {
      setVenueState(null);
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
  /** The form's slippage floor, the same number the quote and the on-chain min-out use. */
  const slippageBps = DEFAULT_SLIPPAGE_BPS;
  const parsedAmount = Number(amount);
  const venue = venueState?.venue ?? null;
  /**
   * Pre-graduation, from the venue the chain reports. Before that read lands there is no answer,
   * and the honest default is the curve: a coin starts on it, and the program rejects the wrong
   * route with MarketGraduated rather than filling it at a wrong price.
   */
  const onCurve = venue !== "pool";
  const poolUnreadable = venue === "pool" && !venueState?.pool;
  /**
   * The quote for the current input, on the venue the market is actually on: the curve's own
   * math before graduation, the locked pool's x*y=k after it. The fees the program takes off the
   * top are included, so `outRaw` is what the wallet really receives and `minOutRaw` is the
   * floor to send on-chain.
   */
  const quote = useMemo(() => {
    if (!venueState || !Number.isFinite(parsedAmount) || parsedAmount <= 0) return null;
    return quoteSwap(venueState, side, swapAmountRaw(parsedAmount, side, decimals), slippageBps);
  }, [venueState, parsedAmount, side, decimals, slippageBps]);
  const quoteOut = quote?.outRaw ?? null;

  /**
   * Trading is only possible against a quote that can produce a floor. Without one the trade is
   * priced again — and refused — in submitTrade; the button says so before it is clicked.
   */
  const quoteReady = quote !== null && quote.minOutRaw > 0n;

  const slippageLabel = `${(slippageBps / 100).toFixed(0)}%`;
  const feeSol = quote ? Number(quote.feeRaw) / 1_000_000_000 : 0;
  const creatorFeePercent = venueState ? formatFeeBps(venueState.coin.creatorFeeBps) : null;
  const platformFeePercent = venueState ? formatFeeBps(venueState.coin.platformFeeBps) : null;

  async function submitTrade(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (!pendingTransaction.canSubmit()) return;
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
      // The displayed quote may be stale and the venue read behind it may have failed outright, so
      // the trade is priced again from a fresh account read here, immediately before signing. A
      // trade with no live quote is refused rather than sent with a zero slippage floor.
      const execution = await executeSwap({
        programAddress: address(programAddress),
        wallet: signer,
        mint: address(token.mint),
        side,
        amount: parsedAmount,
        decimals,
        slippageBps,
      });
      setVenueState(execution.state);
      await recordTrade(token.mint, {
        signature: execution.signature,
        side,
        amount: execution.recordedAmount,
      });
      setLastSignature(execution.signature);
      track(side === "buy" ? "swap_buy" : "swap_sell", { network: "solana-devnet" });
      setAmount("");
      onTraded();
    } catch (tradeError) {
      if (!pendingTransaction.record(tradeError, "Trade")) {
        setError(tradeError instanceof Error ? tradeError.message : "Trade failed");
      } else setError("");
    } finally {
      setBusy(false);
    }
  }

  const spotPriceSol = (venueState && venueSpotPriceSol(venueState, decimals)) ?? token.priceSol;

  return (
    <section className="swap-terminal page-shell" id="swap">
      <div className="section-heading">
        <div><div className="eyebrow"><IconSwap size={14} /> DiggoSwap</div><h2>TRADE<br />${token.symbol}.</h2></div>
        <div className="swap-price-tag">
          <span>SPOT PRICE</span>
          <strong>{spotPriceSol < 0.000001 ? spotPriceSol.toExponential(3) : spotPriceSol.toFixed(9)} SOL</strong>
          <span>{onCurve ? "BONDING CURVE" : "LOCKED POOL · GRADUATED"}</span>
          <span className={"badge " + (onCurve ? "badge-curve" : "badge-reserve")}>
            <i aria-hidden="true" /> {onCurve ? "Curve emission" : "Reserve emission"}
          </span>
        </div>
      </div>
      <div className="swap-grid">
        <div className="swap-chart-panel">
          <div ref={chartContainerRef} className="swap-chart" />
          {tradeCount < 2 && (
            <div className="swap-chart-empty">
              Not enough trade history yet — every real buy/sell plots here live.
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
            <span>YOU RECEIVE (EST., {slippageLabel} SLIPPAGE FLOOR)</span>
            <strong>
              {quoteOut !== null
                ? side === "buy"
                  ? `${formatTokenAmount(quoteOut, decimals)} $${token.symbol}`
                  : `${(Number(quoteOut) / 1_000_000_000).toFixed(6)} SOL`
                : poolUnreadable
                  ? "POOL STATE UNAVAILABLE — RETRY"
                  : "—"}
            </strong>
          </div>
          {venueState && creatorFeePercent !== null && platformFeePercent !== null && (
            <div className="swap-quote">
              <span>TRADING FEE ({creatorFeePercent}% CREATOR + {platformFeePercent}% PLATFORM)</span>
              <strong>{feeSol > 0 ? `${feeSol.toFixed(6)} SOL` : "—"}</strong>
            </div>
          )}
          {walletAddress && (
            <div className="swap-balances">
              <span>{solBalance !== null ? (Number(solBalance) / 1_000_000_000).toFixed(4) : "…"} SOL</span>
              <span>{tokenBalance !== null ? formatTokenAmount(tokenBalance, decimals) : "…"} ${token.symbol}</span>
            </div>
          )}
          {error && <p className="form-message" role="alert">{error}</p>}
          {lastSignature && <a className="tx-success" href={`https://explorer.solana.com/tx/${lastSignature}?cluster=devnet`} target="_blank" rel="noreferrer">Confirmed on devnet · View transaction</a>}
          {signer ? (
            <button className="primary-button swap-submit" disabled={busy || !quoteReady || !pendingTransaction.canSubmit()}>
              {busy ? "Confirming…" : side === "buy" ? "Buy on-chain" : "Sell on-chain"}
            </button>
          ) : (
            <button type="button" className="primary-button swap-submit" onClick={requestWalletMenu}>
              Connect wallet <IconWallet size={16} />
            </button>
          )}
          {signer && !quoteReady && parsedAmount > 0 && !busy && (
            <p className="swap-note" role="status">
              No live quote for this order yet, and a trade is never sent without a slippage floor.
              {poolUnreadable
                ? " The market's locked pool could not be read — retry in a moment."
                : " Retry in a moment."}
            </p>
          )}
          {onCurve && (
            <div className="swap-capacity">
              <span>SOL AVAILABLE TO SELLERS ON THE CURVE</span>
              <strong>
                {solAmount(token.sellCapacity.sol)} <small>SOL</small>
              </strong>
              <p>Before graduation, sells are limited to the SOL buyers have put into the curve.</p>
              {token.sellCapacity.tokens !== null && (
                <small>
                  about {compact(token.sellCapacity.tokens)} ${token.symbol} would take all of it
                </small>
              )}
            </div>
          )}
          <p className="swap-note">
            {venue === "pool" ? (
              <>
                This market has graduated: its liquidity now sits in a program-owned constant-product
                pool that no key can withdraw from, and every trade is priced by x*y=k against those
                reserves. Nothing here is simulated.
              </>
            ) : (
              <>
                Real SOL moves through the mine's own bonding curve — this is the same liquidity a
                graduation threshold is measured against. Nothing here is simulated.
              </>
            )}
          </p>
        </form>
      </div>
    </section>
  );
}
