import { describe, expect, it } from "vitest";
import { parseSponsoredMineInput, SPONSORED_DEFAULT_DAYS, wholeToRaw } from "./sponsoredMine";

const MINT = "So11111111111111111111111111111111111111112";
const valid = { mint: MINT, symbol: "$pump", name: "Pump Coin", sponsor: "Pump team", reserve: "1,000,000" };

describe("parseSponsoredMineInput", () => {
  it("normalises a valid registration", () => {
    const parsed = parseSponsoredMineInput(valid);
    expect(parsed).toEqual({ ok: true, value: { mint: MINT, symbol: "PUMP", name: "Pump Coin", sponsor: "Pump team", sponsorUrl: null, sponsorWallet: null, reserveWhole: "1000000", days: SPONSORED_DEFAULT_DAYS } });
  });

  it("accepts a numeric reserve, a duration and an https sponsor link", () => {
    const parsed = parseSponsoredMineInput({ ...valid, reserve: 5000, days: 90, sponsorUrl: "https://x.com/pump" });
    expect(parsed.ok && parsed.value).toMatchObject({ reserveWhole: "5000", days: 90, sponsorUrl: "https://x.com/pump" });
  });

  it.each([
    ["a bad mint", { mint: "not-a-mint" }],
    ["an empty symbol", { symbol: "" }],
    ["a long symbol", { symbol: "ABCDEFGHIJKLMN" }],
    ["an empty name", { name: "  " }],
    ["no sponsor", { sponsor: "" }],
    ["a zero reserve", { reserve: "0" }],
    ["a fractional reserve", { reserve: "1.5" }],
    ["a negative reserve", { reserve: -5 }],
    ["zero days", { days: 0 }],
    ["too many days", { days: 3651 }],
    ["fractional days", { days: 1.5 }],
    ["an http link", { sponsorUrl: "http://example.com" }],
    ["a script link", { sponsorUrl: "javascript:alert(1)" }],
    ["a bad sponsor wallet", { sponsorWallet: "nope" }],
  ])("rejects %s", (_label, override) => {
    expect(parseSponsoredMineInput({ ...valid, ...override }).ok).toBe(false);
  });
});

describe("wholeToRaw", () => {
  it("scales whole tokens by the mint's decimals", () => {
    expect(wholeToRaw("1000", 6)).toBe(1_000_000_000n);
    expect(wholeToRaw("1000", 9)).toBe(1_000_000_000_000n);
    expect(wholeToRaw("7", 0)).toBe(7n);
  });

  it("refuses anything that is not a whole amount", () => {
    expect(() => wholeToRaw("1.5", 6)).toThrow();
    expect(() => wholeToRaw("1", 19)).toThrow();
  });
});
