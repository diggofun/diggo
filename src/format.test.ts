import { describe, expect, it } from "vitest";
import { money, usdApprox } from "./format";

describe("money", () => {
  it("shows zero when a price is missing or invalid", () => {
    expect(money(undefined)).toBe("$0.00");
    expect(money(null)).toBe("$0.00");
    expect(money(Number.NaN)).toBe("$0.00");
    expect(money(-1)).toBe("$0.00");
  });
});

describe("usdApprox", () => {
  it("shows nothing rather than a made-up figure when the price is unknown", () => {
    expect(usdApprox(null)).toBeNull();
    expect(usdApprox(undefined)).toBeNull();
    expect(usdApprox(Number.NaN)).toBeNull();
    expect(usdApprox(Number.POSITIVE_INFINITY)).toBeNull();
    expect(usdApprox(-1)).toBeNull();
    // A zero balance is worth no chip space, and "$0.00" would read as a real valuation.
    expect(usdApprox(0)).toBeNull();
  });

  it("collapses a sub-cent amount to <$0.01", () => {
    expect(usdApprox(0.009)).toBe("<$0.01");
    expect(usdApprox(0.000001)).toBe("<$0.01");
  });

  it("shows two decimals with thousands separators at or above a cent", () => {
    expect(usdApprox(0.01)).toBe("$0.01");
    expect(usdApprox(1.5)).toBe("$1.50");
    expect(usdApprox(185.1)).toBe("$185.10");
    expect(usdApprox(1234.567)).toBe("$1,234.57");
    expect(usdApprox(1_000_000)).toBe("$1,000,000.00");
  });

  it("values a SOL balance at the oracle price, as the header chip does", () => {
    // 1.234 SOL at Jupiter's quoted price reads "≈ $149.39"; sub-cent dust reads "≈ <$0.01".
    expect(usdApprox(1.234 * 121.057878250619)).toBe("$149.39");
    expect(usdApprox(0.0000001 * 121.057878250619)).toBe("<$0.01");
  });
});
