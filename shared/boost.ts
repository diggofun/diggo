/**
 * Boosts: anyone can pay SOL to push a mine up for a while (worker/boosts.ts).
 *
 * A boosted mine is listed first with a badge, ranks above others on Mine Wars ties, and is three
 * times as likely to get a crew that has no mine link. Prices are in lamports.
 */

export interface BoostTier {
  id: "1d" | "3d" | "7d";
  label: string;
  days: number;
  lamports: bigint;
}

export const BOOST_TIERS: readonly BoostTier[] = [
  { id: "1d", label: "24 hours", days: 1, lamports: 100_000_000n },
  { id: "3d", label: "3 days", days: 3, lamports: 250_000_000n },
  { id: "7d", label: "7 days", days: 7, lamports: 500_000_000n },
];

/** How much more likely a boosted mine is to be picked for a crew without a mine link. */
export const BOOST_WEIGHT = 3;

export function boostTier(id: unknown): BoostTier | null {
  return BOOST_TIERS.find((tier) => tier.id === id) ?? null;
}

export function solLabel(lamports: bigint): string {
  return (Number(lamports) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 3 }) + " SOL";
}

/** A new boost starts when the current one ends, so buying twice adds up instead of overlapping. */
export function boostWindow(now: number, currentEnd: number | null, days: number): { startsAt: number; endsAt: number } {
  const startsAt = currentEnd !== null && currentEnd > now ? currentEnd : now;
  return { startsAt, endsAt: startsAt + days * 86_400 };
}
