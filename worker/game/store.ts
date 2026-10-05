import { MINING_RESERVE, TOKEN_SCALE, type GamePlayerState } from "./contracts";

export type ClaimStatus = "PENDING" | "PAID";

export interface GameClaim {
  id: string;
  wallet: string;
  mint: string;
  amount: bigint;
  kind: "MINING" | "DISCOVERY";
  status: ClaimStatus;
  signature: string | null;
  createdAt: number;
}

export interface GameBalance {
  wallet: string;
  mint: string;
  claimable: bigint;
  lastSettledAt: number;
}

export interface GameMineLedger {
  mint: string;
  initialReserve: bigint;
  released: bigint;
  remaining: bigint;
  committed: bigint;
  paid: bigint;
  totalEligiblePower: number;
  version: number;
}

export interface ReferralCreditRecord {
  id: string;
  referrer: string;
  referee: string;
  amount: number;
  week: number;
  createdAt: number;
}

export interface DiscoveryRecord {
  id: string;
  wallet: string;
  mint: string;
  amount: bigint;
  claimId: string;
  epoch: number;
  createdAt: number;
}

/** Persistence boundary used by routes and by the in-memory test fake. */
export interface GameStore {
  ensurePlayer(wallet: string, createdAt: number, crew: GamePlayerState["crew"]): Promise<GamePlayerState>;
  getPlayer(wallet: string): Promise<GamePlayerState | null>;
  savePlayer(player: GamePlayerState, expectedVersion: number): Promise<boolean>;
  playerVersion(wallet: string): Promise<number>;
  getMine(mint: string): Promise<GameMineLedger | null>;
  /** The mine this player asked to dig through a mine link, or null. */
  getPreferredMine(wallet: string): Promise<string | null>;
  setPreferredMine(wallet: string, mint: string | null, now: number): Promise<void>;
  ensureMine(mint: string, startsAt: number, totalEligiblePower: number, now: number, reserve?: bigint): Promise<GameMineLedger>;
  saveMine(mine: GameMineLedger, expectedVersion: number): Promise<boolean>;
  mineVersion(mint: string): Promise<number>;
  getBalance(wallet: string, mint: string): Promise<GameBalance>;
  listBalances(wallet: string): Promise<GameBalance[]>;
  /** Current server-visible power assigned to active players mining this mint. */
  getEligiblePower(mint: string, now: number): Promise<number>;
  saveBalance(balance: GameBalance, expectedClaimable: bigint): Promise<boolean>;
  /** Atomically advances the mine ledger and credits the wallet's claimable balance. */
  settleMining(
    mine: GameMineLedger,
    balance: GameBalance,
    expectedMineVersion: number,
    expectedClaimable: bigint,
    now: number,
  ): Promise<boolean>;
  balanceVersion(wallet: string, mint: string): Promise<bigint>;
  createClaim(claim: GameClaim, expectedClaimable: bigint): Promise<GameClaim | null>;
  getClaim(id: string): Promise<GameClaim | null>;
  listPendingClaims(limit: number): Promise<GameClaim[]>;
  listClaims(wallet: string, limit: number): Promise<GameClaim[]>;
  /** Every claim for a wallet, in stable keyset order. Never truncate claim-all preparation. */
  listClaimsForWallet(wallet: string): Promise<GameClaim[]>;
  markClaimPaid(id: string, signature: string): Promise<boolean>;
  /** Atomically settles every included claim and advances each mine's paid total once. */
  markClaimBatchPaid(claimIds: readonly string[], signature: string): Promise<boolean>;
  applyReferralCredit(record: ReferralCreditRecord): Promise<boolean>;
  getReferralCredit(id: string): Promise<ReferralCreditRecord | null>;
  referralWeekTotals(referrer: string, week: number): Promise<{ count: number; ore: number }>;
  createDiscovery(record: DiscoveryRecord, expectedReserveRemaining: bigint): Promise<GameClaim | null>;
  /**
   * Wallets whose current shift has time the ORE cursor has not settled yet, oldest cursor first.
   * Rows carrying legacy millisecond timestamps are excluded until they are repaired.
   */
  listWalletsToSettle(now: number, limit: number): Promise<string[]>;
}

