/**
 * Mining Crew game loop: daily activation and streak, ORE accrual, off-chain mining positions on
 * top of a per-mine cumulative reward index, the Mining Report (spec 29) and reward claims
 * (spec 53, 57).
 *
 * Division of authority (spec 78):
 *   - ORE and Crew progression are internal, non-transferable game state. This backend is the
 *     authority for it.
 *   - A player's real memecoin balance only ever moves through the Solana program. When that
 *     program is authoritative for a mine (mine_reward_state.authority = 'ONCHAIN_INDEXED') the
 *     numbers here are the indexed/estimated view and every response says so; otherwise
 *     ('OFFCHAIN', the default until a mine is synced from chain) these tables are the
 *     accounting source for the report and the keeper pays the settled claims out.
 *
 * Scalability (spec 17, 78): blocks are advanced lazily and in bounded batches on read/write, and
 * a position is settled exactly once per settlement point instead of once per block per player.
 */
import {
  address,
  getBase58Encoder,
  type Address,
  type Instruction,
  type ReadonlyUint8Array,
} from "@solana/kit";
import { DIGGO_CONFIG, type DiggoConfig } from "../shared/config";
import { crewTier, crewPower, effectiveMiningPower } from "../shared/crew";
import {
  activeMineBudget,
  curveMiningDaysRemaining,
  curveMiningProgress,
  curveMiningRoom,
  isCurveMiningDisabled,
  isCurveMiningOpen,
  type CurveMiningState,
} from "../shared/curve";
import { discoveryEligible } from "../shared/discovery";
import { oreCapacity, oreForActiveSeconds, oreFromActivation, storeOre } from "../shared/ore";
import {
  buildClaimRewardsInstruction,
  deriveAssociatedTokenAddress,
  deriveMineAddresses,
  derivePositionPda,
} from "../shared/program";
import {
  applyBlock,
  emissionSchedulePreview,
  epochReward,
  settlePosition,
  type MiningPosition,
  type RewardIndexState,
} from "../shared/rewardIndex";
import { applyActivation, activationEligibility, isEligibleForBlock } from "../shared/streak";
import type {
  DiscoveryRecord,
  IndexingEvent,
  MineAuthority,
  MineInfo,
  MiningAccounting,
  MiningReport,
  MiningReportBlockReward,
  MiningReportDiscoveries,
  MiningReportMilestone,
  MineEmissionSource,
  RewardClaimPayout,
  TokenStatus,
} from "../shared/types";
import {
  challengeKey,
  consumeChallengeNonce,
  issueChallenge,
  loadChallenge,
  sessionWallet,
  storeChallenge,
  verifyWalletSignature,
} from "./auth";
import { isBreakerOpen } from "./breakers";
import { getChainRpc } from "./chain";
import { rollDiscovery } from "./discovery";
import type { RuntimeEnv } from "./env";
import { apiError, checkRateLimit, checkWalletRateLimit, isBase58Address, json, readJson } from "./http";
import {
  activationRecordOf,
  activationStateOf,
  crewLevelsOf,
  getOrCreatePlayer,
  mergeStringLists,
  parseStringList,
  rowToProfile,
  type PlayerRow,
} from "./player";
import { gateAction, miningClusterCounts, recordActivity } from "./risk";
import { metric } from "./telemetry";

/**
 * Nominal cadence of the off-chain block index, matching the program's DEFAULT_BLOCK_INTERVAL.
 * A mine keeps its own copy in mine_reward_state so the accounting stays self-describing and a
 * chain sync can correct it later.
 */
export const NOMINAL_BLOCK_INTERVAL_SECONDS = 300;
export const NOMINAL_EPOCH_LENGTH_SECONDS = 604_800;
/** Bounds per call, so one request can never walk an unbounded block range (spec 78). */
export const MAX_BLOCKS_PER_ADVANCE = 512;
/**
 * Epoch steps one advance call may take before it stops and resumes on the next call.
 *
 * The on-chain walk has the same shape for the same reason (MAX_SYNC_SEGMENTS in
 * programs/diggo-protocol): one block's worth of catch-up can span an arbitrary number of epoch
 * boundaries, and a schedule with a very short epoch length would otherwise make a single call do
 * unbounded work inside one block. Reaching the budget is not a failure - the epochs stepped so far
 * are persisted, so the next call continues from exactly there.
 */
export const MAX_EPOCHS_PER_ADVANCE = 64;
export const MAX_EXPIRY_ROWS = 256;
/** How long a settled block-reward claim stays claimable before it expires. */
export const REWARD_CLAIM_WINDOW_SECONDS = 30 * 86_400;
export const REDUCTION_SCHEDULE_EPOCHS = 8;
export const ESTIMATE_LABEL = "Estimate based on current conditions.";
/**
 * The label a mine on its bonding curve uses instead. Curve-phase emission is a fixed budget
 * spread over a runway fixed at launch, so the honest caveat is not "conditions" but "this is
 * the cap the launch set", and it is never a promise about what a block will be worth.
 */
export const CURVE_PHASE_ESTIMATE_LABEL =
  "Estimate based on the curve's mining cap, which is fixed at launch.";
export const VERIFICATION_REQUIRED = "VERIFICATION_REQUIRED";

export type MineStatus = "MINING_ACTIVE" | "FULLY_MINED" | "PAUSED";
export type RewardClaimStatus = "PENDING" | "ELIGIBLE" | "CLAIMED" | "EXPIRED" | "HELD";

export interface MineState {
  mint: string;
  rewardIndex: bigint;
  /** Unix seconds of the last credited block; 0 means no block has been credited yet. */
  lastBlock: number;
  remainingReserve: bigint;
  initialReserve: bigint;
  epoch: number;
  status: MineStatus;
  totalEligiblePower: bigint;
  rewardPerBlock: bigint;
  committed: bigint;
  dustScaled: bigint;
  /**
   * Whole tokens applyBlock has taken out of the reserve into the index (spec 19). Stored rather
   * than derived: every position floors its own share, so in a mine with more than one miner the
   * whole tokens the positions hold are not a function of `committed`.
   */
  released: bigint;
  /** Whole tokens a forfeit has handed back to the reserve (spec 19, 21). */
  forfeited: bigint;
  blockInterval: number;
  epochLength: number;
  epochEndsAt: number;
  authority: MineAuthority;
  /**
   * Days over which this mine is meant to distribute its whole Mining Reserve (spec 20, 21). It is
   * a launch parameter of the mine, like its reserve split and its starting reward, so it is not
   * stored in DIGGO_CONFIG: a mine that does not set one follows
   * the configured default `economy.emission.targetLifetimeDays`.
   */
  targetLifetimeDays?: number;
  /**
   * Which budget pays the next block. "CURVE" while the mine is on its bonding curve: its
   * block rewards come out of the curve's own token inventory, bounded by the launch-time cap
   * and paid at a flat rate. "RESERVE" once the market has graduated, which is where the
   * reserve-runway schedule below applies.
   */
  emissionSource: MineEmissionSource;
  /**
   * The curve's ledger as chain reports it. Display-only: the index's own running totals are
   * remainingReserve / committed / released, which are maintained here rather than re-read.
   */
  curve: CurveMiningState;
}

interface MineStateRow {
  mint: string;
  reward_index: string;
  last_block: number;
  remaining_reserve: string;
  initial_reserve: string;
  epoch: number;
  status: MineStatus;
  total_eligible_power: string;
  reward_per_block: string;
  committed: string;
  dust_scaled: string;
  released: string;
  forfeited: string;
  block_interval: number;
  epoch_length: number;
  epoch_ends_at: number;
  authority: MineAuthority;
  emission_source: MineEmissionSource | null;
}

export interface MineTokenRow {
  mint: string;
  symbol: string;
  status: TokenStatus;
  reserve_remaining: number;
  reserve_total: number;
  reward_per_block: number;
  next_block_at: number;
  next_epoch_at: number;
  synced_at: number;
  /** The market the price comes from, and the curve ledger it carries. */
  venue: string;
  curve_mining_open: number;
  curve_mining_cap: number;
  curve_mining_mined: number;
  curve_mining_unpaid: number;
  curve_mining_block_reward: number;
}

export interface PositionRow {
  wallet: string;
  mint: string;
  assigned_power: string;
  /** The crew's nominal power this position was armed from, before maturity/cluster/share cap. */
  raw_power: string;
  last_reward_index: string;
  pending_reward: string;
  paused: number;
  activated_at: number | null;
  active_until: number | null;
  claim_seq: number;
}

export interface RewardClaimRow {
  id: string;
  wallet: string;
  mint: string;
  amount: string;
  status: RewardClaimStatus;
  created_at: number;
  eligible_until: number;
  claimed_at: number | null;
  /** When this claim was parked in HELD, so its window can stop running while it is held. */
  held_at: number | null;
  settlement_seq: number;
  authority: MineAuthority;
  tx_signature: string | null;
  /** Token amount the confirmed payout actually moved, measured from the transaction itself. */
  paid_amount: string | null;
}

/** A mining position as the accounting needs it, independent of storage. */
export interface PositionSnapshot {
  wallet: string;
  assignedPower: bigint;
  lastRewardIndex: bigint;
  pendingReward: bigint;
  activatedAt: number | null;
  activeUntil: number | null;
  paused: boolean;
}

export interface ExpiryCredit {
  wallet: string;
  assignedPower: bigint;
  earned: bigint;
  forfeited: bigint;
  pendingReward: bigint;
  indexAtExpiry: bigint;
  blockTime: number;
  /** Blocks this position was credited with while it was armed and eligible (spec 68). */
  blocksWon: number;
}

export interface AdvanceInput {
  state: MineState;
  positions: readonly PositionSnapshot[];
  /** Credit blocks up to this timestamp; with exclusive, only strictly before it. */
  upTo: number;
  /** true = the block landing exactly on upTo is left for the next caller (position arming). */
  exclusive?: boolean;
  maxBlocks?: number;
  config?: DiggoConfig;
}

export interface AdvanceOutcome {
  state: MineState;
  expiries: ExpiryCredit[];
  blocksAdvanced: number;
  distributed: bigint;
}

function big(value: string | number | null | undefined, fallback = 0n): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return Number.isFinite(value) ? BigInt(Math.trunc(value)) : fallback;
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    return BigInt(value);
  } catch {
    // A column that stores its number as REAL arrives as "100.0". Truncating towards zero is
    // still the honest reading of that cell, and is strictly better than reporting a reward of
    // zero because the storage type drifted.
    const parsed = Number(value);
    return Number.isFinite(parsed) ? BigInt(Math.trunc(parsed)) : fallback;
  }
}

export function rowToMineState(row: MineStateRow): MineState {
  return {
    mint: row.mint,
    rewardIndex: big(row.reward_index),
    lastBlock: row.last_block,
    remainingReserve: big(row.remaining_reserve),
    initialReserve: big(row.initial_reserve),
    epoch: row.epoch,
    status: row.status,
    totalEligiblePower: big(row.total_eligible_power),
    rewardPerBlock: big(row.reward_per_block),
    committed: big(row.committed),
    dustScaled: big(row.dust_scaled),
    released: big(row.released),
    forfeited: big(row.forfeited),
    blockInterval: row.block_interval > 0 ? row.block_interval : NOMINAL_BLOCK_INTERVAL_SECONDS,
    epochLength: row.epoch_length > 0 ? row.epoch_length : NOMINAL_EPOCH_LENGTH_SECONDS,
    epochEndsAt: row.epoch_ends_at,
    authority: row.authority,
    // A row written before curve mining existed reads as a reserve-phase mine, which is what
    // it was; loadMineState reconciles this against the chain before anything uses it.
    emissionSource: row.emission_source === "CURVE" ? "CURVE" : "RESERVE",
    curve: { graduated: true, cap: 0n, mined: 0n, unpaid: 0n, blockReward: 0n },
  };
}

export function rowToPositionSnapshot(row: PositionRow): PositionSnapshot {
  return {
    wallet: row.wallet,
    assignedPower: big(row.assigned_power),
    lastRewardIndex: big(row.last_reward_index),
    pendingReward: big(row.pending_reward),
    activatedAt: row.activated_at,
    activeUntil: row.active_until,
    paused: row.paused === 1,
  };
}

export function toRewardIndexState(state: MineState): RewardIndexState {
  return {
    globalRewardIndex: state.rewardIndex,
    totalEligiblePower: state.totalEligiblePower,
    reserveRemaining: state.remainingReserve,
    committed: state.committed,
    // The mine's own ledger counters. Reconstructing them from dustScaled + committed only works
    // while a mine has a single position: with two or more, the per-position flooring leaves whole
    // tokens in the positions that `committed` (the block-level floor) never counted, and the
    // sub-token remainders only reach dustScaled when a position settles.
    released: state.released,
    forfeited: state.forfeited,
    dustScaled: state.dustScaled,
    rewardPerBlock: state.rewardPerBlock,
    blocksProcessed: 0,
    fullyMined: state.remainingReserve <= 0n,
  };
}

function toMiningPosition(mint: string, position: PositionSnapshot): MiningPosition {
  return {
    mineId: mint,
    assignedPower: position.assignedPower,
    lastRewardIndex: position.lastRewardIndex,
    pendingReward: position.pendingReward,
    paused: position.paused,
  };
}

/**
 * True when a mine's schedule can actually move forward: a block interval of zero would credit the
 * same instant over and over, and an epoch length of zero would make the epoch walk inside one block
 * step forever. Neither can come from a well-formed row (rowToMineState substitutes the nominal
 * values), which is exactly why a state carrying one is refused rather than quietly walked.
 */
export function scheduleCanAdvance(state: MineState): boolean {
  return state.blockInterval > 0 && state.epochLength > 0;
}

/**
 * Advances one mine's cumulative reward index over the blocks that are due, in memory.
 *
 * Two rules make the boundary behaviour exact (spec 77):
 *   - a position expires *before* the block that lands on its active_until, so no block at or
 *     after active_until is ever credited to it;
 *   - the index cursor is what makes activation inclusive: a position armed at T starts from the
 *     index as of T, so a block landing exactly on T still belongs to it.
 *
 * Pure: no storage, no clock. worker/mining.ts persists the result write-ahead (index first,
 * then the position credits it implies), so a retry can credit but never double-credit.
 */
