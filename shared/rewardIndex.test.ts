import { describe, expect, it } from "vitest";
import { DIGGO_CONFIG, createDiggoConfig } from "./config";
import {
  applyBlock,
  auditReserve,
  claimPosition,
  clampRewardToReserve,
  blocksPerEpoch,
  createMiningPosition,
  createRewardIndexState,
  emissionSchedulePreview,
  epochReward,
  epochsInLifetime,
  isFullyMined,
  pausePosition,
  proportionalReward,
  reducedReward,
  resumePosition,
  rewardAtEpoch,
  rewardIndexScale,
  rewardReductionSchedule,
  settlePosition,
  setPositionPower,
  switchMine,
  type MiningPosition,
  type RewardIndexState,
} from "./rewardIndex";

function settleAll(state: RewardIndexState, positions: MiningPosition[]) {
  let next = state;
  const settled: MiningPosition[] = [];
  for (const position of positions) {
    const outcome = settlePosition(next, position);
    next = outcome.state;
    settled.push(outcome.position);
  }
  return { state: next, positions: settled };
}

describe("cumulative reward index", () => {
  it("pays the spec proportional reward example exactly", () => {
    const state = createRewardIndexState(1_000_000n, 10_000n);
    const block = applyBlock(state, 10_000n, 2_000_000n);
    const settled = settlePosition(block.state, createMiningPosition("FROG", 4_000n));
    expect(settled.earned).toBe(20n);
    expect(settled.forfeited).toBe(0n);
    expect(block.distributed).toBe(10_000n);
    expect(block.dustScaled).toBe(0n);
  });

  it("keeps sub-token precision across a large total power", () => {
    expect(rewardIndexScale()).toBe(BigInt(DIGGO_CONFIG.economy.rewardIndexScale));
    const state = createRewardIndexState(1_000_000n, 1n);
    const block = applyBlock(state, 1n, 4_001n);
    // A single token split across thousands of power units still yields a
    // non-zero scaled index instead of collapsing to zero.
    expect(block.state.globalRewardIndex).toBe(249_937_515n);
    expect(block.dustScaled).toBeGreaterThan(0n);
    const positions = [1n, 4_000n].map((power) => createMiningPosition("FROG", power));
    const settled = settleAll(block.state, positions);
    expect(settled.positions[0].pendingReward).toBe(0n);
    expect(settled.positions[1].pendingReward).toBe(0n);
    expect(settled.positions[0].pendingReward + settled.positions[1].pendingReward).toBe(0n);
    const audit = auditReserve(settled.state, 1_000_000n, settled.positions, 0n);
    expect(audit.conserved).toBe(true);
  });

  it("settles unsettled rewards exactly when switching mines", () => {
    let state = createRewardIndexState(1_000_000n, 10_000n);
    let position = createMiningPosition("FROG", 4_000n);
    for (let block = 0; block < 3; block += 1) {
      state = applyBlock(state, 10_000n, 2_000_000n).state;
    }
    const switched = switchMine(state, position, "DOGGO");
    expect(switched.earned).toBe(60n);
    expect(switched.position.pendingReward).toBe(60n);
    expect(switched.position.mineId).toBe("DOGGO");
    expect(switched.position.lastRewardIndex).toBe(state.globalRewardIndex);
    expect(switched.position.assignedPower).toBe(4_000n);

    // A second switch has nothing left to settle.
    const again = switchMine(switched.state, switched.position, "FROG");
    expect(again.earned).toBe(0n);
    expect(again.position.pendingReward).toBe(60n);
  });

  it("pays nothing to a paused position and returns its share to the reserve", () => {
    let state = createRewardIndexState(1_000_000n, 10_000n);
    let position = createMiningPosition("FROG", 4_000n);
    const paused = pausePosition(state, position);
    state = paused.state;
    position = paused.position;
    expect(position.paused).toBe(true);

    state = applyBlock(state, 10_000n, 4_000n).state;
    const idle = settlePosition(state, position);
    expect(idle.earned).toBe(0n);
    expect(idle.position.pendingReward).toBe(0n);
    expect(idle.forfeited).toBe(10_000n);
    expect(idle.state.reserveRemaining).toBe(1_000_000n);
    expect(idle.position.lastRewardIndex).toBe(state.globalRewardIndex);

    const resumed = resumePosition(idle.state, idle.position);
    const afterResume = applyBlock(resumed.state, 10_000n, 4_000n).state;
    const earned = settlePosition(afterResume, resumed.position);
    expect(earned.earned).toBe(10_000n);
    expect(earned.position.pendingReward).toBe(10_000n);
  });

  it("settles before a power change so the new power is never backdated", () => {
    let state = createRewardIndexState(1_000_000n, 10_000n);
    const position = createMiningPosition("FROG", 1_000n);
    state = applyBlock(state, 10_000n, 1_000n).state;
    const changed = setPositionPower(state, position, 500n);
    expect(changed.position.pendingReward).toBe(10_000n);
    expect(changed.position.assignedPower).toBe(500n);
    expect(changed.position.lastRewardIndex).toBe(state.globalRewardIndex);
  });

  it("caps a block reward at the remaining reserve", () => {
    const state = createRewardIndexState(500n, 1_000_000n);
    const block = applyBlock(state, 1_000_000n, 1n);
    expect(block.capped).toBe(500n);
    expect(block.distributed).toBe(500n);
    expect(block.state.reserveRemaining).toBe(0n);
    expect(block.fullyMined).toBe(true);
    expect(isFullyMined(block.state)).toBe(true);
  });

  it("enters FULLY_MINED and distributes nothing further", () => {
    let state = createRewardIndexState(1_000n, 1_000n);
    const first = applyBlock(state, 1_000n, 1_000n);
    state = first.state;
    expect(isFullyMined(state)).toBe(true);
    const after = applyBlock(state, 1_000n, 1_000n);
    expect(after.distributed).toBe(0n);
    expect(after.capped).toBe(0n);
    expect(after.state.reserveRemaining).toBe(0n);
    expect(after.state.globalRewardIndex).toBe(state.globalRewardIndex);
    expect(after.fullyMined).toBe(true);
  });

  it("leaves the reserve untouched when nothing is eligible", () => {
    const state = createRewardIndexState(1_000_000n, 10_000n);
    const block = applyBlock(state, 10_000n, 0n);
    expect(block.distributed).toBe(0n);
    expect(block.state.reserveRemaining).toBe(1_000_000n);
    expect(block.state.globalRewardIndex).toBe(0n);
  });

  it("conserves the reserve: paid plus dust plus remaining equals the initial reserve", () => {
    const initial = 100_000n;
    let state = createRewardIndexState(initial, 10_000n);
    let position = createMiningPosition("FROG", 1_000n);
    state = applyBlock(state, 10_000n, 1_000n).state;
    const settled = settlePosition(state, position);
    state = settled.state;
    position = settled.position;
    const claimed = claimPosition(position);

    const audit = auditReserve(state, initial, [claimed.position], claimed.claimed);
    expect(audit.conserved).toBe(true);
    expect(claimed.claimed + audit.dustTokens + audit.remaining).toBe(initial);
    expect(claimed.claimed).toBe(10_000n);
    expect(audit.remaining).toBe(90_000n);
  });

  it("tracks rounding dust across several positions without losing a token", () => {
    const initial = 100_000n;
    let state = createRewardIndexState(initial, 10_000n);
    const positions = [1_000n, 1_000n, 1_000n].map(() => createMiningPosition("FROG", 1_000n));
    state = applyBlock(state, 10_000n, 3_000n).state;
    const settled = settleAll(state, positions);
    state = settled.state;
    let claimedTotal = 0n;
    const claimedPositions: MiningPosition[] = [];
    for (const position of settled.positions) {
      const claim = claimPosition(position);
      claimedTotal += claim.claimed;
      claimedPositions.push(claim.position);
    }
    const audit = auditReserve(state, initial, claimedPositions, claimedTotal);
    expect(audit.dustScaled).toBeGreaterThan(0n);
    expect(audit.conserved).toBe(true);
    expect(claimedTotal + audit.dustTokens + audit.remaining).toBe(initial);
  });

  it("never pays a position more than its proportional share", () => {
    const initial = 1_000n;
    let state = createRewardIndexState(initial, 100n);
    state = applyBlock(state, 100n, 10_000n).state;
    const positions = [1_000n, 9_000n].map((power) => createMiningPosition("FROG", power));
    const settled = settleAll(state, positions);
    expect(settled.positions[0].pendingReward).toBe(10n);
    expect(settled.positions[1].pendingReward).toBe(90n);
    const paid = settled.positions[0].pendingReward + settled.positions[1].pendingReward;
    expect(paid).toBeLessThanOrEqual(100n);
    const audit = auditReserve(settled.state, initial, settled.positions, 0n);
    expect(audit.conserved).toBe(true);
  });

  it("keeps claims idempotent", () => {
    let state = createRewardIndexState(1_000_000n, 10_000n);
    state = applyBlock(state, 10_000n, 1_000n).state;
    const settled = settlePosition(state, createMiningPosition("FROG", 1_000n));
    const first = claimPosition(settled.position);
    expect(first.claimed).toBe(10_000n);
    expect(first.position.pendingReward).toBe(0n);
    const second = claimPosition(first.position);
    expect(second.claimed).toBe(0n);
    const third = claimPosition(second.position);
    expect(third.claimed).toBe(0n);
  });

  it("cannot drain the reserve through claims or oversized blocks", () => {
    const initial = 1_000n;
    let state = createRewardIndexState(initial, 100n);
    let claimedTotal = 0n;
    const position = createMiningPosition("FROG", 1_000n);
    for (let block = 0; block < 50; block += 1) {
      state = applyBlock(state, 1_000_000n, 1_000n).state;
    }
    const settled = settlePosition(state, position);
    const claim = claimPosition(settled.position);
    claimedTotal += claim.claimed;
    const audit = auditReserve(settled.state, initial, [claim.position], claimedTotal);
    expect(claimedTotal).toBeLessThanOrEqual(initial);
    expect(audit.conserved).toBe(true);
    expect(isFullyMined(settled.state)).toBe(true);
  });
});

