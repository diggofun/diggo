import { DIGGO_CONFIG } from "./config";
import {
  isBlockedUsername,
  isReservedUsername,
  USERNAME_RULES,
} from "./username";

export const REFERRAL_SKIN_ID = "outfit_referral_first";

export const REFERRAL_CODE_PATTERN = /^[a-z0-9_-]+$/;
export const REFERRAL_CODE_MIN = 3;
export const REFERRAL_CODE_MAX = 20;

export type ReferralRejection = "empty" | "too_short" | "too_long" | "charset" | "reserved" | "blocked";
export type ReferralValidation = { ok: true; code: string } | { ok: false; reason: ReferralRejection };

export function normalizeReferralCode(value: string): string {
  return value.trim().toLowerCase();
}

export function validateReferralCode(value: unknown): ReferralValidation {
  if (typeof value !== "string") return { ok: false, reason: "empty" };
  const code = normalizeReferralCode(value);
  if (!code) return { ok: false, reason: "empty" };
  if (code.length < REFERRAL_CODE_MIN) return { ok: false, reason: "too_short" };
  if (code.length > REFERRAL_CODE_MAX) return { ok: false, reason: "too_long" };
  if (!REFERRAL_CODE_PATTERN.test(code)) return { ok: false, reason: "charset" };
  if (isReservedUsername(code, USERNAME_RULES)) return { ok: false, reason: "reserved" };
  if (isBlockedUsername(code, USERNAME_RULES)) return { ok: false, reason: "blocked" };
  return { ok: true, code };
}

export function referralCooldownRemaining(lastChangedAt: number, now: number): number {
  return Math.max(0, DIGGO_CONFIG.referral.renameCooldownSeconds - Math.max(0, now - lastChangedAt));
}

export function referralVolumeQualified(volumeLamports: bigint, thresholdLamports = DIGGO_CONFIG.referral.minimumVolumeLamports): boolean {
  return volumeLamports >= thresholdLamports;
}

export function isWashTrade(referreeWallet: string, referrerWallet: string, participants: readonly string[]): boolean {
  return participants.includes(referrerWallet) && participants.includes(referreeWallet) && referreeWallet !== referrerWallet;
}

export function referralWeekIndex(now: number): number {
  return Math.floor(now / DIGGO_CONFIG.time.secondsPerWeek);
}

export function referralRejectionMessage(reason: ReferralRejection): string {
  switch (reason) {
    case "too_short": return "Referral codes are at least 3 characters.";
    case "too_long": return "Referral codes are at most 20 characters.";
    case "charset": return "Use lowercase letters, numbers, hyphens or underscores only.";
    case "reserved": return "That code is reserved for Diggo.fun.";
    case "blocked": return "That referral code is not allowed.";
    default: return "Enter a referral code.";
  }
}
