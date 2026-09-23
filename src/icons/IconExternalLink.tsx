import { IconGlyph } from "./Glyph";
import type { IconProps } from "./types";

/** Box with an arrow leaving it — open in a block explorer. */
export function IconExternalLink(props: IconProps) {
  return <IconGlyph name="externalLink" {...props} />;
}
