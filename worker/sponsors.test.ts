/**
 * The sponsor endpoints.
 *
 * What these pin is the one thing the frontend cannot check for itself: that every event it is
 * handed comes with an event id the client can re-read the event at. An id is a PDA seed and not a
 * stored field, so it is recovered by matching the address against the ids the owning vault says
 * exist - and an event whose id cannot be recovered must be left out rather than guessed at,
 * because the client re-reads on chain at the id it is given.
 */
import { describe, expect, it } from "vitest";
import { address } from "@solana/kit";
import bs58 from "bs58";
import { deriveSponsorEventPdaSync, deriveSponsorVaultPdaSync } from "../shared/pdas";
import { sponsorEvents, sponsorEventsForOwner } from "./sponsors";
import type { RuntimeEnv } from "./env";

const PROGRAM = address("H3Y8GgTnvwv5U1bajfzj386YSPC48vvwjFroXYyHZFj5");
const OWNER = address(bs58.encode(new Uint8Array(32).fill(21)));
const VAULT = deriveSponsorVaultPdaSync(PROGRAM, OWNER);
const EVENT_TWO = deriveSponsorEventPdaSync(PROGRAM, VAULT, 2);
const ORPHAN = address(bs58.encode(new Uint8Array(32).fill(22)));

interface Recorded {
  sql: string;
  args: unknown[];
}

function stubEnv(rows: Record<string, unknown>[], recorded: Recorded[]): RuntimeEnv {
  const statement = (sql: string) => {
    let bound: unknown[] = [];
    const api = {
      bind(...args: unknown[]) {
        bound = args;
        return api;
      },
      async all() {
        recorded.push({ sql, args: bound });
        return { results: rows };
      },
    };
    return api;
  };
  return {
    DIGGO_PROGRAM_ID: PROGRAM,
    DB: { prepare: statement },
  } as unknown as RuntimeEnv;
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event: EVENT_TWO,
    vault: VAULT,
    kind: 0,
    start_at: 1_700_000_000,
    end_at: 1_700_086_400,
    budget_lamports: "5000000000",
    spent_lamports: "0",
    per_coin_limit_lamports: "9000000",
    per_wallet_limit_lamports: "70000000",
    paused: 0,
    event_count: 3,
    sponsor_owner: OWNER,
    ...overrides,
  };
}

async function body(response: Response): Promise<{ events?: unknown[] }> {
  return (await response.json()) as { events?: unknown[] };
}

describe("GET /api/sponsors/events", () => {
  it("recovers the event id from the vault's own count and mirrors the payload", async () => {
    const recorded: Recorded[] = [];
    const response = await sponsorEvents(
      new Request("https://diggo.fun/api/sponsors/events"),
      stubEnv([row()], recorded),
    );
    const { events } = await body(response);
    expect(events).toHaveLength(1);
    expect(events![0]).toEqual({
      eventId: 2,
      event: EVENT_TWO,
      vault: VAULT,
      kind: 0,
      startAt: 1_700_000_000,
      endAt: 1_700_086_400,
      budgetLamports: "5000000000",
      spentLamports: "0",
      perCoinLimitLamports: "9000000",
      perWalletLimitLamports: "70000000",
      paused: false,
    });
    // The whole list, unscoped: no owner predicate and no bound argument.
    expect(recorded[0]!.sql).not.toContain("sponsor_owner = ?1");
    expect(recorded[0]!.args).toEqual([]);
  });

  it("leaves out an event whose id cannot be recovered rather than guessing one", async () => {
    const recorded: Recorded[] = [];
    const response = await sponsorEvents(
      new Request("https://diggo.fun/api/sponsors/events"),
      stubEnv([row({ event: ORPHAN })], recorded),
    );
    expect((await body(response)).events).toEqual([]);
  });

  it("reports a paused event as paused", async () => {
    const recorded: Recorded[] = [];
    const response = await sponsorEvents(
      new Request("https://diggo.fun/api/sponsors/events"),
      stubEnv([row({ paused: 1 })], recorded),
    );
    expect((await body(response)).events![0]).toMatchObject({ paused: true });
  });
});

describe("GET /api/sponsors/:owner/events", () => {
  it("scopes the list by owner, which is the only thing the owner route changes", async () => {
    const recorded: Recorded[] = [];
    const response = await sponsorEventsForOwner(
      new Request("https://diggo.fun/api/sponsors/" + OWNER + "/events"),
      stubEnv([row()], recorded),
      OWNER,
    );
    expect((await body(response)).events).toHaveLength(1);
    expect(recorded[0]!.sql).toContain("WHERE v.sponsor_owner = ?1");
    expect(recorded[0]!.args).toEqual([OWNER]);
  });

  it("refuses an owner that is not a base58 address instead of querying for it", async () => {
    const recorded: Recorded[] = [];
    const response = await sponsorEventsForOwner(
      new Request("https://diggo.fun/api/sponsors/nope/events"),
      stubEnv([row()], recorded),
      "nope",
    );
    expect(response.status).toBe(400);
    expect(recorded).toHaveLength(0);
  });
});
