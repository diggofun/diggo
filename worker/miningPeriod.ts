/**
 * POST /api/mines/period { mint, days }
 *
 * Lets the people behind a mine choose how long it takes to release its reserve:
 * - a launch: the pool's creator (the wallet that created the coin on the Diggo config);
 * - a sponsored mine: the sponsor's wallet the admin registered with it.
 * Admins can change either. A change keeps everything already released and spreads the rest over
 * the new period from now (worker/game/rules.ts rescheduleMining), so no player loses what they dug.
 */
import { isAdminWallet } from "./admin";
import { sessionWallet } from "./auth";
import type { RuntimeEnv } from "./env";
import { coinReserve, type GameEnv } from "./game/contracts";
import { d1GameStore } from "./game/d1-store";
import { rescheduleMining } from "./game/rules";
import { apiError, checkRateLimit, checkWalletRateLimit, isBase58Address, json, readJson } from "./http";
import { meteoraCoinSource } from "./modes/meteora";
import { MINING_PERIOD_CHANGE_COOLDOWN_SECONDS, parseMiningDays } from "../shared/miningSchedule";

export type MiningPeriodResult =
  | { ok: true; mint: string; days: number; endsAt: number }
  | { ok: false; status: number; error: string };

interface MineOwner {
  owner: string | null;
  open: boolean;
}

/** Who may change this mine's period, and whether it is still being mined. Null: not a Diggo mine. */
async function mineOwner(env: RuntimeEnv, mint: string): Promise<MineOwner | null> {
  const sponsored = await env.DB.prepare("SELECT sponsor_wallet, status FROM sponsored_mines WHERE mint = ?1")
    .bind(mint)
    .first<{ sponsor_wallet: string | null; status: string }>()
    .catch(() => null);
  if (sponsored) return { owner: sponsored.sponsor_wallet, open: sponsored.status === "ACTIVE" };
  const config = String((env as RuntimeEnv & { METEORA_DBC_CONFIG?: string }).METEORA_DBC_CONFIG || "");
  if (!config) return null;
  const pool = await env.DB.prepare("SELECT creator, is_graduated FROM meteora_pools WHERE config = ?1 AND base_mint = ?2")
    .bind(config, mint)
    .first<{ creator: string; is_graduated: number }>();
  return pool ? { owner: pool.creator, open: Number(pool.is_graduated) !== 1 } : null;
}

/** Sets the mining period of `mint` to `days` from `now`, on behalf of `actor`. */
export async function applyMiningPeriod(
  env: RuntimeEnv,
  input: { mint: string; days: unknown; actor: string; now?: number },
): Promise<MiningPeriodResult> {
  const days = parseMiningDays(input.days);
  if (days === null) return { ok: false, status: 400, error: "Choose a mining period between 1 day and 10 years" };
  if (!isBase58Address(input.mint)) return { ok: false, status: 400, error: "Invalid mint" };
  const now = input.now ?? Math.floor(Date.now() / 1_000);
  const owner = await mineOwner(env, input.mint);
  if (!owner) return { ok: false, status: 404, error: "Mine not found" };
  const admin = isAdminWallet(env, input.actor);
  if (!admin && (owner.owner === null || owner.owner !== input.actor)) {
    return { ok: false, status: 403, error: "Only the creator of this coin or mine can change its mining period" };
  }
  if (!owner.open) return { ok: false, status: 409, error: "This mine is closed" };

  const previous = await env.DB.prepare("SELECT updated_at FROM mine_schedules WHERE mint = ?1")
    .bind(input.mint)
    .first<{ updated_at: number }>();
  if (previous && !admin && now - Number(previous.updated_at) < MINING_PERIOD_CHANGE_COOLDOWN_SECONDS) {
    const hours = Math.ceil((Number(previous.updated_at) + MINING_PERIOD_CHANGE_COOLDOWN_SECONDS - now) / 3_600);
    return { ok: false, status: 429, error: `The mining period can change once a day. Try again in ${hours} h.` };
  }

  const coin = await meteoraCoinSource(env as GameEnv).getMine(input.mint);
  if (!coin) return { ok: false, status: 404, error: "Mine not found" };
  const ledger = await d1GameStore(env.DB).getMine(input.mint);
  const total = ledger?.initialReserve ?? coinReserve(coin);
  if (ledger && ledger.remaining <= 0n) return { ok: false, status: 409, error: "This mine is fully mined" };
  const schedule = rescheduleMining(coin, total, ledger?.released ?? 0n, now, days);
  await env.DB.prepare(
    "INSERT INTO mine_schedules (mint, anchor_at, anchor_released, ends_at, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)" +
      " ON CONFLICT(mint) DO UPDATE SET anchor_at = excluded.anchor_at, anchor_released = excluded.anchor_released," +
      " ends_at = excluded.ends_at, updated_by = excluded.updated_by, updated_at = excluded.updated_at",
  ).bind(input.mint, schedule.anchorAt, schedule.anchorReleased, schedule.endsAt, input.actor, now).run();
  return { ok: true, mint: input.mint, days, endsAt: schedule.endsAt };
}

/** POST /api/mines/period */
export async function setMiningPeriod(request: Request, env: RuntimeEnv): Promise<Response> {
  const wallet = await sessionWallet(request, env);
  if (!wallet) return apiError("Wallet session required", 401);
  if (!(await checkRateLimit(request, env, "mine-period", 20)) || !(await checkWalletRateLimit(env, wallet, "mine-period", 20, 60))) {
    return apiError("Too many requests", 429);
  }
  let body: { mint?: unknown; days?: unknown };
  try {
    body = await readJson<{ mint?: unknown; days?: unknown }>(request, 1_024);
  } catch {
    return apiError("Invalid request");
  }
  const result = await applyMiningPeriod(env, { mint: String(body.mint ?? ""), days: body.days, actor: wallet });
  if (!result.ok) return apiError(result.error, result.status);
  return json({ mint: result.mint, days: result.days, endsAt: result.endsAt }, { headers: { "cache-control": "no-store" } });
}
