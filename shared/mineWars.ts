/**
 * Mine Wars: coin communities compete for crews (worker/mineWars.ts). A mine ranks by the crews
 * digging it right now, then by how many players dug it this week, then boosted first.
 */

export interface MineWarsEntry {
  rank: number;
  mint: string;
  symbol: string;
  name: string;
  /** A project's name for an added coin, null for a Diggo launch. */
  createdBy: string | null;
  crews: number;
  minersThisWeek: number;
  boosted: boolean;
}

export function rankMineWars<T extends Omit<MineWarsEntry, "rank">>(mines: readonly T[]): (T & { rank: number })[] {
  return [...mines]
    .sort((a, b) =>
      b.crews - a.crews ||
      b.minersThisWeek - a.minersThisWeek ||
      Number(b.boosted) - Number(a.boosted) ||
      a.symbol.localeCompare(b.symbol))
    .map((mine, index) => ({ ...mine, rank: index + 1 }));
}
