import { applyActivation, type ActivationRecord } from "../../shared/streak";
import { crewPower } from "../../shared/crew";
import { discoveryDayIndex } from "../../shared/discovery";
import { bytesToHex, sha256 } from "../../shared/epochSeed";
import type { GameCoin, GamePlayerState } from "./contracts";
import { MINING_RESERVE as RESERVE } from "./contracts";

export const MINING_ALLOCATION_DAYS = 3_650;
export const MINING_SECONDS = MINING_ALLOCATION_DAYS * 86_400;
/** One qualified referral may credit up to 250 ORE, matching the native program. */
export const REFERRAL_ORE = 250;
export const REFERRAL_ORE_PER_CREDIT_MAX = 250;
/** At most 25 qualified referrals can credit one referrer in a Unix week. */
export const REFERRAL_WEEKLY_COUNT = 25;
export const REFERRAL_WEEKLY_MAX = REFERRAL_ORE_PER_CREDIT_MAX * REFERRAL_WEEKLY_COUNT;
export const DISCOVERY_REWARD = 1_000_000n;
export const DISCOVERY_MIN_WALLET_AGE_SECONDS = 7 * 86_400;
export const DISCOVERY_MIN_PORTFOLIO_USD = 10;

function positiveInt(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Linear, lazy release of the 200M leftover allocation. It never relies on a cron being on time. */
export function releasedMiningAllocation(
  now: number,
  startsAt: number,
  total: bigint = RESERVE,
): bigint {
  if (total <= 0n || now <= startsAt) return 0n;
  const elapsed = BigInt(Math.min(MINING_SECONDS, Math.max(0, Math.floor(now - startsAt))));
  return (total * elapsed) / BigInt(MINING_SECONDS);
}

export interface MiningAccrualInput {
  mine: GameCoin;
  wallet: string;
  now: number;
  lastSettledAt: number;
  assignedPower: number;
  totalEligiblePower: number;
  releasedBefore: bigint;
  releasedNow: bigint;
  claimableBefore: bigint;
  reserveRemainingBefore: bigint;
  committedBefore: bigint;
}

export interface MiningAccrual {
  claimable: bigint;
  committed: bigint;
  reserveRemaining: bigint;
}

/**
 * Settles one wallet's share of newly released reserve. Integer division leaves rounding dust in
 * the mine, and the next release can never allocate more than the mine's remaining 200M cap.
 */
export function accrueMining(input: MiningAccrualInput): MiningAccrual {
  if (input.lastSettledAt >= input.now || input.assignedPower <= 0 || input.totalEligiblePower <= 0) {
    return {
      claimable: input.claimableBefore,
      committed: input.committedBefore,
      reserveRemaining: input.reserveRemainingBefore,
    };
  }
  const unlocked = input.releasedNow > input.releasedBefore ? input.releasedNow - input.releasedBefore : 0n;
  const available = input.reserveRemainingBefore < unlocked ? input.reserveRemainingBefore : unlocked;
  const share = input.assignedPower < input.totalEligiblePower ? input.assignedPower : input.totalEligiblePower;
  const amount = (available * BigInt(share)) / BigInt(input.totalEligiblePower);
  return {
    claimable: input.claimableBefore + amount,
    committed: input.committedBefore + amount,
    reserveRemaining: input.reserveRemainingBefore - amount,
  };
}

export interface ReferralCreditInput {
  creditedThisWeek: number;
  oreThisWeek: number;
  amount?: number;
}

export type ReferralCreditResult =
  | { credited: true; amount: number; creditedThisWeek: number; oreThisWeek: number }
  | { credited: false; reason: "duplicate" | "weekly_cap"; amount: number };

export function referralCredit(input: ReferralCreditInput, duplicate = false): ReferralCreditResult {
  const amount = positiveInt(input.amount ?? REFERRAL_ORE);
  const count = positiveInt(input.creditedThisWeek);
  const ore = positiveInt(input.oreThisWeek);
  if (duplicate) return { credited: false, reason: "duplicate", amount };
  if (amount <= 0 || amount > REFERRAL_ORE_PER_CREDIT_MAX || count >= REFERRAL_WEEKLY_COUNT || ore + amount > REFERRAL_WEEKLY_MAX) {
    return { credited: false, reason: "weekly_cap", amount };
  }
  return { credited: true, amount, creditedThisWeek: count + 1, oreThisWeek: ore + amount };
}

export function weekIndex(now: number): number {
  return Math.floor(now / (7 * 86_400));
}

export function isWalletAgeEligible(player: Pick<GamePlayerState, "createdAt">, now: number): boolean {
  return now - player.createdAt >= DISCOVERY_MIN_WALLET_AGE_SECONDS;
}

export function isPortfolioEligible(portfolioUsd: number): boolean {
  return Number.isFinite(portfolioUsd) && portfolioUsd >= DISCOVERY_MIN_PORTFOLIO_USD;
}

export function activationRecord(player: GamePlayerState): ActivationRecord {
  return {
    activatedAt: player.activatedAt || null,
    activeUntil: player.activeUntil || null,
    lastActivationAt: player.lastActivationAt || null,
    streak: player.streak,
    longestStreak: player.longestStreak,
    streakFreezes: player.streakFreezes,
  };
}

export function applyGameActivation(player: GamePlayerState, now: number) {
  return applyActivation(activationRecord(player), now);
}

export function playerCrewPower(player: GamePlayerState): number {
  return crewPower(player.crew);
}

export interface DiscoverySeedInput {
  secret: string;
  epoch: number;
  wallet: string;
}

export function discoveryEpoch(now: number): number {
  return discoveryDayIndex(now);
}

export function discoveryId(input: DiscoverySeedInput): string {
  return bytesToHex(sha256(new TextEncoder().encode(`${input.secret}:${input.epoch}:${input.wallet}`)));
}

export function pickDiscoveryMint(id: string, coins: readonly GameCoin[]): GameCoin | null {
  const eligible = coins.filter((coin) => !coin.graduated);
  if (eligible.length === 0) return null;
  const value = Number.parseInt(id.slice(0, 8), 16) || 1;
  return eligible[value % eligible.length];
}
