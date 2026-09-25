import { afterEach, describe, expect, it, vi } from "vitest";
import { createMeteoraConnection } from "./client";

afterEach(() => vi.unstubAllGlobals());

describe("Meteora browser RPC connection", () => {
  it.each([
    "https://diggo.fun/diggo",
    "https://diggo.fun/mines?mint=12cens35GKeZH8is6R1gdbJ1faktyLrXgHvHyBB6veb7",
    "http://localhost:5173/diggo",
  ])("uses the current origin's RPC proxy from %s", (pageUrl) => {
    vi.stubGlobal("location", new URL(pageUrl));

    expect(createMeteoraConnection().rpcEndpoint).toBe(`${new URL(pageUrl).origin}/api/rpc`);
  });
});
