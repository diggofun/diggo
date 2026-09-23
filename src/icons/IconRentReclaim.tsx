import { IconGlyph } from "./Glyph";
import type { IconProps } from "./types";

/** Return arrow over a coin — close an account and take the rent back. */
export function IconRentReclaim(props: IconProps) {
  return <IconGlyph name="rentReclaim" {...props} />;
}
