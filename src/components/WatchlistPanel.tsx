/**
 * The watchlist panel and the star that feeds it.
 *
 * The star is the only control on the coin list that writes anything, and it writes to the
 * watchlist and nowhere else: no transaction, no session requirement. It reads and writes through
 * the one shared store in src/watchlist.ts, so every star on the page and the panel below agree
 * about what is watched without each of them fetching the list.
 *
 * The panel renders the same numbers the coin list does - price, 24h change, market cap and mining
 * status - and it renders a change of null as an em dash rather than as a flat zero, because a coin
 * nobody has traded has no 24h change at all (see worker/watchlist.ts).
 *
 * The class names below are the design system hooks this panel will be styled through: the panel is
 * `watchlist-panel`, a row is `watchlist-row`, and a watched star is `is-watched`. They reuse the
 * repo own row and card primitives so the panel already reads as part of the page.
 */
import type { TokenSummary } from "../../shared/types";
import { compact, solAmount } from "../format";
import { IconWatchlist } from "../icons";
import { describeMineStatus } from "../mineView";
import { useWatchlist, watchlistRows } from "../watchlist";
import { TokenOrb } from "./TokenOrb";

export interface WatchStarProps {
  mint: string;
  /** Adds a text label next to the star, for a detail page rather than a list row. */
  label?: boolean;
  className?: string;
}

/**
 * The star toggle. It stops the click from reaching a row that would otherwise open the coin, so a
 * tap on the star never navigates.
 */
export function WatchStar({ mint, label = false, className = "" }: WatchStarProps) {
  const watchlist = useWatchlist();
  const watched = watchlist.has(mint);
  return (
    <button
      type="button"
      className={
        "watch-star btn btn-ghost btn-sm" + (watched ? " is-watched" : "") + (className ? " " + className : "")
      }
      aria-pressed={watched}
      aria-label={watched ? "Remove from watchlist" : "Add to watchlist"}
      title={watched ? "Watching this coin" : "Watch this coin"}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        watchlist.toggle(mint);
      }}
    >
      <IconWatchlist size={14} />
      {label && <span>{watched ? "Watching" : "Watch"}</span>}
    </button>
  );
}

export interface WatchlistPanelProps {
  /**
   * The coins the page bootstrapped with. Without a wallet session the Worker list is not
   * available, and this is what still gives every watched row a price and a status.
   */
  tokens?: TokenSummary[];
  onSelectCoin?(mint: string): void;
  /** Opens the wallet menu, for the empty state a signed-out visitor sees. */
  onConnect?(): void;
}

export function WatchlistPanel({ tokens = [], onSelectCoin, onConnect }: WatchlistPanelProps) {
  const watchlist = useWatchlist();
  const rows = watchlistRows(watchlist.mints, watchlist.coins, tokens);
  const full = watchlist.mints.length >= watchlist.limit;

  return (
    <section className="watchlist-panel page-shell" id="watchlist" aria-labelledby="watchlist-title">
      <div className="section-heading">
        <div>
          <div className="eyebrow">
            <IconWatchlist size={14} /> Watchlist
          </div>
          <h2 id="watchlist-title">
            Coins you
            <br />
            are watching.
          </h2>
        </div>
        <p className="mono-label">
          {watchlist.mints.length}/{watchlist.limit} watched
          {watchlist.signedIn ? " · saved to your wallet" : " · saved in this browser"}
        </p>
      </div>

      {watchlist.error && <p className="form-message">{watchlist.error}</p>}
      {full && <p className="form-message">Your watchlist is full. Remove a coin to add another.</p>}

      {rows.length === 0 ? (
        <div className="empty-state">
          <p>
            Nothing watched yet. Tap the star on any coin to keep it here.
          </p>
          {!watchlist.signedIn && onConnect && (
            <button type="button" className="btn btn-primary btn-sm" onClick={onConnect}>
              Connect a wallet
            </button>
          )}
        </div>
      ) : (
        <div className="leaderboard-table watchlist-table">
          <div className="leaderboard-row leaderboard-head">
            <span>Star</span>
            <span>Coin</span>
            <span>Price</span>
            <span>24h</span>
          </div>
          {rows.map((row) => {
            const coin = row.coin;
            const status = coin ? describeMineStatus(coin.status).badge : "Not indexed";
            const change = coin?.change24h ?? null;
            return (
              <div className="leaderboard-row watchlist-row" key={row.mint}>
                <b>
                  <WatchStar mint={row.mint} />
                </b>
                <button
                  type="button"
                  className="leaderboard-name watchlist-coin"
                  onClick={() => onSelectCoin?.(row.mint)}
                  disabled={!onSelectCoin}
                >
                  <TokenOrb symbol={coin?.symbol ?? "?"} imageUrl={coin?.imageUrl ?? null} />
                  <span>
                    ${coin ? coin.symbol : row.mint.slice(0, 4) + "…"}
                    <em className="badge badge-idle">{status}</em>
                  </span>
                </button>
                <strong>
                  {coin ? solAmount(coin.priceSol) + " SOL" : "—"}
                  <small>{coin ? "$" + compact(coin.marketCapUsd) + " cap" : "market cap —"}</small>
                </strong>
                <em className={change === null ? "" : change >= 0 ? "is-up" : "is-down"}>
                  {change === null ? "—" : (change >= 0 ? "+" : "") + change + "%"}
                </em>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
