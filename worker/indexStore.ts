/**
 * Every D1 write the indexer makes.
 *
 * Keeping them in one module is deliberate: it is the complete list of what the worker can
 * change, and reviewing it should be enough to see that nothing in it decides anything. Each
 * function copies fields out of an already-decoded program account; none of them computes a
 * balance, a power, a rarity or a payout.
 */
import {
  type DecodedCoin,
  type DecodedGlobalBudget,
  type DecodedLiquidityPool,
  type DecodedMiningPosition,
  type DecodedPlayerAccount,
  type DecodedProtocolConfig,
  type DecodedSponsorEvent,
  type DecodedSponsorGrant,
  type DecodedSponsorVault,
  baseUnitsToWhole,
  bytesToHex,
  coinStatusWireCode,
  lamportsToSol,
} from "./v2/program";
import type { RuntimeEnv } from "./env";
import { spotPriceLamports, venueLiquidityLamports, venueOf } from "./v2/market";

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}

/** The KV key the public token list is cached under. Bumped when its shape changes. */
export const TOKEN_CACHE_KEY = "coins:v2:1000";

// --- bookkeeping ---------------------------------------------------------------------------

export async function readCursor(
  env: RuntimeEnv,
  kind: string,
): Promise<{ cursor: string; slot: number }> {
  const row = await env.DB.prepare("SELECT cursor, slot FROM indexer_cursors WHERE kind = ?1")
    .bind(kind)
    .first<{ cursor: string; slot: number }>();
  return { cursor: row?.cursor ?? "", slot: row?.slot ?? 0 };
}

export async function writeCursor(
  env: RuntimeEnv,
  kind: string,
  cursor: string,
  slot: number,
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO indexer_cursors (kind, cursor, slot, updated_at) VALUES (?1, ?2, ?3, ?4)" +
      " ON CONFLICT(kind) DO UPDATE SET cursor = excluded.cursor, slot = excluded.slot," +
      " updated_at = excluded.updated_at",
  )
    .bind(kind, cursor, slot, nowSeconds())
    .run();
}

export interface IndexerRunResult {
  accounts: number;
  events: number;
  detail?: string;
}

export async function beginRun(env: RuntimeEnv, kind: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO indexer_runs (id, kind, started_at, status) VALUES (?1, ?2, ?3, 'RUNNING')",
  )
    .bind(id, kind, nowSeconds())
    .run();
  return id;
}

export async function finishRun(
  env: RuntimeEnv,
  id: string,
  result: IndexerRunResult,
  status = "OK",
): Promise<void> {
  await env.DB.prepare(
    "UPDATE indexer_runs SET finished_at = ?1, accounts = ?2, events = ?3, status = ?4," +
      " detail = ?5 WHERE id = ?6",
  )
    .bind(nowSeconds(), result.accounts, result.events, status, result.detail ?? null, id)
    .run();
}

/** One advisory alert. It can inform support and rate limit an HTTP surface; that is all. */
export async function recordAdvisory(
  env: RuntimeEnv,
  alert: { kind: string; subject?: string | null; severity?: string; detail: string },
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO advisory_alerts (id, kind, subject, severity, detail, created_at)" +
      " VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  )
    .bind(
      crypto.randomUUID(),
      alert.kind,
      alert.subject ?? null,
      alert.severity ?? "INFO",
      alert.detail,
      nowSeconds(),
    )
    .run();
}

/** JSON with bigints as strings and byte arrays as hex, so a payload is always re-readable. */
export function jsonSafe(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    typeof item === "bigint"
      ? item.toString()
      : item instanceof Uint8Array
        ? bytesToHex(item)
        : item,
  );
}

// --- account mirrors -----------------------------------------------------------------------

/** The profile row that exists before a wallet ever activates. Idempotent. */
export async function ensurePlayerRow(
  env: RuntimeEnv,
  wallet: string,
  createdAt: number,
): Promise<void> {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO players (wallet, created_at, risk_state, risk_score)" +
      " VALUES (?1, ?2, 'NORMAL', 0)",
  )
    .bind(wallet, createdAt)
    .run();
}

