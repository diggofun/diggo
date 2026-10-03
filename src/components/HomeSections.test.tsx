import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { normalizeTokenSummary } from "../tokenSummary";
import { ExploreBoard, SelectedMine } from "./HomeSections";

const coin = { mint: "mine", name: "Diggo", symbol: "DIGGO", graduated: false };

describe("mining reserve display", () => {
  it.each([
    [200000000, "100%"],
    [199614036.59762284, "100%"],
    [100000000, "50%"],
    [0, "0%"],
  ])("renders measured reserve %s on the coin card", (remaining, expected) => {
    const token = normalizeTokenSummary({ ...coin, reserveRemaining: remaining, reserveTotal: 200000000 })!;
    const html = renderToStaticMarkup(<ExploreBoard tokens={[token]} onLaunch={() => undefined} />);
    expect(html).toContain(expected + " of the reserve left");
  });

  it.each([
    {},
    { reserveTotal: 200000000 },
    { reserveRemaining: 0 },
    { reserveRemaining: 0, reserveTotal: 0 },
  ])("shows missing reserve data as unknown instead of zero: %j", (reserve) => {
    const token = normalizeTokenSummary({ ...coin, ...reserve })!;
    const card = renderToStaticMarkup(<ExploreBoard tokens={[token]} onLaunch={() => undefined} />);
    expect(card).toContain("— reserve left");
    expect(card).not.toContain("0% of the reserve left");
    expect(card).not.toContain('class="progress"');
    const selected = renderToStaticMarkup(<SelectedMine token={token} mineInfo={null} now={0} />);
    expect(selected).toContain("<strong>—</strong>");
    expect(selected).not.toContain("<strong>0.0%</strong>");
  });

  it("uses the curve budget when the mine has a separate launch cap", () => {
    const token = normalizeTokenSummary({
      ...coin, reserveRemaining: 200000000, reserveTotal: 200000000,
      curveMining: { onCurve: true, open: true, cap: 100, remaining: 25, progress: 0.75 },
    })!;
    const html = renderToStaticMarkup(<SelectedMine token={token} mineInfo={null} now={0} />);
    expect(html).toContain("Launch cap left");
    expect(html).toContain("<strong>25.0%</strong>");
  });
});
