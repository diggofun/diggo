/**
 * The market side of the simulation: the block loop that drains a mine's Mining Reserve, the
 * discovery roll that drains a mine's Discovery Reserve, and the daily risk refresh.
 *
 * The block loop mirrors worker/mining.ts simulateAdvance: a position expires *before* the block
 * that lands on its active_until, an epoch reduction is applied before the block that crosses the
 * epoch boundary, and applyBlock caps the block reward at the remaining reserve. The discovery path
 * mirrors worker/discovery.ts rollDiscovery: one opportunity per wallet per window, spent win or
 * lose, account budget authorized before the roll, per-token budget after the target is known.
 */
import type { DiggoConfig } from "../../shared/config";
import { discoveryBudgetCheck, discoveryBudgetRemaining, discoveryEligibility, type DiscoveryUsage } from "../../shared/discovery";
import { applyBlock, epochReward, settlePosition } from "../../shared/rewardIndex";
import { assessRisk, mineTrust, type RiskSignals } from "../../shared/risk";
import { claimHoldApplies, enforcedRewardState, type RiskOpsConfig } from "../../shared/riskOps";
import { crewTier } from "../../shared/crew";
import { maturityBps } from "../../shared/ore";
import {
  capRarityByBudget,
  normalizedDiscoveryAmount,
  rarityTier,
  resolveRarity,
  rollDiscoveryRarity,
  tokenEligibilityScore,
  type TokenEligibilityInput,
} from "../../shared/rarity";
import {
  BLOCKS_PER_DAY,
  LANE,
  RISK_SAMPLE_WINDOW,
  clamp01,
  draw,
  stdev,
  sumDays,
  type DayEvent,
  type FarmRuntime,
  type MineRuntime,
  type SimPlayer,
} from "./state";
import { creditHeld, creditPaid, gateAllows } from "./world";
import type { SimOptions } from "./model";

// --- block loop ------------------------------------------------------------------------

export interface AdvanceContext {
  config: DiggoConfig;
  options: SimOptions;
  riskOps: RiskOpsConfig;
  /** Needed so a player's power can be moved off the mine that currently holds it. */
  mineByKey: Map<string, MineRuntime>;
  /** Only read by the debug power ledger check. */
  players: readonly SimPlayer[];
}

/** Sum of every player's armed power that is currently attributed to `mine`. */
function powerLedgerSum(context: AdvanceContext, mine: MineRuntime): bigint {
  let total = 0n;
  for (const player of context.players) {
    if (player.powerMine === mine.spec.key) total += player.powerArmed;
  }
  return total;
}

/**
 * Settles one armed position at the current index and releases its power, without advancing the
 * block grid. Used when a player leaves a mine and at the end of the horizon, so every position is
 * settled exactly once and the reserve audit balances.
 */
export function releaseArmedPosition(mine: MineRuntime, player: SimPlayer, context: AdvanceContext): void {
  if (player.powerArmed <= 0n) return;
  applyEvent(
    mine,
    { time: mine.cursor, kind: "expire", mineKey: mine.spec.key, power: 0n, windowEnd: mine.cursor, player },
    mine.cursor,
    context,
  );
  player.armedUntil = null;
  player.armedMine = null;
}

export function advanceMine(
  mine: MineRuntime,
  upTo: number,
  queue: DayEvent[],
  context: AdvanceContext,
): void {
  const { config, options } = context;
  if (mine.status === "FULLY_MINED") {
    // The grid has stopped, but queued events still have to be applied: an expire left unapplied
    // would keep a stale position alive, and the player's next arm would then debit power from a
    // mine that never held it, under-counting the new mine's power and over-paying everyone on it.
    for (const event of queue) applyEvent(mine, event, mine.cursor, context);
    return;
  }
  let index = 0;
  while (mine.cursor + options.blockIntervalSeconds <= upTo) {
    const blockTime = mine.cursor + options.blockIntervalSeconds;
    while (mine.epochEndsAt > 0 && blockTime >= mine.epochEndsAt) {
      // The epoch boundary is where the schedule steps down (spec 21). shared/rewardIndex.ts owns
      // the rule; the harness only supplies the mine's own state and its launch parameters.
      mine.rewardPerBlock = epochReward({
        reserveRemaining: mine.core.reserveRemaining,
        previousRewardPerBlock: mine.rewardPerBlock,
        epoch: mine.epoch + 1,
        epochLengthSeconds: options.epochLengthSeconds,
        blockIntervalSeconds: options.blockIntervalSeconds,
        targetLifetimeDays: mine.spec.lifetimeDays,
        config,
      });
      mine.epoch += 1;
      mine.epochEndsAt += options.epochLengthSeconds;
    }
    while (index < queue.length && queue[index].time <= blockTime) {
      applyEvent(mine, queue[index], blockTime, context);
      index += 1;
    }
    if (context.options.debugPower && mine.power !== powerLedgerSum(context, mine)) {
      console.log(
        `in-block power mismatch ${mine.spec.key} at ${blockTime}: aggregate ${mine.power} vs ledger ${powerLedgerSum(
          context,
          mine,
        )}`,
      );
    }
    const outcome = applyBlock(mine.core, mine.rewardPerBlock, mine.power, config);
    mine.core = outcome.state;
    mine.cursor = blockTime;
    mine.cappedTotal += outcome.capped;
    mine.distributedToday += Number(outcome.distributed);
    mine.distributed += outcome.distributed;
    if (outcome.fullyMined) {
      mine.status = "FULLY_MINED";
      mine.fullyMinedAt = blockTime;
      break;
    }
  }
}

