/**
 * Player reads. The game itself is the PlayerAccount PDA; this module only presents it.
 *
 * The v4 `players` table held activation, streak, ORE and crew levels, and the worker decided
 * all of them. v2 keeps a profile row (created_at plus the risk advisory columns) and mirrors the
 * program's fields beside it, so a profile read is a join and never an RPC.
 */
import type { RuntimeEnv } from "./env";
import { apiError, isBase58Address, json } from "./http";
import { address } from "@solana/kit";
import { derivePlayerPda } from "./v2/program";
import type {
  ActivationState,
  CrewLevelsView,
  MiningPositionView,
  PlayerAccountView,
  PlayerProfileView,
  RiskStateName,
} from "./v2/types";
import { usernameFor } from "./profile";
import { CREW_COMPONENTS } from "../shared/crew";
import {
  DIGGO_CONFIG,
  crewPower,
  crewTier,
  oreCapacity,
  type CrewLevels,
} from "../shared/economics";

/**
 * The profile row: what exists before a wallet ever activates, plus the mirrors the indexer
 * denormalises onto it. Every `*_at` field is a mirror of the program's own value.
 */
export interface PlayerRow {
  wallet: string;
  created_at: number;
  risk_state: string;
  risk_score: number;
  indexed_at: number | null;
  active_mint: string | null;
  last_activation_at: number | null;
  activation_expires_at: number | null;
  ore_balance: string | null;
  streak: number | null;
  streak_freezes: number | null;
  active_days: number | null;
}

/** One row of the mirrored PlayerAccount. */
export interface PlayerAccountRow {
  player: string;
  wallet: string;
  created_slot: string;
  created_at: number;
  active_until: number;
  last_activation_at: number;
  streak: number;
  longest_streak: number;
  valid_activations: number;
  active_days: number;
  streak_freezes: number;
  miners_level: number;
  drills_level: number;
  carts_level: number;
  foreman_level: number;
  storage_level: number;
  ore_balance: string;
  ore_earned: string;
  ore_spent: string;
  active_mine: string;
  day_index: number;
  week_index: number;
  spent_day_lamports: string;
  spent_week_lamports: string;
  roll_window: number;
  roll_count: number;
  last_roll_at: number;
  bond_lamports: string;
  bond_locked_at: number;
  unbond_available_at: number;
  bond_source: number;
  bond_sponsor_vault: string;
  indexed_at: number;
}

export function crewLevelsOf(row: {
  miners_level: number;
  drills_level: number;
  carts_level: number;
  foreman_level: number;
  storage_level: number;
}): CrewLevelsView {
  const levels = {
    miners: row.miners_level,
    drills: row.drills_level,
    carts: row.carts_level,
    foreman: row.foreman_level,
    storage: row.storage_level,
  };
  return {
    ...levels,
    total: levels.miners + levels.drills + levels.carts + levels.foreman + levels.storage,
  };
}

/** The row a wallet with no mirrored PlayerAccount is read as: every level zero, which is no crew. */
const NO_CREW_ROW = {
  miners_level: 0,
  drills_level: 0,
  carts_level: 0,
  foreman_level: 0,
  storage_level: 0,
};

/** The same wallet as the profile's own crew view, which is what a tier and a total read. */
const NO_CREW_LEVELS: CrewLevelsView = crewLevelsOf(NO_CREW_ROW);

/**
 * Whether a mirrored crew states a crew at all, and therefore whether it can be priced.
 *
 * `crewPower`, `oreCapacity` and the upgrade costs are defined for `crew.minLevel..maxLevel` and
 * index their tables by level, so they reject a zeroed row outright rather than answer zero. Two
 * mirrors land there: one the indexer has not reached yet, whose columns are all zero, and one whose
 * levels fall outside the configured range, which is a decode or indexing fault. Neither states a
 * real crew, so neither can state a real power, capacity or cost. `worker/cosmetics.ts` asks the
 * same question before it prices an achievement payout, where the answer is "defer until the mirror
 * arrives" rather than "report zero".
 */
export function crewLevelsUsable(levels: CrewLevels): boolean {
  for (const component of CREW_COMPONENTS) {
    const level = levels[component];
    if (
      !Number.isInteger(level) ||
      level < DIGGO_CONFIG.crew.minLevel ||
      level > DIGGO_CONFIG.crew.maxLevel
    ) {
      return false;
    }
  }
  return true;
}

