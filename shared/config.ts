/**
 * Central Diggo configuration.
 *
 * Every gameplay, economic and anti-abuse parameter lives here with a default.
 * No other module hardcodes magic numbers: functions accept an optional
 * DiggoConfig argument that defaults to DIGGO_CONFIG.
 *
 * DIGGO_CONFIG is deeply frozen. Use createDiggoConfig(overrides) to derive a
 * tuned config (tests, per-environment tuning) without mutating the defaults.
 *
 * Deployment-time tuning goes through configFromEnv(), the single override layer
 * between the frozen defaults and a Worker environment: an operator tunes
 * parameters with environment variables, and every value is clamped to a sane
 * range here rather than trusted at the call site (spec 15, 80).
 */

export const BPS_DENOMINATOR = 10_000;

export type DeepPartial<T> = T extends readonly (infer U)[]
  ? readonly DeepPartial<U>[]
  : T extends object
    ? { readonly [K in keyof T]?: DeepPartial<T[K]> }
    : T;

export type CrewComponent = "miners" | "drills" | "carts" | "foreman" | "storage";

export interface CrewLevels {
  miners: number;
  drills: number;
  carts: number;
  foreman: number;
  storage: number;
}

export type DiscoveryRarity = "common" | "uncommon" | "rare" | "epic" | "legendary" | "mythic";

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH";

export type RewardState = "NORMAL" | "UNDER_REVIEW" | "HELD" | "BLOCKED";

/**
 * Progressive anti-abuse responses, in escalation order (spec 63). "ban" is only
 * reachable with strong multi-signal evidence.
 */
export type RiskResponse =
  | "observe"
  | "rate_limit"
  | "challenge"
  | "discovery_restrict"
  | "hold"
  | "review"
  | "ban";

export type RiskSignalName =
  | "walletsPerDeviceCluster"
  | "accountsPerNetworkCluster"
  | "activationTimingRegularity"
  | "activationSynchrony"
  | "burstActions"
  | "switchingPatternSimilarity"
  | "claimBurst"
  | "creationCluster"
  | "linkedAbuseHistory";

export type OreSource =
  | "active_mine"
  | "activation"
  | "streak_milestone"
  | "achievement"
  | "level_up"
  | "quest"
  | "season";

export interface TimeConfig {
  secondsPerMinute: number;
  secondsPerHour: number;
  secondsPerDay: number;
  secondsPerWeek: number;
}

export interface StreakMilestoneConfig {
  day: number;
  ore: number;
  xp: number;
  badges: readonly string[];
  titles: readonly string[];
  freezes: number;
}

export interface StreakConfig {
  activationSeconds: number;
  graceSeconds: number;
  minimumReactivationSeconds: number;
  /** Hard cap on banked Streak Freezes. */
  freezeCap: number;
  freezeEarnIntervalDays: number;
  /** How many extra missed activation windows a single freeze can cover. */
  freezeCoveredWindows: number;
  milestones: readonly StreakMilestoneConfig[];
}

export interface MaturityRampPoint {
  /** The maturity band applies while account age in days is strictly below this value. */
  upToDay: number;
  bps: number;
}

/**
 * Price-oracle bounds (worker/oracle.ts): how long a quote may be cached, how stale an observation
 * may be before it stops counting, and how much external corroboration a price needs.
 */
export interface OracleConfig {
  quoteTtlSeconds: number;
  solTtlSeconds: number;
  maxStalenessSeconds: number;
  freshSeconds: number;
  minimumConfidence: number;
  minimumExternalSources: number;
  externalRefreshSeconds: number;
  fetchTimeoutMs: number;
}

/**
 * Generic ramp lookup for maturity-style curves (spec 40, 42, 58): the first band whose
 * `upToDay` is greater than the age wins, so a ramp always ends in an
 * `upToDay: Number.POSITIVE_INFINITY` band.
 */
export function rampBps(ramp: readonly MaturityRampPoint[], days: number): number {
  if (!Number.isFinite(days) || days < 0 || ramp.length === 0) return 0;
  for (const point of ramp) {
    if (days < point.upToDay) return point.bps;
  }
  return ramp[ramp.length - 1].bps;
}

export interface OreConfig {
  baseOrePerActiveHour: number;
  activationBonusOre: number;
  maturityRamp: readonly MaturityRampPoint[];
  /** Carts are the logistics branch: ORE efficiency, never mining power. */
  cartsEfficiencyGain: number;
  cartsEfficiencyScale: number;
  /** Foreman is the organisation branch: ORE efficiency and cheaper upgrades. */
  foremanEfficiencyGain: number;
  foremanEfficiencyScale: number;
  /** Storage is the offline branch: ORE capacity plus offline hours. */
  storageBaseCapacity: number;
  storageCapacityScale: number;
  storageCapacityExponent: number;
  cartsCapacityScale: number;
  offlineHoursBase: number;
  offlineHoursPerStorageLevel: number;
  offlineHoursCap: number;
  levelUpBaseOre: number;
  levelUpOrePerLevel: number;
  levelUpOreExponent: number;
  achievementOre: Readonly<Record<string, number>>;
  /** Quest and season grants are supplied per event but always capped here. */
  questOreCap: number;
  seasonOreCap: number;
  /** A single accrual window is clamped to this many seconds (one activation). */
  maxAccrualSeconds: number;
}

