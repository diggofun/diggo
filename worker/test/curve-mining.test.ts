/**
 * Curve-phase mining in the off-chain index (worker/mining.ts).
 *
 * Mining is live from the launch block, so the index has to know which side of a mine is paying:
 * the market's curve token inventory before graduation, the mine's own Mining Reserve after it.
 * The rule it mirrors lives on chain (apply_curve_mining_debit in the program), and these tests
 * pin the two properties that make the mirror honest - the curve phase pays a flat rate the
 * reserve schedule never steps down, and a mine that graduates switches sides without disturbing
 * the reward index that positions have already been credited against.
 */
import { describe, expect, it } from "vitest";
import {
  CURVE_PHASE_ESTIMATE_LABEL,
  ESTIMATE_LABEL,
  advanceMineTo,
  createMineStateFromToken,
  loadMineState,
  mineInfoPayload,
  reconcileEmissionSource,
  simulateAdvance,
  type MineState,
  type MineTokenRow,
} from "../mining";
import { createTestHarness } from "./d1-sqlite";
import type { RuntimeEnv } from "../env";
import { readTokenStatus } from "./mining-d1";

const MINT = "CurveMine11111111111111111111111111111111111";
const NOW = 1_800_000_000;
const HOUR = 3_600;

/** A tokens row as the chain sync would leave it for a mine that is still on its curve. */
function tokenRow(overrides: Partial<MineTokenRow> = {}): MineTokenRow {
  return {
    mint: MINT,
    symbol: "MINE",
    status: "MINING_ACTIVE",
    reserve_remaining: 500_000_000,
    reserve_total: 1_000_000_000,
    reward_per_block: 7_500,
    next_block_at: NOW + 300,
    next_epoch_at: NOW + 86_400,
    synced_at: NOW,
    venue: "curve",
    curve_mining_open: 1,
    curve_mining_cap: 47_500_000,
    curve_mining_mined: 1_000_000,
    curve_mining_unpaid: 400_000,
    curve_mining_block_reward: 5_498,
    ...overrides,
  };
}

function stateFor(token: MineTokenRow, now = NOW): MineState {
  return createMineStateFromToken(token, MINT, now);
}

function seedMineToken(db: ReturnType<typeof createTestHarness>["db"], row: MineTokenRow): void {
  db.prepare(
    "INSERT OR REPLACE INTO tokens (mint, slug, name, symbol, description, creator, status," +
      " price_usd, price_sol, change_24h, market_cap_usd, reserve_remaining, reserve_total," +
      " reward_per_block, network_power, next_block_at, next_epoch_at, decimals, synced_at)" +
      " VALUES (?1, ?2, 'Mine', 'MINE', '', 'creator', ?3, 0.01, 0.0001, 0, 1000, ?4, ?5, ?6, 0, ?7, ?8, 6, ?9)",
  ).run(
    row.mint,
    "mine-" + row.mint.slice(0, 6).toLowerCase(),
    row.status,
    row.reserve_remaining,
    row.reserve_total,
    row.reward_per_block,
    row.next_block_at,
    row.next_epoch_at,
    row.synced_at,
  );
  db.prepare(
    "UPDATE tokens SET venue = ?1, curve_mining_open = ?2, curve_mining_cap = ?3," +
      " curve_mining_mined = ?4, curve_mining_unpaid = ?5, curve_mining_block_reward = ?6 WHERE mint = ?7",
  ).run(
    row.venue,
    row.curve_mining_open,
    row.curve_mining_cap,
    row.curve_mining_mined,
    row.curve_mining_unpaid,
    row.curve_mining_block_reward,
    row.mint,
  );
}

