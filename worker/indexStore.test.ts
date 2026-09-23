/**
 * The indexer's write path.
 *
 * The claim these tests make is the one the whole workstream rests on: the indexer copies what the
 * program said and computes nothing. A recording D1 stub captures every statement and its bound
 * arguments, so a field that was derived, rounded or defaulted instead of copied shows up as a
 * mismatched bind rather than as a subtle display bug months later.
 */
import { describe, expect, it } from "vitest";
import bs58 from "bs58";
import { address } from "@solana/kit";
import type { RuntimeEnv } from "./env";
import {
  coinSlug,
  ensurePlayerRow,
  writeCoin,
  writePlayerAccount,
  writePosition,
  writeProtocolConfig,
} from "./indexStore";
import type { DecodedCoin, DecodedPlayerAccount, DecodedProtocolConfig } from "./v2/program";

interface Recorded {
  sql: string;
  args: unknown[];
}

/**
 * A D1 stub that records instead of executing. It answers `first` with null and `all` with an
 * empty page, which is what a cold index sees.
 */
function recordingDb(): { env: RuntimeEnv; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const statement = (sql: string) => {
    let bound: unknown[] = [];
    const api = {
      bind(...args: unknown[]) {
        bound = args;
        return api;
      },
      async run() {
        calls.push({ sql, args: bound });
        return { success: true, meta: { changes: 1 } };
      },
      async first() {
        calls.push({ sql, args: bound });
        return null;
      },
      async all() {
        calls.push({ sql, args: bound });
        return { results: [] };
      },
    };
    return api;
  };
  const env = {
    DB: {
      prepare: statement,
      async batch(statements: unknown[]) {
        return statements;
      },
    },
    TOKEN_CACHE: {
      async get() {
        return null;
      },
      async put() {},
      async delete() {
        return true;
      },
    },
  } as unknown as RuntimeEnv;
  return { env, calls };
}

const OWNER = address(bs58.encode(new Uint8Array(32).fill(9)));
const COIN = address(bs58.encode(new Uint8Array(32).fill(11)));
const MINT = address(bs58.encode(new Uint8Array(32).fill(12)));
const PLAYER = address(bs58.encode(new Uint8Array(32).fill(13)));

const playerAccount: DecodedPlayerAccount = {
  createdSlot: 1_234n,
  createdAt: 1_700_000_000n,
  activeUntil: 1_700_086_400n,
  lastActivationAt: 1_699_000_000n,
  streak: 7,
  longestStreak: 9,
  validActivations: 4,
  activeDays: 12,
  lastActiveDay: 19_999,
  streakFreezes: 1,
  crewLevels: [3, 4, 5, 6, 7],
  crew: { miners: 3, drills: 4, carts: 5, foreman: 6, storage: 7 },
  oreBalance: 12_345n,
  oreEarned: 20_000n,
  oreSpent: 7_655n,
  oreAccruedAt: 1_700_000_000n,
  activeMine: COIN,
  dayIndex: 20_000,
  weekIndex: 2_857,
  spentDayLamports: 1_000n,
  spentWeekLamports: 4_000n,
  rollWindow: 19_999,
  rollCount: 3,
  lastRollAt: 1_699_900_000n,
  bondLamports: 70_000_000n,
  bondLockedAt: 1_699_000_000n,
  unbondAvailableAt: 0n,
  bondSource: "sponsor",
  bondSourceByte: 1,
  bondSponsorVault: MINT,
  bump: 253,
  version: 5,
};