describe("reward reductions and FULLY_MINED economics", () => {
  it("follows the configured reduction schedule", () => {
    expect(rewardReductionSchedule(4, 10_000)).toEqual([10_000, 7_500, 5_625, 4_219]);
    expect(rewardAtEpoch(1, 10_000)).toBe(7_500);
    expect(reducedReward(10_000)).toBe(7_500);
  });

  it("never reduces below the configured minimum reward", () => {
    const schedule = rewardReductionSchedule(500, 10);
    expect(Math.min(...schedule)).toBeGreaterThanOrEqual(DIGGO_CONFIG.economy.minimumReducedReward);
    for (let index = 1; index < schedule.length; index += 1) {
      expect(schedule[index]).toBeLessThanOrEqual(schedule[index - 1]);
    }
    expect(reducedReward(1)).toBe(DIGGO_CONFIG.economy.minimumReducedReward);
  });

  it("never lets the minimum floor raise a reward above its current value", () => {
    const minimum = DIGGO_CONFIG.economy.minimumReducedReward;
    // A sub-minimum block reward (a tiny mine, or a reserve split across a huge
    // launch supply) must stay where it is instead of stepping up to the floor.
    const belowMinimum = minimum / 2;
    expect(reducedReward(belowMinimum)).toBe(belowMinimum);
    const schedule = rewardReductionSchedule(6, belowMinimum);
    for (let index = 0; index < schedule.length; index += 1) {
      expect(schedule[index]).toBe(belowMinimum);
    }

    // A configured floor of zero is a real floor too: the reward decays towards it and stops.
    expect(reducedReward(100, 2_500, 0)).toBe(75);
    expect(reducedReward(1, 2_500, 0)).toBe(1);

    // A nonsensical reduction rate cannot turn into a reward increase either.
    expect(reducedReward(100, -5_000, 1)).toBe(100);
    expect(reducedReward(100, 50_000, 1)).toBe(1);
  });

  it("leaves unreduced tokens in the reserve instead of burning them", () => {
    const state = createRewardIndexState(1_000n, 100n);
    const reduced = rewardAtEpoch(1, 100);
    expect(reduced).toBe(75);
    const block = applyBlock(state, BigInt(reduced), 1_000n);
    expect(block.state.reserveRemaining).toBe(1_000n - 75n);
    expect(block.state.committed).toBe(75n);
  });

  it("keeps the legacy proportional and reserve helpers unchanged", () => {
    expect(proportionalReward(10_000, 4_000, 2_000_000)).toBe(20);
    expect(clampRewardToReserve(10_000, 2_500)).toBe(2_500);
    expect(proportionalReward(10_000, 4_000, 0)).toBe(0);
  });
});

