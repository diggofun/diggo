/**
 * The Mining Report (spec 29, 28).
 *
 * Everything in it is the server's answer from the activation/collect window: how long the crew
 * worked, the per-token block rewards that settled, the ORE that fit storage, the ORE that had to
 * be reported as overflow, and the discovery the server rolled — including which visual event
 * belongs to it. The UI renders the event; it never picks a rarity, a token or an amount, and
 * there is no client-side randomness anywhere in this file (spec 55).
 */
import { Coins, Compass, Hammer, Repeat2, Sparkles, X } from "lucide-react";
import type { DiscoveryVisualEvent, MiningReport } from "../../shared/types";
import { duration, oreAmount, tokenAmount } from "../format";

export interface MiningReportModalProps {
  report: MiningReport;
  mineSymbol: string | null;
  collecting: boolean;
  collected: boolean;
  error: string;
  onCollect(): void;
  onManageCrew(): void;
  onSwitchMine(): void;
  onClose(): void;
}

/** Slug used for the per-event animation class; the event itself is server-chosen. */
function visualSlug(event: DiscoveryVisualEvent): string {
  return event.toLowerCase().replaceAll(" ", "-");
}

function dollar(symbol: string): string {
  return "$" + symbol;
}

export function MiningReportModal({
  report,
  mineSymbol,
  collecting,
  collected,
  error,
  onCollect,
  onManageCrew,
  onSwitchMine,
  onClose,
}: MiningReportModalProps) {
  const discovery = report.discovery;
  const byRarity = report.discoveries ? Object.entries(report.discoveries.byRarity) : [];
  const rewards = report.blockRewards ?? [];
  const mineLabel = mineSymbol ? dollar(mineSymbol) : "the mine";

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="report-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="report-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button className="modal-close" onClick={onClose} aria-label="Close">
          <X size={20} />
        </button>
        <div className="eyebrow">
          <Sparkles size={14} /> WELCOME BACK
        </div>
        <h2 id="report-title">
          Your crew worked
          <br />
          <span>{duration(report.activeSeconds)}</span>.
        </h2>
        {mineSymbol && <p className="report-mine">Mine: {mineLabel}</p>}

        <div className="report-grid">
          <div>
            <span>ORE MINED</span>
            <strong>+{oreAmount(report.oreGained)}</strong>
          </div>
          <div>
            <span>STREAK</span>
            <strong>
              {report.streak} {report.streak === 1 ? "day" : "days"}
            </strong>
          </div>
        </div>

        {report.oreOverflow ? (
          <p className="report-overflow">
            <strong>{oreAmount(report.oreOverflow)} ORE overflowed</strong> — your Storage was full, so that ore was
            reported instead of stored. Upgrade Storage to keep more of it next window.
          </p>
        ) : (
          <p className="report-overflow ok">All of this window's ORE fit your Storage.</p>
        )}

        <div className="report-rewards">
          <div className="report-section-head">
            <span>BLOCK REWARDS</span>
            <small>settled for this window</small>
          </div>
          {rewards.length > 0 ? (
            <ul>
              {rewards.map((reward) => (
                <li key={reward.mint + "-" + (reward.claimId ?? reward.status)}>
                  <strong>
                    +{tokenAmount(reward.amount)} {dollar(reward.symbol)}
                  </strong>
                  <em className={"reward-status status-" + reward.status.toLowerCase()}>{reward.status}</em>
                </li>
              ))}
            </ul>
          ) : (
            <p className="report-empty">
              No block rewards settled in this window. Blocks pay per Mining Power while your crew is
              active inside the mine.
            </p>
          )}
        </div>

        {discovery ? (
          <div className={"discovery-event event-" + visualSlug(discovery.visualEvent) + " rarity-" + discovery.rarity}>
            <div className="discovery-event-burst" aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
            <div className="discovery-event-copy">
              <span className={"rarity-tag rarity-" + discovery.rarity}>
                {discovery.rarity.toUpperCase()} · {discovery.visualEvent.toUpperCase()}
              </span>
              <strong>
                +{tokenAmount(discovery.tokenAmount)} {dollar(discovery.symbol)}
              </strong>
              <small>
                Your crew hit a {discovery.visualEvent} while digging {mineLabel}. Claim it from Discoveries before it
                expires.
              </small>
            </div>
          </div>
        ) : (
          <p className="report-nodiscovery">
            No discovery this window. An active, eligible crew keeps its chance for the next one.
          </p>
        )}

        {byRarity.length > 0 && (
          <div className="report-rarity-summary">
            <span>This window</span>
            {byRarity.map(([rarity, count]) => (
              <em key={rarity} className={"rarity-tag rarity-" + rarity}>
                {rarity} × {count}
              </em>
            ))}
          </div>
        )}

        {report.milestones && report.milestones.length > 0 && (
          <div className="report-milestones">
            {report.milestones.map((milestone) => (
              <span key={milestone.day}>
                Day {milestone.day} milestone · +{oreAmount(milestone.ore)} ORE
              </span>
            ))}
          </div>
        )}

        {report.usedFreeze && (
          <p className="form-message">A Streak Freeze protected your streak while you were away.</p>
        )}
        {report.accounting && !report.accounting.authoritative && (
          <p className="report-accounting">Accounting source: {report.accounting.label}</p>
        )}
        {error && <p className="form-message">{error}</p>}

        <div className="report-actions">
          <button className="outline-button" onClick={onManageCrew}>
            Manage crew <Hammer size={15} />
          </button>
          <button className="outline-button" onClick={onSwitchMine}>
            Switch mine <Repeat2 size={15} />
          </button>
          <button className="primary-button" disabled={collecting || collected} onClick={onCollect}>
            {collected ? (
              <>
                <Compass size={16} /> Collected
              </>
            ) : collecting ? (
              <>
                <Coins size={16} /> Collecting…
              </>
            ) : (
              <>
                <Coins size={16} /> COLLECT
              </>
            )}
          </button>
        </div>
      </section>
    </div>
  );
}
