/**
 * The world the rules are applied to: a population with habits, and one player's day.
 *
 * This is the sim's equivalent of worker/mining.ts (activate, report, claim) and worker/crew.ts
 * (upgrade), plus the score branch of the gate in worker/risk.ts. ORE, streak, capacity, Mining
 * Power, upgrade costs and risk decisions all come from shared/.
 */
import { type CrewComponent, type DiggoConfig } from "../../shared/config";
import {
  CREW_COMPONENTS,
  crewPower,
  crewTier,
  effectiveMiningPower,
  upgradeOreCost,
} from "../../shared/crew";
import { oreCapacity, oreForActiveSeconds, oreGrant, storeOre } from "../../shared/ore";
import { applyActivation, activationEligibility } from "../../shared/streak";
import { createMiningPosition } from "../../shared/rewardIndex";
import { scoreRefusal } from "../../shared/risk";
import {
  claimHoldApplies,
  enforcementDecision,
  type GatedActionKey,
  type RiskOpsConfig,
} from "../../shared/riskOps";
import {
  DAY,
  HOUR,
  LANE,
  draw,
  type DayEvent,
  type FarmRuntime,
  type MineRuntime,
  type SimPlayer,
} from "./state";
import { HUMAN_HABITS, type Cohort, type HumanHabitClass, type SimOptions } from "./model";

export function buildFarms(options: SimOptions): FarmRuntime[] {
  return options.botFarmSizes.map((size, index) => {
    if (options.botStealth === "naive") {
      return {
        id: index,
        size,
        stealth: "naive" as const,
        walletsPerDevice: Math.max(size, 10),
        walletsPerNetwork: Math.max(size, 10),
        creationBatchSize: size,
        burstActionsPerMinute: Math.min(size, 600),
        claimBurstPerMinute: Math.min(Math.ceil(size / 2), 400),
        synchronyFraction: 1,
        switchingSimilarity: 1,
      };
    }
    return {
      id: index,
      size,
      stealth: "stealthy" as const,
      walletsPerDevice: 15,
      walletsPerNetwork: Math.max(1, Math.round(size / 400)),
      creationBatchSize: 8,
      burstActionsPerMinute: 12,
      claimBurstPerMinute: 6,
      synchronyFraction: 0.25,
      switchingSimilarity: 0.2,
    };
  });
}

function pickHabit(seed: number, id: number): HumanHabitClass {
  const value = draw(seed, LANE.habit, id, 0);
  let cumulative = 0;
  for (const habit of HUMAN_HABITS) {
    cumulative += habit.share;
    if (value <= cumulative) return habit;
  }
  return HUMAN_HABITS[HUMAN_HABITS.length - 1];
}

/** A launch spike followed by a decaying tail: half the wallets appear in the first three days. */
export function arrivalDayFor(seed: number, id: number, options: SimOptions): number {
  const window = Math.max(1, Math.min(options.arrivalWindowDays, options.days));
  const weights: number[] = [];
  let total = 0;
  for (let day = 1; day <= window; day += 1) {
    const weight = Math.exp(-(day - 1) / 6) + 0.04;
    weights.push(weight);
    total += weight;
  }
  const value = draw(seed, LANE.arrival, id, 0) * total;
  let cumulative = 0;
  for (let index = 0; index < weights.length; index += 1) {
    cumulative += weights[index];
    if (value <= cumulative) return index + 1;
  }
  return window;
}