/** Mirrors one PlayerAccount PDA and the profile columns denormalised from it. */
export async function writePlayerAccount(
  env: RuntimeEnv,
  player: string,
  wallet: string,
  account: DecodedPlayerAccount,
  slot: bigint,
): Promise<void> {
  const levels = account.crewLevels;
  await env.DB.prepare(
    "INSERT INTO player_accounts (" +
      "player, wallet, created_slot, created_at, active_until, last_activation_at, streak," +
      " longest_streak, valid_activations, active_days, last_active_day, streak_freezes," +
      " miners_level, drills_level, carts_level, foreman_level, storage_level," +
      " ore_balance, ore_earned, ore_spent, ore_accrued_at, active_mine," +
      " day_index, week_index, spent_day_lamports, spent_week_lamports, roll_window, roll_count," +
      " last_roll_at, bond_lamports, bond_locked_at, unbond_available_at, bond_source," +
      " bond_sponsor_vault, version, account_slot, indexed_at" +
      ") VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22," +
      "?23,?24,?25,?26,?27,?28,?29,?30,?31,?32,?33,?34,?35,?36,?37)" +
      " ON CONFLICT(player) DO UPDATE SET" +
      " wallet = excluded.wallet, created_slot = excluded.created_slot," +
      " created_at = excluded.created_at, active_until = excluded.active_until," +
      " last_activation_at = excluded.last_activation_at, streak = excluded.streak," +
      " longest_streak = excluded.longest_streak, valid_activations = excluded.valid_activations," +
      " active_days = excluded.active_days, last_active_day = excluded.last_active_day," +
      " streak_freezes = excluded.streak_freezes, miners_level = excluded.miners_level," +
      " drills_level = excluded.drills_level, carts_level = excluded.carts_level," +
      " foreman_level = excluded.foreman_level, storage_level = excluded.storage_level," +
      " ore_balance = excluded.ore_balance, ore_earned = excluded.ore_earned," +
      " ore_spent = excluded.ore_spent, ore_accrued_at = excluded.ore_accrued_at," +
      " active_mine = excluded.active_mine, day_index = excluded.day_index," +
      " week_index = excluded.week_index, spent_day_lamports = excluded.spent_day_lamports," +
      " spent_week_lamports = excluded.spent_week_lamports, roll_window = excluded.roll_window," +
      " roll_count = excluded.roll_count, last_roll_at = excluded.last_roll_at," +
      " bond_lamports = excluded.bond_lamports, bond_locked_at = excluded.bond_locked_at," +
      " unbond_available_at = excluded.unbond_available_at, bond_source = excluded.bond_source," +
      " bond_sponsor_vault = excluded.bond_sponsor_vault, version = excluded.version," +
      " account_slot = excluded.account_slot, indexed_at = excluded.indexed_at",
  )
    .bind(
      player,
      wallet,
      account.createdSlot.toString(),
      Number(account.createdAt),
      Number(account.activeUntil),
      Number(account.lastActivationAt),
      account.streak,
      account.longestStreak,
      account.validActivations,
      account.activeDays,
      account.lastActiveDay,
      account.streakFreezes,
      levels[0] ?? 0,
      levels[1] ?? 0,
      levels[2] ?? 0,
      levels[3] ?? 0,
      levels[4] ?? 0,
      account.oreBalance.toString(),
      account.oreEarned.toString(),
      account.oreSpent.toString(),
      Number(account.oreAccruedAt),
      account.activeMine,
      account.dayIndex,
      account.weekIndex,
      account.spentDayLamports.toString(),
      account.spentWeekLamports.toString(),
      account.rollWindow,
      account.rollCount,
      Number(account.lastRollAt),
      account.bondLamports.toString(),
      Number(account.bondLockedAt),
      Number(account.unbondAvailableAt),
      account.bondSourceByte,
      account.bondSponsorVault,
      account.version,
      Number(slot),
      nowSeconds(),
    )
    .run();
  await env.DB.prepare(
    "UPDATE players SET indexed_at = ?1, active_mint = ?2, last_activation_at = ?3," +
      " activation_expires_at = ?4, ore_balance = ?5, streak = ?6, streak_freezes = ?7," +
      " active_days = ?8 WHERE wallet = ?9",
  )
    .bind(
      nowSeconds(),
      account.activeMine,
      Number(account.lastActivationAt),
      Number(account.activeUntil),
      account.oreBalance.toString(),
      account.streak,
      account.streakFreezes,
      account.activeDays,
      wallet,
    )
    .run();
}

