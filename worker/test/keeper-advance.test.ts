/**
 * Permissionless ledger catch-up (spec 57, 78): worker/keeper.ts keeperAdvanceMine and the
 * advance_mine instruction it sends.
 *
 * The program walks at most MAX_SYNC_SEGMENTS segments per call and answers SyncBehind when a mine
 * is further behind than that, which is what leaves a player's claim_rewards blocked until somebody
 * advances the mine. These tests drive the loop with a chain that enforces exactly that rule, so the
 * bound, the per-tick budget and the resume across ticks are all exercised without an RPC.
 */
import { address } from "@solana/kit";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { buildAdvanceMineInstruction, deriveMarketPdaSync } from "../../shared/program";
import {
  MINE_ADVANCE_CALLS_PER_TICK,
  MINE_ADVANCE_SEGMENTS_PER_CALL,
  isSyncBehindError,
  keeperAdvanceMine,
  mineLedgerCanMove,
  mineSegmentsBehind,
  type KeeperEnv,
  type MineAdvanceCursor,
  type MineAdvancer,
} from "../keeper";

/** Structurally valid addresses; nothing here depends on them being real accounts. */
function key(fill: number): string {
  return bs58.encode(new Uint8Array(32).fill(fill));
}

const PROGRAM_ID = key(9);
const MINT = key(1);
const INTERVAL = 300;
const NOW = 1_800_000_000;

function env(): KeeperEnv {
  return { DIGGO_PROGRAM_ID: PROGRAM_ID };
}

/**
 * A chain that enforces the program's own rule: one advance_mine call commits at most
 * segmentsPerCall segments, and the cursor only ever moves forward by that much.
 */
function mockChain(startAt: number, segmentsPerCall = MINE_ADVANCE_SEGMENTS_PER_CALL) {
  let cursor = startAt;
  const calls: string[] = [];
  const advancer: MineAdvancer = {
    async readCursor(): Promise<MineAdvanceCursor> {
      return { nextBlockAt: cursor, blockInterval: INTERVAL };
    },
    async advance(): Promise<string> {
      const signature = "advance-" + (calls.length + 1);
      calls.push(signature);
      cursor += segmentsPerCall * INTERVAL;
      return signature;
    },
  };
  return { advancer, calls, cursorAt: () => cursor };
}

describe("mineSegmentsBehind", () => {
  it("counts one segment per block interval the ledger owes", () => {
    expect(mineSegmentsBehind({ nextBlockAt: NOW, blockInterval: INTERVAL }, NOW)).toBe(0);
    expect(mineSegmentsBehind({ nextBlockAt: NOW + INTERVAL, blockInterval: INTERVAL }, NOW)).toBe(0);
    expect(mineSegmentsBehind({ nextBlockAt: NOW - INTERVAL, blockInterval: INTERVAL }, NOW)).toBe(1);
    expect(mineSegmentsBehind({ nextBlockAt: NOW - 100 * INTERVAL, blockInterval: INTERVAL }, NOW)).toBe(100);
    // A partial interval is still a segment the program has to walk.
    expect(mineSegmentsBehind({ nextBlockAt: NOW - 1, blockInterval: INTERVAL }, NOW)).toBe(1);
  });

  it("reports nothing for a cursor that cannot describe a schedule", () => {
    expect(mineSegmentsBehind({ nextBlockAt: 0, blockInterval: INTERVAL }, NOW)).toBe(0);
    expect(mineSegmentsBehind({ nextBlockAt: NOW - 10 * INTERVAL, blockInterval: 0 }, NOW)).toBe(0);
    expect(mineSegmentsBehind({ nextBlockAt: NOW - 10 * INTERVAL, blockInterval: -1 }, NOW)).toBe(0);
  });

  it("reports nothing for a ledger the program will not move, however far behind it looks", () => {
    // The zero-power mine: the program answers CaughtUp and leaves the cursor exactly where it is,
    // so a gap measured against `now` is a gap no advance_mine call can ever close.
    expect(
      mineSegmentsBehind({ nextBlockAt: NOW - 80_000 * INTERVAL, blockInterval: INTERVAL, emittable: false }, NOW),
    ).toBe(0);
  });
});

