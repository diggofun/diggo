import type { RuntimeEnv } from "../env";

/** The two supported game authorities. The native path is intentionally not reimplemented here. */
export type ChainMode = "meteora" | "native";

export const TOKEN_DECIMALS = 9;
export const TOKEN_SCALE = 1_000_000_000n;
export const MINT_SUPPLY = 1_000_000_000n * TOKEN_SCALE;
export const MINING_RESERVE = 200_000_000n * TOKEN_SCALE;

export interface GameCoin {
  mint: string;
  symbol: string;
  name: string;
  createdAt: number;
  /** Unix seconds at which off-chain mining becomes available for this launch. */
  miningStartsAt: number;
  graduated: boolean;
}

/** Integration seam implemented by worker/meteora in the routing integration step. */
export interface GameCoinSource {
  listActiveMines(): Promise<readonly GameCoin[]>;
  getMine(mint: string): Promise<GameCoin | null>;
}

export interface MiningPayoutResult {
  signature: string;
}

/** The sole abstraction permitted to move real mine tokens. */
export interface MiningPayout {
  pay(
    mint: string,
    wallet: string,
    amount: bigint,
    idempotencyKey: string,
  ): Promise<MiningPayoutResult>;
}

/** Portfolio valuation is an integration input, not a value invented by the game engine. */
export interface GamePortfolioSource {
  portfolioUsd(wallet: string): Promise<number>;
}

/** Wallet age must come from the chain/index integration, not from when D1 first saw a row. */
export interface GameWalletSource {
  walletCreatedAt(wallet: string): Promise<number | null>;
}

export interface GameServices {
  coins: GameCoinSource;
  payout: MiningPayout;
  portfolio?: GamePortfolioSource;
  wallet?: GameWalletSource;
}

export type GameEnv = RuntimeEnv & {
  CHAIN_MODE?: string;
  MINING_VAULT_SECRET?: string;
  DISCOVERY_SECRET?: string;
};

export function gameChainMode(env: Pick<GameEnv, "CHAIN_MODE">): ChainMode {
  return env.CHAIN_MODE === "native" ? "native" : "meteora";
}

export interface GamePlayerState {
  wallet: string;
  createdAt: number;
  oreBalance: number;
  oreEarned: number;
  streak: number;
  longestStreak: number;
  streakFreezes: number;
  activeUntil: number;
  lastActivationAt: number;
  activatedAt: number;
  lastOreAt: number;
  activeDays: number;
  validActivations: number;
  activeMine: string | null;
  activeMiningPower: number;
  crew: {
    miners: number;
    drills: number;
    carts: number;
    foreman: number;
    storage: number;
  };
}
