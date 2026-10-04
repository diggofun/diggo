import { describe, expect, it } from "vitest";
import { cardSvg, displayNameOf, escapeXml, formatAmount, lookOf, previewText, type ShareStats } from "./card";

const WALLET = "6HHEkX5MxsoQwyCJZHvLnewmnsaw19vGT9Y8jhqH7GuJ";
const base: ShareStats = { wallet: WALLET, username: null, bot: null, oreEarned: 0, longestStreak: 0, coins: 0, top: null };

describe("share card", () => {
  it("formats amounts whole up to a million, compact above", () => {
    expect(formatAmount(0)).toBe("0");
    expect(formatAmount(-5)).toBe("0");
    expect(formatAmount(Number.NaN)).toBe("0");
    expect(formatAmount(0.5)).toBe("0.5");
    expect(formatAmount(111560.78)).toBe("111,560");
    expect(formatAmount(1_250_000)).toBe("1.2M");
    expect(formatAmount(98_765_432_109)).toBe("98.7B");
  });

  it("escapes everything a username could smuggle into the SVG", () => {
    expect(escapeXml(`<script>"&'`)).toBe("&lt;script&gt;&quot;&amp;&apos;");
    const svg = cardSvg({ ...base, username: `</text><image href="x"/>` }, "data:image/png;base64,AA==");
    expect(svg).not.toContain(`<image href="x"/>`);
    expect(svg).toContain("&lt;/text&gt;");
  });

  it("names the player, or shortens the wallet", () => {
    expect(displayNameOf({ wallet: WALLET, username: "jurek" })).toBe("jurek");
    expect(displayNameOf({ wallet: WALLET, username: "  " })).toBe("6HHE…7GuJ");
  });

  it("shows the haul only when there is one", () => {
    const empty = cardSvg(base, "data:,");
    expect(empty).toContain("Start earning");
    expect(empty).toContain("Free to play");
    expect(empty).not.toContain("My bots dug");
    const rich = cardSvg({ ...base, username: "jurek", top: { symbol: "DIGGO", amount: 111560.78 }, longestStreak: 12, oreEarned: 4320, coins: 5 }, "data:,");
    expect(rich).toContain("111,560");
    expect(rich).toContain("$DIGGO");
    expect(rich).toContain("12-day streak");
    expect(rich).toContain("4,320 ORE");
    expect(rich).toContain("5 coins");
  });

  it("draws the saved bot with its one accessory, or the wallet's default", () => {
    expect(lookOf({ wallet: WALLET, bot: { shape: "ghost", color: "#3b82f6", accessory: "hat:crown" } })).toEqual({ shape: "ghost", color: "#3b82f6", hat: "crown", eyewear: "none" });
    expect(lookOf({ wallet: WALLET, bot: { shape: "star", color: "#ff6a00", accessory: "eyewear:shades" } })).toMatchObject({ hat: "none", eyewear: "shades" });
    const fallback = lookOf({ wallet: WALLET, bot: null });
    expect(fallback.hat === "none" || fallback.eyewear === "none").toBe(true);
    expect(cardSvg(base, "data:,")).toContain('viewBox="0 0 100 100"');
  });

  it("writes the preview text from the same numbers", () => {
    expect(previewText({ ...base, username: "jurek", top: { symbol: "MOLE", amount: 2500 } })).toEqual({
      title: "jurek is earning memecoins on Diggo.fun",
      description: "My bots dug 2,500 $MOLE for free. Start mining while you're away and upgrade your mining power.",
    });
    expect(previewText(base).description).toContain("Earn real Solana memecoins");
  });
});
