/**
 * Mine information (spec 33).
 *
 * The numbers a player needs before committing the crew: the block reward, the mine's total Mining
 * Power, what is left of the reserve, the reduction schedule, and how far the mine is from being
 * fully mined. The share figure always carries the server's own label, and never appears as a
 * return, an ROI or an APY, because a block share moves with every other crew that joins the mine.
 *
 * Built from the shared design-system primitives (.card, .stat, .badge, .btn, .error-state) so it
 * reads as the same product as the dashboard and the crew board.
 *
 * A mine still on its bonding curve is paid out of that curve's own launch cap rather than the
 * Mining Reserve, so the budget tile, the schedule preview and the progress bar all report the
 * budget that is actually paying blocks, and the emission source badge says which side that is
 * (see emissionSource and curveMining on MineInfo).
 */
import { IconLayers, IconMine, IconTimer } from "../icons";
import type { MineInfo, MiningAccounting } from "../../shared/types";
import { compact, countdown, percent, tokenAmount } from "../format";
import { curveCapSpent, describeMineStatus, runwayLabel } from "../mineView";

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
        {loading ? (
          <div className="mine-info-loading" aria-busy="true">
            <span className="skeleton" />
            <span className="sr-only">Loading mine information…</span>
          </div>
        ) : error ? (
          <div className="error-state" role="alert">
            <strong>Mine unavailable</strong>
            <div>
              <strong>Mine information is unavailable</strong>
              <p>{error}</p>
            </div>
          </div>
        ) : null}
      </section>
    );
  }

  const curve = mine.curveMining;
  /** True while the curve's launch cap is the budget paying this mine's blocks. */
  const onCurve = mine.emissionSource === "CURVE";
  /** A mine launched with no curve share has no curve budget to show, even pre-graduation. */
  const hasCurveBudget = onCurve && curve.cap > 0;
  /**
   * Two ends of a mine look alike in the numbers and mean different things. A reserve that is gone is
   * a fully mined mine. A curve cap that is gone is a mine waiting for graduation: the Mining Reserve
   * behind it is untouched and starts paying the moment the market graduates. Only the first is over,
   * so the status label, the note under the header and the switch button all follow that split.
   */
  const capSpent = curveCapSpent(curve);
  const reserveSpent = !onCurve && mine.remainingReserve <= 0;
  const statusView = describeMineStatus(mine.status, { curveCapSpent: capSpent, reserveSpent });
  /** True when the mine cannot pay another block, whatever its status column still reads. */
  const paused = statusView.tone === "danger" || statusView.tone === "paused";
  /**
   * The bar shows the budget that is really paying blocks. While that is the curve's cap it is the
   * cap's own mined / cap progress, the number the API reports for exactly this; after graduation
   * it is the reserve the mine has spent.
   */
  const budgetProgress = hasCurveBudget ? curve.progress : mine.fullyMinedProgress;
  const curveDaysLeft = hasCurveBudget ? mine.curveMiningDaysRemaining : null;
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
        <div className="mine-info-flags">
          <span className={"badge " + (onCurve ? "badge-curve" : "badge-reserve")}>
            <i aria-hidden="true" />
            {onCurve ? "Curve emission" : "Reserve emission"}
            <span className="sr-only">
              {onCurve
                ? " — blocks are paid out of the bonding curve's own token inventory"
                : " — blocks are paid out of the Mining Reserve"}
            </span>
          </span>
          {paused ? (
            <span className={"badge badge-" + statusView.tone}>
              {statusView.badge}
            </span>
          ) : !statusView.known ? (
            /* A status this build has no label for is still shown, in its own words: a new state from
               the API should surface rather than silently disappear. */
            <span className={"badge badge-" + statusView.tone}>{statusView.badge}</span>
          ) : (
            <button
              className="btn btn-ghost btn-sm switch-here"
              disabled={!canSwitch || switching}
              onClick={onSwitchHere}
            >
              {switching ? "Switching…" : "Switch crew to this mine"}
            </button>
          )}
        </div>
      </div>

      {paused && <p className={"mine-status-note is-" + statusView.tone}>{statusView.detail}</p>}

      <div className="mine-info-grid">
        <article className="card stat">
          <span>
            <IconMine size={13} aria-hidden="true" /> BLOCK REWARD
          </span>
          <strong>
            {compact(mine.blockReward)} <small>{mine.symbol}</small>
          </strong>
          <small>paid per block to every active crew, split by Mining Power</small>
        </article>
        <article className="card stat">
          <span>
            <strong>TOTAL MINING POWER</strong>
          </span>
          <strong>{compact(mine.totalMiningPower)}</strong>
          <small>{powerDetail}</small>
        </article>
        <article className="card stat">
          <span>
            <IconLayers size={13} aria-hidden="true" /> {hasCurveBudget ? "CURVE MINING BUDGET" : "REMAINING RESERVE"}
          </span>
          <strong>
            {compact(mine.remainingReserve)} <small>{mine.symbol}</small>
          </strong>
          <small>
            {hasCurveBudget
              ? "of the " + compact(mine.reserveTotal) + " launch cap — the Mining Reserve is untouched until graduation"
              : "of " + compact(mine.reserveTotal) + " allocated to mining"}
          </small>
        </article>
        <article className="card stat is-featured">
          <span>
            <strong>ESTIMATED SHARE</strong>
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
                <IconTimer size={13} aria-hidden="true" /> {onCurve ? "EMISSION RATE" : "REDUCTION SCHEDULE"}
            </span>
            <small>
              {onCurve
                ? capSpent
                  ? "cap spent — awaiting graduation"
                  : "flat until the curve cap runs out" +
                    (curveDaysLeft === null ? "" : " — ≈ " + runwayLabel(curveDaysLeft) + " left")
                : "next reduction in " + countdown(mine.epochEndsAt, now) + ", epoch " + mine.epoch}
            </small>
          </div>
          {onCurve ? (
            /* The curve phase pays one fixed rate until its launch cap runs out, so it gets one flat
               bar: there are no epoch steps to draw before graduation. */
            <div
              className="reduction-bars is-flat"
              role="img"
              aria-label={
                "One flat block reward of " + compact(mine.blockReward) + " " + mine.symbol +
                " per block for the whole curve phase; the epoch schedule starts after graduation"
              }
            >
              <div className="reduction-bar" title={compact(mine.blockReward) + " per block"}>
                <i style={{ height: "100%" }} />
                <span>flat</span>
              </div>
            </div>
          ) : (
            <div className="reduction-bars">
              {schedule.map((reward, index) => (
                <div className="reduction-bar" key={index} title={compact(reward) + " per block"}>
                  <i style={{ height: Math.max(4, Math.round((reward / scheduleMax) * 100)) + "%" }} />
                  <span>{index === 0 ? "now" : "+" + index}</span>
                </div>
              ))}
            </div>
          )}
          <p>
            {onCurve
              ? "The curve phase has no reduction schedule: its rate is fixed at launch, and what ends it is the launch cap running out rather than an epoch boundary. The epoch schedule takes over after graduation."
              : "Every epoch cuts the block reward. A mine never mints more than its reserve, so emissions end when the reserve does."}
          </p>
        </div>

        <div className="fully-mined-progress">
          <div className="mine-info-subhead">
            <span>
              {hasCurveBudget ? (
                <>
                  CURVE MINING
                </>
              ) : (
                "MINED SO FAR"
              )}
            </span>
            <small>{percent(budgetProgress)}</small>
          </div>
          <div
            className="tier-progress-bar"
            role="img"
            aria-label={
              hasCurveBudget
                ? "Curve mining " + percent(budgetProgress) + " of the launch cap mined"
                : "Mine " + percent(budgetProgress) + " mined"
            }
          >
            <i style={{ width: percent(budgetProgress) }} />
          </div>
          {hasCurveBudget && (
            <div className="curve-mining-meta">
              <span>
                <b>
                  {compact(curve.mined)} of {compact(curve.cap)}
                </b>{" "}
                ${mine.symbol} mined
              </span>
              <span>
                <b>{compact(curve.blockReward)}</b> ${mine.symbol} per block
              </span>
              <span>
                {curve.open
                  ? curveDaysLeft === null
                    ? "no room left at this rate"
                    : "≈ " + runwayLabel(curveDaysLeft) + " of cap left"
                  : "launch cap fully mined"}
              </span>
              {curve.unpaid > 0 && (
                <span>
                  <b>{compact(curve.unpaid)}</b> ${mine.symbol} mined and not claimed yet
                </span>
              )}
            </div>
          )}
          {hasCurveBudget ? (
            <p>
              {curve.open
                ? "Mining draws from the curve, not the Mining Reserve: every block takes tokens out of the curve's own inventory, so it moves the price the same way a buy does. Mining adds no SOL — the curve's SOL only ever comes from buyers, which is what caps a seller's payout."
                : "The launch cap for curve mining is fully mined, so no further block is paid before graduation. The Mining Reserve does not stand in for it: that only starts paying once the market graduates."}
            </p>
          ) : (
            <p>{accountingNote(mine.accounting)}</p>
          )}
          {hasCurveBudget && <p className="curve-mining-source">{accountingNote(mine.accounting)}</p>}
        </div>
      </div>
    </section>
  );
}
