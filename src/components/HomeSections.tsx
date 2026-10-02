/**
 * Marketing and market sections: the home hero with its live mine console, the ticker, the
 * explore board, the selected-mine summary, the core-loop explainer and the footer.
 *
 * Numbers here are the Worker's token summaries as-is. Nothing in this file estimates a reward:
 * the only estimate in the product is the server's, shown in the mine info panel with its label.
 */
import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { track } from "../analytics";
import {
  IconArrowDownRight,
  IconArrowUpRight,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconClaim,
  IconCrew,
  IconDiscoveries,
  IconHammer,
  IconLandmark,
  IconLock,
  IconMine,
  IconOre,
  IconPlus,
  IconStreak,
  IconTimer,
  IconWallet,
  IconWarning,
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
import { Bot, botAt, BOT_COLORS } from "./Bot";

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
  const reservePercent = featured ? (featured.reserveRemaining / featured.reserveTotal) * 100 : 0;
  return (
    <section className="hero page-shell" id="home">
      <div className="hero-copy">
        <div className="eyebrow">
          <span className={"live-dot " + (featured ? "" : "idle-dot")} />
          {featured ? "A memecoin mine is available" : "No memecoins launched yet"}
        </div>
        <h1>
          Launch memecoins.
          <br />
          Run a <span>mining crew.</span>
        </h1>
        <p className="hero-lead">
          Launch a memecoin on Solana, or send your bots to mine one.
          <strong> What they dig up, you claim to your own wallet.</strong>
        </p>
        <div className="hero-actions">
          <a className="btn btn-primary btn-lg" href="/mine">
            Start mining <IconMine size={20} />
          </a>
            <a className="btn btn-link" href="#about">
            What is Diggo? <IconChevronDown size={19} />
          </a>
        </div>
        <ul className="trust-row" aria-label="Safeguards">
          <li><IconLock size={15} /> Fixed supply</li>
          <li><IconLandmark size={15} /> Funded vault</li>
          <li><IconWallet size={15} /> You sign every payout</li>
        </ul>
      </div>

      {!featured ? (
        <div className="mine-console console-empty">
          <div className="console-top">
            <div className="featured-token">
              <span className="token-orb token-orb-large orb-empty"><IconMine size={20} /></span>
              <div><span>No active mine</span><h2>Nothing launched yet</h2></div>
            </div>
            <span className="active-pill idle"><i /> Empty</span>
          </div>
          <BotMine symbols={[]} fast={false} layer={1} paused />
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
              <div><span>{isMiningActive ? "Now mining" : "Featured mine"}</span><h2>{featured.name}</h2></div>
            </div>
            <span className={"active-pill " + (isMiningActive ? "" : "idle")}>
              <i /> {isMiningActive ? "Crew active" : player ? "Crew paused" : "Not activated"}
            </span>
          </div>
          <BotMine
            symbols={[featured.symbol, ...coinSymbols.filter((symbol) => symbol !== featured.symbol)]}
            fast={isMiningActive}
            layer={Math.max(1, Math.round((100 - reservePercent) / 15))}
          />
          <div className="block-stats">
            <div><span>Next block</span><strong>{featured.networkPower > 0 ? countdown(featured.nextBlockAt, now) : "Awaiting miners"}</strong></div>
            <div><span>Block reward</span><strong>{compact(featured.rewardPerBlock)} <small>${featured.symbol}</small></strong></div>
            <div><span>Network power</span><strong>{compact(featured.networkPower)}</strong></div>
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
            <button className="mine-button" type="button" onClick={() => requestWalletMenu("home_hero")}>
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

/**
 * The hero's mine: four bots, each a different shape and colour, swinging at a seam while the
 * coins they knock loose float up. Decorative only - the tickers are real listed coins, but nothing
 * here reports what any player has mined.
 */
function BotMine({ symbols, fast, layer, paused = false }: { symbols: string[]; fast: boolean; layer: number; paused?: boolean }) {
  const crew = [0, 1, 2, 3];
  const tempo = fast ? 0.7 : 1.05;
  return (
    <div className={"bot-mine" + (paused ? " is-paused" : "")} aria-hidden="true" style={{ "--bot-tempo": tempo + "s" } as CSSProperties}>
      <div className="bot-mine-hud">
        <span>Layer <b>0{layer}</b></span>
        <span>{paused ? "Crew waiting for a mine" : fast ? "Crew digging" : "Crew on standby"}</span>
      </div>
      <div className="bot-mine-ground" />
      <div className="bot-mine-row" style={{ "--crew": crew.length } as CSSProperties}>
        {crew.map((index) => {
          const look = botAt(index);
          const phase = index * 0.23;
          return (
            <div className="bot-slot" key={index}>
              <Bot shape={look.shape} color={look.color} mood={paused ? "idle" : "dig"} phase={phase} tempo={tempo} />
              <span className="bot-rock" style={{ "--rock-vein": BOT_COLORS[(index * 3 + 5) % BOT_COLORS.length] } as CSSProperties} />
              {!paused && symbols.length > 0 && (
                <span className="bot-coin" style={{ "--coin-delay": -(phase + index * tempo) + "s" } as CSSProperties}>
                  ${symbols[index % symbols.length]}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
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
          <h2 id="explore-title">Find your<br />next mine.</h2>
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

/**
 * The plain-language explainer: what the product is, who it is for, and which parts are real
 * on-chain assets versus game progression. Kept short on purpose; docs/FAQ.md has the long form.
 */
export function AboutDiggo() {
  return (
    <section className="about-section page-shell" id="about" aria-labelledby="about-title">
      <div className="about-intro">
        <span className="section-kicker">What is Diggo.fun?</span>
        <h2 id="about-title">A launchpad<br />with a mine under it.</h2>
        <p>Every coin launched here becomes a mine. Your bots dig it daily. What they find is yours.</p>
      </div>
      <div className="bot-parade" aria-hidden="true">
        {Array.from({ length: 8 }, (_, index) => (
          <Bot key={index} {...botAt(index + 2)} size={56} mood={index % 3 === 0 ? "busy" : "idle"} phase={index * 0.45} />
        ))}
      </div>
      <div className="about-audiences">
        <article className="audience-card">
          <h3>Players</h3>
          <ul>
            <li><IconCheck size={14} /> Open a 24-hour shift</li>
            <li><IconCheck size={14} /> Bots dig while you&apos;re away</li>
            <li><IconCheck size={14} /> Claim up to 12 coins at once</li>
          </ul>
          <a className="btn btn-primary" href="/mine">Start mining <IconMine size={18} /></a>
        </article>
        <article className="audience-card is-dark">
          <h3>Creators</h3>
          <ul>
            <li><IconCheck size={14} /> Launch a fixed-supply coin</li>
            <li><IconCheck size={14} /> Trade on Meteora from block one</li>
            <li><IconCheck size={14} /> Players mine it every day</li>
          </ul>
          <a className="btn btn-primary" href="/create">Launch a coin <IconArrowUpRight size={18} /></a>
        </article>
      </div>
      <div className="about-ledger" role="group" aria-label="What is real and what is game">
        <div className="ledger-col">
          <span className="ledger-tag is-real">Real</span>
          <p>Memecoins you claim are SPL tokens in your wallet.</p>
        </div>
        <div className="ledger-col">
          <span className="ledger-tag is-game">Game only</span>
          <p>ORE and Mining Power are earned by playing. Never sold, never withdrawn.</p>
        </div>
        <p className="ledger-note">
          <IconWarning size={15} /> Memecoins can go to zero. Rewards aren&apos;t guaranteed.
        </p>
      </div>
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
    <section className="how-section" id="how">
      <div className="page-shell">
        <div className="section-heading light">
          <div>
            <span className="section-kicker">How it works</span>
            <h2>About a minute a day.</h2>
          </div>
        </div>
        <ol className="steps">
          {MINING_DAY.map((step, index) => (
            <li key={step.title}>
              <b>{String(index + 1).padStart(2, "0")}</b>
              <span className="step-bot">
                <Bot {...botAt(index + 4)} size={58} mood={index === 1 ? "dig" : index === 3 ? "busy" : "idle"} phase={index * 0.6} />
                <span className="step-icon">{step.icon}</span>
              </span>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

const HOME_FAQ: { q: string; a: string }[] = [
  { q: "Does it cost anything to play?", a: "No. You only need a little SOL for network fees." },
  { q: "What do I get when I claim?", a: "Real SPL memecoins, sent to the wallet that signs the claim." },
  { q: "Why is some of my reward pending?", a: "Coins still on their bonding curve pay out once they graduate." },
  { q: "Are ORE and Mining Power tokens?", a: "No. They're game progress: you can't buy, sell or withdraw them." },
  { q: "Who holds my coins?", a: "You do. Every payout is a transaction your own wallet signs." },
  { q: "What does a launch cost?", a: "Network costs, plus an optional first buy. Creator trading fee is 0%." },
];

export function HomeFaq() {
  return (
    <section className="home-faq page-shell" id="faq" aria-labelledby="faq-title">
      <div className="home-faq-intro">
        <span className="section-kicker">FAQ</span>
        <h2 id="faq-title">Quick answers.</h2>
        <p>
          More in the <a href="/terms">Terms</a> and <a href="/risk">Risk notice</a>, or ask us
          on <a href="https://x.com/Diggo_Fun" target="_blank" rel="noopener noreferrer">X</a>.
        </p>
      </div>
      <div className="faq-list">
        {HOME_FAQ.map((item) => (
          <details key={item.q} className="faq-item">
            <summary>{item.q}<IconChevronDown size={18} /></summary>
            <p>{item.a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

export function FinalCta({ onLaunch }: { onLaunch(): void }) {
  return (
    <section className="final-cta">
      <div className="page-shell">
        <span className="huge-pick final-cta-crew" aria-hidden="true">
          <Bot shape="pill" color="#ff6a00" size={64} mood="dig" phase={0.2} />
          <Bot shape="cloud" color="#06b6d4" size={52} mood="busy" phase={0.7} />
          <Bot shape="triangle" color="#ec4899" size={46} mood="attention" phase={1.1} />
        </span>
        <div>
          <h2>Mine or launch.</h2>
          <p className="final-cta-sub">Both end up in the same mine.</p>
        </div>
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
        <a className="site-footer-x" href="https://x.com/Diggo_Fun" target="_blank" rel="noopener noreferrer" aria-label="Diggo on X" onClick={() => track("x_link_clicked", { location: "footer" })}>
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
