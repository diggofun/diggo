/** GET /api/mines/wars - every open mine ranked by the crews digging it (shared/mineWars.ts). */
import type { RuntimeEnv } from "./env";
import type { GameEnv } from "./game/contracts";
import { json } from "./http";
import { meteoraCoinSource } from "./modes/meteora";
import { rankMineWars, type MineWarsEntry } from "../shared/mineWars";

export async function mineWarsEntries(env: RuntimeEnv, now: number = Math.floor(Date.now() / 1_000)): Promise<MineWarsEntry[]> {
  const [coins, crews, weekly] = await Promise.all([
    meteoraCoinSource(env as GameEnv).listActiveMines(),
    env.DB.prepare("SELECT active_mine AS mint, COUNT(*) AS n FROM game_players WHERE active_mine IS NOT NULL AND active_until > ?1 GROUP BY active_mine")
      .bind(now).all<{ mint: string; n: number }>(),
    env.DB.prepare("SELECT mint, COUNT(DISTINCT wallet) AS n FROM game_balances WHERE updated_at > ?1 GROUP BY mint")
      .bind(now - 7 * 86_400).all<{ mint: string; n: number }>(),
  ]);
  const crewsBy = new Map((crews.results ?? []).map((row) => [row.mint, Number(row.n)]));
  const weeklyBy = new Map((weekly.results ?? []).map((row) => [row.mint, Number(row.n)]));
  return rankMineWars(coins.filter((coin) => !coin.graduated).map((coin) => ({
    mint: coin.mint,
    symbol: coin.symbol,
    name: coin.name,
    createdBy: coin.sponsored ? coin.sponsor ?? null : null,
    crews: crewsBy.get(coin.mint) ?? 0,
    minersThisWeek: weeklyBy.get(coin.mint) ?? 0,
    boosted: coin.boostedUntil !== undefined && coin.boostedUntil > now,
  })));
}

export async function mineWars(env: RuntimeEnv): Promise<Response> {
  const mines = await mineWarsEntries(env);
  return json({ mines: mines.slice(0, 100), computedAt: Math.floor(Date.now() / 1_000) }, { headers: { "cache-control": "public, max-age=60" } });
}
