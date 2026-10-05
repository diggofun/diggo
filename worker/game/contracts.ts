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
  /**
   * A sponsored mine: a project deposited tokens of an existing mint into the mining vault. It has
   * no bonding curve to graduate from, so it pays out as soon as the vault holds the deposit.
   */
  sponsored?: boolean;
  /**
   * The raw amount this mine releases over the mining period, as a decimal string so the coin stays
   * JSON-safe in API responses. Defaults to MINING_RESERVE.
   */
  reserve?: string;
  /** The mint's decimals. Defaults to TOKEN_DECIMALS. */
  decimals?: number;
  /** How long the reserve takes to release, in seconds. Defaults to the launch allocation period. */
  miningSeconds?: number;
  /** Who funded a sponsored mine, for display. */
  sponsor?: string;
}

export function coinReserve(coin: Pick<GameCoin, "reserve">): bigint {
  if (coin.reserve === undefined || !/^[1-9][0-9]{0,30}$/.test(coin.reserve)) return MINING_RESERVE;
  return BigInt(coin.reserve);
}

export function coinDecimals(coin: Pick<GameCoin, "decimals"> | null | undefined): number {
  const decimals = coin?.decimals;
  return decimals !== undefined && Number.isInteger(decimals) && decimals >= 0 && decimals <= 18 ? decimals : TOKEN_DECIMALS;
}

/** Raw units to whole tokens for display. */
export function wholeAmount(raw: bigint, coin: Pick<GameCoin, "decimals"> | null | undefined): number {
  return Number(raw) / 10 ** coinDecimals(coin);
}

/**
 * Whether rewards of this coin can be transferred. A launch pays out after it graduates; a
 * sponsored mine pays out from the start, since its tokens already trade and sit in the vault.
 */
export function isPayableCoin(coin: Pick<GameCoin, "graduated" | "sponsored"> | null | undefined): boolean {
  return Boolean(coin && (coin.graduated || coin.sponsored));
}

/** Integration seam implemented by worker/meteora in the routing integration step. */
export interface GameCoinSource {
  listActiveMines(): Promise<readonly GameCoin[]>;
  getMine(mint: string): Promise<GameCoin | null>;
}

export interface MiningPayoutResult {
  /** Legacy serialized transaction containing the vault signature and the player's empty signature slot. */
  transaction: string;
  /** Unix seconds after which the client should not ask the wallet to sign this transaction. */
  expiresAt: number;
}

/** One transfer inside an aggregate payout; the order matches the signed transaction. */
export interface ClaimBatchItem {
  /** All claims this one transfer settles; a mint can carry both mined and discovery rewards. */
  claimIds: string[];
  mint: string;
  amount: bigint;
}

export interface ClaimBatchResult {
  id: string;
  transaction: string;
  expiresAt: number;
  items: ClaimBatchItem[];
}

/**
 * What the vault's real token account for one mint can provably pay right now.
 *
 * `null` means the chain could not be read, which is not the same as an empty balance: an unknown
 * inventory must never be mistaken for sufficient funds, but it also must not be reported to the
 * player as a shortfall. Only a positive `available` is a proven ability to pay.
 */
export type VaultInventory = { available: bigint; account: string | null } | null;

/** The sole abstraction permitted to move real mine tokens. */
export interface MiningPayout {
  prepare(
    mint: string,
    wallet: string,
    amount: bigint,
    idempotencyKey: string,
  ): Promise<MiningPayoutResult>;
  confirm(claimId: string, signature: string): Promise<boolean>;
  /**
   * Signs every listed claim in one transaction, or none. The batch is refused rather than trimmed:
   * a payout that silently omitted an unfunded mint would be reported to the player as "all" while
   * leaving rewards behind.
   */
  prepareBatch(wallet: string, items: ClaimBatchItem[], batchId: string): Promise<ClaimBatchResult>;
  /** Returns the claims the verified signature settled, or an empty list while the chain is unconfirmed. */
  /** The authenticated wallet is mandatory: a batch may never be inspected or mutated by another session. */
  confirmBatch(wallet: string, batchId: string, signature: string): Promise<ClaimBatchItem[]>;
  /**
   * Reads the vault's real SPL balance for a mint without signing anything.
   *
   * Claim-all filters on this before it calls `prepareBatch`, because the vault refuses a batch
   * containing a mint it cannot fund, and that refusal is all-or-nothing. Proving sufficiency here
   * keeps one unfunded mint from cancelling an otherwise payable batch.
   */
  vaultInventory(mint: string): Promise<VaultInventory>;
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
