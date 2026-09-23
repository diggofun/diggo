import { IconGlyph } from "./Glyph";
import type { IconProps } from "./types";

/** Coin with three slanted bars — SOL balance. */
export function IconBalance(props: IconProps) {
  return <IconGlyph name="balance" {...props} />;
}
