import type { TokenSummary } from "../../shared/types";
import { crewPower, crewTier, upgradeOreCost } from "../../shared/economics";
import { CREW_COMPONENTS, CREW_COMPONENT_LABELS, CREW_ROLES } from "../crewLabels";
import { compact, countdown, oreAmount, tokenAmount } from "../format";
import type { GameCrewComponent, GameState, MeteoraPortfolio } from "../api";
import { IconDiscoveries, IconHammer, IconMine, IconOre, IconProfile, IconStreak, IconSwap, IconTimer } from "../icons";
import { MineScene } from "./MineScene";
import { TokenOrb } from "./TokenOrb";

interface MineProps {
  game: GameState | null;
  mine: TokenSummary | null;
  now: number;
  connected: boolean;
  activating: boolean;
  error: string;
  onActivate(): void;
  onSwitchMine(): void;
}

function validCrew(game: GameState | null): Record<GameCrewComponent, number> {
  return Object.fromEntries(CREW_COMPONENTS.map((component) => {
    const value = game?.crew?.[component];
    return [component, Number.isInteger(value) && (value ?? 0) >= 1 && (value ?? 0) <= 100 ? value! : 1];
  })) as Record<GameCrewComponent, number>;
}

export function MeteoraMineDashboard({ game, mine, now, connected, activating, error, onActivate, onSwitchMine }: MineProps) {
  const active = game?.activation.active ?? false;
  const crew = validCrew(game);
  const tier = game ? crewTier(crew) : null;
  return (
    <section className="meteora-dashboard page-shell" id="mine">
      <div className="section-heading">
        <div><div className="eyebrow"><IconMine size={14} /> Mine dashboard</div><h1>YOUR CREW IS<br /><span>{active ? "ON SHIFT." : "WAITING."}</span></h1></div>
        <button className="btn btn-ghost btn-sm" type="button" onClick={onSwitchMine}><IconSwap size={15} /> Switch mine</button>
      </div>
      <div className={"meteora-status " + (active ? "is-active" : "is-paused")} role="status">
        <div><span className={"badge " + (active ? "badge-active" : "badge-paused")}><i /> {active ? "Active" : "Ready"}</span><strong>{active ? "Crew on shift" : "Start your next shift"}</strong><small>{active ? "Your crew is digging while you are away." : "Activate once a day to keep the streak and ORE flowing."}</small></div>
        <div className="meteora-status-metrics"><span><IconStreak size={13} /> {game?.streak ?? 0} day streak</span><span><IconOre size={13} /> {oreAmount(game?.oreBalance ?? 0)} ORE</span><span><IconTimer size={13} /> {active ? countdown(Math.floor(game?.activation.activeUntil ?? 0), now) + " left" : "Shift paused"}</span></div>
        <button className="btn btn-primary btn-lg" type="button" disabled={!connected || activating} onClick={mine ? onActivate : onSwitchMine}>{activating ? "Activating…" : mine ? <><IconMine size={17} /> Activate shift</> : <><IconSwap size={17} /> Choose a mine</>}</button>
      </div>
      {error && <p className="form-message console-error" role="alert">{error}</p>}
      <div className="meteora-dashboard-grid">
        <div className="meteora-mine-card"><div className="dash-mine-head"><span className="mono-label">ACTIVE MINE</span><span className={"badge " + (active ? "badge-active" : "badge-paused")}>{active ? "WORKING" : "PAUSED"}</span></div><div className="dash-mine-token">{mine ? <TokenOrb symbol={mine.symbol} imageUrl={mine.imageUrl} large /> : <span className="token-orb token-orb-large"><IconMine size={20} /></span>}<div><h3>{mine?.name ?? "No mine selected"}</h3><small>{mine ? `$${mine.symbol}` : "Choose a mine to start"}</small></div></div><MineScene tier={tier?.tier ?? 1} active={active} compact label={tier?.name} /></div>
        <div className="meteora-stat-grid"><article><span>MINING POWER</span><strong>{compact(crewPower(crew))}</strong><small>Crew output</small></article><article><span>STREAK</span><strong>{game?.streak ?? 0}</strong><small>Best: {game?.longestStreak ?? 0} days</small></article><article><span>ORE BALANCE</span><strong>{oreAmount(game?.oreBalance ?? 0)}</strong><small>Earned: {oreAmount(game?.oreEarned ?? 0)}</small></article><article><span>ACTIVE DAYS</span><strong>{game?.activeDays ?? 0}</strong><small>{game?.streakFreezes ?? 0} freezes</small></article></div>
      </div>
    </section>
  );
}

