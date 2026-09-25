import { describe, expect, it, vi } from "vitest";

import { startMeteoraMining } from "./meteoraGameFlow";

describe("Meteora mining start", () => {
  it("activates the shift, then refreshes the authoritative game state", async () => {
    const calls: string[] = [];
    const streak = await startMeteoraMining({
      activate: async () => {
        calls.push("activate");
        return { player: { streak: 3 } };
      },
      refresh: async () => {
        calls.push("refresh");
      },
    });

    expect(calls).toEqual(["activate", "refresh"]);
    expect(streak).toBe(3);
  });

  it("does not refresh when activation fails", async () => {
    const refresh = vi.fn(async () => {});

    await expect(startMeteoraMining({
      activate: async () => { throw new Error("not eligible"); },
      refresh,
    })).rejects.toThrow("not eligible");
    expect(refresh).not.toHaveBeenCalled();
  });
});
