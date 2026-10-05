/**
 * Mining period: how long a mine takes to release its whole reserve.
 *
 * A coin's creator picks it at launch and a sponsor sets it for a sponsored mine; either can change
 * it later. A change never takes back what was already released: from the moment of the change, the
 * rest of the reserve is spread over the new period (worker/game/rules.ts releasedOnSchedule).
 */

export const MINING_PERIOD_MIN_DAYS = 1;
export const MINING_PERIOD_MAX_DAYS = 3_650;
/** The launch allocation's original period, used when nobody chose one. */
export const MINING_PERIOD_DEFAULT_DAYS = 3_650;
/** How often one mine's period can be changed, so it cannot be flipped back and forth. */
export const MINING_PERIOD_CHANGE_COOLDOWN_SECONDS = 86_400;

export const MINING_PERIOD_PRESETS: readonly { days: number; label: string }[] = [
  { days: 7, label: "1 week" },
  { days: 30, label: "1 month" },
  { days: 90, label: "3 months" },
  { days: 365, label: "1 year" },
  { days: 3_650, label: "10 years" },
];

export function parseMiningDays(value: unknown): number | null {
  const days = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof days === "number" && Number.isInteger(days) && days >= MINING_PERIOD_MIN_DAYS && days <= MINING_PERIOD_MAX_DAYS
    ? days
    : null;
}

/** A period change: from `anchorAt`, `anchorReleased` (raw units) is out and the rest releases until `endsAt`. */
export interface MiningSchedule {
  anchorAt: number;
  anchorReleased: string;
  endsAt: number;
}

export function periodLabel(seconds: number): string {
  const days = Math.max(0, Math.round(seconds / 86_400));
  if (days >= 365 && days % 365 === 0) return days / 365 === 1 ? "1 year" : `${days / 365} years`;
  if (days >= 30 && days % 30 === 0) return days / 30 === 1 ? "1 month" : `${days / 30} months`;
  if (days >= 7 && days % 7 === 0) return days / 7 === 1 ? "1 week" : `${days / 7} weeks`;
  return days === 1 ? "1 day" : `${days} days`;
}