describe("which budget a mine is spending", () => {
  it("is the curve's own cap while the market is on its curve", () => {
    const token = tokenRow();
    const state = reconcileEmissionSource(stateFor(token), token);
    expect(state.emissionSource).toBe("CURVE");
    expect(state.initialReserve).toBe(47_500_000n);
    expect(state.remainingReserve).toBe(46_500_000n);
    expect(state.rewardPerBlock).toBe(5_498n);
    expect(state.curve.mined).toBe(1_000_000n);
    expect(state.curve.unpaid).toBe(400_000n);
    expect(state.curve.graduated).toBe(false);
    expect(state.status).toBe("MINING_ACTIVE");
  });

  it("is the Mining Reserve once the market has graduated", () => {
    const token = tokenRow({ venue: "pool", status: "MINING_ACTIVE", curve_mining_open: 0 });
    const state = reconcileEmissionSource(stateFor(token), token);
    expect(state.emissionSource).toBe("RESERVE");
    expect(state.initialReserve).toBe(1_000_000_000n);
    expect(state.remainingReserve).toBe(500_000_000n);
    expect(state.rewardPerBlock).toBe(7_500n);
  });

  it("reports a spent curve budget as fully mined, and never un-pauses a paused mine", () => {
    const spent = tokenRow({ status: "FULLY_MINED", curve_mining_mined: 47_500_000 });
    const state = reconcileEmissionSource(stateFor(spent), spent);
    expect(state.status).toBe("FULLY_MINED");
    expect(state.remainingReserve).toBe(0n);

    const paused = { ...stateFor(spent), status: "PAUSED" as const };
    expect(reconcileEmissionSource(paused, spent).status).toBe("PAUSED");
  });

  /**
   * The curve phase's budget is the one budget chain can take away: the room under the cap is
   * where the tokens physically come from, and advance_mine spends it on chain in parallel. The
   * index therefore takes the smaller of the two, and never a larger one - crediting a block the
   * market vault cannot pay for is what would let a claim draw the difference out of the Mining
   * Reserve before the market has graduated.
   */
  it("clamps the curve budget to what chain reports is left, and never hands budget back", () => {
    const token = tokenRow();
    const started = reconcileEmissionSource(stateFor(token), token);
    expect(started.remainingReserve).toBe(46_500_000n);

    // The chain walk got ahead between two reads and most of the cap is spent.
    const spent = tokenRow({ curve_mining_open: 0, curve_mining_mined: 47_400_000 });
    const clamped = reconcileEmissionSource(started, spent);
    expect(clamped.emissionSource).toBe("CURVE");
    expect(clamped.remainingReserve).toBe(100_000n);
    expect(reconcileEmissionSource(clamped, spent).remainingReserve).toBe(100_000n);

    // A read that reports more room than the index has spent is a floor, not a re-base: the index
    // keeps the budget it has already been given rather than being handed it back.
    expect(reconcileEmissionSource(clamped, tokenRow()).remainingReserve).toBe(100_000n);

    // And when chain says the cap is spent, the index has nothing left to spend either.
    const exhausted = tokenRow({ curve_mining_open: 0, curve_mining_mined: 47_500_000 });
    const idle = reconcileEmissionSource(clamped, exhausted);
    expect(idle.remainingReserve).toBe(0n);
    expect(idle.status).toBe("MINING_ACTIVE");
  });


  it("is idempotent, so a retry can never re-base a budget twice", () => {
    const token = tokenRow();
    const once = reconcileEmissionSource(stateFor(token), token);
    expect(reconcileEmissionSource(once, token)).toBe(once);
    // And a mine that has not changed keeps the ledger it was given.
    expect(reconcileEmissionSource(once, token).remainingReserve).toBe(46_500_000n);
  });
});

