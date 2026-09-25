/**
 * Marketing and market sections: the home hero with its live mine console, the ticker, the
 * explore board, the selected-mine summary, the core-loop explainer and the footer.
 *
 * Numbers here are the Worker's token summaries as-is. Nothing in this file estimates a reward:
 * the only estimate in the product is the server's, shown in the mine info panel with its label.
 */
import { useMemo, useState } from "react";
import {
  IconArrowDownRight,
  IconArrowUpRight,
  IconChevronRight,
  IconDiscoveries,
  IconHammer,
  IconMine,
  IconOre,
  IconPlus,
  IconStreak,
  IconTimer,
  IconWallet,
} from "../icons";
import type { MineInfo, PlayerProfile, TokenSummary } from "../../shared/types";
import { GAMEPLAY_DEFAULTS } from "../../shared/economics";
import { compact, countdown, money, percent, shortAddress, solAmount } from "../format";
import { describeEmissionWindow, resolveNetworkPower } from "../mineView";
import { requestWalletMenu } from "../wallet";
import { BrandMark } from "./AppHeader";
import { LEGAL_ROUTES } from "./legal/routes";
import { EmptyState } from "./StatusViews";
import { TokenOrb } from "./TokenOrb";

export function HomeHero({
  featured,
  player,
  connected,
  now,
  activating,
  error,
  onActivate,
  onManageCrew,
  onLaunch,
  onClaimRewards,
}: {
  featured: TokenSummary | null;
  player: PlayerProfile | null;
  connected: boolean;
  now: number;
  activating: boolean;
  error: string;
  onActivate(): void;
  onManageCrew(): void;
  onLaunch(): void;
  onClaimRewards?(): void;
}) {
  const isMiningActive = player?.activationState === "ACTIVE";
  const reservePercent = featured ? (featured.reserveRemaining / featured.reserveTotal) * 100 : 0;
  return (
    <section className="hero page-shell" id="home">
      <div className="hero-copy">
        <div className="eyebrow">
          <span className={"live-dot " + (featured ? "" : "idle-dot")} />
          {featured ? "A memecoin mine is available" : "No memecoins launched yet"}
        </div>
        <h1>
          LAUNCH MEMECOINS.
          <br />
          RUN A <span>MINING CREW.</span>
        </h1>
        <p>
          Creators launch fixed-supply memecoins with the trading and mining rules set on chain.
          Players activate a crew, mine eligible launches, review random discoveries and claim
          what reaches their wallet.
        </p>
        <div className="hero-actions">
          <a className="btn btn-primary btn-lg" href="/mine">
            Start mining <IconMine size={20} />
          </a>
          <a className="btn btn-link" href="/create">
            Launch a coin <IconArrowUpRight size={19} />
          </a>
        </div>
        <div className="trust-row">
          <span>Mint revoked</span>
          <span>Mining vault funded</span>
          <span><IconWallet size={17} /> Wallet-approved payouts</span>
        </div>
      </div>

      {!featured ? (
        <div className="mine-console console-empty">
          <div className="console-top">
            <div className="featured-token">
              <span className="token-orb token-orb-large orb-empty"><IconMine size={20} /></span>
              <div><span>NO ACTIVE MINE</span><h2>Nothing launched yet</h2></div>
            </div>
            <span className="active-pill idle"><i /> EMPTY</span>
          </div>
          <div className="empty-body">
            <p>
              No token has been launched on this protocol yet, so there is nothing to mine. Block
              rewards, network power and prices will appear here once a real coin is launched.
            </p>
            <button className="btn btn-primary" onClick={onLaunch}>
              Launch the first coin <IconPlus size={19} />
            </button>
          </div>
        </div>
      ) : (
        <div className={"mine-console " + (isMiningActive ? "is-mining" : "")} id="mine">
          <div className="console-top">
            <div className="featured-token">
              <TokenOrb symbol={featured.symbol} imageUrl={featured.imageUrl} large />
              <div><span>{isMiningActive ? "NOW MINING" : "FEATURED MINE"}</span><h2>{featured.name}</h2></div>
            </div>
            <span className={"active-pill " + (isMiningActive ? "" : "idle")}>
              <i /> {isMiningActive ? "CREW ACTIVE" : player ? "CREW PAUSED" : "NOT ACTIVATED"}
            </span>
          </div>
          <div className="mine-scene" aria-hidden="true">
            <div className="grid-lines" />
            <div className="ore ore-one" /><div className="ore ore-two" /><div className="ore ore-three" />
            <div className="pickaxe-wrap"><IconMine size={82} /></div>
            <div className="impact"><span /><span /><span /></div>
            <div className="depth-label">LAYER 0{Math.max(1, Math.round((100 - reservePercent) / 15))}</div>
          </div>
          <div className="block-stats">
            <div><span>NEXT BLOCK</span><strong>{featured.networkPower > 0 ? countdown(featured.nextBlockAt, now) : "AWAITING MINERS"}</strong></div>
            <div><span>BLOCK REWARD</span><strong>{compact(featured.rewardPerBlock)} <small>${featured.symbol}</small></strong></div>
            <div><span>NETWORK POWER</span><strong>{compact(featured.networkPower)}</strong></div>
          </div>
          {player && (
            <div className="crew-strip">
              <span><IconStreak size={13} /> {player.streak} day streak</span>
              <span><IconOre size={13} /> {Math.floor(player.oreBalance).toLocaleString()} ORE</span>
              <span>{player.power.toLocaleString()} power</span>
              {isMiningActive && (
                <span><IconTimer size={13} /> resets in {countdown(Math.floor(player.activationExpiresAt ?? 0), now)}</span>
              )}
              {connected && onClaimRewards && (
                <button type="button" className="claim-rewards-button" onClick={onClaimRewards}>
                  <IconOre size={12} /> Claim on-chain rewards
                </button>
              )}
            </div>
          )}
          {error && <p className="form-message console-error" role="alert">{error}</p>}
          {!connected ? (
            <button className="mine-button" type="button" onClick={requestWalletMenu}>
              <IconMine size={20} /> Connect wallet to mine
            </button>
          ) : isMiningActive ? (
            <button className="mine-button" onClick={onManageCrew}>
              <IconHammer size={20} /> Manage crew
            </button>
          ) : (
            <button className="mine-button" disabled={activating} onClick={onActivate}>
              {activating ? <>Activating…</> : <><IconMine size={20} /> Activate mine ({GAMEPLAY_DEFAULTS.activationSeconds / 3_600}h)</>}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

export function Ticker({ tokens }: { tokens: TokenSummary[] }) {
  if (tokens.length === 0) return null;
  return (
    <div className="ticker-wrap" aria-hidden="true">
      <div className="ticker">
        {[...tokens, ...tokens].map((token, index) => (
          <span key={token.symbol + "-" + index}>
            <b>${token.symbol}</b> {money(token.priceUsd)}{" "}
            {/* The worker reports null when no honest 24h change exists yet, so the ticker falls
                back to the indexed trades that did happen instead of printing a fake zero. */}
            {token.change24h === null ? (
              <i className="unknown">{token.trades24h} trades</i>
            ) : (
              <i className={token.change24h >= 0 ? "up" : "down"}>{token.change24h >= 0 ? "+" : ""}{token.change24h}%</i>
            )}
          </span>
        ))}
      </div>
    </div>
  );
}

type SortMode = "trending" | "new" | "reduction" | "almost";

const SORTS: { id: SortMode; label: string }[] = [
  { id: "trending", label: "Trending" },
  { id: "new", label: "New" },
  { id: "reduction", label: "Near reduction" },
  { id: "almost", label: "Almost mined" },
];

function sortTokens(tokens: TokenSummary[], mode: SortMode): TokenSummary[] {
  const list = [...tokens];
  const left = (token: TokenSummary) => (token.reserveTotal > 0 ? token.reserveRemaining / token.reserveTotal : 1);
  if (mode === "new") return list.sort((a, b) => b.createdAt - a.createdAt);
  if (mode === "reduction") return list.sort((a, b) => a.nextEpochAt - b.nextEpochAt);
  if (mode === "almost") return list.sort((a, b) => left(a) - left(b));
  // Trending ranks on the measured 24h change. A token whose change is unknown (null, never zero)
  // ranks after the measured ones, ordered by the trades that did happen.
  return list.sort((a, b) => {
    if (a.change24h === null || b.change24h === null) {
      if (a.change24h !== b.change24h) return a.change24h === null ? 1 : -1;
      return b.trades24h - a.trades24h;
    }
    return b.change24h - a.change24h;
  });
}

export function ExploreBoard({ tokens, limit, onLaunch }: { tokens: TokenSummary[]; limit?: number; onLaunch(): void }) {
  const [mode, setMode] = useState<SortMode>("trending");
  const sorted = useMemo(() => sortTokens(tokens, mode), [tokens, mode]);
  const shown = limit ? sorted.slice(0, limit) : sorted;
  return (
    <section className="discover page-shell" id="explore" aria-labelledby="explore-title">
      <div className="section-heading">
        <div>
          <h2 id="explore-title">FIND YOUR<br />NEXT MINE.</h2>
        </div>
        {tokens.length > 1 && (
          <div className="filter-tabs" role="group" aria-label="Sort mines">
            {SORTS.map((sort) => (
              <button key={sort.id} type="button" className={mode === sort.id ? "active" : ""} aria-pressed={mode === sort.id} onClick={() => setMode(sort.id)}>
                {sort.label}
              </button>
            ))}
          </div>
        )}
      </div>
      {shown.length ? (
        <>
          <div className="token-grid">
            {shown.map((token) => <TokenCard key={token.mint} token={token} />)}
          </div>
          {limit && tokens.length > limit && (
            <a className="btn btn-ghost board-more" href="/explore">
              View all {tokens.length} mines <IconChevronRight size={16} />
            </a>
          )}
        </>
      ) : (
        <EmptyState
          title="No mines to explore yet"
            action={<button className="btn btn-primary" onClick={onLaunch}>Launch a coin <IconPlus size={19} /></button>}
        >
          Launched coins appear here with their live price and network power.
        </EmptyState>
      )}
    </section>
  );
}

function TokenCard({ token }: { token: TokenSummary }) {
  const reservePercent = token.reserveTotal > 0 ? Math.round((token.reserveRemaining / token.reserveTotal) * 100) : 0;
  const change = token.change24h;
  const up = change !== null && change >= 0;
  /**
   * Before graduation the budget paying this mine's blocks is the curve's own launch cap, and the
   * card's bar has to count that budget rather than a reserve nothing is drawing down yet. A mine
   * launched without a curve share stays on the reserve reading.
   */
  const curve = token.curveMining;
  const onCurve = curve?.onCurve === true && curve.cap > 0;
  return (
    <a className="token-card" href={"/mines?mint=" + encodeURIComponent(token.mint)} aria-label={"Open the " + token.name + " mine"}>
      <div className="token-card-head">
        <TokenOrb symbol={token.symbol} imageUrl={token.imageUrl} />
        <div className="token-title">
          <h3>{token.name}</h3>
          <span>${token.symbol}</span>
        </div>
        <span className={"change " + (change === null ? "unknown" : up ? "positive" : "negative")}>
          {change === null ? (
            <>
              <span className="sr-only">no measured change</span>—
            </>
          ) : (
            <>
              {up ? <IconArrowUpRight size={13} /> : <IconArrowDownRight size={13} />}
              <span className="sr-only">{up ? "up" : "down"}</span>
              {Math.abs(change)}%
            </>
          )}
        </span>
      </div>
      <div className="card-price">
        <strong>{money(token.priceUsd)}</strong>
        <span>{compact(token.marketCapUsd)} mcap</span>
      </div>
      {onCurve ? (
        <>
          <div className="reserve-row">
            <span>curve mining</span>
            <strong>{percent(curve.progress)}</strong>
          </div>
          <div className="progress is-curve" aria-hidden="true"><i style={{ width: percent(curve.progress) }} /></div>
          <p className="card-curve-line">
            {curve.open
              ? compact(curve.mined) + " of " + compact(curve.cap) + " $" + token.symbol + " mined from the curve"
              : compact(curve.mined) + " of " + compact(curve.cap) + " $" + token.symbol + " mined · cap spent"}
          </p>
        </>
      ) : (
        <>
          <div className="reserve-row">
            <span><IconMine size={13} /> unmined reserve</span>
            <strong>{reservePercent}%</strong>
          </div>
          <div className="progress" aria-hidden="true"><i style={{ width: reservePercent + "%" }} /></div>
        </>
      )}
      <div className="card-foot">
        <span>{compact(token.networkPower)} power</span>
        <span className="card-cta" aria-hidden="true">Mine <IconChevronRight size={14} /></span>
      </div>
    </a>
  );
}

export function SelectedMine({
  token,
  mineInfo,
  now,
}: {
  token: TokenSummary;
  /**
   * The live mine info payload for this mine once it has landed. It is the authoritative source for
   * the crew power on the mine and the only place the curve runway is estimated, so the panels below
   * take both from it rather than from the token list's cached columns.
   */
  mineInfo: MineInfo | null;
  now: number;
}) {
  const [copied, setCopied] = useState(false);
  const reservePercent = token.reserveTotal > 0 ? (token.reserveRemaining / token.reserveTotal) * 100 : 0;
  /** Pre-graduation the curve's own launch cap is the budget paying this mine's blocks. */
  const curve = token.curveMining;
  const onCurve = curve.onCurve;
  const hasCurveBudget = onCurve && curve.cap > 0;
  const networkPower = resolveNetworkPower(token, mineInfo);
  /** Only mine info estimates the runway, and only for the mine it was fetched for. */
  const curveDaysRemaining = mineInfo && mineInfo.mint === token.mint ? mineInfo.curveMiningDaysRemaining : null;
  /** A curve-phase mine has no next reduction: its rate is flat until the cap or graduation ends it. */
  const emission = describeEmissionWindow({
    curve,
    daysRemaining: curveDaysRemaining,
    epochEndsAt: token.nextEpochAt,
    now,
  });
  function copyMint() {
    navigator.clipboard.writeText(token.mint).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_400);
    }).catch(() => undefined);
  }
  return (
    <section className="selected-mine page-shell" id="mines">
      <div className="selected-heading">
        <div>
          <h1 className="selected-title">{token.name}</h1>
        </div>
        <div className="selected-heading-actions">
          <a className="btn btn-ghost btn-sm" href={"/trade?mint=" + encodeURIComponent(token.mint)}>
            Trade ${token.symbol}
          </a>
          <button className="mint-address" onClick={copyMint} aria-label={"Copy mint address " + token.mint}>
            {shortAddress(token.mint)} <span className="sr-only" aria-live="polite">{copied ? "Copied" : "Copy mint address"}</span>
          </button>
        </div>
      </div>
      <div className="selected-grid">
        <div className="reserve-panel">
          <div className="reserve-number">
            <span>{hasCurveBudget ? "CURVE CAP REMAINING" : "UNMINED SUPPLY"}</span>
            <strong>{reservePercent.toFixed(1)}%</strong>
            <small>
              {compact(token.reserveRemaining)} ${token.symbol} {hasCurveBudget ? "of the launch cap left" : "remain"}
            </small>
          </div>
          <div className="shaft" aria-hidden="true"><i style={{ height: reservePercent + "%" }}><IconMine size={28} /></i></div>
        </div>
        <div className="metric-panel">
          <span>Network power</span>
          <strong>{networkPower === null ? "—" : compact(networkPower)}</strong>
          {networkPower !== null && <small>total on this mine</small>}
        </div>
        <div className="metric-panel">
          <IconTimer />
          <span>{emission.label}</span>
          <strong className={emission.onCurve ? "is-phrase" : undefined}>{emission.value}</strong>
          <small>{emission.detail}</small>
        </div>
        <div className="metric-panel">
          <IconWallet />
          <span>Wallet custody</span>
          <strong>YOU KEEP CONTROL</strong>
          <small>Your wallet authorizes trades and mining payouts. Leftover launch supply is held in the Diggo-signed mining vault.</small>
        </div>
      </div>
      {hasCurveBudget && (
        <div className="selected-curve">
          <div className="selected-curve-head">
            <span>{percent(curve.progress)} of the launch cap mined</span>
          </div>
          <div
            className="tier-progress-bar"
            role="img"
            aria-label={"Curve mining " + percent(curve.progress) + " of the launch cap mined"}
          >
            <i style={{ width: percent(curve.progress) }} />
          </div>
          <div className="selected-curve-stats">
            <div><span>Mined</span><strong>{compact(curve.mined)} <small>${token.symbol}</small></strong></div>
            <div><span>Launch cap</span><strong>{compact(curve.cap)} <small>${token.symbol}</small></strong></div>
            <div><span>Cap left</span><strong>{compact(curve.remaining)} <small>${token.symbol}</small></strong></div>
            <div><span>Block reward</span><strong>{compact(curve.blockReward)} <small>${token.symbol}</small></strong></div>
            <div>
              <span>Sell capacity</span>
              <strong>{solAmount(token.sellCapacity.sol)} <small>SOL of buyers' money</small></strong>
            </div>
          </div>
          <p>
            Mining before graduation spends curve inventory, pushing the bonding-curve price like a
            buy, and adds no SOL. Sells are limited to the SOL buyers have contributed.
          </p>
        </div>
      )}
    </section>
  );
}

export function HowItWorks() {
  return (
    <section className="how-section" id="how">
      <div className="page-shell">
        <div className="section-heading light">
          <div>
            <h2>TWO WAYS IN.<br />ONE GAME.</h2>
          </div>
          <p>Mining rewards and yield are not guaranteed. Wallet signatures authorize account, claim and launch actions.</p>
        </div>
        <div className="steps">
          <article><b>01</b><span className="step-icon"><IconPlus /></span><h3>Launch a coin</h3><p>Set its fixed supply and launch with a wallet-signed transaction. Leftovers go to the Diggo-signed mining vault.</p></article>
          <article><b>02</b><span className="step-icon"><IconMine /></span><h3>Activate a crew</h3><p>Open a 24-hour shift. The server randomly assigns an eligible mine and your crew keeps mining it while the shift is valid.</p></article>
          <article><b>03</b><span className="step-icon"><IconDiscoveries /></span><h3>Review discoveries</h3><p>Each eligible window has one random opportunity. Mined memecoins accrue in Discoveries until you approve a claim.</p></article>
        </div>
      </div>
    </section>
  );
}

export function FinalCta({ onLaunch }: { onLaunch(): void }) {
  return (
    <section className="final-cta">
      <div className="page-shell">
        <span className="huge-pick" aria-hidden="true"><IconMine /></span>
        <div><h2>MINE OR LAUNCH.</h2></div>
        <div className="hero-actions">
          <a className="btn btn-dark btn-lg" href="/mine">Start mining <IconMine size={20} /></a>
          <button className="btn btn-dark btn-lg" onClick={onLaunch}>Launch a coin <IconArrowUpRight size={20} /></button>
        </div>
      </div>
    </section>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer page-shell">
      <div className="site-footer-content">
        <BrandMark />
        <nav className="site-footer-product" aria-label="Product">
          <a href="/mines">Mines</a><a href="/leaderboards">Leaderboards</a><a href="/create">Launch</a>
        </nav>
        <a className="site-footer-x" href="https://x.com/Diggo_Fun" target="_blank" rel="noopener noreferrer" aria-label="Diggo on X">
          <img className="x-logo" src="/assets/icons/x.png" srcSet="/assets/icons/x.png 1x, /assets/icons/x@2x.png 2x" width={18} height={18} alt="" />
          <span>@Diggo_Fun</span>
        </a>
        <nav className="site-footer-legal" aria-label="Legal">
          {LEGAL_ROUTES.map((route) => (
            <a key={route.id} href={route.path}>
              {route.short}
            </a>
          ))}
        </nav>
        <small>© 2026 Diggo.fun</small>
      </div>
    </footer>
  );
}
