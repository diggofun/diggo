import { describe, expect, it } from "vitest";
import {
  OpportunityRegistry,
  createHmacRandomSource,
  deriveKeyedBytes,
  deriveRoll,
  opportunityKey,
  randomMessage,
  type RandomRequest,
} from "./random";

const request: RandomRequest = {
  serverSecret: "unit-test-server-secret",
  eventId: "event-1",
  accountId: "account-1",
  window: 1_700_000_000,
};

const NEXT_WINDOW = 1_700_000_001;

describe("server-authoritative RNG", () => {
  it("derives the same roll for the same opportunity, so results cannot be rerolled", async () => {
    const first = await deriveRoll(request.serverSecret, randomMessage(request));
    const second = await deriveRoll(request.serverSecret, randomMessage(request));
    expect(first).toBe(second);
    const source = createHmacRandomSource();
    expect(await source.roll(request)).toBe(first);
    expect(await source.roll({ ...request })).toBe(first);
  });

  it("returns a uniform roll in [0, 1)", async () => {
    for (let window = 0; window < 64; window += 1) {
      const roll = await deriveRoll(request.serverSecret, randomMessage({ ...request, window }));
      expect(roll).toBeGreaterThanOrEqual(0);
      expect(roll).toBeLessThan(1);
    }
  });

  it("changes the roll with the event, account, window and secret", async () => {
    const base = await deriveRoll(request.serverSecret, randomMessage(request));
    const otherEvent = await deriveRoll(request.serverSecret, randomMessage({ ...request, eventId: "event-2" }));
    const otherAccount = await deriveRoll(request.serverSecret, randomMessage({ ...request, accountId: "account-2" }));
    const otherWindow = await deriveRoll(request.serverSecret, randomMessage({ ...request, window: NEXT_WINDOW }));
    const otherSecret = await deriveRoll("another-secret", randomMessage(request));
    const rolls = [base, otherEvent, otherAccount, otherWindow, otherSecret];
    expect(new Set(rolls).size).toBe(rolls.length);
  });

  it("fails closed when the server secret is missing", async () => {
    await expect(deriveRoll("", randomMessage(request))).rejects.toThrow("server secret");
    await expect(createHmacRandomSource().roll({ ...request, serverSecret: "" })).rejects.toThrow();
  });

  it("derives deterministic keyed bytes of any length", async () => {
    const eight = await deriveKeyedBytes(request.serverSecret, randomMessage(request), 8);
    const thirtyTwo = await deriveKeyedBytes(request.serverSecret, randomMessage(request), 32);
    expect(eight).toHaveLength(8);
    expect(thirtyTwo).toHaveLength(32);
    expect(Array.from(eight)).toEqual(Array.from(thirtyTwo.slice(0, 8)));
    const again = await deriveKeyedBytes(request.serverSecret, randomMessage(request), 8);
    expect(Array.from(again)).toEqual(Array.from(eight));
    const source = createHmacRandomSource();
    expect(source.kind).toBe("hmac-sha256");
    expect(Array.from(await source.deriveBytes(request, 8))).toEqual(Array.from(eight));
  });

  it("builds an unambiguous, stable opportunity key", () => {
    expect(randomMessage(request)).toBe("diggo.discovery.v1|event-1|account-1|1700000000");
    expect(opportunityKey(request)).toBe("event-1:account-1:1700000000");
  });
});

describe("opportunity registry", () => {
  it("consumes each opportunity exactly once", () => {
    const registry = new OpportunityRegistry();
    expect(registry.consume(request)).toBe(true);
    expect(registry.consume(request)).toBe(false);
    expect(registry.consume({ ...request })).toBe(false);
    expect(registry.has(request)).toBe(true);
    expect(registry.size).toBe(1);
  });

  it("treats a different window as a new opportunity", () => {
    const registry = new OpportunityRegistry();
    expect(registry.consume(request)).toBe(true);
    expect(registry.consume({ ...request, window: NEXT_WINDOW })).toBe(true);
    expect(registry.consume({ ...request, accountId: "account-2" })).toBe(true);
    expect(registry.size).toBe(3);
  });

  it("proves a replayed request cannot produce a better result", async () => {
    const registry = new OpportunityRegistry();
    const first = registry.consume(request);
    const roll = await createHmacRandomSource().roll(request);
    const replay = registry.consume(request);
    expect(first).toBe(true);
    expect(replay).toBe(false);
    expect(await createHmacRandomSource().roll(request)).toBe(roll);
  });
});