function makePlayer(
  id: number,
  cohort: Cohort,
  farmId: number,
  habit: HumanHabitClass | null,
  createdDay: number,
  createdTime: number,
  options: SimOptions,
): SimPlayer {
  const levels = { ...options.config.crew.starterLevels };
  return {
    id,
    cohort,
    farmId,
    habit,
    createdDay,
    createdTime,
    churned: false,
    activation: {
      activatedAt: null,
      activeUntil: null,
      lastActivationAt: null,
      streak: 0,
      longestStreak: 0,
      streakFreezes: 0,
    },
    oreBalance: 0,
    oreOverflow: 0,
    oreEarned: 0,
    oreSpent: 0,
    levels,
    power: BigInt(crewPower(levels, options.config)),
    position: createMiningPosition(null, 0n),
    positionMine: null,
    armedUntil: null,
    armedMine: null,
    powerMine: null,
    powerArmed: 0n,
    claimedTokens: 0,
    minedTokens: 0,
    discoveryTokens: 0,
    discoveryUsd: 0,
    discoveryHits: 0,
    activeMine: null,
    oreCollectedAt: createdTime,
    // One wallet per device and per network environment for the human population; a scripted farm
    // overwrites both with its own shape just below.
    deviceCluster: 1,
    networkCluster: 1,
    activeDays: 0,
    validActivations: 0,
    validClaims: 0,
    riskScore: 0,
    computedState: "NORMAL",
    rewardState: "NORMAL",
    trust: 0,
    signals: {},
    intervals: [],
    blocksCredited: 0,
    achievements: new Set<string>(),
    accountUsdByDay: new Map<number, number>(),
    anchorHour: 24 * draw(options.seed, LANE.anchor, id, 0),
    dormantToday: false,
    lastOverflow: 0,
    upgradeEagerness: habit ? habit.upgradeEagerness : 1,
    creationClusterWindow: 1,
    peakActionsPerMinuteToday: 0,
    claimsInWindow: 0,
  };
}

export function buildPopulation(options: SimOptions): {
  humans: SimPlayer[];
  bots: SimPlayer[];
  farms: FarmRuntime[];
} {
  const humans: SimPlayer[] = [];
  for (let id = 0; id < options.humans; id += 1) {
    const habit = pickHabit(options.seed, id);
    const day = arrivalDayFor(options.seed, id, options);
    const createdTime =
      options.startTime + (day - 1) * DAY + Math.floor(draw(options.seed, LANE.visitJitter, id, 0) * DAY);
    humans.push(makePlayer(id, "human", -1, habit, day, createdTime, options));
  }

  const farms = buildFarms(options);
  const bots: SimPlayer[] = [];
  let botId = options.humans;
  for (const farm of farms) {
    const spreadDays = farm.stealth === "naive" ? 0 : Math.max(1, Math.min(30, options.days) - 1);
    for (let index = 0; index < farm.size; index += 1) {
      const day =
        farm.stealth === "naive" ? 1 : 1 + Math.floor((index / Math.max(1, farm.size - 1)) * spreadDays);
      const jitter =
        farm.stealth === "naive"
          ? 0
          : Math.floor(
              (index % farm.creationBatchSize) * 600 + draw(options.seed, LANE.visitJitter, botId, 1) * 300,
            );
      const createdTime = options.startTime + (day - 1) * DAY + jitter;
      const bot = makePlayer(botId, "bot", farm.id, null, day, createdTime, options);
      if (farm.stealth === "naive") bot.anchorHour = createdTime / HOUR;
      bot.deviceCluster = Math.max(1, Math.floor(farm.walletsPerDevice));
      bot.networkCluster = Math.max(1, Math.floor(farm.walletsPerNetwork));
      bots.push(bot);
      botId += 1;
    }
  }

  // Simplest honest model of creationCluster: how many accounts appeared inside the same
  // ten-minute bucket. Humans really do arrive in a launch spike, which is what the signal reads.
  const sorted = [...humans].sort((left, right) => left.createdTime - right.createdTime);
  let start = 0;
  for (let index = 0; index < sorted.length; index += 1) {
    while (sorted[index].createdTime - sorted[start].createdTime > 600) start += 1;
    const size = index - start + 1;
    for (let cursor = start; cursor <= index; cursor += 1) {
      sorted[cursor].creationClusterWindow = Math.max(sorted[cursor].creationClusterWindow, size);
    }
  }
  return { humans, bots, farms };
}

// --- the gate (mirrors the score branch of worker/risk.ts gateAction) -------------------

/** The mine that owns a position's index, which is the mine that released its tokens. */
export function indexOwnerMine(
  player: SimPlayer,
  mineByKey: Map<string, MineRuntime>,
): MineRuntime | null {
  return player.position.mineId === null ? null : mineByKey.get(player.position.mineId) ?? null;
}

/**
 * Books tokens released to a player, per cohort, so a report can separate "earned" from
 * "actually handed over" (spec 53: a held claim is neither).
 */
export function creditPaid(mine: MineRuntime, player: SimPlayer, amount: number): void {
  mine.paidTokens += amount;
  if (player.cohort === "bot") mine.botPaidTokens += amount;
  else mine.humanPaidTokens += amount;
}