/** Mirrors one MiningPosition PDA. Its identity comes from the caller; the account stores none. */
export async function writePosition(
  env: RuntimeEnv,
  position: string,
  coin: string,
  owner: string,
  account: DecodedMiningPosition,
  slot: bigint,
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO mining_positions_v2 (" +
      "position, coin, owner, assigned_power, last_reward_index, pending_reward, tranche," +
      " created_slot, account_slot, indexed_at" +
      ") VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)" +
      " ON CONFLICT(position) DO UPDATE SET coin = excluded.coin, owner = excluded.owner," +
      " assigned_power = excluded.assigned_power," +
      " last_reward_index = excluded.last_reward_index," +
      " pending_reward = excluded.pending_reward, tranche = excluded.tranche," +
      " created_slot = excluded.created_slot, account_slot = excluded.account_slot," +
      " indexed_at = excluded.indexed_at",
  )
    .bind(
      position,
      coin,
      owner,
      account.assignedPower.toString(),
      account.lastRewardIndex.toString(),
      account.pendingReward.toString(),
      account.trancheByte,
      account.createdSlot.toString(),
      Number(slot),
      nowSeconds(),
    )
    .run();
}

export async function deletePosition(env: RuntimeEnv, position: string): Promise<void> {
  await env.DB.prepare("DELETE FROM mining_positions_v2 WHERE position = ?1").bind(position).run();
}

/** The slug a coin is served under. Derived from the mint and creator, never from user input. */
export function coinSlug(creator: string, mint: string): string {
  return `coin-${mint.slice(0, 4).toLowerCase()}-${creator.slice(0, 4).toLowerCase()}`;
}