export interface CrewTierConfig {
  tier: number;
  name: string;
  minTotalLevel: number;
}

export interface CrewConfig {
  minLevel: number;
  /** Levels run minLevel..maxLevel; maxLevel cannot be upgraded past. */
  maxLevel: number;
  starterLevels: CrewLevels;
  starterPower: number;
  /** Sub-linear miners curve: the main source of diminishing returns (spec 12). */
  minerPowerExponent: number;
  /** Drills multiply Miner output instead of adding flat power (spec 10). */
  drillEfficiencyGain: number;
  drillEfficiencyScale: number;
  /** Foreman reduces upgrade costs, it does not add mining power (spec 10). */
  foremanDiscountGain: number;
  foremanDiscountScale: number;
  minimumUpgradeCostMultiplier: number;
  upgradeCostBase: Readonly<Record<CrewComponent, number>>;
  upgradeCostExponent: number;
  upgradeCostMaxLevel: number;
  /** Bound on a max-level crew versus a starter crew (spec 12). */
  maxVeteranPowerRatio: number;
  tiers: readonly CrewTierConfig[];
}

export interface EconomyConfig {
  /** How a mine's block reward is scheduled down over its life (spec 21). */
  emission: EmissionConfig;
  rewardReductionBps: number;
  minimumReducedReward: number;
  /** Fixed-point scale for the cumulative reward index (spec 17). */
  rewardIndexScale: number;
  /** Block rewards are capped at the remaining reserve (spec 19, 20). */
  enforceReserveCap: boolean;
}

/**
 * How a mine's block reward is scheduled (spec 20, 21).
 *
 * `reserve_runway` (the default) derives each epoch's block reward from the reserve that is still
 * inside the mine: the remaining reserve is paid out evenly over the blocks left of the configured
 * target lifetime, never above the reward declared at launch and never above the epoch before it,
 * with a floor that keeps paying until the reserve is empty. That is what makes the whole Mining
 * Reserve distributable whatever the launch parameters are - a fixed geometric decay reaches a
 * hard cap (epochs x epoch length of reward) and then sits on locked tokens forever.
 *
 * `epoch_reduction` is the legacy fixed-percentage step (spec 21's 10,000 -> 7,500 -> 5,625
 * example), kept for mines that want a pure decay curve. It cannot promise that a reserve is fully
 * distributable, which is why it is not the default.
 */
export type EmissionScheduleKind = "reserve_runway" | "epoch_reduction";

export interface EmissionConfig {
  schedule: EmissionScheduleKind;
  /** Days over which one mine's whole Mining Reserve is meant to be distributed. */
  targetLifetimeDays: number;
  /**
   * Floor on the scheduled block reward, applied until the reserve is exhausted. It is what stops
   * the schedule from decaying towards zero and never reaching FULLY_MINED.
   */
  minimumRewardPerBlock: number;
  /** A scheduled reward never exceeds the reward the mine declared at launch. */
  /**
   * The scheduled reward never rises from one epoch to the next. A mine that sat idle longer than
   * planned therefore stretches its runway instead of paying a catch-up burst; either way the
   * tokens stay in the reserve and the floor keeps them distributable (spec 21).
   */
  nonIncreasing: boolean;
}

export interface ClusterDampingConfig {
  /** Wallets one device may hold before damping starts (a household is not a farm). */
  deviceAllowance: number;
  /** Share of the previous factor each further wallet on the same device keeps, in bps. */
  deviceDecayBps: number;
  /** Wallets one network environment may hold before damping starts. */
  networkAllowance: number;
  /** Share of the previous factor each further wallet on the same network keeps, in bps. */
  networkDecayBps: number;
  /**
   * Floor on the network factor alone, independent of the combined floor. A big honest network - a
   * dorm, an office, a carrier-grade NAT - is slowed, never crippled, by an address cluster that no
   * single person controls (spec 48, 51).
   */
  minimumNetworkFactorBps: number;
  /** Floor on the combined factor: a cluster is throttled hard but never zeroed (spec 63). */
  minimumFactorBps: number;
}

/**
 * How much of its crew's Mining Power an account actually brings to a block (spec 40, 53, 58, 61,
 * 64): the account-maturity ramp, the device/network cluster damping read from the existing
 * cluster signals, and a per-account ceiling on one block's eligible power.
 *
 * All three are applied when a position is armed, which is the only moment a cumulative reward
 * index can apply them: the armed power *is* the block share.
 */
