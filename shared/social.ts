/**
 * Social layer: Cosmetics (spec 34), Achievements, Seasons/seasonal points, the gameplay
 * progression leaderboard categories (spec 68) and Notifications (spec 75).
 *
 * Everything in this module is pure and deterministic so it can be tested without D1 and reused
 * by the worker modules beside it (worker/cosmetics.ts, worker/notifications.ts,
 * worker/leaderboard.ts).
 *
 * The invariant this file protects: cosmetics and leaderboards are progression-only.
 *   - No function here accepts a payment, a token amount or a token price.
 *   - The cosmetics catalog is scanned for gameplay/economic effect fields at module load, so a
 *     cosmetic that grants Power, luck, block share, a reward multiplier or a better expected
 *     financial return cannot be added without failing fast (see assertNoCosmeticEffects).
 *   - Seasonal points are derived from gameplay events only, never from token amounts held.
 *   - Leaderboard prizes are capped and non-financial (see LEADERBOARD_POLICY); real-value prizes
 *     would require additional anti-Sybil work that this change does not implement.
 */
import {
  DIGGO_CONFIG,
  type CrewLevels,
  type DiggoConfig,
  type DiscoveryRarity,
  type RewardState,
  type StreakMilestoneConfig,
} from "./config";
import { crewTier, crewTotalLevel } from "./crew";
import { oreFromAchievement } from "./ore";
import { streakDeadline } from "./streak";
import type { TokenStatus } from "./types";

/* Cosmetics (spec 34) */

export type CosmeticKind =
  | "miner_outfit"
  | "pickaxe"
  | "cart"
  | "mine_theme"
  | "explosion"
  | "profile_frame"
  | "title"
  | "badge";

/** earned = granted by gameplay; purchasable = never granted by gameplay and never tied to power. */
export type CosmeticSource = "earned" | "purchasable";
/** Payments are not implemented: every purchasable cosmetic is 'coming_soon' until then. */
export type CosmeticStatus = "available" | "coming_soon";

export type CosmeticUnlock =
  | { readonly type: "streak"; readonly day: number }
  | { readonly type: "achievement"; readonly achievementId: string }
  | { readonly type: "tier"; readonly tier: number }
  | { readonly type: "season_points"; readonly points: number };

export interface CosmeticItem {
  readonly id: string;
  readonly kind: CosmeticKind;
  readonly name: string;
  readonly description: string;
  readonly source: CosmeticSource;
  readonly status: CosmeticStatus;
  /** Unlock condition; null on an earned item means "owned from the start". */
  readonly unlock: CosmeticUnlock | null;
}

/**
 * Field names that would make a cosmetic affect gameplay or economics. Matching uses a normalized
 * name (lowercased, non-alphanumerics stripped), so bonusPower, bonus_power and BONUS-POWER all
 * resolve to the same forbidden key.
 */
const FORBIDDEN_EFFECT_KEYS: readonly string[] = Object.freeze([
  "power",
  "miningpower",
  "bonuspower",
  "powerbonus",
  "hashrate",
  "luck",
  "luckbps",
  "tokenluck",
  "realluck",
  "discoveryluck",
  "discoveryodds",
  "raritybonus",
  "share",
  "blockshare",
  "blocksharebps",
  "multiplier",
  "rewardmultiplier",
  "oremultiplier",
  "orebonus",
  "oreperhour",
  "oregain",
  "efficiency",
  "orefficiency",
  "bonus",
  "discount",
  "costdiscount",
  "xp",
  "xpbonus",
  "yield",
  "apy",
  "expectedreturn",
  "expectedfinancialreturn",
  "tokenbonus",
  "tokenrate",
  "incomebonus",
]);

/**
 * Numeric fields a cosmetic row may carry. Every one of them is a threshold or an identifier,
 * never an effect magnitude; the catalog test asserts nothing else numeric sneaks in.
 */
export const COSMETIC_ALLOWED_NUMERIC_FIELDS: readonly string[] = Object.freeze(["day", "tier", "points"]);

export function normalizeFieldName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Paths of every gameplay/economic effect field found in an arbitrary value. */
export function cosmeticEffectFields(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => cosmeticEffectFields(entry, path + "[" + index + "]"));
  }
  if (value === null || typeof value !== "object") return [];
  const found: string[] = [];
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const here = path ? path + "." + key : key;
    if (FORBIDDEN_EFFECT_KEYS.includes(normalizeFieldName(key))) found.push(here);
    found.push(...cosmeticEffectFields(entry, here));
  }
  return found;
}

