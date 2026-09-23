import { IconGlyph } from "./Glyph";
import type { IconProps } from "./types";

/** Plus in a rounded square — create a new mine. */
export function IconCreate(props: IconProps) {
  return <IconGlyph name="create" {...props} />;
}
