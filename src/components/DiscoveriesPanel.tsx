/**
 * Discoveries (spec 55, 56, 57).
 *
 * One opportunity per window, authored server-side, and a roll that can only happen once — the
 * Worker decides whether anything turns up, which token it is, its rarity, its visual event and its
 * amount. This screen submits the roll and renders whatever comes back. There is no seed, no
 * re-roll and no client-side randomness in this file.
 *
 * Claims need their own wallet-signed, single-use challenge, exactly like reward claims.
 */
import type { DiscoveryOpportunity, DiscoveryRecord, TokenSummary } from "../../shared/types";
import { tokenAmount } from "../format";
import { IconDiscoveries, IconMine } from "../icons";
import { useReducedMotion } from "../motion";
import { requestWalletMenu } from "../wallet";
import { DiscoveryArt } from "./MineScene";
import { EmptyState } from "./StatusViews";

export interface DiscoveriesPanelProps {
  signedIn: boolean;
  discoveries: DiscoveryRecord[];
  opportunity: DiscoveryOpportunity | null;
  tokens: TokenSummary[];
  loading: boolean;
  rolling: boolean;
  error: string;
  notice: string;
  onRequestOpportunity(): void;
  onRoll(): void;
  onOpenToken(mint: string): void;
  onTrade(mint: string): void;
}

function symbolOf(tokens: TokenSummary[], mint: string): string {
  return tokens.find((token) => token.mint === mint)?.symbol ?? mint.slice(0, 4);
}

export function DiscoveriesPanel(props: DiscoveriesPanelProps) {
  const { signedIn, discoveries, opportunity, tokens, loading, rolling, error, notice } = props;
  const reducedMotion = useReducedMotion();

  const spent = opportunity !== null && opportunity.status !== "PENDING" && opportunity.status !== "ELIGIBLE";
  const rollLabel = rolling ? "Digging" : spent ? "Window spent" : opportunity ? "Roll this window" : "Ask for an opportunity";
  const rollHint = !signedIn
    ? "Sign in with your wallet to dig for a discovery."
    : spent
      ? "One opportunity per window. The next one opens automatically."
      : opportunity
        ? "This window's opportunity is ready and can be rolled once."
        : "One opportunity is authored per active crew per window.";

  return (
    <section className="discoveries page-shell" id="discoveries">
      <div className="section-heading">
        <div>
          <div className="eyebrow">
            <IconDiscoveries size={14} /> Discoveries
          </div>
          <h1>
            WHAT THE CREW
            <br />
            TURNED UP.
          </h1>
        </div>
        <div className="discovery-roll">
          <button
            className="primary-button"
            disabled={!signedIn || rolling || spent}
            onClick={opportunity ? props.onRoll : props.onRequestOpportunity}
          >
            {rolling ? <IconDiscoveries size={16} /> : opportunity && !spent ? <IconMine size={16} /> : <IconDiscoveries size={16} />}
            {rollLabel}
          </button>
          <small>{rollHint}</small>
        </div>
      </div>

      {notice && <p className="form-message discovery-notice" role="status">{notice}</p>}
      {error && <p className="form-message" role="alert">{error}</p>}

      {!signedIn && (
        <EmptyState
          icon={<IconDiscoveries size={26} />}
          title="Hidden finds are waiting underground."
          action={<button className="btn btn-primary" onClick={requestWalletMenu}>Connect wallet</button>}
        >
          An active crew gets one discovery opportunity per window. Sign in to see what yours has
          turned up. Rewards accrue here automatically; wallet collection is a separate action.
        </EmptyState>
      )}
      {signedIn && loading && (
        <div className="discovery-grid" aria-busy="true">
          <span className="skeleton skeleton-card" />
          <span className="skeleton skeleton-card" />
          <span className="skeleton skeleton-card" />
        </div>
      )}
      {signedIn && !loading && discoveries.length === 0 && (
        <EmptyState icon={<IconDiscoveries size={26} />} title="No discoveries yet">
          An active, eligible crew has a chance each window, and the mine's own
          liquidity, volume and reserve decide how good that chance can be. Any mined memecoin
          appears here automatically, without a manual claim.
        </EmptyState>
      )}

      <div className="discovery-grid">
        {discoveries.map((discovery) => (
          <article
            className={"discovery-card rarity-" + discovery.rarity + (reducedMotion ? " is-quiet" : "")}
            key={discovery.id}
          >
            <header>
              <span className={"rarity-tag rarity-" + discovery.rarity}>{discovery.rarity.toUpperCase()}</span>
              <em className={"reward-status status-" + discovery.status.toLowerCase()}>{discovery.status}</em>
            </header>
            {/* Generated art for the rarity; a rarity without art keeps the drawn rarity tag. */}
            <DiscoveryArt rarity={discovery.rarity} className="discovery-card-art" />
            <h4>{tokens.find((token) => token.mint === discovery.mint)?.name ?? "Mined memecoin"}</h4>
            <strong>
              {tokenAmount(discovery.tokenAmount)} {symbolOf(tokens, discovery.mint)}
            </strong>
            <small>{discovery.rarity} · {discovery.visualEvent} · accrued automatically</small>
            <div className="discovery-card-actions">
              <button className="badge ledger-token" onClick={() => props.onOpenToken(discovery.mint)}>
                Token page
              </button>
              <button className="badge ledger-token" onClick={() => props.onTrade(discovery.mint)}>
                Trade
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
