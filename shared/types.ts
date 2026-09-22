import type { DiscoveryVisualEvent } from "./discoveryVisual";

export type { DiscoveryVisualEvent } from "./discoveryVisual";

export type TokenStatus = "LAUNCHING" | "MINING_ACTIVE" | "FULLY_MINED";

export interface TokenSummary {
  mint: string;
  slug: string;
  name: string;
  symbol: string;
  description: string;
  creator: string;
  imageUrl: string | null;
  status: TokenStatus;
  /** Real spot price from the on-chain bonding curve. The only trustworthy price field. */
  priceSol: number;
  /** priceSol converted at an illustrative, hardcoded devnet SOL/USD rate — see worker/chain.ts. Not a live price feed. */
  priceUsd: number;
  change24h: number;
  marketCapUsd: number;
  reserveRemaining: number;
  reserveTotal: number;
  rewardPerBlock: number;
  networkPower: number;
  nextBlockAt: number;
  nextEpochAt: number;
  createdAt: number;
  decimals: number;
}

export interface MarketSnapshot {
  mint: string;
  priceUsd: number;
  volume24h: number;
  lastTradeAt: number | null;
  recentTrades: MarketTrade[];
}

export interface MarketTrade {
  signature: string;
  side: "buy" | "sell";
  priceSol: number;
  priceUsd: number;
  amount: number;
  timestamp: number;
}

export type IndexingEvent =
  | { type: "trade"; mint: string; trade: MarketTrade }
  | {
      type: "helius";
      signature: string;
      mint: string;
      eventType: string;
      source: string;
      slot: number | null;
      timestamp: number | null;
      payload: Record<string, unknown>;
    }
  | { type: "epoch_sync"; mint: string; timestamp: number }
  | { type: "sync_power"; wallet: string; mint: string }
  | { type: "claim_discovery"; discoveryId: string }
  /**
   * A settled block-reward claim, enqueued by worker/mining.ts once its row reaches CLAIMED.
   *
   * The keeper deliberately cannot pay this one: the Mining Reserve leaves the program only
   * through the user-signed `claim_rewards` instruction, and no backend key may sign for a player
   * (docs/SECURITY.md invariant 7). The job's work is therefore to expose the claim as ready for
   * the player to collect, and to record the payout once it exists — `txSignature` is present only
   * when a client reports the confirmed on-chain claim.
   */
  | { type: "reward_claim"; claimId: string; wallet: string; mint: string; txSignature?: string };

export interface LaunchRequest {
  name: string;
  symbol: string;
  description: string;
  creator: string;
  imageUrl?: string;
  turnstileToken: string;
}

export type ActivationState = "NEVER_ACTIVATED" | "ACTIVE" | "PAUSED";
export type RiskState = "NORMAL" | "UNDER_REVIEW" | "HELD" | "BLOCKED";

export interface PlayerProfile {
  wallet: string;
  createdAt: number;
  crewLevels: {
    miners: number;
    drills: number;
    carts: number;
    foreman: number;
    storage: number;
  };
  power: number;
  oreBalance: number;
  oreCapacity: number;
  streak: number;
  streakFreezes: number;
  activationState: ActivationState;
  lastActivationAt: number | null;
  activationExpiresAt: number | null;
  activeMint: string | null;
  accountAgeSeconds: number;
  maturityBps: number;
  discoveryEligible: boolean;
  riskState: RiskState;
  /** Streak/progression fields added by migrations/0008_mining_positions.sql. */
  longestStreak?: number;
  xp?: number;
  badges?: string[];
  titles?: string[];
  oreOverflow?: number;
  activatedAt?: number | null;
  streakGraceUntil?: number | null;
  lastReportAt?: number | null;
}

export interface LeaderboardEntry {
  rank: number;
  wallet: string;
  power: number;
  streak: number;
  activeDays: number;
  oreBalance: number;
  activeMint: string | null;
}

export interface Leaderboards {
  miners: LeaderboardEntry[];
  streaks: LeaderboardEntry[];
  mines: TokenSummary[];
}

export interface MiningReport {
  activeSeconds: number;
  oreGained: number;
  streak: number;
  streakFreezes: number;
  usedFreeze: boolean;
  discovery: DiscoveryRecord | null;
  /** Mine the crew worked, and the per-token block rewards settled for this report (spec 29). */
  mineMint?: string | null;
  blockRewards?: MiningReportBlockReward[];
  /** ORE that did not fit storage this window; reported explicitly, never dropped (spec 42). */
  oreOverflow?: number;
  /** Discoveries found during the reported window, summarised by rarity. */
  discoveries?: MiningReportDiscoveries;
  /** Streak milestones crossed by the activation that opened this window (spec 6). */
  milestones?: MiningReportMilestone[];
  collectedAt?: number;
  accounting?: MiningAccounting;
}

/**
 * Who is authoritative for a mine's numbers (spec 78): when the on-chain program is the source
 * of truth, the numbers here are the indexed/estimated view and are labelled as such.
 */
export type MineAuthority = "OFFCHAIN" | "ONCHAIN_INDEXED";

export interface MiningAccounting {
  source: MineAuthority;
  authoritative: boolean;
  label: string;
}

export interface MiningReportBlockReward {
  mint: string;
  symbol: string;
  amount: number;
  /** Claim row the player claims with; null while the reward is still unsettled in the position. */
  claimId: string | null;
  status: "ELIGIBLE" | "PENDING" | "CLAIMED" | "HELD" | "EXPIRED" | "UNSETTLED";
  authority: MineAuthority;
  /** How the reward reaches the player, once it is a real claim row (spec 57). */
  payout?: RewardClaimPayout;
}

