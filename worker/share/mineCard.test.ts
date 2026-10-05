import { describe, expect, it } from "vitest";
import { cleanSymbol, mineCardSvg, minePreviewText, type MineShareStats } from "./mineCard";

const stats: MineShareStats = { mint: "m", symbol: "bonk", name: "Bonk", createdBy: "Bonk <DAO> & co", paysNow: true, open: true, remaining: 43_210_000, reserve: 50_000_000, crews: 3 };

describe("mine card", () => {
  it("shows the ticker, who created it and what is left, with text escaped", () => {
    const svg = mineCardSvg(stats, "data:image/png;base64,AA==");
    expect(svg).toContain("$BONK");
    expect(svg).toContain("Mine created by Bonk &lt;DAO&gt; &amp; co");
    expect(svg).toContain("43.2M left");
    expect(svg).toContain("Pays out now");
    expect(svg).not.toContain("<DAO>");
  });

  it("names a Diggo launch as such", () => {
    expect(mineCardSvg({ ...stats, createdBy: null, paysNow: false }, "")).toContain("Launched on Diggo");
  });

  it("keeps tickers to what the font can draw", () => {
    expect(cleanSymbol("$wif-hat!")).toBe("WIFHAT");
    expect(cleanSymbol("💎")).toBe("COIN");
  });

  it("writes preview text for the link", () => {
    expect(minePreviewText(stats)).toEqual({
      title: "Mine $BONK on Diggo.fun",
      description: "Send your bots to dig $BONK for free and get paid out in $BONK. Mine created by Bonk <DAO> & co. 43.2M $BONK left to mine.",
    });
  });
});
