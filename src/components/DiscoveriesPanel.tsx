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
import { Compass, ExternalLink, Gem, Pickaxe, Repeat2, Sparkles, TrendingUp } from "lucide-react";
import type { DiscoveryOpportunity, DiscoveryRecord, TokenSummary } from "../../shared/types";
import { tokenAmount } from "../format";
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
  claimingId: string | null;
  error: string;
  notice: string;
  onRequestOpportunity(): void;
  onRoll(): void;
  onClaim(discovery: DiscoveryRecord): void;
  onOpenToken(mint: string): void;
  onTrade(mint: string): void;
  onSwitchCrew(mint: string): void;
}

function symbolOf(tokens: TokenSummary[], mint: string): string {
  return tokens.find((token) => token.mint === mint)?.symbol ?? mint.slice(0, 4);
}

export function DiscoveriesPanel(props: DiscoveriesPanelProps) {
  const { signedIn, discoveries, opportunity, tokens, loading, rolling, claimingId, error, notice } = props;
  const claimable = discoveries.filter((discovery) => discovery.claimable);
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
            <Gem size={14} /> Discoveries
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
            {rolling ? <Compass size={16} /> : opportunity && !spent ? <Pickaxe size={16} /> : <Sparkles size={16} />}
            {rollLabel}
          </button>
          <small>{rollHint}</small>
        </div>
      </div>

      {notice && <p className="form-message discovery-notice" role="status">{notice}</p>}
      {error && <p className="form-message" role="alert">{error}</p>}

      {!signedIn && (
        <EmptyState
          icon={<Gem size={26} />}
          title="Hidden finds are waiting underground."
          action={<button className="btn btn-primary" onClick={requestWalletMenu}>Connect wallet</button>}
        >
          An active crew gets one discovery opportunity per window. Sign in to see what yours has
          turned up and claim it before it expires.
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
        <EmptyState icon={<Compass size={26} />} title="No discoveries yet">
          An active, eligible crew has a chance each window, and the mine's own
          liquidity, volume and reserve decide how good that chance can be.
        </EmptyState>
      )}

      {claimable.length > 0 && (
        <div className="discovery-claimable">
          <span className="claim-block-head-label">READY TO CLAIM</span>
          <ul>
            {claimable.map((discovery) => (
              <li key={discovery.id}>
                <div>
                  <strong>
                    {tokenAmount(discovery.tokenAmount)} {symbolOf(tokens, discovery.mint)}
                  </strong>
                  <small>
                    {discovery.rarity} / {discovery.visualEvent}
                  </small>
                </div>
                <div className="discovery-row-actions">
                  <button className="badge ledger-token" onClick={() => props.onOpenToken(discovery.mint)}>
                    View token <ExternalLink size={11} />
                  </button>
                  <button disabled={claimingId === discovery.id} onClick={() => props.onClaim(discovery)}>
                    {claimingId === discovery.id ? "Claiming…" : "Claim"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
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
            <h4>{discovery.visualEvent}</h4>
            <strong>
              {tokenAmount(discovery.tokenAmount)} {symbolOf(tokens, discovery.mint)}
            </strong>
            <small>{new Date(discovery.createdAt * 1_000).toLocaleString()}</small>
            <div className="discovery-card-actions">
              <button className="badge ledger-token" onClick={() => props.onOpenToken(discovery.mint)}>
                Token page
              </button>
              <button className="badge ledger-token" onClick={() => props.onTrade(discovery.mint)}>
                <TrendingUp size={12} /> Trade
              </button>
              <button className="badge ledger-token" onClick={() => props.onSwitchCrew(discovery.mint)}>
                <Repeat2 size={12} /> Switch crew to this mine
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