/** Mirrors one Coin PDA and rewrites the public read model derived from it. */
export async function writeCoin(
  env: RuntimeEnv,
  coinAddress: string,
  mint: string,
  account: DecodedCoin,
  slot: bigint,
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO coins (" +
      "coin, mint, slug, creator, vault, status, total_supply, reserve_remaining," +
      " discovery_remaining, outstanding_claims, cumulative_distributed, total_power," +
      " bonded_power, starter_power, bonded_index, starter_index, current_block_reward," +
      " block_interval," +
      " next_block_at, epoch_index, epoch_length, epoch_ends_at, epoch_ends_slot, reduction_bps," +
      " minimum_reward, token_reserve, sol_reserve, virtual_sol_reserve, graduation_target," +
      " creator_fee_claimable, platform_fee_claimable, creator_fee_bps, platform_fee_bps," +
      " curve_mining_cap, curve_mining_mined, curve_mining_unpaid, curve_mining_block_reward," +
      " curve_mining_open, graduated, curve_phase_ends_at, discovery_reserve_total," +
      " discovery_epoch_budget, discovery_epoch_spent, discovery_epoch_index, discovery_paused," +
      " twap_cum_price_lamports_per_unit, twap_last_update_slot, twap_last_price, twap_window_slot, twap_window_cum," +
      " epoch_seed, epoch_seed_epoch, epoch_seed_target_slot, epoch_seed_recorded_slot," +
      " version, account_slot, indexed_at" +
      ") VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22," +
      "?23,?24,?25,?26,?27,?28,?29,?30,?31,?32,?33,?34,?35,?36,?37,?38,?39,?40,?41,?42,?43,?44,?45," +
      "?46,?47,?48,?49,?50,?51,?52,?53,?54,?55,?56,?57)" +
      " ON CONFLICT(coin) DO UPDATE SET mint = excluded.mint, creator = excluded.creator," +
      " vault = excluded.vault, status = excluded.status," +
      " total_supply = excluded.total_supply," +
      " reserve_remaining = excluded.reserve_remaining," +
      " discovery_remaining = excluded.discovery_remaining," +
      " outstanding_claims = excluded.outstanding_claims," +
      " cumulative_distributed = excluded.cumulative_distributed," +
      " total_power = excluded.total_power, bonded_power = excluded.bonded_power," +
      " starter_power = excluded.starter_power, bonded_index = excluded.bonded_index," +
      " starter_index = excluded.starter_index," +
      " current_block_reward = excluded.current_block_reward," +
      " block_interval = excluded.block_interval, next_block_at = excluded.next_block_at," +
      " epoch_index = excluded.epoch_index, epoch_length = excluded.epoch_length," +
      " epoch_ends_at = excluded.epoch_ends_at, epoch_ends_slot = excluded.epoch_ends_slot," +
      " reduction_bps = excluded.reduction_bps, minimum_reward = excluded.minimum_reward," +
      " token_reserve = excluded.token_reserve, sol_reserve = excluded.sol_reserve," +
      " virtual_sol_reserve = excluded.virtual_sol_reserve," +
      " graduation_target = excluded.graduation_target," +
      " creator_fee_claimable = excluded.creator_fee_claimable," +
      " platform_fee_claimable = excluded.platform_fee_claimable," +
      " creator_fee_bps = excluded.creator_fee_bps," +
      " platform_fee_bps = excluded.platform_fee_bps," +
      " curve_mining_cap = excluded.curve_mining_cap," +
      " curve_mining_mined = excluded.curve_mining_mined," +
      " curve_mining_unpaid = excluded.curve_mining_unpaid," +
      " curve_mining_block_reward = excluded.curve_mining_block_reward," +
      " curve_mining_open = excluded.curve_mining_open, graduated = excluded.graduated," +
      " curve_phase_ends_at = excluded.curve_phase_ends_at," +
      " discovery_reserve_total = excluded.discovery_reserve_total," +
      " discovery_epoch_budget = excluded.discovery_epoch_budget," +
      " discovery_epoch_spent = excluded.discovery_epoch_spent," +
      " discovery_epoch_index = excluded.discovery_epoch_index," +
      " discovery_paused = excluded.discovery_paused," +
      " twap_cum_price_lamports_per_unit = excluded.twap_cum_price_lamports_per_unit," +
      " twap_last_update_slot = excluded.twap_last_update_slot, twap_last_price = excluded.twap_last_price," +
      " twap_window_slot = excluded.twap_window_slot, twap_window_cum = excluded.twap_window_cum," +
      " epoch_seed = excluded.epoch_seed," +
      " epoch_seed_epoch = excluded.epoch_seed_epoch," +
      " epoch_seed_target_slot = excluded.epoch_seed_target_slot," +
      " epoch_seed_recorded_slot = excluded.epoch_seed_recorded_slot," +
      " version = excluded.version, account_slot = excluded.account_slot," +
      " indexed_at = excluded.indexed_at",
  )
    .bind(
      coinAddress,
      mint,
      coinSlug(account.creator, mint),
      account.creator,
      account.vault,
      coinStatusWireCode(account.status),
      account.totalSupply.toString(),
      account.reserveRemaining.toString(),
      account.discoveryRemaining.toString(),
      account.outstandingClaims.toString(),
      account.cumulativeDistributed.toString(),
      account.totalPower.toString(),
      account.bondedPower.toString(),
      account.starterPower.toString(),
      account.bondedIndex.toString(),
      account.starterIndex.toString(),
      account.currentBlockReward.toString(),
      account.blockInterval,
      Number(account.nextBlockAt),
      account.epochIndex,
      account.epochLength,
      Number(account.epochEndsAt),
      account.epochEndsSlot.toString(),
      account.reductionBps,
      account.minimumReward.toString(),
      account.tokenReserve.toString(),
      account.solReserve.toString(),
      account.virtualSolReserve.toString(),
      account.graduationTarget.toString(),
      account.creatorFeeClaimable.toString(),
      account.platformFeeClaimable.toString(),
      account.creatorFeeBps,
      account.platformFeeBps,
      account.curveMiningCap.toString(),
      account.curveMiningMined.toString(),
      account.curveMiningUnpaid.toString(),
      account.curveMiningBlockReward.toString(),
      account.curveMiningOpen ? 1 : 0,
      account.graduated ? 1 : 0,
      Number(account.curvePhaseEndsAt),
      account.discoveryReserveTotal.toString(),
      account.discoveryEpochBudget.toString(),
      account.discoveryEpochSpent.toString(),
      account.discoveryEpochIndex,
      account.discoveryPaused ? 1 : 0,
      account.twapCumPriceLamportsPerUnit.toString(),
      account.twapLastUpdateSlot.toString(),
      account.twapLastPrice.toString(),
      account.twapWindowSlot.toString(),
      account.twapWindowCum.toString(),
      bytesToHex(account.epochSeed),
      account.epochSeedEpoch,
      account.epochSeedTargetSlot.toString(),
      account.epochSeedRecordedSlot.toString(),
      account.version,
      Number(slot),
      nowSeconds(),
    )
    .run();
  // The public read model is written by the caller, which has the display metadata and the 24h
  // window in hand. Keeping the two writes separate is what stops a raw update from silently
  // leaving a stale conversion behind: the caller always does both.
}

