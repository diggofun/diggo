import { DIGGO_CONFIG, type DiggoConfig, type RewardState } from "./config";
import { crewTotalLevel } from "./crew";
import { V2_BPS } from "./rewardIndex";
import { DISCOVERY_PRICE_SCALE, coinPriceScaled, type V2CoinFacts } from "./rarity";

// ---- v2: eligibility and the reservation a roll charges (design 3.2, 4.2, 4.3) ----------
//
// Mirrors the eligibility rule, the two budget windows and the reservation in
// programs/diggo-protocol/src/{math/rarity.rs, instructions/discovery.rs}. The lamport caps
// are charged at roll creation, while the epoch seed still does not exist, which is what
// makes the scheme safe whatever a wallet knows about the seed before it rolls.

/** Eligibility floors, mirroring the constants in math/rarity.rs. */
export const DISCOVERY_MIN_ACCOUNT_AGE_DAYS = 7;
export const DISCOVERY_MIN_ACTIVE_DAYS = 5;
export const DISCOVERY_MIN_VALID_ACTIVATIONS = 5;
export const DISCOVERY_MIN_TOTAL_CREW_LEVEL = 15;
export const DISCOVERY_MIN_MATURITY_BPS = 5_000;

/** The maturity rungs of MATURITY_RAMP: day, and the bps of full power it unlocks. */
export const MATURITY_RAMP: readonly (readonly [number, number])[] = [
  [1, 2_000],
  [3, 4_000],
  [7, 7_000]
];

export const SECONDS_PER_DAY = 86_400;
export const SECONDS_PER_WEEK = 604_800;

/** How far a wallet's maturity ramp has come, in bps of full power. */
export function discoveryMaturityBps(createdAt: number, now: number): number {
  const ageDays = Math.floor(Math.max(0, now - createdAt) / SECONDS_PER_DAY);
  const lastRung = MATURITY_RAMP[MATURITY_RAMP.length - 1][0];
  if (ageDays > lastRung) return 10_000;
  let bps = 0;
  for (const [day, value] of MATURITY_RAMP) {
    if (ageDays >= day) bps = value;
  }
  return bps;
}

export interface V2DiscoveryPlayer {
  readonly createdAt: number;
  readonly activeDays: number;
  readonly validActivations: number;
  readonly crewLevels: readonly number[];
}

/**
 * The whole on-chain eligibility rule, and it is milestones only: how long the account has existed,
 * how many days it actually played, how many activations it got credit for, how far its crew has
 * come and how mature it is. Holding SOL is not one of the gates - a roll is earned by playing.
 */
export function discoveryIsEligibleV2(player: V2DiscoveryPlayer, now: number): boolean {
  return (
    player.activeDays >= DISCOVERY_MIN_ACTIVE_DAYS &&
    player.validActivations >= DISCOVERY_MIN_VALID_ACTIVATIONS &&
    crewTotalLevel(player.crewLevels) >= DISCOVERY_MIN_TOTAL_CREW_LEVEL &&
    discoveryMaturityBps(player.createdAt, now) >= DISCOVERY_MIN_MATURITY_BPS
  );
}

export function discoveryDayIndex(now: number): number {
  return Math.floor(Math.max(0, now) / SECONDS_PER_DAY) % 65_536;
}

export function discoveryWeekIndex(now: number): number {
  return Math.floor(Math.max(0, now) / SECONDS_PER_WEEK) % 65_536;
}

/**
 * The largest value one discovery on this coin could pay right now, which is what a roll
 * reserves at creation: the top live tier's value class, clamped by every token-side ceiling
 * the coin carries and priced at the coin's own price. Null when the coin has no price.
 */
export function discoveryReservationLamports(
  tiers: readonly { readonly valueLamports: bigint }[],
  discoveryMaxBps: number,
  coin: V2CoinFacts
): bigint | null {
  let top = 0n;
  for (const tier of tiers) {
    if (tier.valueLamports > top) top = tier.valueLamports;
  }
  if (top === 0n) return 0n;
  const price = coinPriceScaled(coin);
  if (price === null) return null;
  let ceiling = (coin.discoveryReserveTotal * BigInt(discoveryMaxBps)) / V2_BPS;
  if (ceiling > coin.discoveryRemaining) ceiling = coin.discoveryRemaining;
  const epochRemaining =
    coin.discoveryEpochBudget > coin.discoveryEpochSpent
      ? coin.discoveryEpochBudget - coin.discoveryEpochSpent
      : 0n;
  if (ceiling > epochRemaining) ceiling = epochRemaining;
  const valueCeiling = (ceiling * price) / DISCOVERY_PRICE_SCALE;
  return top < valueCeiling ? top : valueCeiling;
}

