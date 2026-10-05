/** Which mines are boosted right now (worker/boosts.ts). Kept apart so the coin source can read it without a cycle. */
/** The end of each mint's current boost, for mints boosted right now. */
export async function activeBoosts(db: D1Database, now: number = Math.floor(Date.now() / 1_000)): Promise<Map<string, number>> {
  const result = await db.prepare("SELECT mint, MAX(ends_at) AS ends_at FROM mine_boosts WHERE ends_at > ?1 AND starts_at <= ?1 GROUP BY mint")
    .bind(now)
    .all<{ mint: string; ends_at: number }>()
    // Before migration 0042 there are no boosts.
    .catch(() => null);
  return new Map((result?.results ?? []).map((row) => [row.mint, Number(row.ends_at)]));
}
