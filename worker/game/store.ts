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
  ensureMine(mint: string, startsAt: number, totalEligiblePower: number, now: number): Promise<GameMineLedger>;
  saveMine(mine: GameMineLedger, expectedVersion: number): Promise<boolean>;
  mineVersion(mint: string): Promise<number>;
  getBalance(wallet: string, mint: string): Promise<GameBalance>;
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
  markClaimPaid(id: string, signature: string): Promise<boolean>;
  applyReferralCredit(record: ReferralCreditRecord): Promise<boolean>;
  getReferralCredit(id: string): Promise<ReferralCreditRecord | null>;
  referralWeekTotals(referrer: string, week: number): Promise<{ count: number; ore: number }>;
  createDiscovery(record: DiscoveryRecord, expectedReserveRemaining: bigint): Promise<GameClaim | null>;
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

  async ensureMine(mint: string, _startsAt: number, totalEligiblePower: number, _now: number): Promise<GameMineLedger> {
    const existing = await this.getMine(mint);
    if (existing) return existing;
    const mine: GameMineLedger = {
      mint,
      initialReserve: MINING_RESERVE,
      released: 0n,
      remaining: MINING_RESERVE,
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
      mine.initialReserve !== MINING_RESERVE ||
      mine.released > mine.initialReserve ||
      mine.committed < 0n ||
      mine.committed > mine.released ||
      mine.paid < 0n ||
      mine.paid > mine.committed ||
      mine.remaining !== mine.initialReserve - mine.committed
    ) return false;
    this.mines.set(mine.mint, { ...mine });
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
    if (mine.remaining !== mine.initialReserve - mine.committed) return false;
    this.mines.set(mine.mint, { ...mine });
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
    mine.initialReserve === MINING_RESERVE &&
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
