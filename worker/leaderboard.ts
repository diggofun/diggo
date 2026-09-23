/**
 * Leaderboards (spec 68).
 *
 * Categories are gameplay progression only: Crew Power, streak, achievements and seasonal points.
 * Nothing here ranks token amounts, holdings or trade volume, because a board that pays for farmed
 * token quantity is exactly what a bot farm optimises. Ranking, tiebreaks, eligibility and the
 * no-real-value-prize policy live in shared/social.ts; this module loads rows and ranks them.
 *
 * Only accounts in the NORMAL reward state are selected: UNDER_REVIEW, HELD and BLOCKED accounts
 * are never advertised on a public board (spec 53, 63). The filter is in the SQL itself.
 */
import { DIGGO_CONFIG, crewPower, crewTier, crewTotalLevel } from "../shared/economics";
import {
  DEFAULT_SEASON_ID,
  LEADERBOARD_CATEGORIES,
  LEADERBOARD_POLICY,
  SEASON_LENGTH_SECONDS,
  rankLeaderboard,
  seasonalProgressPoints,
  type LeaderboardCandidate,
  type LeaderboardCategory,
  type RankedLeaderboardEntry,
} from "../shared/social";
import type { LeaderboardEntry } from "../shared/types";
import { currentSeason } from "./cosmetics";
import type { RuntimeEnv } from "./env";
import { json } from "./http";
import { crewLevelsOf, type PlayerRow } from "./player";
import { loadTokens } from "./tokens";

const STARTER_TOTAL_LEVEL = crewTotalLevel(DIGGO_CONFIG.crew.starterLevels);
const RANK_LIMIT = 20;

export interface LeaderboardRow extends PlayerRow {
  achievement_count?: number;
  seasonal_points?: number;
  /** Present only on the query shape that joins the usernames table (migrations/0018). */
  username?: string | null;
}

const CANDIDATE_COLUMNS =
  "wallet, miners_level, drills_level, carts_level, foreman_level, storage_level, streak, active_days," +
  " ore_balance, active_mint, risk_state";

/**
 * The same columns, qualified for a query that joins another table carrying a `wallet` column:
 * an unqualified `wallet` in a join would be ambiguous, and the qualification is derived from the
 * one column list above so the two shapes cannot drift apart.
 */
const JOINED_CANDIDATE_COLUMNS = CANDIDATE_COLUMNS.split(",")
  .map((column) => "players." + column.trim())
  .join(", ");

/**
 * Candidate rows for the progression boards. Achievement and seasonal columns need the social
 * migration, the display name needs the usernames migration, and the caller falls back to the
 * shapes a database without one of them can still answer.
 */
export function leaderboardCandidatesSql(withSocialColumns: boolean, withUsernames = false): string {
  const columns = withUsernames ? JOINED_CANDIDATE_COLUMNS : CANDIDATE_COLUMNS;
  const username = withUsernames ? ", u.username AS username" : "";
  const from = withUsernames
    ? " FROM players LEFT JOIN usernames u ON u.wallet = players.wallet WHERE players.risk_state = 'NORMAL'"
    : " FROM players WHERE risk_state = 'NORMAL'";
  if (!withSocialColumns) {
    return "SELECT " + columns + username + from;
  }
  return (
    "SELECT " + columns + username + "," +
    " (SELECT COUNT(*) FROM player_achievements a WHERE a.wallet = players.wallet) AS achievement_count," +
    " COALESCE((SELECT s.points FROM seasonal_points s WHERE s.wallet = players.wallet AND s.season_id = ?1), 0) AS seasonal_points" +
    from
  );
}

