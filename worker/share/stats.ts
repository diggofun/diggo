/**
 * The numbers on a share card, read from D1 for the wallet behind a referral code. Everything here
 * is what the game itself recorded: ORE earned, the longest streak, and the coins the crew mined
 * (still in the mine, on its way out in a claim, or already paid out).
 */
import { validateReferralCode } from "../../shared/referral";
import type { RuntimeEnv } from "../env";
import { profileBotFor, usernameFor } from "../profile";
import type { ShareStats } from "./card";

/** The wallet a referral code belongs to, or null for a malformed or unknown code. */
export async function walletForShareCode(env: RuntimeEnv, rawCode: string): Promise<{ wallet: string; code: string } | null> {
  const validation = validateReferralCode(rawCode);
  if (!validation.ok) return null;
  const row = await env.DB.prepare("SELECT wallet FROM referral_codes WHERE code = ?1 COLLATE NOCASE")
    .bind(validation.code)
    .first<{ wallet: string }>();
  return row ? { wallet: row.wallet, code: validation.code } : null;
}

function toTokens(raw: string | number | bigint | null, decimals: number): number {
  try {
    const units = BigInt(String(raw ?? "0").split(".")[0] || "0");
    const scale = 10n ** BigInt(Math.max(0, Math.min(18, decimals)));
    return Number(units / scale) + Number(units % scale) / Number(scale);
  } catch {
    return 0;
  }
}

export async function shareStats(env: RuntimeEnv, wallet: string): Promise<ShareStats> {
  const [player, mined, username, bot] = await Promise.all([
    env.DB.prepare("SELECT ore_earned, longest_streak FROM game_players WHERE wallet = ?1")
      .bind(wallet)
      .first<{ ore_earned: string; longest_streak: number }>(),
    env.DB.prepare(
      `SELECT m.mint AS mint, m.raw AS raw, p.symbol AS symbol, COALESCE(p.decimals, 9) AS decimals
         FROM (
           SELECT mint, SUM(CAST(claimable AS INTEGER)) AS raw FROM game_balances WHERE wallet = ?1 GROUP BY mint
           UNION ALL
           SELECT mint, SUM(CAST(amount AS INTEGER)) AS raw FROM game_claims WHERE wallet = ?1 AND status IN ('PENDING', 'PAID') GROUP BY mint
         ) m
         LEFT JOIN meteora_pools p ON p.base_mint = m.mint`,
    )
      .bind(wallet)
      .all<{ mint: string; raw: string | number; symbol: string | null; decimals: number }>(),
    usernameFor(env, wallet).catch(() => null),
    profileBotFor(env, wallet).catch(() => null),
  ]);

  const byMint = new Map<string, { symbol: string | null; amount: number }>();
  for (const row of mined.results ?? []) {
    const amount = toTokens(row.raw, row.decimals);
    const entry = byMint.get(row.mint) ?? { symbol: row.symbol, amount: 0 };
    entry.amount += amount;
    entry.symbol ??= row.symbol;
    byMint.set(row.mint, entry);
  }
  const coins = [...byMint.values()].filter((entry) => entry.amount > 0);
  const top = coins
    .filter((entry): entry is { symbol: string; amount: number } => typeof entry.symbol === "string" && entry.symbol.length > 0)
    .sort((a, b) => b.amount - a.amount)[0];

  return {
    wallet,
    username,
    bot,
    oreEarned: Math.floor(Number(player?.ore_earned ?? 0)) || 0,
    longestStreak: player?.longest_streak ?? 0,
    coins: coins.length,
    top: top ? { symbol: top.symbol.replace(/[^A-Za-z0-9]/g, "").slice(0, 12).toUpperCase(), amount: top.amount } : null,
  };
}
