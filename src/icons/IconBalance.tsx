import { IconGlyph } from "./Glyph";
import type { IconProps } from "./types";

/** The Solana mark (three slanted bars): the SOL balance. */
export function IconBalance(props: IconProps) {
  return <IconGlyph name="balance" {...props} />;
}
