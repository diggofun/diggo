import { describe, expect, it } from "vitest";
import { DIGGO_CONFIG } from "./config";
import {
  isWashTrade,
  referralCooldownRemaining,
  referralVolumeQualified,
  validateReferralCode,
} from "./referral";

describe("referral code validation", () => {
  it("normalizes case and accepts the allowed slug characters", () => {
    expect(validateReferralCode("  Jurek_01 ")).toEqual({ ok: true, code: "jurek_01" });
    expect(validateReferralCode("a-b_9").ok).toBe(true);
  });

  it("enforces the inclusive 3 to 20 character bounds and charset", () => {
    expect(validateReferralCode("ab")).toEqual({ ok: false, reason: "too_short" });
    expect(validateReferralCode("a".repeat(21))).toEqual({ ok: false, reason: "too_long" });
    for (const value of ["a.b", "a b", "a+b", "a/b", "用户名"])
      expect(validateReferralCode(value), value).toEqual({ ok: false, reason: "charset" });
  });

  it("blocks reserved words, impersonation, and profanity", () => {
    for (const value of ["admin", "diggo", "support", "official", "shithead", "nazi_9"])
      expect(validateReferralCode(value).ok, value).toBe(false);
  });
});

describe("referral qualification rules", () => {
  it("uses one cumulative volume threshold and treats the boundary as qualified", () => {
    const threshold = DIGGO_CONFIG.referral.minimumVolumeLamports;
    expect(DIGGO_CONFIG.referral.welcomeBonusOre).toBe(0);
    expect(referralVolumeQualified(threshold - 1n)).toBe(false);
    expect(referralVolumeQualified(threshold)).toBe(true);
    expect(referralVolumeQualified(threshold + 1n)).toBe(true);
  });

  it("excludes a transaction containing both the referrer and referred wallet", () => {
    expect(isWashTrade("referee", "referrer", ["referee", "referrer", "pool"])).toBe(true);
    expect(isWashTrade("referee", "referrer", ["referee", "pool"])).toBe(false);
    expect(isWashTrade("same", "same", ["same"])).toBe(false);
  });

  it("returns the full seven-day rename cooldown at its boundary", () => {
    const now = 1_800_000_000;
    const cooldown = DIGGO_CONFIG.referral.renameCooldownSeconds;
    expect(referralCooldownRemaining(now - cooldown + 1, now)).toBe(1);
    expect(referralCooldownRemaining(now - cooldown, now)).toBe(0);
  });
});
