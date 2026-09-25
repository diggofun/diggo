import { describe, expect, it } from "vitest";
import { normalizeTokenSummaries, normalizeTokenSummary } from "./tokenSummary";

// The exact slim row /api/bootstrap served for $DIGGO when every coin view crashed.
const SLIM_DIGGO = {
  mint: "12cens35GKeZH8is6R1gdbJ1faktyLrXgHvHyBB6veb7",
  pool: "4g7i7aWVvwnSn6K6VKyvzG5UFf2nFCXgYJ7uJUymhhMB",
  name: "12cens",
  symbol: "12cens",
  slug: "12cens35GKeZH8is6R1gdbJ1faktyLrXgHvHyBB6veb7",
  imageUrl: null,
  createdAt: 1790360440,
  status: "active",
  venue: "meteora",
  graduated: false,
  quoteReserve: "7940336",
  migrationQuoteThreshold: "85000000000",
};

describe("normalizeTokenSummary", () => {
  it("completes the slim Meteora list row that crashed coin views", () => {
    const token = normalizeTokenSummary(SLIM_DIGGO)!;
    expect(token.curveMining.onCurve).toBe(true);
    expect(token.curveMining.cap).toBe(0);
    expect(token.status).toBe("MINING_ACTIVE");
    expect(token.imageUrl).toBeNull();
    expect(token.priceSol).toBe(0);
    expect(token.change24h).toBeNull();
    expect(token.volume24hUsd).toBe(0);
    expect(token.sellCapacity).toEqual({ sol: 0, tokens: 0 });
    expect((token as unknown as { pool: string }).pool).toBe(SLIM_DIGGO.pool);
  });

  it("keeps real values from a full summary", () => {
    const token = normalizeTokenSummary({
      ...SLIM_DIGGO,
      status: "FULLY_MINED",
      priceSol: 7.29e-8,
      change24h: -3.5,
      curveMining: { open: false, onCurve: false, cap: 10, mined: 10, remaining: 0, progress: 1, blockReward: 1, unpaid: 0 },
      sellCapacity: { sol: 0.5, tokens: null },
    })!;
    expect(token.status).toBe("FULLY_MINED");
    expect(token.priceSol).toBe(7.29e-8);
    expect(token.change24h).toBe(-3.5);
    expect(token.curveMining.onCurve).toBe(false);
    expect(token.sellCapacity.tokens).toBeNull();
  });

  it("marks a graduated slim row as off the curve and drops rows without a mint", () => {
    expect(normalizeTokenSummary({ ...SLIM_DIGGO, graduated: true })!.curveMining.onCurve).toBe(false);
    expect(normalizeTokenSummaries([SLIM_DIGGO, null, { name: "x" }, "bad"])).toHaveLength(1);
    expect(normalizeTokenSummaries(undefined)).toEqual([]);
  });
});