describe("the curve phase's emission", () => {
  const curveState = (overrides: Partial<MineState> = {}): MineState => ({
    ...stateFor(tokenRow()),
    emissionSource: "CURVE",
    initialReserve: 1_000n,
    remainingReserve: 1_000n,
    rewardPerBlock: 7n,
    // Not zero: a mine that has never credited a block is not advanced at all, which is a
    // different thing from a mine whose next block is due.
    lastBlock: 300,
    epoch: 0,
    epochEndsAt: 600,
    blockInterval: 300,
    epochLength: 600,
    totalEligiblePower: 100n,
    status: "MINING_ACTIVE",
    ...overrides,
  });
  const position = {
    wallet: "WALLET",
    assignedPower: 100n,
    lastRewardIndex: 0n,
    pendingReward: 0n,
    activatedAt: 0,
    activeUntil: NOW + 10 * HOUR,
    paused: false,
  };

  it("pays a flat rate across epoch boundaries, unlike the reserve schedule", () => {
    // Two epochs roll inside these ten blocks (the epoch is two blocks long), which is exactly
    // where the reserve-runway schedule steps its rate down and the curve phase must not.
    const advanced = simulateAdvance({ state: curveState(), positions: [position], upTo: 3_300 });
    expect(advanced.blocksAdvanced).toBe(10);
    expect(advanced.state.rewardPerBlock).toBe(7n);
    expect(advanced.distributed).toBe(70n);
    expect(advanced.state.epoch).toBe(5);
    expect(advanced.state.remainingReserve).toBe(930n);

    const reservePhase = simulateAdvance({
      state: curveState({ emissionSource: "RESERVE" }),
      positions: [position],
      upTo: 3_300,
    });
    expect(reservePhase.state.rewardPerBlock).not.toBe(7n);
    expect(reservePhase.state.rewardPerBlock).toBeLessThan(7n);
  });

  it("never distributes more than the cap has left", () => {
    const advanced = simulateAdvance({
      state: curveState({ remainingReserve: 25n }),
      positions: [position],
      upTo: 3_300,
    });
    expect(advanced.distributed).toBe(25n);
    expect(advanced.state.remainingReserve).toBe(0n);
    // Idle, not finished: the curve budget is spent, the Mining Reserve has not been touched,
    // and only graduation switches the mine onto it.
    expect(advanced.state.status).toBe("MINING_ACTIVE");
  });

  it("credits nothing at all once chain says the curve budget is spent, and keeps the cursor moving", () => {
    const advanced = simulateAdvance({
      state: curveState({ remainingReserve: 0n }),
      positions: [position],
      upTo: 3_300,
    });
    expect(advanced.distributed).toBe(0n);
    expect(advanced.state.rewardIndex).toBe(0n);
    // The idle blocks are still consumed rather than left pending: a cursor stopped here would be
    // paid out of the Mining Reserve in one go the moment the market graduated.
    expect(advanced.blocksAdvanced).toBe(10);
    expect(advanced.state.lastBlock).toBe(3_300);
    expect(advanced.state.status).toBe("MINING_ACTIVE");
  });
});

describe("what the mine info endpoint reports about the curve phase", () => {
  it("shows the cap progress, the flat schedule and the curve-phase caveat", () => {
    const token = tokenRow();
    const state = reconcileEmissionSource(stateFor(token), token);
    const payload = mineInfoPayload({
      state,
      symbol: token.symbol,
      tokenStatus: token.status,
      playerPower: 250_000,
    });

    expect(payload.emissionSource).toBe("CURVE");
    expect(payload.curveMining.open).toBe(true);
    expect(payload.curveMining.onCurve).toBe(true);
    expect(payload.curveMining.cap).toBe(47_500_000);
    expect(payload.curveMining.mined).toBe(1_000_000);
    expect(payload.curveMining.remaining).toBe(46_500_000);
    expect(payload.curveMining.progress).toBeCloseTo(1_000_000 / 47_500_000, 10);
    expect(payload.curveMining.blockReward).toBe(5_498);
    expect(payload.curveMining.unpaid).toBe(400_000);
    // The progress the card shows is the budget actually being spent, which is the cap.
    expect(payload.reserveTotal).toBe(47_500_000);
    expect(payload.remainingReserve).toBe(46_500_000);
    expect(payload.fullyMinedProgress).toBeCloseTo(1_000_000 / 47_500_000, 10);
    expect(payload.estimateLabel).toBe(CURVE_PHASE_ESTIMATE_LABEL);
    expect(payload.reductionSchedule).toEqual([5_498, 5_498, 5_498, 5_498, 5_498, 5_498, 5_498, 5_498]);
    expect(payload.curveMiningDaysRemaining).toBeCloseTo((46_500_000 / 5_498) * (300 / 86_400), 6);
  });

  it("goes back to the reserve schedule and the plain estimate after graduation", () => {
    const token = tokenRow({ venue: "pool", curve_mining_open: 0 });
    const state = reconcileEmissionSource(stateFor(token), token);
    const payload = mineInfoPayload({
      state,
      symbol: token.symbol,
      tokenStatus: token.status,
      playerPower: 250_000,
    });
    expect(payload.emissionSource).toBe("RESERVE");
    expect(payload.curveMining.onCurve).toBe(false);
    expect(payload.curveMining.open).toBe(false);
    expect(payload.estimateLabel).toBe(ESTIMATE_LABEL);
    expect(payload.reserveTotal).toBe(1_000_000_000);
    // The schedule shown is the reserve-runway preview, not the curve phase's flat rate.
    expect(payload.blockReward).toBe(7_500);
    expect(payload.reductionSchedule[0]).toBeLessThan(payload.blockReward);
  });
});

