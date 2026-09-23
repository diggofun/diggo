/**
 * Marketing and market sections: the home hero with its live mine console, the ticker, the
 * explore board, the selected-mine summary, the core-loop explainer and the footer.
 *
 * Numbers here are the Worker's token summaries as-is. Nothing in this file estimates a reward:
 * the only estimate in the product is the server's, shown in the mine info panel with its label.
 */
import { useMemo, useState } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  Check,
  ChevronRight,
  Clock3,
  Coins,
  Copy,
  Flame,
  Gauge,
  Gem,
  Hammer,
  HardHat,
  LockKeyhole,
  Pickaxe,
  Plus,
  Radio,
  ShieldCheck,
  TrendingUp,
  Users,
} from "lucide-react";
import type { PlayerProfile, TokenSummary } from "../../shared/types";
import { GAMEPLAY_DEFAULTS } from "../../shared/economics";
import { compact, countdown, money, shortAddress } from "../format";
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
  onClaimRewards(): void;
}) {
  const isMiningActive = player?.activationState === "ACTIVE";
  const reservePercent = featured ? (featured.reserveRemaining / featured.reserveTotal) * 100 : 0;
  return (
    <section className="hero page-shell" id="home">
      <div className="hero-copy">
        <div className="eyebrow">
          <span className={"live-dot " + (featured ? "" : "idle-dot")} />
          {featured ? "Live on Solana devnet" : "Solana devnet · no mines launched yet"}
        </div>
        <h1>
          BUILD YOUR
          <br />
          MEMECOIN <span>MINING CREW.</span>
        </h1>
        <p>
          Pick a mine, activate your crew once a day and let it dig while you are away. Upgrade
          Miners, Drills and Carts with the ORE they bring back, and turn up rare discoveries.
        </p>
        <div className="hero-actions">
          <a className="btn btn-primary btn-lg" href="/mine">
            Start mining <Pickaxe size={18} />
          </a>
          <a className="btn btn-link" href="/explore">
            Explore mines <ArrowUpRight size={17} />
          </a>
        </div>
        <div className="trust-row">
          <span><ShieldCheck size={15} /> Mint revoked</span>
          <span><LockKeyhole size={15} /> Reserve locked</span>
          <span><Coins size={15} /> Funds stay in your wallet</span>
        </div>
      </div>

      {!featured ? (
        <div className="mine-console console-empty">
          <div className="console-top">
            <div className="featured-token">
              <span className="token-orb token-orb-large orb-empty"><Pickaxe size={20} /></span>
              <div><span>NO ACTIVE MINE</span><h2>Nothing launched yet</h2></div>
            </div>
            <span className="active-pill idle"><i /> EMPTY</span>
          </div>
          <div className="empty-body">
            <p>
              No token has been launched on this protocol yet, so there is nothing to mine. Block
              rewards, network power and prices will appear here once a real coin is launched on devnet.
            </p>
            <button className="btn btn-primary" onClick={onLaunch}>
              Launch the first coin <Plus size={17} />
            </button>
          </div>
        </div>
      ) : (
        <div className={"mine-console " + (isMiningActive ? "is-mining" : "")} id="mine">
          <div className="console-top">
            <div className="featured-token">
              <TokenOrb symbol={featured.symbol} imageUrl={featured.imageUrl} large />
              <div><span>{isMiningActive ? "NOW MINING" : "SELECTED MINE"}</span><h2>{featured.name}</h2></div>
            </div>
            <span className={"active-pill " + (isMiningActive ? "" : "idle")}>
              <i /> {isMiningActive ? "CREW ACTIVE" : player ? "CREW PAUSED" : "NOT ACTIVATED"}
            </span>
          </div>
          <div className="mine-scene" aria-hidden="true">
            <div className="grid-lines" />
            <div className="ore ore-one" /><div className="ore ore-two" /><div className="ore ore-three" />
            <div className="pickaxe-wrap"><Pickaxe size={82} strokeWidth={1.25} /></div>
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
              <span><Flame size={13} /> {player.streak} day streak</span>
              <span><Gem size={13} /> {Math.floor(player.oreBalance).toLocaleString()} ORE</span>
              <span><Gauge size={13} /> {player.power.toLocaleString()} power</span>
              {isMiningActive && (
                <span><Clock3 size={13} /> resets in {countdown(Math.floor(player.activationExpiresAt ?? 0), now)}</span>
              )}
              {connected && (
                <button type="button" className="claim-rewards-button" onClick={onClaimRewards}>
                  <Coins size={12} /> Claim on-chain rewards
                </button>
              )}
            </div>
          )}
          {error && <p className="form-message console-error" role="alert">{error}</p>}
          {!connected ? (
            <button className="mine-button" type="button" onClick={requestWalletMenu}>
              <Pickaxe size={18} /> Connect wallet to mine
            </button>
          ) : isMiningActive ? (
            <button className="mine-button" onClick={onManageCrew}>
              <Hammer size={18} /> Manage crew
            </button>
          ) : (
            <button className="mine-button" disabled={activating} onClick={onActivate}>
              {activating ? <><Radio size={18} /> Activating…</> : <><Pickaxe size={18} /> Activate mine ({GAMEPLAY_DEFAULTS.activationSeconds / 3_600}h)</>}
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
            <i className={token.change24h >= 0 ? "up" : "down"}>{token.change24h >= 0 ? "+" : ""}{token.change24h}%</i>
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
  return list.sort((a, b) => b.change24h - a.change24h);
}

export function ExploreBoard({ tokens, limit, onLaunch }: { tokens: TokenSummary[]; limit?: number; onLaunch(): void }) {
  const [mode, setMode] = useState<SortMode>("trending");
  const sorted = useMemo(() => sortTokens(tokens, mode), [tokens, mode]);
  const shown = limit ? sorted.slice(0, limit) : sorted;
  return (
    <section className="discover page-shell" id="explore" aria-labelledby="explore-title">
      <div className="section-heading">
        <div>
          <div className="eyebrow"><TrendingUp size={14} /> Mine board</div>
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
              View all {tokens.length} mines <ChevronRight size={16} />
            </a>
          )}
        </>
      ) : (
        <EmptyState
          title="No mines to explore yet"
          action={<button className="btn btn-primary" onClick={onLaunch}>Launch a coin <Plus size={17} /></button>}
        >
          Every coin launched through the protocol shows up here with its live price, unmined reserve
          and network power — straight from the chain, never seeded.
        </EmptyState>
      )}
    </section>
  );
}

