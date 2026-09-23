/**
 * Leaderboards, computed from the index.
 *
 * Every board ranks a value the program itself holds: assigned power, ORE, crew levels, the
 * streak counters, or the value of settled discoveries. None of them ranks anything an operator
 * can set, which is what makes a board here a report rather than a decision.
 *
 * No board marks a wallet as bonded. The bond is retired, so there is one tier, and nothing a
 * wallet paid is something a board could rank by or a reader could mistake for a requirement.
 */
import type { RuntimeEnv } from "./env";
import { json } from "./http";
import type { LeaderboardEntryView, LeaderboardsView } from "./v2/types";
import { crewLevelsOf, type PlayerAccountRow } from "./player";

/** One board: the SQL that ranks it, and how the metric is labelled. */
interface BoardDefinition {
  key: string;
  label: string;
  orderBy: string;
  metric: (row: LeaderboardRow) => number;
}

interface LeaderboardRow extends PlayerAccountRow {
  username: string | null;
  discovery_value: string | null;
  assigned_power_total: string | null;
}

const BASE_SELECT = `SELECT p.*, u.username AS username,
       (SELECT COALESCE(SUM(CAST(d.value_lamports AS INTEGER)), 0) FROM discovery_events d
          WHERE d.wallet = p.wallet AND d.status = 'SETTLED') AS discovery_value
       ,(SELECT COALESCE(SUM(CAST(x.assigned_power AS INTEGER)), 0) FROM mining_positions_v2 x
          WHERE x.owner = p.wallet) AS assigned_power_total
  FROM player_accounts p
  LEFT JOIN usernames u ON u.wallet = p.wallet`;

const BOARDS: BoardDefinition[] = [
  {
    key: "power",
    label: "Assigned power",
    orderBy: "CAST(assigned_power_total AS INTEGER) DESC",
    metric: (row) => Number(row.assigned_power_total ?? 0),
  },
  {
    key: "ore",
    label: "ORE earned",
    orderBy: "CAST(p.ore_earned AS INTEGER) DESC",
    metric: (row) => Number(row.ore_earned),
  },
  {
    key: "crew",
    label: "Crew level",
    orderBy:
      "(p.miners_level + p.drills_level + p.carts_level + p.foreman_level + p.storage_level) DESC",
    metric: (row) => crewLevelsOf(row).total,
  },
  {
    key: "streak",
    label: "Longest streak",
    orderBy: "p.longest_streak DESC",
    metric: (row) => row.longest_streak,
  },
  {
    key: "discovery",
    label: "Discovery value",
    orderBy: "CAST(discovery_value AS INTEGER) DESC",
    metric: (row) => Number(row.discovery_value ?? 0),
  },
];

/** GET /api/leaderboards - every board, each capped at its own limit. */
export async function leaderboards(
  _request: Request,
  env: RuntimeEnv,
  limit = 25,
): Promise<Response> {
  const capped = Math.min(100, Math.max(1, limit));
  const boards = [];
  for (const board of BOARDS) {
    const rows = await env.DB.prepare(`${BASE_SELECT} ORDER BY ${board.orderBy} LIMIT ?1`)
      .bind(capped)
      .all<LeaderboardRow>();
    const entries: LeaderboardEntryView[] = (rows.results ?? [])
      .filter((row) => board.metric(row) > 0)
      .map((row, index) => ({
        rank: index + 1,
        wallet: row.wallet,
        username: row.username,
        metric: board.metric(row),
        crewTier: tierLabel(crewLevelsOf(row).total),
        crewPower: Number(row.assigned_power_total ?? "0"),
      }));
    boards.push({ key: board.key, label: board.label, entries });
  }
  const season = await env.DB.prepare(
    "SELECT id, name, ends_at FROM seasons ORDER BY ends_at DESC LIMIT 1",
  ).first<{ id: string; name: string; ends_at: number }>();
  const body: LeaderboardsView = {
    boards,
    season: season ? { id: season.id, name: season.name, endsAt: season.ends_at } : null,
    computedAt: Math.floor(Date.now() / 1_000),
  };
  return json(body, { headers: { "cache-control": "public, max-age=60" } });
}

/** A plain label for a crew total. Presentation only: the program derives the real power. */
function tierLabel(total: number): string {
  if (total >= 400) return "MYTHIC";
  if (total >= 300) return "LEGENDARY";
  if (total >= 200) return "EPIC";
  if (total >= 100) return "RARE";
  if (total >= 40) return "UNCOMMON";
  return "COMMON";
}