function applyEvent(mine: MineRuntime, event: DayEvent, blockTime: number, context: AdvanceContext): void {
  const { config } = context;
  const player = event.player;
  mine.eventCounts[event.kind] += 1;
  // A position belongs to the mine whose index its cursor came from. Settling it against another
  // mine would read that mine's larger index as "earned since the last settle" and mint tokens the
  // reserve never released, so the owning mine is always the one that settles it.
  const owner = ownerMineOf(player, mine, context);
  if (player.position.paused && player.position.assignedPower > 0n) {
    owner.forfeitSettles[event.kind] += 1;
  }
  const settled = settlePosition(
    owner.core,
    // Never force the paused flag: a position that is still live has to earn when it is released,
    // and forcing it paused would book its whole accrued entitlement as a forfeit back to the old
    // mine's reserve. The position is settled exactly as stored, like releaseArmedPositions does.
    owner === mine ? { ...player.position, mineId: mine.spec.key } : player.position,
    config,
  );
  owner.core = settled.state;
  owner.forfeited += settled.forfeited;
  owner.settlementCount += 1;
  owner.settledToday += Number(settled.earned);
  owner.settledTotal += Number(settled.earned);
  // Attribute every settled token to the cohort that earned it, in every branch. Attributing only
  // on the expiry path hides exactly what a migrating wallet settles when it switches mines, which
  // is the path a farm uses most.
  if (player.cohort === "bot") owner.botTokens += Number(settled.earned);
  else owner.humanTokens += Number(settled.earned);
  if (event.kind === "arm") {
    let pending = settled.position.pendingReward;
    if (owner !== mine && pending > 0n) {
      // Switching mines turns the old position's reward into a claim on the old mint, exactly like
      // releaseArmedPositions plus a reward_claims row does in production.
      const tokens = Number(pending);
      if (gateAllows(player, "claim_reward", context.riskOps, context.options)) {
        creditPaid(owner, player, tokens);
        player.claimedTokens += tokens;
        player.validClaims += 1;
      } else {
        creditHeld(owner, player, tokens);
      }
      pending = 0n;
    }
    player.position = {
      mineId: mine.spec.key,
      assignedPower: event.power,
      lastRewardIndex: mine.core.globalRewardIndex,
      pendingReward: pending,
      paused: false,
    };
    player.positionMine = mine.spec.key;
    setArmedPower(mine, player, event.power, context);
    return;
  }
  if (event.kind === "power") {
    // An upgrade re-arms a working crew, exactly like armPosition after releaseArmedPositions in
    // worker/crew.ts: a position that held power must never stay paused, or every later settle of
    // it would take the forfeit path and hand its whole accrued entitlement back to the reserve.
    player.position = { ...settled.position, assignedPower: event.power, paused: false };
    // The power belongs where the position is: the index that pays it is the owner mine's.
    setArmedPower(owner, player, event.power, context);
    return;
  }
  // expire: settle at the last index the position was entitled to, then release the power.
  player.blocksCredited += creditedBlocks(player, blockTime, config);
  player.position = { ...settled.position, assignedPower: 0n, paused: true };
  player.minedTokens += Number(settled.earned);
  setArmedPower(owner, player, 0n, context);
}

/** The mine that owns a player's current position, falling back to the mine being advanced. */
function ownerMineOf(player: SimPlayer, fallback: MineRuntime, context: AdvanceContext): MineRuntime {
  if (player.positionMine === null) return fallback;
  return context.mineByKey.get(player.positionMine) ?? fallback;
}

