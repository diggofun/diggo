import { IconGlyph } from "./Glyph";
import type { IconProps } from "./types";

/** Rosette with a tick — verified creators and awards. */
export function IconBadge(props: IconProps) {
  return <IconGlyph name="badge" {...props} />;
}