/** Maps one players row onto a leaderboard candidate, deriving seasonal points when unset. */
export function rowToCandidate(row: LeaderboardRow): LeaderboardCandidate {
  const levels = crewLevelsOf(row);
  const totalLevel = crewTotalLevel(levels);
  const achievementCount = row.achievement_count ?? 0;
  const derivedPoints = seasonalProgressPoints({
    activeDays: row.active_days,
    crewUpgrades: totalLevel - STARTER_TOTAL_LEVEL,
    streak: row.streak,
    achievementCount,
    discoveryCount: 0,
  });
  return {
    wallet: row.wallet,
    rewardState: row.risk_state,
    power: crewPower(levels),
    crewTier: crewTier(levels).tier,
    crewTotalLevel: totalLevel,
    streak: row.streak,
    longestStreak: row.streak,
    activeDays: row.active_days,
    achievementCount,
    seasonalPoints: Math.max(row.seasonal_points ?? 0, derivedPoints),
    oreBalance: row.ore_balance,
    activeMint: row.active_mint,
    username: row.username ?? null,
  };
}

export function rankCandidates(
  candidates: readonly LeaderboardCandidate[],
): Record<LeaderboardCategory, RankedLeaderboardEntry[]> {
  return {
    crew: rankLeaderboard(candidates, "crew", RANK_LIMIT),
    streak: rankLeaderboard(candidates, "streak", RANK_LIMIT),
    achievements: rankLeaderboard(candidates, "achievements", RANK_LIMIT),
    seasonal_points: rankLeaderboard(candidates, "seasonal_points", RANK_LIMIT),
  };
}

async function loadCandidates(env: RuntimeEnv, seasonId: string): Promise<LeaderboardCandidate[]> {
  // Each shape needs one more migration than the last: the social tables (0011) for achievements and
  // seasonal points, the usernames table (0018) for the display name. A database missing one falls
  // through to the next shape instead of failing the board, which is what an unmigrated local run
  // looks like.
  const attempts: { sql: string; bind: readonly string[] }[] = [
    { sql: leaderboardCandidatesSql(true, true), bind: [seasonId] },
    { sql: leaderboardCandidatesSql(true, false), bind: [seasonId] },
    { sql: leaderboardCandidatesSql(false, false), bind: [] },
  ];
  let lastError: unknown = null;
  for (const attempt of attempts) {
    try {
      const rows = (await env.DB.prepare(attempt.sql).bind(...attempt.bind).all<LeaderboardRow>()).results;
      return rows.map(rowToCandidate);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Leaderboard query failed");
}

export async function leaderboards(env: RuntimeEnv, ctx: ExecutionContext): Promise<Response> {
  const now = Math.floor(Date.now() / 1_000);
  const season = await currentSeasonOrFallback(env, now);
  const candidates = await loadCandidates(env, season.id);
  const ranked = rankCandidates(candidates);
  const legacy = (entries: readonly RankedLeaderboardEntry[], key: "power" | "streak"): LeaderboardEntry[] =>
    entries
      .slice()
      .sort((a, b) => b[key] - a[key] || b.activeDays - a.activeDays)
      .map(
        (entry, index) =>
          ({
            rank: index + 1,
            wallet: entry.wallet,
            power: entry.power,
            streak: entry.streak,
            activeDays: entry.activeDays,
            oreBalance: entry.oreBalance,
            activeMint: entry.activeMint,
            username: entry.username ?? null,
          }) satisfies LeaderboardEntry,
      );
  const mines = (await loadTokens(env, ctx, 20)).tokens
    .slice()
    .sort((a, b) => b.networkPower - a.networkPower || b.marketCapUsd - a.marketCapUsd);
  return json({
    // Legacy keys kept for the current dashboard.
    miners: legacy(ranked.crew, "power"),
    streaks: legacy(ranked.streak, "streak"),
    mines,
    // Spec 68 categories, all gameplay progression.
    crew: ranked.crew,
    streak: ranked.streak,
    achievements: ranked.achievements,
    seasonal: ranked.seasonal_points,
    categories: LEADERBOARD_CATEGORIES,
    season: { id: season.id, name: season.name, endsAt: season.endsAt },
    policy: LEADERBOARD_POLICY,
  });
}

/** The current season, or the built-in default when the seasons table is not migrated yet. */
async function currentSeasonOrFallback(env: RuntimeEnv, now: number) {
  try {
    return await currentSeason(env, now);
  } catch {
    return { id: DEFAULT_SEASON_ID, name: "Season 1 - Genesis Dig", startsAt: now, endsAt: now + SEASON_LENGTH_SECONDS };
  }
}
