import { applyActivation, type ActivationRecord } from "../../shared/streak";
import { crewPower } from "../../shared/crew";
import { discoveryDayIndex } from "../../shared/discovery";
import { bytesToHex, sha256 } from "../../shared/epochSeed";
import {
  onchainOreCapacity,
  onchainOreEfficiencyBps,
  onchainOreForActiveSeconds,
  onchainOreFromActivation,
  onchainOreMaturityBps,
  onchainStoreOre,
} from "../../shared/ore";
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
/**
 * What a wallet needs before it can COLLECT mined coins. Mining and discovery rolls are open to
 * every wallet; these only gate the payout, so a fresh or empty wallet can dig and accrue but
 * cannot take tokens out until it has a track record (wallet age, play days) and some value held.
 */
export const CLAIM_MIN_WALLET_AGE_SECONDS = 7 * 86_400;
export const CLAIM_MIN_PORTFOLIO_USD = 10;
export const CLAIM_MIN_ACTIVE_DAYS = 5;
export const CLAIM_MIN_ACTIVATIONS = 5;

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
  return now - player.createdAt >= CLAIM_MIN_WALLET_AGE_SECONDS;
}

export function isPortfolioEligible(portfolioUsd: number): boolean {
  return Number.isFinite(portfolioUsd) && portfolioUsd >= CLAIM_MIN_PORTFOLIO_USD;
}

/** Each requirement on its own, so the client can say exactly which one is still missing. */
export interface ClaimRequirements {
  met: boolean;
  walletAge: boolean;
  activeDays: boolean;
  activations: boolean;
  portfolio: boolean;
  /** The reading the portfolio check used; null when it could not be read. */
  portfolioUsd: number | null;
}

/**
 * Decides whether a wallet may collect. Every input that could not be read (no wallet age, no
 * portfolio value) counts as NOT met: an unreadable source must never open the payout.
 */
export function evaluateClaimRequirements(input: {
  walletCreatedAt: number | null;
  now: number;
  activeDays: number;
  validActivations: number;
  portfolioUsd: number | null;
}): ClaimRequirements {
  const created = input.walletCreatedAt;
  const walletAge = typeof created === "number" && Number.isFinite(created) && created !== 0 &&
    input.now - created >= CLAIM_MIN_WALLET_AGE_SECONDS;
  const activeDays = input.activeDays >= CLAIM_MIN_ACTIVE_DAYS;
  const activations = input.validActivations >= CLAIM_MIN_ACTIVATIONS;
  const portfolio = input.portfolioUsd !== null && isPortfolioEligible(input.portfolioUsd);
  return { met: walletAge && activeDays && activations && portfolio, walletAge, activeDays, activations, portfolio, portfolioUsd: input.portfolioUsd };
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

/**
 * Every game timestamp is Unix seconds. Anything larger than this is a millisecond value that
 * leaked in from `Date.now()` and must never be compared with a seconds clock.
 */
export const MAX_UNIX_SECONDS = 99_999_999_999;

/** The game clock: whole Unix seconds. */
export function unixSeconds(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 1_000);
}

/** ORE maturity for one shift, fixed at the shift's start so re-settling never re-rates it. */
export function shiftOreMaturityBps(player: Pick<GamePlayerState, "createdAt" | "activatedAt">): number {
  return onchainOreMaturityBps(Math.max(0, player.activatedAt - player.createdAt));
}

/** Cumulative ORE a shift has dug after `seconds` of activity, before the storage clamp. */
export function shiftOreAfter(player: Pick<GamePlayerState, "createdAt" | "activatedAt" | "crew">, seconds: number): number {
  return onchainOreForActiveSeconds(seconds, shiftOreMaturityBps(player), onchainOreEfficiencyBps(player.crew));
}

export interface ShiftOreSettlement {
  /** ORE actually stored this settlement (after the storage clamp). */
  stored: number;
  /** ORE the crew dug but storage could not hold. */
  overflow: number;
  oreBalance: number;
  oreEarned: number;
  /** The new ORE cursor: never before the shift start, never past the shift end. */
  lastOreAt: number;
}

/**
 * Settles the ORE an active shift dug since the last settlement. The crew digs inside
 * [activatedAt, activeUntil) whether or not the player is online, so the end of the interval is
 * min(now, activeUntil), not "now if still active". The amount is a difference of the cumulative
 * shift total, so settling every five minutes or once at the end books exactly the same ORE and
 * no per-settlement rounding is lost. Returns null when there is nothing new to settle.
 */
export function settleShiftOre(player: GamePlayerState, now: number): ShiftOreSettlement | null {
  if (player.activatedAt <= 0 || player.activeUntil <= player.activatedAt) return null;
  if (player.activatedAt > MAX_UNIX_SECONDS || player.activeUntil > MAX_UNIX_SECONDS) return null;
  const from = Math.max(player.lastOreAt, player.activatedAt);
  const to = Math.min(now, player.activeUntil);
  if (to <= from) return null;
  const dug = shiftOreAfter(player, to - player.activatedAt) - shiftOreAfter(player, from - player.activatedAt);
  const stored = onchainStoreOre(player.oreBalance, Math.max(0, dug), onchainOreCapacity(player.crew));
  return {
    stored: stored.stored,
    overflow: stored.overflow,
    oreBalance: stored.balance,
    oreEarned: player.oreEarned + stored.stored,
    lastOreAt: to,
  };
}

/** The activation bonus the native `activate` books, throttled by the same maturity ramp. */
export function activationBonusOre(player: Pick<GamePlayerState, "createdAt">, now: number): number {
  return onchainOreFromActivation(onchainOreMaturityBps(Math.max(0, now - player.createdAt)));
}

/**
 * The window a mining-token settlement may pay for: the part of the current shift after the
 * wallet's own cursor and after the mine opened, ending at min(now, activeUntil). A gap between
 * two shifts is never paid, and a shift that ended while the player was offline is still paid.
 */
export function miningSettlementWindow(
  player: Pick<GamePlayerState, "activatedAt" | "activeUntil">,
  lastSettledAt: number,
  miningStartsAt: number,
  now: number,
): { start: number; end: number } | null {
  if (player.activatedAt <= 0 || player.activeUntil <= player.activatedAt) return null;
  if (player.activatedAt > MAX_UNIX_SECONDS || player.activeUntil > MAX_UNIX_SECONDS || lastSettledAt > MAX_UNIX_SECONDS) return null;
  const start = Math.max(lastSettledAt, player.activatedAt, miningStartsAt);
  const end = Math.min(now, player.activeUntil);
  return end > start ? { start, end } : null;
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
