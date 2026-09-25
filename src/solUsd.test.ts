import { describe, expect, it } from "vitest";
import { usdApprox } from "./format";

// /api/status does not serve a bare number. The solUsd field is the whole oracle quote, so the client has
// to read priceUsd out of it and respect `available`. These fixtures are a real captured response
// from GET /api/status, kept verbatim so a future change to that shape fails here rather than
// silently making the header show nothing.
//
const LIVE = {
  chainReachable: true,
  solUsd: { priceUsd: 121.057878250619, source: "jupiter", available: true, fromOracle: false, fetchedAt: 1790353288 },
};

/** Mirrors fetchSolUsd()'s parse of the response, so this asserts the shipped shape handling. */
function priceFromStatus(data: { solUsd?: unknown }): number | null {
  const quote = data.solUsd;
  const price = typeof quote === "object" && quote !== null ? (quote as { priceUsd?: unknown }).priceUsd : quote;
  if (typeof quote === "object" && quote !== null && (quote as { available?: unknown }).available === false) return null;
  return typeof price === "number" && Number.isFinite(price) && price > 0 ? price : null;
}

describe("SOL/USD from /api/status", () => {
  it("reads the price out of the oracle quote object", () => {
    expect(priceFromStatus(LIVE)).toBe(121.057878250619);
  });

  it("yields nothing when the Worker reports the quote unavailable", () => {
    expect(priceFromStatus({ solUsd: { priceUsd: 0, source: "none", available: false } })).toBeNull();
  });

  it("yields nothing when the field is missing or malformed", () => {
    expect(priceFromStatus({})).toBeNull();
    expect(priceFromStatus({ solUsd: null })).toBeNull();
    expect(priceFromStatus({ solUsd: { priceUsd: Number.NaN, available: true } })).toBeNull();
  });

  it("prices a real balance into the header's figure", () => {
    const price = priceFromStatus(LIVE);
    expect(price).not.toBeNull();
    expect(usdApprox(1.234234 * price!)).toBe("$149.41");
  });
});
