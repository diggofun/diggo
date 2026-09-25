import { describe, expect, it } from "vitest";
import { officialMintFromEnv } from "./officialMint";

// Real mainnet pubkeys, used only as well-formed fixtures for the validator.
const MINT = "5yxCKEmi1rc5ebKmWdHbzj2pEe7caqS8xqvQh5V8duMF";
const VAULT = "H5TTpszeSNneNNxypM3UjaWMjVRNTvmWSCXfgXtzdELT";

describe("official $DIGGO mint", () => {
  it("accepts a real base58 pubkey", () => {
    expect(officialMintFromEnv(MINT)).toBe(MINT);
    expect(officialMintFromEnv(VAULT)).toBe(VAULT);
  });

  it("forgives surrounding whitespace from a copy-pasted address", () => {
    expect(officialMintFromEnv("  " + MINT + "\n")).toBe(MINT);
  });

  it("reports no mint when the var is unset or blank", () => {
    expect(officialMintFromEnv(undefined)).toBeNull();
    expect(officialMintFromEnv(null)).toBeNull();
    expect(officialMintFromEnv("")).toBeNull();
    expect(officialMintFromEnv("   ")).toBeNull();
  });

  it("refuses anything that is not a 32-byte pubkey", () => {
    // Too short, too long, and a 64-byte secret key - all base58, none a mint.
    expect(officialMintFromEnv("5yxCKEmi1rc5ebKmWdHbzj2pEe7caqS8xqvQh5V8d")).toBeNull();
    expect(officialMintFromEnv(MINT + MINT)).toBeNull();
    // The base58 alphabet excludes these four glyphs; a mistyped address carries one of them.
    expect(officialMintFromEnv("0yxCKEmi1rc5ebKmWdHbzj2pEe7caqS8xqvQh5V8duMF")).toBeNull();
    expect(officialMintFromEnv("5yxCKEmi1rc5ebKmWdHbzj2pEe7caqS8xqvQh5V8du0F")).toBeNull();
    // Not a number at all.
    expect(officialMintFromEnv("not-a-mint")).toBeNull();
    expect(officialMintFromEnv("0x" + MINT)).toBeNull();
  });
});