function TokenCard({ token }: { token: TokenSummary }) {
  const reservePercent = token.reserveTotal > 0 ? Math.round((token.reserveRemaining / token.reserveTotal) * 100) : 0;
  const up = token.change24h >= 0;
  return (
    <a className="token-card" href={"/mines?mint=" + encodeURIComponent(token.mint)} aria-label={"Open the " + token.name + " mine"}>
      <div className="token-card-head">
        <TokenOrb symbol={token.symbol} imageUrl={token.imageUrl} />
        <div className="token-title">
          <h3>{token.name}</h3>
          <span>${token.symbol}</span>
        </div>
        <span className={"change " + (up ? "positive" : "negative")}>
          {up ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}
          <span className="sr-only">{up ? "up" : "down"}</span>
          {Math.abs(token.change24h)}%
        </span>
      </div>
      <div className="card-price">
        <strong>{money(token.priceUsd)}</strong>
        <span>{compact(token.marketCapUsd)} mcap</span>
      </div>
      <div className="reserve-row">
        <span><Pickaxe size={13} /> unmined reserve</span>
        <strong>{reservePercent}%</strong>
      </div>
      <div className="progress" aria-hidden="true"><i style={{ width: reservePercent + "%" }} /></div>
      <div className="card-foot">
        <span><Gauge size={13} /> {compact(token.networkPower)} power</span>
        <span className="card-cta" aria-hidden="true">Mine <ChevronRight size={14} /></span>
      </div>
    </a>
  );
}

