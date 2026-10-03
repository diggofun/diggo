/**
 * No pay-to-play, pinned at the read API.
 *
 * The bond is retired: no new bond may be posted, nothing a wallet holds scales its power or its
 * rolls, and a wallet that paid nothing plays exactly as one that paid. Three of this Worker's read
 * views used to say otherwise — a leaderboard badge, a tranche label on a mine report, and the
 * protocol view quoting the deposit and the starter penalty — and the assertions below are that
 * they stay gone, phrased against the payload a client receives rather than against the source that
 * builds it. They are a client-visible contract, not an implementation detail: the pay-to-play
 * prompt can be rebuilt from any one of them.
 *
 * The other half of the decision is that the bond did not vanish. A bond posted before the
 * retirement must stay readable and withdrawable, so the last test here pins the events that
 * record one; `indexStore.test.ts` covers the mirror that keeps the frozen bond block readable
 * in D1, and `v2/program.test.ts` covers the account layout it is copied from.
 */
import { describe, expect, it, vi } from "vitest";
import bs58 from "bs58";
import type { RuntimeEnv } from "./env";
import { leaderboards } from "./leaderboard";
import { mineReport } from "./mine";
import { protocolView } from "./tokens";
import { EVENT_DISCRIMINATOR, decodeProgramEvents, hexToBytes } from "./v2/program";

// The mine report re-reads its coin from chain for the live block reward. This file is about the
// shape of the payload, so the read answers "no coin" and the report falls back to the index.
vi.mock("./chainV2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chainV2")>();
  return { ...actual, readCoinByMint: async () => null };
});

interface Query {
  sql: string;
  args: unknown[];
}

