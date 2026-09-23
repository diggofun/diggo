import { IconGlyph } from "./Glyph";
import type { IconProps } from "./types";

/** Star — watchlist toggle; pass filled for the saved state. */
export function IconWatchlist(props: IconProps) {
  return <IconGlyph name="watchlist" {...props} />;
}
