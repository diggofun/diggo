import type { RuntimeEnv } from "../env";

export const METEORA_DBC_PROGRAM_ID = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
export const METEORA_DAMM_V2_PROGRAM_ID = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";
export const METEORA_POOL_AUTHORITY = "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM";
export const METEORA_ADMIN_WALLET = "GyGjx2nsgG2wDbUESGTw8aHndXh6b8d2znhZPqWSdwcH";
export const METEORA_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

export type TradeDirection = "buy" | "sell";

export interface MeteoraPoolRecord {
  pool: string;
  config: string;
  creator: string;
  baseMint: string;
  baseVault: string;
  quoteMint: string;
  name: string | null;
  symbol: string | null;
  uri: string | null;
  decimals: number;
  activationPoint: bigint;
  baseReserve: bigint;
  quoteReserve: bigint;
  migrationQuoteThreshold: bigint;
  isGraduated: boolean;
  isMigrated: boolean;
}

export interface MeteoraSwapEvent {
  kind: "swap";
  pool: string;
  config: string;
  mint: string;
  side: TradeDirection;
  amountIn: bigint;
  amountOut: bigint;
  solAmountLamports: bigint;
  quoteReserve: bigint;
  migrationThreshold: bigint;
  trader: string;
  signature: string;
  eventIndex: number;
  blockTime: number | null;
  slot: bigint;
}

export interface MeteoraInitializeEvent {
  kind: "initialize";
  pool: string;
  config: string;
  creator: string;
  baseMint: string;
  poolType: number;
  activationPoint: bigint;
  signature: string;
  eventIndex: number;
  blockTime: number | null;
  slot: bigint;
}

export interface MeteoraCurveCompleteEvent {
  kind: "curve_complete";
  pool: string;
  config: string;
  baseReserve: bigint;
  quoteReserve: bigint;
  signature: string;
  eventIndex: number;
  blockTime: number | null;
  slot: bigint;
}

export type MeteoraEvent = MeteoraSwapEvent | MeteoraInitializeEvent | MeteoraCurveCompleteEvent;
export type MeteoraRpcEnv = RuntimeEnv & {
  DIGGO_RPC_URL?: string;
  METEORA_DBC_CONFIG?: string;
  MINING_VAULT_SECRET?: string;
  MINING_VAULT_PUBLIC_KEY?: string;
  MINING_CLAIM_PER_CLAIM?: string;
  MINING_CLAIM_PER_DAY?: string;
  MINING_VAULT_SWEEP_LIMIT?: string;
};
export type MeteoraD1Database = D1Database;

export interface MeteoraSwapInsert {
  id: string;
  signature: string;
  eventIndex: number;
  pool: string;
  config: string;
  mint: string;
  traderWallet: string;
  side: TradeDirection;
  amountIn: bigint;
  amountOut: bigint;
  solAmountLamports: bigint;
  quoteReserve: bigint;
  migrationThreshold: bigint;
  slot: bigint;
  blockTime: number | null;
}

export interface MeteoraVaultRow {
  pool: string;
  baseMint: string;
  config: string;
  creator: string;
  baseVault: string;
  isMigrated: number;
  isLeftoverWithdrawn: number;
}

export interface MeteoraClaimParams {
  mint: string;
  wallet: string;
  amount: bigint;
  idempotencyKey: string;
  env: MeteoraRpcEnv;
}

export interface MeteoraVaultOperation {
  id: string;
  kind: string;
  pool: string | null;
  mint: string | null;
  status: string;
  signature: string | null;
  amount: string | null;
  error: string | null;
}

export interface PreparedMiningClaim {
  id: string;
  mint: string;
  wallet: string;
  amount: string;
  source: string;
  destination: string;
  transaction: string;
  /** Unix seconds after which the client should not sign this transaction. */
  expiresAt: number;
}
