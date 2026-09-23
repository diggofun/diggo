import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ClaimedCell,
  claimedValueDisplay,
  lamportsToExactSol,
  type ClaimedValueFields,
} from "./AdminScreen";

/**
 * The claimed column, pinned against the false zero.
 *
 * adminAbuse answers with three things: the exact lamport sum, that sum converted to USD at the
 * display rate, and whether the oracle rate behind the conversion existed. lamportsToUsd returns 0
 * when it did not, so a console that prints the conversion unconditionally reports "0.00 USD" for
 * an account that did claim something. These tests hold the two honest readings in place - the USD
 * figure while the rate is real, the exact SOL amount with the missing rate named beside it when it
 * is not - and keep the exact lamports visible at any size.
 */

const SOL = 1_000_000_000;

function account(fields: Partial<ClaimedValueFields>): ClaimedValueFields {
  return { claimedValueUsd: 0, ...fields };
}

describe("lamportsToExactSol", () => {
  it("keeps every lamport, including dust a rounded figure would lose", () => {
    expect(lamportsToExactSol("0")).toBe("0");
    expect(lamportsToExactSol("1")).toBe("0.000000001");
    expect(lamportsToExactSol("2500000000")).toBe("2.5");
    expect(lamportsToExactSol("1234567891")).toBe("1.234567891");
  });

  it("groups a large sum and refuses anything that is not a lamport count", () => {
    expect(lamportsToExactSol("3000000000000")).toBe("3,000");
    expect(lamportsToExactSol("")).toBeNull();
    expect(lamportsToExactSol("1.5")).toBeNull();
    expect(lamportsToExactSol("-1")).toBeNull();
    expect(lamportsToExactSol("not-a-count")).toBeNull();
  });
});

describe("the claimed value cell", () => {
  it("prints the USD figure while the oracle rate is real", () => {
    const shown = claimedValueDisplay(
      account({ claimedValueLamports: String(3 * SOL), claimedValueUsd: 450, usdPriceAvailable: true }),
    );
    expect(shown.value).toBe("450.00 USD");
    expect(shown.note).toBeNull();
    expect(shown.title).toBe("3,000,000,000 lamports converted at the display SOL/USD rate");
  });

  it("keeps a real zero real: an account that claimed nothing reads as 0.00 USD", () => {
    const shown = claimedValueDisplay(account({ claimedValueLamports: "0", claimedValueUsd: 0, usdPriceAvailable: true }));
    expect(shown.value).toBe("0.00 USD");
    expect(shown.note).toBeNull();
  });

  it("shows the exact SOL amount, and names the missing rate, when the oracle did not answer", () => {
    const shown = claimedValueDisplay(
      account({ claimedValueLamports: String(3 * SOL), claimedValueUsd: 0, usdPriceAvailable: false }),
    );
    expect(shown.value).toBe("3 SOL");
    expect(shown.value).not.toContain("USD");
    expect(shown.note).toBe("USD unavailable");
    expect(shown.title).toContain("3,000,000,000 lamports");
    expect(shown.title).toContain("no SOL/USD rate was reported");
  });

  it("treats a payload with no availability flag as a rate it cannot vouch for", () => {
    expect(claimedValueDisplay(account({ claimedValueLamports: String(2 * SOL) })).value).toBe("2 SOL");
    expect(
      claimedValueDisplay(account({ claimedValueLamports: String(SOL), claimedValueUsd: Number.NaN, usdPriceAvailable: true })).value,
    ).toBe("1 SOL");
  });

  it("says USD unavailable when there is no exact sum to fall back on", () => {
    const shown = claimedValueDisplay(account({ claimedValueUsd: 0, usdPriceAvailable: false }));
    expect(shown.value).toBe("USD unavailable");
    expect(shown.note).toBeNull();
    expect(shown.title).toContain("no SOL/USD rate was reported");
  });

  it("renders dust as SOL rather than rounding it into the zero the flag warns about", () => {
    const dust = account({ claimedValueLamports: "1", claimedValueUsd: 0, usdPriceAvailable: false });
    expect(claimedValueDisplay(dust).value).toBe("0.000000001 SOL");
    const markup = renderToStaticMarkup(<ClaimedCell account={dust} />);
    expect(markup).toContain("0.000000001 SOL");
    expect(markup).toContain(`<em class="mono-label">USD unavailable</em>`);
    expect(markup).not.toContain("0.00 USD");
  });

  it("renders a real USD figure without the unavailable note", () => {
    const markup = renderToStaticMarkup(
      <ClaimedCell account={account({ claimedValueLamports: String(3 * SOL), claimedValueUsd: 450, usdPriceAvailable: true })} />,
    );
    expect(markup).toContain("450.00 USD");
    expect(markup).not.toContain("USD unavailable");
  });
});
