import { BPS_DENOMINATOR, DIGGO_CONFIG, type DiggoConfig } from "./config";

/**
 * Cumulative reward index accounting (spec 17) plus the reward reduction
 * schedule (spec 21) and the FULLY_MINED terminal state (spec 20).
 *
 * All token math is BigInt. The global index is scaled by
 * config.economy.rewardIndexScale (default 1e12) so that small per-block
 * rewards can still be split across large total power without losing precision.
 */

/** Scaled units are the accounting unit of the reward index. */
export function rewardIndexScale(config: DiggoConfig = DIGGO_CONFIG): bigint {
  return BigInt(config.economy.rewardIndexScale);
}

export interface RewardIndexState {
  /** Cumulative reward per unit of eligible power, scaled by rewardIndexScale. */
  globalRewardIndex: bigint;
  totalEligiblePower: bigint;
  /** Reserve tokens that have not been committed to the index yet. */
  reserveRemaining: bigint;
  /** Whole tokens committed to the index so far (for auditing). */
  committed: bigint;
  /**
   * Sub-token rounding dust, in scaled units. Dust is never claimable; it stays
   * inside reserveRemaining and is tracked so accounting audits balance exactly.
   */
  dustScaled: bigint;
  rewardPerBlock: bigint;
  blocksProcessed: number;
  fullyMined: boolean;
}

export interface MiningPosition {
  mineId: string | null;
  assignedPower: bigint;
  lastRewardIndex: bigint;
  pendingReward: bigint;
  paused: boolean;
}

export function createRewardIndexState(
  initialReserve: bigint,
  rewardPerBlock: bigint,
  config: DiggoConfig = DIGGO_CONFIG,
): RewardIndexState {
  const reserve = initialReserve > 0n ? initialReserve : 0n;
  return {
    globalRewardIndex: 0n,
    totalEligiblePower: 0n,
    reserveRemaining: reserve,
    committed: 0n,
    dustScaled: 0n,
    rewardPerBlock: rewardPerBlock > 0n ? rewardPerBlock : 0n,
    blocksProcessed: 0,
    fullyMined: reserve === 0n,
  };
}

export function createMiningPosition(
  mineId: string | null = null,
  assignedPower: bigint = 0n,
): MiningPosition {
  return { mineId, assignedPower, lastRewardIndex: 0n, pendingReward: 0n, paused: false };
}

export interface BlockOutcome {
  state: RewardIndexState;
  /** Whole tokens pushed into the global index by this block. */
  distributed: bigint;
  /** Rounding dust withheld from the index, in scaled units. */
  dustScaled: bigint;
  /** Block budget taken from the reward schedule before rounding. */
  capped: bigint;
  fullyMined: boolean;
}

/**
 * Advances the global reward index by one block.
 *
 * The block reward is capped at the remaining reserve (spec 19). The block
 * budget leaves the reserve in full; whatever the integer index cannot allocate
 * is tracked as dust, which is never claimable. A block with no eligible power
 * leaves the reserve untouched.
 */
export function applyBlock(
  state: RewardIndexState,
  blockReward: bigint,
  totalEligiblePower: bigint,
  config: DiggoConfig = DIGGO_CONFIG,
): BlockOutcome {
  const scale = rewardIndexScale(config);
  const reward = blockReward > 0n ? blockReward : 0n;
  const power = totalEligiblePower > 0n ? totalEligiblePower : 0n;
  const capped = config.economy.enforceReserveCap ? (reward < state.reserveRemaining ? reward : state.reserveRemaining) : reward;
  const blocksProcessed = state.blocksProcessed + 1;

  if (power === 0n || capped === 0n) {
    return {
      state: {
        ...state,
        totalEligiblePower: power,
        rewardPerBlock: capped,
        blocksProcessed,
        fullyMined: state.reserveRemaining === 0n,
      },
      distributed: 0n,
      dustScaled: 0n,
      capped,
      fullyMined: state.reserveRemaining === 0n,
    };
  }

  const scaledBudget = capped * scale;
  const delta = scaledBudget / power;
  const consumedScaled = delta * power;
  const distributed = consumedScaled / scale;
  const dustScaled = scaledBudget - consumedScaled;
  const reserveRemaining = state.reserveRemaining - capped;

  return {
    state: {
      globalRewardIndex: state.globalRewardIndex + delta,
      totalEligiblePower: power,
      reserveRemaining,
      committed: state.committed + distributed,
      dustScaled: state.dustScaled + dustScaled,
      rewardPerBlock: capped,
      blocksProcessed,
      fullyMined: reserveRemaining === 0n,
    },
    distributed,
    dustScaled,
    capped,
    fullyMined: reserveRemaining === 0n,
  };
}