export function creditHeld(mine: MineRuntime, player: SimPlayer, amount: number): void {
  mine.heldTokens += amount;
  if (player.cohort === "bot") mine.botHeldTokens += amount;
  else mine.humanHeldTokens += amount;
}

const SCORE_REFUSAL_KINDS = {
  block: "score_block",
  hold: "score_hold",
  challenge: "score_challenge",
} as const;

/**
 * The refusal comes from the *computed* state and whether it is enforced comes from
 * shared/riskOps.ts enforcementDecision — shadow mode by default, so a score alone refuses
 * nothing until an operator turns enforcement on. A cleared challenge is modelled as passable:
 * the signature strategy is a wallet signature, free for a script, mild friction for a human.
 * Hard safety (admin restrictions, circuit breakers, rate limits) is not modelled here.
 */
export function gateAllows(
  player: SimPlayer,
  action: GatedActionKey,
  riskOps: RiskOpsConfig,
  options: SimOptions,
): boolean {
  if (!options.riskGating) return true;
  // A reward hold on a real-value claim holds in every enforcement mode (spec 53, 63): it is
  // reversible and destroys nothing, so it is not something shadow mode protects an account from.
  // This is the same branch worker/risk.ts gateAction takes before it reaches the mode.
  if (claimHoldApplies(player.computedState, action, riskOps)) return false;
  const refusal = scoreRefusal(player.computedState);
  if (refusal === "none" || refusal === "challenge") return true;
  const decision = enforcementDecision(SCORE_REFUSAL_KINDS[refusal], action, riskOps);
  if (!decision.enforced) return true;
  if (refusal === "hold") return !riskOps.challenge.heldActions.includes(action);
  return false;
}

// --- progression -----------------------------------------------------------------------

function powerGreedyChoice(player: SimPlayer, config: DiggoConfig): CrewComponent | null {
  let best: CrewComponent | null = null;
  let bestScore = 0;
  for (const component of ["miners", "drills"] as const) {
    const level = player.levels[component];
    if (level >= config.crew.maxLevel) continue;
    const cost = upgradeOreCost(component, level, player.levels.foreman, config);
    if (player.oreBalance < cost) continue;
    const before = crewPower(player.levels, config);
    const after = crewPower({ ...player.levels, [component]: level + 1 }, config);
    const score = cost > 0 ? (after - before) / cost : 0;
    if (score > bestScore) {
      bestScore = score;
      best = component;
    }
  }
  return best;
}

/** Keep every branch as even as possible: what a player who reads the tooltips tends to do. */
function balancedChoice(player: SimPlayer, config: DiggoConfig): CrewComponent | null {
  let best: CrewComponent | null = null;
  let bestLevel = Number.POSITIVE_INFINITY;
  for (const component of CREW_COMPONENTS) {
    const level = player.levels[component];
    if (level >= config.crew.maxLevel) continue;
    if (player.oreBalance < upgradeOreCost(component, level, player.levels.foreman, config)) continue;
    if (level < bestLevel) {
      bestLevel = level;
      best = component;
    }
  }
  return best;
}

function upgradeOnce(player: SimPlayer, component: CrewComponent, config: DiggoConfig): boolean {
  const level = player.levels[component];
  if (level >= config.crew.maxLevel) return false;
  const cost = upgradeOreCost(component, level, player.levels.foreman, config);
  if (player.oreBalance < cost) return false;
  player.oreBalance -= cost;
  player.oreSpent += cost;
  player.levels = { ...player.levels, [component]: level + 1 };
  player.power = BigInt(crewPower(player.levels, config));
  return true;
}

/**
 * Spends available ORE on crew upgrades. Bots always buy the most Mining Power per ORE; humans
 * alternate between that and an even-across-branches habit. Everyone buys Storage when they
 * overflowed last collection and sit near capacity, because overflow is tracked but never
 * spendable (shared/ore.ts storeOre).
 */
