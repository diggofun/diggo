/**
 * Trade: a gmgn-style market screen. A coin list on the side (Diggo launches, mined coins, search
 * across Solana), the chosen coin's price, chart and stats in the middle, and a one-tap trade panel.
 *
 * Coins launched on Diggo trade on their own bonding curve or pool through SwapPanel, which also
 * records the trades the game and the charts use. Every other coin trades through Jupiter
 * (QuickTradePanel), with its market data and chart from Dexscreener.
 */
import { useEffect, useMemo, useState } from "react";
import { getMarketTokens, getSponsoredMines, searchMarket } from "../api";
import { compact, money } from "../format";
import type { TokenSummary } from "../../shared/types";
import type { MarketToken } from "../../shared/marketToken";
import { QuickTradePanel } from "./QuickTradePanel";
import { SwapPanel, type SwapPanelProps } from "./SwapPanel";
import { TokenOrb } from "./TokenOrb";

const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function change(value: number | null | undefined): { text: string; className: string } {
  if (value === null || value === undefined || !Number.isFinite(value)) return { text: "—", className: "" };
  return { text: (value > 0 ? "+" : "") + value.toFixed(1) + "%", className: value >= 0 ? "is-up" : "is-down" };
}

function usd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return "—";
  return value >= 1_000 ? "$" + compact(value) : money(value);
}

interface Row { mint: string; symbol: string; imageUrl: string | null; price: number | null; change: number | null; cap: number | null }

function CoinList({ title, rows, selected, onSelect }: { title: string; rows: Row[]; selected: string | null; onSelect(mint: string): void }) {
  if (rows.length === 0) return null;
  return (
    <div className="trade-list">
      <h3>{title}</h3>
      {rows.map((row) => {
        const delta = change(row.change);
        return (
          <button key={row.mint} type="button" className={"trade-list-row" + (row.mint === selected ? " active" : "")} onClick={() => onSelect(row.mint)}>
            <TokenOrb symbol={row.symbol} imageUrl={row.imageUrl} />
            <span className="trade-list-name"><strong>${row.symbol}</strong><small>MC {usd(row.cap)}</small></span>
            <span className="trade-list-price"><strong>{usd(row.price)}</strong><small className={delta.className}>{delta.text}</small></span>
          </button>
        );
      })}
    </div>
  );
}

export interface TradeScreenProps extends Omit<SwapPanelProps, "token"> {
  tokens: TokenSummary[];
}