/** A D1 stand-in that answers by SQL and records what was asked, as indexStore.test.ts does. */
function stubEnv(answer: (sql: string, args: unknown[]) => { first?: unknown; results?: unknown[] }) {
  const queries: Query[] = [];
  const statement = (sql: string) => {
    let bound: unknown[] = [];
    const api = {
      bind(...args: unknown[]) {
        bound = args;
        return api;
      },
      async first() {
        queries.push({ sql, args: bound });
        return answer(sql, bound).first ?? null;
      },
      async all() {
        queries.push({ sql, args: bound });
        return { results: answer(sql, bound).results ?? [] };
      },
      async run() {
        queries.push({ sql, args: bound });
        return { success: true, meta: { changes: 1 } };
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
  } as unknown as RuntimeEnv;
  return { env, queries };
}

const PDA = bs58.encode(new Uint8Array(32).fill(1));
const WALLET_PAID = bs58.encode(new Uint8Array(32).fill(2));
const WALLET_FREE = bs58.encode(new Uint8Array(32).fill(3));
const MINT = bs58.encode(new Uint8Array(32).fill(4));
const COIN = bs58.encode(new Uint8Array(32).fill(5));

/** One mirrored player_accounts row: the columns a board ranks, plus the legacy bond block. */
function playerRow(wallet: string, bondLamports: string, username: string) {
  return {
    player: PDA,
    wallet,
    created_slot: "1",
    created_at: 1_700_000_000,
    active_until: 1_700_086_400,
    last_activation_at: 1_700_000_000,
    streak: 3,
    longest_streak: 5,
    valid_activations: 4,
    active_days: 6,
    streak_freezes: 0,
    miners_level: 3,
    drills_level: 4,
    carts_level: 5,
    foreman_level: 6,
    storage_level: 7,
    ore_balance: "1000",
    ore_earned: "2000",
    ore_spent: "1000",
    active_mine: COIN,
    day_index: 20_000,
    week_index: 2_857,
    spent_day_lamports: "0",
    spent_week_lamports: "0",
    roll_window: 1,
    roll_count: 0,
    last_roll_at: 0,
    bond_lamports: bondLamports,
    bond_locked_at: 1_699_000_000,
    unbond_available_at: 0,
    bond_source: bondLamports === "0" ? 0 : 1,
    bond_sponsor_vault: "",
    indexed_at: 7,
    username,
    discovery_value: "5000",
    assigned_power_total: "1200",
  };
}

describe("leaderboards", () => {
  it("ranks a wallet that never posted a bond and badges nobody as bonded", async () => {
    const rows = [
      playerRow(WALLET_PAID, "70000000", "paid"),
      playerRow(WALLET_FREE, "0", "free"),
    ];
    const { env } = stubEnv(() => ({ results: rows }));
    const response = await leaderboards(new Request("https://diggo.test/api/leaderboards"), env, 25);
    const body = (await response.json()) as {
      boards: { key: string; entries: Record<string, unknown>[] }[];
    };
    const power = body.boards.find((board) => board.key === "power");
    // Both wallets rank: what one of them locked is not a column here, so it cannot filter a row
    // out and it cannot lift one up.
    expect(power?.entries.map((entry) => entry.wallet)).toEqual([WALLET_PAID, WALLET_FREE]);
    // Exactly the ranked fields, and no bond flag among them.
    expect(power?.entries.map((entry) => Object.keys(entry).sort())).toEqual([
      ["bot", "crewPower", "crewTier", "metric", "rank", "username", "wallet"],
      ["bot", "crewPower", "crewTier", "metric", "rank", "username", "wallet"],
    ]);
  });
});

describe("mineReport", () => {
  const coinRow = {
    mint: MINT,
    coin: COIN,
    slug: "gold-mine",
    symbol: "GOLD",
    status: "MINING",
    graduated: 0,
    venue: "CURVE",
    reserve_remaining: "0",
    cumulative_distributed: "0",
    discovery_remaining: "0",
    discovery_reserve_total: "0",
    discovery_epoch_budget: "0",
    discovery_epoch_spent: "0",
    total_power: "1200",
    bonded_power: "1200",
    starter_power: "0",
    creator_fee_claimable: "0",
    platform_fee_claimable: "0",
    epoch_index: 1,
    epoch_ends_at: 2,
    epoch_ends_slot: "3",
    epoch_seed_recorded_slot: "0",
    graduation_target: "0",
    sol_reserve: "0",
    next_block_at: 100,
    decimals: 6,
  };

  it("reports a position armed before the retirement with no tier label", async () => {
    const { env, queries } = stubEnv((sql) =>
      sql.includes("mining_positions_v2")
        ? { first: { assigned_power: "900", pending_reward: "1500000" } }
        : { first: coinRow },
    );
    const request = new Request(
      "https://diggo.test/api/mines/gold-mine/report?wallet=" + WALLET_FREE,
    );
    const response = await mineReport(request, env, "gold-mine");
    const body = (await response.json()) as { position: Record<string, unknown> };
    // A position that settles against the starter index is still reported in full: removing the
    // bond does not hide what a legacy position holds.
    expect(body.position).toEqual({
      assignedPower: "900",
      pendingReward: "1500000",
      pendingRewardWhole: 1.5,
    });
    // Nothing in it reads as a lesser tier, and the report no longer asks the index for one.
    expect(body.position).not.toHaveProperty("tranche");
    expect(queries.some((query) => query.sql.includes("tranche"))).toBe(false);
  });

  it("gives the same report to a wallet that posted a bond and one that did not", async () => {
    const report = async (wallet: string) => {
      const { env } = stubEnv((sql) =>
        sql.includes("mining_positions_v2")
          ? { first: { assigned_power: "900", pending_reward: "1500000" } }
          : { first: coinRow },
      );
      const response = await mineReport(
        new Request("https://diggo.test/api/mines/gold-mine/report?wallet=" + wallet),
        env,
        "gold-mine",
      );
      return (await response.json()) as { position: unknown };
    };
    expect(await report(WALLET_FREE)).toEqual(await report(WALLET_PAID));
  });
});

describe("protocolView", () => {
  it("serves the live caps and quotes no deposit and no efficiency penalty", async () => {
    // The row is exactly what the frozen ProtocolConfig mirror holds, retired columns included:
    // the view has to drop them even though D1 still carries them.
    const { env } = stubEnv(() => ({
      first: {
        authority: "auth",
        treasury: "treasury",
        crank_pool: "pool",
        creator_fee_bps: 500,
        platform_fee_bps: 100,
        crank_pool_fee_bps: 20,
        bond_lamports: "70000000",
        bond_cooldown_seconds: 604_800,
        starter_efficiency_bps: 2_500,
        starter_tranche_bps: 1_000,
        discovery_daily_cap_lamports: "1000000",
        discovery_weekly_cap_lamports: "5000000",
        discovery_global_daily_cap_lamports: "9000000",
        discovery_epoch_budget_lamports: "2500000",
        paused_flags: 0,
        paused_until: 0,
        indexed_at: 1_700_000_000,
      },
    }));
    const view = await protocolView(env);
    expect(Object.keys(view ?? {}).sort()).toEqual([
      "authority",
      "crankPool",
      "crankPoolFeeBps",
      "creatorFeeBps",
      "discoveryDailyCapLamports",
      "discoveryEpochBudgetLamports",
      "discoveryGlobalDailyCapLamports",
      "discoveryWeeklyCapLamports",
      "indexedAt",
      "pausedFlags",
      "pausedUntil",
      "platformFeeBps",
      "treasury",
    ]);
    // No bond figure or starter factor may appear under any name, whatever the mirror holds.
    expect(JSON.stringify(view)).not.toMatch(/bond|starter/i);
    expect(Object.values(view ?? {})).not.toContain("70000000");
    expect(Object.values(view ?? {})).not.toContain(604_800);
  });
});

/** A borsh writer, enough for the three bond event bodies. */
class Writer {
  private readonly bytes: number[] = [];
  u8(value: number): this {
    this.bytes.push(value & 0xff);
    return this;
  }
  u64(value: bigint): this {
    let rest = value;
    for (let i = 0; i < 8; i++) {
      this.u8(Number(rest & 0xffn));
      rest >>= 8n;
    }
    return this;
  }
  i64(value: bigint): this {
    return this.u64(BigInt.asUintN(64, value));
  }
  pubkey(value: string): this {
    this.bytes.push(...bs58.decode(value));
    return this;
  }
  done(discriminator: string): Uint8Array {
    return Uint8Array.from([...hexToBytes(discriminator), ...this.bytes]);
  }
}

/** One `Program data:` log line, the way the indexer receives an event from a transaction. */
function programData(discriminator: string, body: Uint8Array): string {
  return "Program data: " + Buffer.from(body).toString("base64");
}

describe("the legacy bond", () => {
  it("still decodes the events that record a posted bond and its withdrawal", () => {
    // These three stay in the Worker's decoder on purpose. They are the only trail a bond posted
    // before the retirement leaves, and the withdrawal of one ends in BondWithdrawn; dropping them
    // would make a legacy deposit unreadable rather than making the game free.
    const posted = new Writer().pubkey(WALLET_PAID).u64(70_000_000n).u8(1).pubkey(MINT);
    expect(
      decodeProgramEvents([programData(EVENT_DISCRIMINATOR.BondPosted, posted.done(EVENT_DISCRIMINATOR.BondPosted))]),
    ).toEqual([
      {
        name: "BondPosted",
        player: WALLET_PAID,
        lamports: 70_000_000n,
        source: 1,
        sponsorVault: MINT,
      },
    ]);

    const requested = new Writer().pubkey(WALLET_PAID).i64(1_700_604_800n);
    expect(
      decodeProgramEvents([
        programData(
          EVENT_DISCRIMINATOR.UnbondRequested,
          requested.done(EVENT_DISCRIMINATOR.UnbondRequested),
        ),
      ]),
    ).toEqual([{ name: "UnbondRequested", player: WALLET_PAID, unbondAvailableAt: 1_700_604_800n }]);

    const withdrawn = new Writer().pubkey(WALLET_PAID).u64(70_000_000n).pubkey(WALLET_PAID);
    expect(
      decodeProgramEvents([
        programData(
          EVENT_DISCRIMINATOR.BondWithdrawn,
          withdrawn.done(EVENT_DISCRIMINATOR.BondWithdrawn),
        ),
      ]),
    ).toEqual([
      { name: "BondWithdrawn", player: WALLET_PAID, lamports: 70_000_000n, recipient: WALLET_PAID },
    ]);
  });
});