function spendOre(player: SimPlayer, config: DiggoConfig, atTime: number): boolean {
  if (player.upgradeEagerness < 1 && draw(player.id, LANE.upgrade, player.id, atTime) > player.upgradeEagerness) {
    return false;
  }
  let bought = 0;
  while (bought < 8) {
    const capacity = oreCapacity(player.levels, config);
    const nearCapacity = player.lastOverflow > 0 && player.oreBalance >= capacity * 0.9;
    let choice: CrewComponent | null = null;
    if (nearCapacity) {
      choice = "storage";
    } else if (player.cohort === "human" && player.id % 2 === 1) {
      choice = balancedChoice(player, config) ?? powerGreedyChoice(player, config);
    } else {
      choice = powerGreedyChoice(player, config);
    }
    if (!choice || !upgradeOnce(player, choice, config)) break;
    bought += 1;
  }
  return bought > 0;
}

function grantAchievement(player: SimPlayer, id: string, config: DiggoConfig): number {
  if (player.achievements.has(id)) return 0;
  const ore = oreGrant({ source: "achievement", achievementId: id }, player.levels, config);
  if (ore > 0) player.achievements.add(id);
  return ore;
}

export function chooseMine(
  player: SimPlayer,
  day: number,
  mines: readonly MineRuntime[],
  options: SimOptions,
): MineRuntime | null {
  const live = mines.filter(
    (mine) => mine.status === "MINING_ACTIVE" && mine.spec.launchDay <= day && mine.core.reserveRemaining > 0n,
  );
  if (live.length === 0) return null;
  if (player.cohort === "bot") {
    // A farm optimises expected payout: block reward divided by the power already committed.
    let best = live[0];
    let bestValue = -1;
    for (const mine of live) {
      const value = (mine.spec.rewardPerBlock * 1_000) / (Number(mine.power) + 1_000);
      if (value > bestValue) {
        bestValue = value;
        best = mine;
      }
    }
    return best;
  }
  const total = live.reduce((sum, mine) => sum + mine.spec.popularity, 0);
  const ticket = draw(options.seed, LANE.target, player.id, day, 1) * total;
  let cumulative = 0;
  for (const mine of live) {
    cumulative += mine.spec.popularity;
    if (ticket <= cumulative) return mine;
  }
  return live[live.length - 1];
}

// --- one player, one day ---------------------------------------------------------------

function visitsFor(player: SimPlayer, day: number, dayStart: number, options: SimOptions): number[] {
  const earliest = Math.max(dayStart, player.createdTime);
  const dayEnd = dayStart + DAY;
  // A churned player stops coming back, but their crew still mines while the window is open: the
  // expiry below is what ends it, so a churned wallet must still be planned for that day.
  if (player.churned) return [];
  if (player.cohort === "bot") {
    if (options.botStealth === "naive") {
      // Scripted perfection: re-activate the moment the configured rate limit allows, forever.
      const step = options.config.streak.minimumReactivationSeconds;
      const times: number[] = [];
      let time = player.createdTime;
      while (time < dayStart) time += step;
      while (time < dayEnd) {
        if (time >= earliest) times.push(Math.floor(time));
        time += step;
      }
      return times;
    }
    if (player.dormantToday) return [];
    const drift = (draw(options.seed, LANE.drift, player.id, day) - 0.5) * 2 * 7_200;
    const time = Math.floor(dayStart + player.anchorHour * HOUR + drift);
    return time >= earliest && time < dayEnd ? [time] : [];
  }
  const habit = player.habit;
  if (!habit) return [];
  if (draw(options.seed, LANE.activeDay, player.id, day) > habit.activationDaysPerWeek / 7) return [];
  const sessions = Math.floor(habit.sessionsPerDay);
  const extra = draw(options.seed, LANE.visitSlot, player.id, day, 5) < habit.sessionsPerDay - sessions;
  const count = Math.max(1, sessions + (extra ? 1 : 0));
  const times: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const slot = (index + 0.15 + 0.7 * draw(options.seed, LANE.visitSlot, player.id, day, index + 1)) / count;
    const time = Math.floor(dayStart + slot * DAY);
    if (time >= earliest) times.push(time);
  }
  return times;
}

export interface PlayerPlan {
  events: DayEvent[];
  discoveryIntervals: { from: number; to: number }[];
}

/**
 * Runs one player through one sim day: ORE collection, streak, achievements, claims, upgrades and
 * (re)activation, emitting the mine events the block loop needs. Order matches the real handlers:
 * collect ORE for the window that ended, settle, then move power.
 */
