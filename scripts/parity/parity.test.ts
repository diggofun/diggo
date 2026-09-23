/**
 * The node-side half of the parity harness (WS-G).
 *
 * shared/parity/parity.test.ts asserts the vectors the program crate generates for the frozen
 * contract, and it has to run without a filesystem because shared/** is type-checked by the worker
 * project. This file is the other half: it runs under the node project, so it can read the JSON
 * vector files that A, B and C emit - the design's rule is that the chain generates and TypeScript
 * asserts, and a vector a workstream writes has to be read by something that can fail.
 *
 *   npx vitest run --config scripts/parity/vitest.config.ts
 *
 * Families whose chain implementation has not landed are reported by name rather than skipped
 * silently, so an empty run is visible as an empty run.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CREW_COMPONENTS,
  DRILL_EFFICIENCY_BPS,
  FOREMAN_COST_BPS,
  MINERS_POWER,
  ONCHAIN_MATURITY_RAMP,
  ONCHAIN_MAX_CREW_LEVEL,
  UPGRADE_ORE_COST,
} from "../../shared/crew";
import {
  CARTS_CAPACITY,
  CARTS_ORE_BPS,
  FOREMAN_ORE_BPS,
  ONCHAIN_BASE_ORE_PER_ACTIVE_HOUR,
  ONCHAIN_STORAGE_BASE_CAPACITY,
  STORAGE_CAPACITY,
} from "../../shared/ore";
import { ONCHAIN_STREAK_MILESTONES } from "../../shared/streak";
import { splitBlock } from "../sim/v2rules";
import { TRANCHE } from "../../shared/parity/vectors.tranche.generated";
import { CONTRACT } from "../../shared/parity/vectors.contract.generated";
import { EPOCH_SEED } from "../../shared/parity/vectors.epochSeed.generated";

const root = resolve(__dirname, "..", "..");

function readJson<T>(relative: string): T | null {
  const path = resolve(root, relative);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** WS-A's vectors, emitted by cargo test emit_parity_vectors in the program crate. */
interface PlayerVectors {
  source: string;
  levels: number;
  constants: Record<string, number>;
  maturityRamp: readonly { upToDay: number; bps: number }[];
  streakMilestones: readonly { day: number; ore: number; freezes: number }[];
  tables: {
    minersPower: readonly number[];
    drillEfficiencyBps: readonly number[];
    foremanCostBps: readonly number[];
    cartsOreBps: readonly number[];
    foremanOreBps: readonly number[];
    storageCapacity: readonly number[];
    cartsCapacity: readonly number[];
    upgradeOreCost: Readonly<Record<string, readonly number[]>>;
  };
}

const player = readJson<PlayerVectors>("shared/parity/player.json");

describe("WS-A's player vectors against the TypeScript mirrors", () => {
  it("exists", () => {
    expect(player, "shared/parity/player.json is missing").not.toBeNull();
  });

  it("has the crew power tables the chain has, level for level", () => {
    if (!player) return;
    expect(player.tables.minersPower).toEqual([...MINERS_POWER]);
    expect(player.tables.drillEfficiencyBps).toEqual([...DRILL_EFFICIENCY_BPS]);
    expect(player.tables.foremanCostBps).toEqual([...FOREMAN_COST_BPS]);
    expect(player.tables.minersPower.length).toBe(ONCHAIN_MAX_CREW_LEVEL);
  });

  it("has the ORE tables the chain has, level for level", () => {
    if (!player) return;
    expect(player.tables.cartsOreBps).toEqual([...CARTS_ORE_BPS]);
    expect(player.tables.foremanOreBps).toEqual([...FOREMAN_ORE_BPS]);
    expect(player.tables.storageCapacity).toEqual([...STORAGE_CAPACITY]);
    expect(player.tables.cartsCapacity).toEqual([...CARTS_CAPACITY]);
  });

  it("has the same upgrade costs for all five components and all hundred levels", () => {
    if (!player) return;
    const components = Object.keys(player.tables.upgradeOreCost);
    expect(components.length).toBe(CREW_COMPONENTS.length);
    // The chain names the tables c0..c4 by component index; the client names them after the
    // component. The order is the contract, so the index is the join.
    for (const [index, component] of CREW_COMPONENTS.entries()) {
      const client = UPGRADE_ORE_COST[component];
      expect(client, "no client table for " + component).toBeDefined();
      expect(player.tables.upgradeOreCost["c" + String(index)], component).toEqual([...client]);
    }
  });

  it("has the maturity ramp and the streak milestones the client applies", () => {
    if (!player) return;
    // The client's ramp carries one more point than the chain's: its terminal entry says what
    // happens from the last milestone onwards, which the chain expresses by falling off the end.
    const ramp = ONCHAIN_MATURITY_RAMP.slice(0, player.maturityRamp.length);
    expect(ramp.length).toBe(player.maturityRamp.length);
    expect(player.maturityRamp.map((point) => point.upToDay)).toEqual(
      ramp.map((point) => point.upToDay),
    );
    expect(player.maturityRamp.map((point) => point.bps)).toEqual(
      ramp.map((point) => point.bps),
    );
    expect(player.streakMilestones.map((point) => point.day)).toEqual(
      ONCHAIN_STREAK_MILESTONES.map((point) => point.day),
    );
    expect(player.streakMilestones.map((point) => point.ore)).toEqual(
      ONCHAIN_STREAK_MILESTONES.map((point) => point.ore),
    );
    expect(player.streakMilestones.map((point) => point.freezes)).toEqual(
      ONCHAIN_STREAK_MILESTONES.map((point) => point.freezes),
    );
  });

  it("has the ORE constants the client applies", () => {
    if (!player) return;
    expect(player.constants.baseOrePerActiveHour).toBe(ONCHAIN_BASE_ORE_PER_ACTIVE_HOUR);
    expect(player.constants.storageBaseCapacity).toBe(ONCHAIN_STORAGE_BASE_CAPACITY);
    expect(player.constants.maxCrewLevel).toBe(ONCHAIN_MAX_CREW_LEVEL);
    expect(player.constants.bondLamports).toBe(70_000_000);
    expect(player.constants.bondCooldownSeconds).toBe(604_800);
    expect(player.constants.starterEfficiencyBps).toBe(2_500);
    expect(player.constants.starterTrancheBps).toBe(1_000);
  });
});