/**
 * How a settled block reward reaches the player (spec 57). There is exactly one route: the player
 * signs `claim_rewards` themselves, because the Mining Reserve is program-controlled and the
 * keeper is not authorised to move it. The backend can only say whether the reward is ready and
 * record the transaction signature once it exists.
 */
export interface RewardClaimPayout {
  route: "USER_SIGNED";
  instruction: "claim_rewards";
  /** True while the player still has to submit the on-chain claim. */
  ready: boolean;
  txSignature: string | null;
}

export interface MiningReportDiscoveries {
  total: number;
  byRarity: Record<string, number>;
}

export interface MiningReportMilestone {
  day: number;
  ore: number;
  xp: number;
  badges: string[];
  titles: string[];
  freezes: number;
}

/** Everything a player needs to judge a mine before committing the crew (spec 33). */
export interface MineInfo {
  mint: string;
  symbol: string;
  status: TokenStatus;
  blockReward: number;
  totalMiningPower: number;
  remainingReserve: number;
  reserveTotal: number;
  /** Share of the next block the requesting player would earn, or null when no wallet is known. */
  estimatedShare: number | null;
  estimatedRewardPerBlock: number | null;
  /** Never present an estimate as a guaranteed return (spec 33). */
  estimateLabel: string;
  reductionSchedule: number[];
  fullyMinedProgress: number;
  nextBlockAt: number;
  epoch: number;
  epochEndsAt: number;
  playerPower: number | null;
  accounting: MiningAccounting;
}

export type DiscoveryStatus = "PENDING" | "ELIGIBLE" | "CLAIMED" | "HELD" | "REJECTED";

/** Server-side opportunity lifecycle; only the server ever moves these (spec 56). */
export type DiscoveryOpportunityStatus = "PENDING" | "ELIGIBLE" | "CONSUMED" | "EXPIRED" | "REJECTED";

export interface DiscoveryRecord {
  id: string;
  /** Deterministic id of the single-use opportunity that produced this discovery (spec 56). */
  eventId: string;
  window: string;
  mint: string;
  symbol: string;
  rarity: string;
  /** Server-chosen animation/report event for the UI (spec 28). */
  visualEvent: DiscoveryVisualEvent;
  tokenAmount: number;
  valueUsd: number;
  /** Robust price the amount was normalized with — never the raw spot price (spec 27). */
  priceUsd: number;
  /** Blended token eligibility score at grant time (spec 26). */
  eligibilityScore: number;
  status: DiscoveryStatus;
  /** True only while the owner can still submit a claim for this discovery. */
  claimable: boolean;
  claimedAt: number | null;
  txSignature: string | null;
  createdAt: number;
}

/** Alias used by reward accounting; identical to RiskState. */
export type RewardState = RiskState;

export type { RiskLevel, RiskResponse } from "./config";

/**
 * Neutral, detail-free risk status. Deliberately carries no score, weights or
 * signal names (see spec 62).
 */
export interface PublicRiskView {
  status: "normal" | "verification_required" | "under_review" | "unavailable";
  message: string;
}

/** Persisted mining position counters; BigInt values are stored as decimal strings. */
export interface MiningPositionRecord {
  mineId: string | null;
  assignedPower: string;
  lastRewardIndex: string;
  pendingReward: string;
  paused: boolean;
}

/** Rolling discovery budget usage per account, token and global window (spec 45). */
export interface DiscoveryBudgetUsage {
  accountDailyUsd: number;
  accountWeeklyUsd: number;
  tokenDailyUsd: number;
  tokenPeriodUsd: number;
  globalDailyUsd: number;
}

/**
 * Single-use discovery opportunity (spec 56). Generated lazily by the server for one active
 * Crew in one time window; once consumed the window can never be rolled again, so a client
 * cannot spam requests until it likes the result.
 */
export interface DiscoveryOpportunity {
  id: string;
  /** Deterministic from account + window, so recreating an opportunity is idempotent. */
  eventId: string;
  accountId: string;
  window: string;
  windowIndex: number;
  /** Server-authored nonce derived from the discovery secret; unpredictable without it. */
  nonce: string;
  status: DiscoveryOpportunityStatus;
  consumedAt: number | null;
  expiresAt: number;
  /** Set once a discovery was granted from this opportunity. */
  discoveryId: string | null;
}

/** Non-sensitive Mine Trust snapshot (spec 60). */
export interface MineTrustSnapshot {
  trust: number;
  computedAt: number;
}

/** One stored notification (spec 75). dedupeKey is unique per wallet event. */
export interface NotificationRecord {
  id: number;
  kind: string;
  payload: Record<string, string | number | boolean>;
  createdAt: number;
  readAt: number | null;
}

export interface NotificationsView {
  notifications: NotificationRecord[];
  unread: number;
  total: number;
}

/**
 * A cosmetic as the client sees it (spec 34). Deliberately carries no effect field: a cosmetic is
 * visual only, and purchasable entries stay 'coming_soon' until payment exists. See
 * shared/social.ts for the catalog and the invariant that enforces this.
 */
export interface CosmeticView {
  id: string;
  kind: string;
  slot: string | null;
  name: string;
  description: string;
  source: "earned" | "purchasable";
  status: "available" | "coming_soon";
  unlockKind: string | null;
  unlockRef: string | null;
  unlocked: boolean;
  equipped: boolean;
}

export interface CosmeticsView {
  catalog: CosmeticView[];
  equipped: Record<string, string>;
  slots: readonly string[];
  purchasesEnabled: boolean;
}

/** An achievement with the caller's progress (spec 34, 68). */
export interface AchievementView {
  id: string;
  name: string;
  description: string;
  category: string;
  metric: string;
  threshold: number;
  ore: number;
  badge: string | null;
  title: string | null;
  earnedAt: number | null;
  oreGranted: number;
  progress: number;
}
