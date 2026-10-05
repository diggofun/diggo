/**
 * Sponsored mines: tokens of an existing coin, deposited into the mining vault by a project, that
 * bots dig like a launch.
 *
 * - The game reads them through the same coin source as Meteora launches (worker/modes/meteora.ts),
 *   with their own reserve, decimals and release period.
 * - They pay out from the start (isPayableCoin): the coin already trades, and registration proves
 *   the vault holds the whole reserve.
 * - Only an admin can register or close one, each change signed by the admin wallet (step-up).
 *
 * GET  /api/sponsored-mines               the public list with remaining counters
 * POST /api/admin/sponsored-mines         register { mint, symbol, name, sponsor, sponsorUrl?, reserve, days? }
 * POST /api/admin/sponsored-mines/close   { mint }
 */
import { MINING_RESERVE, type GameCoin } from "./game/contracts";
import { miningEndsAt } from "./game/rules";
import type { MiningSchedule } from "../shared/miningSchedule";
import { adminActor, requireAdminStepUp, stepUpPayload, writeAudit, type AdminStepUpProof } from "./admin";
import type { RuntimeEnv } from "./env";
import { apiError, isBase58Address, json, readJson } from "./http";
import { METEORA_TOKEN_PROGRAM_ID } from "./meteora/types";
import { decodeTokenAccountAmount, decodeTokenMint, deriveAssociatedTokenAddress, readAccount } from "./meteora/rpc";
import type { MeteoraRpcEnv } from "./meteora/types";
import { parseSponsoredMineInput, wholeToRaw, type SponsoredMineView } from "../shared/sponsoredMine";

/** The latest period change for a mine, joined as `ms`; columns are prefixed so they never collide. */
export const SCHEDULE_COLUMNS = "ms.anchor_at AS schedule_anchor_at, ms.anchor_released AS schedule_anchor_released, ms.ends_at AS schedule_ends_at, ms.updated_at AS schedule_updated_at";
export const SCHEDULE_JOIN = "LEFT JOIN mine_schedules ms ON ms.mint = ";

export function scheduleOf(row: Record<string, unknown>): MiningSchedule | undefined {
  const anchorAt = Number(row.schedule_anchor_at);
  const endsAt = Number(row.schedule_ends_at);
  const anchorReleased = String(row.schedule_anchor_released ?? "");
  if (!Number.isSafeInteger(anchorAt) || !Number.isSafeInteger(endsAt) || endsAt <= anchorAt || !/^[0-9]+$/.test(anchorReleased)) return undefined;
  return { anchorAt, anchorReleased, endsAt };
}

export interface SponsoredMineRow {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  reserve: string;
  sponsor: string;
  sponsor_url: string | null;
  mining_starts_at: number;
  mining_seconds: number;
  status: string;
  created_at: number;
  sponsor_wallet?: string | null;
  schedule_anchor_at?: number | null;
  schedule_anchor_released?: string | null;
  schedule_ends_at?: number | null;
}

const COLUMNS = "s.mint, s.symbol, s.name, s.decimals, s.reserve, s.sponsor, s.sponsor_url, s.mining_starts_at, s.mining_seconds, s.status, s.created_at, s.sponsor_wallet, " + SCHEDULE_COLUMNS;
const FROM = "FROM sponsored_mines s LEFT JOIN mine_schedules ms ON ms.mint = s.mint";

/**
 * The mine as the game sees it. A closed mine reports `graduated` so no crew is assigned to it and
 * nothing more accrues; `sponsored` keeps everything already earned payable.
 */
export function sponsoredCoin(row: SponsoredMineRow): GameCoin {
  const schedule = scheduleOf(row as unknown as Record<string, unknown>);
  return {
    ...(schedule ? { schedule } : {}),
    mint: row.mint,
    symbol: row.symbol,
    name: row.name,
    createdAt: Number(row.created_at) || 0,
    miningStartsAt: Number(row.mining_starts_at) || 0,
    graduated: row.status !== "ACTIVE",
    sponsored: true,
    reserve: /^[1-9][0-9]*$/.test(row.reserve) ? row.reserve : MINING_RESERVE.toString(),
    decimals: Number(row.decimals),
    miningSeconds: Number(row.mining_seconds),
    sponsor: row.sponsor,
  };
}

