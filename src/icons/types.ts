import type { CSSProperties, HTMLAttributes } from "react";

/** The two brand tints an icon glyph may be painted in. */
export const ACCENT_FILL = {
  lime: "#d8ff00",
  orange: "#ff7a1a",
} as const;

export type AccentName = keyof typeof ACCENT_FILL;

/** Inline style carrying the custom property the glyph paints with. */
export type IconStyle = CSSProperties & {
  "--icon-color"?: string;
};

/**
 * Props shared by every icon.
 *
 * The glyphs are drawn SVGs inside a span, so:
 *
 * - `size` sizes the icon box (a number is px); without it the 1em box from icons.css applies.
 * - `className` is appended to the `icon` class, and any other span attribute (onClick, aria-*,
 *   data-*) is forwarded untouched.
 * - `title` gives the glyph an accessible name and a tooltip. Without it the icon is decorative
 *   and renders aria-hidden, so it never lands in the accessibility tree twice next to a label.
 * - `filled` asks for the filled variant of the icons that have one (the watchlist star).
 * - `accent` paints the glyph in lime or orange instead of currentColor.
 */
export type IconProps = Omit<HTMLAttributes<HTMLSpanElement>, "children" | "style"> & {
  accent?: AccentName;
  filled?: boolean;
  title?: string;
  size?: number | string;
  style?: IconStyle;
};

/** Resolves the accent prop to a tint colour, or undefined when no tint was requested. */
export function accentFill(accent?: AccentName): string | undefined {
  return accent ? ACCENT_FILL[accent] : undefined;
}

