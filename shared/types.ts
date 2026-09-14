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
  | { type: "epoch_sync"; mint: string; timestamp: number };

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
}

export interface MiningReport {
  activeSeconds: number;
  oreGained: number;
  streak: number;
  streakFreezes: number;
  usedFreeze: boolean;
  discovery: DiscoveryRecord | null;
}

export type DiscoveryStatus = "PENDING" | "ELIGIBLE";

export interface DiscoveryRecord {
  id: string;
  mint: string;
  symbol: string;
  rarity: string;
  tokenAmount: number;
  valueUsd: number;
  status: DiscoveryStatus;
  createdAt: number;
}
