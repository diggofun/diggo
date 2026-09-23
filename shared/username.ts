/**
 * Public usernames: the one piece of player-authored identity Diggo.fun shows next to a wallet.
 *
 * Validation is pure and shared, so the Worker (worker/profile.ts) and the editor UI
 * (src/components/UsernameEditor.tsx) refuse the same input for the same reason. The Worker stays
 * the authority; the client copy exists so an obvious typo is answered before a round trip.
 *
 * Two lists do the blocking, and they are deliberately different in shape:
 *
 *  - `reserved` are names that read as Diggo.fun itself. A name that merely *contains* one is fine
 *    ("badminton" is not an admin), but one that starts or ends with a reserved word of
 *    reservedPrefixMinLength characters or more is not, which is what catches "admin_jan",
 *    "diggo_official" and "theofficial".
 *  - `blockedSubstrings` / `blockedExact` are the profanity and harassment filter. Long,
 *    distinctive stems match anywhere; short words that are ordinary fragments of innocent names
 *    ("ass", "cock", "sex", "anal") only match the whole name, so "peacock" and "analyst" stay
 *    available.
 *
 * Storage keeps both forms (migrations/0018_usernames.sql): the display form exactly as typed, and
 * the normalized lowercase form that carries the UNIQUE index, so two players cannot hold names
 * that differ only in case.
 *
 * Everything is configurable through UsernameRules, and an operator can extend the reserved list
 * from the Worker environment (USERNAME_EXTRA_RESERVED) without editing this file.
 */

export interface UsernameRules {
  /** Inclusive bounds on the stored display form. */
  readonly minLength: number;
  readonly maxLength: number;
  /** How long a player waits between two changes. */
  readonly cooldownSeconds: number;
  /** Names that read as Diggo.fun staff, support or brand. */
  readonly reserved: readonly string[];
  /** Distinctive stems blocked anywhere in the name. */
  readonly blockedSubstrings: readonly string[];
  /** Short words blocked only when they are the whole name. */
  readonly blockedExact: readonly string[];
  /** Reserved words shorter than this only block an exact match. */
  readonly reservedPrefixMinLength: number;
}

/** The character set a username may use: letters, digits and underscores, nothing else. */
export const USERNAME_PATTERN = /^[a-zA-Z0-9_]+$/;

export const USERNAME_RULES: UsernameRules = Object.freeze({
  minLength: 3,
  maxLength: 20,
  cooldownSeconds: 7 * 86_400,
  reservedPrefixMinLength: 5,
  reserved: Object.freeze([
    "admin",
    "administrator",
    "billing",
    "dev",
    "developer",
    "diggo",
    "diggofun",
    "founder",
    "helpdesk",
    "mod",
    "moderator",
    "official",
    "owner",
    "root",
    "security",
    "staff",
    "support",
    "system",
    "team",
  ]),
  blockedSubstrings: Object.freeze([
    "1488",
    "bitch",
    "cunt",
    "fag",
    "fuck",
    "hitler",
    "kys",
    "molest",
    "nazi",
    "nigg",
    "pedo",
    "penis",
    "pussy",
    "retard",
    "shit",
    "slut",
    "vagina",
    "whore",
  ]),
  blockedExact: Object.freeze(["anal", "arse", "ass", "cock", "cum", "dick", "heil", "rape", "sex", "tits"]),
});

/** The messages both the Worker and the editor show, so the two never disagree. */
export const USERNAME_MESSAGES = Object.freeze({
  taken: "That username is already taken.",
  tooSoon: "You can change your username again later.",
});

/** Why a candidate was refused. Every reason is a 400; taken is 409 and too soon is 429. */
export type UsernameRejection = "empty" | "too_short" | "too_long" | "charset" | "reserved" | "blocked";

export interface UsernameAccepted {
  readonly ok: true;
  /** Display form, trimmed, exactly as the player typed it. */
  readonly username: string;
  /** Lowercase form the UNIQUE index is built on. */
  readonly normalized: string;
}

export interface UsernameRefused {
  readonly ok: false;
  readonly reason: UsernameRejection;
}

export type UsernameValidation = UsernameAccepted | UsernameRefused;

/** Lowercase and trimmed: the form uniqueness is decided on, never the form that is displayed. */
export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

