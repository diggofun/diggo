import { IconGlyph } from "./Glyph";
import type { IconProps } from "./types";

/** Bust with a badge dot — the player profile. */
export function IconProfile(props: IconProps) {
  return <IconGlyph name="profile" {...props} />;
}