export function starterCrew(): GamePlayerState["crew"] {
  return { miners: 1, drills: 1, carts: 1, foreman: 1, storage: 1 };
}

export class MemoryGameStore implements GameStore {
  readonly players = new Map<string, GamePlayerState>();
  readonly playerVersions = new Map<string, number>();
  readonly mines = new Map<string, GameMineLedger>();
  readonly mineVersions = new Map<string, number>();
  readonly balances = new Map<string, GameBalance>();
  readonly balanceVersions = new Map<string, bigint>();
  readonly claims = new Map<string, GameClaim>();
  readonly referrals = new Map<string, ReferralCreditRecord>();
  readonly discoveries = new Map<string, DiscoveryRecord>();
  referralCounters = new Map<string, { count: number; ore: number }>();
  readonly preferredMines = new Map<string, string>();

  async getPreferredMine(wallet: string): Promise<string | null> {
    return this.preferredMines.get(wallet) ?? null;
  }

  async setPreferredMine(wallet: string, mint: string | null): Promise<void> {
    if (mint) this.preferredMines.set(wallet, mint);
    else this.preferredMines.delete(wallet);
  }

  private balanceKey(wallet: string, mint: string): string {
    return `${wallet}:${mint}`;
  }

  async ensurePlayer(wallet: string, createdAt: number, crew: GamePlayerState["crew"]): Promise<GamePlayerState> {
    const existing = await this.getPlayer(wallet);
    if (existing) return existing;
    const player: GamePlayerState = {
      wallet,
      createdAt,
      oreBalance: 0,
      oreEarned: 0,
      streak: 0,
      longestStreak: 0,
      streakFreezes: 0,
      activeUntil: 0,
      lastActivationAt: 0,
      activatedAt: 0,
      lastOreAt: 0,
      activeMine: null,
      activeMiningPower: 0,
      activeDays: 0,
      validActivations: 0,
      crew: { ...crew },
    };
    this.players.set(wallet, player);
    this.playerVersions.set(wallet, 0);
    return { ...player, crew: { ...player.crew } };
  }

  async getPlayer(wallet: string): Promise<GamePlayerState | null> {
    const player = this.players.get(wallet);
    return player ? { ...player, crew: { ...player.crew } } : null;
  }

  async savePlayer(player: GamePlayerState, expectedVersion: number): Promise<boolean> {
    const version = this.playerVersions.get(player.wallet) ?? 0;
    if (version !== expectedVersion) return false;
    this.players.set(player.wallet, { ...player, crew: { ...player.crew } });
    this.playerVersions.set(player.wallet, version + 1);
    return true;
  }

  async playerVersion(wallet: string): Promise<number> {
    return this.playerVersions.get(wallet) ?? 0;
  }

  async getMine(mint: string): Promise<GameMineLedger | null> {
    const mine = this.mines.get(mint);
    return mine ? { ...mine } : null;
  }

  async ensureMine(mint: string, _startsAt: number, totalEligiblePower: number, _now: number, reserve: bigint = MINING_RESERVE): Promise<GameMineLedger> {
    const existing = await this.getMine(mint);
    if (existing) return existing;
    if (reserve <= 0n) throw new Error("A mine needs a positive reserve");
    const mine: GameMineLedger = {
      mint,
      initialReserve: reserve,
      released: 0n,
      remaining: reserve,
      committed: 0n,
      paid: 0n,
      totalEligiblePower,
      version: 0,
    };
    this.mines.set(mint, mine);
    this.mineVersions.set(mint, 0);
    return { ...mine };
  }

  async saveMine(mine: GameMineLedger, expectedVersion: number): Promise<boolean> {
    const version = this.mineVersions.get(mine.mint) ?? 0;
    if (
      version !== expectedVersion ||
      // The reserve is fixed when the mine is created; nothing may grow or shrink it later.
      mine.initialReserve !== this.mines.get(mine.mint)?.initialReserve ||
      mine.released > mine.initialReserve ||
      mine.committed < 0n ||
      mine.committed > mine.released ||
      mine.paid < 0n ||
      mine.paid > mine.committed ||
      mine.remaining !== mine.initialReserve - mine.committed
    ) return false;
    this.mines.set(mine.mint, { ...mine, version: version + 1 });
    this.mineVersions.set(mine.mint, version + 1);
    return true;
  }

