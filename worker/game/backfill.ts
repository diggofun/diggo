/**
 * Mining backfill for the millisecond-clock outage (September 2026).
 *
 * The Meteora game path read its clock from `Date.now()` (milliseconds) while every stored
 * timestamp and rule is in seconds, so each 24h shift lasted 86.4 seconds and nothing settled.
 * This module rebuilds what each wallet should hold by replaying the evidenced activations and
 * the five-minute settlement cron through the live functions (`activatePlayer`,
 * `settleActiveShifts`) against an in-memory store, then emits idempotent, version-guarded SQL.
 * It never touches the chain.
 */
import type { GameCoin, GamePlayerState, GameServices } from "./contracts";
import { MAX_UNIX_SECONDS } from "./rules";
import { activatePlayer, settleActiveShifts, type GameHandlerContext } from "./service";
import { MemoryGameStore } from "./store";

export const CRON_SECONDS = 300;

type Row = Record<string, unknown>;

export interface BackfillSnapshot {
  players: Row[];
  balances: Row[];
  mines: Row[];
  claims: Row[];
  pools: Row[];
  /** Consumed `game-activate` challenge nonces that survived pruning. */
  activations: Array<{ wallet: string; consumed_at: number }>;
}

export interface WalletBackfill {
  wallet: string;
  snapshotVersion: number;
  activationEvidence: number[];
  acceptedActivations: number[];
  player: GamePlayerState;
  oreBefore: number;
  oreCredited: number;
  mint: string | null;
  pendingTokens: bigint;
  lastSettledAt: number;
  discoveryEligible: boolean;
  discoveryNote: string;
}

export interface MineBackfill {
  mint: string;
  snapshotVersion: number;
  released: bigint;
  committed: bigint;
  remaining: bigint;
  totalEligiblePower: number;
}

export interface BackfillPlan {
  id: string;
  cutoff: number;
  wallets: WalletBackfill[];
  mines: MineBackfill[];
  sql: string[];
}

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.floor(parsed) : 0;
}

/** Legacy millisecond timestamps to seconds; seconds pass through. */
export function toSeconds(value: unknown): number {
  const parsed = num(value);
  return parsed > MAX_UNIX_SECONDS ? Math.floor(parsed / 1_000) : parsed;
}

