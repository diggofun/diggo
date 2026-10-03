import type { TokenSummary } from "../../shared/types";
import { crewPower, crewTier, upgradeOreCost } from "../../shared/economics";
import { CREW_BOTS, CREW_COMPONENTS, CREW_COMPONENT_LABELS, CREW_ROLES } from "../crewLabels";
import { compact, countdown, oreAmount, shortAddress, tokenAmount } from "../format";
import type { GameCrewComponent, GameState, MeteoraPortfolio } from "../api";
import { IconCheck } from "../icons";
import { MineScene } from "./MineScene";
import { Bot, botAt } from "./Bot";
import { useProfileBot } from "../preferences";
import { PushToggle } from "./PushToggle";
import { TokenOrb } from "./TokenOrb";

interface MineProps {
  game: GameState | null;
  mine: TokenSummary | null;
  now: number;
  connected: boolean;
  activating: boolean;
  error: string;
  onActivate(): void;
}

function validCrew(game: GameState | null): Record<GameCrewComponent, number> {
  return Object.fromEntries(CREW_COMPONENTS.map((component) => {
    const value = game?.crew?.[component];
    return [component, Number.isInteger(value) && (value ?? 0) >= 1 && (value ?? 0) <= 100 ? value! : 1];
  })) as Record<GameCrewComponent, number>;
}

/** One number with its label: the only stat block the game screens use. */
function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <article className="stat">
      <span>{label}</span>
      <strong>{value}</strong>
      {note && <small>{note}</small>}
    </article>
  );
}

/** A row of idle bots for the signed-out and empty states. */
function BotRow({ count = 4 }: { count?: number }) {
  return (
    <span className="bot-row" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <Bot key={index} {...botAt(index)} size={52} mood={index === 1 ? "dig" : "idle"} phase={index * 0.5} />
      ))}
    </span>
  );
}

export function MeteoraMineDashboard({ game, mine, now, connected, activating, error, onActivate }: MineProps) {
  const active = game?.activation.active ?? false;
  const crew = validCrew(game);
  const tier = game ? crewTier(crew) : null;
  return (
    <section className="screen page-shell" id="mine">
      <header className="screen-head">
        <h1>Your crew</h1>
        <p>{active ? "On shift. Your bots are digging." : "Resting. Start a shift to send them in."}</p>
      </header>
      <div className="mine-panel">
        <MineScene tier={tier?.tier ?? 1} active={active} />
        <div className="mine-panel-bar" role="status">
          <div className="mine-panel-coin">
            {mine ? <TokenOrb symbol={mine.symbol} imageUrl={mine.imageUrl} /> : null}
            <div>
              <strong>{mine?.name ?? "No mine yet"}</strong>
              <small>{mine ? "$" + mine.symbol + " · assigned for this shift" : "A mine is assigned when your shift starts"}</small>
            </div>
          </div>
          <span className={"pill " + (active ? "is-on" : "is-off")}>
            {active ? countdown(Math.floor(game?.activation.activeUntil ?? 0), now) + " left" : "Shift paused"}
          </span>
          <button className="btn btn-primary btn-lg" type="button" disabled={!connected || activating} onClick={onActivate}>
            {activating ? "Activating…" : "Activate shift"}
          </button>
        </div>
      </div>
      {error && <p className="form-message" role="alert">{error}</p>}
      <div className="stat-row">
        <Stat label="Mining power" value={compact(crewPower(crew))} />
        <Stat label="Streak" value={(game?.streak ?? 0) + " days"} note={"Best " + (game?.longestStreak ?? 0)} />
        <Stat label="ORE" value={oreAmount(game?.oreBalance ?? 0)} note={"Earned " + oreAmount(game?.oreEarned ?? 0)} />
        <Stat label="Active days" value={String(game?.activeDays ?? 0)} note={(game?.streakFreezes ?? 0) + " freezes"} />
      </div>
    </section>
  );
}

interface CrewProps { game: GameState | null; pending: string | null; error: string; notice: string; onUpgrade(component: GameCrewComponent): void; }

interface DiscoveryClaimCounts {
  availableCount?: number;
  claimableCount?: number;
  pendingCount?: number;
  pendingUntilGraduationCount?: number;
}