  async mineVersion(mint: string): Promise<number> {
    return this.mineVersions.get(mint) ?? 0;
  }

  async getBalance(wallet: string, mint: string): Promise<GameBalance> {
    return this.balances.get(this.balanceKey(wallet, mint)) ?? {
      wallet,
      mint,
      claimable: 0n,
      lastSettledAt: 0,
    };
  }

  async listBalances(wallet: string): Promise<GameBalance[]> {
    return [...this.balances.values()]
      .filter((balance) => balance.wallet === wallet)
      .map((balance) => ({ ...balance }));
  }

  async getEligiblePower(mint: string, now: number): Promise<number> {
    let total = 0;
    for (const player of this.players.values()) {
      if (player.activeMine === mint && player.activeUntil > now && player.activatedAt > 0 && player.activatedAt <= now && player.activeMiningPower > 0) {
        total += player.activeMiningPower;
      }
    }
    return total;
  }

  async listWalletsToSettle(now: number, limit: number): Promise<string[]> {
    return [...this.players.values()]
      .filter((player) => player.activatedAt > 0 && player.activatedAt <= now && player.activeUntil <= 99_999_999_999 && player.lastOreAt < player.activeUntil)
      .sort((a, b) => a.lastOreAt - b.lastOreAt || a.wallet.localeCompare(b.wallet))
      .slice(0, Math.max(0, limit))
      .map((player) => player.wallet);
  }

  async saveBalance(balance: GameBalance, expectedClaimable: bigint): Promise<boolean> {
    const key = this.balanceKey(balance.wallet, balance.mint);
    const current = await this.getBalance(balance.wallet, balance.mint);
    if (current.claimable !== expectedClaimable) return false;
    this.balances.set(key, { ...balance });
    this.balanceVersions.set(key, balance.claimable);
    return true;
  }

  async settleMining(
    mine: GameMineLedger,
    balance: GameBalance,
    expectedMineVersion: number,
    expectedClaimable: bigint,
    now: number,
  ): Promise<boolean> {
    const mineVersion = this.mineVersions.get(mine.mint) ?? 0;
    if (mineVersion !== expectedMineVersion) return false;
    const currentBalance = await this.getBalance(balance.wallet, balance.mint);
    if (currentBalance.claimable !== expectedClaimable) return false;
    if (mine.initialReserve !== this.mines.get(mine.mint)?.initialReserve) return false;
    if (mine.remaining !== mine.initialReserve - mine.committed) return false;
    this.mines.set(mine.mint, { ...mine, version: mineVersion + 1 });
    this.mineVersions.set(mine.mint, mineVersion + 1);
    this.balances.set(this.balanceKey(balance.wallet, balance.mint), { ...balance, lastSettledAt: now });
    this.balanceVersions.set(this.balanceKey(balance.wallet, balance.mint), balance.claimable);
    return true;
  }

  async balanceVersion(wallet: string, mint: string): Promise<bigint> {
    return this.balanceVersions.get(this.balanceKey(wallet, mint)) ?? 0n;
  }

  async createClaim(claim: GameClaim, expectedClaimable: bigint): Promise<GameClaim | null> {
    const existing = this.claims.get(claim.id);
    if (existing) return { ...existing };
    const balance = await this.getBalance(claim.wallet, claim.mint);
    if (balance.claimable < claim.amount || expectedClaimable !== balance.claimable) return null;
    balance.claimable -= claim.amount;
    this.balances.set(this.balanceKey(claim.wallet, claim.mint), balance);
    this.balanceVersions.set(this.balanceKey(claim.wallet, claim.mint), balance.claimable);
    this.claims.set(claim.id, { ...claim });
    return { ...claim };
  }

  async getClaim(id: string): Promise<GameClaim | null> {
    const claim = this.claims.get(id);
    return claim ? { ...claim } : null;
  }

  async listPendingClaims(limit: number): Promise<GameClaim[]> {
    return [...this.claims.values()].filter((claim) => claim.status === "PENDING").slice(0, limit).map((claim) => ({ ...claim }));
  }