export interface SettleOutcome {
  state: RewardIndexState;
  position: MiningPosition;
  /** Whole tokens credited to the position by this settlement. */
  earned: bigint;
  /**
   * Whole tokens returned to the reserve because the position was paused or had
   * no assigned power when its index share was allocated.
   */
  forfeited: bigint;
}

/**
 * Lazy settlement: converts the index delta since the last settlement into
 * pending reward. Floor rounding dust is recorded so audits balance exactly.
 *
 * A paused position earns nothing: its index cursor is advanced to the current
 * index, so the paused window can never be claimed retroactively, and the share
 * allocated to it goes back to the reserve.
 */
export function settlePosition(
  state: RewardIndexState,
  position: MiningPosition,
  config: DiggoConfig = DIGGO_CONFIG,
): SettleOutcome {
  const scale = rewardIndexScale(config);
  const delta = state.globalRewardIndex - position.lastRewardIndex;
  if (delta <= 0n) return { state, position, earned: 0n, forfeited: 0n };

  if (position.paused || position.assignedPower <= 0n) {
    const shareScaled = position.assignedPower * delta;
    const forfeited = shareScaled / scale;
    const remainder = shareScaled - forfeited * scale;
    return {
      state: {
        ...state,
        reserveRemaining: state.reserveRemaining + forfeited,
        dustScaled: state.dustScaled + remainder,
      },
      position: { ...position, lastRewardIndex: state.globalRewardIndex },
      earned: 0n,
      forfeited,
    };
  }

  const rawScaled = position.assignedPower * delta;
  const earnedWhole = rawScaled / scale;
  const dust = rawScaled - earnedWhole * scale;

  return {
    state: { ...state, dustScaled: state.dustScaled + dust },
    position: {
      ...position,
      lastRewardIndex: state.globalRewardIndex,
      pendingReward: position.pendingReward + earnedWhole,
    },
    earned: earnedWhole,
    forfeited: 0n,
  };
}

/** Settles before any power change, so no reward is credited at the new power. */
export function setPositionPower(
  state: RewardIndexState,
  position: MiningPosition,
  power: bigint,
  config: DiggoConfig = DIGGO_CONFIG,
): SettleOutcome {
  const settled = settlePosition(state, position, config);
  return { ...settled, position: { ...settled.position, assignedPower: power > 0n ? power : 0n } };
}

/** Switching mines settles the previous position exactly (spec 30). */
export function switchMine(
  state: RewardIndexState,
  position: MiningPosition,
  mineId: string | null,
  config: DiggoConfig = DIGGO_CONFIG,
): SettleOutcome {
  const settled = settlePosition(state, position, config);
  return { ...settled, position: { ...settled.position, mineId } };
}

export function pausePosition(
  state: RewardIndexState,
  position: MiningPosition,
  config: DiggoConfig = DIGGO_CONFIG,
): SettleOutcome {
  const settled = settlePosition(state, position, config);
  return { ...settled, position: { ...settled.position, paused: true } };
}

export function resumePosition(
  state: RewardIndexState,
  position: MiningPosition,
): SettleOutcome {
  return {
    state,
    position: { ...position, paused: false, lastRewardIndex: state.globalRewardIndex },
    earned: 0n,
    forfeited: 0n,
  };
}

export interface ClaimOutcome {
  position: MiningPosition;
  claimed: bigint;
}

export function claimPosition(position: MiningPosition): ClaimOutcome {
  const claimed = position.pendingReward > 0n ? position.pendingReward : 0n;
  return { position: { ...position, pendingReward: 0n }, claimed };
}

export function isFullyMined(state: RewardIndexState): boolean {
  return state.reserveRemaining <= 0n;
}

/** Unsettled plus pending entitlement of a position, in scaled units. */
export function positionEntitlementScaled(
  state: RewardIndexState,
  position: MiningPosition,
  config: DiggoConfig = DIGGO_CONFIG,
): bigint {
  const scale = rewardIndexScale(config);
  const pending = position.pendingReward * scale;
  if (position.paused || position.assignedPower <= 0n) return pending;
  const delta = state.globalRewardIndex - position.lastRewardIndex;
  if (delta <= 0n) return pending;
  return pending + position.assignedPower * delta;
}

