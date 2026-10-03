/**
 * How the market surfaces describe one mine's emission and its crew power.
 *
 * A mine is paid from one of two places. While its market is still on the bonding curve, blocks come
 * out of that curve's own launch cap at a rate fixed at launch; after graduation they come out of
 * the Mining Reserve on a schedule that steps down every epoch (see shared/curve.ts and
 * MineEmissionSource in shared/types.ts). The epoch countdown and the epoch-by-epoch bars therefore
 * only describe a mine that has graduated, and a mine still on its curve has to be described with
 * the curve's own numbers instead.
 *
 * The power figure has the same split-brain problem. The bootstrap token list carries the cached
 * network_power column of the tokens table, while /api/mines/:mint/info derives the total from live
 * mining state; the cached column reads 0 for mines that plainly have crew on them. The rule here is
 * the one the mine info panel already follows — the live payload wins — and when neither source can
 * state a figure the caller shows nothing rather than a wrong zero.
 */
import type { CurveMiningSummary, MineInfo, TokenSummary } from "../shared/types";
import { countdown } from "./format";

/** The bootstrap token list's view of a mine's total crew power. */
type TokenPower = Pick<TokenSummary, "mint" | "networkPower">;
/** The live mine-info payload's view of the same figure. */
type InfoPower = Pick<MineInfo, "mint" | "totalMiningPower">;

/** Unknown reserve data must not look like an exhausted mine. A measured zero is valid. */
export function miningReserveShare(token: Pick<TokenSummary, "reserveRemaining" | "reserveTotal">): number | null {
  const { reserveRemaining, reserveTotal } = token;
  if (reserveRemaining === null || reserveTotal === null || !Number.isFinite(reserveRemaining) ||
      !Number.isFinite(reserveTotal) || reserveRemaining < 0 || reserveTotal <= 0) return null;
  return Math.min(1, reserveRemaining / reserveTotal);
}

/**
 * The total Mining Power to print for one mine, or null when no loaded source can state it.
 *
 * Mine info is authoritative for the mine it describes, so it wins whenever it has landed for this
 * mint — including a genuine zero, which is what a mine with no activated crew really reports. The
 * token list is only a fallback before that payload arrives, and only a positive figure there is
 * worth printing: the cached column's zero says nothing about a mine whose crew is undisputed.
 */
export function resolveNetworkPower(
  token: TokenPower | null,
  mineInfo: InfoPower | null,
): number | null {
  if (mineInfo && (!token || mineInfo.mint === token.mint)) return mineInfo.totalMiningPower;
  const fallback = token?.networkPower ?? 0;
  return Number.isFinite(fallback) && fallback > 0 ? fallback : null;
}

/**
 * A curve runway, which the worker reports as a fractional day count, as a short label. Under a day
 * it is hours, because "0.4 days" tells a player nothing about when the cap runs out.
 */
export function runwayLabel(days: number): string {
  if (days < 1) return Math.max(1, Math.round(days * 24)) + "h";
  return (days < 10 ? days.toFixed(1) : String(Math.round(days))) + " days";
}

/** True when a curve mine's launch cap is spent, so no block is paid before graduation. */
export function curveCapSpent(curve: CurveMiningSummary): boolean {
  return curve.onCurve && curve.cap > 0 && (!curve.open || curve.remaining <= 0);
}

/** The status a payload reported, upper-cased; "" when it reported none. */
export function statusCode(status: string | null | undefined): string {
  return typeof status === "string" ? status.trim().toUpperCase() : "";
}

/**
 * True when the mine cannot pay another block: its reserve is spent, or it is on a curve whose
 * launch cap is.
 */
export function emissionEnded(
  status: string | null | undefined,
  curve: CurveMiningSummary,
): boolean {
  return statusCode(status) === "FULLY_MINED" || curveCapSpent(curve);
}

/**
 * The mine panel's next-reduction slot.
 *
 * The onCurve flag says whether the panel is describing the curve phase (a flat rate, with the launch
 * cap or graduation as the only things that end it) or the epoch schedule that follows it.
 */
export interface EmissionWindowView {
  label: string;
  value: string;
  detail: string;
  onCurve: boolean;
}

