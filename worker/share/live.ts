/**
 * GET /api/live/mine/:mint - the numbers behind the live mine view (the embeddable player and the
 * X player card): how much is left, how many crews are digging, the Mine Wars rank. Public and
 * read-only; cached for a few seconds at the edge so a post that goes viral costs one query.
 */
import type { RuntimeEnv } from "../env";
import { json } from "../http";
import { mineWarsEntries } from "../mineWars";
import { mineShareStats } from "./mineStats";

export interface LiveMine {
  mint: string;
  symbol: string;
  name: string;
  createdBy: string | null;
  open: boolean;
  paysNow: boolean;
  remaining: number;
  reserve: number;
  crews: number;
  rank: number | null;
  boosted: boolean;
  at: number;
}

export async function liveMine(env: RuntimeEnv, mint: string): Promise<LiveMine | null> {
  const stats = await mineShareStats(env, mint).catch(() => null);
  if (!stats) return null;
  const wars = await mineWarsEntries(env).catch(() => []);
  const entry = wars.find((candidate) => candidate.mint === mint);
  return {
    mint: stats.mint,
    symbol: stats.symbol.replace(/[^A-Za-z0-9]/g, "").slice(0, 12).toUpperCase() || "COIN",
    name: stats.name.slice(0, 40),
    createdBy: stats.createdBy,
    open: stats.open,
    paysNow: stats.paysNow,
    remaining: stats.remaining,
    reserve: stats.reserve,
    crews: stats.crews,
    rank: entry?.rank ?? null,
    boosted: entry?.boosted ?? false,
    at: Math.floor(Date.now() / 1_000),
  };
}

export async function liveMineResponse(env: RuntimeEnv, mint: string): Promise<Response> {
  const live = await liveMine(env, mint);
  if (!live) return json({ error: "Mine not found" }, { status: 404 });
  return json(live, { headers: { "cache-control": "public, max-age=5", "access-control-allow-origin": "*" } });
}
