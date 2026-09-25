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

export interface AdminDashboardFee {
  accruedSol: string | null;
  claimableSol: string | null;
  estimated: boolean;
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
  fees: {
    partnerTrading: AdminDashboardFee;
    creation: AdminDashboardFee;
  };
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