export function planPlayerDay(
  player: SimPlayer,
  day: number,
  dayStart: number,
  options: SimOptions,
  riskOps: RiskOpsConfig,
  mines: readonly MineRuntime[],
  mineByKey: Map<string, MineRuntime>,
): PlayerPlan {
  const config = options.config;
  const events: DayEvent[] = [];
  const discoveryIntervals: { from: number; to: number }[] = [];
  player.dormantToday =
    player.cohort === "bot" &&
    options.botStealth === "stealthy" &&
    draw(options.seed, LANE.dormant, player.id, day) < 0.05;
  player.peakActionsPerMinuteToday = player.cohort === "bot" ? 0 : 1;
  const visits = visitsFor(player, day, dayStart, options);
  // The pending expiry of an open window is interleaved with today's visits in time order: a visit
  // before the window ends extends it, a visit after it lets it lapse.
  const timeline: { time: number; visit: boolean }[] = visits.map((time) => ({ time, visit: true }));
  if (player.armedUntil !== null && player.armedUntil <= dayStart + DAY) {
    timeline.push({ time: player.armedUntil, visit: false });
  }
  timeline.sort((left, right) => left.time - right.time);
  // A day with no visit still has to release a window that lapses on it: an unprocessed expiry
  // would leave an absent player mining forever, which is exactly what spec 3 and 16 forbid.
  if (timeline.length === 0) return { events, discoveryIntervals };

  for (const entry of timeline) {
    const now = entry.time;
    if (!entry.visit) {
      if (player.armedMine !== null && player.armedUntil !== null && player.armedUntil === now) {
        events.push({ time: now, kind: "expire", mineKey: player.armedMine, power: 0n, windowEnd: now, player });
        player.armedUntil = null;
        player.armedMine = null;
      }
      continue;
    }
    if (player.cohort === "bot") player.peakActionsPerMinuteToday = Math.max(player.peakActionsPerMinuteToday, 6);

    // ORE for the window that just ended (worker/mining.ts activeSecondsForWindow).
    const collectFrom = Math.min(player.oreCollectedAt, now);
    const accruedTo = player.armedUntil === null ? collectFrom : Math.min(now, player.armedUntil);
    const activeSeconds = Math.max(0, accruedTo - collectFrom);
    const accountAgeSeconds = Math.max(0, now - player.createdTime);
    const eligibility = activationEligibility(player.activation, now, config);
    let ore = oreForActiveSeconds(activeSeconds, accountAgeSeconds, player.levels, config);

    if (eligibility.eligible && gateAllows(player, "activate", riskOps, options)) {
      if (player.activation.lastActivationAt !== null) {
        player.intervals.push(now - player.activation.lastActivationAt);
        if (player.intervals.length > 40) player.intervals.shift();
      }
      const outcome = applyActivation(player.activation, now, config);
      player.activation = {
        activatedAt: now,
        activeUntil: outcome.window.activeUntil,
        lastActivationAt: now,
        streak: outcome.streak,
        longestStreak: outcome.longestStreak,
        streakFreezes: outcome.freezes,
      };
      ore += oreGrant({ source: "activation", accountAgeSeconds }, player.levels, config);
      ore += oreGrant(
        { source: "streak_milestone", milestoneOre: outcome.rewards.ore },
        player.levels,
        config,
      );
      ore += grantAchievement(player, "FIRST_ACTIVATION", config);
      player.activeDays += 1;
      player.validActivations += 1;

      // Where the crew mines: stay while the mine is live, otherwise pick again.
      const current = player.armedMine === null ? null : mineByKey.get(player.armedMine) ?? null;
      const currentLive =
        current !== null && current.status === "MINING_ACTIVE" && current.core.reserveRemaining > 0n;
      if (!currentLive && current !== null && player.armedMine !== null) {
        if (player.position.pendingReward > 0n) {
          settleAndPark(player, indexOwnerMine(player, mineByKey) ?? current, riskOps, options);
        }
        events.push({ time: now, kind: "expire", mineKey: current.spec.key, power: 0n, windowEnd: now, player });
        player.armedUntil = null;
        player.armedMine = null;
      }
      const target = currentLive ? current : chooseMine(player, day, mines, options);
      if (target !== null) {
        if (current !== null && current.spec.key !== target.spec.key) {
          ore += grantAchievement(player, "FIRST_MINE_SWITCH", config);
        }
        const windowEnd = now + config.streak.activationSeconds;
        player.activeMine = target.spec.key;
        events.push({
          time: now,
          kind: "arm",
          mineKey: target.spec.key,
          power: armPowerFor(player, accountAgeSeconds, target, options),
          windowEnd,
          player,
        });
        player.armedUntil = windowEnd;
        player.armedMine = target.spec.key;
        discoveryIntervals.push({ from: now, to: windowEnd });
      }
    }
    player.oreCollectedAt = now;

    if (player.minedTokens > 0 || player.position.assignedPower > 0n) {
      if (player.blocksCredited >= 1) ore += grantAchievement(player, "FIRST_BLOCK", config);
      if (player.blocksCredited >= 10) ore += grantAchievement(player, "TEN_BLOCKS", config);
    }
    if (crewTier(player.levels, config).tier >= 3) ore += grantAchievement(player, "CREW_TIER_3", config);

    if (ore > 0) {
      const stored = storeOre(player.oreBalance, ore, oreCapacity(player.levels, config), config);
      player.oreBalance = stored.balance;
      player.oreOverflow += stored.overflow;
      player.oreEarned += ore;
      player.lastOverflow = stored.overflow;
    }

    // Claims before upgrades: an upgrade must not eat the claimable reward.
    if (player.position.pendingReward > 0n && gateAllows(player, "claim_reward", riskOps, options)) {
      const amount = Number(player.position.pendingReward);
      player.position = { ...player.position, pendingReward: 0n };
      player.claimedTokens += amount;
      player.validClaims += 1;
      player.claimsInWindow += 1;
      // Parked against the mine whose index released the tokens, not the mine the player happens to
      // be pointing at: a wallet that switched mines can still be owed the old mine's reward.
      const owner = indexOwnerMine(player, mineByKey);
      if (owner) creditPaid(owner, player, amount);
    }
    if (gateAllows(player, "crew_upgrade", riskOps, options) && spendOre(player, config, now)) {
      if (player.armedMine !== null && player.armedUntil !== null) {
        events.push({
          time: now,
          kind: "power",
          mineKey: player.armedMine,
          power: armPowerFor(player, accountAgeSeconds, mineByKey.get(player.armedMine) ?? null, options),
          windowEnd: player.armedUntil,
          player,
        });
      }
    }
  }
  return { events, discoveryIntervals };
}