/**
 * Numeric fields outside COSMETIC_ALLOWED_NUMERIC_FIELDS. Used by the catalog test so that adding
 * a "bonusMultiplierBps"-style field has to be a deliberate, reviewed decision.
 */
export function cosmeticUnexpectedNumericFields(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => cosmeticUnexpectedNumericFields(entry, path + "[" + index + "]"));
  }
  if (value === null || typeof value !== "object") return [];
  const found: string[] = [];
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const here = path ? path + "." + key : key;
    if (typeof entry === "number" && !COSMETIC_ALLOWED_NUMERIC_FIELDS.includes(key)) found.push(here);
    found.push(...cosmeticUnexpectedNumericFields(entry, here));
  }
  return found;
}

function earnedCosmetic(
  id: string,
  kind: CosmeticKind,
  name: string,
  description: string,
  unlock: CosmeticUnlock | null,
): CosmeticItem {
  return { id, kind, name, description, source: "earned", status: "available", unlock };
}

function purchasableCosmetic(id: string, kind: CosmeticKind, name: string, description: string): CosmeticItem {
  return { id, kind, name, description, source: "purchasable", status: "coming_soon", unlock: null };
}

const streakUnlock = (day: number): CosmeticUnlock => ({ type: "streak", day });
const achievementUnlock = (achievementId: string): CosmeticUnlock => ({ type: "achievement", achievementId });
const tierUnlock = (tier: number): CosmeticUnlock => ({ type: "tier", tier });

/** Catalog of every cosmetic: outfits, pickaxes, carts, themes, explosions, frames, titles, badges. */
export const COSMETIC_CATALOG: readonly CosmeticItem[] = Object.freeze([
  earnedCosmetic("outfit_referral_first", "miner_outfit", "Founding Referrer Coveralls", "Exclusive visual outfit unlocked by the first qualified referral.", null),
  earnedCosmetic("outfit_canvas", "miner_outfit", "Canvas Coveralls", "Starter workwear for your first stretch of digging.", streakUnlock(3)),
  earnedCosmetic("outfit_steel", "miner_outfit", "Steel Plate Rig", "Industrial plating for a Tier 3 crew.", tierUnlock(3)),
  earnedCosmetic("outfit_gilded", "miner_outfit", "Gilded Overalls", "Gold trimmed gear for a Mega Mining Operation.", tierUnlock(5)),
  earnedCosmetic("outfit_legendary", "miner_outfit", "Legendary Diggo Fit", "Reserved for a Legendary Diggo Crew.", tierUnlock(6)),
  purchasableCosmetic("outfit_neon", "miner_outfit", "Neon Nightshift", "Decorative shift suit. Coming soon."),
  earnedCosmetic("pickaxe_rusted", "pickaxe", "Rusted Starter Pick", "The pick you begin with. No bonuses, just honest iron.", null),
  earnedCosmetic("pickaxe_iron", "pickaxe", "Iron Week Pick", "One week of daily digging.", streakUnlock(7)),
  earnedCosmetic("pickaxe_diamond", "pickaxe", "Diamond Core Pick", "Deep Mine Division issue.", tierUnlock(4)),
  earnedCosmetic("pickaxe_plasma", "pickaxe", "Plasma Drift Pick", "Witness a mine run out of reserve.", achievementUnlock("FULLY_MINED_WITNESS")),
  purchasableCosmetic("pickaxe_chrome", "pickaxe", "Chrome Showpiece Pick", "Display only chrome. Coming soon."),
  earnedCosmetic("cart_standard", "cart", "Standard Ore Cart", "The cart you start with.", null),
  earnedCosmetic("cart_rail", "cart", "Fortnight Rail Cart", "Fourteen days of daily digging.", streakUnlock(14)),
  earnedCosmetic("cart_hauler", "cart", "Ten Block Hauler", "Haul ten mined blocks.", achievementUnlock("TEN_BLOCKS")),
  purchasableCosmetic("cart_hover", "cart", "Hover Cart", "Floating showpiece cart. Coming soon."),
  earnedCosmetic("theme_standard", "mine_theme", "Shaft Standard", "The default mine look.", null),
  earnedCosmetic("theme_sunset", "mine_theme", "Sunset Shaft", "Thirty days of daily digging.", streakUnlock(30)),
  earnedCosmetic("theme_arcane", "mine_theme", "Arcane Shaft", "Industrial Crew tier theme.", achievementUnlock("CREW_TIER_3")),
  purchasableCosmetic("theme_deepcore", "mine_theme", "Deep Core Theme", "Alternate visual theme. Coming soon."),
  earnedCosmetic("explosion_dust", "explosion", "Dust Puff", "The honest default blast.", null),
  earnedCosmetic("explosion_sparkle", "explosion", "Sparkle Blast", "One week of daily digging.", streakUnlock(7)),
  earnedCosmetic("explosion_rockfall", "explosion", "Rockfall Blast", "Your first memecoin discovery.", achievementUnlock("FIRST_DISCOVERY")),
  purchasableCosmetic("explosion_confetti", "explosion", "Confetti Blast", "Party blast effect. Coming soon."),
  earnedCosmetic("frame_bronze", "profile_frame", "Bronze Frame", "Your first activation.", achievementUnlock("FIRST_ACTIVATION")),
  earnedCosmetic("frame_silver", "profile_frame", "Silver Frame", "Fourteen days of daily digging.", streakUnlock(14)),
  earnedCosmetic("frame_gold", "profile_frame", "Gold Frame", "Mega Mining Operation frame.", tierUnlock(5)),
  earnedCosmetic("frame_diamond", "profile_frame", "Diamond Frame", "Witness a mine run out of reserve.", achievementUnlock("FULLY_MINED_WITNESS")),
  purchasableCosmetic("frame_holo", "profile_frame", "Holo Frame", "Decorative frame. Coming soon."),
  earnedCosmetic("title_steady_digger", "title", "Steady Digger", "Seven day streak title.", streakUnlock(7)),
  earnedCosmetic("title_foreman_material", "title", "Foreman Material", "Thirty day streak title.", streakUnlock(30)),
  earnedCosmetic("title_century_miner", "title", "Century Miner", "One hundred day streak title.", streakUnlock(100)),
  earnedCosmetic("title_legendary_diggo", "title", "Legendary Diggo", "A full year of daily digging.", streakUnlock(365)),
  purchasableCosmetic("title_patron", "title", "Patron", "Decorative title. Coming soon."),
  earnedCosmetic("badge_first_steps", "badge", "First Steps", "Badge for your first activation.", achievementUnlock("FIRST_ACTIVATION")),
  earnedCosmetic("badge_week_one", "badge", "Week One", "Badge for a seven day streak.", achievementUnlock("WEEK_STREAK")),
  earnedCosmetic("badge_first_find", "badge", "First Find", "Badge for your first discovery.", achievementUnlock("FIRST_DISCOVERY")),
  earnedCosmetic("badge_industrial", "badge", "Industrial", "Badge for reaching Tier 3.", achievementUnlock("CREW_TIER_3")),
  purchasableCosmetic("badge_supporter", "badge", "Supporter", "Decorative badge. Coming soon."),
]);

