/**
 * Discovery reads.
 *
 * v4's discovery module was the single largest operator power in the system: it authored the
 * opportunity, rolled the dice from `DISCOVERY_SECRET`, and told the keeper how much to pay. In
 * v2 none of that exists. The roll is `create_discovery_roll` signed by the player, the outcome
 * is `sha256(epoch_seed || owner || window_index)` expanded in order, and the payout is
 * `settle_discovery`, which anyone can send. This module only reads the results - and, crucially,
 * publishes the committed epoch seeds so that anyone can recompute them.
 */
import type { RuntimeEnv } from "./env";
import { apiError, isBase58Address, json } from "./http";
import type { DiscoveryView, EpochSeedView, GlobalBudgetView } from "./v2/types";

interface DiscoveryRow {
  opportunity: string;
  coin: string;
  wallet: string;
  window_index: number;
  day_index: number;
  epoch_index: number;
  status: string;
  rarity: number | null;
  units: string | null;
  value_lamports: string | null;
  budget_lamports: string;
  signature: string;
  block_time: number;
  mint: string | null;
  symbol: string | null;
  decimals: number | null;
}

const DISCOVERY_SELECT = `SELECT d.*, c.mint AS mint, t.symbol AS symbol, t.decimals AS decimals
  FROM discovery_events d
  LEFT JOIN coins c ON c.coin = d.coin
  LEFT JOIN tokens t ON t.mint = c.mint`;

function rowToView(row: DiscoveryRow): DiscoveryView {
  const decimals = row.decimals ?? 6;
  return {
    opportunity: row.opportunity,
    coin: row.coin,
    mint: row.mint,
    symbol: row.symbol,
    wallet: row.wallet,
    windowIndex: row.window_index,
    dayIndex: row.day_index,
    epochIndex: row.epoch_index,
    status: row.status as DiscoveryView["status"],
    rarity: row.rarity,
    units: row.units,
    unitsWhole: row.units === null ? null : Number(row.units) / 10 ** decimals,
    valueLamports: row.value_lamports,
    budgetLamports: row.budget_lamports,
    signature: row.signature,
    blockTime: row.block_time,
  };
}

/** GET /api/player/:wallet/discoveries - a wallet's own rolls, newest first. */
export async function listDiscoveries(
  _request: Request,
  env: RuntimeEnv,
  wallet: string,
): Promise<Response> {
  if (!isBase58Address(wallet)) return apiError("Invalid wallet");
  const rows = await env.DB.prepare(
    `${DISCOVERY_SELECT} WHERE d.wallet = ?1 ORDER BY d.block_time DESC LIMIT 200`,
  )
    .bind(wallet)
    .all<DiscoveryRow>();
  return json({ discoveries: (rows.results ?? []).map(rowToView) });
}

/** GET /api/coins/:mint/discoveries - one coin's rolls, newest first. */
export async function listCoinDiscoveries(
  _request: Request,
  env: RuntimeEnv,
  mint: string,
): Promise<Response> {
  if (!isBase58Address(mint)) return apiError("Invalid mint");
  const rows = await env.DB.prepare(
    `${DISCOVERY_SELECT} WHERE c.mint = ?1 ORDER BY d.block_time DESC LIMIT 200`,
  )
    .bind(mint)
    .all<DiscoveryRow>();
  return json({ discoveries: (rows.results ?? []).map(rowToView) });
}

/**
 * GET /api/discovery/seeds?coin=...&limit=...
 *
 * The committed epoch seeds. This is the endpoint that makes the whole scheme auditable: with a
 * seed in hand, anyone can compute `sha256(seed || owner || window_index)` for any wallet and
 * window, expand it the way the program does, and check a payout without trusting this server.
 *
 * The v4 equivalent published an operator's commit-reveal pair. There is no commitment to
 * publish here because there is no operator: the seed is a slot hash the program recorded before
 * the epoch's rolls could know it.
 */