export interface EffectivePowerConfig {
  maturityRamp: readonly MaturityRampPoint[];
  /**
   * Largest share of one block's eligible power one *cluster* may hold, in bps (0 disables it),
   * measured against the power the mine carries outside that cluster (shared/crew.ts
   * effectiveMiningPower). It is a cluster ceiling rather than a per-account one so that splitting
   * a farm across more wallets cannot compound it.
   */
  perAccountBlockShareCapBps: number;
  /**
   * Power the share cap never cuts a cluster below, before it is divided over the cluster's
   * wallets. It sits above the strongest reachable crew, so the ceiling is inert for one account
   * however strong that account is - a small or brand-new mine is left alone, and only a cluster is
   * ever bounded (spec 63). `shared/crew.test.ts` pins that relationship, so moving the crew curve
   * cannot silently turn this floor into a per-crew ceiling.
   */
  shareCapFloorPower: number;
  cluster: ClusterDampingConfig;
}

export interface DiscoveryConfig {
  minimumMarketCapUsd: number;
  minimumLiquidityUsd: number;
  minimumVolume24hUsd: number;
  minimumPriceConfidence: number;
  minimumAccountAgeDays: number;
  minimumActiveDays: number;
  minimumValidActivations: number;
  minimumCrewTier: number;
  minimumMaturityBps: number;
  accountDailyCapUsd: number;
  accountWeeklyCapUsd: number;
  tokenDailyCapUsd: number;
  tokenPeriodCapUsd: number;
  tokenPeriodSeconds: number;
  globalDailyCapUsd: number;
  /** No single discovery request may exceed this USD value (spec 64). */
  perRequestCapUsd: number;
  activityWindowSeconds: number;
  cappedRarityByBudget: boolean;
  /**
   * Share of each discovery cap, in basis points, that grants parked in HELD (under review, not yet
   * released) may reserve. Held value is real value the backend has promised, so it has to count -
   * but without this ceiling a held farm could commit the whole daily budget and starve ordinary
   * players of it (spec 45, 64).
   */
  heldBudgetShareBps: number;
  /**
   * How long a HELD discovery keeps its share of the budget without being cleared. On expiry the
   * grant is released: it stops counting against every cap and is marked REJECTED, so an unresolved
   * review cannot hold a budget slot (or the reward) open indefinitely (spec 53, 64).
   */
  heldGrantReviewSeconds: number;
  /**
   * Length of one discovery opportunity window in seconds (spec 56). Bounded by
   * DISCOVERY_TUNABLE_BOUNDS.windowSeconds; override with DISCOVERY_WINDOW_SECONDS.
   */
  windowSeconds: number;
  /**
   * Chance in basis points that an eligible active window yields a discovery. Bounded by
   * DISCOVERY_TUNABLE_BOUNDS.rollChanceBps; override with DISCOVERY_ROLL_CHANCE_BPS.
   */
  rollChanceBps: number;
}

export interface RarityTierConfig {
  rarity: DiscoveryRarity;
  /** Cumulative probability upper bound in [0, 1), rolled against a uniform draw. */
  cumulativeChance: number;
  /** Target USD-equivalent value of the reward before caps are applied. */
  valueUsd: number;
  minEligibilityScore: number;
  minLiquidityUsd: number;
  minVolume24hUsd: number;
}

export interface RarityEligibilityWeights {
  liquidity: number;
  volume: number;
  activity: number;
  health: number;
  reserve: number;
  priceConfidence: number;
}

export interface RobustPriceConfig {
  lookbackSeconds: number;
  minimumSamples: number;
  maxDeviationBps: number;
  volumeWeighted: boolean;
}

export interface RarityConfig {
  tiers: readonly RarityTierConfig[];
  weights: RarityEligibilityWeights;
  references: {
    liquidityUsd: number;
    volume24hUsd: number;
    tradeCount24h: number;
    reserveUsd: number;
  };
  healthFlagPenalty: number;
  robustPrice: RobustPriceConfig;
  amountDecimals: number;
}

export interface RiskSignalConfig {
  weight: number;
  /** Raw signal value at which the signal contributes its full weight. */
  saturation: number;
  /**
   * Raw value at or above which the signal counts as strong, corroborating
   * evidence. Below this value the signal is weak evidence.
   */
  strongAt: number;
}

export interface RiskResponseConfig {
  minScore: number;
  response: RiskResponse;
}

export interface TrustConfig {
  weights: {
    age: number;
    validActivations: number;
    streakConsistency: number;
    validClaims: number;
    absenceOfAbuse: number;
  };
  fullAgeDays: number;
  fullValidActivations: number;
  fullValidClaims: number;
  abuseFlagsForZeroTrust: number;
  /**
   * Documented invariant: SOL balance is never a trust input (spec 60).
   */
  solBalanceIsNotAnInput: boolean;
}

