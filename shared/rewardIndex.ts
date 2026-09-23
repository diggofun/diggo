import { BPS_DENOMINATOR, DIGGO_CONFIG, type DiggoConfig, type EmissionConfig } from "./config";

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
   * Whole tokens that have left the reserve into the index, with the reserve cap applied. The
   * reserve only ever shrinks by this amount, and only grows by forfeits.
   */
  released: bigint;
  /**
   * Whole tokens returned to the reserve by forfeited positions (a paused position that still held
   * power). Forfeits are the one way a released token comes back, which is why every conservation
   * identity below carries them as an explicit term (spec 19, 21).
   */
  forfeited: bigint;
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
    released: 0n,
    forfeited: 0n,
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
      released: state.released + capped,
      forfeited: state.forfeited,
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
        forfeited: state.forfeited + forfeited,
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

/**
 * Overrides for the two ledger totals the audit normally reads straight off the state. They exist
 * for callers that keep their own counters (an operator reconciling a mine by hand, or a harness
 * that has already settled positions out of band); with no overrides the audit is self-contained.
 */
export interface ReserveAuditOptions {
  /** Whole tokens that left the reserve into the index; defaults to the state's own counter. */
  released?: bigint;
  /**
   * Whole tokens forfeits returned to the reserve; defaults to the state's own counter. Forfeited
   * and unassigned rewards always go back to the reserve - they are never lost and never burned.
   */
  forfeited?: bigint;
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
  /** Whole tokens that have left the reserve into the index. */
  released: bigint;
  /** Whole tokens forfeits have returned to the reserve. */
  forfeited: bigint;
  /** Net tokens the reserve has given up: released minus forfeited. */
  drained: bigint;
  /**
   * Sub-token rounding still sitting inside the open positions, in scaled units. It is not dust
   * yet: it becomes dust (or a whole token) the moment the position is settled.
   */
  openRemainderScaled: bigint;
  /**
   * Tokens the index released that neither a claim, nor a forfeit, nor a live entitlement, nor
   * dust accounts for, in scaled units. Always zero once every position of this index is supplied.
   */
  unattributedScaled: bigint;
  /** released - forfeited == initialReserve - remaining. */
  reserveBalanced: boolean;
  /** released == claimed + forfeited + outstanding + open remainder + dust. */
  indexBalanced: boolean;
  /**
   * True when both conservation identities hold exactly:
   *
   *   released - forfeited == initialReserve - remaining
   *   released == claimed + forfeited + outstanding + openRemainder + dust
   *
   * The second one is the one that catches a real bug: it says every token the index released is
   * either owned by a position, forfeited back into the reserve, or rounding dust - and that any
   * position the caller forgot to supply (or a reward a caller dropped) shows up as an
   * `unattributed` residual instead of vanishing inside a rounding-sized tolerance.
   */
  conserved: boolean;
}

/**
 * Conservation audit (spec 17, 19, 21): every token of the initial reserve is either claimed, still
 * outstanding to a position, forfeited back into the reserve, withheld as rounding dust, or still
 * sitting in the reserve. Nothing is minted, nothing is burned and nothing is lost.
 *
 * Supply every position that belongs to this index (a position's `mineId`, not the mine a player
 * happens to be pointing at): an omitted live position is exactly what an `unattributed` residual
 * reports.
 */