export interface DiscoveryRewardCounts {
  available: number;
  pending: number;
}

function countOrZero(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

export function discoveryRewardCounts(
  claimAll: (GameState["claimAll"] & DiscoveryClaimCounts) | undefined,
  inferredAvailable: number,
  inferredPending: number,
): DiscoveryRewardCounts {
  if (!claimAll?.supported) return { available: 0, pending: inferredPending };
  return {
    available: countOrZero(claimAll.availableCount) ?? countOrZero(claimAll.claimableCount) ??
      Math.min(countOrZero(claimAll.count) ?? 0, inferredAvailable),
    pending: countOrZero(claimAll.pendingCount) ?? countOrZero(claimAll.pendingUntilGraduationCount) ?? inferredPending,
  };
}

function hasGraduated(tokens: TokenSummary[], mint: string): boolean {
  return tokens.find((token) => token.mint === mint)?.curveMining.onCurve === false;
}

export function MeteoraCrewScreen({ game, pending, error, notice, onUpgrade }: CrewProps) {
  if (!game) {
    return (
      <section className="screen crew-screen page-shell" id="crew">
        <header className="screen-head"><h1>Your crew</h1></header>
        <div className="empty-state"><BotRow /><p>Sign in to see your crew.</p></div>
      </section>
    );
  }
  const crew = validCrew(game);
  const tier = crewTier(crew);
  return (
    <section className="screen crew-screen page-shell" id="crew">
      <header className="screen-head">
        <h1>{tier.name}</h1>
        <p>{compact(crewPower(crew))} Mining Power · {oreAmount(game.oreBalance)} ORE banked</p>
      </header>
      <div className="mine-panel">
        <MineScene tier={tier.tier} active={game.activation.active} />
      </div>
      <div className="crew-grid crew-board">
        {CREW_COMPONENTS.map((component) => {
          const level = crew[component];
          const cost = upgradeOreCost(component, level, crew.foreman);
          return (
            <article className="crew-tile" key={component}>
              <Bot {...CREW_BOTS[component]} size={56} mood="idle" phase={CREW_COMPONENTS.indexOf(component) * 0.7} />
              <h3>{CREW_COMPONENT_LABELS[component]}</h3>
              <span className="pill">Level {level}</span>
              <p>{CREW_ROLES[component].role}</p>
              <button className="btn btn-primary btn-block crew-upgrade-button" disabled={game.oreBalance < cost || pending === component} onClick={() => onUpgrade(component)}>
                {pending === component ? "Upgrading…" : "Upgrade · " + cost.toLocaleString() + " ORE"}
              </button>
            </article>
          );
        })}
      </div>
      {notice && <p className="form-message" role="status">{notice}</p>}
      {error && <p className="form-message" role="alert">{error}</p>}
      <p className="screen-note">Upgrades cost ORE from active shifts. ORE can&apos;t be bought or withdrawn.</p>
    </section>
  );
}

/** One mined coin in the ledger, with its own avatar. */
function FindCard({ token, name, symbol, amount, note, ready }: { token: TokenSummary | undefined; name: string; symbol: string; amount: number; note: string; ready: boolean }) {
  return (
    <article className={"find-card" + (ready ? " is-ready" : "")}>
      <TokenOrb symbol={token?.symbol ?? symbol} imageUrl={token?.imageUrl ?? null} large />
      <div>
        <h3>{name}</h3>
        <strong>{tokenAmount(amount)} ${symbol}</strong>
        <small>{note}</small>
      </div>
    </article>
  );
}

export function MeteoraDiscoveriesScreen({ game, tokens, connected, busy, error, notice, onDiscover, claimAllPending, claimAllError, claimAllNotice, onClaimAll }: { game: GameState | null; tokens: TokenSummary[]; connected: boolean; busy: boolean; error: string; notice: string; onDiscover(): void; claimAllPending: boolean; claimAllError: string; claimAllNotice: string; onClaimAll(): void }) {
  /** Digging is open to everyone; a roll only needs a live shift. */
  const shiftLive = game?.activation.active ?? game?.discovery.eligible ?? false;
  const claim = game?.claim;
  /** Collecting needs wallet age, play days and a funded wallet. An older Worker reports no detail. */
  const canClaim = claim?.met ?? game?.discovery.eligible ?? false;
  const claims = game?.claims.filter((claim) => claim.kind === "discovery" && claim.status === "PENDING") ?? [];
  const balances = game?.balances ?? [];
  const names = new Map(tokens.map((token) => [token.mint, token]));
  const balanceMints = new Set(balances.map((balance) => balance.mint));
  const claimsWithoutBalance = claims.filter((claim) => !balanceMints.has(claim.mint));
  const availableBalances = balances.filter((balance) => hasGraduated(tokens, balance.mint));
  const pendingBalances = balances.filter((balance) => !hasGraduated(tokens, balance.mint));
  const availableClaims = claimsWithoutBalance.filter((claim) => hasGraduated(tokens, claim.mint));
  const pendingClaims = claimsWithoutBalance.filter((claim) => !hasGraduated(tokens, claim.mint));
  const requirements = claim
    ? [
        { met: claim.walletAge, label: "Wallet 7+ days old" },
        { met: claim.activeDays, label: "5 active days" },
        { met: claim.activations, label: "5 shifts" },
        { met: claim.portfolio, label: "$10 in your wallet" },
      ]
    : [];
  const rewardCounts = discoveryRewardCounts(
    game?.claimAll as (GameState["claimAll"] & DiscoveryClaimCounts) | undefined,
    availableBalances.length + availableClaims.length,
    pendingBalances.length + pendingClaims.length,
  );
  const READY_NOTE = "Available to claim from a graduated coin";
  const PENDING_NOTE = "Accrued from a pre-graduation coin · not claimable yet";
  const coins = (count: number) => count + " coin" + (count === 1 ? "" : "s");

  return (
    <section className="screen page-shell" id="discoveries">
      <header className="screen-head screen-head-row">
        <div>
          <h1>Discoveries</h1>
          <p>{shiftLive ? "Coins your bots dug up. Anyone can dig." : "Start a shift to dig for a discovery. Anyone can dig."}</p>
        </div>
        <button className="btn btn-primary" type="button" disabled={!connected || !shiftLive || busy} onClick={onDiscover}>
          {busy ? "Digging…" : "Run this window's discovery"}
        </button>
      </header>
      {notice && <p className="form-message" role="status">{notice}</p>}
      {error && <p className="form-message" role="alert">{error}</p>}
      {claimAllError && <p className="form-message" role="alert">{claimAllError}</p>}
      {claimAllNotice && <p className="form-message" role="status">{claimAllNotice}</p>}

      <div className="ledger-head">
        <div>
          <h2>Ready to claim</h2>
          <span>{coins(rewardCounts.available)}</span>
        </div>
        {rewardCounts.available > 0 ? (
          <button className="btn btn-primary" type="button" disabled={!connected || !canClaim || claimAllPending} onClick={onClaimAll}>{claimAllPending ? "Signing…" : "Claim all"}</button>
        ) : (
          <small>No rewards from graduated coins are available to claim yet.</small>
        )}
      </div>
      {!canClaim && (
        <div className="claim-gate">
          <p>Digging is open to everyone. To collect your coins you need:</p>
          <div className="chip-row" aria-label="Claim requirements">
            {requirements.map((requirement) => (
              <span className={"chip" + (requirement.met ? " is-met" : "")} key={requirement.label}>
                {requirement.met && <IconCheck size={14} />} {requirement.label}
              </span>
            ))}
          </div>
        </div>
      )}
      {rewardCounts.available > 0 && (
        <div className="find-grid">
          {availableBalances.map((balance) => {
            const token = names.get(balance.mint);
            return <FindCard key={balance.mint} token={token} name={balance.name ?? token?.name ?? "Mined memecoin"} symbol={balance.symbol ?? token?.symbol ?? "tokens"} amount={Number(balance.amountWhole)} note={READY_NOTE} ready />;
          })}
          {availableClaims.map((claim) => {
            const token = names.get(claim.mint);
            return <FindCard key={claim.id} token={token} name={claim.name ?? token?.name ?? "Mined memecoin"} symbol={claim.symbol ?? token?.symbol ?? "tokens"} amount={Number(claim.amountWhole)} note={READY_NOTE} ready />;
          })}
        </div>
      )}

      <div className="ledger-head">
        <div>
          <h2>Pending until graduation</h2>
          <span>{coins(rewardCounts.pending)}</span>
        </div>
        <small>Mining does not guarantee that a coin will graduate.</small>
      </div>
      <div className="find-grid">
        {pendingBalances.map((balance) => {
          const token = names.get(balance.mint);
          return <FindCard key={balance.mint} token={token} name={balance.name ?? token?.name ?? "Mined memecoin"} symbol={balance.symbol ?? token?.symbol ?? "tokens"} amount={Number(balance.amountWhole)} note={PENDING_NOTE} ready={false} />;
        })}
        {pendingClaims.map((claim) => {
          const token = names.get(claim.mint);
          return <FindCard key={claim.id} token={token} name={claim.name ?? token?.name ?? "Mined memecoin"} symbol={claim.symbol ?? token?.symbol ?? "tokens"} amount={Number(claim.amountWhole)} note={PENDING_NOTE} ready={false} />;
        })}
      </div>
      {game && balances.length === 0 && claims.length === 0 && (
        <div className="empty-state"><BotRow count={3} /><p>No discoveries yet. An eligible crew gets one random chance each window.</p></div>
      )}
    </section>
  );
}

export function MeteoraPortfolioScreen({ game, portfolio, tokens }: { game: GameState | null; portfolio: MeteoraPortfolio | null; tokens: TokenSummary[] }) {
  const mine = game?.activeMine ?? null;
  const token = mine ? tokens.find((candidate) => candidate.mint === mine.coin.mint) ?? null : null;
  const claimable = Number(mine?.balance.claimable ?? portfolio?.claimable ?? 0);
  const threshold = Number(token?.migrationQuoteThreshold ?? 0);
  const quoteReserve = Number(token?.quoteReserve ?? 0);
  const reserve = threshold > 0 && quoteReserve > 0 ? Math.max(0, Math.min(1, quoteReserve / threshold)) : 0;
  const graduated = mine?.coin.graduated ?? portfolio?.graduated ?? false;
  const wallet = game?.wallet ?? "";
  const { look: profileBot } = useProfileBot(wallet || "guest");
  return (
    <section className="screen page-shell" id="portfolio">
      <header className="screen-head profile-head">
        <Bot {...profileBot} size={72} mood="idle" />
        <div>
          <h1>Your profile</h1>
          <p>{wallet ? shortAddress(wallet) : "Your mines and payouts"}</p>
          <a className="btn btn-ghost btn-sm" href="/settings">Edit your bot</a>
        </div>
      </header>
      <div className="stat-row">
        <article className="stat"><span>ORE</span><strong>{oreAmount(game?.oreBalance ?? 0)}</strong><small>For crew upgrades</small></article>
        <article className="stat"><span>Streak</span><strong>{game?.streak ?? 0} days</strong><small>Best {game?.longestStreak ?? 0}</small></article>
      </div>
      {mine ? (
        <article className="payout-card">
          <div className="mine-panel-coin">
            {token && <TokenOrb symbol={token.symbol} imageUrl={token.imageUrl} large />}
            <div>
              <strong>{mine.coin.name}</strong>
              <small>{graduated ? "Ready to collect" : "Payouts may stay pending until the coin graduates"}</small>
            </div>
          </div>
          <strong className="payout-amount">{tokenAmount(claimable)} {token ? "$" + token.symbol : "tokens"}</strong>
          <div className="progress" aria-label="Progress to graduation"><i style={{ width: Math.round(reserve * 100) + "%" }} /></div>
          <div className="payout-foot">
            <span>{Math.round(reserve * 100)}% of the graduation target</span>
            <a className="btn btn-primary" href="/discoveries">Open Discoveries</a>
          </div>
        </article>
      ) : (
        <div className="empty-state"><BotRow count={3} /><p>Your payouts show up in Discoveries once your crew is assigned a mine.</p></div>
      )}
      <PushToggle />
    </section>
  );
}