export type V2DiscoveryCapReason = "ok" | "daily" | "weekly";

/**
 * The account-side caps, checked against a reservation before the roll is created. The
 * protocol-wide day is a separate GlobalBudget account, keyed by day index.
 */
export function discoveryAccountCapCheck(
  spentDayLamports: bigint,
  spentWeekLamports: bigint,
  reservationLamports: bigint,
  dailyCapLamports: bigint,
  weeklyCapLamports: bigint
): V2DiscoveryCapReason {
  if (spentDayLamports + reservationLamports > dailyCapLamports) return "daily";
  if (spentWeekLamports + reservationLamports > weeklyCapLamports) return "weekly";
  return "ok";
}

export function discoveryWindowReset(
  dayIndex: number,
  weekIndex: number,
  spentDayLamports: bigint,
  spentWeekLamports: bigint,
  now: number
): {
  readonly dayIndex: number;
  readonly weekIndex: number;
  readonly spentDayLamports: bigint;
  readonly spentWeekLamports: bigint;
} {
  const day = discoveryDayIndex(now);
  const week = discoveryWeekIndex(now);
  const dayRolled = dayIndex !== day;
  const weekRolled = weekIndex !== week;
  return {
    dayIndex: day,
    weekIndex: week,
    spentDayLamports: dayRolled ? 0n : spentDayLamports,
    spentWeekLamports: weekRolled ? 0n : spentWeekLamports
  };
}

/**
 * Discovery eligibility and multi-level budget caps (spec 44, 45, 54, 64).
 *
 * Real-value discoveries are the most security sensitive subsystem, so they are
 * gated on account time, valid play, progression, maturity and risk state, and
 * then further limited by per-account, per-token and global budgets. Reason
 * codes are returned for internal logging and must never be surfaced verbatim
 * to clients (spec 62).
 */

export type DiscoveryIneligibleReason =
  | "account_too_new"
  | "insufficient_active_days"
  | "insufficient_valid_activations"
  | "crew_tier_too_low"
  | "maturity_below_minimum"
  | "risk_state_not_normal"
  | "abuse_flags_present";

export interface DiscoveryEligibilityInput {
  accountAgeSeconds: number;
  activeDays: number;
  validActivations: number;
  crewTier: number;
  maturityBps: number;
  riskState: RewardState;
  abuseFlags: number;
}

export interface DiscoveryEligibilityResult {
  eligible: boolean;
  reasons: DiscoveryIneligibleReason[];
  /** Account age required before the age gate opens. */
  requiredAccountAgeSeconds: number;
  /** Configured minimums, echoed for admin views. */
  requiredActiveDays: number;
  requiredValidActivations: number;
  requiredCrewTier: number;
}

export function discoveryEligibility(
  input: DiscoveryEligibilityInput,
  config: DiggoConfig = DIGGO_CONFIG,
): DiscoveryEligibilityResult {
  const rules = config.discovery;
  const requiredAccountAgeSeconds = rules.minimumAccountAgeDays * config.time.secondsPerDay;
  const reasons: DiscoveryIneligibleReason[] = [];
  if (input.accountAgeSeconds < requiredAccountAgeSeconds) reasons.push("account_too_new");
  if (input.activeDays < rules.minimumActiveDays) reasons.push("insufficient_active_days");
  if (input.validActivations < rules.minimumValidActivations) {
    reasons.push("insufficient_valid_activations");
  }
  if (input.crewTier < rules.minimumCrewTier) reasons.push("crew_tier_too_low");
  if (input.maturityBps < rules.minimumMaturityBps) reasons.push("maturity_below_minimum");
  if (input.riskState !== "NORMAL") reasons.push("risk_state_not_normal");
  if (input.abuseFlags > 0) reasons.push("abuse_flags_present");
  return {
    eligible: reasons.length === 0,
    reasons,
    requiredAccountAgeSeconds,
    requiredActiveDays: rules.minimumActiveDays,
    requiredValidActivations: rules.minimumValidActivations,
    requiredCrewTier: rules.minimumCrewTier,
  };
}

/**
 * Legacy three-signal gate kept for existing call sites; prefer
 * discoveryEligibility for the full rule set.
 */
export function discoveryEligible(
  accountAgeSeconds: number,
  activeDays: number,
  crewTier: number,
  config: DiggoConfig = DIGGO_CONFIG,
): boolean {
  const rules = config.discovery;
  return (
    accountAgeSeconds >= rules.minimumAccountAgeDays * config.time.secondsPerDay &&
    activeDays >= rules.minimumActiveDays &&
    crewTier >= rules.minimumCrewTier
  );
}

