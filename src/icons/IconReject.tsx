import { IconGlyph } from "./Glyph";
import type { IconProps } from "./types";

/** Circle with an X — rejecting an appeal rather than dismissing the panel. */
export function IconReject(props: IconProps) {
  return <IconGlyph name="reject" {...props} />;
}