export function simulateAdvance(input: AdvanceInput): AdvanceOutcome {
  const config = input.config ?? DIGGO_CONFIG;
  const maxBlocks = Math.max(0, input.maxBlocks ?? MAX_BLOCKS_PER_ADVANCE);
  const { state } = input;
  const expiries: ExpiryCredit[] = [];
  if (state.lastBlock <= 0 || maxBlocks === 0 || state.status === "FULLY_MINED") {
    return { state, expiries, blocksAdvanced: 0, distributed: 0n };
  }
  // Fail closed on a schedule that cannot advance, before any work: nothing is credited and the
  // caller is handed its own state back. advanceMineTo records the refusal as a metric.
  if (!scheduleCanAdvance(state)) {
    return { state, expiries, blocksAdvanced: 0, distributed: 0n };
  }

  let core = toRewardIndexState(state);
  let rewardPerBlock = state.rewardPerBlock;
  let epoch = state.epoch;
  let epochEndsAt = state.epochEndsAt;
  let cursor = state.lastBlock;
  let blocksAdvanced = 0;
  let distributed = 0n;
  const positions = input.positions.map((position) => ({ ...position }));

  while (blocksAdvanced < maxBlocks) {
    const blockTime = cursor + state.blockInterval;
    if (input.exclusive === true ? blockTime >= input.upTo : blockTime > input.upTo) break;

    if (epochEndsAt > 0 && blockTime >= epochEndsAt) {
      let stepped = 0;
      while (blockTime >= epochEndsAt) {
        // Per-call epoch budget, like the on-chain segment budget. Stopping here leaves the block
        // uncredited and the *epoch cursor* advanced, which the caller persists: the next call picks
        // the same block up with the remaining epochs, so a burst of catch-up costs several calls
        // instead of one unbounded one.
        if (stepped >= MAX_EPOCHS_PER_ADVANCE) break;
        // The epoch boundary is where the schedule steps down (spec 21). Under the reserve-runway
        // schedule the step is derived from the reserve that is actually left, so the mine's whole
        // Mining Reserve stays distributable however it was launched (spec 19, 20).
        //
        // The curve phase is not that schedule and does not step down: its rate is the launch-time
        // cap spread over its own runway, flat by design, so a mine on its curve pays the same
        // block reward until the cap is spent or the market graduates. The epoch still rolls,
        // because the reserve schedule the mine inherits at graduation is counted in epochs.
        if (state.emissionSource === "RESERVE") {
          rewardPerBlock = epochReward({
            reserveRemaining: core.reserveRemaining,
            previousRewardPerBlock: rewardPerBlock,
            epoch: epoch + 1,
            epochLengthSeconds: state.epochLength,
            blockIntervalSeconds: state.blockInterval,
            targetLifetimeDays: state.targetLifetimeDays,
            config,
          });
        }
        epoch += 1;
        epochEndsAt += state.epochLength;
        stepped += 1;
      }
      if (blockTime >= epochEndsAt) break;
    }

    for (const position of positions) {
      if (position.assignedPower <= 0n || position.activeUntil === null) continue;
      if (isEligibleForBlock(position.activeUntil, blockTime, position.activatedAt ?? 0)) continue;
      const settled = settlePosition(core, toMiningPosition(state.mint, position), config);
      core = settled.state;
      const pendingReward = position.pendingReward + settled.earned;
      expiries.push({
        wallet: position.wallet,
        assignedPower: position.assignedPower,
        earned: settled.earned,
        forfeited: settled.forfeited,
        pendingReward,
        indexAtExpiry: core.globalRewardIndex,
        blockTime,
        // The block that just fell outside the window is the cursor the position's entitlement
        // runs to, so the count is exact whether or not this call is the one that armed it.
        blocksWon: creditedBlockCount({
          activatedAt: position.activatedAt ?? 0,
          activeUntil: position.activeUntil,
          cursor: blockTime,
          blockInterval: state.blockInterval,
        }),
      });
      core = { ...core, totalEligiblePower: core.totalEligiblePower - position.assignedPower };
      position.assignedPower = 0n;
      position.pendingReward = pendingReward;
      position.paused = true;
    }

    const outcome = applyBlock(core, rewardPerBlock, core.totalEligiblePower, config);
    core = outcome.state;
    distributed += outcome.distributed;
    cursor = blockTime;
    blocksAdvanced += 1;
    // Only the reserve has a terminal state. A curve-phase mine whose cap is spent is idle:
    // its blocks accrue nothing, and the walk still has to move past them (see the completeness
    // rule in worker/mining.ts's loadMineState), so it never stops on an empty curve budget the
    // way it stops on an empty reserve.
    if (outcome.fullyMined && state.emissionSource === "RESERVE") break;
  }

  const fullyMined = state.emissionSource === "RESERVE" && core.reserveRemaining <= 0n;
  return {
    state: {
      ...state,
      rewardIndex: core.globalRewardIndex,
      lastBlock: blocksAdvanced > 0 ? cursor : state.lastBlock,
      remainingReserve: core.reserveRemaining,
      committed: core.committed,
      dustScaled: core.dustScaled,
      totalEligiblePower: core.totalEligiblePower,
      rewardPerBlock,
      epoch,
      epochEndsAt,
      released: core.released,
      forfeited: core.forfeited,
      status: fullyMined ? "FULLY_MINED" : state.status,
    },
    expiries,
    blocksAdvanced,
    distributed,
  };
}

/**
 * Seconds a crew actually worked in the window that just ended. Time after active_until is not
 * credited: a paused mine generates no ORE (spec 3, 16).
 */
export function activeSecondsForWindow(
  now: number,
  activeUntil: number | null,
  from: number | null,
): number {
  const start = from === null ? now : Math.min(from, now);
  const end = activeUntil === null ? start : Math.min(now, activeUntil);
  return Math.max(0, end - start);
}

/**
 * How many blocks one armed position was credited with between being armed and `cursor` (spec 68).
 *
 * A mine's block grid is anchored on its persisted cursor and steps by `blockInterval`, and a
 * position is always armed on that grid: arming is preceded by an exclusive advance, and
 * armPosition stores the later of the activation instant and the mine's cursor. The credited
 * blocks are therefore the grid points strictly after the arming instant that fall inside the
 * position's half-open window - the block landing exactly on active_until is never credited
 * (spec 77) - up to the cursor the settlement ran to.
 *
 * O(1) on purpose: this is what lets the achievement counter stay exact without walking blocks
 * per player, which is the O(users x blocks) shape spec 78 forbids.
 */
export function creditedBlockCount(input: {
  activatedAt: number;
  activeUntil: number | null;
  cursor: number;
  blockInterval: number;
}): number {
  const { activatedAt, activeUntil, cursor, blockInterval } = input;
  if (activeUntil === null || blockInterval <= 0 || cursor <= 0 || activeUntil <= activatedAt) return 0;
  const steps = Math.floor((cursor - activatedAt) / blockInterval);
  if (steps <= 0) return 0;
  const lastEligibleStep = Math.ceil((activeUntil - activatedAt) / blockInterval) - 1;
  return Math.max(0, Math.min(steps, lastEligibleStep));
}

/** How the numbers in a response should be read (spec 78). */
export function accountingOf(authority: MineAuthority): MiningAccounting {
  return authority === "ONCHAIN_INDEXED"
    ? {
        source: authority,
        authoritative: false,
        label:
          "Indexed estimate of the on-chain mining reserve. The Solana program is authoritative for token balances.",
      }
    : {
        source: authority,
        authoritative: true,
        label: "Off-chain accounting for this mine; settled claims are paid out by the keeper.",
      };
}

export function claimIdFor(wallet: string, mint: string, settlementSeq: number): string {
  return `claim:${wallet}:${mint}:${settlementSeq}`;
}

export interface MineInfoInput {
  state: MineState;
  symbol: string;
  tokenStatus: TokenStatus;
  playerPower: number | null;
  config?: DiggoConfig;
}

/** Mine information payload (spec 33): never an ROI/APY promise, always labelled as an estimate. */
export function mineInfoPayload(input: MineInfoInput): MineInfo {
  const { state } = input;
  const totalPower = Number(state.totalEligiblePower);
  const blockReward = Number(state.rewardPerBlock);
  const playerPower = input.playerPower;
  const estimatedShare =
    playerPower === null ? null : totalPower > 0 ? Math.min(1, playerPower / totalPower) : playerPower > 0 ? 1 : 0;
  const estimatedRewardPerBlock =
    playerPower === null || estimatedShare === null ? null : Math.min(blockReward, blockReward * estimatedShare);
  const initialReserve = Number(state.initialReserve);
  const remainingReserve = Number(state.remainingReserve);
  // While the mine is on its curve, remainingReserve and initialReserve above are the curve's
  // own cap, not the Mining Reserve: that is the budget a block is actually paid out of, and
  // reporting the reserve would describe a number nothing is drawing down yet. emissionSource
  // says which of the two the caller is looking at.
  const onCurve = state.emissionSource === "CURVE";
  return {
    mint: state.mint,
    symbol: input.symbol,
    status: state.status === "FULLY_MINED" ? "FULLY_MINED" : input.tokenStatus,
    blockReward,
    totalMiningPower: totalPower,
    remainingReserve,
    reserveTotal: initialReserve,
    estimatedShare,
    estimatedRewardPerBlock,
    estimateLabel: onCurve ? CURVE_PHASE_ESTIMATE_LABEL : ESTIMATE_LABEL,
    curveMining: {
      open: isCurveMiningOpen(state.curve),
      // A market on its curve that never had a budget at all: a legacy market, whose cap a
      // migration can only default to zero, or a launch that asked for no curve share. Mining
      // is not paused for it, it starts at graduation, and the card has to say that rather than
      // show a budget that was never granted as 0% spent.
      disabled: isCurveMiningDisabled(state.curve),
      onCurve: !state.curve.graduated,
      cap: Number(state.curve.cap),
      mined: Number(state.curve.mined),
      remaining: Number(curveMiningRoom(state.curve)),
      progress: curveMiningProgress(state.curve),
      blockReward: Number(state.curve.blockReward),
      unpaid: Number(state.curve.unpaid),
    },
    emissionSource: state.emissionSource,
    curveMiningDaysRemaining: curveMiningDaysRemaining(state.curve, state.blockInterval),
    // The schedule the mine is actually on, not a fixed decay curve: under the reserve-runway
    // schedule the next epochs follow from the reserve that is left (spec 21, 33).
    //
    // The curve phase has no such schedule to preview: its rate is the launch-time cap spread
    // over a runway fixed at launch, it does not step down, and what ends it is the cap running
    // out, not an epoch boundary. So the honest preview is the flat rate it actually pays.
    reductionSchedule: onCurve
      ? Array.from({ length: REDUCTION_SCHEDULE_EPOCHS }, () => blockReward)
      : emissionSchedulePreview(
          {
            reserveRemaining: state.remainingReserve,
            previousRewardPerBlock: state.rewardPerBlock,
            epoch: state.epoch,
            epochLengthSeconds: state.epochLength,
            blockIntervalSeconds: state.blockInterval,
            targetLifetimeDays: state.targetLifetimeDays,
          },
          REDUCTION_SCHEDULE_EPOCHS,
          input.config ?? DIGGO_CONFIG,
        ).map((reward) => Number(reward)),
    fullyMinedProgress: initialReserve > 0 ? Math.min(1, Math.max(0, 1 - remainingReserve / initialReserve)) : 1,
    nextBlockAt: state.lastBlock + state.blockInterval,
    epoch: state.epoch,
    epochEndsAt: state.epochEndsAt,
    playerPower,
    accounting: accountingOf(state.authority),
  };
}

export async function loadMineToken(env: RuntimeEnv, mint: string): Promise<MineTokenRow | null> {
  return env.DB.prepare(
    "SELECT mint, symbol, status, reserve_remaining, reserve_total, reward_per_block, next_block_at, next_epoch_at, synced_at, venue, curve_mining_open, curve_mining_cap, curve_mining_mined, curve_mining_unpaid, curve_mining_block_reward FROM tokens WHERE mint = ?1",
  )
    .bind(mint)
    .first<MineTokenRow>();
}
/** The curve ledger of one mine, as the last chain sync left it in the tokens cache. */
export function curveStateFromToken(token: MineTokenRow): CurveMiningState {
  const whole = (value: number | null | undefined): bigint => {
    const parsed = Math.round(Number(value ?? 0));
    return Number.isFinite(parsed) && parsed > 0 ? BigInt(parsed) : 0n;
  };
  return {
    graduated: token.venue === "pool",
    cap: whole(token.curve_mining_cap),
    mined: whole(token.curve_mining_mined),
    unpaid: whole(token.curve_mining_unpaid),
    blockReward: whole(token.curve_mining_block_reward),
  };
}

/** A mine's accounting state as the tokens cache alone describes it, before reconciliation. */
export function createMineStateFromToken(token: MineTokenRow, mint: string, now: number): MineState {
  return {
    mint,
    rewardIndex: 0n,
    lastBlock: now,
    remainingReserve: BigInt(Math.max(0, Math.round(token.reserve_remaining ?? 0))),
    initialReserve: BigInt(Math.max(0, Math.round(token.reserve_total ?? 0))),
    epoch: 0,
    status: "MINING_ACTIVE",
    totalEligiblePower: 0n,
    rewardPerBlock: BigInt(Math.max(0, Math.round(token.reward_per_block ?? 0))),
    committed: 0n,
    dustScaled: 0n,
    released: 0n,
    forfeited: 0n,
    blockInterval: NOMINAL_BLOCK_INTERVAL_SECONDS,
    epochLength: NOMINAL_EPOCH_LENGTH_SECONDS,
    epochEndsAt: token.next_epoch_at > now ? token.next_epoch_at : now + NOMINAL_EPOCH_LENGTH_SECONDS,
    authority: "OFFCHAIN",
    emissionSource: "RESERVE",
    curve: { graduated: true, cap: 0n, mined: 0n, unpaid: 0n, blockReward: 0n },
  };
}

/**
 * Brings a loaded mine's emission source, budget and curve ledger in line with the chain.
 *
 * Which side pays is a fact about the market, and it flips exactly once - at graduation - so it
 * is re-derived rather than trusted to a stored value forever. When it flips, the budget the
 * mine pays out of is re-based: the curve phase spends the launch-time cap at a flat rate over
 * its own runway, the reserve phase spends the Mining Reserve as chain reports it. The reward
 * index and every position's last_reward_index are untouched, so no block is credited twice and
 * none is skipped, and the function is idempotent: the same chain state always lands on the same
 * off-chain one. Its progress is the budget the mine is really spending, which is why the card
 * for a mine on its curve shows the cap rather than a reserve nothing is drawing down yet.
 */
