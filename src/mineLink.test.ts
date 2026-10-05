import { describe, expect, it } from "vitest";
import { mineFromLocation, mineLink } from "./mineLink";

const MINT = "So11111111111111111111111111111111111111112";

describe("mine links", () => {
  it("builds and reads back the short /m/ link", () => {
    expect(mineLink(MINT)).toBe(`https://diggo.fun/m/${MINT}`);
    expect(mineFromLocation(mineLink(MINT))).toBe(MINT);
    expect(mineFromLocation(`https://diggo.fun/m/${MINT}/?ref=jurek`)).toBe(MINT);
  });

  it("ignores anything that is not a mint", () => {
    expect(mineFromLocation("https://diggo.fun/m/not-a-mint")).toBeNull();
    expect(mineFromLocation("https://diggo.fun/mine")).toBeNull();
    expect(mineFromLocation(`https://diggo.fun/m/${MINT}/extra`)).toBeNull();
    expect(mineFromLocation("nonsense")).toBeNull();
  });
});
