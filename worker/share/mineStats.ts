/** The numbers on a mine card, read from the game's own coin source and mining ledger. */
import type { RuntimeEnv } from "../env";
import { coinReserve, isPayableCoin, wholeAmount, type GameEnv } from "../game/contracts";
import { d1GameStore } from "../game/d1-store";
import { isBase58Address } from "../http";
import { meteoraCoinSource } from "../modes/meteora";
import type { MineShareStats } from "./mineCard";

export async function mineShareStats(env: RuntimeEnv, mint: string): Promise<MineShareStats | null> {
  if (!isBase58Address(mint)) return null;
  const coin = await meteoraCoinSource(env as GameEnv).getMine(mint);
  if (!coin) return null;
  const now = Math.floor(Date.now() / 1_000);
  const [ledger, crews] = await Promise.all([
    d1GameStore(env.DB).getMine(mint),
    env.DB.prepare("SELECT COUNT(*) AS n FROM game_players WHERE active_mine = ?1 AND active_until > ?2")
      .bind(mint, now)
      .first<{ n: number }>()
      .catch(() => null),
  ]);
  const reserve = ledger?.initialReserve ?? coinReserve(coin);
  const remaining = ledger?.remaining ?? reserve;
  return {
    mint,
    symbol: coin.symbol,
    name: coin.name,
    createdBy: coin.sponsored ? coin.sponsor ?? null : null,
    paysNow: Boolean(coin.sponsored) && isPayableCoin(coin),
    open: !coin.graduated,
    remaining: wholeAmount(remaining, coin),
    reserve: wholeAmount(reserve, coin),
    crews: Number(crews?.n ?? 0) || 0,
  };
}
