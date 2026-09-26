/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MINING_RESERVE } from "./contracts";
import { planMiningBackfill, type BackfillSnapshot } from "./backfill";
import { releasedMiningAllocation } from "./rules";

const MINT = "12cens35GKeZH8is6R1gdbJ1faktyLrXgHvHyBB6veb7";
const OWNER = "GyGjx2nsgG2wDbUESGTw8aHndXh6b8d2znhZPqWSdwcH";
const OTHER = "J53sFYi6UcFFjEnHqn1JtwkgBaErRe9e2adk9iuzekjA";
const READER = "6HHEkX5MxsoQwyCJZHvLnewmnsaw19vGT9Y8jhqH7GuJ";
const POOL_CREATED = 1_790_360_440;
const OWNER_FIRST = 1_790_361_719;
const OWNER_SECOND = 1_790_405_530;
const OTHER_FIRST = 1_790_360_517;
const CUTOFF = 1_790_412_000;

function playerRow(wallet: string, createdMs: number, activatedMs: number, version: number) {
  return {
    wallet, created_at: createdMs, version, ore_balance: "0.0", ore_earned: "0.0", streak: 1, longest_streak: 1, streak_freezes: 0,
    active_until: activatedMs + 86_400, last_activation_at: activatedMs, activated_at: activatedMs, last_ore_at: 0,
    active_mine: MINT, active_mining_power: "0.0", active_days: 5, valid_activations: 5,
    miners_level: 1, drills_level: 1, carts_level: 1, foreman_level: 1, storage_level: 1, updated_at: Math.floor(activatedMs / 1000),
  };
}

/** The production shape on 2026-09-26: millisecond activation fields and legacy balance anchors. */
function snapshot(): BackfillSnapshot {
  return {
    players: [
      playerRow(OWNER, 1_790_335_902_663, OWNER_SECOND * 1000 + 608, 8),
      playerRow(OTHER, 1_790_351_132_947, OTHER_FIRST * 1000 + 726, 2),
      { ...playerRow(READER, 1_790_336_439_260, 0, 0), active_until: 0, last_activation_at: 0, activated_at: 0, active_mine: null, active_days: 0, valid_activations: 0 },
    ],
    balances: [
      { wallet: OWNER, mint: MINT, claimable: "0", last_settled_at: OWNER_FIRST * 1000 + 730, updated_at: OWNER_FIRST },
      { wallet: OTHER, mint: MINT, claimable: "0", last_settled_at: OTHER_FIRST * 1000 + 726, updated_at: OTHER_FIRST },
    ],
    mines: [{ mint: MINT, mining_starts_at: POOL_CREATED, initial_reserve: MINING_RESERVE.toString(), released: "0", remaining: MINING_RESERVE.toString(), committed: "0", paid: "0", total_eligible_power: 0, version: 0 }],
    claims: [],
    pools: [{ base_mint: MINT, symbol: "DIGGO", name: "Diggo", created_at: POOL_CREATED, is_graduated: 0 }],
    activations: [{ wallet: OWNER, consumed_at: OWNER_SECOND }, { wallet: OTHER, consumed_at: OTHER_FIRST }],
  };
}

function database(data: BackfillSnapshot): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  const dir = fileURLToPath(new URL("../../migrations", import.meta.url));
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()) db.exec(readFileSync(join(dir, file), "utf8"));
  const insert = (table: string, row: Record<string, unknown>) => {
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...(keys.map((key) => row[key]) as never[]));
  };
  for (const row of data.players) insert("game_players", row);
  for (const row of data.balances) insert("game_balances", row);
  for (const row of data.mines) insert("game_mines", row);
  return db;
}

describe("mining clock backfill", () => {
  it("replays evidenced activations under the live rules", async () => {
    const plan = await planMiningBackfill(snapshot(), CUTOFF);
    const owner = plan.wallets.find((entry) => entry.wallet === OWNER)!;
    // The second activation came 12h into a 24h shift, inside the 20h reactivation lock.
    expect(owner.activationEvidence).toEqual([OWNER_FIRST, OWNER_SECOND]);
    expect(owner.acceptedActivations).toEqual([OWNER_FIRST]);
    expect(owner.player.activatedAt).toBe(OWNER_FIRST);
    expect(owner.player.activeUntil).toBe(OWNER_FIRST + 86_400);
    expect(owner.player.createdAt).toBe(1_790_335_902);
    expect(owner.player.activeDays).toBe(1);
    expect(owner.player.lastOreAt).toBe(CUTOFF);
    // Day-0 maturity (2,000 bps): 10 ORE activation bonus plus 6 ORE per active hour.
    expect(owner.oreCredited).toBe(10 + Math.floor(((CUTOFF - OWNER_FIRST) * 6) / 3_600));
    expect(owner.pendingTokens).toBeGreaterThan(0n);
    expect(owner.lastSettledAt).toBe(CUTOFF);
    expect(owner.discoveryEligible).toBe(false);
    const other = plan.wallets.find((entry) => entry.wallet === OTHER)!;
    const mine = plan.mines[0]!;
    expect(owner.pendingTokens + other.pendingTokens).toBe(mine.committed);
    expect(mine.committed).toBeLessThanOrEqual(releasedMiningAllocation(CUTOFF, POOL_CREATED));
    expect(mine.remaining).toBe(MINING_RESERVE - mine.committed);
  });

  it("applies once and is a no-op when rerun", async () => {
    const data = snapshot();
    const plan = await planMiningBackfill(data, CUTOFF);
    const db = database(data);
    const run = () => { for (const statement of plan.sql) db.exec(statement); };
    run();
    const read = () => ({
      players: db.prepare("SELECT wallet, created_at, version, ore_balance, activated_at, active_until, last_ore_at FROM game_players ORDER BY wallet").all(),
      balances: db.prepare("SELECT wallet, claimable, last_settled_at FROM game_balances ORDER BY wallet").all(),
      mines: db.prepare("SELECT committed, remaining, version FROM game_mines").all(),
      markers: db.prepare("SELECT id FROM game_backfills ORDER BY id").all(),
    });
    const first = read();
    run();
    expect(read()).toEqual(first);
    const owner = plan.wallets.find((entry) => entry.wallet === OWNER)!;
    expect(first.players.find((row) => row.wallet === OWNER)).toMatchObject({ created_at: 1_790_335_902, version: 9, ore_balance: String(owner.oreCredited), activated_at: OWNER_FIRST });
    expect(first.players.find((row) => row.wallet === READER)).toMatchObject({ created_at: 1_790_336_439 });
    expect(first.balances.find((row) => row.wallet === OWNER)).toMatchObject({ claimable: owner.pendingTokens.toString(), last_settled_at: CUTOFF });
    expect(first.mines[0]).toMatchObject({ committed: plan.mines[0]!.committed.toString(), version: 1 });
    expect(first.markers).toHaveLength(3);
  });

  it("skips a wallet whose row changed after the snapshot, and then holds the ledger", async () => {
    const data = snapshot();
    const plan = await planMiningBackfill(data, CUTOFF);
    const db = database(data);
    db.exec(`UPDATE game_players SET version = version + 1 WHERE wallet = '${OWNER}'`);
    for (const statement of plan.sql) db.exec(statement);
    expect(db.prepare(`SELECT ore_balance FROM game_players WHERE wallet = '${OWNER}'`).get()).toMatchObject({ ore_balance: "0.0" });
    expect(db.prepare("SELECT committed FROM game_mines").get()).toMatchObject({ committed: "0" });
  });
});

