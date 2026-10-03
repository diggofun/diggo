/**
 * Marketing and market sections: the home hero with its bot mine, the explore board, the
 * selected-mine summary, the short explainer, the FAQ and the footer.
 *
 * Numbers here are the Worker's token summaries as-is. Nothing in this file estimates a reward:
 * the only estimate in the product is the server's, shown in the mine info panel with its label.
 */
import { useMemo, useState, type ReactNode } from "react";
import { track } from "../analytics";
import { IconArrowDownRight, IconArrowUpRight, IconCheck, IconChevronDown, IconClaim, IconCrew, IconDiscoveries, IconMine, IconPlus, IconWallet } from "../icons";
import type { MineInfo, PlayerProfile, TokenSummary } from "../../shared/types";
import { GAMEPLAY_DEFAULTS } from "../../shared/economics";
import { compact, countdown, money, percent, shortAddress, solAmount } from "../format";
import { describeEmissionWindow, miningReserveShare, resolveNetworkPower } from "../mineView";
import { requestWalletMenu } from "../wallet";
import { BrandMark } from "./AppHeader";
import { BotMine } from "./BotMine";
import { LEGAL_ROUTES } from "./legal/routes";
import { EmptyState } from "./StatusViews";
import { TokenOrb } from "./TokenOrb";
import { Bot, botAt } from "./Bot";

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
  coinSymbols = [],
}: {
  featured: TokenSummary | null;
  /** Tickers the hero crew digs up; the featured coin's comes first. */
  coinSymbols?: string[];
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
  const symbols = featured ? [featured.symbol, ...coinSymbols.filter((symbol) => symbol !== featured.symbol)] : coinSymbols;
  return (
    <section className="hero page-shell" id="home">
      <div className="hero-copy">
        <h1>
          Launch &amp; earn
          <br />
          memecoins <span className="grad-word">for free.</span>
        </h1>
        <p className="hero-lead">
          Launch a coin on Solana, or send your bots to mine one for free. What they dig up, you
          claim to your own wallet.
        </p>
        <div className="hero-actions">
          <a className="btn btn-primary btn-lg" href="/mine">
            Start mining <IconMine size={20} />
          </a>
          <button type="button" className="btn btn-dark btn-lg" onClick={onLaunch}>
            Launch a coin <IconPlus size={20} />
          </button>
        </div>
      </div>

      <div className="hero-mine">
        <BotMine crew={4} active={featured !== null} symbols={featured ? symbols : []} />
        {featured ? (
          <div className="hero-mine-bar">
            <div className="mine-panel-coin">
              <TokenOrb symbol={featured.symbol} imageUrl={featured.imageUrl} />
              <div>
                <strong>{featured.name}</strong>
                <small>
                  {featured.miningEmission?.kind === "TIME" ? "Rewards accrue over time" : (
                    <>
                      {featured.networkPower > 0 ? "Next block " + countdown(featured.nextBlockAt, now) : "Waiting for miners"}
                      {" · "}
                      {compact(featured.rewardPerBlock)} ${featured.symbol} per block
                    </>
                  )}
                </small>
              </div>
            </div>
            {!connected ? (
              <button className="btn btn-primary" type="button" onClick={() => requestWalletMenu("home_hero")}>
                <IconWallet size={18} /> Connect to mine
              </button>
            ) : isMiningActive ? (
              <button className="btn btn-dark" type="button" onClick={onManageCrew}>Manage crew</button>
            ) : (
              <button className="btn btn-primary" type="button" disabled={activating} onClick={onActivate}>
                {activating ? "Activating…" : "Activate " + GAMEPLAY_DEFAULTS.activationSeconds / 3_600 + "h shift"}
              </button>
            )}
          </div>
        ) : (
          <div className="hero-mine-bar">
            <div className="mine-panel-coin">
              <div>
                <strong>No coins launched yet</strong>
                <small>The first launch opens the first mine.</small>
              </div>
            </div>
            <button className="btn btn-primary" type="button" onClick={onLaunch}>Launch the first coin</button>
          </div>
        )}
        {player && connected && onClaimRewards && (
          <button type="button" className="btn btn-ghost btn-sm hero-claim" onClick={onClaimRewards}>Claim on-chain rewards</button>
        )}
        {error && <p className="form-message" role="alert">{error}</p>}
      </div>
    </section>
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
  const left = (token: TokenSummary) => miningReserveShare(token) ?? Number.POSITIVE_INFINITY;
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
        <h2 id="explore-title">{limit ? "Mines to dig" : "Explore coins"}</h2>
        {!limit && tokens.length > 1 && (
          <div className="filter-tabs" role="group" aria-label="Sort mines">
            {SORTS.map((sort) => (
              <button key={sort.id} type="button" className={mode === sort.id ? "active" : ""} aria-pressed={mode === sort.id} onClick={() => setMode(sort.id)}>
                {sort.label}
              </button>
            ))}
          </div>
        )}
        {limit && tokens.length > limit && (
          <a className="btn btn-ghost btn-sm" href="/explore">See all {tokens.length}</a>
        )}
      </div>
      {shown.length ? (
        <div className="token-grid">
          {shown.map((token) => <TokenCard key={token.mint} token={token} />)}
        </div>
      ) : (
        <EmptyState
          title="No mines yet"
          action={<button className="btn btn-primary" onClick={onLaunch}>Launch a coin <IconPlus size={19} /></button>}
        >
          Launched coins show up here with their price and crew.
        </EmptyState>
      )}
    </section>
  );
}