export async function listEpochSeeds(request: Request, env: RuntimeEnv): Promise<Response> {
  const url = new URL(request.url);
  const coin = url.searchParams.get("coin");
  const limit = Math.min(500, Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "", 10) || 100));
  const rows = coin
    ? await env.DB.prepare(
        "SELECT s.*, c.mint AS mint FROM epoch_seeds s LEFT JOIN coins c ON c.coin = s.coin" +
          " WHERE s.coin = ?1 ORDER BY s.epoch_index DESC LIMIT ?2",
      )
        .bind(coin, limit)
        .all<{
          coin: string;
          mint: string | null;
          epoch_index: number;
          seed: string;
          target_slot: string;
          recorded_slot: string;
          signature: string;
          block_time: number;
        }>()
    : await env.DB.prepare(
        "SELECT s.*, c.mint AS mint FROM epoch_seeds s LEFT JOIN coins c ON c.coin = s.coin" +
          " ORDER BY s.epoch_index DESC LIMIT ?1",
      )
        .bind(limit)
        .all<{
          coin: string;
          mint: string | null;
          epoch_index: number;
          seed: string;
          target_slot: string;
          recorded_slot: string;
          signature: string;
          block_time: number;
        }>();
  const seeds: EpochSeedView[] = (rows.results ?? []).map((row) => ({
    coin: row.coin,
    mint: row.mint,
    epochIndex: row.epoch_index,
    seed: row.seed,
    targetSlot: row.target_slot,
    recordedSlot: row.recorded_slot,
    signature: row.signature,
    blockTime: row.block_time,
  }));
  return json({
    seeds,
    derivation: "sha256(seed_hex || owner_pubkey_bytes || window_index_u16_le)",
    note: "the seed is the SlotHashes entry the program recorded; it is not an operator value",
  });
}

/** GET /api/discovery/budget - the protocol-wide daily discovery budget, mirrored. */
export async function globalBudget(_request: Request, env: RuntimeEnv): Promise<Response> {
  const rows = await env.DB.prepare(
    "SELECT day_index, cap_lamports, spent_lamports, roll_count, settled_count, closed" +
      " FROM global_budgets ORDER BY day_index DESC LIMIT 14",
  ).all<{
    day_index: number;
    cap_lamports: string;
    spent_lamports: string;
    roll_count: number;
    settled_count: number;
    closed: number;
  }>();
  const budgets: GlobalBudgetView[] = (rows.results ?? []).map((row) => ({
    dayIndex: row.day_index,
    capLamports: row.cap_lamports,
    spentLamports: row.spent_lamports,
    rollCount: row.roll_count,
    settledCount: row.settled_count,
    closed: row.closed === 1,
  }));
  return json({ budgets });
}

/**
 * The per-account budget a wallet has charged, read straight from its mirrored PlayerAccount.
 *
 * Charging happens at roll creation on-chain and this only reports it, which is why the numbers
 * here always match the program's own windows rather than a server's idea of them.
 */
export async function discoveryBudgetFor(
  env: RuntimeEnv,
  wallet: string,
): Promise<{ dayIndex: number; weekIndex: number; spentDayLamports: string; spentWeekLamports: string; rollCount: number } | null> {
  const row = await env.DB.prepare(
    "SELECT day_index, week_index, spent_day_lamports, spent_week_lamports, roll_count" +
      " FROM player_accounts WHERE wallet = ?1",
  )
    .bind(wallet)
    .first<{
      day_index: number;
      week_index: number;
      spent_day_lamports: string;
      spent_week_lamports: string;
      roll_count: number;
    }>();
  if (!row) return null;
  return {
    dayIndex: row.day_index,
    weekIndex: row.week_index,
    spentDayLamports: row.spent_day_lamports,
    spentWeekLamports: row.spent_week_lamports,
    rollCount: row.roll_count,
  };
}
