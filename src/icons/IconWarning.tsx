import { IconGlyph } from "./Glyph";
import type { IconProps } from "./types";

/** Triangle with an exclamation — warnings and risk notices. */
export function IconWarning(props: IconProps) {
  return <IconGlyph name="warning" {...props} />;
}