export async function activeSponsoredCoins(db: D1Database): Promise<GameCoin[]> {
  const result = await db.prepare(`SELECT ${COLUMNS} ${FROM} WHERE s.status = 'ACTIVE' ORDER BY s.created_at DESC`)
    .all<SponsoredMineRow>()
    .catch(() => null);
  return (result?.results ?? []).map(sponsoredCoin);
}

export async function sponsoredCoinByMint(db: D1Database, mint: string): Promise<GameCoin | null> {
  const row = await db.prepare(`SELECT ${COLUMNS} ${FROM} WHERE s.mint = ?1`)
    .bind(mint)
    .first<SponsoredMineRow>()
    .catch(() => null);
  return row ? sponsoredCoin(row) : null;
}

function whole(raw: string | null | undefined, decimals: number): number {
  try {
    const units = BigInt(raw && /^[0-9]+$/.test(raw) ? raw : "0");
    const scale = 10n ** BigInt(decimals);
    return Number(units / scale) + Number(units % scale) / Number(scale);
  } catch {
    return 0;
  }
}

/** GET /api/sponsored-mines */
export async function listSponsoredMines(env: RuntimeEnv): Promise<Response> {
  const now = Math.floor(Date.now() / 1_000);
  const result = await env.DB.prepare(
    `SELECT ${COLUMNS}, m.remaining, m.committed,
            (SELECT COUNT(*) FROM game_players p WHERE p.active_mine = s.mint AND p.active_until > ?1) AS miners
       ${FROM} LEFT JOIN game_mines m ON m.mint = s.mint
      ORDER BY s.status = 'ACTIVE' DESC, s.created_at DESC LIMIT 50`,
  ).bind(now).all<SponsoredMineRow & { remaining: string | null; committed: string | null; miners: number }>()
    .catch(() => null);
  const mines: SponsoredMineView[] = (result?.results ?? []).map((row) => {
    const decimals = Number(row.decimals);
    return {
      mint: row.mint,
      symbol: row.symbol,
      name: row.name,
      sponsor: row.sponsor,
      sponsorUrl: row.sponsor_url,
      status: row.status === "ACTIVE" ? "ACTIVE" : "CLOSED",
      startsAt: Number(row.mining_starts_at),
      endsAt: miningEndsAt(sponsoredCoin(row)),
      sponsorWallet: row.sponsor_wallet ?? null,
      reserve: whole(row.reserve, decimals),
      // A mine nobody has dug yet has no ledger row: all of it remains.
      remaining: whole(row.remaining ?? row.reserve, decimals),
      mined: whole(row.committed ?? "0", decimals),
      miners: Number(row.miners) || 0,
    };
  });
  return json({ mines }, { headers: { "cache-control": "public, max-age=30" } });
}

function rpcEnv(env: RuntimeEnv): MeteoraRpcEnv {
  const extra = env as RuntimeEnv & { DIGGO_RPC_URL?: string };
  return { ...env, DIGGO_RPC_URL: String(extra.DIGGO_RPC_URL || "") } as MeteoraRpcEnv;
}

/**
 * What the chain says about a mint the admin wants to register: its decimals, and how much of it
 * the vault holds. Throws with a message meant for the admin when it cannot be used.
 */
export async function inspectSponsoredMint(env: MeteoraRpcEnv, mint: string, vault: string): Promise<{ decimals: number; vaultBalance: bigint }> {
  const account = await readAccount(env, mint);
  if (!account) throw new Error("That mint does not exist on this cluster");
  if (account.owner !== METEORA_TOKEN_PROGRAM_ID) {
    throw new Error("Only classic SPL Token mints can be mined (Token-2022 is not supported)");
  }
  const { decimals } = decodeTokenMint(account.data);
  const vaultAccount = await readAccount(env, deriveAssociatedTokenAddress(mint, vault));
  return { decimals, vaultBalance: vaultAccount ? decodeTokenAccountAmount(vaultAccount.data) : 0n };
}

type RegisterBody = Record<string, unknown> & { stepUp?: AdminStepUpProof };

