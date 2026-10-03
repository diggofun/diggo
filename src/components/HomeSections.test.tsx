import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { normalizeMineInfo, normalizeTokenSummary } from "../tokenSummary";
import { ExploreBoard, HomeHero, SelectedMine } from "./HomeSections";
import { MineInfoPanel } from "./MineInfoPanel";

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

describe("time-based mining display", () => {
  const emission = { kind: "TIME", durationDays: 3650 };

  function hero(timeBased: boolean): string {
    const token = normalizeTokenSummary({
      ...coin, miningEmission: timeBased ? emission : undefined, rewardPerBlock: 250,
    })!;
    return renderToStaticMarkup(<HomeHero
      featured={token} player={null} connected now={0} activating={false} error=""
      onActivate={() => undefined} onManageCrew={() => undefined} onLaunch={() => undefined}
    />);
  }

  it("shows time-based accrual rather than a block reward in the home hero", () => {
    const html = hero(true);
    expect(html).toContain("Rewards accrue over time");
    expect(html).not.toContain("per block");
    expect(html).not.toContain("Next block");
  });

  it("preserves the reward per block for the native mining model", () => {
    expect(hero(false)).toContain("per block");
  });

  it("shows the allocation period instead of fictitious block and epoch figures in mine info", () => {
    const mine = normalizeMineInfo({
      ...coin, miningEmission: emission, remainingReserve: 200000000, reserveTotal: 200000000,
      emissionSource: "RESERVE", estimatedShare: 0.5,
    })!;
    const html = renderToStaticMarkup(<MineInfoPanel mine={mine} mineName="Diggo" now={0} loading={false} error="" />);
    expect(html).toContain("Time-based");
    expect(html).toContain("3,650 days");
    expect(html).toContain("your share of released tokens");
    expect(html).not.toContain("per block");
    expect(html).not.toContain("next reduction");
    expect(html).not.toContain("Each epoch reduces");
  });

  it("describes the time-based mining model on the selected mine", () => {
    const token = normalizeTokenSummary({ ...coin, miningEmission: emission })!;
    const html = renderToStaticMarkup(<SelectedMine token={token} mineInfo={null} now={0} />);
    expect(html).toContain("Mining model");
    expect(html).toContain("Time-based");
    expect(html).not.toContain("Flat");
    expect(html).not.toContain("per block");
  });
});