describe("emission schedule (spec 20, 21)", () => {
  const blockInterval = 300;
  const epochLength = 604_800;
  const blocksPerEpochCount = 2_016;

  /** Runs the schedule the way a mine does: one epoch at a time, capped by the reserve. */
  function drain(reserve: number, launchReward: number, lifetimeDays: number, config = DIGGO_CONFIG) {
    let remaining = BigInt(reserve);
    let reward = BigInt(launchReward);
    let epoch = 0;
    let distributed = 0n;
    for (let guard = 0; guard < 20_000 && remaining > 0n; guard += 1) {
      const budget = epochReward({
        reserveRemaining: remaining,
        previousRewardPerBlock: reward,
        epoch,
        epochLengthSeconds: epochLength,
        blockIntervalSeconds: blockInterval,
        targetLifetimeDays: lifetimeDays,
        config,
      });
      const spent = budget * BigInt(blocksPerEpochCount);
      const capped = spent > remaining ? remaining : spent;
      distributed += capped;
      remaining -= capped;
      reward = budget;
      epoch += 1;
    }
    return { remaining, distributed, epochs: epoch };
  }

  it("distributes a whole reserve whatever the launch reward is", () => {
    for (const launchReward of [1_200, 1_900, 3_000, 7_500]) {
      const drained = drain(50_000_000, launchReward, 365);
      expect(drained.remaining).toBe(0n);
      expect(drained.distributed).toBe(50_000_000n);
      // 365 days is 53 whole epochs of 7 days, and the schedule finishes inside the last one.
      expect(drained.epochs).toBeLessThanOrEqual(53);
    }
  });

  it("keeps the target lifetime configurable and proportional to it", () => {
    expect(drain(50_000_000, 7_500, 30).epochs).toBeLessThanOrEqual(5);
    expect(drain(50_000_000, 7_500, 180).epochs).toBeLessThanOrEqual(26);
    expect(drain(200_000_000, 40_000, 730).remaining).toBe(0n);
    // A twelve-month default is what a launch gets when it says nothing.
    expect(DIGGO_CONFIG.economy.emission.targetLifetimeDays).toBe(365);
    expect(DIGGO_CONFIG.economy.emission.schedule).toBe("reserve_runway");
  });

  it("never raises a reward and never pays more than the reserve holds", () => {
    let reward = 7_500n;
    let remaining = 50_000_000n;
    for (let epoch = 1; epoch <= 60 && remaining > 0n; epoch += 1) {
      const next = epochReward({
        reserveRemaining: remaining,
        previousRewardPerBlock: reward,
        epoch,
        epochLengthSeconds: epochLength,
        blockIntervalSeconds: blockInterval,
        targetLifetimeDays: 365,
      });
      expect(next).toBeLessThanOrEqual(reward);
      if (next * BigInt(blocksPerEpochCount) > remaining) expect(next).toBeGreaterThan(0n);
      remaining -= next * BigInt(blocksPerEpochCount) > remaining ? remaining : next * BigInt(blocksPerEpochCount);
      reward = next;
    }
  });

  it("keeps paying at the floor until the reserve is empty, then stops", () => {
    const tiny = epochReward({
      reserveRemaining: 3n,
      previousRewardPerBlock: 1n,
      epoch: 50,
      epochLengthSeconds: epochLength,
      blockIntervalSeconds: blockInterval,
      targetLifetimeDays: 365,
    });
    expect(tiny).toBe(BigInt(DIGGO_CONFIG.economy.emission.minimumRewardPerBlock));
    expect(
      epochReward({
        reserveRemaining: 0n,
        previousRewardPerBlock: 100n,
        epoch: 0,
        epochLengthSeconds: epochLength,
        blockIntervalSeconds: blockInterval,
      }),
    ).toBe(0n);
    // A reserve smaller than one block's budget cannot be overpaid.
    const state = createRewardIndexState(3n, 1_000n);
    const block = applyBlock(state, 1_000n, 10n);
    expect(block.capped).toBe(3n);
    expect(block.state.reserveRemaining).toBe(0n);
  });

  it("still offers the legacy geometric step when a mine asks for it", () => {
    const legacy = createDiggoConfig({ economy: { emission: { schedule: "epoch_reduction" } } });
    expect(
      epochReward({
        reserveRemaining: 1_000_000n,
        previousRewardPerBlock: 10_000n,
        epoch: 1,
        epochLengthSeconds: epochLength,
        blockIntervalSeconds: blockInterval,
        config: legacy,
      }),
    ).toBe(7_500n);
  });

  it("describes the runway a mine is actually on", () => {
    expect(blocksPerEpoch(epochLength, blockInterval)).toBe(2_016);
    expect(epochsInLifetime(365, epochLength)).toBe(53);
    expect(epochsInLifetime(0, epochLength)).toBe(1);
    const preview = emissionSchedulePreview(
      {
        reserveRemaining: 50_000_000n,
        previousRewardPerBlock: 7_500n,
        epoch: 0,
        epochLengthSeconds: epochLength,
        blockIntervalSeconds: blockInterval,
        targetLifetimeDays: 365,
      },
      4,
    );
    expect(preview).toHaveLength(4);
    for (let index = 1; index < preview.length; index += 1) {
      expect(preview[index]).toBeLessThanOrEqual(preview[index - 1]);
    }
    expect(preview[0]).toBeGreaterThan(0n);
    expect(preview[0]).toBeLessThan(7_500n);
  });
});

