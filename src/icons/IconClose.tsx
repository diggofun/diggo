import { IconGlyph } from "./Glyph";
import type { IconProps } from "./types";

/** Cross — dismiss a modal or panel. */
export function IconClose(props: IconProps) {
  return <IconGlyph name="close" {...props} />;
}