/**
 * Moves a player's aggregate power to its one correct home. A player's power lives in exactly one
 * mine's running total at a time, so every arm, upgrade and expiry goes through here: the previous
 * holder is debited first, whether or not it is the mine being written to.
 */
function setArmedPower(
  mine: MineRuntime,
  player: SimPlayer,
  power: bigint,
  context: AdvanceContext,
): void {
  if (player.powerArmed > 0n && player.powerMine !== null) {
    const holder = context.mineByKey.get(player.powerMine);
    if (holder) removePower(holder, player, player.powerArmed);
  }
  player.powerArmed = power > 0n ? power : 0n;
  player.powerMine = power > 0n ? mine.spec.key : null;
  if (power > 0n) addPower(mine, player, power);
}

function addPower(mine: MineRuntime, player: SimPlayer, power: bigint): void {
  mine.power += power;
  if (player.cohort === "bot") mine.powerBots += power;
  else mine.powerHumans += power;
}

function removePower(mine: MineRuntime, player: SimPlayer, power: bigint): void {
  mine.power -= power;
  if (player.cohort === "bot") mine.powerBots -= power;
  else mine.powerHumans -= power;
}

/** Blocks a window earned, mirroring worker/mining.ts creditedBlockCount. */
function creditedBlocks(player: SimPlayer, cursor: number, config: DiggoConfig): number {
  const activatedAt = player.activation.activatedAt;
  const activeUntil = player.armedUntil;
  if (activatedAt === null || activeUntil === null || activeUntil <= activatedAt) return 0;
  const interval = config.time.secondsPerDay / BLOCKS_PER_DAY;
  const steps = Math.floor((cursor - activatedAt) / interval);
  if (steps <= 0) return 0;
  const lastEligible = Math.ceil((activeUntil - activatedAt) / interval) - 1;
  return Math.max(0, Math.min(steps, lastEligible));
}

// --- discovery -------------------------------------------------------------------------

function epochHeadroomTokens(mine: MineRuntime, now: number): number {
  if (mine.discoveryEpochEndsAt <= now) return mine.discoveryReserveRemaining;
  return Math.max(
    0,
    Math.min(mine.discoveryReserveRemaining, mine.discoveryEpochBudget - mine.discoveryEpochSpent),
  );
}

function noteDenial(mine: MineRuntime, reason: string): void {
  mine.denialsToday.set(reason, (mine.denialsToday.get(reason) ?? 0) + 1);
}

export interface DiscoveryContext {
  options: SimOptions;
  riskOps: RiskOpsConfig;
  globalUsdToday: () => number;
  addGlobalUsd: (usd: number) => void;
  capDenials: Map<string, number>;
  misses: { count: number };
  violations: { count: number };
}

export function runDiscovery(
  player: SimPlayer,
  day: number,
  dayStart: number,
  intervals: readonly { from: number; to: number }[],
  mines: readonly MineRuntime[],
  context: DiscoveryContext,
): void {
  const config = context.options.config;
  const accountAgeSeconds = Math.max(0, dayStart - player.createdTime);
  const eligible = discoveryEligibility(
    {
      accountAgeSeconds,
      activeDays: player.activeDays,
      validActivations: player.validActivations,
      crewTier: crewTier(player.levels, config).tier,
      maturityBps: maturityBps(accountAgeSeconds, config),
      riskState: player.rewardState,
      abuseFlags: 0,
    },
    config,
  );
  if (!eligible.eligible) return;
  if (!gateAllows(player, "discovery_roll", context.riskOps, context.options)) return;

  const windowsPerDay = Math.round(86_400 / config.discovery.windowSeconds);
  for (const interval of intervals) {
    const first = Math.max(0, Math.floor((interval.from - dayStart) / config.discovery.windowSeconds));
    const last = Math.min(
      windowsPerDay - 1,
      Math.ceil((interval.to - dayStart) / config.discovery.windowSeconds) - 1,
    );
    for (let window = first; window <= last; window += 1) {
      const windowStart = dayStart + window * config.discovery.windowSeconds;
      if (windowStart < interval.from || windowStart >= interval.to) continue;
      const roll = draw(player.id, LANE.discoveryWindow, day, window, player.id % 7_919);
      if (roll >= config.discovery.rollChanceBps / 10_000) {
        context.misses.count += 1;
        continue;
      }
      attemptDiscovery(player, day, windowStart, mines, context);
    }
  }
}

