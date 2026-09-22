/**
 * The mining dashboard (spec 71-75).
 *
 * Two states, and only two: ACTIVE while the 24h activation window is open, PAUSED once it closes.
 * A status band at the top says which one it is, how long is left and offers the single action
 * that matters now (collect while active, activate while paused). Everything below it comes
 * straight from the Worker — Mining Power, the window countdown, the next block, the streak, ORE
 * and the crew summary. Nothing here computes a reward.
 */
import { useState } from "react";
import { Clock3, Coins, Flame, Gauge, Hammer, Hourglass, Pickaxe, Repeat2, Snowflake, Timer, Users, Wallet } from "lucide-react";
import type { MineInfo, PlayerProfile, TokenSummary } from "../../shared/types";
import { CREW_COMPONENT_LABELS, CREW_COMPONENTS } from "../crewLabels";
import { compact, countdown, oreAmount } from "../format";
import { DIGGO_CONFIG, GAMEPLAY_DEFAULTS, crewTier } from "../../shared/economics";
import { requestWalletMenu } from "../wallet";
import { MineScene } from "./MineScene";
import { TokenOrb } from "./TokenOrb";

export interface DashboardPanelProps {
  player: PlayerProfile | null;
  mine: TokenSummary | null;
  mineInfo: MineInfo | null;
  now: number;
  connected: boolean;
  activating: boolean;
  collecting: boolean;
  error: string;
  onActivate(): void;
  onManageCrew(): void;
  onSwitchMine(): void;
  onCollect(): void;
}

const WINDOW_HOURS = GAMEPLAY_DEFAULTS.activationSeconds / 3_600;
/** How long the "shift started" moment stays on screen after the crew goes ACTIVE. */
const CELEBRATION_MS = 2_600;

