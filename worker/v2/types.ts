/**
 * The read API's payload shapes. WS-E owns these; the frontend consumes them and does not
 * define its own (design 8.3, interface 3).
 *
 * One rule runs through every shape below: a number that came from the chain is carried as a
 * string when it is an integer amount, and the *derived* display value is a separate field
 * with a name that says it is a conversion. A client can therefore always tell a program fact
 * from a display convenience, and no float rounding can ever be mistaken for a balance.
 */

/** The coin lifecycle, as `state/coin.rs` numbers it. */
export type CoinStatus = "LAUNCHING" | "MINING_ACTIVE" | "FULLY_MINED";

/** Which venue holds a coin's liquidity. Before graduation: its bonding curve. After: the pool. */
export type CoinVenue = "curve" | "pool";

export type DiscoveryStatus = "PENDING" | "SETTLED" | "EXPIRED";

/** One coin, as the list and detail endpoints serve it. */
export interface CoinSummary {
  mint: string;
  coin: string;
  slug: string;
  name: string;
  symbol: string;
  description: string;
  creator: string;
  imageUrl: string | null;
  decimals: number;
  status: CoinStatus;
  venue: CoinVenue;
  graduated: boolean;
  /** Spot price in SOL, from whichever venue holds the liquidity. Display only. */
  priceSol: number;
  /** `priceSol` at the oracle's SOL/USD rate. Display only; never a settlement input. */
  priceUsd: number;
  /** False when no SOL/USD observation was available and the derived USD values are zero. */
  usdPriceAvailable: boolean;
  marketCapUsd: number;
  liquiditySol: number;
  liquidityUsd: number;
  /** Real SOL backing the price, in lamports, exactly as the program stores it. */
  liquidityLamports: string;
  /** Mining Reserve left, in whole tokens. */
  reserveRemaining: number;
  reserveTotal: number;
  discoveryReserveRemaining: number;
  discoveryReserveTotal: number;
  rewardPerBlock: number;
  networkPower: number;
  bondedPower: number;
  starterPower: number;
  nextBlockAt: number;
  nextEpochAt: number;
  epochIndex: number;
  epochSeedEpoch: number;
  /** True once the epoch seed for `epochSeedEpoch` has been committed on-chain. */
  epochSeedCommitted: boolean;
  discoveryPaused: boolean;
  /** Curve-phase mining budget, from the coin's own ledger. */
  curveMining: {
    open: boolean;
    cap: number;
    mined: number;
    remaining: number;
    progress: number;
    blockReward: number;
    unpaid: number;
  };
  /** Measured from this coin's own indexed trades. Null is unknown, never zero. */
  change24h: number | null;
  volume24hUsd: number;
  trades24h: number;
  createdAt: number;
  syncedAt: number;
}

export interface CoinListResponse {
  tokens: CoinSummary[];
  syncedAt: number;
}

/** One trade, indexed from chain. */
export interface CoinTrade {
  signature: string;
  side: "BUY" | "SELL";
  priceSol: number;
  priceUsd: number;
  /** What the trader offered: lamports for a buy, base units for a sell. */
  amount: number;
  /**
   * What the trader received, from the transaction's own balance table, or 0 when that table was
   * not available. `fillSource` says which of the two it is; v2 emits no trade event yet.
   */
  amountOut: number;
  fillSource: "meta" | "instruction" | "event";
  blockTime: number;
}

export interface MarketSnapshot {
  mint: string;
  priceSol: number;
  priceUsd: number;
  change24h: number | null;
  volume24hUsd: number;
  trades24h: number;
  updatedAt: number;
}

