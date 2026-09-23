import { IconGlyph } from "./Glyph";
import type { IconProps } from "./types";

/** Flame with a counter badge — the daily streak counter. */
export function IconStreak(props: IconProps) {
  return <IconGlyph name="streak" {...props} />;
}