export interface TokenMetrics {
  change24h: number | null;
  change24hAt: number;
  volume24hUsd: number;
  trades24h: number;
}

/**
 * The public read model. Every raw value is copied from `coins`; the display conversions are
 * recomputed here so a stale conversion cannot survive a raw update, and the two are never
 * stored in the same column.
 */
export async function writeTokenRow(
  env: RuntimeEnv,
  coinAddress: string,
  mint: string,
  account: DecodedCoin,
  pool: DecodedLiquidityPool | null,
  decimals: number,
  metrics: TokenMetrics,
  display: { name: string; symbol: string; description: string; imageKey: string | null; solUsd: number; usdPriceAvailable: boolean },
): Promise<void> {
  const existing = await env.DB.prepare("SELECT created_at FROM tokens WHERE mint = ?1")
    .bind(mint)
    .first<{ created_at: number }>();
  const priceLamports = spotPriceLamports(account, pool, decimals);
  const priceSol = priceLamports / 1_000_000_000;
  const liquidityLamports = venueLiquidityLamports(account, pool);
  const liquiditySol = lamportsToSol(liquidityLamports);
  const totalSupplyWhole = baseUnitsToWhole(account.totalSupply, decimals);
  const now = nowSeconds();
  await env.DB.prepare(
    "INSERT INTO tokens (" +
      "mint, coin, slug, name, symbol, description, creator, image_key, decimals, status," +
      " price_sol, price_usd, market_cap_usd, liquidity_sol, liquidity_usd, reserve_remaining," +
      " reserve_total, discovery_reserve_remaining, discovery_reserve_total, reward_per_block," +
      " network_power, bonded_power, starter_power, venue, next_block_at, next_epoch_at," +
      " epoch_index, epoch_seed_epoch, epoch_seed_committed, graduated, discovery_paused, usd_price_available," +
      " change_24h, change_24h_at, volume_24h_usd, trades_24h, synced_at, created_at" +
      ") VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22," +
      "?23,?24,?25,?26,?27,?28,?29,?30,?31,?32,?33,?34,?35,?36,?37,?38)" +
      " ON CONFLICT(mint) DO UPDATE SET coin = excluded.coin, name = excluded.name," +
      " symbol = excluded.symbol, creator = excluded.creator, decimals = excluded.decimals," +
      " status = excluded.status, price_sol = excluded.price_sol," +
      " price_usd = excluded.price_usd, market_cap_usd = excluded.market_cap_usd," +
      " liquidity_sol = excluded.liquidity_sol, liquidity_usd = excluded.liquidity_usd," +
      " reserve_remaining = excluded.reserve_remaining, reserve_total = excluded.reserve_total," +
      " discovery_reserve_remaining = excluded.discovery_reserve_remaining," +
      " discovery_reserve_total = excluded.discovery_reserve_total," +
      " reward_per_block = excluded.reward_per_block," +
      " network_power = excluded.network_power, bonded_power = excluded.bonded_power," +
      " starter_power = excluded.starter_power, venue = excluded.venue," +
      " next_block_at = excluded.next_block_at, next_epoch_at = excluded.next_epoch_at," +
      " epoch_index = excluded.epoch_index, epoch_seed_epoch = excluded.epoch_seed_epoch," +
      " epoch_seed_committed = excluded.epoch_seed_committed," +
      " graduated = excluded.graduated, discovery_paused = excluded.discovery_paused," +
      " usd_price_available = excluded.usd_price_available," +
      " change_24h = excluded.change_24h, change_24h_at = excluded.change_24h_at," +
      " volume_24h_usd = excluded.volume_24h_usd, trades_24h = excluded.trades_24h," +
      " synced_at = excluded.synced_at",
  )
    .bind(
      mint,
      coinAddress,
      coinSlug(account.creator, mint),
      display.name,
      display.symbol,
      display.description,
      account.creator,
      display.imageKey,
      decimals,
      coinStatusWireCode(account.status),
      priceSol,
      priceSol * display.solUsd,
      priceSol * display.solUsd * totalSupplyWhole,
      liquiditySol,
      liquiditySol * display.solUsd,
      baseUnitsToWhole(account.reserveRemaining, decimals),
      baseUnitsToWhole(account.reserveRemaining + account.cumulativeDistributed, decimals),
      baseUnitsToWhole(account.discoveryRemaining, decimals),
      baseUnitsToWhole(account.discoveryReserveTotal, decimals),
      baseUnitsToWhole(account.currentBlockReward, decimals),
      Number(account.totalPower),
      Number(account.bondedPower),
      Number(account.starterPower),
      venueOf(account, pool),
      Number(account.nextBlockAt),
      Number(account.epochEndsAt),
      account.epochIndex,
      account.epochSeedEpoch,
      account.epochSeedRecordedSlot > 0n ? 1 : 0,
      account.graduated ? 1 : 0,
      account.discoveryPaused ? 1 : 0,
      display.usdPriceAvailable ? 1 : 0,
      metrics.change24h ?? 0,
      metrics.change24hAt,
      metrics.volume24hUsd,
      metrics.trades24h,
      now,
      existing?.created_at ?? now,
    )
    .run();
  await env.TOKEN_CACHE.delete(TOKEN_CACHE_KEY);
}