/** A player's own on-chain account, mirrored. Every game value here is the program's. */
export interface PlayerAccountView {
  player: string;
  wallet: string;
  /** Null until the PlayerAccount PDA exists; `initialize_player` is the player's first act. */
  indexed: boolean;
  createdSlot: string;
  createdAt: number;
  activeUntil: number;
  lastActivationAt: number;
  activationState: ActivationState;
  streak: number;
  longestStreak: number;
  validActivations: number;
  activeDays: number;
  streakFreezes: number;
  crewLevels: CrewLevelsView;
  crewPower: number;
  crewTier: string;
  oreBalance: number;
  oreEarned: number;
  oreSpent: number;
  oreCapacity: number;
  activeMine: string;
  /** The discovery budget charged so far in the current day and week windows. */
  discovery: {
    dayIndex: number;
    weekIndex: number;
    spentDayLamports: string;
    spentWeekLamports: string;
    rollWindow: number;
    rollCount: number;
    lastRollAt: number;
  };
  bond: {
    lamports: string;
    sol: number;
    source: "SELF" | "SPONSOR";
    sponsorVault: string | null;
    lockedAt: number;
    unbondAvailableAt: number;
    /**
     * True when a bond posted before the retirement is still held. It gates nothing: no new bond
     * may be posted, a wallet mines at full power without one, and the flag is kept so a legacy
     * deposit stays visible until `request_unbond`/`withdraw_bond` returns it.
     */
    posted: boolean;
    /** True while a cooldown set by `request_unbond` is still running. */
    cooldownActive: boolean;
  };
  /** Legacy: the same fact as `bond.posted`. Nothing a wallet holds scales its power or its rolls. */
  bonded: boolean;
  /** Retired: the program applies no efficiency factor, so every position mines at full rate. */
  starterEfficiencyBps: number;
  /** Advisory only: it has no on-chain effect by design (design section 5). */
  riskState: RiskStateName;
}

export interface CrewLevelsView {
  miners: number;
  drills: number;
  carts: number;
  foreman: number;
  storage: number;
  total: number;
}

export type ActivationState = "NEVER_ACTIVATED" | "ACTIVE" | "PAUSED";
export type RiskStateName = "NORMAL" | "UNDER_REVIEW" | "HELD" | "BLOCKED";

/** One MiningPosition PDA, mirrored. */
export interface MiningPositionView {
  position: string;
  coin: string;
  mint: string | null;
  symbol: string | null;
  owner: string;
  assignedPower: string;
  pendingReward: string;
  pendingRewardWhole: number;
  /**
   * Legacy: the tranche a position was armed with. Only a position armed before the bond's
   * retirement can read `STARTER`, and both settle against the index the program keys to them.
   */
  tranche: "BONDED" | "STARTER";
  createdSlot: string;
}

/** A player's profile: the on-chain account plus the parts that are off-chain on purpose. */
export interface PlayerProfileView {
  wallet: string;
  username: string | null;
  account: PlayerAccountView;
  positions: MiningPositionView[];
  achievements: AchievementView[];
  cosmetics: CosmeticView[];
  season: { id: string; name: string; points: number } | null;
}

/** One discovery, indexed from the program's own events. */
export interface DiscoveryView {
  opportunity: string;
  coin: string;
  mint: string | null;
  symbol: string | null;
  wallet: string;
  windowIndex: number;
  dayIndex: number;
  epochIndex: number;
  status: DiscoveryStatus;
  /** The rarity tier the epoch seed derived, or null while the roll is still pending. */
  rarity: number | null;
  units: string | null;
  unitsWhole: number | null;
  valueLamports: string | null;
  budgetLamports: string;
  signature: string;
  blockTime: number;
}

/**
 * A committed epoch seed, published so anyone can recompute any outcome: every discovery is
 * `sha256(seed || owner || window_index)` expanded in order. This is the whole reason the
 * indexer stores seeds rather than outcomes alone.
 */
export interface EpochSeedView {
  coin: string;
  mint: string | null;
  epochIndex: number;
  seed: string;
  targetSlot: string;
  recordedSlot: string;
  signature: string;
  blockTime: number;
}