export function TradeScreen({ tokens, ...swap }: TradeScreenProps) {
  const [selected, setSelected] = useState<string | null>(() => new URLSearchParams(window.location.search).get("mint"));
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MarketToken[]>([]);
  const [mined, setMined] = useState<MarketToken[]>([]);
  const [fetched, setFetched] = useState<MarketToken | null>(null);
  const [searching, setSearching] = useState(false);

  // Coins added as mines: their markets, so players can trade what their bots dig.
  useEffect(() => {
    let live = true;
    getSponsoredMines()
      .then((mines) => getMarketTokens(mines.filter((mine) => mine.status === "ACTIVE").map((mine) => mine.mint)))
      .then((list) => { if (live) setMined(list); })
      .catch(() => undefined);
    return () => { live = false; };
  }, []);

  // Search Solana by ticker, name or mint, a moment after typing stops.
  useEffect(() => {
    const q = query.trim();
    // Shorter queries show the lists instead, so stale results are simply not rendered.
    if (q.length < 2) return;
    let live = true;
    const timer = window.setTimeout(() => {
      setSearching(true);
      const lookup = MINT.test(q) ? getMarketTokens([q]) : searchMarket(q);
      lookup.then((list) => { if (live) setResults(list); }).catch(() => { if (live) setResults([]); }).finally(() => { if (live) setSearching(false); });
    }, 300);
    return () => { live = false; window.clearTimeout(timer); };
  }, [query]);

  const diggoToken = useMemo(() => tokens.find((token) => token.mint === selected) ?? null, [tokens, selected]);
  const fallback = selected ?? tokens[0]?.mint ?? mined[0]?.mint ?? null;

  // The chosen coin's market, unless it is a Diggo launch (SwapPanel reads its own): from the lists
  // already loaded, or fetched once for a coin opened by its mint.
  const isDiggo = Boolean(fallback && tokens.some((token) => token.mint === fallback));
  const known = useMemo(() => [...mined, ...results].find((token) => token.mint === fallback) ?? null, [mined, results, fallback]);
  useEffect(() => {
    if (!fallback || isDiggo || known) return;
    let live = true;
    getMarketTokens([fallback]).then((list) => { if (live) setFetched(list[0] ?? null); }).catch(() => undefined);
    return () => { live = false; };
  }, [fallback, isDiggo, known]);
  const external = isDiggo ? null : known ?? (fetched?.mint === fallback ? fetched : null);

  function select(mint: string): void {
    setSelected(mint);
    setQuery("");
    const url = new URL(window.location.href);
    url.searchParams.set("mint", mint);
    window.history.replaceState(null, "", url.pathname + url.search);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const current = diggoToken ?? tokens.find((token) => token.mint === fallback) ?? null;
  const diggoRows: Row[] = tokens.slice(0, 30).map((token) => ({ mint: token.mint, symbol: token.symbol, imageUrl: token.imageUrl, price: token.priceUsd, change: token.change24h, cap: token.marketCapUsd }));
  const toRows = (list: MarketToken[]): Row[] => list.map((token) => ({ mint: token.mint, symbol: token.symbol, imageUrl: token.imageUrl, price: token.priceUsd, change: token.change24h, cap: token.marketCap }));

  return (
    <section className="trade-screen page-shell" id="trade">
      <div className="trade-side">
        <label className="trade-search">
          <span className="sr-only">Search coins</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search a coin or paste a mint" autoComplete="off" />
        </label>
        {query.trim().length >= 2 ? (
          <>
            <CoinList title={searching ? "Searching…" : "Results"} rows={toRows(results)} selected={fallback} onSelect={select} />
            {!searching && results.length === 0 && <p className="trade-empty">No Solana coin found.</p>}
          </>
        ) : (
          <>
            <CoinList title="Mined on Diggo" rows={toRows(mined)} selected={fallback} onSelect={select} />
            <CoinList title="Launched on Diggo" rows={diggoRows} selected={fallback} onSelect={select} />
          </>
        )}
      </div>
      <div className="trade-main">
        {current ? (
          <SwapPanel token={current} {...swap} />
        ) : external ? (
          <ExternalMarket token={external} />
        ) : (
          <p className="trade-empty">{fallback ? "Loading the market…" : "Search for a coin to trade."}</p>
        )}
      </div>
    </section>
  );
}

function ExternalMarket({ token }: { token: MarketToken }) {
  const delta = change(token.change24h);
  const chart = token.pairAddress
    ? `https://dexscreener.com/solana/${encodeURIComponent(token.pairAddress)}?embed=1&loadChartSettings=0&trades=0&tabs=0&info=0&chartLeftToolbar=0&chartTheme=dark&theme=dark&chartStyle=1&chartType=usd&interval=15`
    : null;
  return (
    <div className="external-market">
      <header className="external-head">
        <TokenOrb symbol={token.symbol} imageUrl={token.imageUrl} large />
        <div>
          <h1>${token.symbol} <small>{token.name}</small></h1>
          <p><strong>{usd(token.priceUsd)}</strong> <span className={delta.className}>{delta.text}</span></p>
        </div>
      </header>
      <div className="external-stats">
        <div><span>Market cap</span><strong>{usd(token.marketCap)}</strong></div>
        <div><span>Liquidity</span><strong>{usd(token.liquidityUsd)}</strong></div>
        <div><span>Volume 24h</span><strong>{usd(token.volume24h)}</strong></div>
        <div><span>Mint</span><strong title={token.mint}>{token.mint.slice(0, 4)}…{token.mint.slice(-4)}</strong></div>
      </div>
      <div className="external-body">
        {chart ? <iframe className="external-chart" title={`$${token.symbol} chart`} src={chart} loading="lazy" referrerPolicy="no-referrer" /> : <p className="trade-empty">No chart for this coin yet.</p>}
        <QuickTradePanel mint={token.mint} symbol={token.symbol} />
      </div>
    </div>
  );
}