describe("reserve audit with forfeits (spec 17, 19, 21)", () => {
  it("returns a forfeited share to the reserve and still balances exactly", () => {
    const initial = 1_000_000n;
    let state = createRewardIndexState(initial, 10_000n);
    const live = createMiningPosition("FROG", 1_000n);
    const paused = createMiningPosition("FROG", 1_000n);

    // Two positions share one block, but only one of them is still eligible.
    state = applyBlock(state, 10_000n, 2_000n).state;
    const liveSettled = settlePosition(state, live);
    state = liveSettled.state;
    const forfeitedSettle = settlePosition(state, { ...paused, paused: true });
    state = forfeitedSettle.state;
    expect(liveSettled.earned).toBe(5_000n);
    expect(forfeitedSettle.forfeited).toBe(5_000n);
    expect(state.forfeited).toBe(5_000n);
    expect(state.released).toBe(10_000n);
    // The forfeited half is back in the reserve: the mine only gave up what was really paid.
    expect(state.reserveRemaining).toBe(initial - 5_000n);

    const claimed = claimPosition(liveSettled.position);
    const audit = auditReserve(state, initial, [claimed.position, forfeitedSettle.position], claimed.claimed);
    expect(audit.conserved).toBe(true);
    expect(audit.indexBalanced).toBe(true);
    expect(audit.reserveBalanced).toBe(true);
    expect(audit.unattributedScaled).toBe(0n);
    expect(audit.forfeited).toBe(5_000n);
    expect(audit.released - audit.forfeited).toBe(initial - audit.remaining);
  });

  it("leaves the forfeit term in the identity, so a gross claimed total is caught", () => {
    const initial = 1_000_000n;
    let state = createRewardIndexState(initial, 10_000n);
    const paused = createMiningPosition("FROG", 1_000n);
    state = applyBlock(state, 10_000n, 1_000n).state;
    const forfeitedSettle = settlePosition(state, { ...paused, paused: true });
    state = forfeitedSettle.state;

    // A caller that books the whole block as "claimed" is off by exactly the forfeit ...
    const gross = auditReserve(state, initial, [forfeitedSettle.position], 10_000n);
    expect(gross.conserved).toBe(false);
    expect(gross.unattributedScaled).toBe(-10_000n * rewardIndexScale());
    // ... while the same audit without the phantom claim balances.
    expect(auditReserve(state, initial, [forfeitedSettle.position], 0n).conserved).toBe(true);
    // ... and a caller that passes the forfeit explicitly balances again.
    const reconciled = auditReserve(state, initial, [forfeitedSettle.position], 0n, DIGGO_CONFIG, {
      released: 10_000n,
      forfeited: 10_000n,
    });
    expect(reconciled.conserved).toBe(true);
  });

  it("reports a position the caller forgot as unattributed instead of a tolerance", () => {
    const initial = 1_000_000n;
    let state = createRewardIndexState(initial, 10_000n);
    const one = createMiningPosition("FROG", 1_000n);
    const two = createMiningPosition("FROG", 1_000n);
    state = applyBlock(state, 10_000n, 2_000n).state;
    const settledOne = settlePosition(state, one);
    const settledTwo = settlePosition(settledOne.state, two);

    const complete = auditReserve(settledTwo.state, initial, [settledOne.position, settledTwo.position], 0n);
    expect(complete.conserved).toBe(true);
    const incomplete = auditReserve(settledTwo.state, initial, [settledOne.position], 0n);
    expect(incomplete.conserved).toBe(false);
    // The missing position's whole entitlement shows up as released-but-unattributed.
    expect(incomplete.unattributedScaled).toBe(5_000n * rewardIndexScale());
  });
});