export function validateUsername(value: unknown, rules: UsernameRules = USERNAME_RULES): UsernameValidation {
  if (typeof value !== "string") return { ok: false, reason: "empty" };
  const username = value.trim();
  if (username.length === 0) return { ok: false, reason: "empty" };
  if (username.length < rules.minLength) return { ok: false, reason: "too_short" };
  if (username.length > rules.maxLength) return { ok: false, reason: "too_long" };
  if (!USERNAME_PATTERN.test(username)) return { ok: false, reason: "charset" };
  const normalized = username.toLowerCase();
  if (isReservedUsername(normalized, rules)) return { ok: false, reason: "reserved" };
  if (isBlockedUsername(normalized, rules)) return { ok: false, reason: "blocked" };
  return { ok: true, username, normalized };
}

/** Whether a normalized name reads as Diggo.fun itself. */
export function isReservedUsername(normalized: string, rules: UsernameRules = USERNAME_RULES): boolean {
  for (const word of rules.reserved) {
    if (normalized === word) return true;
    // Short words ("dev", "mod") would otherwise block innocent names that merely begin with them.
    if (word.length >= rules.reservedPrefixMinLength && (normalized.startsWith(word) || normalized.endsWith(word))) {
      return true;
    }
  }
  return false;
}

/** Whether a normalized name trips the profanity and harassment filter. */
export function isBlockedUsername(normalized: string, rules: UsernameRules = USERNAME_RULES): boolean {
  if (rules.blockedExact.includes(normalized)) return true;
  return rules.blockedSubstrings.some((stem) => normalized.includes(stem));
}

/** The copy for one rejection. Never carries a score, a threshold or an internal name. */
export function usernameRejectionMessage(reason: UsernameRejection): string {
  switch (reason) {
    case "too_short":
      return "Usernames are at least " + USERNAME_RULES.minLength + " characters.";
    case "too_long":
      return "Usernames are at most " + USERNAME_RULES.maxLength + " characters.";
    case "charset":
      return "Use letters, numbers and underscores only.";
    case "reserved":
      return "That name is reserved for Diggo.fun.";
    case "blocked":
      return "That username is not allowed.";
    default:
      return "Enter a username.";
  }
}

/** Seconds left on the change cooldown, or 0 when the player may change the name now. */
export function usernameCooldownRemaining(
  lastChangedAt: number,
  now: number,
  rules: UsernameRules = USERNAME_RULES,
): number {
  const elapsed = Math.max(0, now - lastChangedAt);
  return Math.max(0, rules.cooldownSeconds - elapsed);
}

/** "6 days", "5 hours", "20 minutes": the wait in the largest unit that still says something. */
export function formatUsernameCooldown(seconds: number): string {
  if (seconds >= 86_400) {
    const days = Math.ceil(seconds / 86_400);
    return days + (days === 1 ? " day" : " days");
  }
  if (seconds >= 3_600) {
    const hours = Math.ceil(seconds / 3_600);
    return hours + (hours === 1 ? " hour" : " hours");
  }
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return minutes + (minutes === 1 ? " minute" : " minutes");
}

/**
 * A tuned copy of the rules, used for the environment-driven overrides in worker/profile.ts.
 * Extra reserved words are normalized and merged; a cooldown that is not a finite, non-negative
 * number is ignored rather than turning the feature off.
 */
export function withUsernameRules(
  base: UsernameRules = USERNAME_RULES,
  overrides: { reserved?: readonly string[]; cooldownSeconds?: number } = {},
): UsernameRules {
  const extra = (overrides.reserved ?? [])
    .map((word) => normalizeUsername(String(word)))
    .filter((word) => word.length > 0 && !base.reserved.includes(word));
  const cooldownSeconds =
    typeof overrides.cooldownSeconds === "number" &&
    Number.isFinite(overrides.cooldownSeconds) &&
    overrides.cooldownSeconds >= 0
      ? Math.floor(overrides.cooldownSeconds)
      : base.cooldownSeconds;
  if (extra.length === 0 && cooldownSeconds === base.cooldownSeconds) return base;
  return Object.freeze({
    ...base,
    cooldownSeconds,
    reserved: Object.freeze([...base.reserved, ...extra]),
  });
}
