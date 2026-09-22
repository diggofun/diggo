/**
 * Player state: the players row shape, its Crew-level projection, the streak record the shared
 * streak rules consume, and the load/serialize helpers that mining, crew, discovery, risk and
 * leaderboards all build on.
 *
 * The streak/XP/badge columns added in migrations/0008_mining_positions.sql belong to the
 * activation and streak loop owned by worker/mining.ts; the row itself stays the single source
 * of player state every other module reads.
 */
import {
  crewPower,
  crewTier,
  discoveryEligible,
  maturityBps,
  oreCapacity,
  type CrewLevels,
} from "../shared/economics";
import type { ActivationRecord } from "../shared/streak";
import type { ActivationState, PlayerProfile, RiskState } from "../shared/types";
import { sessionWallet } from "./auth";
import type { RuntimeEnv } from "./env";
import { apiError, json } from "./http";
import { gateAction, type GateResult } from "./risk";

export interface PlayerRow {
  wallet: string;
  created_at: number;
  miners_level: number;
  drills_level: number;
  carts_level: number;
  foreman_level: number;
  storage_level: number;
  ore_balance: number;
  streak: number;
  streak_freezes: number;
  active_days: number;
  active_mint: string | null;
  last_activation_at: number | null;
  activation_expires_at: number | null;
  ore_collected_at: number | null;
  power_synced_onchain: number;
  risk_state: RiskState;
  risk_score: number;
  /** Start of the current activation window (spec 76). */
  activated_at: number | null;
  /** End of the grace period that keeps the streak alive (spec 5, 76). */
  streak_grace_until: number | null;
  longest_streak: number;
  xp: number;
  /** JSON-encoded string arrays; badges/titles are granted by streak milestones (spec 6). */
  badges: string;
  titles: string;
  /** ORE that did not fit storage; reported, never silently dropped (spec 42). */
  ore_overflow: number;
  last_report_at: number | null;
}

export function crewLevelsOf(row: PlayerRow): CrewLevels {
  return {
    miners: row.miners_level,
    drills: row.drills_level,
    carts: row.carts_level,
    foreman: row.foreman_level,
    storage: row.storage_level,
  };
}

/** The slice of a player row that shared/streak.ts needs. */
export function activationRecordOf(row: PlayerRow): ActivationRecord {
  return {
    activatedAt: row.activated_at,
    activeUntil: row.activation_expires_at,
    lastActivationAt: row.last_activation_at,
    streak: row.streak,
    longestStreak: row.longest_streak,
    streakFreezes: row.streak_freezes,
  };
}

/** Tolerant JSON string-array decode: a malformed column never breaks a read path. */
export function parseStringList(raw: string | null | undefined): string[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

/** Union of two string lists, preserving order and dropping duplicates. */
export function mergeStringLists(current: readonly string[], added: readonly string[]): string[] {
  const merged = [...current];
  for (const entry of added) {
    if (!merged.includes(entry)) merged.push(entry);
  }
  return merged;
}

/**
 * Thrown when a brand-new wallet is refused an account by the anti-abuse gate (spec 48, 58).
 *
 * Account creation is the one moment a wallet farm is cheapest to slow down, so it is rate
 * limited on its own budget. The router turns this into a neutral 429 rather than letting it
 * surface as a 500 (spec 62).
 */
export class AccountCreationDenied extends Error {
  readonly gate: GateResult;

  constructor(gate: GateResult) {
    super("Account creation refused by the anti-abuse gate");
    this.name = "AccountCreationDenied";
    this.gate = gate;
  }
}

/**
 * Loads a player, creating the row on first touch.
 *
 * The creation path is gated when the caller passes the request that caused it: an existing
 * player is never re-gated (a limiter must not be able to lock someone out of their own account),
 * and a wallet whose row already exists costs nothing extra. Time and legitimate participation
 * are what make a farm expensive (spec 58); this only stops one host from minting accounts in a
 * tight loop.
 */
export async function getOrCreatePlayer(
  env: RuntimeEnv,
  wallet: string,
  request?: Request,
): Promise<PlayerRow> {
  const existing = await env.DB.prepare("SELECT * FROM players WHERE wallet = ?1").bind(wallet).first<PlayerRow>();
  if (existing) return existing;
  if (request) {
    const gate = await gateAction(env, { wallet, request, action: "bootstrap" });
    if (!gate.allowed) throw new AccountCreationDenied(gate);
  }
  await env.DB.prepare("INSERT OR IGNORE INTO players (wallet) VALUES (?1)").bind(wallet).run();
  const created = await env.DB.prepare("SELECT * FROM players WHERE wallet = ?1").bind(wallet).first<PlayerRow>();
  if (!created) throw new Error("Failed to initialize player");
  return created;
}

export function activationStateOf(row: PlayerRow, now: number): ActivationState {
  if (row.last_activation_at === null) return "NEVER_ACTIVATED";
  return row.activation_expires_at !== null && now < row.activation_expires_at ? "ACTIVE" : "PAUSED";
}

export function rowToProfile(row: PlayerRow, now: number): PlayerProfile {
  const levels = crewLevelsOf(row);
  const accountAgeSeconds = Math.max(0, now - row.created_at);
  return {
    wallet: row.wallet,
    createdAt: row.created_at,
    crewLevels: levels,
    power: crewPower(levels),
    oreBalance: row.ore_balance,
    oreCapacity: oreCapacity(levels),
    streak: row.streak,
    streakFreezes: row.streak_freezes,
    activationState: activationStateOf(row, now),
    lastActivationAt: row.last_activation_at,
    activationExpiresAt: row.activation_expires_at,
    activeMint: row.active_mint,
    accountAgeSeconds,
    maturityBps: maturityBps(accountAgeSeconds),
    discoveryEligible: discoveryEligible(accountAgeSeconds, row.active_days, crewTier(levels).tier),
    riskState: row.risk_state,
    longestStreak: row.longest_streak,
    xp: row.xp,
    badges: parseStringList(row.badges),
    titles: parseStringList(row.titles),
    oreOverflow: row.ore_overflow,
    activatedAt: row.activated_at,
    streakGraceUntil: row.streak_grace_until,
    lastReportAt: row.last_report_at,
  };
}

export async function playerProfile(request: Request, env: RuntimeEnv, wallet: string): Promise<Response> {
  const authenticated = await sessionWallet(request, env);
  if (!authenticated || authenticated !== wallet) return apiError("Wallet authentication required", 401);
  const row = await getOrCreatePlayer(env, wallet, request);
  return json({ player: rowToProfile(row, Math.floor(Date.now() / 1_000)) });
}
