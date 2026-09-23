/**
 * Username rules (shared/username.ts).
 *
 * The two lists are tested for both directions on purpose: a reserved word or a blocked stem has to
 * be refused, and an innocent name that merely contains one has to stay available. The second half
 * is what a naive substring filter gets wrong, so it is asserted explicitly.
 */
import { describe, expect, it } from "vitest";
import {
  USERNAME_MESSAGES,
  USERNAME_PATTERN,
  USERNAME_RULES,
  formatUsernameCooldown,
  isBlockedUsername,
  isReservedUsername,
  normalizeUsername,
  usernameCooldownRemaining,
  usernameRejectionMessage,
  validateUsername,
  withUsernameRules,
  type UsernameRejection,
} from "./username";

const NOW = 1_800_000_000;

describe("username validation", () => {
  it("accepts a valid name and returns the display and normalized forms", () => {
    const result = validateUsername("  Miner_01  ");
    expect(result).toEqual({ ok: true, username: "Miner_01", normalized: "miner_01" });
    expect(normalizeUsername("  DiggoFan  ")).toBe("diggofan");
  });

  it("enforces the length bounds inclusively", () => {
    expect(validateUsername("ab")).toEqual({ ok: false, reason: "too_short" });
    expect(validateUsername("abc").ok).toBe(true);
    expect(validateUsername("a".repeat(USERNAME_RULES.maxLength)).ok).toBe(true);
    expect(validateUsername("a".repeat(USERNAME_RULES.maxLength + 1))).toEqual({
      ok: false,
      reason: "too_long",
    });
  });

  it("allows only letters, digits and underscores", () => {
    for (const candidate of ["user-name", "user name", "user.name", "user@name", "üser", "user!"]) {
      expect(validateUsername(candidate), candidate).toEqual({ ok: false, reason: "charset" });
    }
    expect(USERNAME_PATTERN.test("Miner_01")).toBe(true);
  });

  it("treats a missing, empty or whitespace-only name as empty", () => {
    for (const candidate of [undefined, null, 42, {}, "", "   "]) {
      expect(validateUsername(candidate)).toEqual({ ok: false, reason: "empty" });
    }
  });

  it("refuses reserved words, including one wrapped in other text", () => {
    for (const candidate of ["admin", "Admin", "diggo", "support", "moderator", "system", "official", "staff"]) {
      expect(validateUsername(candidate), candidate).toEqual({ ok: false, reason: "reserved" });
    }
    for (const candidate of ["admin_jan", "diggo_official", "theofficial", "DiggoFan99"]) {
      expect(validateUsername(candidate), candidate).toEqual({ ok: false, reason: "reserved" });
    }
    expect(isReservedUsername("admin_jan")).toBe(true);
    expect(isReservedUsername("theofficial")).toBe(true);
  });

  it("keeps innocent names that merely contain a short reserved word", () => {
    for (const candidate of ["badminton", "modest", "device", "devon", "steam", "rooter", "teamplayer", "renowned"]) {
      expect(validateUsername(candidate), candidate).toMatchObject({ ok: true });
    }
  });

  it("blocks profanity anywhere and short slurs only as the whole name", () => {
    for (const candidate of ["fucker", "nazi_x", "shithead", "xxbitchxx", "retarded"]) {
      expect(validateUsername(candidate), candidate).toEqual({ ok: false, reason: "blocked" });
    }
    for (const candidate of ["ass", "sex", "rape", "cock", "tits"]) {
      expect(validateUsername(candidate), candidate).toEqual({ ok: false, reason: "blocked" });
    }
    expect(isBlockedUsername("shithead")).toBe(true);
  });

  it("keeps innocent names that merely contain a short blocked word", () => {
    for (const candidate of ["peacock", "analyst", "grapes", "classic", "sheila", "assassin", "cocktail"]) {
      expect(validateUsername(candidate), candidate).toMatchObject({ ok: true });
    }
  });

  it("has copy for every rejection and never leaks an internal reason", () => {
    const reasons: UsernameRejection[] = ["empty", "too_short", "too_long", "charset", "reserved", "blocked"];
    const messages = reasons.map((reason) => usernameRejectionMessage(reason));
    for (const [index, message] of messages.entries()) {
      expect(message.length, reasons[index]).toBeGreaterThan(0);
      // Player-facing copy only: nothing about a score, a threshold or the gate behind it.
      expect(message, reasons[index]).not.toMatch(/\bscore\b|\brisk\b|\bgate\b|\bsignal\b/i);
    }
    expect(new Set(messages).size).toBe(reasons.length);
    expect(USERNAME_MESSAGES.taken.length).toBeGreaterThan(0);
    expect(USERNAME_MESSAGES.tooSoon.length).toBeGreaterThan(0);
  });
});

