import type { ChainMode } from "./meteora";

export interface AdminDashboardCount {
  total: number | null;
  last24h: number | null;
  last7d: number | null;
}

export interface AdminDashboardVolume {
  sol: string | null;
  estimated: boolean;
}

/** One partner fee stream, read from the Meteora DBC accounts. Null means the read failed. */
export interface AdminDashboardFee {
  /** Unclaimed and collectable by the config fee claimer right now. */
  claimableSol: string | null;
  /** Everything the partner has earned since the pools were created, claimed or not. */
  lifetimeSol: string | null;
  /** lifetimeSol minus claimableSol. */
  claimedSol: string | null;
}

/**
 * Partner fees across every pool under the published DBC config, read on-chain. When the read
 * fails every amount is null and status is "unavailable"; the Worker never substitutes an estimate.
 */
export interface AdminDashboardFees {
  status: "live" | "unavailable";
  /** Partner trading fee plus unclaimed creation fees: what a claim would collect now. */
  claimableSol: string | null;
  partnerTrading: AdminDashboardFee;
  creation: AdminDashboardFee;
  /** Meteora's own share, shown for reference only; the platform cannot claim it. */
  protocol: {
    tradingLifetimeSol: string | null;
    tradingUnclaimedSol: string | null;
    creationLifetimeSol: string | null;
  };
  pools: number | null;
  config: string | null;
  /** Unix seconds of the on-chain read the figures come from. */
  readAt: number | null;
  error: string | null;
}

export interface AdminDashboardVaultBalance {
  mint: string;
  tokenAccount: string;
  amount: string;
  updatedAt: number;
}

export interface AdminDashboardClaimCounts {
  pending: number | null;
  paid: number | null;
}

export interface AdminDashboardReferrals {
  invited: number | null;
  qualified: number | null;
  oreCredited: string | null;
}

export interface AdminDashboardJob {
  lastSuccessfulAt: number | null;
  lastError: string | null;
}

export interface AdminDashboardVault {
  address: string | null;
  solBalance: string | null;
  solscanUrl: string | null;
  tokenBalances: AdminDashboardVaultBalance[];
}

export interface AdminDashboardPayload {
  actor: string;
  generatedAt: number;
  cachedUntil: number;
  chainMode: ChainMode;
  cluster: "devnet" | "mainnet-beta";
  launches: AdminDashboardCount;
  graduated: AdminDashboardCount;
  tradingVolume: {
    last24h: AdminDashboardVolume;
    last7d: AdminDashboardVolume;
    all: AdminDashboardVolume;
  };
  fees: AdminDashboardFees;
  vault: AdminDashboardVault;
  claims: AdminDashboardClaimCounts;
  players: AdminDashboardCount;
  crews: {
    active24h: number | null;
  };
  referrals: AdminDashboardReferrals;
  jobs: {
    indexer: AdminDashboardJob;
    vaultSweep: AdminDashboardJob;
    cron: AdminDashboardJob;
  };
  addresses: {
    treasury: string | null;
    feeClaimer: string | null;
    vault: string | null;
  };
  links: {
    treasury: string | null;
    feeClaimer: string | null;
    vault: string | null;
  };
}
