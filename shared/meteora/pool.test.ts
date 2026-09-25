import { describe, expect, it } from "vitest";
import { graduationProgress, poolMetrics } from "./pool";

describe("Meteora pool math", () => {
  it("clamps graduation progress at zero and one", () => {
    expect(graduationProgress(0n, 2_000_000_000n)).toBe(0);
    expect(graduationProgress(1_000_000_000n, 2_000_000_000n)).toBe(0.5);
    expect(graduationProgress(3_000_000_000n, 2_000_000_000n)).toBe(1);
    expect(graduationProgress(1n, 2_000_000_000n, true)).toBe(1);
  });

  it("derives reserve price and curve market cap", () => {
    const metrics = poolMetrics(
      {
        baseReserve: 800_000_000_000_000_000n,
        quoteReserve: 2_000_000_000n,
        isMigrated: false,
      },
      2_000_000_000n,
    );
    expect(metrics.priceSol).toBeCloseTo(0.0000000025, 15);
    expect(metrics.marketCapSol).toBeCloseTo(2, 6);
    expect(metrics.graduated).toBe(true);
  });
});
