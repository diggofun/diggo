import { IconGlyph } from "./Glyph";
import type { IconProps } from "./types";

/** Three bars — open the navigation drawer. */
export function IconMenu(props: IconProps) {
  return <IconGlyph name="menu" {...props} />;
}