describe("keeperAdvanceMine", () => {
  it("sends nothing for a mine whose ledger is at the present", async () => {
    const chain = mockChain(NOW);

    const report = await keeperAdvanceMine(env(), MINT, { now: NOW, advancer: chain.advancer });

    expect(report).toMatchObject({ mint: MINT, behindSegments: 0, signatures: [], caughtUp: true });
    expect(chain.calls).toEqual([]);
  });

  it("spends at most the per-tick call budget and reports the rest of the gap", async () => {
    // 400 segments behind: each call commits 64, so four calls cannot finish it.
    const behind = 400;
    const chain = mockChain(NOW - behind * INTERVAL);

    const report = await keeperAdvanceMine(env(), MINT, { now: NOW, advancer: chain.advancer });

    expect(report.behindSegments).toBe(behind);
    expect(report.signatures).toHaveLength(MINE_ADVANCE_CALLS_PER_TICK);
    expect(report.signatures).toEqual(chain.calls);
    expect(report.caughtUp).toBe(false);
    expect(chain.cursorAt()).toBe(NOW - (behind - MINE_ADVANCE_CALLS_PER_TICK * MINE_ADVANCE_SEGMENTS_PER_CALL) * INTERVAL);
  });

  it("finishes a catch-up the program never lets one call do, and stops the moment it is caught up", async () => {
    // 100 segments: two calls of at most 64 each. The loop has to stop after the second, not send a
    // third just because the budget would allow it.
    const chain = mockChain(NOW - 100 * INTERVAL);

    const report = await keeperAdvanceMine(env(), MINT, { now: NOW, advancer: chain.advancer });

    expect(report.behindSegments).toBe(100);
    expect(report.signatures).toEqual(["advance-1", "advance-2"]);
    expect(report.caughtUp).toBe(true);
  });

  it("resumes a long catch-up on the next tick until the mine is current", async () => {
    const chain = mockChain(NOW - 400 * INTERVAL);
    const reports = [];

    for (let tick = 0; tick < 3; tick += 1) {
      reports.push(await keeperAdvanceMine(env(), MINT, { now: NOW, advancer: chain.advancer }));
    }

    // 400 segments at 64 per call needs seven calls, so the second tick finishes the job.
    expect(reports.map((report) => report.signatures.length)).toEqual([4, 3, 0]);
    expect(reports[0].caughtUp).toBe(false);
    expect(reports[1].caughtUp).toBe(true);
    expect(reports[2].caughtUp).toBe(true);
    expect(chain.cursorAt()).toBeGreaterThanOrEqual(NOW);
  });

  it("treats a mine with no on-chain account as nothing to do", async () => {
    const advancer: MineAdvancer = {
      async readCursor(): Promise<MineAdvanceCursor | null> {
        return null;
      },
      async advance(): Promise<string> {
        throw new Error("must not advance a mine that does not exist");
      },
    };

    const report = await keeperAdvanceMine(env(), MINT, { now: NOW, advancer });

    expect(report).toMatchObject({ behindSegments: 0, signatures: [], caughtUp: true });
  });

  it("reports a zero-power mine as caught up instead of paying to walk it for ever", async () => {
    // The regression this pins: the program short-circuits a mine with no power to divide a block
    // reward by (sync_is_complete) and answers CaughtUp without moving the cursor. The keeper read
    // the untouched cursor as a backlog of tens of thousands of segments, spent its whole call
    // budget on transactions that changed nothing, reported `caughtUp: false` every tick - and
    // graduation waits on that flag, so the market never formed its pool.
    const behind = 80_000;
    let calls = 0;
    const advancer: MineAdvancer = {
      async readCursor(): Promise<MineAdvanceCursor> {
        return { nextBlockAt: NOW - behind * INTERVAL, blockInterval: INTERVAL, emittable: false };
      },
      async advance(): Promise<string> {
        calls += 1;
        return "advance-" + calls;
      },
    };

    const report = await keeperAdvanceMine(env(), MINT, { now: NOW, advancer });

    expect(report).toMatchObject({ mint: MINT, behindSegments: 0, signatures: [], caughtUp: true });
    expect(calls).toBe(0);
  });
});

describe("buildAdvanceMineInstruction", () => {
  it("names the mine and its market, as the program's AdvanceMine accounts declare", () => {
    const mine = address(key(7));
    const mint = address(key(9));
    const instruction = buildAdvanceMineInstruction({
      programAddress: address(PROGRAM_ID),
      mine,
      mint,
    });

    expect(instruction.programAddress).toBe(PROGRAM_ID);
    // Two writable accounts: the mine, and the market the walk reads to decide which side of
    // the mine pays the blocks it is about to credit.
    expect(instruction.accounts).toHaveLength(2);
    expect(instruction.accounts?.[0]).toMatchObject({ address: mine, role: 1 }); // WRITABLE
    expect(instruction.accounts?.[1]).toMatchObject({
      address: deriveMarketPdaSync(address(PROGRAM_ID), mint),
      role: 1,
    });
    // The advance_mine discriminator, and no arguments: the instruction takes none.
    expect(Array.from(instruction.data as Uint8Array)).toEqual([219, 100, 97, 253, 117, 231, 58, 7]);
  });

  it("refuses to build a call it cannot name a market for", () => {
    // The program requires the market, so a builder that silently dropped it would produce a
    // transaction that always fails. Better to say so here.
    expect(() =>
      buildAdvanceMineInstruction({ programAddress: address(PROGRAM_ID), mine: address(key(7)) }),
    ).toThrow(/market/);
  });
});