export function reconcileEmissionSource(state: MineState, token: MineTokenRow): MineState {
  const curve = curveStateFromToken(token);
  const budget = activeMineBudget({
    curve,
    reserveRemaining: BigInt(Math.max(0, Math.round(token.reserve_remaining ?? 0))),
    reserveTotal: BigInt(Math.max(0, Math.round(token.reserve_total ?? 0))),
    reserveBlockReward: BigInt(Math.max(0, Math.round(token.reward_per_block ?? 0))),
  });
  // A spent curve budget is idle, not finished: the mine's Mining Reserve has not been touched
  // and graduation is what starts paying out of it. Only a reserve-phase mine that has run its
  // own reserve out is FULLY_MINED - which is also the only thing the program itself says, since
  // it now reaches that state exactly when a graduated market's reserve is empty.
  const reserveExhausted = budget.source === "RESERVE" && budget.remainingReserve <= 0n;
  const status: MineStatus =
    state.status === "PAUSED"
      ? "PAUSED"
      : token.status === "FULLY_MINED" || reserveExhausted
        ? "FULLY_MINED"
        : "MINING_ACTIVE";
  const unchanged =
    status === state.status &&
    curve.cap === state.curve.cap &&
    curve.mined === state.curve.mined &&
    curve.unpaid === state.curve.unpaid;
  // The budget is only re-based when the mine actually switches sides. While the source is
  // unchanged, remainingReserve / initialReserve / rewardPerBlock are the index's own running
  // totals — what it has spent and what it has left — and re-reading them from chain on every
  // load would hand the index back budget it has already distributed.
  if (budget.source === state.emissionSource) {
    // The curve phase's budget is the one chain can take away, so it is clamped rather than
    // re-based: the room under the cap is where the tokens physically come from, and the walk
    // that spends it runs there too (advance_mine). Clamping only downwards keeps both
    // properties - the index can never credit a block the market vault cannot pay for, which is
    // what would otherwise let a claim draw the difference out of the Mining Reserve before
    // graduation, and a chain read can never hand the index back budget it has already
    // distributed.
    if (budget.source === "CURVE" && budget.remainingReserve < state.remainingReserve) {
      return { ...state, curve, status, remainingReserve: budget.remainingReserve };
    }
    return unchanged ? state : { ...state, curve, status };
  }
  return {
    ...state,
    curve,
    emissionSource: budget.source,
    initialReserve: budget.initialReserve,
    remainingReserve: budget.remainingReserve,
    rewardPerBlock: budget.rewardPerBlock,
    status,
  };
}

/**
 * Persists a reconciled source and budget. Guarded on the cursor the reconciliation was made
 * against, so a concurrent advance that moved the ledger forward is never clobbered; the next
 * load re-derives the same answer anyway, which is what makes that guard safe rather than a
 * source of drift.
 */
export async function persistEmissionSource(
  env: RuntimeEnv,
  state: MineState,
  now: number,
): Promise<void> {
  await env.DB.prepare(
    "UPDATE mine_reward_state SET emission_source = ?1, initial_reserve = ?2," +
      " remaining_reserve = ?3, reward_per_block = ?4, status = ?5, updated_at = ?6" +
      " WHERE mint = ?7 AND last_block <= ?8",
  )
    .bind(
      state.emissionSource,
      state.initialReserve.toString(),
      state.remainingReserve.toString(),
      state.rewardPerBlock.toString(),
      state.status,
      now,
      state.mint,
      state.lastBlock,
    )
    .run();
}

/**
 * Loads (and on first touch creates) a mine's accounting state.
 *
 * The block cursor is anchored at first touch rather than back-dated: the off-chain index starts
 * accounting when it starts existing, so no reward is invented for a period nobody tracked.
 */
export interface LoadedMineState {
  state: MineState;
  /**
   * False when the stored row's own schedule cannot walk forward (a block interval or epoch length
   * of zero or less). rowToMineState substitutes the nominal values so the rest of the game keeps
   * working, so this is the only place that still knows the row was unusable.
   */
  scheduleUsable: boolean;
}

export async function loadMineState(
  env: RuntimeEnv,
  mint: string,
  now: number,
): Promise<LoadedMineState | null> {
  const [existing, token] = await Promise.all([
    env.DB.prepare("SELECT * FROM mine_reward_state WHERE mint = ?1").bind(mint).first<MineStateRow>(),
    loadMineToken(env, mint),
  ]);
  if (!existing && !token) return null;
  if (existing) {
    const state = rowToMineState(existing);
    // The budget a mine pays out of is a fact about the chain, not a running total, so it is
    // re-derived on every load: a mine that graduated between two calls switches sides here.
    const reconciled = token ? reconcileEmissionSource(state, token) : state;
    if (reconciled !== state) await persistEmissionSource(env, reconciled, now);
    return {
      state: reconciled,
      scheduleUsable: existing.block_interval > 0 && existing.epoch_length > 0,
    };
  }

  // No stored row and no token row is the only "unknown mine"; past this point there is a token
  // row to speak for the chain.
  if (!token) return null;
  const base = createMineStateFromToken(token, mint, now);
  const state = reconcileEmissionSource(base, token);
  const status = state.status;
  const initialReserve = state.initialReserve;
  const remainingReserve = state.remainingReserve;
  const rewardPerBlock = state.rewardPerBlock;
  // A mine synced from chain already has a program-side accounting authority.
  const authority: MineAuthority = env.DIGGO_PROGRAM_ID && token.synced_at > 0 ? "ONCHAIN_INDEXED" : "OFFCHAIN";
  const epochEndsAt = token.next_epoch_at > now ? token.next_epoch_at : now + NOMINAL_EPOCH_LENGTH_SECONDS;

  await env.DB.prepare(
    `INSERT OR IGNORE INTO mine_reward_state
       (mint, reward_index, last_block, remaining_reserve, initial_reserve, epoch, status,
        total_eligible_power, reward_per_block, committed, dust_scaled, block_interval,
        epoch_length, epoch_ends_at, authority, released, forfeited, updated_at, emission_source)
     VALUES (?1, '0', ?2, ?3, ?4, 0, ?5, '0', ?6, '0', '0', ?7, ?8, ?9, ?10, ?11, '0', ?2, ?12)`,
  )
    .bind(
      mint,
      now,
      remainingReserve.toString(),
      initialReserve.toString(),
      status,
      rewardPerBlock.toString(),
      NOMINAL_BLOCK_INTERVAL_SECONDS,
      NOMINAL_EPOCH_LENGTH_SECONDS,
      epochEndsAt,
      authority,
      // Whatever the reserve split already says has left it: a mine first seen with a reserve below
      // its total has already paid that difference out.
      (initialReserve > remainingReserve ? initialReserve - remainingReserve : 0n).toString(),
      state.emissionSource,
    )
    .run();

  const created = await env.DB.prepare("SELECT * FROM mine_reward_state WHERE mint = ?1")
    .bind(mint)
    .first<MineStateRow>();
  // A row this function just created always carries the nominal schedule.
  return created ? { state: rowToMineState(created), scheduleUsable: true } : null;
}

/**
 * Persists the advanced index. The monotonic guard means a slower concurrent advance can never
 * roll the cursor or the reserve backwards.
 */
async function persistMineState(env: RuntimeEnv, state: MineState, now: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE mine_reward_state SET
       reward_index = ?1, last_block = ?2, remaining_reserve = ?3, initial_reserve = ?4, epoch = ?5,
       status = ?6, reward_per_block = ?7, committed = ?8, dust_scaled = ?9, epoch_ends_at = ?10,
       released = ?13, forfeited = ?14, updated_at = ?11
     WHERE mint = ?12 AND last_block <= ?2`,
  )
    .bind(
      state.rewardIndex.toString(),
      state.lastBlock,
      state.remainingReserve.toString(),
      state.initialReserve.toString(),
      state.epoch,
      state.status,
      state.rewardPerBlock.toString(),
      state.committed.toString(),
      state.dustScaled.toString(),
      state.epochEndsAt,
      now,
      state.mint,
      state.released.toString(),
      state.forfeited.toString(),
    )
    .run();
}

/** Total eligible power is maintained by deltas only, so concurrent writers cannot clobber it. */
async function adjustMinePower(env: RuntimeEnv, mint: string, delta: number, now: number): Promise<void> {
  if (delta === 0) return;
  await env.DB.prepare(
    "UPDATE mine_reward_state SET total_eligible_power = MAX(0, CAST(total_eligible_power AS INTEGER) + ?1), updated_at = ?2 WHERE mint = ?3",
  )
    .bind(delta, now, mint)
    .run();
}

/**
 * Books the ledger moves one position's settlement produced onto the mine's row: the sub-token
 * remainder it could not be credited with, which is dust, and - for a forfeit - the share handed
 * back to the reserve. Both are deltas against the state the settlement started from, so a
 * settlement that moved neither writes nothing.
 *
 * advanceMineTo() persists its own ledger through persistMineState(); this is the same move for the
 * settlements that run outside it. Dropping them is what leaves a mine's books short of the tokens
 * its positions actually hold (spec 17, 19).
 */
async function bookSettlementLedger(
  env: RuntimeEnv,
  mint: string,
  before: RewardIndexState,
  after: RewardIndexState,
  now: number,
): Promise<void> {
  const dust = after.dustScaled - before.dustScaled;
  const reserve = after.reserveRemaining - before.reserveRemaining;
  const forfeited = after.forfeited - before.forfeited;
  if (dust === 0n && reserve === 0n && forfeited === 0n) return;
  await env.DB.prepare(
    `UPDATE mine_reward_state
        SET dust_scaled = CAST(dust_scaled AS INTEGER) + CAST(?1 AS INTEGER),
            remaining_reserve = CAST(remaining_reserve AS INTEGER) + CAST(?2 AS INTEGER),
            forfeited = CAST(forfeited AS INTEGER) + CAST(?3 AS INTEGER),
            updated_at = ?4
      WHERE mint = ?5`,
  )
    .bind(dust.toString(), reserve.toString(), forfeited.toString(), now, mint)
    .run();
}

/**
 * Bumps the achievement counters that mining is the authority for (spec 68).
 *
 * The row is created on demand and only for a wallet that already has a players row, so a
 * settlement can never introduce a social-metrics row for an unknown account, and an existing
 * count is only ever added to. Absent rows read as zero everywhere else (worker/cosmetics.ts), so
 * nothing here has to be backfilled.
 */
async function bumpSocialMetrics(
  env: RuntimeEnv,
  wallet: string,
  delta: { blocksWon?: number; mineSwitches?: number },
  now: number,
): Promise<void> {
  const blocks = Math.max(0, Math.floor(delta.blocksWon ?? 0));
  const switches = Math.max(0, Math.floor(delta.mineSwitches ?? 0));
  if (blocks === 0 && switches === 0) return;
  await env.DB.prepare(
    `INSERT INTO player_social_metrics (wallet, blocks_won, mine_switches, updated_at)
       SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM players WHERE wallet = ?1)
     ON CONFLICT(wallet) DO UPDATE SET
       blocks_won = blocks_won + excluded.blocks_won,
       mine_switches = mine_switches + excluded.mine_switches,
       updated_at = excluded.updated_at`,
  )
    .bind(wallet, blocks, switches, now)
    .run();
}

export interface MineAdvance {
  state: MineState;
  blocksAdvanced: number;
  expiries: ExpiryCredit[];
}

/**
 * Lazily advances one mine by the blocks that are due, bounded per call (spec 78).
 * The index is persisted before the position credits it implies, so an interrupted call can
 * credit on retry but can never double-credit.
 */
export async function advanceMineTo(
  env: RuntimeEnv,
  mint: string,
  upTo: number,
  options: { exclusive?: boolean; maxBlocks?: number } = {},
): Promise<MineAdvance | null> {
  const loaded = await loadMineState(env, mint, upTo);
  if (!loaded) return null;
  const { state } = loaded;
  const wasFullyMined = state.status === "FULLY_MINED";
  if (state.status === "FULLY_MINED" || state.lastBlock <= 0) {
    return { state, blocksAdvanced: 0, expiries: [] };
  }
  if (!loaded.scheduleUsable) {
    // Fail closed, loudly: a mine whose stored schedule cannot move forward is never walked with a
    // substituted interval, because that would credit blocks the row never described. The counter
    // is what makes a corrupt row visible instead of silently paying a different schedule.
    await metric(env, "mining.advance_schedule_invalid", 1, { mint });
    console.error(
      JSON.stringify({
        event: "mining.advance_schedule_invalid",
        mint,
        blockInterval: state.blockInterval,
        epochLength: state.epochLength,
      }),
    );
    return { state, blocksAdvanced: 0, expiries: [] };
  }

  const candidates = await env.DB.prepare(
    `SELECT wallet, mint, assigned_power, last_reward_index, pending_reward, paused, activated_at, active_until, claim_seq
       FROM mining_positions
      WHERE mint = ?1 AND assigned_power != '0' AND active_until IS NOT NULL AND active_until <= ?2
      LIMIT ?3`,
  )
    .bind(mint, upTo + state.blockInterval, MAX_EXPIRY_ROWS)
    .all<PositionRow>();

  const outcome = simulateAdvance({
    state,
    positions: candidates.results.map(rowToPositionSnapshot),
    upTo,
    exclusive: options.exclusive,
    maxBlocks: options.maxBlocks,
  });

  await persistMineState(env, outcome.state, upTo);

  for (const expiry of outcome.expiries) {
    const cas = await env.DB.prepare(
      `UPDATE mining_positions
          SET assigned_power = '0', pending_reward = ?1, last_reward_index = ?2, paused = 1, updated_at = ?3
        WHERE wallet = ?4 AND mint = ?5 AND assigned_power = ?6`,
    )
      .bind(
        expiry.pendingReward.toString(),
        expiry.indexAtExpiry.toString(),
        upTo,
        expiry.wallet,
        mint,
        expiry.assignedPower.toString(),
      )
      .run();
    if (cas.meta.changes === 1) {
      await adjustMinePower(env, mint, -Number(expiry.assignedPower), upTo);
      if (expiry.blocksWon > 0) {
        await bumpSocialMetrics(env, expiry.wallet, { blocksWon: expiry.blocksWon }, upTo);
      }
    }
  }

  if (outcome.state.status === "FULLY_MINED" && !wasFullyMined) {
    // Mining ends, trading continues (spec 20). The chain stays authoritative where it owns the mine.
    if (outcome.state.authority === "OFFCHAIN") {
      await env.DB.prepare("UPDATE tokens SET status = 'FULLY_MINED' WHERE mint = ?1").bind(mint).run();
    }
    await metric(env, "mining.fully_mined", 1, { mint, authority: outcome.state.authority });
  }

  return { state: outcome.state, blocksAdvanced: outcome.blocksAdvanced, expiries: outcome.expiries };
}

export async function loadPositionRow(
  env: RuntimeEnv,
  wallet: string,
  mint: string,
): Promise<PositionRow | null> {
  return env.DB.prepare("SELECT * FROM mining_positions WHERE wallet = ?1 AND mint = ?2")
    .bind(wallet, mint)
    .first<PositionRow>();
}

/**
 * The effective Mining Power one position is armed with (spec 40, 53, 58, 61, 64).
 *
 * Time is the anti-sybil resource (spec 58), so a wallet that was created a minute ago brings its
 * configured maturity share to a block; a wallet sharing a device or a network environment with a
 * whole farm brings the cluster's share of that; and no single account may own more than the
 * configured fraction of one block. None of it is a paywall (spec 41) and none of it stops the
 * account from mining: the crew keeps accruing ORE, keeps its streak and keeps its claim, it just
 * carries less weight while it is young or inside a farm-sized cluster (spec 53).
 *
 * Both cluster counts come from account_signals, the same counters the risk score uses. A missing
 * device or network key reports no cluster at all, so an absent header can never damp a player.
 */
export async function effectiveArmPower(
  env: RuntimeEnv,
  wallet: string,
  rawPower: bigint,
  now: number,
  options: { mineTotalPower?: bigint; config?: DiggoConfig } = {},
): Promise<bigint> {
  if (rawPower <= 0n) return 0n;
  const config = options.config ?? DIGGO_CONFIG;
  const [player, cluster] = await Promise.all([
    env.DB.prepare("SELECT created_at FROM players WHERE wallet = ?1")
      .bind(wallet)
      .first<{ created_at: number }>(),
    miningClusterCounts(env, wallet, now).catch(() => ({ walletsOnDevice: 0, walletsOnNetwork: 0 })),
  ]);
  const accountAgeSeconds = player ? Math.max(0, now - player.created_at) : 0;
  return effectiveMiningPower({
    power: rawPower,
    accountAgeSeconds,
    cluster,
    mineTotalPower: options.mineTotalPower ?? 0n,
    config,
  });
}

/**
 * Arms (or re-arms) a position at the mine's current index: no retroactive credit.
 *
 * The stored activation instant is the later of the activation the caller asked for and the
 * mine's current block cursor. Both are already true of a freshly armed position - its index
 * cursor starts at the mine's cursor, so no block at or before it can ever be credited - and
 * keeping them equal is what makes creditedBlockCount() exact for a crew that switched mines
 * mid-window (the position keeps the original window end but starts earning on this mine now).
 *
 * The position is settled first, always. `last_reward_index` is the only record of what a position
 * has already accrued, so moving it (or the power it is measured against) without a settlement in
 * front of it silently destroys that entitlement (spec 30). The settle is exclusive, so the block
 * landing exactly on `now` still belongs to the new arm (spec 77).
 */
export async function armPosition(
  env: RuntimeEnv,
  wallet: string,
  mint: string,
  power: bigint,
  activatedAt: number,
  activeUntil: number,
  now: number,
  options: { config?: DiggoConfig } = {},
): Promise<void> {
  await settlePositionAt(env, wallet, mint, now, { releasePower: true, exclusive: true });

  const index = await env.DB.prepare(
    "SELECT reward_index, last_block, total_eligible_power FROM mine_reward_state WHERE mint = ?1",
  )
    .bind(mint)
    .first<{ reward_index: string; last_block: number; total_eligible_power: string }>();
  const armedAt = Math.max(activatedAt, index?.last_block ?? 0);
  // The position stores the power it actually brings to a block, which is the crew's power after the
  // account-maturity, cluster-damping and share-cap rules (spec 40, 58, 61, 64). This is the only
  // place a block share is created, so it is the only place a cumulative index can apply them.
  const armedPower = await effectiveArmPower(env, wallet, power, now, {
    mineTotalPower: big(index?.total_eligible_power),
    config: options.config,
  });
  // One batch, so the mine's total and the row that explains it move together. The delta is
  // (new - old) with the old value read from the position row inside the same statement, so two
  // concurrent arms of one position cannot both add the same power to the mine (spec 78).
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE mine_reward_state
          SET total_eligible_power = MAX(0, CAST(total_eligible_power AS INTEGER) + ?1 -
                COALESCE((SELECT CAST(assigned_power AS INTEGER) FROM mining_positions
                           WHERE wallet = ?2 AND mint = ?3), 0)),
              updated_at = ?4
        WHERE mint = ?3`,
    ).bind(Number(armedPower), wallet, mint, now),
    env.DB.prepare(
      `INSERT INTO mining_positions
         (wallet, mint, assigned_power, raw_power, last_reward_index, pending_reward, paused, activated_at, active_until, claim_seq, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, '0', 0, ?6, ?7, 0, ?8)
       ON CONFLICT(wallet, mint) DO UPDATE SET
         assigned_power = excluded.assigned_power,
         raw_power = excluded.raw_power,
         last_reward_index = excluded.last_reward_index,
         paused = 0,
         activated_at = excluded.activated_at,
         active_until = excluded.active_until,
         updated_at = excluded.updated_at`,
    ).bind(
      wallet,
      mint,
      armedPower.toString(),
      power.toString(),
      big(index?.reward_index).toString(),
      armedAt,
      activeUntil,
      now,
    ),
  ]);
}