function TokenCard({ token }: { token: TokenSummary }) {
  const change = token.change24h;
  const up = change !== null && change >= 0;
  /**
   * Before graduation the budget paying this mine's blocks is the curve's own launch cap, and the
   * card's bar has to count that budget rather than a reserve nothing is drawing down yet. A mine
   * launched without a curve share stays on the reserve reading.
   */
  const curve = token.curveMining;
  const onCurve = curve?.onCurve === true && curve.cap > 0;
  const reserveShare = miningReserveShare(token);
  const bar = onCurve ? curve.progress : reserveShare;
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
      <strong className="token-price">{money(token.priceUsd)}</strong>
      {bar !== null && <div className="progress" aria-hidden="true"><i style={{ width: percent(bar) }} /></div>}
      <small className="token-foot">
        {onCurve ? percent(curve.progress) + " of the launch cap mined" : reserveShare === null ? "— reserve left" : Math.round(reserveShare * 100) + "% of the reserve left"}
        {" · "}
        {compact(token.networkPower)} power
      </small>
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
  /** Pre-graduation the curve's own launch cap is the budget paying this mine's blocks. */
  const curve = token.curveMining;
  const onCurve = curve.onCurve;
  const hasCurveBudget = onCurve && curve.cap > 0;
  const reserveShare = hasCurveBudget ? curve.remaining / curve.cap : miningReserveShare(token);
  const remaining = hasCurveBudget ? curve.remaining : token.reserveRemaining;
  const networkPower = resolveNetworkPower(token, mineInfo);
  /** Only mine info estimates the runway, and only for the mine it was fetched for. */
  const curveDaysRemaining = mineInfo && mineInfo.mint === token.mint ? mineInfo.curveMiningDaysRemaining : null;
  /** A curve-phase mine has no next reduction: its rate is flat until the cap or graduation ends it. */
  const emission = token.miningEmission?.kind === "TIME" ? {
    label: "Mining model",
    value: "Time-based",
    detail: "Rewards accrue over time; payouts after graduation",
    onCurve: false,
  } : describeEmissionWindow({
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
      <header className="screen-head screen-head-row">
        <div className="coin-title">
          <TokenOrb symbol={token.symbol} imageUrl={token.imageUrl} large />
          <div>
            <h1 className="selected-title">{token.name}</h1>
            <button className="mint-address" onClick={copyMint} aria-label={"Copy mint address " + token.mint}>
              ${token.symbol} · {shortAddress(token.mint)} <span className="sr-only" aria-live="polite">{copied ? "Copied" : "Copy mint address"}</span>
            </button>
          </div>
        </div>
        <a className="btn btn-primary" href={"/trade?mint=" + encodeURIComponent(token.mint)}>
          Trade ${token.symbol}
        </a>
      </header>
      <div className="stat-row">
        <article className="stat">
          <span>{hasCurveBudget ? "Launch cap left" : "Unmined supply"}</span>
          <strong>{reserveShare === null ? "—" : (reserveShare * 100).toFixed(1) + "%"}</strong>
          <small>{remaining === null ? "—" : compact(remaining)} ${token.symbol}</small>
        </article>
        <article className="stat">
          <span>Network power</span>
          <strong>{networkPower === null ? "—" : compact(networkPower)}</strong>
          {networkPower !== null && <small>on this mine</small>}
        </article>
        <article className="stat">
          <span>{emission.label}</span>
          <strong className={emission.onCurve ? "is-phrase" : undefined}>{emission.value}</strong>
          <small>{emission.detail}</small>
        </article>
      </div>
      {hasCurveBudget && (
        <div className="curve-card">
          <div className="curve-card-head">
            <strong>{percent(curve.progress)} of the launch cap mined</strong>
            <span>{compact(curve.mined)} of {compact(curve.cap)} ${token.symbol}</span>
          </div>
          <div className="progress" role="img" aria-label={"Curve mining " + percent(curve.progress) + " of the launch cap mined"}>
            <i style={{ width: percent(curve.progress) }} />
          </div>
          <div className="curve-card-stats">
            <span>Block reward <b>{compact(curve.blockReward)} ${token.symbol}</b></span>
            <span>Sell capacity <b>{solAmount(token.sellCapacity.sol)} SOL</b></span>
          </div>
          <p>
            Mining before graduation spends curve inventory and pushes the price like a buy. Sells
            are limited to the SOL buyers have put in.
          </p>
        </div>
      )}
    </section>
  );
}

/**
 * The plain-language explainer: what the product is, who it is for, and which parts are real
 * on-chain assets versus game progression. Kept short on purpose; docs/FAQ.md has the long form.
 */
export function AboutDiggo() {
  return (
    <section className="about-section page-shell" id="about" aria-labelledby="about-title">
      <div className="about-intro">
        <h2 id="about-title">A launchpad with a mine under it.</h2>
        <p>Every coin launched here becomes a mine. Your bots dig it daily. What they find is yours.</p>
      </div>
      <div className="bot-parade" aria-hidden="true">
        {Array.from({ length: 7 }, (_, index) => (
          <Bot key={index} {...botAt(index + 2)} size={60} mood={index % 3 === 0 ? "busy" : "idle"} phase={index * 0.9} />
        ))}
      </div>
      <div className="about-audiences">
        <article className="audience-card">
          <h3>Players</h3>
          <ul>
            <li><IconCheck size={16} /> Open a 24-hour shift</li>
            <li><IconCheck size={16} /> Bots dig while you&apos;re away</li>
            <li><IconCheck size={16} /> Claim up to 12 coins at once</li>
          </ul>
          <a className="btn btn-primary" href="/mine">Start mining</a>
        </article>
        <article className="audience-card">
          <h3>Creators</h3>
          <ul>
            <li><IconCheck size={16} /> Launch a fixed-supply coin</li>
            <li><IconCheck size={16} /> Trade on Meteora from block one</li>
            <li><IconCheck size={16} /> Players mine it every day</li>
          </ul>
          <a className="btn btn-dark" href="/create">Launch a coin</a>
        </article>
      </div>
      <p className="about-fineprint">
        Claimed memecoins are real SPL tokens in your wallet. ORE and Mining Power are game progress
        only. Memecoins can go to zero.
      </p>
    </section>
  );
}

const MINING_DAY: { icon: ReactNode; title: string; body: string }[] = [
  { icon: <IconWallet />, title: "Activate", body: "Open a 24-hour shift from your wallet." },
  { icon: <IconCrew />, title: "Bots dig", body: "They mine a random coin, even with the tab closed." },
  { icon: <IconDiscoveries />, title: "Discover", body: "Mined coins pile up in Discoveries." },
  { icon: <IconClaim />, title: "Claim all", body: "Up to 12 coins in one signed transaction." },
];

export function HowItWorks() {
  return (
    <section className="how-section page-shell" id="how">
      <div className="section-heading">
        <h2>About a minute a day.</h2>
      </div>
      <ol className="steps">
        {MINING_DAY.map((step, index) => (
          <li key={step.title}>
            <Bot {...botAt(index + 4)} size={56} mood={index === 1 ? "dig" : "idle"} phase={index * 0.6} />
            <h3>{step.icon} {step.title}</h3>
            <p>{step.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

const HOME_FAQ: { q: string; a: string }[] = [
  { q: "Does it cost anything to play?", a: "No. You only need a little SOL for network fees." },
  { q: "Who can claim?", a: "Anyone can dig. To collect, your wallet needs to be 7+ days old with $10 in it, after 5 active days." },
  { q: "What do I get when I claim?", a: "Real SPL memecoins, sent to the wallet that signs the claim." },
  { q: "Why is some of my reward pending?", a: "Coins still on their bonding curve pay out once they graduate." },
  { q: "Are ORE and Mining Power tokens?", a: "No. They're game progress: you can't buy, sell or withdraw them." },
  { q: "Who holds my coins?", a: "You do. Every payout is a transaction your own wallet signs." },
  { q: "What does a launch cost?", a: "Network costs, plus an optional first buy. Creator trading fee is 0%." },
];

export function HomeFaq() {
  return (
    <section className="home-faq page-shell" id="faq" aria-labelledby="faq-title">
      <h2 id="faq-title">Quick answers.</h2>
      <div className="faq-list">
        {HOME_FAQ.map((item) => (
          <details key={item.q} className="faq-item">
            <summary>{item.q}<IconChevronDown size={20} /></summary>
            <p>{item.a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

export function FinalCta({ onLaunch }: { onLaunch(): void }) {
  return (
    <section className="final-cta page-shell">
      <div className="final-cta-card">
        <span className="final-cta-crew" aria-hidden="true">
          <Bot shape="blob" color="#ff6a00" hat="hardhat" size={68} mood="dig" phase={0.2} />
          <Bot shape="cloud" color="#06b6d4" eyewear="goggles" size={54} mood="busy" phase={0.7} />
          <Bot shape="triangle" color="#ec4899" hat="party" size={48} mood="attention" phase={1.1} />
        </span>
        <h2>Mine or launch.</h2>
        <div className="hero-actions">
          <a className="btn btn-primary btn-lg" href="/mine">Start mining <IconMine size={20} /></a>
          <button className="btn btn-dark btn-lg" onClick={onLaunch}>Launch a coin <IconArrowUpRight size={20} /></button>
        </div>
      </div>
    </section>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer page-shell">
      <BrandMark />
      <nav className="site-footer-links" aria-label="Legal">
        {LEGAL_ROUTES.map((route) => (
          <a key={route.id} href={route.path}>
            {route.short}
          </a>
        ))}
        <a href="https://x.com/Diggo_Fun" target="_blank" rel="noopener noreferrer" onClick={() => track("x_link_clicked", { location: "footer" })}>
          X
        </a>
      </nav>
      <small>© 2026 Diggo.fun</small>
    </footer>
  );
}