export function auditReserve(
  state: RewardIndexState,
  initialReserve: bigint,
  positions: readonly MiningPosition[],
  claimedTotal: bigint,
  config: DiggoConfig = DIGGO_CONFIG,
  options: ReserveAuditOptions = {},
): ReserveAudit {
  const scale = rewardIndexScale(config);
  const claimedScaled = claimedTotal * scale;
  let outstandingScaled = 0n;
  let openRemainderScaled = 0n;
  for (const position of positions) {
    const delta = state.globalRewardIndex - position.lastRewardIndex;
    if (position.paused || position.assignedPower <= 0n || delta <= 0n) {
      // Everything such a position is owed is already whole: a forfeit only credits whole tokens
      // back to the reserve, and its remainder is booked as dust by settlePosition.
      outstandingScaled += position.pendingReward * scale;
      continue;
    }
    const rawScaled = position.assignedPower * delta;
    outstandingScaled += position.pendingReward * scale + (rawScaled / scale) * scale;
    openRemainderScaled += rawScaled - (rawScaled / scale) * scale;
  }
  const released = options.released ?? state.released;
  const forfeited = options.forfeited ?? state.forfeited;
  const forfeitedScaled = forfeited * scale;
  const releasedScaled = released * scale;
  const accounted =
    claimedScaled + forfeitedScaled + outstandingScaled + openRemainderScaled + state.dustScaled;
  const unattributedScaled = releasedScaled - accounted;
  const reserveBalanced = released - forfeited === initialReserve - state.reserveRemaining;
  const indexBalanced = unattributedScaled === 0n;
  return {
    initialReserve,
    claimed: claimedTotal,
    claimedScaled,
    dustScaled: state.dustScaled,
    dustTokens: state.dustScaled / scale,
    remaining: state.reserveRemaining,
    committed: state.committed,
    released,
    forfeited,
    drained: released - forfeited,
    openRemainderScaled,
    outstandingScaled,
    unattributedScaled,
    reserveBalanced,
    indexBalanced,
    conserved: indexBalanced && reserveBalanced,
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

// --- emission schedule (spec 20, 21) -----------------------------------------------------

export function emissionConfig(config: DiggoConfig = DIGGO_CONFIG): EmissionConfig {
  return config.economy.emission;
}

/** Blocks in one epoch, never below one. */
export function blocksPerEpoch(epochLengthSeconds: number, blockIntervalSeconds: number): number {
  if (!Number.isFinite(epochLengthSeconds) || !Number.isFinite(blockIntervalSeconds) || blockIntervalSeconds <= 0) {
    return 1;
  }
  return Math.max(1, Math.floor(epochLengthSeconds / blockIntervalSeconds));
}

/** Epochs in the configured target lifetime, never below one. */
export function epochsInLifetime(
  targetLifetimeDays: number,
  epochLengthSeconds: number,
  secondsPerDay = DIGGO_CONFIG.time.secondsPerDay,
): number {
  if (
    !Number.isFinite(targetLifetimeDays) ||
    targetLifetimeDays <= 0 ||
    !Number.isFinite(epochLengthSeconds) ||
    epochLengthSeconds <= 0
  ) {
    return 1;
  }
  return Math.max(1, Math.ceil((targetLifetimeDays * secondsPerDay) / epochLengthSeconds));
}

export interface EmissionInput {
  /** Tokens still inside the mine's Mining Reserve. */
  reserveRemaining: bigint;
  /** The reward the mine is paying now, i.e. the value this step may not raise. */
  previousRewardPerBlock: bigint;
  /** The mine's own epoch counter, counting from the launch epoch. */
  epoch: number;
  epochLengthSeconds: number;
  blockIntervalSeconds: number;
  /** Per-mine launch parameter; falls back to `economy.emission.targetLifetimeDays`. */
  targetLifetimeDays?: number;
  config?: DiggoConfig;
}

/**
 * Blocks left of the target lifetime, counting from the epoch that is starting. Never below one:
 * the last epoch of the lifetime pays whatever is left.
 */
export function blocksLeftOfLifetime(input: EmissionInput): bigint {
  const config = input.config ?? DIGGO_CONFIG;
  const target = input.targetLifetimeDays ?? config.economy.emission.targetLifetimeDays;
  const perEpoch = BigInt(blocksPerEpoch(input.epochLengthSeconds, input.blockIntervalSeconds));
  const total = BigInt(epochsInLifetime(target, input.epochLengthSeconds, config.time.secondsPerDay));
  const elapsed = BigInt(Math.max(0, Math.floor(input.epoch)));
  const epochsLeft = total - elapsed;
  return perEpoch * (epochsLeft > 1n ? epochsLeft : 1n);
}

/**
 * The block reward a mine pays for one epoch (spec 20, 21).
 *
 * Under the default `reserve_runway` schedule the budget is the remaining reserve divided by the
 * blocks left of the configured target lifetime, so the whole reserve is distributable - every
 * epoch pays out its share of what is actually left, and the last epoch pays the remainder.
 * Three rules keep it sane:
 *   - a floor (`minimumRewardPerBlock`), applied until the reserve is exhausted, so the tail can
 *     never stall at zero and strand tokens in the reserve;
 *   - monotone non-increasing by default, so a reward never rises from one epoch to the next
 *     (spec 21 is a *reduction* schedule), which is the one thing that can stretch the runway
 *     past the target when a mine sat idle;
 *   - unreduced tokens stay in the reserve: this function only decides a budget, and applyBlock
 *     only ever removes what it distributes.
 *
 * `epoch_reduction` keeps the legacy fixed-percentage step for mines that want a pure decay curve.
 */
export function epochReward(input: EmissionInput): bigint {
  const config = input.config ?? DIGGO_CONFIG;
  const emission = config.economy.emission;
  const reserve = input.reserveRemaining > 0n ? input.reserveRemaining : 0n;
  if (reserve === 0n) return 0n;
  const previous = input.previousRewardPerBlock > 0n ? input.previousRewardPerBlock : 0n;

  if (emission.schedule === "epoch_reduction") {
    const current = previous > 0n ? previous : reserve;
    return BigInt(
      reducedReward(Number(current), config.economy.rewardReductionBps, config.economy.minimumReducedReward),
    );
  }

  const floorReward = BigInt(Math.max(1, Math.floor(emission.minimumRewardPerBlock)));
  const blocksLeft = blocksLeftOfLifetime(input);
  // Rounded up: an epoch must always be able to finish the reserve it is holding, so the last
  // fraction of a percent cannot trickle out for days at one token per block.
  const budget = (reserve + blocksLeft - 1n) / blocksLeft;
  let scheduled = budget > floorReward ? budget : floorReward;
  if (emission.nonIncreasing && previous > 0n && scheduled > previous) scheduled = previous;
  return scheduled;
}

/**
 * The reward the reserve-runway schedule would pay on the first block of a fresh mine: the
 * remaining reserve spread over the whole target lifetime. Reported as the recommended launch
 * parameter, because a launch reward far above it front-loads the first epoch (the schedule
 * corrects from the next epoch on, but the tokens paid in epoch zero are already gone).
 */
export function launchRunwayReward(
  initialReserve: bigint,
  epochLengthSeconds: number,
  blockIntervalSeconds: number,
  targetLifetimeDays?: number,
  config: DiggoConfig = DIGGO_CONFIG,
): bigint {
  const perEpoch = BigInt(blocksPerEpoch(epochLengthSeconds, blockIntervalSeconds));
  const target = targetLifetimeDays ?? config.economy.emission.targetLifetimeDays;
  const total = BigInt(epochsInLifetime(target, epochLengthSeconds, config.time.secondsPerDay));
  const blocks = perEpoch * total;
  const reserve = initialReserve > 0n ? initialReserve : 0n;
  // Rounded up, like the epoch budget it recommends: a launch reward at the floor of the schedule
  // would leave the last fraction of the reserve trickling out after the target lifetime.
  return blocks > 0n ? (reserve + blocks - 1n) / blocks : 0n;
}

/**
 * The next `epochs` block rewards the schedule would pay, starting from the current epoch
 * (spec 21, 33). This is what a mine page can show a player instead of a fixed decay curve: it is
 * the schedule the mine is actually on, and it ends when the reserve does. It assumes every block
 * is mined; blocks nobody mines leave their tokens in the reserve and slow the countdown instead.
 */
export function emissionSchedulePreview(
  input: EmissionInput,
  epochs: number,
  config: DiggoConfig = DIGGO_CONFIG,
): bigint[] {
  const steps = Math.max(0, Math.floor(epochs));
  const schedule: bigint[] = [];
  const perEpoch = BigInt(blocksPerEpoch(input.epochLengthSeconds, input.blockIntervalSeconds));
  let reserve = input.reserveRemaining > 0n ? input.reserveRemaining : 0n;
  let previous = input.previousRewardPerBlock > 0n ? input.previousRewardPerBlock : 0n;
  for (let step = 0; step < steps; step += 1) {
    const reward = epochReward({
      ...input,
      reserveRemaining: reserve,
      previousRewardPerBlock: previous,
      epoch: input.epoch + step,
      config,
    });
    schedule.push(reward);
    const budget = reward * perEpoch;
    reserve = reserve > budget ? reserve - budget : 0n;
    previous = reward;
  }
  return schedule;
}