/** Throws if any catalog entry could affect gameplay or economics. Called at module load. */
export function assertNoCosmeticEffects(catalog: readonly CosmeticItem[] = COSMETIC_CATALOG): void {
  for (const item of catalog) {
    const fields = cosmeticEffectFields(item);
    if (fields.length > 0) {
      throw new Error("Cosmetic " + item.id + " declares gameplay/economic effect fields: " + fields.join(", "));
    }
  }
}

export const COSMETIC_SLOT_BY_KIND: Readonly<Record<CosmeticKind, string>> = Object.freeze({
  miner_outfit: "outfit",
  pickaxe: "pickaxe",
  cart: "cart",
  mine_theme: "mine_theme",
  explosion: "explosion",
  profile_frame: "profile_frame",
  title: "title",
  badge: "badge",
});

export type CosmeticSlot = (typeof COSMETIC_SLOT_BY_KIND)[CosmeticKind];
export const COSMETIC_SLOTS: readonly CosmeticSlot[] = Object.freeze(Object.values(COSMETIC_SLOT_BY_KIND));

export function cosmeticSlot(kind: CosmeticKind): CosmeticSlot {
  return COSMETIC_SLOT_BY_KIND[kind] as CosmeticSlot;
}

export function cosmeticById(id: string, catalog: readonly CosmeticItem[] = COSMETIC_CATALOG): CosmeticItem | null {
  return catalog.find((item) => item.id === id) ?? null;
}

/** Payments are deliberately not implemented (spec 34): purchasable items stay display-only. */
export const PURCHASABLE_COSMETICS_ENABLED = false;

export interface CosmeticUnlockContext {
  readonly streak: number;
  readonly crewTier: number;
  readonly achievementIds: readonly string[];
  readonly seasonPoints: number;
}

