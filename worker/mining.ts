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
import { DIGGO_CONFIG, type DiggoConfig } from "../shared/config";
import { crewTier, crewPower } from "../shared/crew";
import { discoveryEligible } from "../shared/discovery";
import { oreCapacity, oreForActiveSeconds, oreFromActivation, storeOre } from "../shared/ore";
import {
  applyBlock,
  reducedReward,
  rewardReductionSchedule,
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
  RewardClaimPayout,
  TokenStatus,
} from "../shared/types";
import { loadChallenge, sessionWallet, storeChallenge, verifyWalletSignature } from "./auth";
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
import { gateAction, recordActivity } from "./risk";
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
export const MAX_EXPIRY_ROWS = 256;
/** How long a settled block-reward claim stays claimable before it expires. */
export const REWARD_CLAIM_WINDOW_SECONDS = 30 * 86_400;
export const REDUCTION_SCHEDULE_EPOCHS = 8;
export const ESTIMATE_LABEL = "Estimate based on current conditions.";
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
  blockInterval: number;
  epochLength: number;
  epochEndsAt: number;
  authority: MineAuthority;
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
  block_interval: number;
  epoch_length: number;
  epoch_ends_at: number;
  authority: MineAuthority;
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
}

export interface PositionRow {
  wallet: string;
  mint: string;
  assigned_power: string;
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
  settlement_seq: number;
  authority: MineAuthority;
  tx_signature: string | null;
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
    blockInterval: row.block_interval > 0 ? row.block_interval : NOMINAL_BLOCK_INTERVAL_SECONDS,
    epochLength: row.epoch_length > 0 ? row.epoch_length : NOMINAL_EPOCH_LENGTH_SECONDS,
    epochEndsAt: row.epoch_ends_at,
    authority: row.authority,
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

function toRewardIndexState(state: MineState): RewardIndexState {
  return {
    globalRewardIndex: state.rewardIndex,
    totalEligiblePower: state.totalEligiblePower,
    reserveRemaining: state.remainingReserve,
    committed: state.committed,
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
      while (blockTime >= epochEndsAt) {
        rewardPerBlock = BigInt(
          reducedReward(Number(rewardPerBlock), config.economy.rewardReductionBps, config.economy.minimumReducedReward),
        );
        epoch += 1;
        epochEndsAt += state.epochLength;
      }
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
    if (outcome.fullyMined) break;
  }

  const fullyMined = core.reserveRemaining <= 0n;
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
    estimateLabel: ESTIMATE_LABEL,
    reductionSchedule: rewardReductionSchedule(REDUCTION_SCHEDULE_EPOCHS, blockReward),
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
    "SELECT mint, symbol, status, reserve_remaining, reserve_total, reward_per_block, next_block_at, next_epoch_at, synced_at FROM tokens WHERE mint = ?1",
  )
    .bind(mint)
    .first<MineTokenRow>();
}

/**
 * Loads (and on first touch creates) a mine's accounting state.
 *
 * The block cursor is anchored at first touch rather than back-dated: the off-chain index starts
 * accounting when it starts existing, so no reward is invented for a period nobody tracked.
 */
