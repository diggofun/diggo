import { IconGlyph } from "./Glyph";
import type { IconProps } from "./types";

/** Circle with a slash — blocked and disabled states. */
export function IconBan(props: IconProps) {
  return <IconGlyph name="ban" {...props} />;
}