describe("loadMineState", () => {
  it("starts a curve-phase mine on the curve's budget and follows it across graduation", async () => {
    const h = createTestHarness();
    const env = h.env as RuntimeEnv;
    const row = tokenRow();
    seedMineToken(h.db, row);

    const first = await loadMineState(env, MINT, NOW);
    expect(first?.state.emissionSource).toBe("CURVE");
    expect(first?.state.remainingReserve).toBe(46_500_000n);
    expect(first?.state.rewardPerBlock).toBe(5_498n);
    expect(first?.state.status).toBe("MINING_ACTIVE");

    const stored = h.db
      .prepare("SELECT emission_source, remaining_reserve, reward_per_block FROM mine_reward_state WHERE mint = ?1")
      .get(MINT) as { emission_source: string; remaining_reserve: string; reward_per_block: string };
    expect(stored.emission_source).toBe("CURVE");
    expect(stored.remaining_reserve).toBe("46500000");
    expect(stored.reward_per_block).toBe("5498");

    // The market graduates between two calls: the mine switches to its own reserve, and the
    // index cursor it had is left exactly where it was.
    const graduated = tokenRow({ venue: "pool", curve_mining_open: 0 });
    seedMineToken(h.db, graduated);
    const second = await loadMineState(env, MINT, NOW + HOUR);
    expect(second?.state.emissionSource).toBe("RESERVE");
    expect(second?.state.initialReserve).toBe(1_000_000_000n);
    expect(second?.state.remainingReserve).toBe(500_000_000n);
    expect(second?.state.rewardPerBlock).toBe(7_500n);
    expect(second?.state.lastBlock).toBe(first?.state.lastBlock);
    expect(second?.state.rewardIndex).toBe(first?.state.rewardIndex);

    const after = h.db
      .prepare("SELECT emission_source, remaining_reserve FROM mine_reward_state WHERE mint = ?1")
      .get(MINT) as { emission_source: string; remaining_reserve: string };
    expect(after.emission_source).toBe("RESERVE");
    expect(after.remaining_reserve).toBe("500000000");
    h.db.close();
  });

  it("reads a market with no curve budget as the idle curve-phase mine it is", async () => {
    const h = createTestHarness();
    const row = tokenRow({ venue: "curve", curve_mining_cap: 0, curve_mining_block_reward: 0, curve_mining_open: 0 });
    seedMineToken(h.db, row);
    const loaded = await loadMineState(h.env as RuntimeEnv, MINT, NOW);
    expect(loaded?.state.emissionSource).toBe("CURVE");
    expect(loaded?.state.remainingReserve).toBe(0n);
    // Nothing to emit before graduation, which is exactly the pre-curve rule: a legacy market's
    // cap can only ever be migrated to zero, so this mine pays nothing until it graduates, and
    // then its whole Mining Reserve is waiting. It is idle rather than finished - the token row
    // says CURVE_CAP_REACHED for the same state (worker/chain.ts) - which is what keeps it in the
    // indexing loop that will notice its graduation.
    expect(loaded?.state.status).toBe("MINING_ACTIVE");
    h.db.close();
  });

  /**
   * The whole lifecycle the review asked for, in the order the Worker drives it: curve mining
   * while the cap has room, an idle span once it is spent, and the reserve from graduation on.
   *
   * The property that matters is at step two: a spent curve cap is not FULLY_MINED. The token row
   * has to stay in queueEpochSync's re-read set (worker/indexing.ts), which is the only place
   * that ever notices a curve reaching its graduation target, and the mining walk must not write
   * FULLY_MINED over it either (worker/mining.ts). Both would leave the mine idle for good.
   */
  it("runs the curve phase to its cap, stays idle, then pays from the reserve after graduation", async () => {
    const h = createTestHarness();
    const env = h.env as RuntimeEnv;

    // 1. Curve mining: the cap has room, so the market's own inventory pays and the mine is
    //    actively emitting.
    seedMineToken(h.db, tokenRow());
    const emitting = await loadMineState(env, MINT, NOW);
    expect(emitting?.state.emissionSource).toBe("CURVE");
    expect(emitting?.state.remainingReserve).toBe(46_500_000n);
    expect(emitting?.state.status).toBe("MINING_ACTIVE");

    // 2. The cap is spent. chain.ts reports CURVE_CAP_REACHED and not FULLY_MINED, so the market
    //    stays in the sync loop and the keeper still gets to see its graduation.
    const spent = tokenRow({
      status: "CURVE_CAP_REACHED",
      curve_mining_open: 0,
      curve_mining_mined: 47_500_000,
    });
    seedMineToken(h.db, spent);
    const idle = await loadMineState(env, MINT, NOW + HOUR);
    expect(idle?.state.emissionSource).toBe("CURVE");
    expect(idle?.state.remainingReserve).toBe(0n);
    expect(idle?.state.status).toBe("MINING_ACTIVE");

    // The walk over the idle span credits nothing, and never marks the mine finished: the Mining
    // Reserve is untouched and graduation is what turns it back on.
    const advanced = await advanceMineTo(env, MINT, NOW + 2 * HOUR);
    expect(advanced?.blocksAdvanced).toBeGreaterThan(0);
    expect(advanced?.state.status).toBe("MINING_ACTIVE");
    expect(advanced?.state.rewardIndex).toBe(idle?.state.rewardIndex ?? 0n);
    expect(await readTokenStatus(env, MINT)).toBe("CURVE_CAP_REACHED");

    // 3. Graduation: the same mine, now on the pool venue, pays out of its own Mining Reserve and
    //    the walk starts drawing it down.
    seedMineToken(
      h.db,
      tokenRow({
        venue: "pool",
        status: "MINING_ACTIVE",
        curve_mining_open: 0,
        curve_mining_mined: 47_500_000,
      }),
    );
    const graduated = await loadMineState(env, MINT, NOW + 3 * HOUR);
    expect(graduated?.state.emissionSource).toBe("RESERVE");
    expect(graduated?.state.initialReserve).toBe(1_000_000_000n);
    expect(graduated?.state.remainingReserve).toBe(500_000_000n);
    // The ledger cursor and the index the curve phase produced are left exactly where they were,
    // so the switch credits no block twice and skips none.
    expect(graduated?.state.rewardIndex).toBe(advanced?.state.rewardIndex);
    h.db.close();
  });


  it("returns null for a mint nothing is known about", async () => {
    const h = createTestHarness();
    expect(await loadMineState(h.env as RuntimeEnv, "Unknown111111111111111111111111111111111111", NOW)).toBeNull();
    h.db.close();
  });
});