export async function loadMineState(env: RuntimeEnv, mint: string, now: number): Promise<MineState | null> {
  const existing = await env.DB.prepare("SELECT * FROM mine_reward_state WHERE mint = ?1")
    .bind(mint)
    .first<MineStateRow>();
  if (existing) return rowToMineState(existing);

  const token = await loadMineToken(env, mint);
  if (!token) return null;
  const initialReserve = BigInt(Math.max(0, Math.round(token.reserve_total)));
  const remainingReserve = BigInt(Math.max(0, Math.round(token.reserve_remaining)));
  const rewardPerBlock = BigInt(Math.max(0, Math.round(token.reward_per_block)));
  const status: MineStatus =
    token.status === "FULLY_MINED" || remainingReserve <= 0n ? "FULLY_MINED" : "MINING_ACTIVE";
  // A mine synced from chain already has a program-side accounting authority.
  const authority: MineAuthority = env.DIGGO_PROGRAM_ID && token.synced_at > 0 ? "ONCHAIN_INDEXED" : "OFFCHAIN";
  const epochEndsAt = token.next_epoch_at > now ? token.next_epoch_at : now + NOMINAL_EPOCH_LENGTH_SECONDS;

  await env.DB.prepare(
    `INSERT OR IGNORE INTO mine_reward_state
       (mint, reward_index, last_block, remaining_reserve, initial_reserve, epoch, status,
        total_eligible_power, reward_per_block, committed, dust_scaled, block_interval,
        epoch_length, epoch_ends_at, authority, updated_at)
     VALUES (?1, '0', ?2, ?3, ?4, 0, ?5, '0', ?6, '0', '0', ?7, ?8, ?9, ?10, ?2)`,
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
    )
    .run();

  const created = await env.DB.prepare("SELECT * FROM mine_reward_state WHERE mint = ?1")
    .bind(mint)
    .first<MineStateRow>();
  return created ? rowToMineState(created) : null;
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
       updated_at = ?11
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
  const state = await loadMineState(env, mint, upTo);
  if (!state) return null;
  const wasFullyMined = state.status === "FULLY_MINED";
  if (state.status === "FULLY_MINED" || state.lastBlock <= 0) {
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
 * Arms (or re-arms) a position at the mine's current index: no retroactive credit.
 *
 * The stored activation instant is the later of the activation the caller asked for and the
 * mine's current block cursor. Both are already true of a freshly armed position - its index
 * cursor starts at the mine's cursor, so no block at or before it can ever be credited - and
 * keeping them equal is what makes creditedBlockCount() exact for a crew that switched mines
 * mid-window (the position keeps the original window end but starts earning on this mine now).
 */
export async function armPosition(
  env: RuntimeEnv,
  wallet: string,
  mint: string,
  power: bigint,
  activatedAt: number,
  activeUntil: number,
  now: number,
): Promise<void> {
  const index = await env.DB.prepare("SELECT reward_index, last_block FROM mine_reward_state WHERE mint = ?1")
    .bind(mint)
    .first<{ reward_index: string; last_block: number }>();
  const armedAt = Math.max(activatedAt, index?.last_block ?? 0);
  await env.DB.prepare(
    `INSERT INTO mining_positions
       (wallet, mint, assigned_power, last_reward_index, pending_reward, paused, activated_at, active_until, claim_seq, updated_at)
     VALUES (?1, ?2, ?3, ?4, '0', 0, ?5, ?6, 0, ?7)
     ON CONFLICT(wallet, mint) DO UPDATE SET
       assigned_power = excluded.assigned_power,
       last_reward_index = excluded.last_reward_index,
       paused = 0,
       activated_at = excluded.activated_at,
       active_until = excluded.active_until,
       updated_at = excluded.updated_at`,
  )
    .bind(
      wallet,
      mint,
      (power > 0n ? power : 0n).toString(),
      big(index?.reward_index).toString(),
      armedAt,
      activeUntil,
      now,
    )
    .run();
  await adjustMinePower(env, mint, Number(power), now);
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
 */
export async function settlePositionAt(
  env: RuntimeEnv,
  wallet: string,
  mint: string,
  now: number,
  options: { releasePower?: boolean } = {},
): Promise<PositionSettlement | null> {
  const releasePower = options.releasePower ?? false;
  const advance = await advanceMineTo(env, mint, now);
  if (!advance) return null;
  const row = await loadPositionRow(env, wallet, mint);
  if (!row) return null;

  const snapshot = rowToPositionSnapshot(row);
  let settled = 0n;
  let forfeited = 0n;
  let released = false;

  if (snapshot.assignedPower > 0n) {
    const outcome = settlePosition(toRewardIndexState(advance.state), toMiningPosition(mint, snapshot));
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
 */
export async function reconcileArmedPosition(env: RuntimeEnv, row: PlayerRow, now: number): Promise<boolean> {
  if (activationStateOf(row, now) !== "ACTIVE" || !row.active_mint) return false;
  const power = BigInt(crewPower(crewLevelsOf(row)));
  const position = await loadPositionRow(env, row.wallet, row.active_mint);
  const armed = big(position?.assigned_power ?? "0");
  if (position && armed === power && position.active_until === row.activation_expires_at) return false;

  const token = await loadMineToken(env, row.active_mint);
  if (!token || token.status === "FULLY_MINED") return false;

  await advanceMineTo(env, row.active_mint, now, { exclusive: true });
  if (armed > 0n) await adjustMinePower(env, row.active_mint, -Number(armed), now);
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

  const nonce = crypto.randomUUID();
  const message = [
    "Claim Diggo mining reward",
    `Wallet: ${wallet}`,
    `Reward: ${claim.id}`,
    `Nonce: ${nonce}`,
    "This request does not trigger a blockchain transaction.",
  ].join("\n");
  await storeChallenge(env, `claim:challenge:${nonce}`, { wallet, message });
  return json({
    nonce,
    message,
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

  // The breaker is a hard, auditable halt, checked before any risk decision (spec 65).
  if (await isBreakerOpen(env, "claims")) {
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
  // again only once the hold is lifted, which is what the release step below does.
  if (gate.rewardState === "HELD" || gate.rewardState === "UNDER_REVIEW") {
    await env.DB.prepare(
      "UPDATE reward_claims SET status = 'HELD' WHERE id = ?1 AND wallet = ?2 AND status IN ('ELIGIBLE', 'PENDING')",
    )
      .bind(body.rewardId, wallet)
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

  const challengeKey = `claim:challenge:${body.nonce}`;
  const challenge = await loadChallenge(env, challengeKey);
  if (!challenge || challenge.wallet !== wallet) {
    await recordActivity(env, { wallet, request, action: "claim_reward", outcome: "failed_challenge" });
    return apiError("Challenge expired", 401);
  }
  if (!challenge.message.includes(`Reward: ${body.rewardId}`)) {
    await recordActivity(env, { wallet, request, action: "claim_reward", outcome: "failed_challenge" });
    return apiError("Challenge does not match this reward", 401);
  }
  if (!verifyWalletSignature(wallet, challenge.message, body.signature)) {
    await recordActivity(env, { wallet, request, action: "claim_reward", outcome: "failed_challenge" });
    return apiError("Invalid wallet signature", 401);
  }
  await env.TOKEN_CACHE.delete(challengeKey);

  const now = Math.floor(Date.now() / 1_000);
  // Recovery path for a claim parked while the account was under review.
  await env.DB.prepare("UPDATE reward_claims SET status = 'ELIGIBLE' WHERE id = ?1 AND wallet = ?2 AND status = 'HELD'")
    .bind(body.rewardId, wallet)
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

export async function markClaimPaid(env: RuntimeEnv, claimId: string, txSignature: string): Promise<boolean> {
  const result = await env.DB.prepare(
    "UPDATE reward_claims SET tx_signature = ?1 WHERE id = ?2 AND status = 'CLAIMED' AND tx_signature IS NULL",
  )
    .bind(txSignature, claimId)
    .run();
  return result.meta.changes === 1;
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
 * against chain and only then recorded through markClaimPaid.
 */
export async function settleRewardClaim(
  env: RuntimeEnv,
  event: RewardClaimQueueEvent,
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
    if (!(await verifyUserSignedPayout(env, event.txSignature, row))) {
      await metric(env, "mining.claim_payout_unverified", 1, { mint: row.mint });
      console.error(
        JSON.stringify({ event: "mining.claim_payout_unverified", claimId, signature: event.txSignature }),
      );
      return done("ignored", "unverified_signature", claimPayoutView(row));
    }
    if (!(await markClaimPaid(env, claimId, event.txSignature))) {
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

/**
 * True when signature is a confirmed, successful transaction to the Diggo program that this wallet
 * signed.
 *
 * Deliberately not a full instruction decode: the program is authoritative for whether a claim was
 * paid, and the recorded signature is a pointer for the player and for operators. What the check
 * has to prevent is a client marking a reward paid with an unrelated or failed signature, which
 * would strand that player's own reward. Anything unreadable counts as unverified, so a flaky RPC
 * can never turn a forged report into a recorded payout.
 */
async function verifyUserSignedPayout(
  env: RuntimeEnv,
  signature: string,
  row: RewardClaimRow,
): Promise<boolean> {
  if (!env.DIGGO_PROGRAM_ID) return false;
  try {
    const rpc = getChainRpc(env);
    const transaction = await rpc
      .getTransaction(signature as never, {
        commitment: "confirmed",
        encoding: "jsonParsed",
        maxSupportedTransactionVersion: 0,
      })
      .send();
    if (!transaction || transaction.meta?.err) return false;
    const keys = transaction.transaction.message.accountKeys as readonly {
      pubkey?: unknown;
      signer?: boolean;
    }[];
    const walletSigned = keys.some((key) => String(key.pubkey) === row.wallet && key.signer === true);
    const touchedProgram = keys.some((key) => String(key.pubkey) === env.DIGGO_PROGRAM_ID);
    return walletSigned && touchedProgram;
  } catch (error) {
    console.error(
      JSON.stringify({ event: "mining.claim_verify_failed", claimId: row.id, error: String(error) }),
    );
    return false;
  }
}
