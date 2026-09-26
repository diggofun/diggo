/**
 * Trade $DIGGO, the platform own coin.
 *
 * This is not a separate market implementation. It is the same per-coin trade view a mine gets when
 * you open it - the same header, the same price chart fed by real indexed trades, the same SwapPanel
 * buy/sell form and the same stats - pointed at the official mint instead of a launched mine. Every
 * number on it therefore comes from the same read path as every other coin, and none of it is
 * fabricated here.
 *
 * The one thing this page adds is honesty about the pre-launch state. The official mint is an
 * operator-set Worker var (see shared/officialMint.ts), so there are two ways to have nothing to
 * show, and both render the same tidy empty state rather than a market with placeholder numbers:
 *
 *   1. No mint configured - $DIGGO has not been assigned an address yet.
 *   2. A mint, but no indexed token for it - the pool has not been indexed yet.
 *
 * In both cases "launches soon" is the honest description, and inventing a price would be the one
 * thing this page must never do.
 */
import { useEffect, useState } from "react";
import { OFFICIAL_COIN_LOGO, OFFICIAL_COIN_NAME, OFFICIAL_COIN_SYMBOL } from "../../shared/officialMint";
import type { TokenSummary } from "../../shared/types";
import { getToken } from "../api";
import { compact, shortAddress } from "../format";
import { SwapPanel } from "./SwapPanel";
import { EmptyState } from "./StatusViews";

/** The brand mark, shipped as a raster asset. Decorative here: the name is already in the heading. */
const DIGGO_MARK = "/assets/brand/mark-trim-512.png?v=2";

export interface DiggoTradePageProps {
  /** The validated official mint, or null while $DIGGO has not launched. */
  officialMint: string | null;
  programAddress: string;
  cluster: string;
  chainMode: "native" | "meteora";
  meteoraConfigPubkey: string;
  signer: import("../solanaProgram").DiggoWallet | null;
  /** Called after a trade so the page can re-read the coin's own summary. */
  onTraded(): void;
}

/**
 * Reads the official coin's own summary by mint.
 *
 * A 404 here is the "not indexed yet" case, not a failure: the coin exists, the indexer simply has
 * not seen its pool. It is reported as null so the caller can show the empty state instead of an
 * error the visitor cannot act on.
 */
function useOfficialToken(mint: string | null): { token: TokenSummary | null; loading: boolean } {
  const [token, setToken] = useState<TokenSummary | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!mint) {
      setToken(null);
      return;
    }
    let current = true;
    setLoading(true);
    void getToken(mint)
      .then((next) => {
        if (current) setToken(next);
      })
      .catch(() => {
        if (current) setToken(null);
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [mint]);

  return { token, loading };
}

export function DiggoTradePage({
  officialMint,
  programAddress,
  cluster,
  chainMode,
  meteoraConfigPubkey,
  signer,
  onTraded,
}: DiggoTradePageProps) {
  const { token, loading } = useOfficialToken(officialMint);

  if (!officialMint) {
    return (
      <section className="diggo-page page-shell">
        <DiggoHeader mint={null} />
        <EmptyState
          title="$DIGGO launches soon"
          icon={<img className="diggo-empty-mark" src={DIGGO_MARK} alt="" width={512} height={512} />}
        >
          The official Diggo coin is not live yet. This page will carry its real market - price,
          charts and trading - as soon as it launches.
        </EmptyState>
      </section>
    );
  }

  if (!token) {
    return (
      <section className="diggo-page page-shell">
        <DiggoHeader mint={officialMint} />
        {loading ? (
          <div className="diggo-loading" role="status" aria-live="polite">
            <span className="skeleton skeleton-card" />
            <span className="sr-only">Loading the $DIGGO market…</span>
          </div>
        ) : (
          <EmptyState
            title="$DIGGO launches soon"
            icon={<img className="diggo-empty-mark" src={DIGGO_MARK} alt="" width={512} height={512} />}
          >
            The official coin has an address but its market is not indexed yet. Nothing is shown here
            until there are real trades to read.
          </EmptyState>
        )}
      </section>
    );
  }

  // The coin's own symbol is authoritative once it is indexed; only the name is forced to the brand
  // spelling so the heading is never a placeholder row, and the shipped logo covers a missing image.
  const official: TokenSummary = {
    ...token,
    name: OFFICIAL_COIN_NAME,
    symbol: token.symbol || OFFICIAL_COIN_SYMBOL,
    imageUrl: token.imageUrl || OFFICIAL_COIN_LOGO,
  };

  return (
    <section className="diggo-page">
      <DiggoHeader mint={officialMint} name={official.name} symbol={official.symbol} imageUrl={official.imageUrl} />
      <DiggoStats token={official} />
      <SwapPanel
        token={official}
        programAddress={programAddress}
        cluster={cluster}
        chainMode={chainMode}
        meteoraConfigPubkey={meteoraConfigPubkey}
        isOfficialDiggo
        signer={signer}
        onTraded={onTraded}
      />
    </section>
  );
}

/** Name, symbol, mark and mint address - the same header a mine opens with. */
function DiggoHeader({
  mint,
  name,
  symbol,
  imageUrl,
}: {
  mint: string | null;
  name?: string;
  symbol?: string;
  imageUrl?: string | null;
}) {
  return (
    <div className="diggo-hero page-shell">
      <img
        className={imageUrl ? "diggo-hero-mark" : "diggo-hero-mark is-brand"}
        src={imageUrl || DIGGO_MARK}
        alt=""
        width={512}
        height={512}
      />
      <div className="diggo-hero-text">
        <span className="eyebrow">OFFICIAL COIN</span>
        <h1>
          {name || OFFICIAL_COIN_NAME} <span>${symbol || OFFICIAL_COIN_SYMBOL}</span>
        </h1>
        {mint && <code className="diggo-mint">{shortAddress(mint)}</code>}
      </div>
    </div>
  );
}

/**
 * The market stats, from the indexed summary only.
 *
 * Every field here is a real observation or an honest "not measured yet" dash - the same rule the
 * rest of the product follows (see TokenChange24h: null is unknown, never zero).
 */
function DiggoStats({ token }: { token: TokenSummary }) {
  const stats = [
    { label: "Spot price", value: token.priceSol > 0 ? token.priceSol.toExponential(4) + " SOL" : "—" },
    { label: "24h change", value: token.change24h === null ? "—" : token.change24h.toFixed(2) + "%" },
    { label: "24h volume", value: token.volume24hUsd > 0 ? "$" + compact(token.volume24hUsd) : "—" },
    { label: "24h trades", value: token.trades24h > 0 ? String(token.trades24h) : "—" },
    { label: "Market cap", value: token.marketCapUsd > 0 ? "$" + compact(token.marketCapUsd) : "—" },
    { label: "Status", value: token.status.replaceAll("_", " ") },
  ];
  return (
    <div className="diggo-stats page-shell" aria-label="$DIGGO market statistics">
      {stats.map((stat) => (
        <div className="metric-panel" key={stat.label}>
          <span>{stat.label}</span>
          <strong>{stat.value}</strong>
        </div>
      ))}
    </div>
  );
}
