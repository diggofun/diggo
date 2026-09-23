/**
 * Advisory reconciliation: compare the index against the chain and say so.
 *
 * v4's reconciliation could halt a mine's payouts when its accounting diverged, which made the
 * worker the arbiter of whether a player could claim. v2 has nothing to halt: the program holds
 * the ledger and pays from it, so a divergence can only mean this index is stale. What remains is
 * the useful half - noticing the divergence and recording it - with no ability to act on it.
 */
import type { RuntimeEnv } from "./env";
import { nowSeconds } from "./indexStore";
import { checkLedgerInvariant, refreshCoin } from "./indexing";
import { readCoinByMint } from "./chainV2";

/** How many coins one reconciliation pass checks. Bounded so a pass stays cheap. */
export const RECONCILE_COINS_PER_RUN = 20;

export interface ReconcileReport {
  checked: number;
  diverged: number;
  repaired: number;
}

/**
 * Checks each coin's vault against its own ledger fields.
 *
 * Two outcomes are possible and neither is enforcement: a coin whose index was stale is refreshed
 * from chain (which is the repair), and a coin whose *program* state violates the invariant is
 * recorded as an advisory alert for a human to look at. The indexer cannot move a token, so the
 * second case is a finding, not a fix.
 */
export async function reconcileIndex(env: RuntimeEnv): Promise<ReconcileReport> {
  const rows = await env.DB.prepare(
    "SELECT mint, indexed_at FROM coins ORDER BY COALESCE(indexed_at, 0) ASC LIMIT ?1",
  )
    .bind(RECONCILE_COINS_PER_RUN)
    .all<{ mint: string; indexed_at: number | null }>();
  let checked = 0;
  let diverged = 0;
  let repaired = 0;
  for (const row of rows.results ?? []) {
    checked += 1;
    const chain = await readCoinByMint(env, row.mint).catch(() => null);
    if (!chain) continue;
    const invariant = await checkLedgerInvariant(env, row.mint, chain.data);
    const stale =
      (row.indexed_at ?? 0) < nowSeconds() - 600 ||
      (await indexDiffersFromChain(env, row.mint, chain.data));
    if (!invariant.ok) diverged += 1;
    if (stale) {
      await refreshCoin(env, row.mint);
      repaired += 1;
    }
    await env.DB.prepare(
      "INSERT INTO index_reconcile_runs (id, coin, checked_at, status, divergence_kind," +
        " index_value, chain_value, detail) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )
      .bind(
        crypto.randomUUID(),
        row.mint,
        nowSeconds(),
        invariant.ok ? (stale ? "REFRESHED" : "OK") : "INVARIANT_VIOLATION",
        invariant.ok ? null : "vault_ledger_invariant",
        null,
        invariant.ok ? null : invariant.shortfall.toString(),
        stale ? "index was behind the chain and was refreshed" : null,
      )
      .run();
  }
  return { checked, diverged, repaired };
}

/** True when the indexed ledger fields no longer match the program's own values. */
async function indexDiffersFromChain(
  env: RuntimeEnv,
  mint: string,
  chain: {
    reserveRemaining: bigint;
    discoveryRemaining: bigint;
    outstandingClaims: bigint;
    cumulativeDistributed: bigint;
    totalPower: bigint;
  },
): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT reserve_remaining, discovery_remaining, outstanding_claims," +
      " cumulative_distributed, total_power FROM coins WHERE mint = ?1",
  )
    .bind(mint)
    .first<{
      reserve_remaining: string;
      discovery_remaining: string;
      outstanding_claims: string;
      cumulative_distributed: string;
      total_power: string;
    }>();
  if (!row) return true;
  return (
    row.reserve_remaining !== chain.reserveRemaining.toString() ||
    row.discovery_remaining !== chain.discoveryRemaining.toString() ||
    row.outstanding_claims !== chain.outstandingClaims.toString() ||
    row.cumulative_distributed !== chain.cumulativeDistributed.toString() ||
    row.total_power !== chain.totalPower.toString()
  );
}