export type DiscoveryCapReason =
  | "account_daily_cap"
  | "account_weekly_cap"
  | "token_daily_cap"
  | "token_period_cap"
  | "global_daily_cap"
  | "per_request_cap"
  | "no_budget_left"
  | "circuit_breaker_open";

export interface DiscoveryUsage {
  accountDailyUsd: number;
  accountWeeklyUsd: number;
  tokenDailyUsd: number;
  tokenPeriodUsd: number;
  globalDailyUsd: number;
}

export interface DiscoveryBudgetRequest {
  requestedUsd: number;
  /** Circuit breaker (spec 65): pauses new discoveries without stopping trading. */
  circuitBreakerOpen?: boolean;
}

export interface DiscoveryBudgetResult {
  allowed: boolean;
  /** The binding cap, for internal logging only. */
  reason: DiscoveryCapReason | null;
  /** Largest value currently permitted; 0 when nothing can be paid out. */
  maxAllowedUsd: number;
  headroom: Readonly<Record<Exclude<DiscoveryCapReason, "no_budget_left" | "circuit_breaker_open">, number>>;
}

function headroom(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * How much of a cap value parked in HELD (granted, under review, not released) may reserve.
 *
 * Held value is a real promise, so it has to count against the budget the same way a pending grant
 * does - otherwise a review queue is a way to spend the day's allowance twice. But an account under
 * review can hold a large amount of it, and counting it in full lets a held farm commit every cap
 * and deny ordinary players their own budget. The compromise is a ceiling: held value counts up to
 * `heldBudgetShareBps` of each cap and no further, so a review backlog can never reserve more than
 * its configured share of what the caps allow (spec 45, 64).
 *
 * Non-finite and negative inputs count as zero, so a corrupt row cannot inflate or deflate usage.
 */
export function heldUsageCountedUsd(
  heldUsd: number,
  capUsd: number,
  config: DiggoConfig = DIGGO_CONFIG,
): number {
  const held = headroom(heldUsd);
  const cap = headroom(capUsd);
  if (held <= 0 || cap <= 0) return 0;
  const share = config.discovery.heldBudgetShareBps / 10_000;
  if (!Number.isFinite(share) || share <= 0) return 0;
  return Math.min(held, cap * Math.min(1, share));
}

export function discoveryBudgetRemaining(
  usage: DiscoveryUsage,
  config: DiggoConfig = DIGGO_CONFIG,
): number {
  const rules = config.discovery;
  return Math.max(
    0,
    Math.min(
      rules.accountDailyCapUsd - usage.accountDailyUsd,
      rules.accountWeeklyCapUsd - usage.accountWeeklyUsd,
      rules.tokenDailyCapUsd - usage.tokenDailyUsd,
      rules.tokenPeriodCapUsd - usage.tokenPeriodUsd,
      rules.globalDailyCapUsd - usage.globalDailyUsd,
      rules.perRequestCapUsd,
    ),
  );
}

export function discoveryBudgetCheck(
  usage: DiscoveryUsage,
  request: DiscoveryBudgetRequest,
  config: DiggoConfig = DIGGO_CONFIG,
): DiscoveryBudgetResult {
  const rules = config.discovery;
  const caps = {
    account_daily_cap: headroom(rules.accountDailyCapUsd - usage.accountDailyUsd),
    account_weekly_cap: headroom(rules.accountWeeklyCapUsd - usage.accountWeeklyUsd),
    token_daily_cap: headroom(rules.tokenDailyCapUsd - usage.tokenDailyUsd),
    token_period_cap: headroom(rules.tokenPeriodCapUsd - usage.tokenPeriodUsd),
    global_daily_cap: headroom(rules.globalDailyCapUsd - usage.globalDailyUsd),
    per_request_cap: headroom(rules.perRequestCapUsd),
  } as const;

  let binding: keyof typeof caps = "per_request_cap";
  let maxAllowedUsd = Number.POSITIVE_INFINITY;
  for (const key of Object.keys(caps) as (keyof typeof caps)[]) {
    if (caps[key] < maxAllowedUsd) {
      maxAllowedUsd = caps[key];
      binding = key;
    }
  }

  if (request.circuitBreakerOpen === true) {
    return { allowed: false, reason: "circuit_breaker_open", maxAllowedUsd: 0, headroom: caps };
  }
  const requested = Number.isFinite(request.requestedUsd) ? request.requestedUsd : 0;
  if (maxAllowedUsd <= 0) {
    return { allowed: false, reason: "no_budget_left", maxAllowedUsd: 0, headroom: caps };
  }
  if (requested <= 0 || requested > maxAllowedUsd) {
    return { allowed: false, reason: binding, maxAllowedUsd, headroom: caps };
  }
  return { allowed: true, reason: null, maxAllowedUsd, headroom: caps };
}
