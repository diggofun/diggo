/**
 * Every icon in the set, alphabetically. One PNG per name lives in public/assets/icons, and
 * `icons.test.tsx` fails if a name has no file of its own.
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
 * The PNG stems shipped under public/assets/icons: one per name above, plus `alerts`.
 *
 * `alerts` is the bell, drawn under that stem before `bell.png` existed. It has no registry key
 * of its own and nothing requests it any more, so it can be deleted from the asset directory (and
 * from this list) whenever the art owner cleans up.
 */
export const ICON_ASSET_NAMES = new Set<string>([
  "admin",
  "alerts",
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
]);

/**
 * The only icon with a second glyph asset for its filled state. Every other icon ignores `filled`
 * and paints its single glyph, so a missing variant can never blank an icon out.
 */
export const FILLED_VARIANTS: Partial<Record<IconName, IconName>> = { watchlist: "watchlistFilled" };

/**
 * The PNG stem to request for a registry key, or undefined when nothing ships for it.
 *
 * Resolution order: the filled variant when the icon has one, then the name's own PNG. There are no
 * stand-ins and no aliases: every registry key ships its own file, and `icons.test.tsx` fails if one
 * does not. So this returns undefined only for a name that is outside the registry.
 */
export function iconAssetStem(name: IconName, filled?: boolean): string | undefined {
  const variant = FILLED_VARIANTS[name];
  const preferred = filled && variant ? variant : name;
  return ICON_ASSET_NAMES.has(preferred) ? preferred : undefined;
}

/** Maps a registry key (plus filled flag) to the asset file stem under public/assets/icons. */
export function iconAsset(name: IconName, filled?: boolean): string {
  return iconAssetStem(name, filled) ?? name;
}

/** Whether the selected PNG is available for the browser mask. */
export function hasIconAsset(name: IconName, filled?: boolean): boolean {
  return iconAssetStem(name, filled) !== undefined;
}

/**
 * The readable text a glyph paints when no PNG stands in for it: the name's own initials.
 *
 * Every registry key ships a PNG, so this only covers a name from outside the registry, and it keeps
 * that glyph legible instead of rendering an empty box or a meaningless bullet.
 */
export function iconFallbackText(name: IconName): string {
  const initials = name.replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase();
  return initials.length > 0 ? initials : "?";
}

