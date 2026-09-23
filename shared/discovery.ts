import { DIGGO_CONFIG, type DiggoConfig, type RewardState } from "./config";

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