describe("writePlayerAccount", () => {
  it("mirrors every program value verbatim, including the bond block", async () => {
    const { env, calls } = recordingDb();
    await writePlayerAccount(env, PLAYER, OWNER, playerAccount, 4_242n);
    const insert = calls[0]!;
    expect(insert.sql).toContain("INSERT INTO player_accounts");
    // The first bound argument is the PDA, the second the wallet it was derived from.
    expect(insert.args[0]).toBe(PLAYER);
    expect(insert.args[1]).toBe(OWNER);
    // Crew levels land in their five own columns, in the program's order.
    expect(insert.args.slice(12, 17)).toEqual([3, 4, 5, 6, 7]);
    // ORE is a bigint on chain and a string in D1, never a float.
    expect(insert.args[17]).toBe("12345");
    expect(insert.args[18]).toBe("20000");
    expect(insert.args[19]).toBe("7655");
    // The bond block is copied, not recomputed: the sponsor vault is recorded as it stands.
    expect(insert.args[29]).toBe("70000000");
    expect(insert.args[32]).toBe(1);
    expect(insert.args[33]).toBe(MINT);
    // The account slot the read observed is recorded, so a stale mirror is visible.
    expect(insert.args[35]).toBe(4242);
    // The profile row's denormalised mirrors follow in a second statement.
    const update = calls[1]!;
    expect(update.sql).toContain("UPDATE players SET indexed_at");
    expect(update.args[4]).toBe("12345");
    expect(update.args[8]).toBe(OWNER);
  });

  it("creates a profile row for a wallet that has no account yet, with no game value", async () => {
    const { env, calls } = recordingDb();
    await ensurePlayerRow(env, OWNER, 1_700_000_000);
    expect(calls[0]!.sql).toContain("INSERT OR IGNORE INTO players");
    expect(calls[0]!.args).toEqual([OWNER, 1_700_000_000]);
    expect(calls[0]!.sql).not.toContain("ore_balance");
  });
});

describe("writePosition", () => {
  it("keys the row on the PDA and keeps the index as a string", async () => {
    const { env, calls } = recordingDb();
    await writePosition(
      env,
      PLAYER,
      COIN,
      OWNER,
      {
        assignedPower: 1_200n,
        lastRewardIndex: 999_999_999_999n,
        pendingReward: 42n,
        tranche: "starter",
        trancheByte: 1,
        createdSlot: 1_234n,
        bump: 250,
        version: 5,
      },
      4_242n,
    );
    const insert = calls[0]!;
    expect(insert.sql).toContain("INSERT INTO mining_positions_v2");
    expect(insert.args.slice(0, 3)).toEqual([PLAYER, COIN, OWNER]);
    expect(insert.args[3]).toBe("1200");
    expect(insert.args[4]).toBe("999999999999");
    expect(insert.args[6]).toBe(1);
  });
});