export function SelectedMine({
  token,
  now,
  canSwitch,
  onSwitch,
}: {
  token: TokenSummary;
  now: number;
  canSwitch: boolean;
  onSwitch(): void;
}) {
  const [copied, setCopied] = useState(false);
  const reservePercent = token.reserveTotal > 0 ? (token.reserveRemaining / token.reserveTotal) * 100 : 0;
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
          <span className="mono-label">SELECTED MINE // ${token.symbol}</span>
          <h1 className="selected-title">{token.name}</h1>
        </div>
        <div className="selected-heading-actions">
          {canSwitch && (
            <button className="btn btn-ghost btn-sm switch-mine-button" onClick={onSwitch}>
              Switch crew here <Pickaxe size={14} />
            </button>
          )}
          <a className="btn btn-ghost btn-sm" href={"/trade?mint=" + encodeURIComponent(token.mint)}>
            Trade ${token.symbol} <TrendingUp size={14} />
          </a>
          <button className="mint-address" onClick={copyMint} aria-label={"Copy mint address " + token.mint}>
            {shortAddress(token.mint)} {copied ? <Check size={14} /> : <Copy size={14} />}
            <span className="sr-only" aria-live="polite">{copied ? "Copied" : ""}</span>
          </button>
        </div>
      </div>
      <div className="selected-grid">
        <div className="reserve-panel">
          <div className="reserve-number"><span>UNMINED SUPPLY</span><strong>{reservePercent.toFixed(1)}%</strong><small>{compact(token.reserveRemaining)} ${token.symbol} remain</small></div>
          <div className="shaft" aria-hidden="true"><i style={{ height: reservePercent + "%" }}><Pickaxe size={28} /></i></div>
        </div>
        <div className="metric-panel"><Gauge /><span>Network power</span><strong>{compact(token.networkPower)}</strong><small>total crew power on this mine</small></div>
        <div className="metric-panel"><Clock3 /><span>Next reduction</span><strong>{countdown(token.nextEpochAt, now)}</strong><small>block reward steps down each epoch</small></div>
        <div className="metric-panel"><Users /><span>Custody</span><strong>NON-CUSTODIAL</strong><small>only the LP is program-controlled</small></div>
      </div>
    </section>
  );
}

export function HowItWorks() {
  return (
    <section className="how-section" id="how">
      <div className="page-shell">
        <div className="section-heading light">
          <div>
            <div className="eyebrow"><HardHat size={14} /> The core loop</div>
            <h2>ACTIVATE. DIG.<br />UPGRADE.</h2>
          </div>
          <p>No magic yield. Each mine has a finite, transparent reserve shared by crew Mining Power, and your crew only grows by playing.</p>
        </div>
        <div className="steps">
          <article><b>01</b><span className="step-icon"><Pickaxe /></span><h3>Activate your crew</h3><p>One signature opens a 24h shift. Your crew keeps digging while you are offline.</p></article>
          <article><b>02</b><span className="step-icon"><Gem /></span><h3>Collect the report</h3><p>Come back to ORE for upgrades, settled block rewards and the occasional discovery.</p></article>
          <article><b>03</b><span className="step-icon"><Hammer /></span><h3>Grow the operation</h3><p>Spend ORE on Miners, Drills, Carts, Foreman and Storage. The mine grows with your tier.</p></article>
        </div>
      </div>
    </section>
  );
}

export function FinalCta({ onLaunch }: { onLaunch(): void }) {
  return (
    <section className="final-cta">
      <div className="page-shell">
        <span className="huge-pick" aria-hidden="true"><Pickaxe /></span>
        <div><span>THE NEXT MEME IS UNDERGROUND.</span><h2>START DIGGING.</h2></div>
        <button className="btn btn-dark btn-lg" onClick={onLaunch}>Launch your coin <ArrowUpRight size={18} /></button>
      </div>
    </section>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer page-shell">
      <BrandMark />
      <p>Finite supply. Infinite memes.</p>
      <div><a href="/mines">Mines</a><a href="/leaderboards">Leaderboards</a><a href="/create">Launch</a></div>
      <nav className="site-footer-legal" aria-label="Legal">
        {LEGAL_ROUTES.map((route) => (
          <a key={route.id} href={route.path}>
            {route.short}
          </a>
        ))}
      </nav>
      <small>© 2026 Diggo.fun · Devnet MVP</small>
    </footer>
  );
}
