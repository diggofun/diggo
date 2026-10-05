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
import { compact, countdown, miningProgressPercent, percent, tokenAmount } from "../format";
import { curveCapSpent, describeMineStatus, runwayLabel } from "../mineView";
import { MiningPeriodEditor } from "./MiningPeriodEditor";

export interface MineInfoPanelProps {
  mine: MineInfo | null;
  mineName: string | null;
  now: number;
  loading: boolean;
  error: string;
  /** The signed-in wallet; the coin's creator gets the mining period control. */
  viewer?: string | null;
  onPeriodChanged?: () => void;
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
  viewer = null,
  onPeriodChanged,
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
  const timeBased = mine.miningEmission;
  /** True while the curve's launch cap is the budget paying this mine's blocks. */
  const onCurve = mine.emissionSource === "CURVE";
  /** A mine launched with no curve share has no curve budget to show, even pre-graduation. */
  const hasCurveBudget = onCurve && curve.cap > 0;
  /**
   * Two ends of a mine look alike in the numbers and mean different things. A reserve that is gone is
   * a fully mined mine. A curve cap that is gone is a mine waiting for graduation: the Mining Reserve
   * behind it is untouched and starts paying the moment the market graduates. Only the first is over,
   * so the status label and the note under the header follow that split.
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
  const progressLabel = miningProgressPercent(budgetProgress);
  const curveDaysLeft = hasCurveBudget ? mine.curveMiningDaysRemaining : null;
  const schedule = mine.reductionSchedule ?? [];
  const scheduleMax = Math.max(1, ...schedule);
  const shareLabel = mine.estimatedShare === null ? "—" : percent(mine.estimatedShare);
  const shareDetail =
    timeBased && mine.estimatedShare !== null
      ? "your share of released tokens"
      : mine.estimatedRewardPerBlock === null || mine.estimatedShare === null
      ? "sign in to see your share"
      : "about " + tokenAmount(mine.estimatedRewardPerBlock) + " " + mine.symbol + " per block";
  const powerDetail = mine.playerPower === null ? "" : compact(mine.playerPower) + " yours";

  return (
    <section className="mine-info page-shell" id="mine-info">
      <div className="mine-info-head">
        <div>
          <h3>{mineName ?? mine.symbol}</h3>
        </div>
        <div className="mine-info-flags">
          {paused ? (
            <span className={"badge badge-" + statusView.tone}>
              {statusView.badge}
            </span>
          ) : !statusView.known ? (
            /* A status this build has no label for is still shown, in its own words: a new state from
               the API should surface rather than silently disappear. */
            <span className={"badge badge-" + statusView.tone}>{statusView.badge}</span>
          ) : null}
        </div>
      </div>

      {paused && <p className={"mine-status-note is-" + statusView.tone}>{statusView.detail}</p>}

      <div className="mine-info-grid">
        <article className="card stat">
          <span>
            <IconMine size={13} aria-hidden="true" /> {timeBased ? "MINING MODEL" : "BLOCK REWARD"}
          </span>
          <strong>
            {timeBased ? "Time-based" : <>{compact(mine.blockReward)} <small>{mine.symbol}</small></>}
          </strong>
          <small>{timeBased ? "Rewards accrue over active time, shared by Mining Power. Payouts become available after graduation." : "Paid to active crews for each block, split by Mining Power."}</small>
        </article>
        <article className="card stat">
          <span>
            <strong>Total mining power</strong>
          </span>
          <strong>{compact(mine.totalMiningPower)}</strong>
          {powerDetail && <small>{powerDetail}</small>}
        </article>
        <article className="card stat">
          <span>
            <IconLayers size={13} aria-hidden="true" /> {hasCurveBudget ? "Launch cap" : "Remaining reserve"}
          </span>
          <strong>
            {compact(mine.remainingReserve)} <small>{mine.symbol}</small>
          </strong>
          <small>
            {hasCurveBudget
              ? "of the " + compact(mine.reserveTotal) + " launch cap"
              : "of " + compact(mine.reserveTotal) + " allocated"}
          </small>
        </article>
        <article className="card stat is-featured">
          <span>
            <strong>Estimated share</strong>
          </span>
          <strong>{shareLabel}</strong>
          <small>{shareDetail}</small>
          <p className="estimate-label">{mine.estimateLabel}</p>
        </article>
      </div>

      <div className="mine-info-lower">
        <div className="reduction-schedule">
          {timeBased ? (
            <>
              <div className="mine-info-subhead">
                <span><IconTimer size={13} aria-hidden="true" /> Mining schedule</span>
                <small>time-based</small>
              </div>
              <p>
                The {compact(mine.reserveTotal)} {mine.symbol} allocation is released gradually
                {mine.miningEndsAt ? " until " + new Date(mine.miningEndsAt * 1000).toLocaleDateString("en") : " over " + timeBased.durationDays.toLocaleString("en") + " days"}.
                Your rewards depend on active mining time and your share of Mining Power.
              </p>
              {viewer && mine.creator === viewer && (
                <MiningPeriodEditor mint={mine.mint} endsAt={mine.miningEndsAt ?? null} onChanged={onPeriodChanged} />
              )}
            </>
          ) : (
            <>
              <div className="mine-info-subhead">
                <span>
                    <IconTimer size={13} aria-hidden="true" /> {onCurve ? "Block reward" : "Reward schedule"}
                </span>
                <small>
                  {onCurve
                    ? capSpent
                      ? "cap spent"
                      : curveDaysLeft === null
                        ? "flat rate"
                        : "≈ " + runwayLabel(curveDaysLeft) + " left"
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
                  ? "The curve phase pays one fixed rate until its launch cap runs out. The epoch schedule starts after graduation."
                  : "Each epoch reduces the block reward. Mining ends when the reserve is spent."}
              </p>
            </>
          )}
        </div>

        <div className="fully-mined-progress">
          <div className="mine-info-subhead">
            <span>
              {hasCurveBudget ? (
                <>
                  Curve mining
                </>
              ) : (
                "Mined so far"
              )}
            </span>
            <small>{progressLabel}</small>
          </div>
          <div
            className="tier-progress-bar"
            role="img"
            aria-label={
              hasCurveBudget
                ? "Curve mining " + progressLabel + " of the launch cap mined"
                : "Mine " + progressLabel + " mined"
            }
          >
            <i style={{ width: (Number.isFinite(budgetProgress) ? Math.max(0, Math.min(1, budgetProgress)) * 100 : 0) + "%" }} />
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
                ? "Mining spends curve inventory, pushing the bonding-curve price like a buy, and adds no SOL. Seller payouts are limited to buyer-contributed SOL."
                : "The launch cap is fully mined, so blocks pay nothing until graduation. The Mining Reserve does not replace it."}
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
