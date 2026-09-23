import { IconGlyph } from "./Glyph";
import type { IconProps } from "./types";

/** Bell — notifications; pass filled for the unread state. */
export function IconBell(props: IconProps) {
  return <IconGlyph name="bell" {...props} />;
}
