/**
 * The platform official coin, $DIGGO.
 *
 * Its mint address is not a constant in this repository: it is a Worker var
 * (`DIGGO_OFFICIAL_MINT`, see wrangler.jsonc) that an operator sets once the coin is deployed.
 * Until then the var is the empty string, and every surface that would show the coin shows a
 * "launches soon" empty state instead of an invented price.
 *
 * That is why the raw var is never handed to the client directly. It is validated here - it has to
 * be a real base58-encoded 32-byte pubkey - and an unset, blank or mistyped value collapses to null
 * rather than to something the UI would render as a live market.
 */

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** The official coin's on-chain name and symbol, as written into its mint metadata at launch. */
export const OFFICIAL_COIN_NAME = "Diggo.fun";
export const OFFICIAL_COIN_SYMBOL = "DIGGO";
/** The official coin's logo as shipped with the site: the same bytes its hosted metadata points at. */
export const OFFICIAL_COIN_LOGO = "/brand/official-diggo-fun-logo-v2.png";

/** A Solana pubkey is a 32-byte account address. */
const PUBKEY_BYTES = 32;

/**
 * Decodes a base58 string to its byte length, or -1 when it is not base58 at all.
 *
 * The alphabet excludes 0, O, I and l because those glyphs are easy to confuse; a string carrying
 * one of them is rejected outright rather than silently normalized, since a mistyped mint is far
 * more likely than an exotic-but-valid address. The value is accumulated as a bigint so an address
 * can never be truncated by a float.
 */
function base58ByteLength(value: string): number {
  let decoded = 0n;
  for (const character of value) {
    const digit = BASE58_ALPHABET.indexOf(character);
    if (digit < 0) return -1;
    decoded = decoded * 58n + BigInt(digit);
  }
  // Every leading "1" is a leading zero byte, which the bigint accumulation above drops.
  const leadingZeros = /^1*/.exec(value)?.[0].length ?? 0;
  let byteLength = 0;
  for (let rest = decoded; rest > 0n; rest >>= 8n) byteLength += 1;
  return leadingZeros + byteLength;
}

/** True when the value is a base58-encoded 32-byte Solana pubkey. */
function isPubkey(value: string): boolean {
  if (value.length < 32 || value.length > 44) return false;
  return base58ByteLength(value) === PUBKEY_BYTES;
}

/**
 * The official mint as the API and the UI should see it: a validated pubkey, or null when the coin
 * has not launched yet. Null is the "not launched" signal, and every caller must show an empty
 * state for it rather than a placeholder market.
 */
export type OfficialMint = string | null;

/**
 * Reads the `DIGGO_OFFICIAL_MINT` var and returns the mint only if it is genuinely a pubkey.
 *
 * Unset, blank, whitespace-padded and malformed values all become null. Trimming first means a
 * trailing newline from a copy-pasted address is forgiven, while a value that is still not a pubkey
 * after trimming is refused.
 */
export function officialMintFromEnv(value: string | undefined | null): OfficialMint {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed.length === 0) return null;
  return isPubkey(trimmed) ? trimmed : null;
}