/** Moves a settled reward into the mine it belongs to, exactly as a per-mint claim row would. */
export function settleAndPark(
  player: SimPlayer,
  mine: MineRuntime,
  riskOps: RiskOpsConfig,
  options: SimOptions,
): void {
  const pending = Number(player.position.pendingReward);
  if (pending <= 0) return;
  player.position = { ...player.position, pendingReward: 0n };
  if (gateAllows(player, "claim_reward", riskOps, options)) {
    creditPaid(mine, player, pending);
    player.claimedTokens += pending;
    player.validClaims += 1;
  } else {
    creditHeld(mine, player, pending);
  }
}

/**
 * The power a position is armed with: shared/crew.ts effectiveMiningPower, i.e. the crew's power
 * after account maturity, the device/network cluster damping and the per-account share cap
 * (spec 40, 58, 61, 64). The `legacy` economy keeps the old behaviour because its config switches
 * every lever off, so the harness still runs the real rule in both columns.
 *
 * The one counterfactual this file owns is the minimum crew tier for owning eligible power, which
 * is not in shared/config.ts: it exists to price an alternative to the hard cap.
 */
function armPowerFor(
  player: SimPlayer,
  accountAgeSeconds: number,
  mine: MineRuntime | null,
  options: SimOptions,
): bigint {
  const config = options.config;
  if (options.miningMinCrewTier > 0 && crewTier(player.levels, config).tier < options.miningMinCrewTier) {
    return 0n;
  }
  return effectiveMiningPower({
    power: player.power,
    accountAgeSeconds,
    cluster: { walletsOnDevice: player.deviceCluster, walletsOnNetwork: player.networkCluster },
    mineTotalPower: mine ? mine.power : 0n,
    config,
  });
}
