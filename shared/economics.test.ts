import { describe, expect, it } from "vitest";
import {
  clampRewardToReserve,
  proportionalReward,
  reducedReward,
  routeUpgradePayment,
} from "./economics";

describe("Diggo economics", () => {
  it("uses proportional mining rewards", () => {
    expect(proportionalReward(10_000, 4_000, 2_000_000)).toBe(20);
  });

  it("reduces epoch reward by 25%", () => {
    expect(reducedReward(10_000)).toBe(7_500);
  });

  it("routes upgrades 70/20/10 without creating supply", () => {
    const result = routeUpgradePayment(1_000);
    expect(result).toEqual({ recycle: 700, burn: 200, protocol: 100 });
    expect(result.recycle + result.burn + result.protocol).toBe(1_000);
  });

  it("never distributes above the reserve", () => {
    expect(clampRewardToReserve(10_000, 2_500)).toBe(2_500);
  });
});