export async function writePool(
  env: RuntimeEnv,
  poolAddress: string,
  account: DecodedLiquidityPool,
  slot: bigint,
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO pools (pool, coin, mint, token_vault, sol_vault, token_reserve, sol_reserve," +
      " graduated_at, cum_price_lamports_per_unit, last_update_slot, account_slot, indexed_at)" +
      " VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)" +
      " ON CONFLICT(pool) DO UPDATE SET coin = excluded.coin, mint = excluded.mint," +
      " token_vault = excluded.token_vault, sol_vault = excluded.sol_vault," +
      " token_reserve = excluded.token_reserve, sol_reserve = excluded.sol_reserve," +
      " graduated_at = excluded.graduated_at," +
      " cum_price_lamports_per_unit = excluded.cum_price_lamports_per_unit," +
      " last_update_slot = excluded.last_update_slot, account_slot = excluded.account_slot," +
      " indexed_at = excluded.indexed_at",
  )
    .bind(
      poolAddress,
      account.coin,
      account.mint,
      account.tokenVault,
      account.solVault,
      account.tokenReserve.toString(),
      account.solReserve.toString(),
      Number(account.graduatedAt),
      account.cumPriceLamportsPerUnit.toString(),
      account.lastUpdateSlot.toString(),
      Number(slot),
      nowSeconds(),
    )
    .run();
}

