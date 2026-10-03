/**
 * Every icon in the set, alphabetically. Each name has one drawn glyph in glyphs.tsx, and
 * `icons.test.tsx` fails if a name has none.
 */
export const ICON_NAMES = [
  "admin",
  "arrowDownRight",
  "arrowUpRight",
  "badge",
  "balance",
  "ban",
  "bell",
  "bellOff",
  "bolt",
  "check",
  "chevronDown",
  "chevronLeft",
  "chevronRight",
  "chevronUp",
  "claim",
  "close",
  "collapseSidebar",
  "copy",
  "cosmetics",
  "create",
  "crew",
  "dashboard",
  "discoveries",
  "explore",
  "externalLink",
  "eye",
  "filter",
  "fire",
  "gauge",
  "hammer",
  "history",
  "home",
  "hourglass",
  "info",
  "landmark",
  "layers",
  "leaderboards",
  "legal",
  "lock",
  "logout",
  "menu",
  "mine",
  "mines",
  "minus",
  "ore",
  "plus",
  "portfolio",
  "profile",
  "radio",
  "refresh",
  "reject",
  "rentReclaim",
  "rocket",
  "search",
  "settings",
  "snowflake",
  "sort",
  "streak",
  "swap",
  "timer",
  "trade",
  "unlock",
  "userGroup",
  "wallet",
  "warning",
  "watchlist",
  "watchlistFilled",
] as const;

export type IconName = (typeof ICON_NAMES)[number];

/**
 * The only icon with a second glyph for its filled state. Every other icon ignores `filled` and
 * draws its single glyph, so a missing variant can never blank an icon out.
 */
export const FILLED_VARIANTS: Partial<Record<IconName, IconName>> = { watchlist: "watchlistFilled" };

/**
 * The glyph to draw for a registry key: the filled variant when one exists and `filled` is set,
 * otherwise the name itself. Every registry key has a drawn glyph (glyphs.tsx, enforced by
 * icons.test.tsx), so this only returns a different key for the filled variants.
 */
export function iconGlyphName(name: IconName, filled?: boolean): IconName {
  const variant = FILLED_VARIANTS[name];
  return filled && variant ? variant : name;
}

/**
 * The readable text a glyph paints when there is no drawing for it: the name's own initials.
 *
 * Every registry key has a glyph, so this only covers a name from outside the registry, and it keeps
 * that icon legible instead of rendering an empty box or a meaningless bullet.
 */
export function iconFallbackText(name: IconName): string {
  const initials = name.replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase();
  return initials.length > 0 ? initials : "?";
}