export interface RiskConfig {
  signals: Readonly<Record<RiskSignalName, RiskSignalConfig>>;
  /** A single weak signal can never push an account above this score. */
  weakEvidenceScoreCeiling: number;
  maxSingleWeakSignalScore: number;
  lowMaxScore: number;
  mediumMaxScore: number;
  banMinimumStrongSignals: number;
  banMinimumScore: number;
  responses: readonly RiskResponseConfig[];
  rewardStates: Readonly<Record<RiskLevel, RewardState>>;
  /** Neutral, detail-free user-facing copy (spec 62). */
  publicStatus: Readonly<Record<RewardState, string>>;
  trust: TrustConfig;
}

export interface DiggoConfig {
  time: TimeConfig;
  /** Price-oracle freshness, cache and confidence bounds (worker/oracle.ts). */
  oracle: OracleConfig;
  streak: StreakConfig;
  ore: OreConfig;
  crew: CrewConfig;
  economy: EconomyConfig;
  effectivePower: EffectivePowerConfig;
  discovery: DiscoveryConfig;
  rarity: RarityConfig;
  risk: RiskConfig;
  /** Curve-phase mining and the windows the indexed 24h metrics are measured over. */
  curve: CurveMiningConfig;
}

/**
 * Curve-phase mining: mining works from the launch block, and before graduation its block
 * rewards are paid out of the market's own curve token inventory instead of the mine's
 * Mining Reserve (see shared/curve.ts).
 *
 * The share and the runway are per-launch parameters — a launcher picks them for each mine —
 * so these are the defaults a launch that does not pick gets, plus the bounds the program
 * enforces. They mirror the program's own constants, and shared/curve.test.ts pins that they
 * have not drifted, because a default the program would reject is a launch that cannot land.
 */
export interface CurveMiningConfig {
  /** Default share of a curve's initial token inventory that pre-graduation mining may emit. */
  defaultMiningBps: number;
  /** Hard ceiling on that share; the program validates the same bound at launch. */
  maxMiningBps: number;
  /** Default runway, in whole days, over which the curve budget is spread. */
  defaultRunwayDays: number;
  /** Longest runway a launch may ask for. */
  maxRunwayDays: number;
  /**
   * How old a price observation must be before it may back a reported 24h change. Because
   * the sampler runs every few minutes rather than exactly on the hour, this is a whole day
   * minus an hour of slack rather than a whole day exactly: a baseline that is only 23 hours
   * old still describes real 24h-scale movement, and refusing it would report nothing at all
   * on a token whose history is sampled on a schedule.
   */
  changeBaselineSeconds: number;
  /** The window the indexed 24h volume and trade count are measured over. */
  volumeWindowSeconds: number;
}