export interface ReserveAudit {
  initialReserve: bigint;
  claimed: bigint;
  claimedScaled: bigint;
  /** Rounding dust withheld from the index, in scaled units. */
  dustScaled: bigint;
  /** Dust expressed in whole tokens. */
  dustTokens: bigint;
  remaining: bigint;
  /** Whole tokens pushed into the global index, for operator visibility. */
  committed: bigint;
  /** Entitlement still owed to the supplied positions, in scaled units. */
  outstandingScaled: bigint;
  /**
   * True when every token is accounted for, which is the invariant
   * claimed + dust + outstanding + remaining == initial reserve.
   */
  conserved: boolean;
}

/**
 * Conservation audit (spec 17, 21): every token of the initial reserve is either
 * claimed, still outstanding to a position, withheld as rounding dust, or still
 * sitting in the reserve. Nothing is minted and nothing disappears.
 */
export function auditReserve(
  state: RewardIndexState,
  initialReserve: bigint,
  positions: readonly MiningPosition[],
  claimedTotal: bigint,
  config: DiggoConfig = DIGGO_CONFIG,
): ReserveAudit {
  const scale = rewardIndexScale(config);
  const claimedScaled = claimedTotal * scale;
  let outstandingScaled = 0n;
  for (const position of positions) {
    outstandingScaled += positionEntitlementScaled(state, position, config);
  }
  const accounted =
    claimedScaled + state.dustScaled + outstandingScaled + state.reserveRemaining * scale;
  return {
    initialReserve,
    claimed: claimedTotal,
    claimedScaled,
    dustScaled: state.dustScaled,
    dustTokens: state.dustScaled / scale,
    remaining: state.reserveRemaining,
    committed: state.committed,
    outstandingScaled,
    conserved: accounted === initialReserve * scale,
  };
}

export function proportionalReward(
  blockReward: number,
  assignedPower: number,
  totalPower: number,
): number {
  if (blockReward < 0 || assignedPower < 0 || totalPower <= 0) return 0;
  return Math.min(blockReward, blockReward * (assignedPower / totalPower));
}

/**
 * One reduction step of the reward schedule (spec 21). Unreduced tokens are not
 * burned: they stay in the Mining Reserve because applyBlock only removes what
 * it distributes.
 *
 * The configured minimum is a floor on how far one reduction may travel, not a
 * value that may raise a reward. A block reward that already sits at or below
 * the minimum is kept as it is, so the schedule is non-increasing and an epoch
 * step can never pay out more than the step before it.
 */
export function reducedReward(
  currentReward: number,
  reductionBps: number = DIGGO_CONFIG.economy.rewardReductionBps,
  minimumReward: number = DIGGO_CONFIG.economy.minimumReducedReward,
): number {
  if (currentReward <= 0) return 0;
  const bps = Number.isFinite(reductionBps) ? Math.min(BPS_DENOMINATOR, Math.max(0, reductionBps)) : 0;
  const reduction = Math.floor((currentReward * bps) / BPS_DENOMINATOR);
  const floor = Number.isFinite(minimumReward) && minimumReward > 0 ? minimumReward : 0;
  return Math.min(currentReward, Math.max(floor, currentReward - reduction));
}

export function rewardAtEpoch(
  epochIndex: number,
  baseReward: number,
  config: DiggoConfig = DIGGO_CONFIG,
): number {
  let reward = baseReward;
  const steps = Math.max(0, Math.floor(epochIndex));
  for (let step = 0; step < steps; step += 1) {
    reward = reducedReward(reward, config.economy.rewardReductionBps, config.economy.minimumReducedReward);
  }
  return reward;
}

export function rewardReductionSchedule(
  epochs: number,
  baseReward: number,
  config: DiggoConfig = DIGGO_CONFIG,
): number[] {
  const schedule: number[] = [];
  for (let epoch = 0; epoch < Math.max(0, epochs); epoch += 1) {
    schedule.push(rewardAtEpoch(epoch, baseReward, config));
  }
  return schedule;
}

export function clampRewardToReserve(reward: number, reserve: number): number {
  return Math.max(0, Math.min(reward, reserve));
}