interface CrewProps { game: GameState | null; pending: string | null; error: string; notice: string; onUpgrade(component: GameCrewComponent): void; }

export function MeteoraCrewScreen({ game, pending, error, notice, onUpgrade }: CrewProps) {
  if (!game) return <section className="crew-screen page-shell"><div className="empty-state"><p>Sign in to see your crew.</p></div></section>;
  const crew = validCrew(game);
  const tier = crewTier(crew);
  return <section className="crew-screen page-shell meteora-crew" id="crew"><div className="crew-head"><div><span className="eyebrow"><IconHammer size={14} /> Crew upgrades</span><h2>{tier.name}</h2><p>{compact(crewPower(crew))} Mining Power · {oreAmount(game.oreBalance)} ORE banked</p></div><MineScene tier={tier.tier} active={game.activation.active} label={tier.name} /></div><div className="crew-board">{CREW_COMPONENTS.map((component) => { const level = crew[component]; const cost = upgradeOreCost(component, level, crew.foreman); return <article className="crew-card" key={component}><header><span className="crew-card-glyph">{component.slice(0, 1).toUpperCase()}</span><div><strong>{CREW_COMPONENT_LABELS[component]}</strong><small>{CREW_ROLES[component].deltaLabel}</small></div><b className="crew-card-level">LV. {level}</b></header><p className="crew-card-role">{CREW_ROLES[component].role}</p><button className="btn btn-primary btn-block crew-upgrade-button" disabled={game.oreBalance < cost || pending === component} onClick={() => onUpgrade(component)}>{pending === component ? "Upgrading…" : <>Upgrade <IconOre size={13} /> {cost.toLocaleString()} ORE</>}</button></article>; })}</div>{notice && <p className="form-message crew-notice">{notice}</p>}{error && <p className="form-message" role="alert">{error}</p>}<p className="crew-note">Crew upgrades cost ORE earned from active shifts. ORE cannot be bought or withdrawn.</p></section>;
}

export function MeteoraDiscoveriesScreen({ game, connected, busy, error, notice, onDiscover }: { game: GameState | null; connected: boolean; busy: boolean; error: string; notice: string; onDiscover(): void }) {
  const eligible = game?.discovery.eligible ?? false;
  const portfolioUsd = game?.discovery.portfolioUsd ?? 0;
  const requirements = [
    { met: (game?.activeDays ?? 0) >= 5, label: "5 active mining days" },
    { met: (game?.validActivations ?? 0) >= 5, label: "5 valid shift activations" },
    { met: portfolioUsd >= 10, label: "$10 portfolio value" },
  ];
  return <section className="discoveries page-shell meteora-discoveries" id="discoveries"><div className="section-heading"><div><div className="eyebrow"><IconDiscoveries size={14} /> Discoveries</div><h1>WHAT THE CREW<br /><span>TURNED UP.</span></h1></div><button className="btn btn-primary" type="button" disabled={!connected || !eligible || busy} onClick={onDiscover}>{busy ? "Digging…" : "Run discovery"}</button></div><p className="section-intro">Eligible windows can turn up a rare mine token for your active crew.</p><div className="discovery-requirements" aria-label="Discovery requirements">{requirements.map((requirement) => <span className={requirement.met ? "is-met" : ""} key={requirement.label}>{requirement.met ? "Ready" : "Pending"} · {requirement.label}</span>)}</div>{notice && <p className="form-message discovery-notice" role="status">{notice}</p>}{error && <p className="form-message" role="alert">{error}</p>}<div className="discovery-grid">{game?.claims.filter((claim) => claim.kind === "discovery").map((claim) => <article className="discovery-card" key={claim.id}><header><span className="rarity-tag">{claim.kind.toUpperCase()}</span><em className={"reward-status status-" + claim.status.toLowerCase()}>{claim.status}</em></header><DiscoveryArtPlaceholder /><h4>Discovery token</h4><strong>{tokenAmount(claim.amountWhole)} tokens</strong><small>{claim.mint}</small></article>)}</div>{game && !game.claims.some((claim) => claim.kind === "discovery") && <div className="empty-state"><p>No discoveries yet. Keep the crew active and check back after the next window.</p></div>}</section>;
}

