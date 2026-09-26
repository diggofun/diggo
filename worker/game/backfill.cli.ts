/// <reference types="node" />
/**
 * Plans the mining-clock backfill from a production snapshot. It reads only local files and writes
 * a report and a SQL file; applying the SQL is a separate, explicit `wrangler d1 execute` step.
 *
 *   npx tsx worker/game/backfill.cli.ts <snapshot.json> <cutoffUnixSeconds> <out-prefix>
 *
 * The snapshot is { players, balances, mines, claims, pools, activations } as returned by
 * `wrangler d1 execute --json` for game_players, game_balances, game_mines, game_claims,
 * meteora_pools and consumed game-activate challenge_nonces.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { planMiningBackfill, type BackfillSnapshot } from "./backfill";
import { wholeTokens } from "./store";

const [snapshotPath, cutoffArg, outPrefix] = process.argv.slice(2);
if (!snapshotPath || !cutoffArg || !outPrefix) throw new Error("usage: backfill.cli.ts <snapshot.json> <cutoff> <out-prefix>");
const cutoff = Number(cutoffArg);
if (!Number.isSafeInteger(cutoff) || cutoff <= 0 || cutoff > 99_999_999_999) throw new Error("cutoff must be Unix seconds");
const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as BackfillSnapshot;
const plan = await planMiningBackfill(snapshot, cutoff);
const report = {
  id: plan.id,
  cutoff: plan.cutoff,
  wallets: plan.wallets.map((entry) => ({
    wallet: entry.wallet,
    evidence: entry.activationEvidence,
    accepted: entry.acceptedActivations,
    shift: { activatedAt: entry.player.activatedAt, activeUntil: entry.player.activeUntil },
    oreCredited: entry.oreCredited,
    oreBalance: entry.player.oreBalance,
    pendingTokensRaw: entry.pendingTokens.toString(),
    pendingTokens: wholeTokens(entry.pendingTokens),
    mint: entry.mint,
    activeDays: entry.player.activeDays,
    discovery: entry.discoveryNote,
  })),
  mines: plan.mines.map((mine) => ({
    mint: mine.mint,
    committedRaw: mine.committed.toString(),
    committed: wholeTokens(mine.committed),
    remaining: wholeTokens(mine.remaining),
    released: wholeTokens(mine.released),
  })),
};
writeFileSync(`${outPrefix}.report.json`, JSON.stringify(report, null, 2));
writeFileSync(`${outPrefix}.sql`, plan.sql.join("\n") + "\n");
console.log(JSON.stringify(report, null, 2));

