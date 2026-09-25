import type { DiscoveryVisualEvent } from "./discoveryVisual";

export type { DiscoveryVisualEvent } from "./discoveryVisual";

import type { DecodedCoin } from "./program";

/**
 * The on-chain v2 state types, re-exported so a module that only needs to *describe* on-chain
 * state does not have to import the instruction surface with it. The layouts, decoders, builders
 * and seed tables all live in shared/program.ts and shared/pdas.ts; these are the names.
 */
export type {
  AccountName,
  BondSourceName,
  CoinStatusName,
  DiggoAccountName,
  DiggoErrorName,
  DiggoEventName,
  DiggoInstructionName,
  DecodedCoin,
  DecodedCurveTable,
  DecodedDiscoveryOpportunity,
  DecodedGlobalBudget,
  DecodedLiquidityPool,
  DecodedMintMetadata,
  DecodedMiningPosition,
  DecodedPlayerAccount,
  DecodedProtocolConfig,
  DecodedSponsorEvent,
  DecodedSponsorGrant,
  DecodedSponsorVault,
  DecodedTokenAccount,
  LaunchTokenArgs,
  OpportunityStatusName,
  PlayerCrewLevels,
  ProtocolConfigArgs,
  RarityTier,
  SponsorEventKindName,
  TokenAccountStateName,
  TrancheName,
} from "./program";


/**
 * What a mine's token is doing right now.
 *
 * CURVE_CAP_REACHED is the pre-graduation idle state: the market is still on its bonding curve
 * and has spent (or never had) its curve-mining budget, so blocks accrue nothing until it
 * graduates and the Mining Reserve takes over. It is deliberately distinct from FULLY_MINED,
 * which the program only reaches with a spent Mining Reserve after graduation - a market that
 * is idle on its curve is not a mine that has run out for good.
 */
export type TokenStatus = "LAUNCHING" | "MINING_ACTIVE" | "FULLY_MINED" | "CURVE_CAP_REACHED";

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
  /**
   * Real 24h change in percent, or null when it cannot be measured honestly. See
   * TokenChange24h below: null is unknown, never zero.
   */
  change24h: TokenChange24h;
  /** Real traded volume over the same 24h window, in USD, from indexed trades. */
  volume24hUsd: number;
  /** Indexed trades in that window; the ranking signal when change24h is unknown. */
  trades24h: number;
  /** Curve-phase mining progress: how much of the pre-graduation budget is left. */
  curveMining: CurveMiningSummary;
  /** What a seller can really get out of the curve right now. */
  sellCapacity: CurveSellCapacitySummary;
  marketCapUsd: number;
  reserveRemaining: number;
  reserveTotal: number;
  rewardPerBlock: number;
  networkPower: number;
  nextBlockAt: number;
  nextEpochAt: number;
  createdAt: number;
  decimals: number;
  venue?: "meteora";
  quoteReserve?: string;
  migrationQuoteThreshold?: string;
}

/**
 * The real 24h change of a token, measured from its own indexed price observations: the
 * price right now against the observation closest to a whole day older (see worker/chain.ts).
 *
 * It is null whenever that measurement cannot be made honestly: no observation at least
 * changeBaselineSeconds old, no indexed trade in the window, or a baseline price of zero.
 * Null is not zero, and a client must render it as unknown rather than as "+0%" — a token
 * nobody has traded has no 24h change, not a flat one.
 */
export type TokenChange24h = number | null;

/** Which side of a mine pays for a block (mirrors shared/curve.ts). */
export type MineEmissionSource = "CURVE" | "RESERVE";

/**
 * Curve-phase mining, as the API reports it for one mine.
 *
 * Mining is live from the launch block: while a market is still on its bonding curve its
 * block rewards come out of that curve's own token inventory, capped at a launch-time share
 * of the inventory it started with (see shared/curve.ts). This is that cap's progress, so a
 * client can show how much of the pre-graduation budget is left without inventing anything.
 */
export interface CurveMiningSummary {
  /** True while the cap has room left: pre-graduation emission is live right now. */
  open: boolean;
  /**
   * True for a market on its curve that never had a curve-mining budget at all - launched
   * with a zero share, or written before the ledger existed (a migration can only default the
   * cap to zero). Mining is not paused for these mines; it starts at graduation. Shown so a
   * legacy market is not rendered as a budget that is 0% spent.
   */
  disabled?: boolean;
  /** True while the market is still on its curve; false means the locked pool is the venue. */
  onCurve: boolean;
  /** The launch-time budget in whole tokens; 0 on a market launched without one. */
  cap: number;
  /** Emitted so far, in whole tokens. Never above cap. */
  mined: number;
  /** cap - mined, in whole tokens. */
  remaining: number;
  /** mined / cap as a 0..1 fraction, for a progress bar. 0 when there is no budget. */
  progress: number;
  /** The curve phase's flat per-block output, in whole tokens. */
  blockReward: number;
  /**
   * Emitted but not claimed yet, in whole tokens. These are already credited to positions
   * and graduation deliberately leaves them in the market vault.
   */
  unpaid: number;
}

/**
 * What a seller can really get out of a market's curve right now.
 *
 * Mined tokens bring no SOL with them, so this does not grow as a mine emits: it is the real
 * SOL the curve holds, which the quote path caps every payout at. A graduated market has no
 * curve to sell into and reports zero here; its liquidity is the pool's.
 */
export interface CurveSellCapacitySummary {
  /** Real SOL available to sellers, in SOL. */
  sol: number;
  /** Token amount that would take all of it, or null when no finite amount can. */
  tokens: number | null;
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
  /** Public username when the player set one; the UI falls back to the shortened wallet. */
  username?: string | null;
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
  /**
   * Curve-phase mining. While the mine is on its curve this is the budget its block rewards
   * come out of, so remainingReserve / reserveTotal / fullyMinedProgress above describe the
   * curve cap rather than the Mining Reserve; emissionSource says which.
   */
  curveMining: CurveMiningSummary;
  /** Which side pays the next block: the curve's inventory, or the Mining Reserve. */
  emissionSource: MineEmissionSource;
  /** Estimated days of curve budget left at the current rate, or null when there is none. */
  curveMiningDaysRemaining: number | null;
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

/**
 * How a coin's on-chain lifecycle projects onto the API's TokenStatus.
 *
 * The program's own status byte is Launching, MiningActive or FullyMined, and none of those three
 * can express the state a client has to show: a coin that is still on its bonding curve and whose
 * curve-phase budget is spent (or was never granted, when the launch asked for a zero share), so
 * its blocks accrue nothing until it graduates and the Mining Reserve takes over. That state is not
 * "fully mined" - the reserve is untouched - which is why it is derived here from the coin's own
 * phase flags rather than read off the status byte.
 */
export function tokenStatusFromCoin(
  coin: Pick<DecodedCoin, "status" | "graduated" | "curveMiningOpen">,
): TokenStatus {
  if (coin.status === "FullyMined") return "FULLY_MINED";
  if (!coin.graduated && !coin.curveMiningOpen) return "CURVE_CAP_REACHED";
  if (coin.status === "MiningActive") return "MINING_ACTIVE";
  return "LAUNCHING";
}

/**
 * Which side pays a coin's next block. Before graduation only the curve's own token inventory may
 * pay a block and after it only the Mining Reserve may, so this is a phase and not a preference.
 */
export function emissionSourceFromCoin(coin: Pick<DecodedCoin, "graduated">): MineEmissionSource {
  return coin.graduated ? "RESERVE" : "CURVE";
}
