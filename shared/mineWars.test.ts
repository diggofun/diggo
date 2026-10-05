import { describe, expect, it } from "vitest";
import { rankMineWars } from "./mineWars";

const mine = (symbol: string, crews: number, minersThisWeek = 0, boosted = false) => ({ mint: symbol, symbol, name: symbol, createdBy: null, crews, minersThisWeek, boosted });

describe("rankMineWars", () => {
  it("ranks by crews now, then players this week, then boosted, then ticker", () => {
    const ranked = rankMineWars([mine("C", 2, 9), mine("A", 5), mine("B", 2, 9, true), mine("D", 2, 10), mine("E", 0)]);
    expect(ranked.map((entry) => [entry.rank, entry.symbol])).toEqual([[1, "A"], [2, "D"], [3, "B"], [4, "C"], [5, "E"]]);
  });

  it("does not reorder the input", () => {
    const input = [mine("B", 1), mine("A", 2)];
    rankMineWars(input);
    expect(input.map((entry) => entry.symbol)).toEqual(["B", "A"]);
  });
});