function DiscoveryArtPlaceholder() { return <div className="discovery-card-art" aria-hidden="true"><IconDiscoveries size={44} /></div>; }

export function MeteoraPortfolioScreen({ game, portfolio, tokens, busyMint, onClaim }: { game: GameState | null; portfolio: MeteoraPortfolio | null; tokens: TokenSummary[]; busyMint: string | null; onClaim(mint: string): void }) {
  const mine = game?.activeMine ?? null;
  const token = mine ? tokens.find((candidate) => candidate.mint === mine.coin.mint) ?? null : null;
  const claimable = Number(mine?.balance.claimable ?? portfolio?.claimable ?? 0);
  const threshold = Number(token?.migrationQuoteThreshold ?? 0);
  const quoteReserve = Number(token?.quoteReserve ?? 0);
  const reserve = threshold > 0 && quoteReserve > 0 ? Math.max(0, Math.min(1, quoteReserve / threshold)) : 0;
  const graduated = mine?.coin.graduated ?? portfolio?.graduated ?? false;
  return <section className="portfolio-screen page-shell meteora-portfolio" id="portfolio"><div className="section-heading"><div><div className="eyebrow"><IconProfile size={14} /> Portfolio</div><h1>YOUR MINES.<br /><span>YOUR PAYOUTS.</span></h1></div></div><div className="meteora-portfolio-grid"><article className="meteora-balance-card"><span><IconOre size={15} /> ORE BALANCE</span><strong>{oreAmount(game?.oreBalance ?? 0)}</strong><small>Available for crew upgrades</small></article><article className="meteora-balance-card"><span><IconStreak size={15} /> STREAK</span><strong>{game?.streak ?? 0} days</strong><small>Best {game?.longestStreak ?? 0} days</small></article></div>{mine ? <article className="meteora-claim-card"><div className="dash-mine-token">{token ? <TokenOrb symbol={token.symbol} imageUrl={token.imageUrl} large /> : <span className="token-orb token-orb-large"><IconMine size={20} /></span>}<div><span className="mono-label">{token ? `$${token.symbol}` : "Active mine"}</span><h2>{mine.coin.name}</h2><small>{mine.coin.mint}</small></div></div><div className="meteora-claim-state"><span className={"badge " + (graduated ? "badge-active" : "badge-paused")}>{graduated ? "READY TO CLAIM" : "PENDING UNTIL GRADUATION"}</span><strong>{tokenAmount(claimable)} {token ? `$${token.symbol}` : "tokens"}</strong><small>{graduated ? "Your mined tokens are ready to withdraw." : "Keep buying and trading to push this mine toward graduation."}</small><div className="progress" aria-label="Progress to graduation"><i style={{ width: `${Math.round(reserve * 100)}%` }} /></div><div className="meteora-claim-foot"><span>{Math.round(reserve * 100)}% of graduation target</span><button className="btn btn-primary" type="button" disabled={!graduated || claimable <= 0 || busyMint === mine.coin.mint} onClick={() => onClaim(mine.coin.mint)}>{busyMint === mine.coin.mint ? "Waiting for wallet…" : "Sign & claim"}</button></div></div></article> : <div className="empty-state"><p>Choose a mine to start mining tokens.</p></div>}</section>;
}