export const DIGGO_CONFIG_DEFAULTS: DiggoConfig = {
  time: {
    secondsPerMinute: 60,
    secondsPerHour: 3_600,
    secondsPerDay: 86_400,
    secondsPerWeek: 604_800,
  },
  // The price oracle's bounds live here with every other tunable, so one config object describes the
  // whole economy: a deployment cannot be running an oracle policy nobody can see from DIGGO_CONFIG.
  oracle: {
    /** How long a combined quote may be served from cache. */
    quoteTtlSeconds: 60,
    /** How long a SOL/USD read may be served from cache. */
    solTtlSeconds: 120,
    /** Hard staleness limit for a single source observation. */
    maxStalenessSeconds: 900,
    /** Age up to which an observation counts as fully fresh. */
    freshSeconds: 300,
    /** Confidence below which no price is returned. */
    minimumConfidence: 0.6,
    /** Default external-source requirement; 0 keeps a credential-less deployment working. */
    minimumExternalSources: 0,
    /** Do not re-fetch one mint's external quote more often than this. */
    externalRefreshSeconds: 120,
    /** Timeout for one third-party call. */
    fetchTimeoutMs: 4_000,
  },
  streak: {
    activationSeconds: 86_400,
    graceSeconds: 43_200,
    minimumReactivationSeconds: 72_000,
    freezeCap: 3,
    freezeEarnIntervalDays: 7,
    freezeCoveredWindows: 1,
    milestones: [
      { day: 3, ore: 75, xp: 25, badges: ["FIRST_STEPS"], titles: [], freezes: 0 },
      { day: 7, ore: 250, xp: 75, badges: ["WEEK_ONE"], titles: ["Steady Digger"], freezes: 0 },
      { day: 14, ore: 500, xp: 150, badges: ["FORTNIGHT"], titles: [], freezes: 0 },
      { day: 30, ore: 1_200, xp: 350, badges: ["MONTH_ONE"], titles: ["Foreman Material"], freezes: 1 },
      { day: 60, ore: 2_500, xp: 700, badges: ["TWO_MONTHS"], titles: [], freezes: 0 },
      { day: 100, ore: 5_000, xp: 1_200, badges: ["CENTURY"], titles: ["Century Miner"], freezes: 1 },
      { day: 365, ore: 25_000, xp: 5_000, badges: ["YEAR_ONE"], titles: ["Legendary Diggo"], freezes: 3 },
    ],
  },
  ore: {
    baseOrePerActiveHour: 30,
    activationBonusOre: 50,
    maturityRamp: [
      { upToDay: 1, bps: 2_000 },
      { upToDay: 3, bps: 3_500 },
      { upToDay: 7, bps: 5_000 },
      { upToDay: Number.POSITIVE_INFINITY, bps: 10_000 },
    ],
    cartsEfficiencyGain: 0.35,
    cartsEfficiencyScale: 14,
    foremanEfficiencyGain: 0.2,
    foremanEfficiencyScale: 18,
    storageBaseCapacity: 1_800,
    storageCapacityScale: 420,
    storageCapacityExponent: 0.78,
    cartsCapacityScale: 120,
    offlineHoursBase: 24,
    offlineHoursPerStorageLevel: 4,
    offlineHoursCap: 168,
    levelUpBaseOre: 60,
    levelUpOrePerLevel: 1.25,
    levelUpOreExponent: 1,
    achievementOre: {
      FIRST_ACTIVATION: 25,
      FIRST_BLOCK: 40,
      TEN_BLOCKS: 120,
      FIRST_DISCOVERY: 200,
      CREW_TIER_3: 400,
      FIRST_MINE_SWITCH: 60,
      FULLY_MINED_WITNESS: 300,
    },
    questOreCap: 5_000,
    seasonOreCap: 25_000,
    maxAccrualSeconds: 86_400,
  },
  crew: {
    minLevel: 1,
    maxLevel: 100,
    starterLevels: { miners: 2, drills: 1, carts: 1, foreman: 1, storage: 1 },
    starterPower: 100,
    minerPowerExponent: 0.62,
    drillEfficiencyGain: 0.3,
    drillEfficiencyScale: 12,
    foremanDiscountGain: 0.3,
    foremanDiscountScale: 15,
    minimumUpgradeCostMultiplier: 0.4,
    upgradeCostBase: { miners: 80, drills: 115, carts: 120, foreman: 190, storage: 150 },
    upgradeCostExponent: 1.4,
    upgradeCostMaxLevel: 100,
    maxVeteranPowerRatio: 25,
    tiers: [
      { tier: 1, name: "Backyard Diggers", minTotalLevel: 5 },
      { tier: 2, name: "Small Mining Crew", minTotalLevel: 15 },
      { tier: 3, name: "Industrial Crew", minTotalLevel: 35 },
      { tier: 4, name: "Deep Mine Division", minTotalLevel: 75 },
      { tier: 5, name: "Mega Mining Operation", minTotalLevel: 150 },
      { tier: 6, name: "Legendary Diggo Crew", minTotalLevel: 300 },
    ],
  },
  economy: {
    emission: {
      schedule: "reserve_runway",
      targetLifetimeDays: 365,
      minimumRewardPerBlock: 1,
      nonIncreasing: true,
    },
    rewardReductionBps: 2_500,
    minimumReducedReward: 1,
    rewardIndexScale: 1_000_000_000_000,
    enforceReserveCap: true,
  },
  // Time is the anti-sybil resource (spec 40, 58): a wallet that was created a minute ago brings a
  // fifth of its crew's power to a block, and a wallet sitting in a large device cluster brings a
  // fifth of that again. Neither is a paywall (spec 41) and neither is permanent (spec 63).
  effectivePower: {
    maturityRamp: [
      { upToDay: 1, bps: 2_000 },
      { upToDay: 3, bps: 4_000 },
      { upToDay: 7, bps: 7_000 },
      { upToDay: Number.POSITIVE_INFINITY, bps: 10_000 },
    ],
    perAccountBlockShareCapBps: 200,
    // Above the strongest reachable crew: a maxed veteran (every branch at maxLevel) brings 2,259
    // power, so a cluster ceiling with this floor can never shrink a single crew.
    // Above the strongest reachable crew: a maxed veteran (every branch at maxLevel) brings 2,259
    // power, so a cluster ceiling with this floor can never shrink a single crew.
    shareCapFloorPower: 2_500,
  cluster: {
      deviceAllowance: 4,
      // A household keeps its whole share; each further wallet on one device keeps 60% of what the
      // previous one kept, so a farm quickly lands on the floor. The network allowance is generous
      // on purpose: a dorm, an office or a carrier-grade NAT must never be throttled hard, so the
      // network factor only bites for genuinely large address clusters (spec 48, 51, 64).
      deviceDecayBps: 7_000,
      networkAllowance: 50,
      networkDecayBps: 9_700,
      minimumNetworkFactorBps: 5_000,
      minimumFactorBps: 150,
    },
  },
  discovery: {
    minimumMarketCapUsd: 250_000,
    minimumLiquidityUsd: 10_000,
    minimumVolume24hUsd: 5_000,
    minimumPriceConfidence: 0.6,
    minimumAccountAgeDays: 7,
    minimumActiveDays: 5,
    minimumValidActivations: 5,
    minimumCrewTier: 2,
    minimumMaturityBps: 5_000,
    accountDailyCapUsd: 0.5,
    accountWeeklyCapUsd: 2.5,
    tokenDailyCapUsd: 25,
    tokenPeriodCapUsd: 100,
    tokenPeriodSeconds: 604_800,
    globalDailyCapUsd: 500,
    perRequestCapUsd: 20,
    activityWindowSeconds: 86_400,
    cappedRarityByBudget: true,
    // A fifth of every cap at most: enough for a genuine review queue, far too little for a held
    // farm to lock up the day (or the week) for everyone else.
    heldBudgetShareBps: 2_000,
    // One day: long enough for a review to be worked, short enough that an uncleared hold stops
    // reserving the weekly and per-token-period budgets on day two.
    heldGrantReviewSeconds: 86_400,
    windowSeconds: 3_600,
    rollChanceBps: 250,
  },
  rarity: {
    tiers: [
      { rarity: "common", cumulativeChance: 0.7, valueUsd: 0.05, minEligibilityScore: 0, minLiquidityUsd: 0, minVolume24hUsd: 0 },
      { rarity: "uncommon", cumulativeChance: 0.9, valueUsd: 0.15, minEligibilityScore: 20, minLiquidityUsd: 2_500, minVolume24hUsd: 500 },
      { rarity: "rare", cumulativeChance: 0.97, valueUsd: 0.5, minEligibilityScore: 40, minLiquidityUsd: 10_000, minVolume24hUsd: 2_500 },
      { rarity: "epic", cumulativeChance: 0.995, valueUsd: 1.5, minEligibilityScore: 60, minLiquidityUsd: 50_000, minVolume24hUsd: 10_000 },
      { rarity: "legendary", cumulativeChance: 0.9995, valueUsd: 5, minEligibilityScore: 80, minLiquidityUsd: 250_000, minVolume24hUsd: 50_000 },
      { rarity: "mythic", cumulativeChance: 1, valueUsd: 20, minEligibilityScore: 92, minLiquidityUsd: 1_000_000, minVolume24hUsd: 200_000 },
    ],
    weights: {
      liquidity: 0.25,
      volume: 0.2,
      activity: 0.15,
      health: 0.15,
      reserve: 0.15,
      priceConfidence: 0.1,
    },
    references: {
      liquidityUsd: 250_000,
      volume24hUsd: 100_000,
      tradeCount24h: 500,
      reserveUsd: 5_000,
    },
    healthFlagPenalty: 0.25,
    robustPrice: {
      lookbackSeconds: 3_600,
      minimumSamples: 3,
      maxDeviationBps: 1_500,
      volumeWeighted: true,
    },
    amountDecimals: 6,
  },
  risk: {
    signals: {
      walletsPerDeviceCluster: { weight: 18, saturation: 25, strongAt: 50 },
      accountsPerNetworkCluster: { weight: 14, saturation: 40, strongAt: 200 },
      activationTimingRegularity: { weight: 12, saturation: 1, strongAt: 1.5 },
      activationSynchrony: { weight: 14, saturation: 1, strongAt: 0.98 },
      burstActions: { weight: 12, saturation: 20, strongAt: 120 },
      switchingPatternSimilarity: { weight: 10, saturation: 1, strongAt: 1.5 },
      claimBurst: { weight: 12, saturation: 15, strongAt: 120 },
      creationCluster: { weight: 12, saturation: 20, strongAt: 150 },
      linkedAbuseHistory: { weight: 30, saturation: 1, strongAt: 0.5 },
    },
    weakEvidenceScoreCeiling: 60,
    maxSingleWeakSignalScore: 20,
    lowMaxScore: 25,
    mediumMaxScore: 60,
    banMinimumStrongSignals: 2,
    banMinimumScore: 90,
    responses: [
      { minScore: 0, response: "observe" },
      { minScore: 20, response: "rate_limit" },
      { minScore: 35, response: "challenge" },
      { minScore: 45, response: "discovery_restrict" },
      { minScore: 70, response: "hold" },
      { minScore: 82, response: "review" },
      { minScore: 90, response: "ban" },
    ],
    rewardStates: {
      LOW: "NORMAL",
      MEDIUM: "UNDER_REVIEW",
      HIGH: "HELD",
    },
    publicStatus: {
      NORMAL: "Everything looks normal.",
      UNDER_REVIEW: "Additional verification required.",
      HELD: "Rewards are being reviewed before they can be collected.",
      BLOCKED: "Rewards are temporarily unavailable for this account.",
    },
    trust: {
      weights: {
        age: 0.2,
        validActivations: 0.25,
        streakConsistency: 0.2,
        validClaims: 0.2,
        absenceOfAbuse: 0.15,
      },
      fullAgeDays: 30,
      fullValidActivations: 30,
      fullValidClaims: 30,
      abuseFlagsForZeroTrust: 3,
      solBalanceIsNotAnInput: true,
    },
  },
  // Mining is live from the launch block, so a mine already pays block rewards while its
  // market is still on the curve. The share is small on purpose: the curve has to stay a
  // curve, and graduation still moves whatever inventory mining left behind.
  curve: {
    defaultMiningBps: 500,
    maxMiningBps: 1_000,
    defaultRunwayDays: 30,
    maxRunwayDays: 3_650,
    changeBaselineSeconds: 82_800,
    volumeWindowSeconds: 86_400,
  },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeInto<T>(base: T, override: unknown): T {
  if (override === undefined) return base;
  if (Array.isArray(override)) return override as unknown as T;
  if (isPlainObject(base) && isPlainObject(override)) {
    const merged: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const key of Object.keys(override)) {
      merged[key] = mergeInto(merged[key], override[key]);
    }
    return merged as unknown as T;
  }
  return override as T;
}

