import { DIGGO_CONFIG, type DiggoConfig, type StreakMilestoneConfig } from "./config";

/**
 * Daily activation and streak rules (spec 5, 6, 7, 77).
 *
 * A crew is activated manually for a configurable duration (default 24h) and a
 * configurable grace period (default 12h) keeps the streak alive. Streak
 * Freezes can cover a single missed window and can only be earned by playing.
 */

export interface ActivationWindow {
  activatedAt: number;
  activeUntil: number;
  graceUntil: number;
}

export function activationWindow(now: number, config: DiggoConfig = DIGGO_CONFIG): ActivationWindow {
  const activeUntil = now + config.streak.activationSeconds;
  return {
    activatedAt: now,
    activeUntil,
    graceUntil: activeUntil + config.streak.graceSeconds,
  };
}

/** Latest moment the streak survives without spending a Streak Freeze. */
export function streakDeadline(
  previousActivationAt: number | null,
  config: DiggoConfig = DIGGO_CONFIG,
): number {
  if (previousActivationAt === null) return Number.POSITIVE_INFINITY;
  return (
    previousActivationAt +
    config.streak.activationSeconds +
    config.streak.graceSeconds
  );
}

/** Latest moment a Streak Freeze can still rescue the streak. */
export function freezeDeadline(
  previousActivationAt: number,
  config: DiggoConfig = DIGGO_CONFIG,
): number {
  return (
    streakDeadline(previousActivationAt, config) +
    config.streak.activationSeconds * config.streak.freezeCoveredWindows
  );
}

export interface ActivationRecord {
  activatedAt: number | null;
  activeUntil: number | null;
  lastActivationAt: number | null;
  streak: number;
  longestStreak: number;
  streakFreezes: number;
}

export type ActivationEligibilityReason = "eligible" | "too_soon";

export interface ActivationEligibility {
  eligible: boolean;
  reason: ActivationEligibilityReason;
  /** Earliest timestamp at which a new activation is accepted. */
  nextEligibleAt: number;
}

/**
 * Activations stay free but are rate limited to one per minimumReactivation
 * window, so an activation cannot be spammed to farm the activation bonus.
 */
export function activationEligibility(
  record: ActivationRecord,
  now: number,
  config: DiggoConfig = DIGGO_CONFIG,
): ActivationEligibility {
  if (record.lastActivationAt === null) {
    return { eligible: true, reason: "eligible", nextEligibleAt: now };
  }
  const nextEligibleAt = record.lastActivationAt + config.streak.minimumReactivationSeconds;
  if (now < nextEligibleAt) {
    return { eligible: false, reason: "too_soon", nextEligibleAt };
  }
  return { eligible: true, reason: "eligible", nextEligibleAt: now };
}

/**
 * Block eligibility rule (spec 77).
 *
 * A mining position is eligible for the block at blockTime if and only if:
 *
 *   activatedAt <= blockTime < activeUntil
 *
 * A block landing exactly on active_until is NOT eligible: the activation
 * window is half open [activatedAt, activeUntil). The activation timestamp
 * itself is inclusive, so the very first block of a window counts.
 */
export function isEligibleForBlock(
  activeUntil: number | null,
  blockTime: number,
  activatedAt: number | null = 0,
): boolean {
  if (activeUntil === null || !Number.isFinite(activeUntil) || !Number.isFinite(blockTime)) return false;
  const startedAt = activatedAt === null ? 0 : activatedAt;
  return startedAt <= blockTime && blockTime < activeUntil;
}

/**
 * Streak continuation without any rewards. Kept as the original public contract
 * (returns streak/freezes/usedFreeze only); use applyActivation for the full
 * outcome including milestone rewards.
 */
export function nextStreak(
  previousActivationAt: number | null,
  now: number,
  currentStreak: number,
  freezes: number,
  config: DiggoConfig = DIGGO_CONFIG,
): { streak: number; freezes: number; usedFreeze: boolean } {
  if (previousActivationAt === null) return { streak: 1, freezes, usedFreeze: false };
  const elapsed = now - previousActivationAt;
  if (elapsed <= streakDeadline(previousActivationAt, config) - previousActivationAt) {
    return { streak: currentStreak + 1, freezes, usedFreeze: false };
  }
  if (elapsed <= freezeDeadline(previousActivationAt, config) - previousActivationAt && freezes > 0) {
    return { streak: currentStreak + 1, freezes: freezes - 1, usedFreeze: true };
  }
  return { streak: 1, freezes, usedFreeze: false };
}