/**
 * The crew numbers a profile shows, from the levels it mirrors.
 *
 * A wallet with no crew is reported as a zero crew - zero power, zero capacity, the base tier. That
 * is the fact about a wallet the indexer has not reached yet, and it is the only honest answer for a
 * mirror that does not state a crew: clamping such levels up to `crew.minLevel` would invent an
 * upgrade nobody bought, and pricing them would throw.
 *
 * The levels themselves are left alone; the caller reports them exactly as mirrored, so a mirror
 * that states no crew stays visible instead of being smoothed into a plausible one. When the row
 * exists that is a fault rather than a new player, so it is logged.
 */
export function crewStatsOf(
  levels: CrewLevelsView,
  indexed: boolean,
): { power: number; capacity: number; tier: string } {
  if (!crewLevelsUsable(levels)) {
    if (indexed) {
      console.error(JSON.stringify({ event: "player.crew_mirror_unusable", levels }));
    }
    return { power: 0, capacity: 0, tier: crewTier(NO_CREW_LEVELS).name };
  }
  return {
    power: crewPower(levels),
    capacity: oreCapacity(levels),
    tier: crewTier(levels).name,
  };
}

/** Activation is a fact about the program's own window, so it is read, never inferred. */
export function activationStateOf(row: PlayerAccountRow | null, now: number): ActivationState {
  if (!row) return "NEVER_ACTIVATED";
  return row.active_until > now ? "ACTIVE" : "PAUSED";
}

export async function loadPlayerRow(env: RuntimeEnv, wallet: string): Promise<PlayerRow | null> {
  return env.DB.prepare("SELECT * FROM players WHERE wallet = ?1").bind(wallet).first<PlayerRow>();
}

export async function loadPlayerAccount(
  env: RuntimeEnv,
  wallet: string,
): Promise<PlayerAccountRow | null> {
  return env.DB.prepare("SELECT * FROM player_accounts WHERE wallet = ?1")
    .bind(wallet)
    .first<PlayerAccountRow>();
}

/**
 * A wallet's crew levels, zeroed when it has never initialized its PlayerAccount.
 *
 * Zero is the right default for a profile rather than an error: a wallet with no PDA has no crew.
 * It is not a level the protocol's tables can price, though - zero sits below `crew.minLevel` - so a
 * caller that derives power, capacity or an upgrade cost from these levels has to ask
 * `crewLevelsUsable` first rather than pass them on. The program derives the power that matters from
 * its own copy of them.
 */
export async function crewLevelsForWallet(
  env: RuntimeEnv,
  wallet: string,
): Promise<CrewLevelsView> {
  const row = await loadPlayerAccount(env, wallet);
  return crewLevelsOf(row ?? NO_CREW_ROW);
}

/**
 * A wallet's profile row, created on first sight.
 *
 * The row is off-chain because a username and a support history are not consensus facts. It
 * carries no game value: activation, ORE and crew all come from the PDA beside it.
 */
export async function getOrCreatePlayer(env: RuntimeEnv, wallet: string): Promise<PlayerRow> {
  const existing = await loadPlayerRow(env, wallet);
  if (existing) return existing;
  const now = Math.floor(Date.now() / 1_000);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO players (wallet, created_at, risk_state, risk_score)" +
      " VALUES (?1, ?2, 'NORMAL', 0)",
  )
    .bind(wallet, now)
    .run();
  return (
    (await loadPlayerRow(env, wallet)) ?? {
      wallet,
      created_at: now,
      risk_state: "NORMAL",
      risk_score: 0,
      indexed_at: null,
      active_mint: null,
      last_activation_at: null,
      activation_expires_at: null,
      ore_balance: null,
      streak: null,
      streak_freezes: null,
      active_days: null,
    }
  );
}

/** The flat bond the program holds for this wallet, as the UI needs to describe it. */
export function bondView(row: PlayerAccountRow | null, now: number) {
  const lamports = row ? BigInt(row.bond_lamports) : 0n;
  return {
    lamports: lamports.toString(),
    sol: Number(lamports) / 1_000_000_000,
    source: (row?.bond_source === 1 ? "SPONSOR" : "SELF") as "SELF" | "SPONSOR",
    sponsorVault:
      row && row.bond_source === 1 && row.bond_sponsor_vault ? row.bond_sponsor_vault : null,
    lockedAt: row?.bond_locked_at ?? 0,
    unbondAvailableAt: row?.unbond_available_at ?? 0,
    posted: lamports > 0n,
    cooldownActive: (row?.unbond_available_at ?? 0) > now,
  };
}

/**
 * The player's view, assembled from mirrors only.
 *
 * `indexed: false` is not an error: a wallet that has never sent `initialize_player` has no PDA
 * and therefore no game state, which is exactly what the response says - including a zero crew.
 * The crew numbers come from `crewStatsOf`, which prices a mirror only when it states a real crew.
 */