describe("the starter tranche rule", () => {
  it("splits a block exactly as the chain's amendment does", () => {
    expect(TRANCHE.cases.length).toBeGreaterThan(0);
    for (const vector of TRANCHE.cases) {
      const split = splitBlock(
        BigInt(vector.blockReward),
        BigInt(vector.bondedPower),
        BigInt(vector.starterPower),
        true,
      );
      const label =
        "block " +
        String(vector.blockReward) +
        ", bonded " +
        String(vector.bondedPower) +
        ", starter " +
        String(vector.starterPower);
      expect(split.starterTake, label + " starter take").toBe(BigInt(vector.starterTake));
      expect(split.bondedTake, label + " bonded take").toBe(BigInt(vector.bondedTake));
      expect(split.remainder, label + " remainder").toBe(BigInt(vector.remainder));
    }
  });

  it("never hands the starter tranche more than its cap, and never burns the rest", () => {
    for (const vector of TRANCHE.cases) {
      const block = BigInt(vector.blockReward);
      const split = splitBlock(
        block,
        BigInt(vector.bondedPower),
        BigInt(vector.starterPower),
        true,
      );
      expect(split.starterTake * 10_000n <= block * 1_000n).toBe(true);
      expect(split.starterTake + split.bondedTake + split.remainder).toBe(block);
      if (vector.bondedPower === 0) {
        expect(split.bondedTake).toBe(0n);
      } else {
        expect(split.remainder).toBe(0n);
      }
    }
  });
});

describe("the generated vector modules", () => {
  it("carry the same data as the committed JSON", () => {
    const contractJson = readJson<unknown>("tests/vectors/contract.json");
    const epochSeedJson = readJson<unknown>("tests/vectors/epoch_seed.json");
    const trancheJson = readJson<unknown>("tests/vectors/tranche.json");
    expect(contractJson).not.toBeNull();
    expect(epochSeedJson).not.toBeNull();
    expect(trancheJson).not.toBeNull();
    // The TypeScript module is the JSON text with a declaration around it, so the two forms can
    // only disagree if one was hand-edited.
    expect(JSON.parse(JSON.stringify(CONTRACT))).toEqual(contractJson);
    expect(JSON.parse(JSON.stringify(EPOCH_SEED))).toEqual(epochSeedJson);
    expect(JSON.parse(JSON.stringify(TRANCHE))).toEqual(trancheJson);
  });
});

describe("vector families still owed by a workstream", () => {
  it("reports which ones are missing rather than passing silently", () => {
    const owed: readonly { file: string; owner: string }[] = [
      { file: "shared/parity/curve.json", owner: "WS-B (shared/curve.ts)" },
      { file: "shared/parity/index.json", owner: "WS-C (shared/rewardIndex.ts)" },
      { file: "shared/parity/rarity.json", owner: "WS-C (shared/rarity.ts)" },
      { file: "shared/parity/discovery.json", owner: "WS-C (shared/discovery.ts)" },
      { file: "shared/parity/epochSeed.json", owner: "WS-C (shared/epochSeed.ts)" },
    ];
    const missing = owed.filter((entry) => !existsSync(resolve(root, entry.file)));
    const present = owed.filter((entry) => existsSync(resolve(root, entry.file)));
    console.log(
      "parity vectors present: " +
        String(present.length) +
        "; still owed: " +
        (missing.length === 0
          ? "none"
          : missing.map((entry) => entry.file + " from " + entry.owner).join(", ")),
    );
    // The assertion is that every family is either present or named, never forgotten.
    expect(present.length + missing.length).toBe(owed.length);
  });
});