export async function writeProtocolConfig(
  env: RuntimeEnv,
  account: DecodedProtocolConfig,
  slot: bigint,
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO protocol_config (" +
      "id, authority, treasury, crank_pool, creator_fee_bps, platform_fee_bps, crank_pool_fee_bps," +
      " bond_lamports, bond_cooldown_seconds, starter_efficiency_bps, starter_tranche_bps," +
      " discovery_daily_cap_lamports, discovery_weekly_cap_lamports," +
      " discovery_global_daily_cap_lamports, discovery_epoch_budget_lamports, paused_flags," +
      " paused_until, payload, account_slot, indexed_at" +
      ") VALUES (1,?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)" +
      " ON CONFLICT(id) DO UPDATE SET authority = excluded.authority," +
      " treasury = excluded.treasury, crank_pool = excluded.crank_pool," +
      " creator_fee_bps = excluded.creator_fee_bps," +
      " platform_fee_bps = excluded.platform_fee_bps," +
      " crank_pool_fee_bps = excluded.crank_pool_fee_bps," +
      " bond_lamports = excluded.bond_lamports," +
      " bond_cooldown_seconds = excluded.bond_cooldown_seconds," +
      " starter_efficiency_bps = excluded.starter_efficiency_bps," +
      " starter_tranche_bps = excluded.starter_tranche_bps," +
      " discovery_daily_cap_lamports = excluded.discovery_daily_cap_lamports," +
      " discovery_weekly_cap_lamports = excluded.discovery_weekly_cap_lamports," +
      " discovery_global_daily_cap_lamports = excluded.discovery_global_daily_cap_lamports," +
      " discovery_epoch_budget_lamports = excluded.discovery_epoch_budget_lamports," +
      " paused_flags = excluded.paused_flags, paused_until = excluded.paused_until," +
      " payload = excluded.payload, account_slot = excluded.account_slot," +
      " indexed_at = excluded.indexed_at",
  )
    .bind(
      account.authority,
      account.treasury,
      account.crankPool,
      account.creatorFeeBps,
      account.platformFeeBps,
      account.crankPoolFeeBps,
      account.bondLamports.toString(),
      Number(account.bondCooldownSeconds),
      account.starterEfficiencyBps,
      account.starterTrancheBps,
      account.discoveryDailyCapLamports.toString(),
      account.discoveryWeeklyCapLamports.toString(),
      account.discoveryGlobalDailyCapLamports.toString(),
      account.discoveryEpochBudgetLamports.toString(),
      account.pausedFlags,
      Number(account.pausedUntil),
      jsonSafe(account),
      Number(slot),
      nowSeconds(),
    )
    .run();
}

export async function writeSponsorVault(
  env: RuntimeEnv,
  vault: string,
  account: DecodedSponsorVault,
  slot: bigint,
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO sponsor_vaults (vault, sponsor_owner, event_count, total_funded, total_spent," +
      " total_withdrawn, account_slot, indexed_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)" +
      " ON CONFLICT(vault) DO UPDATE SET sponsor_owner = excluded.sponsor_owner," +
      " event_count = excluded.event_count, total_funded = excluded.total_funded," +
      " total_spent = excluded.total_spent, total_withdrawn = excluded.total_withdrawn," +
      " account_slot = excluded.account_slot, indexed_at = excluded.indexed_at",
  )
    .bind(
      vault,
      account.sponsorOwner,
      account.eventCount,
      account.totalFunded.toString(),
      account.totalSpent.toString(),
      account.totalWithdrawn.toString(),
      Number(slot),
      nowSeconds(),
    )
    .run();
}