/** POST /api/admin/sponsored-mines */
export async function adminRegisterSponsoredMine(request: Request, env: RuntimeEnv): Promise<Response> {
  const actor = await adminActor(env, request);
  if (!actor) return apiError("Admin session required", 401);
  let body: RegisterBody;
  try {
    body = await readJson<RegisterBody>(request, 4_096);
  } catch {
    return apiError("Invalid request");
  }
  const parsed = parseSponsoredMineInput(body);
  if (!parsed.ok) return apiError(parsed.error);
  const input = parsed.value;
  const proof = await requireAdminStepUp(env, { actor, action: "sponsor.register", payload: stepUpPayload(body), proof: body.stepUp });
  if (!proof.ok) return proof.response;

  const taken = await env.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM sponsored_mines WHERE mint = ?1) + (SELECT COUNT(*) FROM meteora_pools WHERE base_mint = ?1)" +
      " + (SELECT COUNT(*) FROM game_mines WHERE mint = ?1) AS n",
  ).bind(input.mint).first<{ n: number }>();
  // One ledger per mint: a launch, or an old mine, already owns this mint's reserve and vault balance.
  if (Number(taken?.n ?? 0) > 0) return apiError("This mint already has a mine", 409);

  const vault = String((env as RuntimeEnv & { MINING_VAULT_PUBLIC_KEY?: string }).MINING_VAULT_PUBLIC_KEY || "").trim();
  if (!isBase58Address(vault)) return apiError("The mining vault is not configured", 503);
  let decimals: number;
  let vaultBalance: bigint;
  try {
    ({ decimals, vaultBalance } = await inspectSponsoredMint(rpcEnv(env), input.mint, vault));
  } catch (error) {
    return apiError(error instanceof Error ? error.message : "The mint could not be read", 400);
  }
  const reserve = wholeToRaw(input.reserveWhole, decimals);
  // The deposit must already be in the vault: a mine promises exactly what the vault can pay.
  if (vaultBalance < reserve) {
    return apiError(`The vault holds ${whole(vaultBalance.toString(), decimals).toLocaleString("en-US")} ${input.symbol}; deposit the reserve first`, 409);
  }
  const now = Math.floor(Date.now() / 1_000);
  const seconds = input.days * 86_400;
  try {
    await env.DB.prepare(
      "INSERT INTO sponsored_mines (mint, symbol, name, decimals, reserve, sponsor, sponsor_url, mining_starts_at, mining_seconds, status, created_by, created_at, updated_at, sponsor_wallet)" +
        " VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'ACTIVE', ?10, ?8, ?8, ?11)",
    ).bind(input.mint, input.symbol, input.name, decimals, reserve.toString(), input.sponsor, input.sponsorUrl, now, seconds, actor, input.sponsorWallet).run();
  } catch {
    return apiError("This mint already has a mine", 409);
  }
  await writeAudit(env, actor, "sponsor.register", input.mint, {
    symbol: input.symbol, sponsor: input.sponsor, reserve: reserve.toString(), decimals, days: input.days, stepUp: proof.nonce,
  });
  return json({ mint: input.mint, decimals, reserve: reserve.toString(), startsAt: now, endsAt: now + seconds }, { headers: { "cache-control": "no-store" } });
}

/** POST /api/admin/sponsored-mines/close */
export async function adminCloseSponsoredMine(request: Request, env: RuntimeEnv): Promise<Response> {
  const actor = await adminActor(env, request);
  if (!actor) return apiError("Admin session required", 401);
  let body: RegisterBody;
  try {
    body = await readJson<RegisterBody>(request, 1_024);
  } catch {
    return apiError("Invalid request");
  }
  if (!isBase58Address(body.mint)) return apiError("Invalid mint");
  const proof = await requireAdminStepUp(env, { actor, action: "sponsor.close", payload: stepUpPayload(body), proof: body.stepUp });
  if (!proof.ok) return proof.response;
  const now = Math.floor(Date.now() / 1_000);
  const result = await env.DB.prepare("UPDATE sponsored_mines SET status = 'CLOSED', updated_at = ?2 WHERE mint = ?1 AND status = 'ACTIVE'")
    .bind(body.mint, now)
    .run();
  const closed = (result.meta?.changes ?? 0) === 1;
  await writeAudit(env, actor, "sponsor.close", body.mint, { closed, stepUp: proof.nonce });
  return json({ mint: body.mint, closed }, { headers: { "cache-control": "no-store" } });
}
