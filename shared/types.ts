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
  | { type: "helius"; payload: Record<string, unknown> }
  | { type: "epoch_sync"; mint: string; timestamp: number };

export interface LaunchRequest {
  name: string;
  symbol: string;
  description: string;
  creator: string;
  imageUrl?: string;
  turnstileToken: string;
}