export function cosmeticUnlocked(item: CosmeticItem, ctx: CosmeticUnlockContext): boolean {
  // This catalog row is a visual reward only. It must never be granted by the progression sweep;
  // worker/referrals.ts inserts it into player_cosmetics after a qualified attribution.
  if (item.id === "outfit_referral_first") return false;
  if (item.source === "purchasable") return false;
  if (item.unlock === null) return true;
  switch (item.unlock.type) {
    case "streak":
      return ctx.streak >= item.unlock.day;
    case "achievement":
      return ctx.achievementIds.includes(item.unlock.achievementId);
    case "tier":
      return ctx.crewTier >= item.unlock.tier;
    case "season_points":
      return ctx.seasonPoints >= item.unlock.points;
    default:
      return false;
  }
}

export function unlockedCosmeticIds(
  ctx: CosmeticUnlockContext,
  catalog: readonly CosmeticItem[] = COSMETIC_CATALOG,
): string[] {
  return catalog.filter((item) => cosmeticUnlocked(item, ctx)).map((item) => item.id);
}

/* Achievements */

export type AchievementCategory = "progression" | "streak" | "crew" | "discovery" | "mining";
export type AchievementMetric =
  | "activeDays"
  | "streak"
  | "crewTotalLevel"
  | "crewTier"
  | "discoveries"
  | "blocks"
  | "mineSwitches"
  | "fullyMined";

export interface AchievementDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly category: AchievementCategory;
  readonly metric: AchievementMetric;
  readonly threshold: number;
  readonly ore: number;
  readonly badge: string | null;
  readonly title: string | null;
}

/** ORE amounts for achievements the central config does not price (kept deliberately small). */
const SOCIAL_ACHIEVEMENT_ORE: Readonly<Record<string, number>> = Object.freeze({
  WEEK_STREAK: 150,
  FIRST_UPGRADE: 60,
});

/** Hard ceiling on the ORE a wallet can ever receive from achievements. */
export const ACHIEVEMENT_ORE_TOTAL_CAP = 2_000;

export function achievementOre(achievementId: string): number {
  return oreFromAchievement(achievementId) || SOCIAL_ACHIEVEMENT_ORE[achievementId] || 0;
}

/** Clamps an achievement ORE grant to what is left of ACHIEVEMENT_ORE_TOTAL_CAP. */
export function cappedAchievementOre(
  awardedSoFar: number,
  requested: number,
  cap: number = ACHIEVEMENT_ORE_TOTAL_CAP,
): number {
  const remaining = Math.max(0, cap - Math.max(0, Math.floor(awardedSoFar)));
  return Math.min(Math.max(0, Math.floor(requested)), remaining);
}

const STARTER_TOTAL_LEVEL = crewTotalLevel(DIGGO_CONFIG.crew.starterLevels);

export const ACHIEVEMENT_CATALOG: readonly AchievementDefinition[] = Object.freeze([
  {
    id: "FIRST_ACTIVATION",
    name: "First Shift",
    description: "Activate your Mining Crew for the first time.",
    category: "progression",
    metric: "activeDays",
    threshold: 1,
    ore: achievementOre("FIRST_ACTIVATION"),
    badge: "badge_first_steps",
    title: null,
  },
  {
    id: "FIRST_UPGRADE",
    name: "Tooled Up",
    description: "Upgrade any Mining Crew component.",
    category: "crew",
    metric: "crewTotalLevel",
    threshold: STARTER_TOTAL_LEVEL + 1,
    ore: achievementOre("FIRST_UPGRADE"),
    badge: null,
    title: null,
  },
  {
    id: "WEEK_STREAK",
    name: "Week One",
    description: "Reach a seven day activation streak.",
    category: "streak",
    metric: "streak",
    threshold: 7,
    ore: achievementOre("WEEK_STREAK"),
    badge: "badge_week_one",
    title: null,
  },
  {
    id: "CREW_TIER_3",
    name: "Industrial Crew",
    description: "Reach Mining Crew Tier 3.",
    category: "crew",
    metric: "crewTier",
    threshold: 3,
    ore: achievementOre("CREW_TIER_3"),
    badge: "badge_industrial",
    title: null,
  },
  {
    id: "FIRST_DISCOVERY",
    name: "First Find",
    description: "Find your first memecoin discovery.",
    category: "discovery",
    metric: "discoveries",
    threshold: 1,
    ore: achievementOre("FIRST_DISCOVERY"),
    badge: "badge_first_find",
    title: null,
  },
  {
    id: "FIRST_BLOCK",
    name: "First Block",
    description: "Earn your first mined block reward.",
    category: "mining",
    metric: "blocks",
    threshold: 1,
    ore: achievementOre("FIRST_BLOCK"),
    badge: null,
    title: null,
  },
  {
    id: "TEN_BLOCKS",
    name: "Block Hauler",
    description: "Earn ten mined block rewards.",
    category: "mining",
    metric: "blocks",
    threshold: 10,
    ore: achievementOre("TEN_BLOCKS"),
    badge: null,
    title: null,
  },
  {
    id: "FIRST_MINE_SWITCH",
    name: "Mine Hopper",
    description: "Switch to a different mine.",
    category: "progression",
    metric: "mineSwitches",
    threshold: 1,
    ore: achievementOre("FIRST_MINE_SWITCH"),
    badge: null,
    title: null,
  },
  {
    id: "FULLY_MINED_WITNESS",
    name: "End of the Vein",
    description: "Be mining a token when it becomes fully mined.",
    category: "mining",
    metric: "fullyMined",
    threshold: 1,
    ore: achievementOre("FULLY_MINED_WITNESS"),
    badge: null,
    title: null,
  },
]);