export interface PositionSettlement {
  wallet: string;
  mint: string;
  settled: number;
  forfeited: number;
  released: boolean;
  claimId: string | null;
  pendingReward: number;
  blocksAdvanced: number;
  authority: MineAuthority;
}

/**
 * Settles one wallet's position on one mine at the current index.
 *
 * releasePower = true is the switch/upgrade/expiry path: the position stops carrying power, so
 * the mine's eligible total drops with it. releasePower = false is the "show me my report" path:
 * the crew keeps mining and only the settled tokens move into a claim row.
 *
 * exclusive leaves the block landing exactly on `now` to the next caller, which is what lets
 * armPosition() settle a position and re-arm it on the same instant without either losing the
 * block at that instant or crediting it twice (spec 77).
 */
export async function settlePositionAt(
  env: RuntimeEnv,
  wallet: string,
  mint: string,
  now: number,
  options: { releasePower?: boolean; exclusive?: boolean } = {},
): Promise<PositionSettlement | null> {
  const releasePower = options.releasePower ?? false;
  const advance = await advanceMineTo(env, mint, now, { exclusive: options.exclusive });
  if (!advance) return null;
  const row = await loadPositionRow(env, wallet, mint);
  if (!row) return null;

  const snapshot = rowToPositionSnapshot(row);
  let settled = 0n;
  let forfeited = 0n;
  let released = false;

  if (snapshot.assignedPower > 0n) {
    const mineState = toRewardIndexState(advance.state);
    const outcome = settlePosition(mineState, toMiningPosition(mint, snapshot));
    settled = outcome.earned;
    forfeited = outcome.forfeited;
    // A forfeit (paused/zero-power position) goes back to the reserve, never to the position.
    const nextPending = snapshot.pendingReward + outcome.earned;
    const powerText = snapshot.assignedPower.toString();
    const cas = await env.DB.prepare(
      `UPDATE mining_positions
          SET pending_reward = ?1, last_reward_index = ?2, assigned_power = ?3, paused = ?4, updated_at = ?5
        WHERE wallet = ?6 AND mint = ?7 AND assigned_power = ?8`,
    )
      .bind(
        nextPending.toString(),
        outcome.position.lastRewardIndex.toString(),
        releasePower ? "0" : powerText,
        releasePower || snapshot.paused ? 1 : 0,
        now,
        wallet,
        mint,
        powerText,
      )
      .run();
    if (cas.meta.changes === 1 && releasePower) {
      released = true;
      await adjustMinePower(env, mint, -Number(snapshot.assignedPower), now);
    }
    if (cas.meta.changes === 1) {
      // The settlement's own ledger moves land only if the position it belongs to was actually
      // updated, so a lost compare-and-swap cannot book the same remainder twice.
      await bookSettlementLedger(env, mint, mineState, outcome.state, now);
    }
    if (cas.meta.changes === 1 && settled > 0n) {
      // The position was credited, so count the blocks this settlement paid for (spec 68).
      const blocksWon = creditedBlockCount({
        activatedAt: snapshot.activatedAt ?? 0,
        activeUntil: snapshot.activeUntil,
        cursor: advance.state.lastBlock,
        blockInterval: advance.state.blockInterval,
      });
      if (blocksWon > 0) await bumpSocialMetrics(env, wallet, { blocksWon }, now);
    }
  }

  const claim = await materializeRewardClaim(env, wallet, mint, now, advance.state.authority);
  const after = await loadPositionRow(env, wallet, mint);
  return {
    wallet,
    mint,
    settled: Number(settled),
    forfeited: Number(forfeited),
    released,
    claimId: claim?.id ?? null,
    pendingReward: Number(big(after?.pending_reward ?? "0")),
    blocksAdvanced: advance.blocksAdvanced,
    authority: advance.state.authority,
  };
}

/**
 * Moves a position's settled pending reward into a claim row.
 *
 * The pending counter is zeroed with a compare-and-swap on its exact value first: exactly one
 * concurrent caller can win, so a token can never be represented by two claims.
 */
export async function materializeRewardClaim(
  env: RuntimeEnv,
  wallet: string,
  mint: string,
  now: number,
  authority: MineAuthority,
): Promise<{ id: string; amount: bigint; created: boolean } | null> {
  const row = await loadPositionRow(env, wallet, mint);
  if (!row) return null;
  const pending = big(row.pending_reward);
  if (pending <= 0n) return null;

  const settlementSeq = row.claim_seq + 1;
  const cas = await env.DB.prepare(
    `UPDATE mining_positions SET pending_reward = '0', claim_seq = ?1, updated_at = ?2
      WHERE wallet = ?3 AND mint = ?4 AND pending_reward = ?5`,
  )
    .bind(settlementSeq, now, wallet, mint, pending.toString())
    .run();
  if (cas.meta.changes !== 1) return null;

  const id = claimIdFor(wallet, mint, settlementSeq);
  const insert = await env.DB.prepare(
    `INSERT OR IGNORE INTO reward_claims
       (id, wallet, mint, amount, status, created_at, eligible_until, settlement_seq, authority)
     VALUES (?1, ?2, ?3, ?4, 'ELIGIBLE', ?5, ?6, ?7, ?8)`,
  )
    .bind(id, wallet, mint, pending.toString(), now, now + REWARD_CLAIM_WINDOW_SECONDS, settlementSeq, authority)
    .run();
  if (insert.meta.changes !== 1) {
    await metric(env, "mining.claim_materialize_conflict", 1, { mint });
    return { id, amount: pending, created: false };
  }
  await metric(env, "mining.claim_materialized", Number(pending), { mint, authority });
  return { id, amount: pending, created: true };
}

/** Settles and releases every armed position of this wallet, across mines (switch/activation). */
export async function releaseArmedPositions(
  env: RuntimeEnv,
  wallet: string,
  now: number,
): Promise<PositionSettlement[]> {
  const armed = await env.DB.prepare(
    "SELECT mint FROM mining_positions WHERE wallet = ?1 AND assigned_power != '0'",
  )
    .bind(wallet)
    .all<{ mint: string }>();
  const settlements: PositionSettlement[] = [];
  for (const { mint } of armed.results) {
    const settlement = await settlePositionAt(env, wallet, mint, now, { releasePower: true });
    if (settlement) settlements.push(settlement);
  }
  return settlements;
}

/**
 * Makes the stored position agree with the player's activation window. Used on the read path so
 * an interrupted activation (state written, position not armed) heals on the next request
 * without ever crediting blocks retroactively.
 *
 * The guard compares like with like: what a position stores is the *effective* power it brings to
 * a block (maturity ramp, cluster damping and the share cap already applied), so the only reading
 * it can be compared against is the raw crew power it was armed from, which the row keeps in
 * raw_power. Comparing the stored effective power with a raw crewPower() reading made this fire on
 * every collect for a damped account (a young, clustered or share-capped one) - and because
 * re-arming resets the position's index cursor, that destroyed the accrual it had not settled yet.
 */
export async function reconcileArmedPosition(env: RuntimeEnv, row: PlayerRow, now: number): Promise<boolean> {
  if (activationStateOf(row, now) !== "ACTIVE" || !row.active_mint) return false;
  const power = BigInt(crewPower(crewLevelsOf(row)));
  const position = await loadPositionRow(env, row.wallet, row.active_mint);
  const armed = big(position?.assigned_power ?? "0");
  if (
    position &&
    armed > 0n &&
    big(position.raw_power) === power &&
    position.active_until === row.activation_expires_at
  ) {
    return false;
  }

  const token = await loadMineToken(env, row.active_mint);
  if (!token || token.status === "FULLY_MINED") return false;

  // armPosition settles the position it is about to move and releases its power through its own
  // compare-and-swap, so the mine's total moves exactly once per position (spec 78).
  await armPosition(
    env,
    row.wallet,
    row.active_mint,
    power,
    row.activated_at ?? row.last_activation_at ?? now,
    row.activation_expires_at ?? now,
    now,
  );
  await metric(env, "mining.position_reconciled", 1, { mint: row.active_mint });
  return true;
}

export async function armedPowerOf(env: RuntimeEnv, wallet: string, mint: string): Promise<number> {
  const row = await loadPositionRow(env, wallet, mint);
  return row ? Number(big(row.assigned_power)) : 0;
}

/** Per-token block rewards for the report: settled claim rows plus anything still unsettled. */
async function blockRewardsFor(env: RuntimeEnv, wallet: string, since: number): Promise<MiningReportBlockReward[]> {
  const [claims, pending] = await Promise.all([
    env.DB.prepare(
      `SELECT c.id, c.mint, c.amount, c.status, c.authority, c.tx_signature, COALESCE(t.symbol, '') AS symbol
         FROM reward_claims c LEFT JOIN tokens t ON t.mint = c.mint
        WHERE c.wallet = ?1 AND c.created_at >= ?2
        ORDER BY c.created_at DESC LIMIT 20`,
    )
      .bind(wallet, since)
      .all<{
        id: string;
        mint: string;
        amount: string;
        status: RewardClaimStatus;
        authority: MineAuthority;
        tx_signature: string | null;
        symbol: string;
      }>(),
    env.DB.prepare(
      `SELECT p.mint, p.pending_reward, COALESCE(t.symbol, '') AS symbol
         FROM mining_positions p LEFT JOIN tokens t ON t.mint = p.mint
        WHERE p.wallet = ?1 AND p.pending_reward != '0' LIMIT 20`,
    )
      .bind(wallet)
      .all<{ mint: string; pending_reward: string; symbol: string }>(),
  ]);

  const rewards: MiningReportBlockReward[] = claims.results.map((row) => ({
    mint: row.mint,
    symbol: row.symbol,
    amount: Number(big(row.amount)),
    claimId: row.id,
    status: row.status,
    authority: row.authority,
    payout: claimPayoutView(row),
  }));
  for (const row of pending.results) {
    rewards.push({
      mint: row.mint,
      symbol: row.symbol,
      amount: Number(big(row.pending_reward)),
      claimId: null,
      status: "UNSETTLED",
      authority: "OFFCHAIN",
    });
  }
  return rewards;
}

