import { IconGlyph } from "./Glyph";
import type { IconProps } from "./types";

/** Bars with an up arrow — sort a table. */
export function IconSort(props: IconProps) {
  return <IconGlyph name="sort" {...props} />;
}
