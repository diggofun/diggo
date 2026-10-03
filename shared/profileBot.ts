/**
 * The profile bot: the avatar a player picks in settings, stored next to their username.
 *
 * One shape, one colour and at most one accessory (a hat or a piece of eyewear). The lists here are
 * the single source the Worker validates against; src/components/Bot.tsx draws exactly these, and
 * a test keeps the two in step. Like a username it is display identity only and never game state.
 */
export const BOT_SHAPE_NAMES = [
  "circle", "blob", "square", "pill", "triangle", "hexagon", "cloud", "drop",
  "star", "heart", "diamond", "ghost", "egg", "bean", "octagon", "bell",
] as const;
export type BotShape = (typeof BOT_SHAPE_NAMES)[number];

/** LowBot's eight creature colours first, then eight more from its avatar palette and Tailwind. */
export const BOT_COLORS = [
  "#ff6a00", "#3b82f6", "#a855f7", "#10b981", "#f43f5e", "#eab308", "#06b6d4", "#ec4899",
  "#84cc16", "#6366f1", "#14b8a6", "#ef2b3c", "#38bdf8", "#d946ef", "#8d6e4f", "#ffffff",
] as const;
export type BotColor = (typeof BOT_COLORS)[number];

export const BOT_HATS = ["none", "hardhat", "cap", "beanie", "crown", "party", "bow", "tophat"] as const;
export type BotHat = (typeof BOT_HATS)[number];
export const BOT_EYEWEAR = ["none", "glasses", "shades", "goggles"] as const;
export type BotEyewear = (typeof BOT_EYEWEAR)[number];

/** The single accessory slot. Prefixed so a hat and eyewear share one list. */
export type BotAccessory = "none" | `hat:${Exclude<BotHat, "none">}` | `eyewear:${Exclude<BotEyewear, "none">}`;

export const BOT_ACCESSORIES: readonly BotAccessory[] = [
  "none",
  ...BOT_HATS.filter((hat): hat is Exclude<BotHat, "none"> => hat !== "none").map((hat) => `hat:${hat}` as const),
  ...BOT_EYEWEAR.filter((item): item is Exclude<BotEyewear, "none"> => item !== "none").map((item) => `eyewear:${item}` as const),
];

export interface ProfileBot {
  shape: BotShape;
  color: BotColor;
  accessory: BotAccessory;
}

/** A valid profile bot from untrusted input, or null. Colours compare case-insensitively. */
export function parseProfileBot(value: unknown): ProfileBot | null {
  if (typeof value !== "object" || value === null) return null;
  const { shape, color, accessory } = value as Record<string, unknown>;
  if (typeof shape !== "string" || !(BOT_SHAPE_NAMES as readonly string[]).includes(shape)) return null;
  if (typeof color !== "string") return null;
  const normalizedColor = color.toLowerCase();
  if (!(BOT_COLORS as readonly string[]).includes(normalizedColor)) return null;
  const slot = accessory === undefined ? "none" : accessory;
  if (typeof slot !== "string" || !(BOT_ACCESSORIES as readonly string[]).includes(slot)) return null;
  return { shape: shape as BotShape, color: normalizedColor as BotColor, accessory: slot as BotAccessory };
}