export type StreakOutcomeKind = "first_activation" | "continued" | "freeze_consumed" | "broken";

export interface StreakRewards {
  ore: number;
  xp: number;
  badges: string[];
  titles: string[];
  freezes: number;
}

export interface StreakOutcome {
  kind: StreakOutcomeKind;
  streak: number;
  longestStreak: number;
  freezes: number;
  usedFreeze: boolean;
  window: ActivationWindow;
  /** Milestones crossed by this activation, lowest day first. */
  milestones: readonly StreakMilestoneConfig[];
  rewards: StreakRewards;
}

/**
 * Milestone rewards (spec 6). Milestones may grant ORE, XP, badges, titles and
 * Streak Freezes. They must never grant token reward multipliers, block shares
 * or real-token luck: this is enforced by the shape of StreakRewards.
 */
export function milestoneRewards(
  previousStreak: number,
  newStreak: number,
  config: DiggoConfig = DIGGO_CONFIG,
): { rewards: StreakRewards; milestones: readonly StreakMilestoneConfig[] } {
  const rewards: StreakRewards = { ore: 0, xp: 0, badges: [], titles: [], freezes: 0 };
  const crossed: StreakMilestoneConfig[] = [];
  if (newStreak <= previousStreak) return { rewards, milestones: crossed };
  for (const milestone of config.streak.milestones) {
    if (milestone.day > previousStreak && milestone.day <= newStreak) {
      crossed.push(milestone);
      rewards.ore += milestone.ore;
      rewards.xp += milestone.xp;
      rewards.badges.push(...milestone.badges);
      rewards.titles.push(...milestone.titles);
      rewards.freezes += milestone.freezes;
    }
  }
  return { rewards, milestones: crossed };
}

/** Streak Freezes earned by sustained play, one per configured interval. */
export function freezesEarnedByInterval(
  previousStreak: number,
  newStreak: number,
  config: DiggoConfig = DIGGO_CONFIG,
): number {
  const interval = config.streak.freezeEarnIntervalDays;
  if (interval <= 0) return 0;
  const before = Math.floor(Math.max(0, previousStreak) / interval);
  const after = Math.floor(Math.max(0, newStreak) / interval);
  return Math.max(0, after - before);
}

/**
 * Applies Streak Freeze grants and the banked freeze cap. Freezes are only ever
 * granted by gameplay; there is no purchase path in this module.
 */
export function grantFreezes(
  currentFreezes: number,
  granted: number,
  config: DiggoConfig = DIGGO_CONFIG,
): { freezes: number; awarded: number } {
  const base = Math.max(0, Math.min(currentFreezes, config.streak.freezeCap));
  const freezes = Math.min(config.streak.freezeCap, base + Math.max(0, granted));
  return { freezes, awarded: freezes - base };
}

/** Full activation outcome: streak continue/break, freeze consumption and rewards. */
export function applyActivation(
  record: ActivationRecord,
  now: number,
  config: DiggoConfig = DIGGO_CONFIG,
): StreakOutcome {
  const window = activationWindow(now, config);
  const previousStreak = Math.max(0, record.streak);
  const base = nextStreak(
    record.lastActivationAt,
    now,
    previousStreak,
    Math.max(0, record.streakFreezes),
    config,
  );

  let kind: StreakOutcomeKind;
  if (record.lastActivationAt === null) kind = "first_activation";
  else if (base.usedFreeze) kind = "freeze_consumed";
  else if (base.streak === 1 && previousStreak > 0) kind = "broken";
  else kind = "continued";

  const { rewards, milestones } = milestoneRewards(previousStreak, base.streak, config);
  const intervalFreezes = freezesEarnedByInterval(previousStreak, base.streak, config);
  const granted = grantFreezes(base.freezes, rewards.freezes + intervalFreezes, config);

  return {
    kind,
    streak: base.streak,
    longestStreak: Math.max(record.longestStreak, base.streak),
    freezes: granted.freezes,
    usedFreeze: base.usedFreeze,
    window,
    milestones,
    rewards: { ...rewards, freezes: granted.awarded },
  };
}

