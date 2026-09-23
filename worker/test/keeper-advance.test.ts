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
import { buildAdvanceMineInstruction } from "../../shared/program";
import {
  MINE_ADVANCE_CALLS_PER_TICK,
  MINE_ADVANCE_SEGMENTS_PER_CALL,
  keeperAdvanceMine,
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
});

describe("buildAdvanceMineInstruction", () => {
  it("names the mine and nothing else, as the program's AdvanceMine accounts declare", () => {
    const mine = address(key(7));
    const instruction = buildAdvanceMineInstruction({ programAddress: address(PROGRAM_ID), mine });

    expect(instruction.programAddress).toBe(PROGRAM_ID);
    expect(instruction.accounts).toHaveLength(1);
    expect(instruction.accounts?.[0]).toMatchObject({ address: mine, role: 1 }); // WRITABLE
    // The advance_mine discriminator, and no arguments: the instruction takes none.
    expect(Array.from(instruction.data as Uint8Array)).toEqual([219, 100, 97, 253, 117, 231, 58, 7]);
  });
});