function attemptDiscovery(
  player: SimPlayer,
  day: number,
  now: number,
  mines: readonly MineRuntime[],
  context: DiscoveryContext,
): void {
  const config = context.options.config;
  const candidates = mines.filter(
    (mine) =>
      mine.status !== "FULLY_MINED" &&
      mine.discoveryReserveRemaining > 0 &&
      mine.spec.launchDay <= day &&
      mine.spec.liquidityUsd >= config.discovery.minimumLiquidityUsd &&
      mine.spec.volume24hUsd >= config.discovery.minimumVolume24hUsd &&
      mine.spec.priceUsd * mine.spec.totalSupply >= config.discovery.minimumMarketCapUsd &&
      mine.price.confidence >= config.discovery.minimumPriceConfidence,
  );
  if (candidates.length === 0) {
    if (mines.length > 0) noteDenial(mines[0], "no_candidate_token");
    return;
  }
  const accountDailyUsd = player.accountUsdByDay.get(day) ?? 0;
  const accountWeeklyUsd = sumDays(player.accountUsdByDay, day - 6, day);
  const globalUsd = context.globalUsdToday();
  const preRoll: DiscoveryUsage = {
    accountDailyUsd,
    accountWeeklyUsd,
    tokenDailyUsd: 0,
    tokenPeriodUsd: 0,
    globalDailyUsd: globalUsd,
  };
  if (discoveryBudgetRemaining(preRoll, config) <= 0) {
    const probe = discoveryBudgetCheck(preRoll, { requestedUsd: 0, circuitBreakerOpen: false }, config);
    const reason = probe.reason ?? "no_budget_left";
    context.capDenials.set(reason, (context.capDenials.get(reason) ?? 0) + 1);
    return;
  }

  const totalLiquidity = candidates.reduce((sum, mine) => sum + mine.spec.liquidityUsd, 0);
  const ticket = draw(player.id, LANE.discoveryTarget, day, Math.floor(now / 3_600), 7) * totalLiquidity;
  let cumulative = 0;
  let target = candidates[candidates.length - 1];
  for (const mine of candidates) {
    cumulative += mine.spec.liquidityUsd;
    if (ticket <= cumulative) {
      target = mine;
      break;
    }
  }

  const eligibility: TokenEligibilityInput = {
    liquidityUsd: target.spec.liquidityUsd,
    volume24hUsd: target.spec.volume24hUsd,
    tradeCount24h: target.spec.tradeCount24h,
    reserveAvailableUsd: target.discoveryReserveRemaining * target.price.priceUsd,
    priceConfidence: target.price.confidence,
    health: target.spec.health,
  };
  const score = tokenEligibilityScore(eligibility, config);
  const rolled = rollDiscoveryRarity(
    draw(player.id, LANE.discoveryRarity, day, Math.floor(now / 3_600), 11),
    config,
  );
  const resolved = resolveRarity(rolled, eligibility, config);
  const usage: DiscoveryUsage = {
    accountDailyUsd,
    accountWeeklyUsd,
    tokenDailyUsd: target.tokenUsdByDay.get(day) ?? 0,
    tokenPeriodUsd: sumDays(target.tokenUsdByDay, day - 6, day),
    globalDailyUsd: globalUsd,
  };
  const headroomUsd = discoveryBudgetRemaining(usage, config);
  if (headroomUsd <= 0) {
    const probe = discoveryBudgetCheck(usage, { requestedUsd: 0, circuitBreakerOpen: false }, config);
    const reason = probe.reason ?? "no_budget_left";
    noteDenial(target, reason);
    context.capDenials.set(reason, (context.capDenials.get(reason) ?? 0) + 1);
    return;
  }
  const epochTokens = epochHeadroomTokens(target, now);
  const tierValueUsd = rarityTier(resolved.rarity, config).valueUsd;
  const maxGrantUsd = Math.min(tierValueUsd, headroomUsd, epochTokens * target.price.priceUsd);
  const capped = capRarityByBudget(resolved.rarity, maxGrantUsd, config);
  const amount = normalizedDiscoveryAmount(capped, target.price, config, maxGrantUsd);
  if (!amount) {
    noteDenial(target, "amount_unavailable");
    return;
  }
  const check = discoveryBudgetCheck(
    usage,
    { requestedUsd: amount.valueUsd, circuitBreakerOpen: target.discoveryReserveRemaining <= 0 },
    config,
  );
  if (!check.allowed) {
    const reason = check.reason ?? "no_budget_left";
    noteDenial(target, reason);
    context.capDenials.set(reason, (context.capDenials.get(reason) ?? 0) + 1);
    return;
  }
  if (amount.amount > epochTokens) {
    noteDenial(target, "reserve_exhausted");
    return;
  }
  if (amount.valueUsd > config.discovery.perRequestCapUsd + 1e-9) context.violations.count += 1;
  if (amount.valueUsd > check.maxAllowedUsd + 1e-9) context.violations.count += 1;

  target.discoveryReserveRemaining -= amount.amount;
  target.discoveryEpochSpent += amount.amount;
  target.discoverySpent += amount.amount;
  target.discoverySpentToday += amount.amount;
  target.discoveryUsd += amount.valueUsd;
  target.discoveryHitsToday += 1;
  target.discoveryTokensToday += amount.amount;
  target.discoveryUsdToday += amount.valueUsd;
  target.tokenUsdByDay.set(day, (target.tokenUsdByDay.get(day) ?? 0) + amount.valueUsd);
  player.accountUsdByDay.set(day, accountDailyUsd + amount.valueUsd);
  context.addGlobalUsd(amount.valueUsd);
  // A discovery won by an account whose real-value claims are held is committed against the
  // Discovery Reserve but not handed over (spec 53, 54): the record exists, the wallet cannot
  // receive it while the hold stands, and a cleared account still gets it.
  const heldClaim = claimHoldApplies(player.computedState, "claim_discovery", context.riskOps);
  if (!heldClaim) {
    player.discoveryTokens += amount.amount;
    player.discoveryUsd += amount.valueUsd;
    player.discoveryHits += 1;
  }
  if (player.cohort === "human") {
    target.discoveryHumanUsd += amount.valueUsd;
    target.discoveryHumanTokens += amount.amount;
    target.discoveryHumanTokensToday += amount.amount;
    target.discoveryHumanHitsToday += 1;
    if (heldClaim) target.discoveryHumanHeldTokens += amount.amount;
  } else {
    target.discoveryBotUsd += amount.valueUsd;
    target.discoveryBotTokens += amount.amount;
    target.discoveryBotTokensToday += amount.amount;
    target.discoveryBotHitsToday += 1;
    if (heldClaim) target.discoveryBotHeldTokens += amount.amount;
  }
  void score;
}

