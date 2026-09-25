export type ChainMode = "meteora" | "native";
export type MeteoraCluster = "devnet" | "mainnet-beta";

export const METEORA_DBC_PROGRAM_ID = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
export const METEORA_DAMM_V2_PROGRAM_ID = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";
export const METEORA_WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
export const METEORA_FEE_CLAIMER = "6HHEkX5MxsoQwyCJZHvLnewmnsaw19vGT9Y8jhqH7GuJ";
export const METEORA_DBC_CONFIG_PLACEHOLDER = "SET_AFTER_CREATE";

export const METEORA_TOKEN = {
  totalSupply: 1_000_000_000n,
  decimals: 9,
  leftover: 200_000_000n,
  curveSupply: 800_000_000n,
} as const;

export const METEORA_LAUNCH = {
  poolCreationFeeLamports: 10_000_000n,
  estimatedAccountRentLamports: 20_000_000n,
  estimatedTransactionFeeLamports: 2_000_000n,
  creatorTradingFeeBps: 0,
  minimumBaseFeeBps: 25,
  antiSniperStartFeeBps: 300,
  antiSniperEndFeeBps: 100,
  antiSniperDurationSeconds: 60 * 60,
  dynamicFeeEnabled: true,
  migrationFeeBps: 50,
  creatorMigrationFeeBps: 0,
  dammV2FeeBps: 100,
  partnerLiquidityBps: 10_000,
  partnerPermanentLockedLiquidityBps: 1_000,
} as const;
export const METEORA_POOL_CREATION_FEE_LAMPORTS = METEORA_LAUNCH.poolCreationFeeLamports;

export const METEORA_MIGRATION_THRESHOLD_SOL: Readonly<Record<MeteoraCluster, number>> = {
  devnet: 2,
  "mainnet-beta": 85,
};

export function normalizeMeteoraCluster(cluster: string | null | undefined): MeteoraCluster {
  const normalized = cluster?.trim().toLowerCase();
  if (normalized === "devnet") return "devnet";
  return "mainnet-beta";
}

export function normalizeChainMode(value: string | null | undefined): ChainMode {
  return value === "native" ? "native" : "meteora";
}

export function requireMeteoraConfigPubkey(value: string | null | undefined): string {
  const pubkey = value?.trim() ?? "";
  if (pubkey && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(pubkey)) return pubkey;
  throw new Error("Meteora is enabled, but no valid Meteora config pubkey was published by bootstrap.");
}

export function isMeteoraConfigPubkey(value: string | null | undefined): value is string {
  const pubkey = value?.trim() ?? "";
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(pubkey);
}

/** Publishes no placeholder to clients that expect a real Solana address. */
export function normalizeMeteoraConfigPubkey(value: string | null | undefined): string {
  return isMeteoraConfigPubkey(value) ? value.trim() : "";
}

export function migrationThresholdLamports(cluster: string | null | undefined): bigint {
  const sol = METEORA_MIGRATION_THRESHOLD_SOL[normalizeMeteoraCluster(cluster)];
  return BigInt(sol) * 1_000_000_000n;
}

export function estimatedMeteoraLaunchCostLamports(includeTransactionFee = true): {
  poolCreationFeeLamports: bigint;
  rentLamports: bigint;
  transactionFeeLamports: bigint;
  totalLamports: bigint;
} {
  const transactionFeeLamports = includeTransactionFee
    ? METEORA_LAUNCH.estimatedTransactionFeeLamports
    : 0n;
  return {
    poolCreationFeeLamports: METEORA_LAUNCH.poolCreationFeeLamports,
    rentLamports: METEORA_LAUNCH.estimatedAccountRentLamports,
    transactionFeeLamports,
    totalLamports:
      METEORA_LAUNCH.poolCreationFeeLamports +
      METEORA_LAUNCH.estimatedAccountRentLamports +
      transactionFeeLamports,
  };
}