export function deepFreeze<T>(value: T): T {
  if (isPlainObject(value) || Array.isArray(value)) {
    if (!Object.isFrozen(value)) Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

export const DIGGO_CONFIG: DiggoConfig = deepFreeze(DIGGO_CONFIG_DEFAULTS);

/** Derives a tuned config from the defaults. Arrays are replaced wholesale. */
export function createDiggoConfig(overrides: DeepPartial<DiggoConfig> = {}): DiggoConfig {
  return deepFreeze(mergeInto(DIGGO_CONFIG_DEFAULTS, overrides));
}

// --- environment override layer ---------------------------------------------------------

/**
 * Every tunable that may be overridden per deployment, with the range it is clamped to.
 * Bounds are deliberately narrow: a mistyped environment variable must be able to neither
 * open the floodgates (a window of one second, a 100% roll chance) nor stop the subsystem
 * outright (a window of a year).
 */
export const DISCOVERY_TUNABLE_BOUNDS = Object.freeze({
  windowSeconds: Object.freeze({ min: 60, max: 86_400 }),
  rollChanceBps: Object.freeze({ min: 0, max: BPS_DENOMINATOR }),
});

/** Bounds for the held-grant tunables, clamped the same way every other discovery tunable is. */
export const DISCOVERY_HELD_TUNABLE_BOUNDS = Object.freeze({
  heldBudgetShareBps: Object.freeze({ min: 0, max: BPS_DENOMINATOR }),
  /** Five minutes at the fastest, a month at the slowest. */
  heldGrantReviewSeconds: Object.freeze({ min: 300, max: 30 * 86_400 }),
});

/**
 * The environment variables the override layer reads. Structural on purpose, so both a Worker
 * RuntimeEnv and a plain test object satisfy it without dragging bindings into shared/.
 */
export interface ConfigEnvSource {
  /** Discovery opportunity window in seconds. */
  DISCOVERY_WINDOW_SECONDS?: string;
  /** Discovery roll chance in basis points (0-10000). */
  DISCOVERY_ROLL_CHANCE_BPS?: string;
  /** Share of every discovery cap held grants may reserve, in basis points (0-10000). */
  DISCOVERY_HELD_BUDGET_SHARE_BPS?: string;
  /** Seconds a held discovery keeps its budget slot before it is released, 300-2592000. */
  DISCOVERY_HELD_REVIEW_SECONDS?: string;
}

/** Floors a possibly-stringly numeric value and clamps it into `bounds`. */
export function clampToBounds(
  value: unknown,
  bounds: { min: number; max: number },
  fallback: number,
): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string" && value.trim().length === 0) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(bounds.max, Math.max(bounds.min, Math.floor(parsed)));
}

/** The two discovery tunables, with whatever was supplied clamped into their bounds. */
export function clampDiscoveryTunables(
  input: { windowSeconds?: unknown; rollChanceBps?: unknown },
  base: DiscoveryConfig = DIGGO_CONFIG.discovery,
): { windowSeconds: number; rollChanceBps: number } {
  return {
    windowSeconds: clampToBounds(input.windowSeconds, DISCOVERY_TUNABLE_BOUNDS.windowSeconds, base.windowSeconds),
    rollChanceBps: clampToBounds(input.rollChanceBps, DISCOVERY_TUNABLE_BOUNDS.rollChanceBps, base.rollChanceBps),
  };
}

/** The held-grant tunables, clamped into DISCOVERY_HELD_TUNABLE_BOUNDS. */
export function clampHeldBudgetTunables(
  input: { heldBudgetShareBps?: unknown; heldGrantReviewSeconds?: unknown },
  base: DiscoveryConfig = DIGGO_CONFIG.discovery,
): { heldBudgetShareBps: number; heldGrantReviewSeconds: number } {
  return {
    heldBudgetShareBps: clampToBounds(
      input.heldBudgetShareBps,
      DISCOVERY_HELD_TUNABLE_BOUNDS.heldBudgetShareBps,
      base.heldBudgetShareBps,
    ),
    heldGrantReviewSeconds: clampToBounds(
      input.heldGrantReviewSeconds,
      DISCOVERY_HELD_TUNABLE_BOUNDS.heldGrantReviewSeconds,
      base.heldGrantReviewSeconds,
    ),
  };
}

/**
 * The one place an environment variable becomes configuration: applies the override layer on
 * top of `base` (DIGGO_CONFIG by default) and returns a frozen config.
 *
 * Callers resolve this per request rather than caching a module-level mutable copy, because a
 * Worker isolate's environment is stable while its imported modules are shared.
 */
export function configFromEnv(
  source: ConfigEnvSource,
  base: DiggoConfig = DIGGO_CONFIG,
): DiggoConfig {
  const { windowSeconds, rollChanceBps } = clampDiscoveryTunables(
    {
      windowSeconds: source.DISCOVERY_WINDOW_SECONDS,
      rollChanceBps: source.DISCOVERY_ROLL_CHANCE_BPS,
    },
    base.discovery,
  );
  const { heldBudgetShareBps, heldGrantReviewSeconds } = clampHeldBudgetTunables(
    {
      heldBudgetShareBps: source.DISCOVERY_HELD_BUDGET_SHARE_BPS,
      heldGrantReviewSeconds: source.DISCOVERY_HELD_REVIEW_SECONDS,
    },
    base.discovery,
  );
  if (
    windowSeconds === base.discovery.windowSeconds &&
    rollChanceBps === base.discovery.rollChanceBps &&
    heldBudgetShareBps === base.discovery.heldBudgetShareBps &&
    heldGrantReviewSeconds === base.discovery.heldGrantReviewSeconds
  ) {
    return base;
  }
  return deepFreeze(
    mergeInto(base, {
      discovery: {
        ...base.discovery,
        windowSeconds,
        rollChanceBps,
        heldBudgetShareBps,
        heldGrantReviewSeconds,
      },
    }),
  );
}

/**
 * Legacy flat view of gameplay defaults. Kept for backwards compatibility with
 * worker/src call sites; prefer DIGGO_CONFIG in new code.
 */
export interface GameplayDefaults {
  activationSeconds: number;
  graceSeconds: number;
  minimumReactivationSeconds: number;
  baseOrePerHour: number;
  activationOre: number;
  starterPower: number;
  discoveryMinimumAgeDays: number;
  discoveryMinimumActiveDays: number;
}

export const GAMEPLAY_DEFAULTS: GameplayDefaults = Object.freeze({
  activationSeconds: DIGGO_CONFIG.streak.activationSeconds,
  graceSeconds: DIGGO_CONFIG.streak.graceSeconds,
  minimumReactivationSeconds: DIGGO_CONFIG.streak.minimumReactivationSeconds,
  baseOrePerHour: DIGGO_CONFIG.ore.baseOrePerActiveHour,
  activationOre: DIGGO_CONFIG.ore.activationBonusOre,
  starterPower: DIGGO_CONFIG.crew.starterPower,
  discoveryMinimumAgeDays: DIGGO_CONFIG.discovery.minimumAccountAgeDays,
  discoveryMinimumActiveDays: DIGGO_CONFIG.discovery.minimumActiveDays,
});

export interface DiscoveryDefaults {
  minimumMarketCapUsd: number;
  accountDailyCapUsd: number;
  accountWeeklyCapUsd: number;
  tokenDailyCapUsd: number;
  globalDailyCapUsd: number;
}

export const DISCOVERY_DEFAULTS: DiscoveryDefaults = Object.freeze({
  minimumMarketCapUsd: DIGGO_CONFIG.discovery.minimumMarketCapUsd,
  accountDailyCapUsd: DIGGO_CONFIG.discovery.accountDailyCapUsd,
  accountWeeklyCapUsd: DIGGO_CONFIG.discovery.accountWeeklyCapUsd,
  tokenDailyCapUsd: DIGGO_CONFIG.discovery.tokenDailyCapUsd,
  globalDailyCapUsd: DIGGO_CONFIG.discovery.globalDailyCapUsd,
});