export interface AchievementMetrics {
  readonly activeDays: number;
  readonly streak: number;
  readonly crewTotalLevel: number;
  readonly crewTier: number;
  readonly discoveries: number;
  readonly blocks: number;
  readonly mineSwitches: number;
  readonly fullyMined: number;
}

export interface AchievementMetricsInput {
  readonly crewLevels: CrewLevels;
  readonly activeDays?: number;
  readonly streak?: number;
  readonly discoveries?: number;
  readonly blocks?: number;
  readonly mineSwitches?: number;
  readonly fullyMined?: boolean;
}

function nonNegativeCount(value: number | undefined): number {
  const raw = Number.isFinite(value) ? (value as number) : 0;
  return Math.max(0, Math.floor(raw));
}

export function achievementMetrics(input: AchievementMetricsInput): AchievementMetrics {
  return {
    activeDays: nonNegativeCount(input.activeDays),
    streak: nonNegativeCount(input.streak),
    crewTotalLevel: crewTotalLevel(input.crewLevels),
    crewTier: crewTier(input.crewLevels).tier,
    discoveries: nonNegativeCount(input.discoveries),
    blocks: nonNegativeCount(input.blocks),
    mineSwitches: nonNegativeCount(input.mineSwitches),
    fullyMined: input.fullyMined ? 1 : 0,
  };
}

export function achievementById(
  id: string,
  catalog: readonly AchievementDefinition[] = ACHIEVEMENT_CATALOG,
): AchievementDefinition | null {
  return catalog.find((entry) => entry.id === id) ?? null;
}

/** Achievements whose threshold is met and which were not awarded yet, in catalog order. */
export function evaluateAchievements(
  metrics: AchievementMetrics,
  alreadyEarned: readonly string[] = [],
  catalog: readonly AchievementDefinition[] = ACHIEVEMENT_CATALOG,
): AchievementDefinition[] {
  return catalog.filter((entry) => !alreadyEarned.includes(entry.id) && metrics[entry.metric] >= entry.threshold);
}

/* Seasons and seasonal points (spec 68) */

export const DEFAULT_SEASON_ID = "s1-genesis";
export const SEASON_LENGTH_SECONDS = 90 * 86_400;
/** Seasonal points are capped so the seasonal board cannot become a farming target. */
export const SEASONAL_POINTS_TOTAL_CAP = 25_000;

/**
 * Points per gameplay event. Only gameplay progression appears here: activations, crew upgrades,
 * streak milestones, achievements and discoveries. Token amounts, token prices, holdings and trade
 * volume are deliberately absent, because they are exactly what a bot farm would optimise.
 */
export const SEASONAL_POINT_VALUES = Object.freeze({
  activation: 10,
  crew_upgrade: 15,
  streak_milestone: 25,
  achievement: 50,
  discovery: 20,
});

export type SeasonalEventKind = keyof typeof SEASONAL_POINT_VALUES;
export const SEASONAL_EVENT_KINDS: readonly SeasonalEventKind[] = Object.freeze(
  Object.keys(SEASONAL_POINT_VALUES) as SeasonalEventKind[],
);

export interface SeasonDefinition {
  readonly id: string;
  readonly name: string;
  readonly startsAt: number;
  readonly endsAt: number;
}

export type SeasonStatus = "UPCOMING" | "ACTIVE" | "ENDED";

export function seasonStatus(season: SeasonDefinition, now: number): SeasonStatus {
  if (now < season.startsAt) return "UPCOMING";
  if (now >= season.endsAt) return "ENDED";
  return "ACTIVE";
}

