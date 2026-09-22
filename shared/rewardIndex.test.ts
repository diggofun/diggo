import { describe, expect, it } from "vitest";
import { DIGGO_CONFIG } from "./config";
import {
  applyBlock,
  auditReserve,
  claimPosition,
  clampRewardToReserve,
  createMiningPosition,
  createRewardIndexState,
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
