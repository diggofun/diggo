import { IconGlyph } from "./Glyph";
import type { IconProps } from "./types";

/** Single bar — decrease and remove. */
export function IconMinus(props: IconProps) {
  return <IconGlyph name="minus" {...props} />;
}