function sqlText(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

function coinsFrom(pools: Row[]): GameCoin[] {
  return pools.map((row) => {
    const mint = String(row.base_mint);
    const createdAt = toSeconds(row.created_at);
    return {
      mint,
      symbol: String(row.symbol || mint.slice(0, 6)),
      name: String(row.name || row.symbol || mint.slice(0, 6)),
      createdAt,
      miningStartsAt: createdAt,
      graduated: num(row.is_graduated) === 1,
    };
  });
}

function simulationContext(store: MemoryGameStore, coins: GameCoin[], now: number): GameHandlerContext {
  const services: GameServices = {
    coins: {
      async listActiveMines() { return coins.filter((coin) => !coin.graduated); },
      async getMine(mint) { return coins.find((coin) => coin.mint === mint) ?? null; },
    },
    payout: {
      async prepare() { throw new Error("backfill never pays"); },
      async confirm() { return false; },
      async prepareBatch() { throw new Error("backfill never pays"); },
      async confirmBatch() { return []; },
      async vaultInventory() { return null; },
    },
  };
  return { env: {} as never, services, store, now: () => now };
}

/** Every activation instant the snapshot can prove, in seconds, at or before the cutoff. */
export function activationEvidence(snapshot: BackfillSnapshot, wallet: string, cutoff: number): number[] {
  const player = snapshot.players.find((row) => String(row.wallet) === wallet);
  const times = new Set<number>();
  if (player && num(player.last_activation_at) > 0) times.add(toSeconds(player.last_activation_at));
  for (const row of snapshot.activations) if (row.wallet === wallet && num(row.consumed_at) > 0) times.add(toSeconds(row.consumed_at));
  // A legacy balance anchor is written by the activation that assigned the mine (or by a read
  // inside that activation's 86-second window), so it marks an activation to within 86 seconds.
  for (const row of snapshot.balances) {
    if (String(row.wallet) === wallet && num(row.last_settled_at) > MAX_UNIX_SECONDS) times.add(toSeconds(row.last_settled_at));
  }
  return [...times].filter((time) => time > 0 && time <= cutoff).sort((a, b) => a - b);
}

export async function planMiningBackfill(snapshot: BackfillSnapshot, cutoff: number, id = "mining-clock-2026-09"): Promise<BackfillPlan> {
  if (snapshot.claims.length > 0) throw new Error("Snapshot has game claims; this backfill assumes an unpaid ledger");
  for (const row of snapshot.balances) if (String(row.claimable ?? "0") !== "0") throw new Error(`Balance ${row.wallet} is not zero`);
  for (const row of snapshot.mines) if (String(row.committed ?? "0") !== "0") throw new Error(`Mine ${row.mint} has committed rewards`);

  const coins = coinsFrom(snapshot.pools);
  const store = new MemoryGameStore();
  const activated = snapshot.players.filter((row) => num(row.activated_at) > 0 || num(row.last_activation_at) > 0);
  const evidence = new Map<string, number[]>();
  for (const row of activated) {
    const wallet = String(row.wallet);
    const created = await store.ensurePlayer(wallet, toSeconds(row.created_at), {
      miners: num(row.miners_level) || 1, drills: num(row.drills_level) || 1, carts: num(row.carts_level) || 1,
      foreman: num(row.foreman_level) || 1, storage: num(row.storage_level) || 1,
    });
    await store.savePlayer({ ...created, oreBalance: num(row.ore_balance), oreEarned: num(row.ore_earned), streakFreezes: num(row.streak_freezes) }, 0);
    evidence.set(wallet, activationEvidence(snapshot, wallet, cutoff));
  }

  type Event = { at: number; wallet: string | null };
  const events: Event[] = [];
  for (const [wallet, times] of evidence) for (const at of times) events.push({ at, wallet });
  const first = Math.min(...events.map((event) => event.at));
  if (Number.isFinite(first)) {
    for (let tick = Math.ceil(first / CRON_SECONDS) * CRON_SECONDS; tick < cutoff; tick += CRON_SECONDS) events.push({ at: tick, wallet: null });
  }
  events.push({ at: cutoff, wallet: null });
  // Activations sort before a tick at the same second, as a request would land before the cron.
  events.sort((a, b) => a.at - b.at || (a.wallet === null ? 1 : 0) - (b.wallet === null ? 1 : 0));

  const accepted = new Map<string, number[]>();
  for (const event of events) {
    const context = simulationContext(store, coins, event.at);
    if (event.wallet) {
      const result = await activatePlayer(context, event.wallet);
      if (result.ok) accepted.set(event.wallet, [...(accepted.get(event.wallet) ?? []), event.at]);
    } else {
      const sweep = await settleActiveShifts(context, 10_000);
      if (sweep.failed > 0) throw new Error(`Simulated settlement failed at ${event.at}`);
    }
  }

  const wallets: WalletBackfill[] = [];
  for (const row of activated) {
    const wallet = String(row.wallet);
    const player = (await store.getPlayer(wallet))!;
    const balances = await store.listBalances(wallet);
    const balance = balances.find((entry) => entry.claimable > 0n) ?? balances[0] ?? null;
    const age = cutoff - player.createdAt;
    const discoveryEligible = age >= 7 * 86_400 && player.activeDays >= 5;
    wallets.push({
      wallet,
      snapshotVersion: num(row.version),
      activationEvidence: evidence.get(wallet) ?? [],
      acceptedActivations: accepted.get(wallet) ?? [],
      player,
      oreBefore: num(row.ore_balance),
      oreCredited: player.oreBalance - num(row.ore_balance),
      mint: balance?.mint ?? player.activeMine,
      pendingTokens: balance?.claimable ?? 0n,
      lastSettledAt: balance?.lastSettledAt ?? 0,
      discoveryEligible,
      discoveryNote: discoveryEligible
        ? "eligible by age and play; roll happens live"
        : `not eligible: game account ${(age / 86_400).toFixed(2)} days old (needs 7) and ${player.activeDays} active days (needs 5)`,
    });
  }

  const mines: MineBackfill[] = [];
  for (const row of snapshot.mines) {
    const ledger = await store.getMine(String(row.mint));
    if (!ledger) continue;
    mines.push({
      mint: ledger.mint, snapshotVersion: num(row.version), released: ledger.released, committed: ledger.committed,
      remaining: ledger.remaining, totalEligiblePower: ledger.totalEligiblePower,
    });
  }
  return { id, cutoff, wallets, mines, sql: backfillSql(id, cutoff, wallets, mines) };
}

/**
 * Idempotent SQL. Each wallet row is replaced only from the exact snapshot version it was planned
 * from and only while its marker is absent; the balance and the marker follow only when the row
 * is at snapshot version + 1. Rerunning the file, or finishing a half-applied run, is safe.
 */
export function backfillSql(id: string, cutoff: number, wallets: WalletBackfill[], mines: MineBackfill[]): string[] {
  const sql: string[] = [];
  // Rows that were only ever read carry a millisecond created_at; seconds rows are untouched.
  sql.push(
    "UPDATE game_players SET created_at = created_at / 1000," +
      " updated_at = CASE WHEN updated_at > 99999999999 THEN updated_at / 1000 ELSE updated_at END" +
      " WHERE created_at > 99999999999 AND activated_at = 0 AND last_activation_at = 0;",
  );
  for (const entry of wallets) {
    const marker = sqlText(`${id}:${entry.wallet}`);
    const wallet = sqlText(entry.wallet);
    const p = entry.player;
    sql.push(
      `UPDATE game_players SET created_at = ${p.createdAt}, ore_balance = '${p.oreBalance}', ore_earned = '${p.oreEarned}',` +
        ` streak = ${p.streak}, longest_streak = ${p.longestStreak}, streak_freezes = ${p.streakFreezes},` +
        ` active_until = ${p.activeUntil}, last_activation_at = ${p.lastActivationAt}, activated_at = ${p.activatedAt},` +
        ` last_ore_at = ${p.lastOreAt}, active_mine = ${p.activeMine ? sqlText(p.activeMine) : "NULL"},` +
        ` active_mining_power = '${p.activeMiningPower}', active_days = ${p.activeDays}, valid_activations = ${p.validActivations},` +
        ` version = version + 1, updated_at = ${cutoff}` +
        ` WHERE wallet = ${wallet} AND version = ${entry.snapshotVersion} AND NOT EXISTS (SELECT 1 FROM game_backfills WHERE id = ${marker});`,
    );
    // "Applied" means the row holds exactly what this plan wrote, not merely a bumped version: a
    // concurrent write can also produce snapshot version + 1.
    const applied =
      `EXISTS (SELECT 1 FROM game_players WHERE wallet = ${wallet} AND version = ${entry.snapshotVersion + 1}` +
      ` AND updated_at = ${cutoff} AND last_ore_at = ${p.lastOreAt} AND activated_at = ${p.activatedAt} AND ore_balance = '${p.oreBalance}')`;
    if (entry.mint) {
      const mint = sqlText(entry.mint);
      sql.push(
        `INSERT OR IGNORE INTO game_balances (wallet, mint, claimable, last_settled_at, updated_at)` +
          ` SELECT ${wallet}, ${mint}, '0', 0, ${cutoff} WHERE ${applied} AND NOT EXISTS (SELECT 1 FROM game_backfills WHERE id = ${marker});`,
      );
      sql.push(
        `UPDATE game_balances SET claimable = '${entry.pendingTokens}', last_settled_at = ${entry.lastSettledAt}, updated_at = ${cutoff}` +
          ` WHERE wallet = ${wallet} AND mint = ${mint} AND claimable = '0' AND ${applied}` +
          ` AND NOT EXISTS (SELECT 1 FROM game_backfills WHERE id = ${marker});`,
      );
    }
    sql.push(
      `INSERT OR IGNORE INTO game_backfills (id, wallet, mint, ore_amount, token_amount, detail, applied_at)` +
        ` SELECT ${marker}, ${wallet}, ${entry.mint ? sqlText(entry.mint) : "NULL"}, ${entry.oreCredited}, '${entry.pendingTokens}',` +
        ` ${sqlText(JSON.stringify({ accepted: entry.acceptedActivations, evidence: entry.activationEvidence }))}, ${cutoff} WHERE ${applied};`,
    );
  }
  for (const mine of mines) {
    const marker = sqlText(`${id}:mine:${mine.mint}`);
    const mint = sqlText(mine.mint);
    // The ledger moves only once every wallet paid from it has its own marker, so the mine's
    // committed total always equals the balances actually written.
    const payees = wallets.filter((entry) => entry.mint === mine.mint && entry.pendingTokens > 0n);
    const allPaid = payees.length === 0
      ? "1 = 1"
      : `(SELECT COUNT(*) FROM game_backfills WHERE id IN (${payees.map((entry) => sqlText(`${id}:${entry.wallet}`)).join(", ")})) = ${payees.length}`;
    sql.push(
      `UPDATE game_mines SET released = '${mine.released}', committed = '${mine.committed}', remaining = '${mine.remaining}',` +
        ` total_eligible_power = ${mine.totalEligiblePower}, version = version + 1, updated_at = ${cutoff}` +
        ` WHERE mint = ${mint} AND version = ${mine.snapshotVersion} AND committed = '0' AND ${allPaid}` +
        ` AND NOT EXISTS (SELECT 1 FROM game_backfills WHERE id = ${marker});`,
    );
    sql.push(
      `INSERT OR IGNORE INTO game_backfills (id, wallet, mint, ore_amount, token_amount, detail, applied_at)` +
        ` SELECT ${marker}, NULL, ${mint}, 0, '${mine.committed}', NULL, ${cutoff}` +
        ` WHERE (SELECT committed FROM game_mines WHERE mint = ${mint}) = '${mine.committed}';`,
    );
  }
  return sql;
}