async function discoverySummary(env: RuntimeEnv, wallet: string, since: number): Promise<MiningReportDiscoveries> {
  const rows = await env.DB.prepare(
    "SELECT rarity, COUNT(*) AS total FROM discoveries WHERE wallet = ?1 AND created_at >= ?2 GROUP BY rarity",
  )
    .bind(wallet, since)
    .all<{ rarity: string; total: number }>();
  const byRarity: Record<string, number> = {};
  let total = 0;
  for (const row of rows.results) {
    byRarity[row.rarity] = row.total;
    total += row.total;
  }
  return { total, byRarity };
}

function milestoneView(milestones: readonly { day: number; ore: number; xp: number; badges: readonly string[]; titles: readonly string[]; freezes: number }[]): MiningReportMilestone[] {
  return milestones.map((milestone) => ({
    day: milestone.day,
    ore: milestone.ore,
    xp: milestone.xp,
    badges: [...milestone.badges],
    titles: [...milestone.titles],
    freezes: milestone.freezes,
  }));
}

function verificationResponse(): Response {
  return json(
    { code: VERIFICATION_REQUIRED, message: DIGGO_CONFIG.risk.publicStatus.UNDER_REVIEW },
    { status: 403 },
  );
}

type GateOutcome = Awaited<ReturnType<typeof gateAction>>;

/** Neutral, detail-free refusal for a wallet the risk layer will not let act (spec 62). */
function gateResponse(gate: GateOutcome): Response | null {
  if (gate.challengeRequired) return verificationResponse();
  if (gate.allowed) return null;
  const message = gate.publicMessage ?? DIGGO_CONFIG.risk.publicStatus[gate.rewardState];
  if (gate.retryAfterSec === undefined) {
    return json({ code: gate.rewardState, message }, { status: 403 });
  }
  return json({ code: "RATE_LIMITED", message }, { status: 429, headers: { "retry-after": String(gate.retryAfterSec) } });
}

function gateOutcomeName(gate: GateOutcome): "rejected" | "rate_limited" | "failed_challenge" {
  if (gate.challengeRequired) return "failed_challenge";
  return gate.retryAfterSec === undefined ? "rejected" : "rate_limited";
}

export async function activateChallenge(request: Request, env: RuntimeEnv): Promise<Response> {
  if (!(await checkRateLimit(request, env, "mine-activate"))) return apiError("Too many requests", 429);
  const { wallet } = await readJson<{ wallet?: string }>(request);
  if (!isBase58Address(wallet)) return apiError("Invalid Solana wallet");
  if (!(await checkWalletRateLimit(env, wallet, "mine-activate", 6, 300))) {
    await recordActivity(env, { wallet, request, action: "activate", outcome: "rate_limited" });
    return apiError("Too many activation attempts, slow down", 429);
  }
  // A wallet that needs a challenge is exactly the wallet that must be able to get one.
  const gate = await gateAction(env, { wallet, request, action: "activate" });
  if (!gate.allowed && gate.rewardState === "BLOCKED") {
    await recordActivity(env, { wallet, request, action: "activate", outcome: gateOutcomeName(gate) });
    return json(
      { code: gate.rewardState, message: gate.publicMessage ?? DIGGO_CONFIG.risk.publicStatus.BLOCKED },
      { status: 403 },
    );
  }
  const nonce = crypto.randomUUID();
  const message = [
    "Activate Diggo Mining Crew",
    `Wallet: ${wallet}`,
    `Nonce: ${nonce}`,
    "This request does not trigger a blockchain transaction.",
  ].join("\n");
  await storeChallenge(env, `activate:challenge:${nonce}`, { wallet, message });
  return json({ nonce, message });
}

export async function activateMine(request: Request, env: RuntimeEnv): Promise<Response> {
  if (!(await checkRateLimit(request, env, "mine-activate"))) return apiError("Too many requests", 429);
  const body = await readJson<{ wallet?: string; nonce?: string; signature?: string; mint?: string }>(request);
  if (!isBase58Address(body.wallet) || !body.nonce || !body.signature) {
    return apiError("Incomplete activation proof");
  }
  const wallet = body.wallet;
  const now = Math.floor(Date.now() / 1_000);

  const gate = await gateAction(env, { wallet, request, action: "activate" });
  const denied = gateResponse(gate);
  if (denied) {
    await recordActivity(env, { wallet, request, action: "activate", outcome: gateOutcomeName(gate) });
    return denied;
  }

  const challengeKey = `activate:challenge:${body.nonce}`;
  const challenge = await loadChallenge(env, challengeKey);
  if (!challenge || challenge.wallet !== wallet) {
    await recordActivity(env, { wallet, request, action: "activate", outcome: "failed_challenge" });
    return apiError("Challenge expired", 401);
  }
  if (!verifyWalletSignature(wallet, challenge.message, body.signature)) {
    await recordActivity(env, { wallet, request, action: "activate", outcome: "failed_challenge" });
    return apiError("Invalid wallet signature", 401);
  }
  // Single-use: a replayed signature finds no challenge (spec 47).
  await env.TOKEN_CACHE.delete(challengeKey);

  const row = await getOrCreatePlayer(env, wallet, request);
  const eligibility = activationEligibility(activationRecordOf(row), now);
  if (!eligibility.eligible) {
    await recordActivity(env, { wallet, request, action: "activate", outcome: "rejected" });
    return json(
      {
        error: `Mine still active. You can reactivate in ${eligibility.nextEligibleAt - now}s.`,
        nextEligibleAt: eligibility.nextEligibleAt,
      },
      { status: 409 },
    );
  }

  const targetMint = body.mint ?? row.active_mint;
  let token: MineTokenRow | null = null;
  if (targetMint) {
    token = await loadMineToken(env, targetMint);
    if (!token) {
      await recordActivity(env, { wallet, request, action: "activate", outcome: "rejected" });
      return apiError("Unknown mine", 404);
    }
    if (token.status === "FULLY_MINED") {
      await recordActivity(env, { wallet, request, action: "activate", outcome: "rejected" });
      return apiError("This mine is fully mined", 409);
    }
  }

  const levels = crewLevelsOf(row);
  const power = BigInt(crewPower(levels));
  const accountAgeSeconds = Math.max(0, now - row.created_at);

  // ORE for the window that just ended. A paused crew accrues nothing after active_until.
  const collectFrom = row.ore_collected_at ?? row.last_activation_at ?? now;
  const activeSeconds = activeSecondsForWindow(now, row.activation_expires_at, collectFrom);
  const oreMining = oreForActiveSeconds(activeSeconds, accountAgeSeconds, levels);
  const oreActivation = oreFromActivation(accountAgeSeconds);
  const streakOutcome = applyActivation(activationRecordOf(row), now);
  const oreMilestones = streakOutcome.rewards.ore;
  const stored = storeOre(row.ore_balance, oreMining + oreActivation + oreMilestones, oreCapacity(levels));
  const badges = mergeStringLists(parseStringList(row.badges), streakOutcome.rewards.badges);
  const titles = mergeStringLists(parseStringList(row.titles), streakOutcome.rewards.titles);

  // Settle the old position before power moves, without touching activation or streak (spec 30).
  const settlements = await releaseArmedPositions(env, wallet, now);

  // Compare-and-swap on the activation cursor: concurrent activations credit ORE exactly once.
  const cas = await env.DB.prepare(
    `UPDATE players SET
       ore_balance = ?1, ore_overflow = ?2, streak = ?3, streak_freezes = ?4, longest_streak = ?5,
       xp = xp + ?6, badges = ?7, titles = ?8, active_days = active_days + 1, active_mint = ?9,
       activated_at = ?10, last_activation_at = ?10, activation_expires_at = ?11,
       streak_grace_until = ?12, ore_collected_at = ?10
     WHERE wallet = ?13 AND last_activation_at IS ?14 AND ore_collected_at IS ?15`,
  )
    .bind(
      stored.balance,
      row.ore_overflow + stored.overflow,
      streakOutcome.streak,
      streakOutcome.freezes,
      streakOutcome.longestStreak,
      streakOutcome.rewards.xp,
      JSON.stringify(badges),
      JSON.stringify(titles),
      targetMint,
      now,
      streakOutcome.window.activeUntil,
      streakOutcome.window.graceUntil,
      wallet,
      row.last_activation_at,
      row.ore_collected_at,
    )
    .run();
  if (cas.meta.changes !== 1) {
    await recordActivity(env, { wallet, request, action: "activate", outcome: "rejected" });
    return apiError("Activation state changed, please retry", 409);
  }

  // Arm the new window. exclusive: the block landing exactly on this activation is the new
  // position's (activation is inclusive at its start, spec 77).
  let mine: MineState | null = null;
  if (targetMint) {
    const advance = await advanceMineTo(env, targetMint, now, { exclusive: true });
    mine = advance?.state ?? null;
    if (mine && mine.status !== "FULLY_MINED") {
      await armPosition(env, wallet, targetMint, power, now, streakOutcome.window.activeUntil, now);
    }
  }

  let discovery: DiscoveryRecord | null = null;
  const hadPriorActiveWindow =
    row.last_activation_at !== null && activeSeconds >= DIGGO_CONFIG.streak.activationSeconds * 0.5;
  if (
    hadPriorActiveWindow &&
    gate.rewardState === "NORMAL" &&
    discoveryEligible(accountAgeSeconds, row.active_days + 1, crewTier(levels).tier) &&
    !(await isBreakerOpen(env, "discoveries"))
  ) {
    discovery = await rollDiscovery(env, wallet, targetMint, 0.12);
  }

  const report: MiningReport = {
    activeSeconds,
    oreGained: stored.stored,
    oreOverflow: stored.overflow,
    streak: streakOutcome.streak,
    streakFreezes: streakOutcome.freezes,
    usedFreeze: streakOutcome.usedFreeze,
    discovery,
    mineMint: targetMint,
    blockRewards: await blockRewardsFor(env, wallet, now - activeSeconds),
    discoveries: await discoverySummary(env, wallet, now - activeSeconds),
    milestones: milestoneView(streakOutcome.milestones),
    collectedAt: now,
    accounting: accountingOf(mine?.authority ?? "OFFCHAIN"),
  };

  if (targetMint) {
    await env.INDEXING_QUEUE.send({ type: "sync_power", wallet, mint: targetMint } satisfies IndexingEvent);
  }
  await metric(env, "mining.activate", 1, { streak: String(streakOutcome.streak), kind: streakOutcome.kind });
  await recordActivity(env, { wallet, request, action: "activate", outcome: "ok" });

  const updated = await env.DB.prepare("SELECT * FROM players WHERE wallet = ?1").bind(wallet).first<PlayerRow>();
  return json({
    report,
    player: rowToProfile(updated ?? row, now),
    settlements,
    streakOutcome: {
      kind: streakOutcome.kind,
      streak: streakOutcome.streak,
      longestStreak: streakOutcome.longestStreak,
      freezes: streakOutcome.freezes,
      usedFreeze: streakOutcome.usedFreeze,
      rewards: streakOutcome.rewards,
    },
    mine: mine ? mineInfoPayload({ state: mine, symbol: token?.symbol ?? "", tokenStatus: token?.status ?? "MINING_ACTIVE", playerPower: Number(power) }) : null,
  });
}

export async function switchMine(request: Request, env: RuntimeEnv): Promise<Response> {
  if (!(await checkRateLimit(request, env, "mine-switch"))) return apiError("Too many requests", 429);
  const wallet = await sessionWallet(request, env);
  if (!wallet) return apiError("Wallet authentication required", 401);

  const gate = await gateAction(env, { wallet, request, action: "switch_mine" });
  const denied = gateResponse(gate);
  if (denied) {
    await recordActivity(env, { wallet, request, action: "switch_mine", outcome: gateOutcomeName(gate) });
    return denied;
  }

  const { mint } = await readJson<{ mint?: string }>(request);
  if (!mint) return apiError("Missing mint");
  const token = await loadMineToken(env, mint);
  if (!token || token.status === "FULLY_MINED") return apiError("Unknown or fully mined mine", 404);

  const row = await getOrCreatePlayer(env, wallet, request);
  const now = Math.floor(Date.now() / 1_000);
  if (activationStateOf(row, now) !== "ACTIVE") {
    await recordActivity(env, { wallet, request, action: "switch_mine", outcome: "rejected" });
    return apiError("Activate your Mining Crew before switching mines", 409);
  }
  if (row.active_mint === mint) return apiError("This mine is already active", 409);

  // Switching settles the previous position; activation and streak are untouched (spec 30).
  const settlements = await releaseArmedPositions(env, wallet, now);
  const advance = await advanceMineTo(env, mint, now, { exclusive: true });
  if (!advance) return apiError("Unknown mine", 404);
  await armPosition(
    env,
    wallet,
    mint,
    BigInt(crewPower(crewLevelsOf(row))),
    row.activated_at ?? row.last_activation_at ?? now,
    row.activation_expires_at ?? now,
    now,
  );

  const cas = await env.DB.prepare("UPDATE players SET active_mint = ?1 WHERE wallet = ?2 AND active_mint IS ?3")
    .bind(mint, wallet, row.active_mint)
    .run();
  if (cas.meta.changes !== 1) {
    await recordActivity(env, { wallet, request, action: "switch_mine", outcome: "rejected" });
    return apiError("Mine switch raced another request, please retry", 409);
  }

  // Counted only once the switch actually committed, so a raced request does not inflate it.
  await bumpSocialMetrics(env, wallet, { mineSwitches: 1 }, now);

  await env.INDEXING_QUEUE.send({ type: "sync_power", wallet, mint } satisfies IndexingEvent);
  await metric(env, "mining.switch", 1, { mint });
  await recordActivity(env, { wallet, request, action: "switch_mine", outcome: "ok" });

  const updated = await env.DB.prepare("SELECT * FROM players WHERE wallet = ?1").bind(wallet).first<PlayerRow>();
  return json({
    player: rowToProfile(updated ?? row, now),
    settlements,
    mine: mineInfoPayload({
      state: advance.state,
      symbol: token.symbol,
      tokenStatus: token.status,
      playerPower: crewPower(crewLevelsOf(row)),
    }),
  });
}

/**
 * COLLECT (spec 29). Idempotent per activation window: the report row's primary key is the
 * window, so a repeat call returns the stored report instead of crediting ORE twice.
 */