export function DashboardPanel({
  player,
  mine,
  mineInfo,
  now,
  connected,
  activating,
  collecting,
  error,
  onActivate,
  onManageCrew,
  onSwitchMine,
  onCollect,
}: DashboardPanelProps) {
  const active = player?.activationState === "ACTIVE";
  const tier = player ? crewTier(player.crewLevels) : null;
  const mineSymbol = mine?.symbol ?? (player?.activeMint ? "—" : null);
  const nowSeconds = Math.floor(now / 1_000);
  const windowSeconds = player?.activationExpiresAt ? Math.max(0, player.activationExpiresAt - nowSeconds) : 0;
  const windowShare = Math.min(1, windowSeconds / GAMEPLAY_DEFAULTS.activationSeconds);
  const graceSeconds = player?.streakGraceUntil ? Math.max(0, player.streakGraceUntil - nowSeconds) : 0;

  // The activation moment: when the crew flips from paused to active, play a short celebration.
  // Adjusting state during render on a prop change is the React-recommended pattern here.
  const [previousActive, setPreviousActive] = useState(active);
  const [celebrateUntil, setCelebrateUntil] = useState(0);
  if (active !== previousActive) {
    setPreviousActive(active);
    if (active) setCelebrateUntil(now + CELEBRATION_MS);
  }
  const celebrating = active && now < celebrateUntil;

  return (
    <section className={"dashboard-panel page-shell" + (celebrating ? " is-celebrating" : "")} id="mine" aria-labelledby="dashboard-title">
      <div className="dashboard-head">
        <div>
          <span className="eyebrow">
            <Pickaxe size={14} /> Mining dashboard
          </span>
          <h1 id="dashboard-title">
            YOUR CREW IS
            <br />
            <span>{active ? "ON SHIFT." : "WAITING."}</span>
          </h1>
        </div>
      </div>

      {!connected && <GuestDashboard />}

      {connected && !player && (
        <div className="dash-loading" aria-busy="true">
          <span className="skeleton" />
          <span className="skeleton" />
          <p className="sr-only">Loading your crew…</p>
        </div>
      )}

      {connected && player && (
        <div className={"dash-status " + (active ? "is-active" : "is-paused")} role="status" aria-live="polite">
          <div className="dash-status-state">
            <span className={"badge " + (active ? "badge-active" : "badge-paused")}>
              <i /> {active ? "Active" : player.activationState === "NEVER_ACTIVATED" ? "Ready" : "Paused"}
            </span>
            <strong>{active ? "Crew on shift" : player.activationState === "NEVER_ACTIVATED" ? "Start your first shift" : "Mine paused"}</strong>
            <small>{active ? "Digging while you are away." : "A paused crew earns nothing until you activate."}</small>
          </div>

          {active ? (
            <div className="dash-status-timer">
              <span><Timer size={12} /> Shift ends in</span>
              <strong className="dash-countdown">{countdown(Math.floor(player.activationExpiresAt ?? 0), now)}</strong>
              <div className="shift-bar" aria-hidden="true"><i style={{ width: (windowShare * 100).toFixed(2) + "%" }} /></div>
            </div>
          ) : (
            <div className="dash-status-timer">
              <span><Hourglass size={12} /> Streak expires in</span>
              {player.streak && player.streakGraceUntil ? (
                <strong className={"dash-countdown" + (graceSeconds === 0 ? " expired" : "")}>
                  {graceSeconds === 0 ? "expired" : countdown(player.streakGraceUntil, now)}
                </strong>
              ) : (
                <strong className="dash-countdown muted-value">no streak yet</strong>
              )}
              <small><Flame size={11} /> {player.streak} day streak · <Snowflake size={11} /> {player.streakFreezes} freeze{player.streakFreezes === 1 ? "" : "s"}</small>
            </div>
          )}

          {active ? (
            <button className="btn btn-primary btn-lg dash-cta" disabled={collecting} onClick={onCollect}>
              {collecting ? <><Hourglass size={18} /> Collecting…</> : <><Coins size={18} /> Collect report</>}
            </button>
          ) : (
            <button className="btn btn-primary btn-lg dash-cta dash-cta-activate" disabled={activating} onClick={onActivate}>
              {activating ? <><Hourglass size={18} /> Activating…</> : <><Pickaxe size={18} /> Activate for {WINDOW_HOURS}h</>}
            </button>
          )}
          {celebrating && (
            <div className="shift-stamp" aria-hidden="true">
              <span>SHIFT STARTED</span>
            </div>
          )}
        </div>
      )}

      {error && <p className="form-message console-error" role="alert">{error}</p>}

      {connected && player && active && (
        <>
          <div className="dash-active">
            <div className="dash-mine">
              <div className="dash-mine-head">
                <span className="mono-label">NOW MINING</span>
                <span className="active-pill">
                  <i /> CREW ACTIVE
                </span>
              </div>
              <div className="dash-mine-token">
                {mine ? (
                  <TokenOrb symbol={mine.symbol} imageUrl={mine.imageUrl} large />
                ) : (
                  <span className="token-orb token-orb-large orb-empty">
                    <Pickaxe size={20} />
                  </span>
                )}
                <div>
                  <h3>{mine?.name ?? "Assigned mine"}</h3>
                  <small>{mineSymbol ? "$" + mineSymbol : "Mine symbol syncing…"}</small>
                </div>
              </div>
              <MineScene tier={tier?.tier ?? 1} active compact label={tier?.name} />
              <div className="dash-counters">
                <div>
                  <span>
                    <Timer size={12} /> TIME REMAINING
                  </span>
                  <strong>{countdown(Math.floor(player.activationExpiresAt ?? 0), now)}</strong>
                </div>
                <div>
                  <span>
                    <Clock3 size={12} /> NEXT BLOCK
                  </span>
                  <strong>{mineInfo ? countdown(mineInfo.nextBlockAt, now) : "—"}</strong>
                </div>
              </div>
            </div>

            <div className="dash-stats">
              <article>
                <span>
                  <Gauge size={13} /> MINING POWER
                </span>
                <strong>{player.power.toLocaleString()}</strong>
                <small>
                  {mineInfo
                    ? percentOf(player.power, mineInfo.totalMiningPower) + " of this mine · " + compact(mineInfo.totalMiningPower) + " total"
                    : "share loads with the mine"}
                </small>
              </article>
              <article>
                <span>
                  <Flame size={13} /> STREAK
                </span>
                <strong>
                  {player.streak} {player.streak === 1 ? "day" : "days"}
                </strong>
                <small>
                  <Snowflake size={11} /> {player.streakFreezes} freeze{player.streakFreezes === 1 ? "" : "s"} banked
                </small>
              </article>
              <article>
                <span>
                  <Coins size={13} /> ORE
                </span>
                <strong>
                  {oreAmount(player.oreBalance)} <small>/ {oreAmount(player.oreCapacity)}</small>
                </strong>
                <div className="ore-meter" aria-hidden="true">
                  <i style={{ width: Math.min(100, (player.oreBalance / Math.max(1, player.oreCapacity)) * 100) + "%" }} />
                </div>
                <small>
                  progress currency · {player.oreOverflow ? oreAmount(player.oreOverflow) + " overflowed" : "storage clear"}
                </small>
              </article>
              <article>
                <span>
                  <Users size={13} /> CREW
                </span>
                <strong>{tier?.name ?? "Backyard Diggers"}</strong>
                <small>{crewSummary(player)}</small>
              </article>
            </div>
          </div>

          <div className="dash-actions">
            <button className="btn btn-ghost" onClick={onManageCrew}>
              Manage crew <Hammer size={14} />
            </button>
            <button className="btn btn-ghost" onClick={onSwitchMine}>
              Switch mine <Repeat2 size={14} />
            </button>
          </div>
          <p className="dash-note">
            {player.activatedAt
              ? "Window opened " + new Date(player.activatedAt * 1_000).toLocaleString() + " · " + (windowSeconds / 3_600).toFixed(1) + "h left."
              : "Window open."}{" "}
            ORE is a game currency and cannot be bought, sold or transferred.
          </p>
        </>
      )}

      {connected && player && !active && (
        <div className="dash-paused">
          <div className="paused-copy">
            <span className="mono-label">WHILE PAUSED</span>
            <h3>No ORE, no rewards, no discoveries.</h3>
            <p>
              Activating covers the next {WINDOW_HOURS} hours and your crew keeps working while you
              are offline. Come back to collect a mining report.
            </p>
            {player.streakFreezes > 0 && (
              <p className="paused-freezes">
                <Snowflake size={12} /> {player.streakFreezes} streak freeze{player.streakFreezes === 1 ? "" : "s"} will
                cover a missed window.
              </p>
            )}
            <div className="dash-actions dash-actions-inline">
              <button className="btn btn-ghost btn-sm" onClick={onManageCrew}>
                Manage crew <Hammer size={14} />
              </button>
              <button className="btn btn-ghost btn-sm" onClick={onSwitchMine}>
                Switch mine <Repeat2 size={14} />
              </button>
            </div>
          </div>
          <div className="paused-visual">
            <MineScene tier={tier?.tier ?? 1} label={tier?.name} />
            <div className="paused-visual-note">
              <strong>{tier?.name ?? "Backyard Diggers"}</strong>
              <span>{player.power.toLocaleString()} Mining Power on standby</span>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/** What a visitor sees before connecting: their future mine and how it grows. */
function GuestDashboard() {
  const tiers = DIGGO_CONFIG.crew.tiers;
  return (
    <div className="dash-guest">
      <div className="dash-guest-copy">
        <span className="badge badge-idle"><i /> Not connected</span>
        <h2>Wake up your crew.</h2>
        <p>
          Connect a wallet to see your crew tier, ORE storage, streak and the block rewards your crew
          has settled. Mining Power is earned only by playing.
        </p>
        <button className="btn btn-primary btn-lg" onClick={requestWalletMenu}>
          <Wallet size={18} /> Connect wallet
        </button>
      </div>
      <div className="dash-guest-visual">
        <MineScene tier={1} label={tiers[0]?.name} />
        <ol className="tier-ladder" aria-label="Crew tiers">
          {tiers.map((tier) => (
            <li key={tier.tier}>
              <b>{tier.tier}</b>
              <span>{tier.name}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function percentOf(power: number, total: number): string {
  if (total <= 0) return power > 0 ? "100%" : "0%";
  const share = Math.min(100, (power / total) * 100);
  return (share < 1 ? share.toFixed(3) : share.toFixed(2)) + "%";
}

function crewSummary(player: PlayerProfile): string {
  return CREW_COMPONENTS.map(
    (component) => CREW_COMPONENT_LABELS[component] + " " + player.crewLevels[component],
  ).join(" · ");
}