/**
 * What replaces the epoch countdown on a mine page.
 *
 * A curve mine has no next reduction to count down to: its rate is fixed at launch, so the panel
 * reports either how long the cap lasts at that rate, or that the cap is already spent and mining
 * waits on graduation.
 */
export function describeEmissionWindow(input: {
  curve: CurveMiningSummary;
  /** The worker's estimate of curve budget left, or null when it has none to give. */
  daysRemaining: number | null;
  epochEndsAt: number;
  now: number;
}): EmissionWindowView {
  const { curve, daysRemaining, epochEndsAt, now } = input;
  if (!curve.onCurve) {
    return {
      label: "Next reduction",
      value: countdown(epochEndsAt, now),
      detail: "block reward steps down each epoch",
      onCurve: false,
    };
  }
  if (curveCapSpent(curve)) {
    return {
      label: "Mining status",
      value: "Awaiting graduation",
      detail: "Launch cap reached; mining resumes after graduation",
      onCurve: true,
    };
  }
  if (daysRemaining !== null && daysRemaining > 0) {
    return {
      label: "Mining window",
      value: "≈ " + runwayLabel(daysRemaining),
      detail: "Fixed rate until the launch cap is used or the mine graduates",
      onCurve: true,
    };
  }
  return {
    label: "Mining window",
    value: "Flat",
    detail: "Fixed rate until the launch cap is used or the mine graduates",
    onCurve: true,
  };
}

/** How one status should be labelled, and which badge tone carries it. */
export interface MineStatusView {
  /** The status the payload reported, upper-cased; "" when it reported none. */
  code: string;
  /** Short badge text. */
  badge: string;
  /** One sentence for tooltips and aria labels. */
  detail: string;
  tone: "active" | "idle" | "paused" | "danger";
  /** False when this build has no label for the status it was handed. */
  known: boolean;
}

/** The curve phase's own pause, phrased once for every surface that reports it. */
const CURVE_CAP_REACHED: Omit<MineStatusView, "code" | "known"> = {
  badge: "Awaiting graduation",
  detail: "Curve cap reached — mining resumes after graduation.",
  tone: "paused",
};

const KNOWN_STATUSES: Record<string, Omit<MineStatusView, "code" | "known">> = {
  LAUNCHING: {
    badge: "Launching",
    detail: "The mine is live on chain and waiting for its first crew.",
    tone: "idle",
  },
  MINING_ACTIVE: {
    badge: "Mining active",
    detail: "The mine is paying blocks to the crew working it.",
    tone: "active",
  },
  CURVE_CAP_REACHED,
  FULLY_MINED: {
    badge: "Fully mined",
    detail: "The reserve is spent, so the mine has nothing left to pay.",
    tone: "danger",
  },
};

/**
 * The label for a mine's status.
 *
 * Statuses are the worker's vocabulary and it grows: a curve mine that has spent its cap reports one
 * this build may never have seen. An unrecognised status is therefore labelled in its own words
 * rather than dropped or guessed at, so a new state shows up in the UI the day the API sends it.
 *
 * The options let the caller pass what the mine's own numbers say, because the status column can lag
 * behind them: a curve cap that is spent means the mine is awaiting graduation, and a reserve that is
 * spent means it is fully mined, whatever status the API still reports.
 */
export function describeMineStatus(
  status: string | null | undefined,
  options: { curveCapSpent?: boolean; reserveSpent?: boolean } = {},
): MineStatusView {
  const code = statusCode(status);
  if (code === "FULLY_MINED") return { code, known: true, ...KNOWN_STATUSES.FULLY_MINED };
  if (options.curveCapSpent) return { code, known: true, ...CURVE_CAP_REACHED };
  if (options.reserveSpent) return { code, known: true, ...KNOWN_STATUSES.FULLY_MINED };
  const known = KNOWN_STATUSES[code];
  if (known) return { code, known: true, ...known };
  if (code === "") {
    return {
      code,
      known: false,
      badge: "Status unknown",
      detail:
        "The API reported no status for this mine; its numbers below still come from the mine itself.",
      tone: "idle",
    };
  }
  return {
    code,
    known: false,
    badge: code.replace(/_+/g, " ").toLowerCase(),
    detail:
      'The API reported the status "' +
      code +
      '", which this build has no label for; nothing about the mine is assumed from it.',
    tone: "idle",
  };
}