// --- risk ------------------------------------------------------------------------------

/**
 * Daily risk refresh, mirroring worker/risk.ts refreshAccountRisk: raw behaviour counts are
 * turned into the configured signals, assessRisk scores them, and enforcedRewardState decides
 * whether the score is a state at all (shadow mode by default). Mine Trust is recomputed from
 * time, valid play and clean history only.
 */
export function refreshRisk(
  player: SimPlayer,
  dayStart: number,
  config: DiggoConfig,
  riskOps: RiskOpsConfig,
  farmById: Map<number, FarmRuntime>,
): void {
  const farm = player.cohort === "bot" ? farmById.get(player.farmId) ?? null : null;
  const intervalStdev = stdev(player.intervals.slice(-RISK_SAMPLE_WINDOW));
  const signals: RiskSignals = {
    activationTimingRegularity: clamp01(1 - intervalStdev / 21_600) * 2,
    activationSynchrony: farm ? farm.synchronyFraction : 0.02,
    walletsPerDeviceCluster: farm ? farm.walletsPerDevice : 1,
    accountsPerNetworkCluster: farm ? farm.walletsPerNetwork : 1,
    creationCluster: farm ? farm.creationBatchSize : player.creationClusterWindow,
    burstActions: farm ? farm.burstActionsPerMinute : 1,
    claimBurst: farm ? farm.claimBurstPerMinute : Math.min(3, player.claimsInWindow),
    switchingPatternSimilarity: farm ? farm.switchingSimilarity : 0.1,
    linkedAbuseHistory: 0,
  };
  const assessment = assessRisk(signals, config);
  const enforced = enforcedRewardState(assessment.rewardState, riskOps);
  const accountAgeSeconds = Math.max(0, dayStart - player.createdTime);
  const ageDays = accountAgeSeconds / config.time.secondsPerDay;
  player.signals = signals;
  player.riskScore = assessment.score;
  player.computedState = assessment.rewardState;
  player.rewardState = enforced.state;
  player.trust = mineTrust(
    {
      accountAgeSeconds,
      validActivations: player.activeDays,
      streakConsistency: ageDays > 0 ? Math.min(1, player.activeDays / ageDays) : 0,
      validClaims: player.validClaims,
      abuseFlags: 0,
    },
    config,
  );
}