/** The season covering now, else the most recently started one, else the first upcoming one. */
export function selectSeason(
  seasons: readonly SeasonDefinition[],
  now: number,
): (SeasonDefinition & { readonly status: SeasonStatus }) | null {
  if (seasons.length === 0) return null;
  const sorted = seasons.slice().sort((a, b) => a.startsAt - b.startsAt);
  const active = sorted.find((season) => seasonStatus(season, now) === "ACTIVE");
  if (active) return { ...active, status: "ACTIVE" };
  const started = sorted.filter((season) => season.startsAt <= now);
  const chosen = started.length > 0 ? started[started.length - 1] : sorted[0];
  return { ...chosen, status: seasonStatus(chosen, now) };
}

export function streakMilestonesReached(
  streak: number,
  config: DiggoConfig = DIGGO_CONFIG,
): readonly StreakMilestoneConfig[] {
  if (!Number.isFinite(streak) || streak <= 0) return [];
  return config.streak.milestones.filter((milestone) => milestone.day <= streak);
}

export interface SeasonalProgressInput {
  readonly activeDays: number;
  readonly crewUpgrades: number;
  readonly streak: number;
  readonly achievementCount: number;
  readonly discoveryCount: number;
}

/**
 * Seasonal points derived from a player's gameplay progression snapshot. Pure, monotone in every
 * input and capped, so it is safe to recompute on every sweep and store as a high-water mark.
 */
export function seasonalProgressPoints(
  input: SeasonalProgressInput,
  config: DiggoConfig = DIGGO_CONFIG,
): number {
  const points =
    nonNegativeCount(input.activeDays) * SEASONAL_POINT_VALUES.activation +
    nonNegativeCount(input.crewUpgrades) * SEASONAL_POINT_VALUES.crew_upgrade +
    streakMilestonesReached(nonNegativeCount(input.streak), config).length * SEASONAL_POINT_VALUES.streak_milestone +
    nonNegativeCount(input.achievementCount) * SEASONAL_POINT_VALUES.achievement +
    nonNegativeCount(input.discoveryCount) * SEASONAL_POINT_VALUES.discovery;
  return Math.min(SEASONAL_POINTS_TOTAL_CAP, points);
}

/* Leaderboards (spec 68) */

export type LeaderboardCategory = "crew" | "streak" | "achievements" | "seasonal_points";
export const LEADERBOARD_CATEGORIES: readonly LeaderboardCategory[] = Object.freeze([
  "crew",
  "streak",
  "achievements",
  "seasonal_points",
]);

export interface LeaderboardCandidate {
  readonly wallet: string;
  readonly rewardState: RewardState;
  /** Mining Power. Progression only; no cosmetic or purchase can change it (spec 34). */
  readonly power: number;
  readonly crewTier: number;
  readonly crewTotalLevel: number;
  readonly streak: number;
  readonly longestStreak: number;
  readonly activeDays: number;
  readonly achievementCount: number;
  readonly seasonalPoints: number;
  readonly oreBalance: number;
  readonly activeMint: string | null;
  /**
   * The player's public username, or null/absent when they never set one. Display identity only:
   * it is never an input to ranking, eligibility or a prize (worker/leaderboard.ts joins it).
   */
  readonly username?: string | null;
}

export interface RankedLeaderboardEntry extends LeaderboardCandidate {
  readonly rank: number;
}

/**
 * Only accounts in the NORMAL reward state are ranked: UNDER_REVIEW, HELD and BLOCKED accounts
 * must never be advertised on a public board (spec 53, 63, 68).
 */
export function leaderboardEligible(state: RewardState): boolean {
  return state === "NORMAL";
}

/**
 * Prizes are capped and non-financial. Real-value prizes stay off until additional anti-Sybil
 * protection exists (spec 68); this object is the single place that records that decision.
 */
export const LEADERBOARD_POLICY = Object.freeze({
  realValuePrizes: false,
  allowedRewards: Object.freeze(["cosmetic", "badge", "title", "capped_ore", "seasonal_points"] as const),
  rewardsTokenAmounts: false,
  requiresAdditionalAntiSybilProtectionForRealValuePrizes: true,
});

type Comparator = (a: LeaderboardCandidate, b: LeaderboardCandidate) => number;

const byWallet: Comparator = (a, b) => a.wallet.localeCompare(b.wallet);
const byActiveDays: Comparator = (a, b) => b.activeDays - a.activeDays;

const COMPARATORS: Readonly<Record<LeaderboardCategory, Comparator>> = Object.freeze({
  crew: (a, b) =>
    b.power - a.power || b.crewTier - a.crewTier || b.crewTotalLevel - a.crewTotalLevel || byActiveDays(a, b) || byWallet(a, b),
  streak: (a, b) => b.streak - a.streak || b.longestStreak - a.longestStreak || byActiveDays(a, b) || byWallet(a, b),
  achievements: (a, b) =>
    b.achievementCount - a.achievementCount || b.crewTier - a.crewTier || byActiveDays(a, b) || byWallet(a, b),
  seasonal_points: (a, b) =>
    b.seasonalPoints - a.seasonalPoints || b.achievementCount - a.achievementCount || byActiveDays(a, b) || byWallet(a, b),
});