export async function collectMiningReport(request: Request, env: RuntimeEnv): Promise<Response> {
  if (!(await checkRateLimit(request, env, "mine-report"))) return apiError("Too many requests", 429);
  const wallet = await sessionWallet(request, env);
  if (!wallet) return apiError("Wallet authentication required", 401);
  if (!(await checkWalletRateLimit(env, wallet, "mine-report", 30, 300))) {
    return apiError("Too many report requests, slow down", 429);
  }

  const row = await getOrCreatePlayer(env, wallet, request);
  const now = Math.floor(Date.now() / 1_000);
  const windowKey = row.last_activation_at ?? row.created_at;
  const reportId = `report:${wallet}:${windowKey}`;

  const existing = await env.DB.prepare("SELECT payload FROM mining_reports WHERE id = ?1")
    .bind(reportId)
    .first<{ payload: string }>();
  if (existing) {
    return json({ report: JSON.parse(existing.payload) as MiningReport, idempotent: true });
  }

  await reconcileArmedPosition(env, row, now);

  // Settle the live position so the report shows claimable block rewards; power is not released,
  // the crew keeps mining.
  const settlements: PositionSettlement[] = [];
  if (row.active_mint) {
    const settlement = await settlePositionAt(env, wallet, row.active_mint, now, { releasePower: false });
    if (settlement) settlements.push(settlement);
  }

  const levels = crewLevelsOf(row);
  const collectFrom = row.ore_collected_at ?? row.last_activation_at ?? now;
  const activeSeconds = activeSecondsForWindow(now, row.activation_expires_at, collectFrom);
  const stored = storeOre(
    row.ore_balance,
    oreForActiveSeconds(activeSeconds, Math.max(0, now - row.created_at), levels),
    oreCapacity(levels),
  );

  // The ORE cursor is the compare-and-swap: exactly one concurrent collect can credit the window.
  const cas = await env.DB.prepare(
    `UPDATE players SET ore_balance = ?1, ore_overflow = ?2, ore_collected_at = ?3, last_report_at = ?3
      WHERE wallet = ?4 AND ore_collected_at IS ?5`,
  )
    .bind(stored.balance, row.ore_overflow + stored.overflow, now, wallet, row.ore_collected_at)
    .run();

  if (cas.meta.changes !== 1) {
    const raced = await env.DB.prepare("SELECT payload FROM mining_reports WHERE id = ?1")
      .bind(reportId)
      .first<{ payload: string }>();
    if (raced) return json({ report: JSON.parse(raced.payload) as MiningReport, idempotent: true });
    return apiError("This report was already collected", 409);
  }

  const mineState = row.active_mint
    ? await env.DB.prepare("SELECT * FROM mine_reward_state WHERE mint = ?1")
        .bind(row.active_mint)
        .first<MineStateRow>()
    : null;

  const report: MiningReport = {
    activeSeconds,
    oreGained: stored.stored,
    oreOverflow: stored.overflow,
    streak: row.streak,
    streakFreezes: row.streak_freezes,
    usedFreeze: false,
    discovery: null,
    mineMint: row.active_mint,
    blockRewards: await blockRewardsFor(env, wallet, now - activeSeconds),
    discoveries: await discoverySummary(env, wallet, now - activeSeconds),
    milestones: [],
    collectedAt: now,
    accounting: accountingOf(mineState ? rowToMineState(mineState).authority : "OFFCHAIN"),
  };

  const insert = await env.DB.prepare(
    `INSERT OR IGNORE INTO mining_reports
       (id, wallet, mint, active_seconds, ore_gained, ore_overflow, streak, payload, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  )
    .bind(
      reportId,
      wallet,
      row.active_mint,
      activeSeconds,
      stored.stored,
      stored.overflow,
      row.streak,
      JSON.stringify(report),
      now,
    )
    .run();
  if (insert.meta.changes !== 1) {
    const raced = await env.DB.prepare("SELECT payload FROM mining_reports WHERE id = ?1")
      .bind(reportId)
      .first<{ payload: string }>();
    if (raced) return json({ report: JSON.parse(raced.payload) as MiningReport, idempotent: true });
  }

  await metric(env, "mining.report_collected", 1, { mint: row.active_mint ?? "none" });
  const updated = await env.DB.prepare("SELECT * FROM players WHERE wallet = ?1").bind(wallet).first<PlayerRow>();
  return json({
    report,
    player: rowToProfile(updated ?? row, now),
    settlements,
    idempotent: false,
  });
}

/** GET /api/mines/:mint/info (spec 33). Public; the share estimate needs a session wallet. */
export async function mineInfo(request: Request, env: RuntimeEnv, mint: string): Promise<Response> {
  const now = Math.floor(Date.now() / 1_000);
  const token = await loadMineToken(env, mint);
  if (!token) return apiError("Unknown mine", 404);
  const advance = await advanceMineTo(env, mint, now);
  if (!advance) return apiError("Unknown mine", 404);
  const wallet = await sessionWallet(request, env);
  const playerPower = wallet ? await armedPowerOf(env, wallet, mint) : null;
  return json({
    mine: mineInfoPayload({
      state: advance.state,
      symbol: token.symbol,
      tokenStatus: token.status,
      playerPower,
    }),
  });
}

/** Issues the signed, single-use challenge bound to wallet + action + reward id (spec 46, 47). */
export async function claimRewardChallenge(request: Request, env: RuntimeEnv): Promise<Response> {
  if (!(await checkRateLimit(request, env, "rewards-claim"))) return apiError("Too many requests", 429);
  const body = await readJson<{ wallet?: string; rewardId?: string; mint?: string }>(request);
  if (!isBase58Address(body.wallet)) return apiError("Invalid Solana wallet");
  const wallet = body.wallet;
  if (!(await checkWalletRateLimit(env, wallet, "rewards-claim-challenge", 30, 300))) {
    return apiError("Too many claim attempts, slow down", 429);
  }
  const now = Math.floor(Date.now() / 1_000);

  let rewardId = body.rewardId;
  if (!rewardId && body.mint) {
    // Convenience path: settle on demand so a player can claim without opening the report first.
    const settlement = await settlePositionAt(env, wallet, body.mint, now, { releasePower: false });
    rewardId = settlement?.claimId ?? undefined;
  }
  if (!rewardId) return apiError("No settled reward to claim", 404);

  const claim = await env.DB.prepare("SELECT * FROM reward_claims WHERE id = ?1 AND wallet = ?2")
    .bind(rewardId, wallet)
    .first<RewardClaimRow>();
  if (!claim) return apiError("Unknown reward claim", 404);
  if (claim.status === "EXPIRED" || (claim.status === "ELIGIBLE" && claim.eligible_until <= now)) {
    return apiError("This reward claim has expired", 410);
  }

  // Issued through the shared helper so the nonce is bound to the wallet, the action and this exact
  // reward as a structured `resource`, rather than only being implied by the text that gets signed.
  const challenge = await issueChallenge(env, {
    wallet,
    action: CLAIM_REWARD_ACTION,
    resource: claim.id,
    title: "Claim Diggo mining reward",
  });
  return json({
    nonce: challenge.nonce,
    message: challenge.message,
    rewardId: claim.id,
    mint: claim.mint,
    amount: Number(big(claim.amount)),
    status: claim.status,
    eligibleUntil: claim.eligible_until,
    accounting: accountingOf(claim.authority),
  });
}

function claimView(row: RewardClaimRow): Record<string, unknown> {
  return {
    id: row.id,
    mint: row.mint,
    amount: Number(big(row.amount)),
    status: row.status,
    createdAt: row.created_at,
    eligibleUntil: row.eligible_until,
    claimedAt: row.claimed_at,
    txSignature: row.tx_signature,
    accounting: accountingOf(row.authority),
    payout: claimPayoutView(row),
  };
}

/**
 * The only payout route a settled mining reward has (spec 57, docs/SECURITY.md invariant 7): the
 * tokens sit in the mine's program-controlled Mining Reserve and leave it only through the
 * user-signed `claim_rewards` instruction. The keeper is not authorised to move them, so the
 * backend's whole job is to say when a reward is ready and to record the signature the player's
 * own transaction produced.
 */
export const MINING_CLAIM_PAYOUT_ROUTE = "USER_SIGNED" as const;
export const MINING_CLAIM_INSTRUCTION = "claim_rewards" as const;
/** The action a claim challenge is bound to in challenge_nonces (see worker/auth.ts issueChallenge). */
export const CLAIM_REWARD_ACTION = "claim_reward";

/**
 * `ready` means the accounting is finished and the player still has to submit the on-chain claim:
 * the row is CLAIMED with no transaction recorded against it yet.
 */
export function claimPayoutView(row: {
  status: RewardClaimStatus;
  tx_signature: string | null;
}): RewardClaimPayout {
  return {
    route: MINING_CLAIM_PAYOUT_ROUTE,
    instruction: MINING_CLAIM_INSTRUCTION,
    ready: row.status === "CLAIMED" && row.tx_signature === null,
    txSignature: row.tx_signature,
  };
}

/**
 * POST /api/rewards/claim (spec 53, 57).
 *
 * The transition is a single conditional UPDATE, so of N concurrent requests exactly one can
 * observe meta.changes === 1 and only that one may report a payout.
 */
export async function claimReward(request: Request, env: RuntimeEnv): Promise<Response> {
  if (!(await checkRateLimit(request, env, "rewards-claim"))) return apiError("Too many requests", 429);
  const wallet = await sessionWallet(request, env);
  if (!wallet) return apiError("Wallet authentication required", 401);
  if (!(await checkWalletRateLimit(env, wallet, "rewards-claim", 20, 300))) {
    await recordActivity(env, { wallet, request, action: "claim_reward", outcome: "rate_limited" });
    return apiError("Too many claim attempts, slow down", 429);
  }
  const body = await readJson<{ rewardId?: string; nonce?: string; signature?: string }>(request);
  if (!body.rewardId || !body.nonce || !body.signature) return apiError("Incomplete claim proof");
  const now = Math.floor(Date.now() / 1_000);

  // The breaker is a hard, auditable halt, checked before any risk decision (spec 65). The claim's
  // mint is read first so an admin can halt one mine's claims without freezing the whole game:
  // isBreakerOpen consults that mine's row *and* the scope-wide one.
  const breakerTarget = await env.DB.prepare("SELECT mint FROM reward_claims WHERE id = ?1 AND wallet = ?2")
    .bind(body.rewardId, wallet)
    .first<{ mint: string }>();
  if (await isBreakerOpen(env, "claims", breakerTarget?.mint)) {
    await metric(env, "mining.claim_halted", 1, {});
    return json(
      { code: "CLAIMS_HALTED", message: "Reward claims are temporarily paused. Please try again later." },
      { status: 503, headers: { "retry-after": "300" } },
    );
  }

  const gate = await gateAction(env, { wallet, request, action: "claim_reward" });
  if (gate.challengeRequired) {
    await recordActivity(env, { wallet, request, action: "claim_reward", outcome: "failed_challenge" });
    return verificationResponse();
  }
  // A held reward is parked in HELD and can never reach CLAIMED (spec 53). It becomes claimable
  // again only once the hold is lifted, which is what the release step below does. The instant the
  // hold started is recorded, because the eligibility window stops running while it is in place.
  if (gate.rewardState === "HELD" || gate.rewardState === "UNDER_REVIEW") {
    await env.DB.prepare(
      "UPDATE reward_claims SET status = 'HELD', held_at = COALESCE(held_at, ?3)" +
        " WHERE id = ?1 AND wallet = ?2 AND status IN ('ELIGIBLE', 'PENDING')",
    )
      .bind(body.rewardId, wallet, now)
      .run();
    await metric(env, "mining.claim_held", 1, { state: gate.rewardState });
    await recordActivity(env, { wallet, request, action: "claim_reward", outcome: "rejected" });
    return json(
      {
        code: gate.rewardState,
        message: gate.publicMessage ?? DIGGO_CONFIG.risk.publicStatus[gate.rewardState],
      },
      { status: 403 },
    );
  }
  const denied = gateResponse(gate);
  if (denied) {
    await recordActivity(env, { wallet, request, action: "claim_reward", outcome: gateOutcomeName(gate) });
    return denied;
  }

  const key = challengeKey(CLAIM_REWARD_ACTION, body.nonce);
  const challenge = await loadChallenge(env, key);
  if (!challenge || challenge.wallet !== wallet) {
    // Nothing usable is left in KV, so the nonce table has the final word: a spent nonce is a
    // replay, not merely a late request (spec 47).
    const status = await consumeChallengeNonce(env, {
      nonce: body.nonce,
      wallet,
      action: CLAIM_REWARD_ACTION,
      resource: body.rewardId,
    });
    await recordActivity(env, { wallet, request, action: "claim_reward", outcome: "failed_challenge" });
    if (status === "replay") return apiError("Challenge already used", 409);
    return apiError("Challenge expired", 401);
  }
  // The bound resource, not a substring of the signed text: a signature over another reward's
  // challenge must not be usable for this one.
  if ((challenge.resource ?? "") !== body.rewardId) {
    await recordActivity(env, { wallet, request, action: "claim_reward", outcome: "failed_challenge" });
    return apiError("Challenge does not match this reward", 401);
  }
  if (!verifyWalletSignature(wallet, challenge.message, body.signature)) {
    await recordActivity(env, { wallet, request, action: "claim_reward", outcome: "failed_challenge" });
    return apiError("Invalid wallet signature", 401);
  }
  // Single-use in the authoritative table: the conditional UPDATE is what spends the nonce in every
  // colo, where deleting the KV record only clears the cache of the colo that handled the claim.
  const consumed = await consumeChallengeNonce(env, {
    nonce: body.nonce,
    wallet,
    action: CLAIM_REWARD_ACTION,
    resource: body.rewardId,
  });
  if (consumed !== "ok") {
    await recordActivity(env, { wallet, request, action: "claim_reward", outcome: "replay" });
    return apiError(
      consumed === "replay" ? "Challenge already used" : "Challenge expired",
      consumed === "replay" ? 409 : 401,
    );
  }
  await env.TOKEN_CACHE.delete(key);

  // Recovery path for a claim parked while the account was under review. The window stopped
  // running while the hold was in place, so it is extended by exactly the time the hold lasted: a
  // hold that outlives eligible_until must not destroy the reward it was protecting (spec 53).
  await env.DB.prepare(
    `UPDATE reward_claims
        SET status = 'ELIGIBLE',
            eligible_until = eligible_until + MAX(0, ?1 - COALESCE(held_at, ?1)),
            held_at = NULL
      WHERE id = ?2 AND wallet = ?3 AND status = 'HELD'`,
  )
    .bind(now, body.rewardId, wallet)
    .run();

  const transition = await env.DB.prepare(
    `UPDATE reward_claims SET status = 'CLAIMED', claimed_at = ?1, claim_nonce = ?2
      WHERE id = ?3 AND wallet = ?4 AND status = 'ELIGIBLE' AND eligible_until > ?1`,
  )
    .bind(now, body.nonce, body.rewardId, wallet)
    .run();

  if (transition.meta.changes !== 1) {
    const current = await env.DB.prepare("SELECT * FROM reward_claims WHERE id = ?1 AND wallet = ?2")
      .bind(body.rewardId, wallet)
      .first<RewardClaimRow>();
    if (!current) return apiError("Unknown reward claim", 404);
    if (current.status === "CLAIMED") {
      await recordActivity(env, { wallet, request, action: "claim_reward", outcome: "replay" });
      await metric(env, "mining.claim_replay", 1, { mint: current.mint });
      // Idempotent: the second request reports the same claim and pays nothing twice.
      return json({ claimed: false, alreadyClaimed: true, claim: claimView(current) });
    }
    if (current.status === "EXPIRED" || current.eligible_until <= now) {
      await env.DB.prepare("UPDATE reward_claims SET status = 'EXPIRED' WHERE id = ?1 AND status IN ('ELIGIBLE', 'PENDING')")
        .bind(current.id)
        .run();
      return apiError("This reward claim has expired", 410);
    }
    if (current.status === "HELD") {
      return json(
        { code: "HELD", message: DIGGO_CONFIG.risk.publicStatus.HELD },
        { status: 423, headers: { "retry-after": "3600" } },
      );
    }
    return apiError("This reward claim is not claimable", 409);
  }

  const claimed = await env.DB.prepare("SELECT * FROM reward_claims WHERE id = ?1").bind(body.rewardId).first<RewardClaimRow>();
  await env.INDEXING_QUEUE.send({
    type: "reward_claim",
    claimId: body.rewardId,
    wallet,
    mint: claimed?.mint ?? "",
  } satisfies IndexingEvent);
  await metric(env, "mining.claim", 1, { mint: claimed?.mint ?? "unknown" });
  await recordActivity(env, { wallet, request, action: "claim_reward", outcome: "ok" });

  return json({ claimed: true, claim: claimed ? claimView(claimed) : null });
}

export async function listRewardClaims(request: Request, env: RuntimeEnv, wallet: string): Promise<Response> {
  const authenticated = await sessionWallet(request, env);
  if (!authenticated || authenticated !== wallet) return apiError("Wallet authentication required", 401);
  const rows = await env.DB.prepare(
    "SELECT * FROM reward_claims WHERE wallet = ?1 ORDER BY created_at DESC LIMIT 50",
  )
    .bind(wallet)
    .all<RewardClaimRow>();
  return json({ claims: rows.results.map(claimView) });
}

/**
 * Claims that are CLAIMED but have no payout transaction recorded against them yet: the player has
 * won the accounting and still has to submit their own on-chain `claim_rewards`.
 *
 * This is the read side of the reward_claim job (see settleRewardClaim and worker/indexing.ts) and
 * the monitoring gauge for how much value is waiting on players rather than on the backend.
 */
export async function listClaimsAwaitingPayout(
  env: RuntimeEnv,
  limit = 20,
): Promise<RewardClaimRow[]> {
  const rows = await env.DB.prepare(
    "SELECT * FROM reward_claims WHERE status = 'CLAIMED' AND tx_signature IS NULL ORDER BY claimed_at ASC LIMIT ?1",
  )
    .bind(limit)
    .all<RewardClaimRow>();
  return rows.results;
}

/**
 * Records one user-signed payout against its claim. The conditional UPDATE is the concurrency
 * guard - of N writers exactly one sees meta.changes === 1 - and the partial UNIQUE index on
 * tx_signature (migrations/0012_reconciliation.sql) is the storage-level guard behind it, so a
 * signature that already backs another reward is rejected even by a writer that raced past the
 * read-side replay check.
 *
 * paidAmount is what the verified transaction actually moved, not what the claim asked for; it is
 * the number the reconciliation cron compares against the chain.
 */
export async function markClaimPaid(
  env: RuntimeEnv,
  claimId: string,
  txSignature: string,
  paidAmount?: bigint | null,
): Promise<boolean> {
  const result = await env.DB.prepare(
    "UPDATE reward_claims SET tx_signature = ?1, paid_amount = ?3 " +
      "WHERE id = ?2 AND status = 'CLAIMED' AND tx_signature IS NULL",
  )
    .bind(txSignature, claimId, paidAmount === undefined || paidAmount === null ? null : paidAmount.toString())
    .run();
  return result.meta.changes === 1;
}

/* ---- confirming a player's own on-chain claim_rewards transaction (spec 57) ---------- */

/**
 * The slice of a JSON-RPC confirmed transaction this module reads. Declared structurally, and the
 * reader that fetches it is injectable, so a test can drive the whole confirmation path with a
 * crafted transaction and no network double.
 */
export interface RawClaimInstruction {
  programId?: unknown;
  accounts?: readonly unknown[] | null;
  data?: unknown;
}

export interface RawTokenBalance {
  accountIndex?: unknown;
  mint?: unknown;
  owner?: unknown;
  uiTokenAmount?: { amount?: unknown } | null;
}

export interface RawClaimTransaction {
  /** Unix seconds the block was produced, when the RPC reports it. */
  blockTime?: number | null;
  meta?: {
    err?: unknown;
    preTokenBalances?: readonly RawTokenBalance[] | null;
    postTokenBalances?: readonly RawTokenBalance[] | null;
    innerInstructions?: readonly { instructions?: readonly RawClaimInstruction[] | null }[] | null;
    /**
     * The accounts this transaction's address lookup tables resolved. A versioned transaction's
     * message carries only its statically declared keys, so without these the account list is
     * incomplete - and the loaded ones follow the static ones in the runtime's own order, writable
     * entries first and read-only entries after.
     */
    loadedAddresses?: {
      writable?: readonly unknown[] | null;
      readonly?: readonly unknown[] | null;
    } | null;
  } | null;
  transaction?: {
    message?: {
      accountKeys?: readonly unknown[] | null;
      instructions?: readonly RawClaimInstruction[] | null;
    } | null;
  } | null;
}

/** The one chain read the confirmation path needs. */
export interface ClaimTransactionReader {
  getTransaction(signature: string): Promise<RawClaimTransaction | null>;
}

export function chainClaimTransactionReader(env: RuntimeEnv): ClaimTransactionReader {
  return {
    async getTransaction(signature: string): Promise<RawClaimTransaction | null> {
      const rpc = getChainRpc(env);
      const transaction = await rpc
        .getTransaction(signature as never, {
          commitment: "confirmed",
          encoding: "jsonParsed",
          maxSupportedTransactionVersion: 0,
        })
        .send();
      return (transaction as unknown as RawClaimTransaction | null) ?? null;
    },
  };
}

/**
 * Why a reported payout was refused. Every value is a stable name, because the endpoint reports
 * one back to the client and the telemetry counter tags on it.
 */
export type ClaimVerificationReason =
  | "program_not_configured"
  | "transaction_not_found"
  | "transaction_failed"
  /** The claim has no settlement instant to anchor the transaction against. */
  | "claim_not_settled"
  | "transaction_predates_claim"
  | "wallet_not_signer"
  | "instruction_not_found"
  | "instruction_accounts_mismatch"
  | "no_token_credit"
  | "reserve_not_debited";

export interface ClaimVerification {
  ok: boolean;
  reason: ClaimVerificationReason | null;
  /** Tokens the transaction credited to the player's own associated token account. */
  paidAmount: bigint;
  // paidAmount is in raw base units, exactly as the chain reported them. reward_claims.amount is
  // the settled whole-token figure, so the two are deliberately not compared here: the
  // settled-vs-paid comparison belongs to the reconciliation job (worker/reconcile.ts), which loads
  // the mint's decimals in one place instead of each caller guessing the unit.
}

function accountKeyOf(entry: unknown): { pubkey: string; signer: boolean } | null {
  if (typeof entry === "string") return { pubkey: entry, signer: false };
  if (entry && typeof entry === "object") {
    const candidate = entry as { pubkey?: unknown; signer?: unknown };
    if (typeof candidate.pubkey === "string") {
      return { pubkey: candidate.pubkey, signer: candidate.signer === true };
    }
  }
  return null;
}

/**
 * The complete account list of a transaction: the keys its message declares, followed by the ones
 * its address lookup tables loaded. jsonParsed reports the loaded entries separately, and a claim
 * that names one of them - a wallet's own associated token account is the usual case - is only
 * matchable against this list. Order matters: indices, including every token balance's
 * accountIndex, are positions in exactly this array.
 */
function resolvedAccountKeys(transaction: RawClaimTransaction): { pubkey: string; signer: boolean }[] {
  const declared = (transaction.transaction?.message?.accountKeys ?? []).map(accountKeyOf);
  const loaded = [
    ...(transaction.meta?.loadedAddresses?.writable ?? []),
    ...(transaction.meta?.loadedAddresses?.readonly ?? []),
  ].map(accountKeyOf);
  return [...declared, ...loaded].filter((entry): entry is { pubkey: string; signer: boolean } => entry !== null);
}

/**
 * The accounts an instruction names. jsonParsed gives a parsed instruction base58 pubkeys, but an
 * instruction it could not parse (which is what a custom program instruction is) carries indices
 * into the transaction's account list instead - including indices that resolve through an address
 * lookup table, which is why the caller passes the resolved list rather than the static keys.
 */
function instructionAccountKeys(
  instruction: RawClaimInstruction,
  accountKeys: readonly { pubkey: string }[],
): string[] {
  const keys: string[] = [];
  for (const entry of instruction.accounts ?? []) {
    if (typeof entry === "number") {
      const resolved = accountKeys[entry];
      if (resolved) keys.push(resolved.pubkey);
      continue;
    }
    const key = accountKeyOf(entry);
    if (key) keys.push(key.pubkey);
  }
  return keys;
}

/**
 * Instruction bytes as jsonParsed reports them (base58 for a program the RPC cannot parse). The
 * decoder is the same one the client uses, so the two sides cannot disagree about the encoding.
 */
function instructionDataBytes(instruction: RawClaimInstruction): Uint8Array | ReadonlyUint8Array | null {
  const data = instruction.data;
  if (data instanceof Uint8Array) return data;
  if (Array.isArray(data)) return Uint8Array.from(data as number[]);
  if (typeof data === "string") {
    try {
      return getBase58Encoder().encode(data);
    } catch {
      return null;
    }
  }
  return null;
}

interface ExpectedClaim {
  instruction: Instruction;
  reserveVault: Address;
  ownerTokens: Address;
}

/**
 * The instruction a legitimate claim_rewards payout for this claim has to contain, plus the two
 * token accounts whose balances say what it actually paid.
 *
 * Built with the same shared/program.ts builder the browser uses, so the discriminator, the PDA
 * seeds and the account order have exactly one definition in the codebase.
 */
async function expectedClaimInstruction(
  programId: string,
  wallet: string,
  mint: string,
): Promise<ExpectedClaim> {
  const programAddress = address(programId);
  const mintAddress = address(mint);
  const owner = address(wallet);
  const { mine, reserveVault } = await deriveMineAddresses(programAddress, mintAddress);
  const [position, ownerTokens] = await Promise.all([
    derivePositionPda(programAddress, mine, owner),
    deriveAssociatedTokenAddress(owner, mintAddress),
  ]);
  return {
    instruction: buildClaimRewardsInstruction({
      programAddress,
      owner,
      mine,
      mint: mintAddress,
      reserveVault,
      ownerTokens,
      position,
    }),
    reserveVault,
    ownerTokens,
  };
}

function tokenAmountAt(balances: readonly RawTokenBalance[] | null | undefined, accountIndex: number): bigint | null {
  for (const balance of balances ?? []) {
    if (Number(balance.accountIndex) !== accountIndex) continue;
    const amount = balance.uiTokenAmount?.amount;
    return amount === undefined || amount === null ? null : BigInt(String(amount));
  }
  return null;
}

/**
 * Verifies a reported claim_rewards signature against the chain and measures what it paid.
 *
 * The checks are identity, not amount: the transaction has to be a confirmed, successful,
 * wallet-signed call to the Diggo program whose claim_rewards instruction carries this claim's
 * owner, mine, mint, reserve vault, owner token account and mining position, and it has to have
 * moved tokens out of that mine's reserve vault into that wallet's own token account by the same
 * amount it left the vault. Any of those failing means the signature is not this claim's payout,
 * so nothing is recorded - anything unreadable counts as unverified, which is what makes a flaky
 * RPC unable to turn a forged report into a recorded payout.
 */
export async function verifyConfirmedClaim(
  env: RuntimeEnv,
  signature: string,
  claim: { wallet: string; mint: string; claimed_at?: number | null },
  reader: ClaimTransactionReader,
): Promise<ClaimVerification> {
  const refuse = (reason: ClaimVerificationReason): ClaimVerification => ({
    ok: false,
    reason,
    paidAmount: 0n,
  });

  if (!env.DIGGO_PROGRAM_ID) return refuse("program_not_configured");

  let transaction: RawClaimTransaction | null;
  try {
    transaction = await reader.getTransaction(signature);
  } catch (error) {
    console.error(
      JSON.stringify({ event: "mining.claim_confirm_read_failed", mint: claim.mint, error: String(error) }),
    );
    return refuse("transaction_not_found");
  }
  if (!transaction) return refuse("transaction_not_found");
  if (transaction.meta?.err) return refuse("transaction_failed");

  // A transaction older than the moment the reward settled cannot be that reward's payout. Without
  // this, a real claim_rewards signature that was never recorded (a collect made outside this
  // endpoint) could be replayed later as proof for a newer, still-unpaid reward. The slack absorbs
  // ordinary clock skew between this Worker and the cluster.
  //
  // A missing block time is refused rather than skipped: "the RPC did not say when this landed" is
  // not evidence that it is recent, and treating it as recent is exactly the hole above.
  const claimedAt = claim.claimed_at ?? null;
  // A claim with no settlement instant is the same hole from the other side: without the anchor
  // there is nothing to compare against, so every old signature for this wallet and mine would
  // count as proof for it. Refuse instead of skipping the check.
  if (claimedAt === null) return refuse("claim_not_settled");
  if (typeof transaction.blockTime !== "number") return refuse("transaction_predates_claim");
  if (transaction.blockTime < claimedAt - 300) return refuse("transaction_predates_claim");

  const accountKeys = resolvedAccountKeys(transaction);
  const indexOf = new Map<string, number>();
  accountKeys.forEach((key, index) => {
    if (!indexOf.has(key.pubkey)) indexOf.set(key.pubkey, index);
  });
  const walletSigned = accountKeys.some((key) => key.pubkey === claim.wallet && key.signer);
  if (!walletSigned) return refuse("wallet_not_signer");

  let expected: ExpectedClaim;
  try {
    expected = await expectedClaimInstruction(env.DIGGO_PROGRAM_ID, claim.wallet, claim.mint);
  } catch (error) {
    console.error(
      JSON.stringify({ event: "mining.claim_confirm_derive_failed", mint: claim.mint, error: String(error) }),
    );
    return refuse("instruction_accounts_mismatch");
  }
  const expectedData = instructionDataBytes({ data: expected.instruction.data });
  // The builder always carries the discriminator; if it ever did not, every instruction on the
  // program would look like a match, so refuse instead of comparing against nothing.
  if (!expectedData || expectedData.length === 0) return refuse("instruction_not_found");
  const requiredAccounts = (expected.instruction.accounts ?? []).map((account) => account.address);
  const required = new Set<string>(requiredAccounts);

  // A claim that another program CPI'd into the Diggo program is still a real payout, so the
  // inner instructions are searched too; only a top-level match is required to be present once.
  const candidates: RawClaimInstruction[] = [
    ...(transaction.transaction?.message?.instructions ?? []),
    ...(transaction.meta?.innerInstructions ?? []).flatMap((entry) => entry.instructions ?? []),
  ];
  const matching = candidates.filter((instruction) => {
    if (String(instruction.programId) !== env.DIGGO_PROGRAM_ID) return false;
    const data = instructionDataBytes(instruction);
    if (!data || data.length < expectedData.length) return false;
    for (let index = 0; index < expectedData.length; index += 1) {
      if (data[index] !== expectedData[index]) return false;
    }
    // Superset, not equality: a caller that adds remaining accounts is still claiming the same
    // reward, but every account this claim's payout must name has to be named.
    const present = new Set(instructionAccountKeys(instruction, accountKeys));
    for (const account of required) {
      if (!present.has(account)) return false;
    }
    return true;
  });
  if (matching.length === 0) {
    // Distinguish "no claim_rewards at all" from "a claim_rewards for somewhere else".
    const anyClaim = candidates.some((instruction) => {
      const data = instructionDataBytes(instruction);
      if (!data || data.length < expectedData.length) return false;
      for (let index = 0; index < expectedData.length; index += 1) {
        if (data[index] !== expectedData[index]) return false;
      }
      return true;
    });
    return refuse(anyClaim ? "instruction_accounts_mismatch" : "instruction_not_found");
  }

  const ownerTokensIndex = indexOf.get(expected.ownerTokens);
  const reserveVaultIndex = indexOf.get(expected.reserveVault);
  if (ownerTokensIndex === undefined || reserveVaultIndex === undefined) {
    return refuse("instruction_accounts_mismatch");
  }
  const credited = (tokenAmountAt(transaction.meta?.postTokenBalances, ownerTokensIndex) ?? 0n) -
    (tokenAmountAt(transaction.meta?.preTokenBalances, ownerTokensIndex) ?? 0n);
  const debited = (tokenAmountAt(transaction.meta?.preTokenBalances, reserveVaultIndex) ?? 0n) -
    (tokenAmountAt(transaction.meta?.postTokenBalances, reserveVaultIndex) ?? 0n);
  if (credited <= 0n) return refuse("no_token_credit");
  if (debited !== credited) return refuse("reserve_not_debited");

  return { ok: true, reason: null, paidAmount: credited };
}

/** Signature shape the RPC accepts; a malformed one is rejected before any chain call. */
const TRANSACTION_SIGNATURE_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

/**
 * POST /api/rewards/claim/confirm (spec 53, 57).
 *
 * The player's own wallet signs and submits claim_rewards, so the backend never touches the
 * Mining Reserve; this endpoint exists only to record that the payout happened, and only after
 * verifying the transaction on-chain. It is deliberately idempotent: confirming the same
 * signature again is a success, while a signature that already backs a different reward is a
 * rejection (the partial UNIQUE index on tx_signature is the storage-level version of the same
 * rule).
 */
export async function confirmRewardClaim(
  request: Request,
  env: RuntimeEnv,
  reader?: ClaimTransactionReader,
): Promise<Response> {
  // Higher than the claim endpoint's IP budget on purpose: a player who has banked several settled
  // rewards confirms them one after another in a short window, and each one is a real transaction.
  if (!(await checkRateLimit(request, env, "rewards-confirm", 30))) return apiError("Too many requests", 429);
  const wallet = await sessionWallet(request, env);
  if (!wallet) return apiError("Wallet authentication required", 401);
  if (!(await checkWalletRateLimit(env, wallet, "rewards-confirm", 30, 300))) {
    return apiError("Too many claim confirmations, slow down", 429);
  }
  const body = await readJson<{ rewardId?: string; signature?: string }>(request);
  if (typeof body.rewardId !== "string" || body.rewardId.length === 0) return apiError("Missing reward id");
  if (typeof body.signature !== "string" || !TRANSACTION_SIGNATURE_PATTERN.test(body.signature)) {
    return apiError("Invalid transaction signature");
  }

  const claim = await env.DB.prepare("SELECT * FROM reward_claims WHERE id = ?1")
    .bind(body.rewardId)
    .first<RewardClaimRow>();
  // Another wallet's claim is reported exactly like a missing one, so this endpoint cannot be used
  // to probe which reward ids exist.
  if (!claim || claim.wallet !== wallet) return apiError("Unknown reward claim", 404);

  if (claim.tx_signature !== null) {
    if (claim.tx_signature === body.signature) {
      return json({ status: "CONFIRMED", idempotent: true, claim: claimView(claim) });
    }
    await metric(env, "mining.claim_confirm_replay", 1, { mint: claim.mint });
    return json(
      { code: "ALREADY_CLAIMED", message: "This reward already has a confirmed payout." },
      { status: 409 },
    );
  }
  if (claim.status !== "CLAIMED") {
    await metric(env, "mining.claim_confirm_not_settled", 1, { mint: claim.mint, status: claim.status });
    return json(
      { code: "NOT_SETTLED", message: "This reward has not finished settling yet." },
      { status: 409 },
    );
  }
  // A claims breaker scoped to this mint (which is what the reconciliation cron opens when a
  // reserve diverges) has to stop a payout from being recorded for that mine. isBreakerOpen also
  // consults the scope-wide row, so both kinds of halt are covered by this one check.
  if (await isBreakerOpen(env, "claims", claim.mint)) {
    await metric(env, "mining.claim_confirm_halted", 1, { mint: claim.mint });
    return json(
      { code: "CLAIMS_HALTED", message: "Reward claims are temporarily paused. Please try again later." },
      { status: 503, headers: { "retry-after": "300" } },
    );
  }

  const reused = await env.DB.prepare("SELECT id FROM reward_claims WHERE tx_signature = ?1")
    .bind(body.signature)
    .first<{ id: string }>();
  if (reused && reused.id !== claim.id) {
    await metric(env, "risk.replay_attempt", 1, { path: "claim_confirm" });
    console.error(
      JSON.stringify({ event: "mining.claim_confirm_replay", claimId: claim.id, wallet, signature: body.signature }),
    );
    return json(
      {
        code: "SIGNATURE_REUSED",
        message: "That transaction signature is already recorded against another reward.",
      },
      { status: 409 },
    );
  }

  const verification = await verifyConfirmedClaim(
    env,
    body.signature,
    claim,
    reader ?? chainClaimTransactionReader(env),
  );
  if (!verification.ok) {
    await metric(env, "mining.claim_confirm_unverified", 1, {
      mint: claim.mint,
      reason: verification.reason ?? "unknown",
    });
    console.error(
      JSON.stringify({
        event: "mining.claim_confirm_unverified",
        claimId: claim.id,
        wallet,
        mint: claim.mint,
        signature: body.signature,
        reason: verification.reason,
      }),
    );
    return json(
      {
        code: "PAYOUT_UNVERIFIED",
        message: "That transaction could not be verified as this reward's payout.",
      },
      { status: 409 },
    );
  }

  let recorded: boolean;
  try {
    recorded = await markClaimPaid(env, claim.id, body.signature, verification.paidAmount);
  } catch (error) {
    // The partial UNIQUE index rejected a signature another row already carries.
    await metric(env, "risk.replay_attempt", 1, { path: "claim_confirm_unique" });
    console.error(
      JSON.stringify({
        event: "mining.claim_confirm_unique_violation",
        claimId: claim.id,
        error: String(error),
      }),
    );
    return json(
      { code: "SIGNATURE_REUSED", message: "That transaction signature is already recorded." },
      { status: 409 },
    );
  }

  const settled = await env.DB.prepare("SELECT * FROM reward_claims WHERE id = ?1")
    .bind(claim.id)
    .first<RewardClaimRow>();
  if (!recorded) {
    // A concurrent confirm won the guarded UPDATE. The same signature is a success; anything else
    // means this payout was already recorded by another transaction.
    if (settled && settled.tx_signature === body.signature) {
      return json({ status: "CONFIRMED", idempotent: true, claim: claimView(settled) });
    }
    await metric(env, "mining.claim_confirm_conflict", 1, { mint: claim.mint });
    return json(
      { code: "ALREADY_CLAIMED", message: "This reward already has a confirmed payout." },
      { status: 409 },
    );
  }

  // Counted as one confirmed payout, with the settled figure and the measured raw figure logged
  // side by side rather than folded into one number: they are in different units on purpose, and
  // the numeric comparison between them is the reconciliation job's.
  await metric(env, "mining.claim_confirmed", 1, { mint: claim.mint });
  console.log(
    JSON.stringify({
      event: "mining.claim_confirmed",
      claimId: claim.id,
      wallet,
      mint: claim.mint,
      signature: body.signature,
      settledAmount: claim.amount,
      paidAmountRaw: verification.paidAmount.toString(),
    }),
  );
  return json({
    status: "CONFIRMED",
    idempotent: false,
    // Raw base units, exactly as the chain reported them.
    paidAmountRaw: verification.paidAmount.toString(),
    settledAmount: claim.amount,
    claim: claimView(settled ?? claim),
  });
}

export interface RewardClaimQueueEvent {
  claimId: string;
  wallet: string;
  mint: string;
  /** Present only when a client reports the confirmed on-chain claim_rewards transaction. */
  txSignature?: string;
}

export type RewardClaimOutcome = "ready" | "paid" | "ignored";

export interface RewardClaimSettlement {
  claimId: string;
  outcome: RewardClaimOutcome;
  /** Why the job ended the way it did. Never returned to a client. */
  reason: string;
  /** Claims still waiting on a user-signed payout, for the monitoring gauge (spec 66). */
  outstanding: number;
  payout: RewardClaimPayout | null;
}

/**
 * Applies one reward_claim queue job (spec 57, 65).
 *
 * This is where a settled block reward becomes collectable, and it is deliberately the narrowest
 * possible path: the backend never pays a mining reward. The Mining Reserve is program-controlled
 * and leaves it only through the user-signed claim_rewards instruction, so there is no keeper call
 * to make here. The two alternatives were rejected rather than implemented:
 *
 *   - a keeper-signed payout of the Mining Reserve would hand a backend key the power to drain a
 *     mine's reserve, which is exactly what docs/SECURITY.md invariant 7 forbids;
 *   - marking the claim paid without a real transaction would strand the player's own reward.
 *
 * So a job without a txSignature ends in `ready`: the claim row is already CLAIMED, its amount is
 * already accounted out of the reserve, and the player collects it on-chain themselves. A job that
 * carries a txSignature is the other half of the loop - the player's transaction is verified
 * against chain and only then recorded through markClaimPaid, by the same verifier the confirm
 * endpoint uses. A signature that only proves "some wallet-signed transaction touched the program"
 * is not proof of this claim's payout, so the weak check that used to sit here is gone rather than
 * kept as a second, easier door into markClaimPaid.
 */
export async function settleRewardClaim(
  env: RuntimeEnv,
  event: RewardClaimQueueEvent,
  reader?: ClaimTransactionReader,
): Promise<RewardClaimSettlement> {
  const claimId = event.claimId;
  const done = async (
    outcome: RewardClaimOutcome,
    reason: string,
    payout: RewardClaimPayout | null,
  ): Promise<RewardClaimSettlement> => ({
    claimId,
    outcome,
    reason,
    outstanding: (await listClaimsAwaitingPayout(env, 20)).length,
    payout,
  });

  const row = await env.DB.prepare("SELECT * FROM reward_claims WHERE id = ?1")
    .bind(claimId)
    .first<RewardClaimRow>();
  if (!row) return done("ignored", "unknown_claim", null);

  // The event is a queue message, so it is untrusted input: a job may only ever act on the claim
  // it names, for the wallet and mine that claim actually belongs to.
  if (row.wallet !== event.wallet || row.mint !== event.mint) {
    await metric(env, "mining.claim_event_mismatch", 1, { mint: row.mint });
    console.error(JSON.stringify({ event: "mining.claim_event_mismatch", claimId, expected: row.wallet }));
    return done("ignored", "event_mismatch", claimPayoutView(row));
  }

  if (row.status === "CLAIMED" && row.tx_signature !== null) {
    return done("ignored", "already_paid", claimPayoutView(row));
  }
  if (row.status !== "CLAIMED") {
    // Only a claim that won the guarded ELIGIBLE -> CLAIMED transition is ever collectable, so a
    // stray job cannot turn an unsettled, expired or held reward into a payout.
    return done("ignored", `status_${row.status.toLowerCase()}`, claimPayoutView(row));
  }

  if (event.txSignature) {
    const verification = await verifyConfirmedClaim(
      env,
      event.txSignature,
      { wallet: row.wallet, mint: row.mint, claimed_at: row.claimed_at },
      reader ?? chainClaimTransactionReader(env),
    );
    if (!verification.ok) {
      await metric(env, "mining.claim_payout_unverified", 1, { mint: row.mint });
      console.error(
        JSON.stringify({
          event: "mining.claim_payout_unverified",
          claimId,
          signature: event.txSignature,
          reason: verification.reason,
        }),
      );
      return done("ignored", "unverified_signature", claimPayoutView(row));
    }
    if (!(await markClaimPaid(env, claimId, event.txSignature, verification.paidAmount))) {
      // Another job recorded the same payout first; the row is paid exactly once either way.
      await metric(env, "mining.claim_paid_conflict", 1, { mint: row.mint });
      const settled = await env.DB.prepare("SELECT * FROM reward_claims WHERE id = ?1")
        .bind(claimId)
        .first<RewardClaimRow>();
      return done("ignored", "already_paid", settled ? claimPayoutView(settled) : null);
    }
    await metric(env, "mining.claim_paid", Number(big(row.amount)), { mint: row.mint });
    console.log(
      JSON.stringify({ event: "mining.claim_paid", claimId, wallet: row.wallet, signature: event.txSignature }),
    );
    return done("paid", "user_signed_payout_recorded", {
      route: MINING_CLAIM_PAYOUT_ROUTE,
      instruction: MINING_CLAIM_INSTRUCTION,
      ready: false,
      txSignature: event.txSignature,
    });
  }

  await metric(env, "mining.claim_ready", Number(big(row.amount)), { mint: row.mint });
  console.log(
    JSON.stringify({
      event: "mining.claim_ready_for_user",
      claimId,
      wallet: row.wallet,
      mint: row.mint,
      instruction: MINING_CLAIM_INSTRUCTION,
    }),
  );
  return done("ready", "awaiting_user_signature", claimPayoutView(row));
}
