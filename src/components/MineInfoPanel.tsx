/**
 * Mine information (spec 33).
 *
 * The numbers a player needs before committing the crew: the block reward, the mine's total Mining
 * Power, what is left of the reserve, the reduction schedule, and how far the mine is from being
 * fully mined. The share figure always carries the server's own label, and never appears as a
 * return, an ROI or an APY, because a block share moves with every other crew that joins the mine.
 */
import { AlertTriangle, Clock3, Gauge, Layers, Pickaxe, Repeat2, Users } from "lucide-react";
import type { MineInfo, MiningAccounting } from "../../shared/types";
import { compact, countdown, percent, tokenAmount } from "../format";

export interface MineInfoPanelProps {
  mine: MineInfo | null;
  mineName: string | null;
  now: number;
  loading: boolean;
  error: string;
  /** False for a signed-out visitor, who has no share to estimate. */
  canSwitch: boolean;
  switching: boolean;
  onSwitchHere(): void;
}

function accountingNote(accounting: MiningAccounting | undefined): string {
  if (!accounting) return "Accounting source pending.";
  return accounting.authoritative
    ? accounting.label
    : accounting.label + " — indexed estimate, not the on-chain program's own number.";
}

export function MineInfoPanel({
  mine,
  mineName,
  now,
  loading,
  error,
  canSwitch,
  switching,
  onSwitchHere,
}: MineInfoPanelProps) {
  if (!mine) {
    return (
      <section className="mine-info page-shell" id="mine-info">
        {loading ? "Loading mine information…" : error ? <span className="form-message">{error}</span> : null}
      </section>
    );
  }

  const fullyMined = mine.status === "FULLY_MINED" || mine.remainingReserve <= 0;
  const schedule = mine.reductionSchedule ?? [];
  const scheduleMax = Math.max(1, ...schedule);
  const shareLabel = mine.estimatedShare === null ? "—" : percent(mine.estimatedShare);
  const shareDetail =
    mine.estimatedRewardPerBlock === null || mine.estimatedShare === null
      ? "sign in to see what your crew would take from the next block"
      : "about " + tokenAmount(mine.estimatedRewardPerBlock) + " " + mine.symbol + " from the next block";
  const powerDetail =
    mine.playerPower === null
      ? "connect a wallet for your share"
      : compact(mine.playerPower) + " belongs to your crew";

  return (
    <section className="mine-info page-shell" id="mine-info">
      <div className="mine-info-head">
        <div>
          <span className="mono-label">MINE INFO // {mine.symbol}</span>
          <h3>{mineName ?? mine.symbol}</h3>
        </div>
        {fullyMined ? (
          <span className="fully-mined-badge">
            <AlertTriangle size={13} /> FULLY_MINED
          </span>
        ) : (
          <button className="outline-button switch-here" disabled={!canSwitch || switching} onClick={onSwitchHere}>
            {switching ? "Switching…" : "Switch crew to this mine"} <Repeat2 size={14} />
          </button>
        )}
      </div>

      <div className="mine-info-grid">
        <article>
          <span>
            <Pickaxe size={13} /> BLOCK REWARD
          </span>
          <strong>
            {compact(mine.blockReward)} <small>{mine.symbol}</small>
          </strong>
          <small>paid per block to every active crew, split by Mining Power</small>
        </article>
        <article>
          <span>
            <Gauge size={13} /> TOTAL MINING POWER
          </span>
          <strong>{compact(mine.totalMiningPower)}</strong>
          <small>{powerDetail}</small>
        </article>
        <article>
          <span>
            <Layers size={13} /> REMAINING RESERVE
          </span>
          <strong>
            {compact(mine.remainingReserve)} <small>{mine.symbol}</small>
          </strong>
          <small>of {compact(mine.reserveTotal)} allocated to mining</small>
        </article>
        <article>
          <span>
            <Users size={13} /> ESTIMATED SHARE
          </span>
          <strong>{shareLabel}</strong>
          <small>{shareDetail}</small>
          <p className="estimate-label">{mine.estimateLabel}</p>
        </article>
      </div>

      <div className="mine-info-lower">
        <div className="reduction-schedule">
          <div className="mine-info-subhead">
            <span>
              <Clock3 size={13} /> REDUCTION SCHEDULE
            </span>
            <small>
              next reduction in {countdown(mine.epochEndsAt, now)}, epoch {mine.epoch}
            </small>
          </div>
          <div className="reduction-bars">
            {schedule.map((reward, index) => (
              <div className="reduction-bar" key={index} title={compact(reward) + " per block"}>
                <i style={{ height: Math.max(4, Math.round((reward / scheduleMax) * 100)) + "%" }} />
                <span>{index === 0 ? "now" : "+" + index}</span>
              </div>
            ))}
          </div>
          <p>
            Every epoch cuts the block reward. A mine never mints more than its reserve, so emissions
            end when the reserve does.
          </p>
        </div>

        <div className="fully-mined-progress">
          <div className="mine-info-subhead">
            <span>MINED SO FAR</span>
            <small>{percent(mine.fullyMinedProgress)}</small>
          </div>
          <div className="progress-track" role="img" aria-label={"Mine " + percent(mine.fullyMinedProgress) + " mined"}>
            <i style={{ width: percent(mine.fullyMinedProgress) }} />
          </div>
          <p>{accountingNote(mine.accounting)}</p>
        </div>
      </div>
    </section>
  );
}
