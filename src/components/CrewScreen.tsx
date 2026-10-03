/**
 * Manage Crew (spec 72, 29).
 *
 * Five branches with a distinct strategic role each, priced only in ORE, with the exact power (or
 * efficiency, capacity, discount) change the next level buys. The tier name and the mine behind it
 * grow with the crew, so the screen reads as a tycoon upgrade board rather than a staking form.
 *
 * There is no money, no token payment and no purchase button anywhere on this screen: the only
 * currency in the game's progression loop is ORE, and ORE can never be bought (spec 9, 34).
 */
import type { ReactNode } from "react";
import type { PlayerProfile } from "../../shared/types";
import {
  DIGGO_CONFIG,
  crewPower,
  crewTier,
  offlineHours,
  oreCapacity,
  oreForActiveSeconds,
  upgradeCostMultiplier,
  upgradeOreCost,
  type CrewLevels,
} from "../../shared/economics";
import { CREW_BOTS, CREW_COMPONENTS, CREW_COMPONENT_LABELS, CREW_ROLES } from "../crewLabels";
import { IconArrowUpRight, IconClose, IconHammer, IconOre } from "../icons";
import { Bot } from "./Bot";
import { MineScene } from "./MineScene";
import { useDialog } from "./useDialog";

export interface CrewScreenProps {
  player: PlayerProfile;
  pending: string | null;
  error: string;
  notice: string;
  onUpgrade(component: (typeof CREW_COMPONENTS)[number]): void;
  /** "modal" renders the same board inside a dialog opened from the dashboard. */
  variant?: "page" | "modal";
  onClose?(): void;
}

interface UpgradePreview {
  cost: number | null;
  delta: string;
  also: string | null;
}

function preview(player: PlayerProfile, component: (typeof CREW_COMPONENTS)[number]): UpgradePreview {
  const levels = player.crewLevels;
  const level = levels[component];
  const atMax = level >= DIGGO_CONFIG.crew.maxLevel;
  if (atMax) return { cost: null, delta: "Maximum level", also: null };

  const next: CrewLevels = { ...levels, [component]: level + 1 };
  const cost = upgradeOreCost(component, level, levels.foreman);

  if (component === "miners" || component === "drills") {
    const gain = crewPower(next) - crewPower(levels);
    return { cost, delta: `+${gain.toLocaleString()} Mining Power`, also: `${crewPower(next).toLocaleString()} total` };
  }
  if (component === "carts") {
    const gain = orePerHour(player, next) - orePerHour(player, levels);
    return {
      cost,
      delta: `+${gain.toFixed(1)} ORE per active hour`,
      also: `+${(oreCapacity(next) - oreCapacity(levels)).toLocaleString()} ORE capacity`,
    };
  }
  if (component === "foreman") {
    const before = upgradeCostMultiplier(levels.foreman);
    const after = upgradeCostMultiplier(next.foreman);
    const saved = Math.round((before - after) * 100);
    return {
      cost,
      delta: saved > 0 ? `-${saved}% on every future upgrade` : "Discounted upgrades capped",
      also: `+${(orePerHour(player, next) - orePerHour(player, levels)).toFixed(1)} ORE per active hour`,
    };
  }
  return {
    cost,
    delta: `+${(oreCapacity(next) - oreCapacity(levels)).toLocaleString()} ORE capacity`,
    also: `+${(offlineHours(next) - offlineHours(levels)).toFixed(1)}h offline mining`,
  };
}

function orePerHour(player: PlayerProfile, levels: CrewLevels): number {
  return oreForActiveSeconds(3_600, player.accountAgeSeconds, levels);
}

