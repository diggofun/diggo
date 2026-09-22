/**
 * The mining dashboard (spec 71-75).
 *
 * Two states, and only two: ACTIVE while the 24h activation window is open, PAUSED once it closes.
 * Everything on the ACTIVE card comes straight from the Worker — Mining Power, the window
 * countdown, the next block, the streak, ORE and the crew summary. The paused card says what the
 * crew is doing (waiting) and offers the one action that changes it.
 */
import { Clock3, Coins, Flame, Gauge, Hammer, Hourglass, Pickaxe, Repeat2, Snowflake, Timer, Users } from "lucide-react";
import type { MineInfo, PlayerProfile, TokenSummary } from "../../shared/types";
import { CREW_COMPONENT_LABELS, CREW_COMPONENTS } from "../crewLabels";
import { compact, countdown, oreAmount } from "../format";
import { GAMEPLAY_DEFAULTS, crewTier } from "../../shared/economics";
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
  const windowSeconds = player?.activationExpiresAt ? Math.max(0, player.activationExpiresAt - Math.floor(now / 1_000)) : 0;
  const graceSeconds = player?.streakGraceUntil ? Math.max(0, player.streakGraceUntil - Math.floor(now / 1_000)) : 0;

  return (
    <section className="dashboard-panel page-shell" id="mine">
      <div className="dashboard-head">
        <div>
          <span className="eyebrow">
            <Pickaxe size={14} /> Mining dashboard
          </span>
          <h2>
            YOUR CREW IS
            <br />
            <span>{active ? "ON SHIFT." : "WAITING."}</span>
          </h2>
        </div>
        <div className={`mining-status${active ? " active" : ""}`}>
          <i /> {connected ? (active ? "Mining live" : "Mine paused") : "Wallet not connected"}
        </div>
      </div>

      {!connected && (
        <div className="mining-connect-panel">
          <Pickaxe size={26} />
          <div>
            <strong>Connect your wallet to wake your crew.</strong>
            <p>Your crew tier, ORE storage, streak and shared block rewards appear here.</p>
          </div>
        </div>
      )}

      {connected && !player && <div className="mining-connect-panel">Loading your crew…</div>}

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
                  <small>{mineSymbol ? `$${mineSymbol}` : "Mine symbol syncing…"}</small>
                </div>
              </div>
              <MineScene tier={tier?.tier ?? 1} active compact />
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
                    ? `${percentOf(player.power, mineInfo.totalMiningPower)} of this mine · ${compact(mineInfo.totalMiningPower)} total`
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
                <small>
                  progress currency · {player.oreOverflow ? `${oreAmount(player.oreOverflow)} overflowed` : "storage clear"}
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
            <button className="primary-button" disabled={collecting} onClick={onCollect}>
              {collecting ? (
                <>
                  <Hourglass size={16} /> Collecting…
                </>
              ) : (
                <>
                  <Coins size={16} /> Collect mining report
                </>
              )}
            </button>
            <button className="outline-button" onClick={onManageCrew}>
              Manage crew <Hammer size={14} />
            </button>
            <button className="outline-button" onClick={onSwitchMine}>
              Switch mine <Repeat2 size={14} />
            </button>
          </div>
          <p className="dash-note">
            {player.activatedAt
              ? `Window opened ${new Date(player.activatedAt * 1_000).toLocaleString()} · ${(windowSeconds / 3_600).toFixed(1)}h left`
              : "Window open."}{" "}
            ORE is a game currency and cannot be bought, sold or transferred.
          </p>
        </>
      )}

      {connected && player && !active && (
        <div className="dash-paused">
          <div className="paused-copy">
            <span className="mono-label">STATUS</span>
            <h3>MINE PAUSED</h3>
            <p className="paused-line">Your crew is waiting.</p>
            <p>
              A paused crew earns nothing: no ORE, no block rewards and no discoveries. Activating
              covers the next {GAMEPLAY_DEFAULTS.activationSeconds / 3_600} hours and your crew keeps working
              while you are offline.
            </p>
            <button className="primary-button paused-activate" disabled={activating} onClick={onActivate}>
              {activating ? (
                <>
                  <Hourglass size={16} /> Activating…
                </>
              ) : (
                <>
                  <Pickaxe size={16} /> ACTIVATE FOR {GAMEPLAY_DEFAULTS.activationSeconds / 3_600}H
                </>
              )}
            </button>
            <div className="paused-streak">
              <div>
                <span>
                  <Flame size={12} /> STREAK
                </span>
                <strong>
                  {player.streak} {player.streak === 1 ? "day" : "days"}
                </strong>
              </div>
              <div>
                <span>
                  <Hourglass size={12} /> STREAK EXPIRES
                </span>
                {player.streak && player.streakGraceUntil ? (
                  <strong className={graceSeconds === 0 ? "expired" : ""}>
                    {graceSeconds === 0 ? "expired" : countdown(player.streakGraceUntil, now)}
                  </strong>
                ) : (
                  <strong className="muted-value">no streak yet</strong>
                )}
              </div>
            </div>
            {player.streakFreezes > 0 && (
              <p className="paused-freezes">
                <Snowflake size={12} /> {player.streakFreezes} streak freeze{player.streakFreezes === 1 ? "" : "s"} will
                cover a missed window.
              </p>
            )}
          </div>
          <div className="paused-visual">
            <MineScene tier={tier?.tier ?? 1} />
            <div className="paused-visual-note">
              <strong>{tier?.name ?? "Backyard Diggers"}</strong>
              <span>{player.power.toLocaleString()} Mining Power on standby</span>
            </div>
          </div>
        </div>
      )}

      {error && <p className="form-message console-error">{error}</p>}
    </section>
  );
}

function percentOf(power: number, total: number): string {
  if (total <= 0) return power > 0 ? "100%" : "0%";
  const share = Math.min(100, (power / total) * 100);
  return `${share < 1 ? share.toFixed(3) : share.toFixed(2)}%`;
}

function crewSummary(player: PlayerProfile): string {
  return CREW_COMPONENTS.map(
    (component) => CREW_COMPONENT_LABELS[component] + " " + player.crewLevels[component],
  ).join(" · ");
}
