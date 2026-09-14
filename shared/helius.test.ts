import { describe, expect, it } from "vitest";
import { normalizeHeliusEvent } from "./helius";

const SIGNATURE = "5".repeat(88);
const MINT = "9".repeat(32);

describe("Helius normalization", () => {
  it("extracts stable indexing fields", () => {
    const event = normalizeHeliusEvent({
      signature: SIGNATURE,
      type: "SWAP",
      source: "DIGGO",
      slot: 123,
      timestamp: 456,
      tokenTransfers: [{ mint: MINT }],
    });
    expect(event).toMatchObject({
      signature: SIGNATURE,
      mint: MINT,
      eventType: "SWAP",
      source: "DIGGO",
      slot: 123,
      timestamp: 456,
    });
  });

  it("rejects objects without a real transaction signature", () => {
    expect(normalizeHeliusEvent({ type: "SWAP" })).toBeNull();
    expect(normalizeHeliusEvent({ signature: "not-base58" })).toBeNull();
  });

  it("sanitizes provider labels before persistence", () => {
    const event = normalizeHeliusEvent({ signature: SIGNATURE, type: "swap; drop table", source: "custom source" });
    expect(event?.eventType).toBe("SWAP__DROP_TABLE");
    expect(event?.source).toBe("CUSTOM_SOURCE");
  });
});
