/** The creator dashboard's view of one mine (worker/creatorMines.ts). Amounts are whole tokens. */
export interface CreatorMineView {
  mint: string;
  symbol: string;
  name: string;
  /** "added": an existing coin deposited into a mine; "launch": a coin launched on Diggo. */
  kind: "added" | "launch";
  open: boolean;
  crews: number;
  minersThisWeek: number;
  /** Distinct wallets that received this coin from the mine: new holders the mine brought. */
  holdersPaid: number;
  paidOut: number;
  remaining: number;
  reserve: number;
  endsAt: number | null;
  boostedUntil: number | null;
  /** Place in Mine Wars, or null for a mine that is not being mined. */
  rank: number | null;
}