export async function playerAccountView(
  env: RuntimeEnv,
  wallet: string,
  now: number,
): Promise<PlayerAccountView> {
  const [row, profile] = await Promise.all([loadPlayerAccount(env, wallet), loadPlayerRow(env, wallet)]);
  const levels = crewLevelsOf(row ?? NO_CREW_ROW);
  const player =
    row?.player ?? (await derivePlayerPda(address(env.DIGGO_PROGRAM_ID), address(wallet)));
  const bond = bondView(row, now);
  const crew = crewStatsOf(levels, row !== null);
  return {
    player,
    wallet,
    indexed: row !== null,
    createdSlot: row?.created_slot ?? "0",
    createdAt: row?.created_at ?? 0,
    activeUntil: row?.active_until ?? 0,
    lastActivationAt: row?.last_activation_at ?? 0,
    activationState: activationStateOf(row, now),
    streak: row?.streak ?? 0,
    longestStreak: row?.longest_streak ?? 0,
    validActivations: row?.valid_activations ?? 0,
    activeDays: row?.active_days ?? 0,
    streakFreezes: row?.streak_freezes ?? 0,
    crewLevels: levels,
    crewPower: crew.power,
    crewTier: crew.tier,
    oreBalance: Number(row?.ore_balance ?? 0),
    oreEarned: Number(row?.ore_earned ?? 0),
    oreSpent: Number(row?.ore_spent ?? 0),
    oreCapacity: crew.capacity,
    activeMine: row?.active_mine ?? "",
    discovery: {
      dayIndex: row?.day_index ?? 0,
      weekIndex: row?.week_index ?? 0,
      spentDayLamports: row?.spent_day_lamports ?? "0",
      spentWeekLamports: row?.spent_week_lamports ?? "0",
      rollWindow: row?.roll_window ?? 0,
      rollCount: row?.roll_count ?? 0,
      lastRollAt: row?.last_roll_at ?? 0,
    },
    bond,
    bonded: bond.posted,
    starterEfficiencyBps: await starterEfficiencyBps(env),
    riskState: (profile?.risk_state ?? "NORMAL") as RiskStateName,
  };
}

async function starterEfficiencyBps(env: RuntimeEnv): Promise<number> {
  const row = await env.DB.prepare("SELECT starter_efficiency_bps FROM protocol_config WHERE id = 1")
    .first<{ starter_efficiency_bps: number }>();
  return row?.starter_efficiency_bps ?? 2_500;
}

/** A wallet's positions, from the index. */
export async function playerPositions(
  env: RuntimeEnv,
  wallet: string,
): Promise<MiningPositionView[]> {
  const rows = await env.DB.prepare(
    "SELECT p.*, c.mint AS mint, t.symbol AS symbol, c.epoch_length AS epoch_length" +
      " FROM mining_positions_v2 p" +
      " LEFT JOIN coins c ON c.coin = p.coin" +
      " LEFT JOIN tokens t ON t.mint = c.mint" +
      " WHERE p.owner = ?1 ORDER BY p.assigned_power DESC",
  )
    .bind(wallet)
    .all<{
      position: string;
      coin: string;
      mint: string | null;
      symbol: string | null;
      owner: string;
      assigned_power: string;
      pending_reward: string;
      tranche: number;
      created_slot: string;
    }>();
  return (rows.results ?? []).map((row) => ({
    position: row.position,
    coin: row.coin,
    mint: row.mint,
    symbol: row.symbol,
    owner: row.owner,
    assignedPower: row.assigned_power,
    pendingReward: row.pending_reward,
    pendingRewardWhole: Number(row.pending_reward) / 1_000_000,
    tranche: row.tranche === 1 ? "STARTER" : "BONDED",
    createdSlot: row.created_slot,
  }));
}

/**
 * GET /api/player/:wallet
 *
 * The profile is public, as it was in v4: a wallet's username, its on-chain account and its
 * positions. Nothing here is privileged and nothing here is operator-authored.
 */
export async function playerProfile(
  _request: Request,
  env: RuntimeEnv,
  wallet: string,
): Promise<Response> {
  if (!isBase58Address(wallet)) return apiError("Invalid wallet");
  const now = Math.floor(Date.now() / 1_000);
  const [account, positions, username] = await Promise.all([
    playerAccountView(env, wallet, now),
    playerPositions(env, wallet),
    usernameFor(env, wallet).catch(() => null),
  ]);
  const profile: PlayerProfileView = {
    wallet,
    username,
    account,
    positions,
    achievements: [],
    cosmetics: [],
    season: null,
  };
  return json({ profile }, { headers: { "cache-control": "public, max-age=10" } });
}
