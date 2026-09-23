import { IconGlyph } from "./Glyph";
import type { IconProps } from "./types";

/** Door with an outbound arrow — disconnect. */
export function IconLogout(props: IconProps) {
  return <IconGlyph name="logout" {...props} />;
}
