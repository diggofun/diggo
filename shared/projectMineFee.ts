/**
 * The platform fee on coins added as mines (worker/projectMines.ts).
 *
 * The depositor's one transaction sends the fee straight to the fee wallet and the rest to the
 * mining vault; only the rest becomes the mine. Rounded down, so the fee is never more than the rate.
 */

/** 2%, in basis points. The Worker can override it with PROJECT_MINE_FEE_BPS (0 turns it off). */
export const PROJECT_MINE_FEE_BPS = 200;
export const PROJECT_MINE_MAX_FEE_BPS = 1_000;
/** Where the fee goes unless PROJECT_MINE_FEE_WALLET says otherwise. */
export const PROJECT_MINE_FEE_WALLET = "6HHEkX5MxsoQwyCJZHvLnewmnsaw19vGT9Y8jhqH7GuJ";

export function feeFor(total: bigint, bps: number): bigint {
  if (total <= 0n || !Number.isInteger(bps) || bps <= 0) return 0n;
  return (total * BigInt(Math.min(bps, PROJECT_MINE_MAX_FEE_BPS))) / 10_000n;
}

/** How a deposit of `total` raw units splits between the fee and the mine. */
export function splitDeposit(total: bigint, bps: number): { fee: bigint; reserve: bigint } {
  const fee = feeFor(total, bps);
  return { fee, reserve: total - fee };
}

/** "2%" or "1.5%" for display. */
export function feeLabel(bps: number): string {
  return (Math.round(bps) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 }) + "%";
}