describe("writeCoin", () => {
  const coin: DecodedCoin = {
    creator: OWNER,
    vault: MINT,
    totalSupply: 1_000_000n,
    reserveRemaining: 500n,
    discoveryRemaining: 40n,
    outstandingClaims: 7n,
    cumulativeDistributed: 60n,
    totalPower: 900n,
    bondedPower: 800n,
    starterPower: 100n,
    bondedIndex: 123n,
    starterIndex: 30n,
    currentBlockReward: 250n,
    blockInterval: 300,
    nextBlockAt: 1_700_000_000n,
    epochIndex: 9,
    epochLength: 604_800,
    epochEndsAt: 1_700_600_000n,
    epochEndsSlot: 1_234_567n,
    reductionBps: 2_500,
    minimumReward: 10n,
    tokenReserve: 400_000n,
    solReserve: 12_000_000n,
    virtualSolReserve: 3_000_000n,
    graduationTarget: 50_000_000n,
    creatorFeeClaimable: 11n,
    platformFeeClaimable: 13n,
    creatorFeeBps: 50,
    platformFeeBps: 50,
    curveMiningCap: 300_000n,
    curveMiningMined: 120_000n,
    curveMiningUnpaid: 5_000n,
    curveMiningBlockReward: 25n,
    curveMiningOpen: true,
    graduated: false,
    curvePhaseEndsAt: 0n,
    discoveryReserveTotal: 50_000n,
    discoveryEpochBudget: 4_000n,
    discoveryEpochSpent: 250n,
    discoveryEpochIndex: 9,
    discoveryPaused: false,
    twapCumPriceLamportsPerUnit: 1n,
    twapLastUpdateSlot: 2n,
    twapLastPrice: 3n,
    twapWindowSlot: 4n,
    twapWindowCum: 5n,
    epochSeed: new Uint8Array(32).fill(0xab),
    epochSeedEpoch: 8,
    epochSeedTargetSlot: 1_234_900n,
    epochSeedRecordedSlot: 1_234_950n,
    status: "MiningActive",
    statusByte: 1,
    bump: 254,
    version: 5,
  };

  it("keeps the program's own ledger values as strings and the seed as hex", async () => {
    const { env, calls } = recordingDb();
    await writeCoin(env, COIN, MINT, coin, 4_242n);
    const insert = calls[0]!;
    expect(insert.sql).toContain("INSERT INTO coins");
    expect(insert.args[0]).toBe(COIN);
    expect(insert.args[1]).toBe(MINT);
    expect(insert.args[5]).toBe("MINING_ACTIVE");
    expect(insert.args[7]).toBe("500");
    expect(insert.args[10]).toBe("60");
    expect(insert.args[14]).toBe("123");
    expect(insert.args.slice(45, 50)).toEqual(["1", "2", "3", "4", "5"]);
    expect(insert.args[50]).toBe("ab".repeat(32));
    expect(insert.args[51]).toBe(8);
    expect(insert.args[52]).toBe("1234900");
    // The slug is derived, and it is derived from the mint and creator rather than from input.
    expect(insert.args[2]).toBe(coinSlug(OWNER, MINT));
  });

  it("writes the coin mirror without touching the public read model", async () => {
    const { env, calls } = recordingDb();
    await writeCoin(env, COIN, MINT, coin, 4_242n);
    // One statement: the read model is the caller's, so a raw update can never leave a stale
    // conversion behind without the caller having decided to write one.
    expect(calls).toHaveLength(1);
  });
});

describe("writeProtocolConfig", () => {
  it("stores the whole config as a payload alongside the columns the UI reads", async () => {
    const { env, calls } = recordingDb();
    const config = {
      authority: OWNER,
      treasury: MINT,
      crankPool: COIN,
      creatorFeeBps: 50,
      platformFeeBps: 50,
      crankPoolFeeBps: 0,
      discoveryMaxBps: 100,
      discoveryEpochBudgetBps: 500,
      starterEfficiencyBps: 2_500,
      starterTrancheBps: 1_000,
      bondLamports: 70_000_000n,
      bondCooldownSeconds: 604_800n,
      epochSeedDelaySlots: 32n,
      epochSeedMaxLatenessSlots: 512n,
      minCurveMiningBlocks: 48n,
      discoveryDailyCapLamports: 1_000_000_000n,
      discoveryWeeklyCapLamports: 4_000_000_000n,
      discoveryGlobalDailyCapLamports: 50_000_000_000n,
      discoveryEpochBudgetLamports: 2_000_000_000n,
      rarityTiers: [],
      rarityTierCount: 6,
      timelockSeconds: 172_800n,
      pausedFlags: 0,
      pausedUntil: 0n,
      bump: 255,
      version: 5,
    } satisfies DecodedProtocolConfig;
    await writeProtocolConfig(env, config, 4_242n);
    const insert = calls[0]!;
    expect(insert.sql).toContain("INSERT INTO protocol_config");
    expect(insert.args[6]).toBe("70000000");
    expect(insert.args[8]).toBe(2_500);
    expect(insert.args[9]).toBe(1_000);
    // The payload carries bigints as strings, so it is re-readable without a lossy JSON round trip.
    const payload = insert.args.find(
      (argument): argument is string => typeof argument === "string" && argument.startsWith("{"),
    );
    expect(payload).toContain(`"bondLamports":"70000000"`);
    expect(payload).toContain(`"authority":"${OWNER}"`);
  });
});
