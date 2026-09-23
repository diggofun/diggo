import { IconGlyph } from "./Glyph";
import type { IconProps } from "./types";

/** Circular arrow — refresh and retry. */
export function IconRefresh(props: IconProps) {
  return <IconGlyph name="refresh" {...props} />;
}
