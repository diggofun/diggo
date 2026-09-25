import type { GamePlayerState } from "./contracts";
import { MINING_RESERVE } from "./contracts";
import type {
  ClaimStatus,
  DiscoveryRecord,
  GameBalance,
  GameClaim,
  GameMineLedger,
  GameStore,
  ReferralCreditRecord,
} from "./store";

function text(value: unknown): string {
  return value === null || value === undefined ? "0" : String(value);
}

function number(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function bigint(value: unknown): bigint {
  try {
    return BigInt(text(value));
  } catch {
    return 0n;
  }
}

function playerFromRow(row: Record<string, unknown>): GamePlayerState {
  return {
    wallet: String(row.wallet),
    createdAt: number(row.created_at),
    oreBalance: number(row.ore_balance),
    oreEarned: number(row.ore_earned),
    streak: number(row.streak),
    longestStreak: number(row.longest_streak),
    streakFreezes: number(row.streak_freezes),
    activeUntil: number(row.active_until),
    lastActivationAt: number(row.last_activation_at),
    activatedAt: number(row.activated_at),
    lastOreAt: number(row.last_ore_at),
    activeMine: row.active_mine === null ? null : String(row.active_mine),
    activeMiningPower: number(row.active_mining_power),
    activeDays: number(row.active_days),
    validActivations: number(row.valid_activations),
    crew: {
      miners: number(row.miners_level),
      drills: number(row.drills_level),
      carts: number(row.carts_level),
      foreman: number(row.foreman_level),
      storage: number(row.storage_level),
    },
  };
}

function mineFromRow(row: Record<string, unknown>): GameMineLedger {
  return {
    mint: String(row.mint),
    initialReserve: bigint(row.initial_reserve),
    released: bigint(row.released),
    remaining: bigint(row.remaining),
    committed: bigint(row.committed),
    paid: bigint(row.paid),
    totalEligiblePower: number(row.total_eligible_power),
    version: number(row.version),
  };
}

function claimFromRow(row: Record<string, unknown>): GameClaim {
  return {
    id: String(row.id),
    wallet: String(row.wallet),
    mint: String(row.mint),
    kind: row.kind as GameClaim["kind"],
    amount: bigint(row.amount),
    status: row.status as ClaimStatus,
    signature: row.signature === null ? null : String(row.signature),
    createdAt: number(row.created_at),
  };
}

/** D1 persistence. Every cross-row transition is a single D1 batch (one transaction). */
export class D1GameStore implements GameStore {
  constructor(private readonly db: D1Database) {}

  async ensurePlayer(wallet: string, createdAt: number, crew: GamePlayerState["crew"]): Promise<GamePlayerState> {
    await this.db.prepare(
      "INSERT OR IGNORE INTO game_players (wallet, created_at, miners_level, drills_level, carts_level, foreman_level, storage_level, updated_at)" +
        " VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?2)",
    ).bind(wallet, createdAt, crew.miners, crew.drills, crew.carts, crew.foreman, crew.storage).run();
    const player = await this.getPlayer(wallet);
    if (!player) throw new Error("Game player could not be created");
    return player;
  }

  async getPlayer(wallet: string): Promise<GamePlayerState | null> {
    const row = await this.db.prepare("SELECT * FROM game_players WHERE wallet = ?1").bind(wallet).first<Record<string, unknown>>();
    return row ? playerFromRow(row) : null;
  }

  async savePlayer(player: GamePlayerState, expectedVersion: number): Promise<boolean> {
    const result = await this.db.prepare(
      "UPDATE game_players SET ore_balance = ?1, ore_earned = ?2, streak = ?3, longest_streak = ?4," +
        " streak_freezes = ?5, active_until = ?6, last_activation_at = ?7, activated_at = ?8, last_ore_at = ?9," +
        " active_mine = ?10, active_mining_power = ?11, active_days = ?12, valid_activations = ?13," +
        " miners_level = ?14, drills_level = ?15, carts_level = ?16, foreman_level = ?17, storage_level = ?18," +
        " version = version + 1, updated_at = ?19 WHERE wallet = ?20 AND version = ?21",
    ).bind(
      player.oreBalance, player.oreEarned, player.streak, player.longestStreak, player.streakFreezes,
      player.activeUntil, player.lastActivationAt, player.activatedAt, player.lastOreAt, player.activeMine,
      player.activeMiningPower, player.activeDays, player.validActivations, player.crew.miners, player.crew.drills,
      player.crew.carts, player.crew.foreman, player.crew.storage, Math.floor(Date.now() / 1_000), player.wallet, expectedVersion,
    ).run();
    return result.meta.changes === 1;
  }

  async playerVersion(wallet: string): Promise<number> {
    const row = await this.db.prepare("SELECT version FROM game_players WHERE wallet = ?1").bind(wallet).first<{ version: number }>();
    return number(row?.version);
  }

  async getMine(mint: string): Promise<GameMineLedger | null> {
    const row = await this.db.prepare("SELECT * FROM game_mines WHERE mint = ?1").bind(mint).first<Record<string, unknown>>();
    return row ? mineFromRow(row) : null;
  }

  async ensureMine(mint: string, startsAt: number, totalEligiblePower: number, now: number): Promise<GameMineLedger> {
    await this.db.prepare(
      "INSERT OR IGNORE INTO game_mines (mint, mining_starts_at, initial_reserve, remaining, total_eligible_power, updated_at)" +
        " VALUES (?1, ?2, ?3, ?3, ?4, ?5)",
    ).bind(mint, startsAt, MINING_RESERVE.toString(), String(totalEligiblePower), now).run();
    const mine = await this.getMine(mint);
    if (!mine) throw new Error("Game mine could not be created");
    return mine;
  }

  async saveMine(mine: GameMineLedger, expectedVersion: number): Promise<boolean> {
    if (
      mine.initialReserve !== MINING_RESERVE ||
      mine.remaining !== MINING_RESERVE - mine.committed ||
      mine.released < 0n || mine.released > mine.initialReserve ||
      mine.committed < 0n || mine.committed > mine.released ||
      mine.paid < 0n || mine.paid > mine.committed
    ) return false;
    const result = await this.db.prepare(
      "UPDATE game_mines SET released = ?1, remaining = ?2, committed = ?3, paid = ?4, total_eligible_power = ?5," +
        " version = version + 1, updated_at = ?6 WHERE mint = ?7 AND version = ?8 AND initial_reserve = ?9" +
        " AND ?2 = ?9 AND ?3 <= ?1 AND ?4 <= ?3",
    ).bind(
      mine.released.toString(), mine.remaining.toString(), mine.committed.toString(), mine.paid.toString(),
      mine.totalEligiblePower, Math.floor(Date.now() / 1_000), mine.mint, expectedVersion, MINING_RESERVE.toString(),
    ).run();
    return result.meta.changes === 1;
  }

  async mineVersion(mint: string): Promise<number> {
    const row = await this.db.prepare("SELECT version FROM game_mines WHERE mint = ?1").bind(mint).first<{ version: number }>();
    return number(row?.version);
  }

  async getBalance(wallet: string, mint: string): Promise<GameBalance> {
    const row = await this.db.prepare("SELECT wallet, mint, claimable, last_settled_at FROM game_balances WHERE wallet = ?1 AND mint = ?2").bind(wallet, mint).first<Record<string, unknown>>();
    return row ? { wallet: String(row.wallet), mint: String(row.mint), claimable: bigint(row.claimable), lastSettledAt: number(row.last_settled_at) } : { wallet, mint, claimable: 0n, lastSettledAt: 0 };
  }

  async saveBalance(balance: GameBalance, expectedClaimable: bigint): Promise<boolean> {
    const result = await this.db.prepare(
      "INSERT INTO game_balances (wallet, mint, claimable, last_settled_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)" +
        " ON CONFLICT(wallet, mint) DO UPDATE SET claimable = excluded.claimable, last_settled_at = excluded.last_settled_at, updated_at = excluded.updated_at" +
        " WHERE game_balances.claimable = ?6",
    ).bind(balance.wallet, balance.mint, balance.claimable.toString(), balance.lastSettledAt, Math.floor(Date.now() / 1_000), expectedClaimable.toString()).run();
    return result.meta.changes === 1;
  }

  async settleMining(
    mine: GameMineLedger,
    balance: GameBalance,
    expectedMineVersion: number,
    expectedClaimable: bigint,
    now: number,
  ): Promise<boolean> {
    if (
      mine.initialReserve !== MINING_RESERVE ||
      mine.remaining !== MINING_RESERVE - mine.committed ||
      mine.released < 0n || mine.released > mine.initialReserve ||
      mine.committed < 0n || mine.committed > mine.released
    ) return false;
    const results = await this.db.batch([
      this.db.prepare(
        "INSERT OR IGNORE INTO game_balances (wallet, mint, claimable, last_settled_at, updated_at) VALUES (?1, ?2, 0, 0, ?3)",
      ).bind(balance.wallet, balance.mint, now),
      this.db.prepare(
        "UPDATE game_mines SET released = ?1, remaining = ?2, committed = ?3, total_eligible_power = ?4," +
          " version = version + 1, updated_at = ?5 WHERE mint = ?6 AND version = CAST(?7 AS INTEGER) AND remaining = CAST(?8 AS TEXT)" +
          " AND CAST(?2 AS INTEGER) = CAST(initial_reserve AS INTEGER) - CAST(?3 AS INTEGER)" +
          " AND CAST(?3 AS INTEGER) <= CAST(?1 AS INTEGER)" +
          " AND EXISTS (SELECT 1 FROM game_balances WHERE wallet = ?9 AND mint = ?6 AND claimable = CAST(?10 AS TEXT))",
      ).bind(
        mine.released.toString(), mine.remaining.toString(), mine.committed.toString(), mine.totalEligiblePower,
        now, mine.mint, expectedMineVersion, (mine.remaining + mine.committed).toString(), balance.wallet, expectedClaimable.toString(),
      ),
      this.db.prepare(
        "INSERT INTO game_balances (wallet, mint, claimable, last_settled_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)" +
          " ON CONFLICT(wallet, mint) DO UPDATE SET claimable = excluded.claimable, last_settled_at = excluded.last_settled_at, updated_at = excluded.updated_at" +
          " WHERE game_balances.claimable = CAST(?6 AS TEXT)" +
          " AND EXISTS (SELECT 1 FROM game_mines WHERE mint = ?7 AND committed = CAST(?8 AS TEXT) AND remaining = CAST(?9 AS TEXT))",
      ).bind(
        balance.wallet, balance.mint, balance.claimable.toString(), now, now, expectedClaimable.toString(),
        mine.mint, mine.committed.toString(), mine.remaining.toString(),
      ),
    ]);
    if ((results[1]?.meta.changes ?? 0) !== 1 || (results[2]?.meta.changes ?? 0) !== 1) return false;
    return true;
  }

  async balanceVersion(wallet: string, mint: string): Promise<bigint> {
    return (await this.getBalance(wallet, mint)).claimable;
  }

  async createClaim(claim: GameClaim, expectedClaimable: bigint): Promise<GameClaim | null> {
    const existing = await this.getClaim(claim.id);
    if (existing) return existing;
    if (claim.amount <= 0n || expectedClaimable < claim.amount) return null;
    const nextClaimable = expectedClaimable - claim.amount;
    const results = await this.db.batch([
      this.db.prepare(
        "INSERT OR IGNORE INTO game_claims (id, wallet, mint, kind, amount, status, idempotency_key, created_at)" +
          " SELECT ?1, ?2, ?3, ?4, ?5, 'PENDING', ?6, ?7 WHERE CAST(?8 AS INTEGER) = CAST(?9 AS INTEGER) AND CAST(?8 AS INTEGER) >= CAST(?5 AS INTEGER)" +
          " AND EXISTS (SELECT 1 FROM game_balances WHERE wallet = ?2 AND mint = ?3 AND claimable = CAST(?8 AS TEXT))",
      ).bind(claim.id, claim.wallet, claim.mint, claim.kind, claim.amount, claim.id, claim.createdAt, expectedClaimable, expectedClaimable),
      this.db.prepare(
        "UPDATE game_balances SET claimable = ?1, updated_at = ?2 WHERE wallet = ?3 AND mint = ?4 AND claimable = CAST(?5 AS TEXT)" +
          " AND EXISTS (SELECT 1 FROM game_claims WHERE id = ?6 AND idempotency_key = ?6 AND amount = CAST(?7 AS TEXT) AND wallet = ?3 AND mint = ?4)",
      ).bind(nextClaimable, Math.floor(Date.now() / 1_000), claim.wallet, claim.mint, expectedClaimable, claim.id, claim.amount),
    ]);
    if ((results[0]?.meta.changes ?? 0) !== 1 || (results[1]?.meta.changes ?? 0) !== 1) return null;
    return this.getClaim(claim.id);
  }

  async getClaim(id: string): Promise<GameClaim | null> {
    const row = await this.db.prepare("SELECT * FROM game_claims WHERE id = ?1").bind(id).first<Record<string, unknown>>();
    return row ? claimFromRow(row) : null;
  }

  async listPendingClaims(limit: number): Promise<GameClaim[]> {
    const result = await this.db.prepare("SELECT * FROM game_claims WHERE status = 'PENDING' ORDER BY created_at LIMIT ?1").bind(Math.max(1, Math.floor(limit))).all<Record<string, unknown>>();
    return (result.results ?? []).map(claimFromRow);
  }

  async listClaims(wallet: string, limit: number): Promise<GameClaim[]> {
    const result = await this.db.prepare("SELECT * FROM game_claims WHERE wallet = ?1 ORDER BY created_at DESC LIMIT ?2").bind(wallet, Math.max(1, Math.floor(limit))).all<Record<string, unknown>>();
    return (result.results ?? []).map(claimFromRow);
  }

  async markClaimPaid(id: string, signature: string): Promise<boolean> {
    const claim = await this.getClaim(id);
    if (!claim) return false;
    if (claim.status === "PAID") return claim.signature === signature;
    const mine = await this.getMine(claim.mint);
    if (!mine || mine.paid + claim.amount > mine.committed) return false;
    const nextPaid = mine.paid + claim.amount;
    const results = await this.db.batch([
      this.db.prepare(
        "UPDATE game_mines SET paid = ?1, version = version + 1, updated_at = ?2 WHERE mint = ?3 AND version = ?4 AND paid = ?5 AND ?1 <= committed",
      ).bind(nextPaid, Math.floor(Date.now() / 1_000), claim.mint, mine.version, mine.paid),
      this.db.prepare(
        "UPDATE game_claims SET status = 'PAID', signature = ?1, paid_at = ?2 WHERE id = ?3 AND status = 'PENDING'" +
          " AND EXISTS (SELECT 1 FROM game_mines WHERE mint = ?4 AND paid = ?5)",
      ).bind(signature, Math.floor(Date.now() / 1_000), id, claim.mint, nextPaid),
    ]);
    return (results[0]?.meta.changes ?? 0) === 1 && (results[1]?.meta.changes ?? 0) === 1;
  }

  async getReferralCredit(id: string): Promise<ReferralCreditRecord | null> {
    const row = await this.db.prepare("SELECT * FROM game_referral_credits WHERE id = ?1").bind(id).first<Record<string, unknown>>();
    return row ? { id: String(row.id), referrer: String(row.referrer_wallet), referee: String(row.referee_wallet), amount: number(row.ore_amount), week: number(row.week_index), createdAt: number(row.created_at) } : null;
  }

  async referralWeekTotals(referrer: string, week: number): Promise<{ count: number; ore: number }> {
    const row = await this.db.prepare(
      "SELECT credited_count, ore_amount FROM game_referral_weekly_caps WHERE referrer_wallet = ?1 AND week_index = ?2",
    ).bind(referrer, week).first<{ credited_count: number; ore_amount: number }>();
    return { count: number(row?.credited_count), ore: number(row?.ore_amount) };
  }

  async applyReferralCredit(record: ReferralCreditRecord): Promise<boolean> {
    const result = await this.db.prepare(
      "INSERT OR IGNORE INTO game_referral_credits (id, referrer_wallet, referee_wallet, week_index, ore_amount, created_at)" +
        " SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE CAST(?5 AS INTEGER) BETWEEN 1 AND ?7" +
        " AND CAST(?5 AS INTEGER) BETWEEN 1 AND ?7" +
        " AND NOT EXISTS (SELECT 1 FROM game_referral_weekly_caps WHERE referrer_wallet = ?2 AND week_index = ?4 AND (credited_count >= ?8 OR CAST(ore_amount AS INTEGER) + CAST(?5 AS INTEGER) > ?9))" +
        " AND EXISTS (SELECT 1 FROM game_players WHERE wallet = ?2)",
    ).bind(
      record.id, record.referrer, record.referee, record.week, record.amount, record.createdAt,
      250, 25, 6250,
    ).run();
    if (result.meta.changes !== 1) return false;
    const applied = await this.db.prepare(
      "SELECT 1 AS ok FROM game_referral_weekly_caps WHERE referrer_wallet = ?1 AND week_index = ?2" +
        " AND CAST(credited_count AS INTEGER) = (SELECT COUNT(*) FROM game_referral_credits WHERE referrer_wallet = ?1 AND week_index = ?2)" +
        " AND CAST(ore_amount AS INTEGER) = (SELECT SUM(CAST(ore_amount AS INTEGER)) FROM game_referral_credits WHERE referrer_wallet = ?1 AND week_index = ?2)",
    ).bind(record.referrer, record.week).first<{ ok: number }>();
    return number(applied?.ok) === 1;
  }

  async createDiscovery(record: DiscoveryRecord, expectedReserveRemaining: bigint): Promise<GameClaim | null> {
    const existing = await this.getClaim(record.claimId);
    if (existing) return existing;
    const mine = await this.getMine(record.mint);
    if (!mine || mine.remaining !== expectedReserveRemaining || mine.remaining < record.amount) return null;
    const results = await this.db.batch([
      this.db.prepare(
        "INSERT OR IGNORE INTO game_discoveries (id, claim_id, wallet, mint, epoch_index, amount, created_at)" +
          " SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE EXISTS (SELECT 1 FROM game_mines WHERE mint = ?4 AND remaining = CAST(?8 AS TEXT))",
      ).bind(record.id, record.claimId, record.wallet, record.mint, record.epoch, record.amount, record.createdAt, expectedReserveRemaining),
    ]);
    if ((results[0]?.meta.changes ?? 0) !== 1) return this.getClaim(record.claimId);
    return this.getClaim(record.claimId);
  }
}

export function d1GameStore(db: D1Database): D1GameStore {
  return new D1GameStore(db);
}
