import { describe, expect, it } from "vitest";
import { money } from "./format";

describe("money", () => {
  it("shows zero when a price is missing or invalid", () => {
    expect(money(undefined)).toBe("$0.00");
    expect(money(null)).toBe("$0.00");
    expect(money(Number.NaN)).toBe("$0.00");
    expect(money(-1)).toBe("$0.00");
  });
});
