import { describe, expect, it } from "vitest";
import { claimProgress } from "./claimProgress";

const none = { walletAge: false, activeDays: false, activations: false, portfolio: false, portfolioUsd: 0 };

describe("claim progress", () => {
  it("fills each step from the counters the Worker reports", () => {
    const p = claimProgress({ claim: { ...none, portfolioUsd: 4.2 }, activeDays: 3, validActivations: 2 });
    expect(p.steps.map((s) => s.detail)).toEqual(["Unlocks with time", "3 / 5", "2 / 5", "$4.20 / $10"]);
    [0, 0.6, 0.4, 0.42].forEach((value, i) => expect(p.steps[i]!.progress).toBeCloseTo(value));
    expect(p.done).toBe(0);
    expect(p.overall).toBeCloseTo((0 + 0.6 + 0.4 + 0.42) / 4);
  });

  it("trusts the Worker's verdict over the counters", () => {
    const p = claimProgress({ claim: { walletAge: true, activeDays: true, activations: true, portfolio: true, portfolioUsd: 25 }, activeDays: 9, validActivations: 12 });
    expect(p.done).toBe(4);
    expect(p.overall).toBe(1);
    expect(p.steps[1]!.detail).toBe("5 / 5");
    // A counter at the threshold is not "met" until the Worker says so.
    const pending = claimProgress({ claim: none, activeDays: 5, validActivations: 5 });
    expect(pending.steps[1]!.met).toBe(false);
  });

  it("never reads an unreadable wallet as progress", () => {
    const p = claimProgress({ claim: { ...none, portfolioUsd: null }, activeDays: -3, validActivations: Number.NaN });
    expect(p.steps[3]).toMatchObject({ progress: 0, detail: "Could not read your wallet" });
    expect(p.steps[1]!.detail).toBe("0 / 5");
    expect(p.overall).toBe(0);
  });
});