  async listClaims(wallet: string, limit: number): Promise<GameClaim[]> {
    return [...this.claims.values()]
      .filter((claim) => claim.wallet === wallet)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((claim) => ({ ...claim }));
  }

  async markClaimPaid(id: string, signature: string): Promise<boolean> {
    const claim = this.claims.get(id);
    if (!claim) return false;
    if (claim.status === "PAID") return claim.signature === signature;
    const mine = this.mines.get(claim.mint);
    if (mine) {
      if (mine.paid + claim.amount > mine.committed) return false;
      mine.paid += claim.amount;
    }
    claim.status = "PAID";
    claim.signature = signature;
    return true;
  }

  async listClaimsForWallet(wallet: string): Promise<GameClaim[]> {
    return [...this.claims.values()]
      .filter((claim) => claim.wallet === wallet)
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
      .map((claim) => ({ ...claim }));
  }

  async markClaimBatchPaid(claimIds: readonly string[], signature: string): Promise<boolean> {
    const unique = new Set(claimIds);
    if (unique.size !== claimIds.length || unique.size === 0 || !signature) return false;
    const claims: GameClaim[] = [];
    for (const id of unique) {
      const claim = this.claims.get(id);
      if (!claim) return false;
      if (claim.status === "PAID" && claim.signature !== signature) return false;
      claims.push(claim);
    }
    const pending = claims.filter((claim) => claim.status === "PENDING");
    const totals = new Map<string, bigint>();
    for (const claim of pending) totals.set(claim.mint, (totals.get(claim.mint) ?? 0n) + claim.amount);
    for (const [mint, amount] of totals) {
      const mine = this.mines.get(mint);
      if (!mine || mine.paid + amount > mine.committed) return false;
    }
    for (const [mint, amount] of totals) this.mines.get(mint)!.paid += amount;
    for (const claim of pending) {
      claim.status = "PAID";
      claim.signature = signature;
    }
    return true;
  }

  async applyReferralCredit(record: ReferralCreditRecord): Promise<boolean> {
    if (this.referrals.has(record.id)) return false;
    const key = `${record.referrer}:${record.week}`;
    const current = this.referralCounters.get(key) ?? { count: 0, ore: 0 };
    if (record.amount <= 0 || record.amount > 250 || current.count >= 25 || current.ore + record.amount > 6250) return false;
    this.referralCounters.set(key, { count: current.count + 1, ore: current.ore + record.amount });
    this.referrals.set(record.id, { ...record });
    return true;
  }

  async getReferralCredit(id: string): Promise<ReferralCreditRecord | null> {
    const row = this.referrals.get(id);
    return row ? { ...row } : null;
  }

  async referralWeekTotals(referrer: string, week: number): Promise<{ count: number; ore: number }> {
    return this.referralCounters.get(`${referrer}:${week}`) ?? { count: 0, ore: 0 };
  }

  async createDiscovery(record: DiscoveryRecord, expectedReserveRemaining: bigint): Promise<GameClaim | null> {
    const existing = this.claims.get(record.claimId);
    if (existing) return { ...existing };
    const mine = this.mines.get(record.mint);
    if (!mine || mine.remaining !== expectedReserveRemaining || mine.remaining < record.amount) return null;
    mine.released = mine.released + record.amount > mine.initialReserve ? mine.initialReserve : mine.released + record.amount;
    mine.committed += record.amount;
    mine.remaining -= record.amount;
    this.discoveries.set(record.id, { ...record });
    const claim: GameClaim = {
      id: record.claimId,
      wallet: record.wallet,
      mint: record.mint,
      amount: record.amount,
      kind: "DISCOVERY",
      status: "PENDING",
      signature: null,
      createdAt: record.createdAt,
    };
    this.claims.set(claim.id, claim);
    return { ...claim };
  }
}

export function mineConservation(mine: GameMineLedger, claimableOutstanding: bigint, paid: bigint): boolean {
  return (
    mine.initialReserve > 0n &&
    mine.released <= mine.initialReserve &&
    mine.remaining === mine.initialReserve - mine.committed &&
    mine.committed <= mine.released &&
    paid === mine.paid &&
    claimableOutstanding + mine.paid <= mine.committed
  );
}

export function wholeTokens(amount: bigint): number {
  return Number(amount) / Number(TOKEN_SCALE);
}
