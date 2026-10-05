/**
 * GET /api/creator/mines - the signed-in wallet's own mines with the numbers a creator shows off:
 * crews digging now, players this week, wallets paid out (new holders) and what is left.
 * A wallet's mines are the coins it added (or was named sponsor wallet for) and the coins it launched.
 */
import { sessionWallet } from "./auth";
import { activeBoosts } from "./boostState";
import type { RuntimeEnv } from "./env";
import { coinReserve, wholeAmount, type GameEnv } from "./game/contracts";
import { d1GameStore } from "./game/d1-store";
import { miningEndsAt } from "./game/rules";
import { apiError, json } from "./http";
import { mineWarsEntries } from "./mineWars";
import { meteoraCoinSource } from "./modes/meteora";
import type { CreatorMineView } from "../shared/creatorMines";

export async function creatorMines(request: Request, env: RuntimeEnv): Promise<Response> {
  const wallet = await sessionWallet(request, env);
  if (!wallet) return apiError("Sign in with your wallet first", 401);
  const now = Math.floor(Date.now() / 1_000);
  const config = String((env as RuntimeEnv & { METEORA_DBC_CONFIG?: string }).METEORA_DBC_CONFIG || "");
  const [added, launched] = await Promise.all([
    env.DB.prepare("SELECT mint FROM sponsored_mines WHERE created_by = ?1 OR sponsor_wallet = ?1 ORDER BY created_at DESC LIMIT 50")
      .bind(wallet).all<{ mint: string }>().catch(() => null),
    config
      ? env.DB.prepare("SELECT base_mint AS mint FROM meteora_pools WHERE config = ?1 AND creator = ?2 ORDER BY created_at DESC LIMIT 50")
        .bind(config, wallet).all<{ mint: string }>()
      : Promise.resolve(null),
  ]);
  const mints = [...new Map([
    ...(added?.results ?? []).map((row) => [row.mint, "added"] as const),
    ...(launched?.results ?? []).map((row) => [row.mint, "launch"] as const),
  ]).entries()];
  if (mints.length === 0) return json({ mines: [] }, { headers: { "cache-control": "no-store" } });

  const [wars, boosts] = await Promise.all([mineWarsEntries(env, now), activeBoosts(env.DB, now)]);
  const warBy = new Map(wars.map((entry) => [entry.mint, entry]));
  const coins = meteoraCoinSource(env as GameEnv);
  const store = d1GameStore(env.DB);
  const mines: CreatorMineView[] = [];
  for (const [mint, kind] of mints) {
    const coin = await coins.getMine(mint);
    if (!coin) continue;
    const [ledger, paid, week] = await Promise.all([
      store.getMine(mint),
      env.DB.prepare("SELECT COUNT(DISTINCT wallet) AS holders, COALESCE(SUM(CAST(amount AS INTEGER)), 0) AS total FROM game_claims WHERE mint = ?1 AND status = 'PAID'")
        .bind(mint).first<{ holders: number; total: number | string }>(),
      env.DB.prepare("SELECT COUNT(DISTINCT wallet) AS n FROM game_balances WHERE mint = ?1 AND updated_at > ?2")
        .bind(mint, now - 7 * 86_400).first<{ n: number }>(),
    ]);
    const reserve = ledger?.initialReserve ?? coinReserve(coin);
    const war = warBy.get(mint);
    mines.push({
      mint,
      symbol: coin.symbol,
      name: coin.name,
      kind,
      open: !coin.graduated,
      crews: war?.crews ?? 0,
      minersThisWeek: Number(week?.n ?? 0),
      holdersPaid: Number(paid?.holders ?? 0),
      paidOut: wholeAmount(BigInt(String(paid?.total ?? "0").split(".")[0] || "0"), coin),
      remaining: wholeAmount(ledger?.remaining ?? reserve, coin),
      reserve: wholeAmount(reserve, coin),
      endsAt: coin.graduated ? null : miningEndsAt(coin),
      boostedUntil: boosts.get(mint) ?? null,
      rank: war?.rank ?? null,
    });
  }
  return json({ mines }, { headers: { "cache-control": "no-store" } });
}