/** One mine's information panel: the coin, its pool, and the ledger invariant check. */
export interface MineInfoView {
  mint: string;
  coin: string;
  slug: string;
  symbol: string;
  status: CoinStatus;
  venue: CoinVenue;
  /** The vault ledger invariant of design 1.3(a), checked off-chain and reported, not enforced. */
  ledger: {
    vaultAmount: string;
    owed: string;
    ok: boolean;
    shortfall: string;
  };
  reserve: { remaining: number; total: number; cumulativeDistributed: number };
  discovery: { remaining: number; total: number; epochBudget: number; epochSpent: number };
  /** The coin's own power totals. `starter` can only be non-zero for a pre-retirement position. */
  power: { total: number; bonded: number; starter: number };
  fees: { creatorClaimableLamports: string; platformClaimableLamports: string };
  epoch: { index: number; endsAt: number; endsSlot: string; seedCommitted: boolean };
  pool: { pool: string; solReserveLamports: string; tokenReserve: string } | null;
  /** Whether a permissionless `graduate_market` could do anything right now. */
  graduationReady: boolean;
  /** Whether the ledger has been advanced to the present; a stale coin needs a crank. */
  advanceDue: boolean;
}

/** One sponsor event, mirrored. Sponsorship never touches power, rewards or discovery odds. */
export interface SponsorEventView {
  event: string;
  vault: string;
  kind: string;
  startAt: number;
  endAt: number;
  active: boolean;
  budgetLamports: string;
  spentLamports: string;
  remainingLamports: string;
  perCoinLimitLamports: string;
  perWalletLimitLamports: string;
}

/**
 * The governance parameters the read API serves, straight from the ProtocolConfig account. The
 * bond amount, its cooldown and the starter factors are absent on purpose: the account still
 * carries the frozen fields, but the API serves no deposit a wallet has to make and no penalty it
 * mines under.
 */
export interface ProtocolView {
  authority: string;
  treasury: string;
  crankPool: string;
  creatorFeeBps: number;
  platformFeeBps: number;
  crankPoolFeeBps: number;
  discoveryDailyCapLamports: string;
  discoveryWeeklyCapLamports: string;
  discoveryGlobalDailyCapLamports: string;
  discoveryEpochBudgetLamports: string;
  rarityTierCount: number;
  pausedFlags: number;
  pausedUntil: number;
  indexedAt: number;
}

/** The global daily discovery budget, mirrored so the UI can show headroom without an RPC. */
export interface GlobalBudgetView {
  dayIndex: number;
  capLamports: string;
  spentLamports: string;
  rollCount: number;
  settledCount: number;
  closed: boolean;
}

/** One leaderboard row. `metric` is whatever the board ranks by. */
export interface LeaderboardEntryView {
  rank: number;
  wallet: string;
  username: string | null;
  /** The player's profile bot, or null for the default bot of their wallet. */
  bot: import("../../shared/profileBot").ProfileBot | null;
  metric: number;
  crewTier: string;
  crewPower: number;
}

export interface LeaderboardsView {
  boards: { key: string; label: string; entries: LeaderboardEntryView[] }[];
  season: { id: string; name: string; endsAt: number } | null;
  computedAt: number;
}

/** Notifications are derived from indexed on-chain state, never authored by an operator. */
export interface NotificationView {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: number;
  readAt: number | null;
}

export interface AchievementView {
  id: string;
  name: string;
  description: string;
  earnedAt: number | null;
}

export interface CosmeticView {
  id: string;
  kind: string;
  name: string;
  description: string;
  owned: boolean;
  equipped: boolean;
}

/** What the indexer reports about itself. Purely diagnostic. */
export interface IndexerStatusView {
  cursors: { kind: string; cursor: string; slot: number; updatedAt: number }[];
  lastRuns: { id: string; kind: string; startedAt: number; finishedAt: number; accounts: number; events: number; status: string }[];
  counts: Record<string, number>;
  crank: { enabled: boolean; feePayer: string | null };
}

/** The indexer's job payloads, as they travel through INDEXING_QUEUE. */
export type IndexerJob =
  | { type: "events"; signature: string; slot: number; blockTime: number | null }
  | { type: "account"; address: string; kind: string }
  | { type: "coin"; mint: string }
  | { type: "player"; wallet: string }
  | { type: "sweep"; reason: string };

/** One advisory alert. Advisory means advisory: nothing here can move value. */
export interface AdvisoryAlert {
  kind: string;
  subject: string | null;
  severity: "INFO" | "WARN" | "CRITICAL";
  detail: string;
}
