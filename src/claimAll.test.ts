import { describe, expect, it } from "vitest";

import { settledClaimAllNotice } from "./claimAll";

describe("claim-all settlement copy", () => {
  it("reports only the settled batch when more coins remain", () => {
    expect(settledClaimAllNotice({
      items: Array.from({ length: 12 }, () => ({})),
      totalItems: 15,
      remainingItems: 3,
      complete: false,
    })).toBe(
      "Collected 12 of 15 coins in one transaction. 3 more remain; run Claim all again for the next batch.",
    );
  });

  it("reports the whole balance only when the backend marks the batch complete", () => {
    expect(settledClaimAllNotice({
      items: Array.from({ length: 4 }, () => ({})),
      totalItems: 4,
      remainingItems: 0,
      complete: true,
    })).toBe("Collected all 4 accrued coins to your wallet in one transaction.");
  });

  it("rejects contradictory continuation data instead of claiming everything", () => {
    expect(() => settledClaimAllNotice({
      items: Array.from({ length: 12 }, () => ({})),
      totalItems: 12,
      remainingItems: 3,
      complete: true,
    })).toThrow(/inconsistent/i);
  });

  it("rejects totals that do not equal the current batch plus its remainder", () => {
    expect(() => settledClaimAllNotice({
      items: Array.from({ length: 12 }, () => ({})),
      totalItems: 20,
      remainingItems: 3,
      complete: false,
    })).toThrow(/inconsistent/i);
  });
});