export function CrewScreen({ player, pending, error, notice, onUpgrade, variant = "page", onClose }: CrewScreenProps) {
  const tier = crewTier(player.crewLevels);
  const totalLevel = CREW_COMPONENTS.reduce((sum, component) => sum + player.crewLevels[component], 0);

  const nextTier = DIGGO_CONFIG.crew.tiers.find((candidate) => candidate.minTotalLevel > totalLevel) ?? null;
  const tierFloor = tier.minTotalLevel;
  const tierProgress = nextTier ? Math.min(1, Math.max(0, (totalLevel - tierFloor) / Math.max(1, nextTier.minTotalLevel - tierFloor))) : 1;

  const board = (
    <>
      <div className="crew-head">
        <div>
          <span className="eyebrow">
            <IconHammer size={14} /> Crew tier {tier.tier} of {DIGGO_CONFIG.crew.tiers.length}
          </span>
          <h2>{tier.name}</h2>
          <p>
            {player.power.toLocaleString()} Mining Power · {Math.floor(player.oreBalance).toLocaleString()} ORE banked
            {nextTier ? ` · ${nextTier.minTotalLevel - totalLevel} levels to ${nextTier.name}` : " · top tier reached"}
          </p>
          <div className="tier-progress">
            <div className="tier-progress-bar" role="progressbar" aria-label="Progress to the next crew tier" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(tierProgress * 100)}>
              <i style={{ width: (tierProgress * 100).toFixed(1) + "%" }} />
            </div>
            <small>
              {nextTier ? (
                <>
                  Level {totalLevel} / {nextTier.minTotalLevel} <IconArrowUpRight size={11} /> {nextTier.name}
                </>
              ) : (
                "Legendary operation — every branch can still level up"
              )}
            </small>
          </div>
        </div>
        <MineScene key={tier.tier} tier={tier.tier} active={player.activationState === "ACTIVE"} />
      </div>

      <div className="crew-board">
        {CREW_COMPONENTS.map((component) => {
          const level = player.crewLevels[component];
          const preview_ = preview(player, component);
          const affordable = preview_.cost !== null && player.oreBalance >= preview_.cost;
          const role = CREW_ROLES[component];
          return (
            <article className={`crew-card${preview_.cost === null ? " is-max" : ""}`} key={component}>
              <header>
                <span className="crew-card-glyph">
                  <Bot {...CREW_BOTS[component]} size={44} mood="idle" />
                </span>
                <div>
                  <strong>{CREW_COMPONENT_LABELS[component]}</strong>
                  <small>{role.deltaLabel}</small>
                </div>
                <b className="crew-card-level" key={level}>LV. {level}</b>
              </header>
              <p className="crew-card-role">{role.role}</p>
              <div className="crew-card-delta">
                <span>{preview_.delta}</span>
                {preview_.also && <small>{preview_.also}</small>}
              </div>
              <button
                className="btn btn-primary btn-block crew-upgrade-button"
                disabled={preview_.cost === null || !affordable || pending === component}
                onClick={() => onUpgrade(component)}
                title={
                  preview_.cost === null
                    ? "Maximum level"
                    : affordable
                      ? "Spend ORE to upgrade"
                      : "Not enough ORE yet"
                }
              >
                {pending === component ? (
                  <>
                    Upgrading…
                  </>
                ) : preview_.cost === null ? (
                  <>
                    Max level
                  </>
                ) : (
                  <>
                    Upgrade <IconOre size={13} /> {preview_.cost.toLocaleString()} ORE
                  </>
                )}
              </button>
            </article>
          );
        })}
      </div>

      {notice && <p className="form-message crew-notice">{notice}</p>}
      {error && <p className="form-message">{error}</p>}
      <p className="crew-note">
        Crew upgrades only ever cost ORE, mined by keeping your crew active. ORE cannot be bought,
        sold, transferred or withdrawn, and no payment can change Mining Power.
      </p>
    </>
  );

  if (variant === "modal") {
    return <CrewModalFrame onClose={onClose}>{board}</CrewModalFrame>;
  }

  return (
    <section className="crew-screen page-shell" id="crew">
      {board}
    </section>
  );
}

function CrewModalFrame({ onClose, children }: { onClose?(): void; children: ReactNode }) {
  const dialogRef = useDialog<HTMLElement>(onClose);
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="crew-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Manage your Mining Crew"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button className="modal-close" onClick={onClose} aria-label="Close">
          <IconClose size={20} />
        </button>
        {children}
      </section>
    </div>
  );
}