export function rankLeaderboard(
  candidates: readonly LeaderboardCandidate[],
  category: LeaderboardCategory,
  limit = 20,
): RankedLeaderboardEntry[] {
  const bounded = Math.min(100, Math.max(1, Math.floor(limit)));
  return candidates
    .filter((candidate) => leaderboardEligible(candidate.rewardState))
    .slice()
    .sort(COMPARATORS[category])
    .slice(0, bounded)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

/* Notifications (spec 75) */

export type NotificationKind =
  | "MINE_EXPIRES_3H"
  | "MINE_EXPIRED"
  | "STREAK_AT_RISK"
  | "RARE_DISCOVERY_FOUND"
  | "STREAK_7_DAY"
  | "REWARD_REDUCTION_APPROACHING"
  | "TOKEN_ALMOST_FULLY_MINED";

export const NOTIFICATION_THRESHOLDS = Object.freeze({
  /** "Mine expires in 3 hours". Inclusive: remaining === 10800 notifies. */
  mineExpiringSeconds: 3 * 3_600,
  /** An expiry older than this is history, not news. */
  expiredFreshnessSeconds: 7 * 86_400,
  /** How close the streak deadline has to be before warning. Inclusive. */
  streakAtRiskSeconds: 12 * 3_600,
  /** A one day streak is not worth waking anyone up for. */
  minStreakForRisk: 2,
  sevenDayStreak: 7,
  rareDiscoveryWindowSeconds: 86_400,
  maxRareDiscoveryNotifications: 3,
  /** Warn this far (in basis points of reserve) before a reward reduction step. Inclusive. */
  rewardReductionLeadBps: 500,
  /** Reserve remaining (in bps of the total) at which each reward reduction step lands. */
  rewardReductionBoundariesBps: Object.freeze([7_500, 5_000, 2_500, 0]),
  /** "Token almost fully mined": at or below this share of the reserve remaining. */
  tokenAlmostFullyMinedBps: 500,
});

export const RARE_RARITIES: readonly DiscoveryRarity[] = Object.freeze(["rare", "epic", "legendary", "mythic"]);

export function isRareRarity(rarity: string): boolean {
  return (RARE_RARITIES as readonly string[]).includes(rarity);
}

export interface NotificationPlayerState {
  readonly wallet: string;
  readonly streak: number;
  readonly longestStreak: number;
  readonly lastActivationAt: number | null;
  readonly activationExpiresAt: number | null;
}

export interface NotificationMineState {
  readonly mint: string;
  readonly symbol: string;
  readonly status: TokenStatus;
  readonly reserveRemaining: number;
  readonly reserveTotal: number;
}

export interface NotificationDiscoveryState {
  readonly id: string;
  readonly rarity: string;
  readonly createdAt: number;
}

export interface NotificationInput {
  readonly now: number;
  readonly player: NotificationPlayerState;
  readonly mine?: NotificationMineState | null;
  readonly discoveries?: readonly NotificationDiscoveryState[];
}

export type NotificationPayload = Readonly<Record<string, string | number | boolean>>;

export interface GeneratedNotification {
  readonly kind: NotificationKind;
  readonly dedupeKey: string;
  readonly payload: NotificationPayload;
  readonly createdAt: number;
}

/** Share of a reserve still unmined, in basis points, clamped to [0, 10000]. */
export function remainingReserveBps(reserveRemaining: number, reserveTotal: number): number {
  if (!Number.isFinite(reserveTotal) || reserveTotal <= 0) return 0;
  const ratio = Number.isFinite(reserveRemaining) ? reserveRemaining / reserveTotal : 0;
  return Math.min(10_000, Math.max(0, Math.round(ratio * 10_000)));
}

/**
 * The reward reduction step a mine is heading towards: the highest boundary at or below the
 * reserve still remaining (spec 21). Returns null only when no boundary is below the input.
 */
export function nextRewardReductionBoundaryBps(remainingBps: number): number | null {
  for (const step of NOTIFICATION_THRESHOLDS.rewardReductionBoundariesBps) {
    if (step <= remainingBps) return step;
  }
  return null;
}

/**
 * Every notification due for one player at one instant. Pure: the caller persists the results and
 * relies on the dedupeKey unique index, so re-running a sweep inserts nothing new.
 */
export function computeNotifications(
  input: NotificationInput,
  config: DiggoConfig = DIGGO_CONFIG,
): GeneratedNotification[] {
  const { now, player, mine = null, discoveries = [] } = input;
  const generated: GeneratedNotification[] = [];
  const emit = (kind: NotificationKind, dedupeKey: string, payload: NotificationPayload) => {
    generated.push({ kind, dedupeKey, payload, createdAt: now });
  };

  if (player.activationExpiresAt !== null && Number.isFinite(player.activationExpiresAt)) {
    const remaining = player.activationExpiresAt - now;
    if (remaining > 0 && remaining <= NOTIFICATION_THRESHOLDS.mineExpiringSeconds) {
      emit("MINE_EXPIRES_3H", "MINE_EXPIRES_3H:" + player.activationExpiresAt, {
        expiresAt: player.activationExpiresAt,
        expiresInSeconds: remaining,
      });
    } else if (remaining <= 0 && now - player.activationExpiresAt <= NOTIFICATION_THRESHOLDS.expiredFreshnessSeconds) {
      emit("MINE_EXPIRED", "MINE_EXPIRED:" + player.activationExpiresAt, {
        expiredAt: player.activationExpiresAt,
        expiredSecondsAgo: -remaining,
      });
    }
  }

  const deadline = streakDeadline(player.lastActivationAt, config);
  if (player.streak >= NOTIFICATION_THRESHOLDS.minStreakForRisk && Number.isFinite(deadline)) {
    const remaining = deadline - now;
    if (remaining > 0 && remaining <= NOTIFICATION_THRESHOLDS.streakAtRiskSeconds) {
      emit("STREAK_AT_RISK", "STREAK_AT_RISK:" + deadline, {
        streak: player.streak,
        deadline,
        remainingSeconds: remaining,
      });
    }
  }

  if (player.streak === NOTIFICATION_THRESHOLDS.sevenDayStreak && player.lastActivationAt !== null) {
    emit("STREAK_7_DAY", "STREAK_7_DAY:" + player.lastActivationAt, { streak: player.streak });
  }

  const rare = discoveries
    .filter(
      (discovery) =>
        isRareRarity(discovery.rarity) &&
        now >= discovery.createdAt &&
        now - discovery.createdAt <= NOTIFICATION_THRESHOLDS.rareDiscoveryWindowSeconds,
    )
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    .slice(0, NOTIFICATION_THRESHOLDS.maxRareDiscoveryNotifications);
  for (const discovery of rare) {
    emit("RARE_DISCOVERY_FOUND", "RARE_DISCOVERY_FOUND:" + discovery.id, {
      discoveryId: discovery.id,
      rarity: discovery.rarity,
    });
  }

  if (mine && mine.reserveTotal > 0) {
    const remainingBps = remainingReserveBps(mine.reserveRemaining, mine.reserveTotal);
    if (remainingBps <= NOTIFICATION_THRESHOLDS.tokenAlmostFullyMinedBps) {
      emit("TOKEN_ALMOST_FULLY_MINED", "TOKEN_ALMOST_FULLY_MINED:" + mine.mint, {
        mint: mine.mint,
        symbol: mine.symbol,
        remainingBps,
      });
    } else {
      const boundary = nextRewardReductionBoundaryBps(remainingBps);
      if (boundary !== null && remainingBps - boundary <= NOTIFICATION_THRESHOLDS.rewardReductionLeadBps) {
        emit("REWARD_REDUCTION_APPROACHING", "REWARD_REDUCTION_APPROACHING:" + mine.mint + ":" + boundary, {
          mint: mine.mint,
          symbol: mine.symbol,
          remainingBps,
          nextReductionBps: boundary,
        });
      }
    }
  }

  return generated;
}

/* Referrals (spec 69): not implemented; only the policy they must respect is recorded here. */

/**
 * Referrals are out of scope for now. When they are added they must never pay a percentage of
 * what an invited account earns: no share of earnings, deposits, trading losses or mining
 * rewards. Cosmetics, badges, small capped ORE and capped progression rewards only, with
 * anti-Sybil protection against self-referrals.
 */
export const REFERRAL_POLICY = Object.freeze({
  implemented: false,
  percentOfDownstreamEarningsBps: 0,
  forbiddenPayoutBases: Object.freeze(["earnings", "deposits", "trading_losses", "mining_rewards"] as const),
  allowedRewards: Object.freeze(["cosmetic", "badge", "small_capped_ore", "capped_progression"] as const),
  requiresAntiSybilSelfReferralProtection: true,
});

assertNoCosmeticEffects(COSMETIC_CATALOG);