describe("username cooldown", () => {
  it("counts down to zero and never goes negative", () => {
    expect(usernameCooldownRemaining(NOW, NOW)).toBe(USERNAME_RULES.cooldownSeconds);
    expect(usernameCooldownRemaining(NOW - 100, NOW)).toBe(USERNAME_RULES.cooldownSeconds - 100);
    expect(usernameCooldownRemaining(NOW - USERNAME_RULES.cooldownSeconds, NOW)).toBe(0);
    expect(usernameCooldownRemaining(NOW - USERNAME_RULES.cooldownSeconds - 1, NOW)).toBe(0);
    // A clock that jumped backwards must not hand out a longer wait than the cooldown itself.
    expect(usernameCooldownRemaining(NOW + 5_000, NOW)).toBe(USERNAME_RULES.cooldownSeconds);
  });

  it("describes the wait in the largest unit that still says something", () => {
    expect(formatUsernameCooldown(6 * 86_400)).toBe("6 days");
    expect(formatUsernameCooldown(86_400)).toBe("1 day");
    expect(formatUsernameCooldown(3_600)).toBe("1 hour");
    expect(formatUsernameCooldown(7_200)).toBe("2 hours");
    expect(formatUsernameCooldown(90)).toBe("2 minutes");
    expect(formatUsernameCooldown(30)).toBe("1 minute");
    expect(formatUsernameCooldown(0)).toBe("1 minute");
  });
});

describe("username rules configuration", () => {
  it("ships frozen defaults", () => {
    expect(Object.isFrozen(USERNAME_RULES)).toBe(true);
    expect(Object.isFrozen(USERNAME_RULES.reserved)).toBe(true);
    expect(USERNAME_RULES.minLength).toBe(3);
    expect(USERNAME_RULES.maxLength).toBe(20);
    expect(USERNAME_RULES.cooldownSeconds).toBe(7 * 86_400);
  });

  it("extends the reserved list from configuration without touching the defaults", () => {
    const tuned = withUsernameRules(USERNAME_RULES, { reserved: ["  Scammer ", "diggo", ""] });
    expect(tuned.reserved).toContain("scammer");
    expect(tuned.reserved.filter((word) => word === "diggo")).toHaveLength(1);
    expect(validateUsername("scammer_jan", tuned)).toEqual({ ok: false, reason: "reserved" });
    expect(validateUsername("scammer_jan")).toMatchObject({ ok: true });
    expect(USERNAME_RULES.reserved).not.toContain("scammer");
  });

  it("honours a tuned cooldown and ignores a nonsensical one", () => {
    expect(withUsernameRules(USERNAME_RULES, { cooldownSeconds: 60 }).cooldownSeconds).toBe(60);
    expect(withUsernameRules(USERNAME_RULES, { cooldownSeconds: 60.7 }).cooldownSeconds).toBe(60);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, undefined]) {
      expect(withUsernameRules(USERNAME_RULES, { cooldownSeconds: bad }).cooldownSeconds).toBe(
        USERNAME_RULES.cooldownSeconds,
      );
    }
  });

  it("returns the shared defaults untouched when there is nothing to tune", () => {
    expect(withUsernameRules(USERNAME_RULES, { reserved: [], cooldownSeconds: USERNAME_RULES.cooldownSeconds })).toBe(
      USERNAME_RULES,
    );
  });
});
