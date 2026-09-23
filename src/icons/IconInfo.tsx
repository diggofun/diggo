import { IconGlyph } from "./Glyph";
import type { IconProps } from "./types";

/** Circle with an i — inline explanations. */
export function IconInfo(props: IconProps) {
  return <IconGlyph name="info" {...props} />;
}