export async function writeSponsorEvent(
  env: RuntimeEnv,
  event: string,
  account: DecodedSponsorEvent,
  slot: bigint,
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO sponsor_events (event, vault, kind, kind_name, start_at, end_at," +
      " budget_lamports, spent_lamports, per_coin_limit_lamports, per_wallet_limit_lamports," +
      " paused, account_slot, indexed_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)" +
      " ON CONFLICT(event) DO UPDATE SET vault = excluded.vault, kind = excluded.kind," +
      " kind_name = excluded.kind_name, start_at = excluded.start_at, end_at = excluded.end_at," +
      " budget_lamports = excluded.budget_lamports, spent_lamports = excluded.spent_lamports," +
      " per_coin_limit_lamports = excluded.per_coin_limit_lamports," +
      " per_wallet_limit_lamports = excluded.per_wallet_limit_lamports, paused = excluded.paused," +
      " account_slot = excluded.account_slot, indexed_at = excluded.indexed_at",
  )
    .bind(
      event,
      account.vault,
      account.kind,
      account.kindName,
      Number(account.startAt),
      Number(account.endAt),
      account.budgetLamports.toString(),
      account.spentLamports.toString(),
      account.perCoinLimitLamports.toString(),
      account.perWalletLimitLamports.toString(),
      account.paused,
      Number(slot),
      nowSeconds(),
    )
    .run();
}

/**
 * Mirrors one SponsorGrant. Its event and subject are PDA seeds and are not stored in the
 * account, so they are passed in: the indexer knows them from the grant's own address when it
 * derived it, and leaves them blank when it swept the grant blind.
 */
export async function writeSponsorGrant(
  env: RuntimeEnv,
  grant: string,
  event: string,
  subject: string,
  account: DecodedSponsorGrant,
  slot: bigint,
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO sponsor_grants (grant, event, subject, spent_lamports, waived_fee_lamports," +
      " wallet_spent_lamports, created_slot, account_slot, indexed_at)" +
      " VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)" +
      " ON CONFLICT(grant) DO UPDATE SET event = excluded.event, subject = excluded.subject," +
      " spent_lamports = excluded.spent_lamports," +
      " waived_fee_lamports = excluded.waived_fee_lamports," +
      " wallet_spent_lamports = excluded.wallet_spent_lamports," +
      " created_slot = excluded.created_slot, account_slot = excluded.account_slot," +
      " indexed_at = excluded.indexed_at",
  )
    .bind(
      grant,
      event,
      subject,
      account.spentLamports.toString(),
      account.waivedFeeLamports.toString(),
      account.walletSpentLamports.toString(),
      account.createdSlot.toString(),
      Number(slot),
      nowSeconds(),
    )
    .run();
}

export async function writeGlobalBudget(
  env: RuntimeEnv,
  account: DecodedGlobalBudget,
  slot: bigint,
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO global_budgets (day_index, cap_lamports, spent_lamports, roll_count," +
      " settled_count, closed, account_slot, indexed_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)" +
      " ON CONFLICT(day_index) DO UPDATE SET cap_lamports = excluded.cap_lamports," +
      " spent_lamports = excluded.spent_lamports, roll_count = excluded.roll_count," +
      " settled_count = excluded.settled_count, closed = excluded.closed," +
      " account_slot = excluded.account_slot, indexed_at = excluded.indexed_at",
  )
    .bind(
      account.dayIndex,
      account.capLamports.toString(),
      account.spentLamports.toString(),
      account.rollCount,
      account.settledCount,
      account.closed,
      Number(slot),
      nowSeconds(),
    )
    .run();
}

/** Records one price observation. Display history only; no instruction reads it. */
export async function writePriceSample(
  env: RuntimeEnv,
  mint: string,
  priceSol: number,
  slot: bigint,
  retentionSeconds: number,
): Promise<void> {
  if (!(priceSol > 0)) return;
  const observedAt = nowSeconds();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO coin_price_samples (mint, observed_at, price_sol, slot) VALUES (?1,?2,?3,?4)" +
        " ON CONFLICT(mint, observed_at) DO UPDATE SET price_sol = excluded.price_sol," +
        " slot = excluded.slot",
    ).bind(mint, observedAt, priceSol, slot.toString()),
    env.DB.prepare("DELETE FROM coin_price_samples WHERE mint = ?1 AND observed_at < ?2").bind(
      mint,
      observedAt - retentionSeconds,
    ),
  ]);
}