describe("mineLedgerCanMove", () => {
  function mine(
    overrides: {
      status?: string;
      remainingReserve?: bigint;
      totalPower?: bigint;
      graduated?: boolean;
      nextBlockAt?: bigint;
      curvePhaseEndsAt?: bigint;
    } = {},
  ) {
    return {
      status: overrides.status ?? "MiningActive",
      remainingReserve: overrides.remainingReserve ?? 1_000_000n,
      totalPower: overrides.totalPower ?? 1_000n,
      graduated: overrides.graduated ?? false,
      nextBlockAt: overrides.nextBlockAt ?? 0n,
      curvePhaseEndsAt: overrides.curvePhaseEndsAt ?? 0n,
    } as unknown as Parameters<typeof mineLedgerCanMove>[0];
  }
  function market(graduated: boolean) {
    return { graduated } as unknown as Parameters<typeof mineLedgerCanMove>[1];
  }

  it("keeps advancing a mine that is still on its curve, however little its budget can pay", () => {
    // Pre-graduation the cursor always has work to do: a spent curve budget pays nothing for the
    // blocks that land while it is spent, but walking past them is exactly what stops that idle
    // stretch from being paid out of the Mining Reserve once the market graduates.
    expect(mineLedgerCanMove(mine(), market(false))).toBe(true);
    expect(mineLedgerCanMove(mine({ remainingReserve: 0n }), market(false))).toBe(true);
  });

  it("stops once the reserve is the source and is empty, or the program is finished", () => {
    expect(mineLedgerCanMove(mine(), market(true))).toBe(true);
    expect(mineLedgerCanMove(mine({ remainingReserve: 0n }), market(true))).toBe(false);
    expect(mineLedgerCanMove(mine({ status: "FullyMined" }), market(true))).toBe(false);
    expect(mineLedgerCanMove(mine({ status: "FullyMined" }), market(false))).toBe(false);
  });

  it("stops on a mine with no power, which the program never moves", () => {
    // Mirrors the program's own opening short-circuit: total_power == 0 means no block reward can
    // be divided, so advance_mine answers CaughtUp and the cursor stays where it is. Reading that
    // as "behind" is an endless loop, and graduation is what it stalls.
    expect(mineLedgerCanMove(mine({ totalPower: 0n }), market(false))).toBe(false);
    expect(mineLedgerCanMove(mine({ totalPower: 0n }), market(true))).toBe(false);
    expect(mineLedgerCanMove(mine({ totalPower: 0n }), null)).toBe(false);
  });

  it("keeps advancing a graduated mine that still owes its graduation cursor's stretch", () => {
    // A graduated mine with an empty reserve is not finished while the walk has not consumed the
    // blocks that landed before its graduation cursor: those are curve-phase for good, so they
    // must be walked past rather than left for the reserve to pay.
    const owing = mine({ graduated: true, remainingReserve: 0n, nextBlockAt: 300n, curvePhaseEndsAt: 900n });
    expect(mineLedgerCanMove(owing, market(true))).toBe(true);
    expect(
      mineLedgerCanMove(
        mine({ graduated: true, remainingReserve: 0n, nextBlockAt: 900n, curvePhaseEndsAt: 900n }),
        market(true),
      ),
    ).toBe(false);
  });

  it("treats an unreadable market as ask again, so a real backlog still fails loudly", () => {
    expect(mineLedgerCanMove(mine(), null)).toBe(true);
    expect(mineLedgerCanMove(mine({ remainingReserve: 0n }), null)).toBe(true);
  });
});

describe("isSyncBehindError", () => {
  it("matches the anchor error name the program logs", () => {
    const error = new Error("Transaction simulation failed");
    (error as { logs?: string[] }).logs = [
      "Program log: AnchorError caused by account: mine. Error Code: SyncBehind. Error Number: 6044. Error Message: This mine is behind.",
    ];
    expect(isSyncBehindError(error)).toBe(true);
  });

  it("matches the numeric code, in the shape a preflight failure arrives in", () => {
    expect(
      isSyncBehindError(
        new Error("custom program error: 0x179c"),
      ),
    ).toBe(true);
    // And through a cause chain, which is where @solana/kit keeps the simulation logs.
    expect(
      isSyncBehindError(new Error("failed to send", { cause: new Error("Error Number: 6044") })),
    ).toBe(true);
  });

  it("does not match any other refusal", () => {
    expect(isSyncBehindError(new Error("Keeper transaction confirmation timed out"))).toBe(false);
    expect(isSyncBehindError(new Error("custom program error: 0x179d"))).toBe(false);
    expect(isSyncBehindError(new Error("Error Number: 6012"))).toBe(false);
    expect(isSyncBehindError(undefined)).toBe(false);
  });
});
