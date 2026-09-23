import { describe, expect, it } from "vitest";
import { DIGGO_CONFIG, createDiggoConfig, type CrewComponent, type CrewLevels } from "./config";
import {
  CREW_COMPONENTS,
  clusterDampingBps,
  crewPower,
  crewTier,
  crewTotalLevel,
  drillEfficiency,
  effectiveMiningPower,
  maxCrewPowerRatio,
  minersBasePower,
  upgradeCostMultiplier,
  upgradeOreCost,
} from "./crew";
import { oreEfficiency } from "./ore";

const starter = { miners: 1, drills: 1, carts: 1, foreman: 1, storage: 1 };
const veteran = { miners: 100, drills: 100, carts: 100, foreman: 100, storage: 100 };

describe("Mining Crew branches", () => {
  it("keeps every branch strategically distinct", () => {
    const base = crewPower({ miners: 10, drills: 10, carts: 1, foreman: 1, storage: 1 });
    const withCarts = crewPower({ miners: 10, drills: 10, carts: 60, foreman: 1, storage: 1 });
    const withForeman = crewPower({ miners: 10, drills: 10, carts: 1, foreman: 60, storage: 1 });
    const withStorage = crewPower({ miners: 10, drills: 10, carts: 1, foreman: 1, storage: 60 });
    const withDrills = crewPower({ miners: 10, drills: 60, carts: 1, foreman: 1, storage: 1 });

    // Carts, Foreman and Storage are not mining power branches.
    expect(withCarts).toBe(base);
    expect(withForeman).toBe(base);
    expect(withStorage).toBe(base);
    // Drills multiply Miner output instead of adding a second flat power term.
    expect(withDrills).toBeGreaterThan(base);
  });

  it("makes Drills a multiplier on Miners, never flat power", () => {
    const weakMiners = { miners: 1, drills: 100, carts: 1, foreman: 1, storage: 1 };
    const strongMiners = { miners: 100, drills: 1, carts: 1, foreman: 1, storage: 1 };
    const multiplier = drillEfficiency(100);
    expect(multiplier).toBeGreaterThan(1);
    expect(multiplier).toBeLessThan(1 + DIGGO_CONFIG.crew.drillEfficiencyGain + 0.001);
    // A maxed Drill branch cannot carry a starter crew above a real miner crew.
    expect(crewPower(weakMiners)).toBeLessThan(crewPower(strongMiners));
    expect(minersBasePower(100) / minersBasePower(1)).toBeLessThan(100);
  });

  it("makes Foreman a discount on upgrade costs", () => {
    expect(upgradeCostMultiplier(1)).toBe(1);
    const discounted = upgradeOreCost("miners", 10, 60);
    const full = upgradeOreCost("miners", 10, 1);
    expect(discounted).toBeLessThan(full);
    expect(upgradeCostMultiplier(100)).toBeGreaterThanOrEqual(DIGGO_CONFIG.crew.minimumUpgradeCostMultiplier);
  });

  it("applies diminishing returns per level", () => {
    const early = minersBasePower(11) - minersBasePower(1);
    const late = minersBasePower(100) - minersBasePower(90);
    expect(late).toBeLessThan(early);
  });

  it("bounds a max-level veteran crew against a starter crew", () => {
    const ratio = crewPower(veteran) / crewPower(starter);
    expect(ratio).toBeLessThanOrEqual(DIGGO_CONFIG.crew.maxVeteranPowerRatio);
    expect(maxCrewPowerRatio()).toBeLessThanOrEqual(DIGGO_CONFIG.crew.maxVeteranPowerRatio);
    expect(crewPower(veteran)).toBeGreaterThan(crewPower(starter));
  });

  it("respects a tightened veteran ratio from config", () => {
    const strict = createDiggoConfig({ crew: { maxVeteranPowerRatio: 5, minerPowerExponent: 0.25 } });
    const ratio = crewPower(veteran, strict) / crewPower(starter, strict);
    expect(ratio).toBeLessThanOrEqual(strict.crew.maxVeteranPowerRatio);
    expect(maxCrewPowerRatio(strict)).toBeLessThanOrEqual(strict.crew.maxVeteranPowerRatio);
  });

  it("promotes crew tiers from combined levels", () => {
    expect(crewTotalLevel(starter)).toBe(5);
    expect(crewTier(starter).tier).toBe(1);
    expect(crewTier({ miners: 20, drills: 20, carts: 20, foreman: 20, storage: 20 }).tier).toBe(4);
    expect(crewTier(veteran).tier).toBe(DIGGO_CONFIG.crew.tiers[DIGGO_CONFIG.crew.tiers.length - 1].tier);
  });

  it("rejects invalid levels and unknown components", () => {
    expect(() => crewPower({ miners: 0, drills: 1, carts: 1, foreman: 1, storage: 1 })).toThrow();
    expect(() => crewPower({ miners: 101, drills: 1, carts: 1, foreman: 1, storage: 1 })).toThrow();
    expect(() => upgradeOreCost("miners", 100)).toThrow();
    expect(() => upgradeOreCost("miners", 0)).toThrow();
    expect(() => upgradeOreCost("lasers" as CrewComponent, 1)).toThrow();
    expect(CREW_COMPONENTS).toHaveLength(5);
  });

  it("gives Carts and Foreman an ORE efficiency role", () => {
    expect(oreEfficiency(starter)).toBeCloseTo(1, 6);
    expect(oreEfficiency({ miners: 1, drills: 1, carts: 60, foreman: 1, storage: 1 })).toBeGreaterThan(1);
    expect(oreEfficiency({ miners: 1, drills: 1, carts: 1, foreman: 60, storage: 1 })).toBeGreaterThan(1);
    expect(oreEfficiency({ miners: 100, drills: 100, carts: 100, foreman: 100, storage: 100 })).toBeLessThan(2);
  });
});

describe("effective Mining Power (spec 40, 53, 58, 61, 64)", () => {
  const day = (days: number): number => days * DIGGO_CONFIG.time.secondsPerDay;

  it("scales block weight by account maturity, not only by ORE", () => {
    const power = 1_000;
    expect(effectiveMiningPower({ power, accountAgeSeconds: 0 })).toBe(200n);
    expect(effectiveMiningPower({ power, accountAgeSeconds: day(2) })).toBe(400n);
    expect(effectiveMiningPower({ power, accountAgeSeconds: day(6) })).toBe(700n);
    // From the seventh day on, a crew brings its whole power to a block.
    expect(effectiveMiningPower({ power, accountAgeSeconds: day(7) })).toBe(1_000n);
    expect(effectiveMiningPower({ power, accountAgeSeconds: day(30) })).toBe(1_000n);
    // Never zero: a registered crew always mines something (spec 53 keeps accounting running).
    expect(effectiveMiningPower({ power: 1n, accountAgeSeconds: 0 })).toBe(1n);
    expect(effectiveMiningPower({ power: 0n, accountAgeSeconds: day(30) })).toBe(0n);
  });

  it("leaves a household alone and damps a farm-sized device cluster", () => {
    const power = 1_000;
    const aged = day(30);
    expect(clusterDampingBps({ walletsOnDevice: 1, walletsOnNetwork: 1 })).toBe(10_000);
    expect(clusterDampingBps({ walletsOnDevice: 3, walletsOnNetwork: 3 })).toBe(10_000);
    expect(effectiveMiningPower({ power, accountAgeSeconds: aged, cluster: { walletsOnDevice: 4 } })).toBe(1_000n);
    const farmed = effectiveMiningPower({
      power,
      accountAgeSeconds: aged,
      cluster: { walletsOnDevice: 15, walletsOnNetwork: 25 },
    });
    // Fifteen wallets on one device keep 0.7^11 of a single wallet's weight - under 2%.
    expect(farmed).toBe(19n);
    expect(farmed).toBeLessThan(BigInt(power) / 40n);
    // A whole farm on one device lands on the configured floor rather than nothing at all.
    expect(
      effectiveMiningPower({ power, accountAgeSeconds: aged, cluster: { walletsOnDevice: 100_000 } }),
    ).toBe(BigInt(Math.floor((power * DIGGO_CONFIG.effectivePower.cluster.minimumFactorBps) / 10_000)));
  });

  it("never throttles an honest shared network below the network floor", () => {
    const crowdedNetwork = clusterDampingBps({ walletsOnDevice: 1, walletsOnNetwork: 100_000 });
    expect(crowdedNetwork).toBe(DIGGO_CONFIG.effectivePower.cluster.minimumNetworkFactorBps);
  });

  it("caps one account's share of a block without shrinking an ordinary crew", () => {
    const cap = DIGGO_CONFIG.effectivePower.perAccountBlockShareCapBps;
    expect(cap).toBeGreaterThan(0);
    // A single big position in a mine with many players is cut to the configured share of the power
    // *outside* it: the account's own weight is part of the mine's total, so counting it would let
    // the account raise the very ceiling it is measured against.
    const whale = effectiveMiningPower({
      power: 500_000,
      accountAgeSeconds: day(30),
      mineTotalPower: 1_000_000,
    });
    expect(whale).toBe(BigInt(Math.floor((500_000 * cap) / 10_000)));
    // ...while a normal crew in a small or brand-new mine is left at its own weight (spec 63).
    expect(effectiveMiningPower({ power: 153, accountAgeSeconds: day(30), mineTotalPower: 100 })).toBe(153n);
  });

  it("keeps the share cap above the strongest reachable crew", () => {
    // The ceiling's floor is what makes it inert for a single account: if the crew curve ever grew
    // past it, the cap would start shrinking ordinary solo players instead of clusters.
    const maxed = CREW_COMPONENTS.reduce<Record<string, number>>(
      (levels, component) => ({ ...levels, [component]: DIGGO_CONFIG.crew.maxLevel }),
      {},
    );
    expect(crewPower(maxed as unknown as CrewLevels)).toBeLessThan(DIGGO_CONFIG.effectivePower.shareCapFloorPower);
  });

  it("bounds a cluster's block share without compounding when it is split", () => {
    // One farm, spread over a network cluster of a given size, beside a mine that is mostly honest
    // mining. Every wallet is a maxed veteran crew, i.e. the strongest weight a real account can
    // bring, so this is the best case a splitter can construct.
    const farmOf = (size: number): { perAccount: bigint; cluster: bigint } => {
      const perAccount = effectiveMiningPower({
        power: 2_259,
        accountAgeSeconds: day(30),
        cluster: { walletsOnDevice: 1, walletsOnNetwork: size },
        mineTotalPower: 500_000,
      });
      return { perAccount, cluster: perAccount * BigInt(size) };
    };

    const small = farmOf(60);
    const large = farmOf(200);
    // Splitting the same farm across more than three times as many wallets does not raise what the
    // cluster may hold: the ceiling is measured against the power outside the cluster and divided
    // over the wallets past the allowance.
    expect(large.cluster).toBeLessThan(small.cluster);
    expect(small.perAccount).toBeLessThan(2_259n);
    expect(large.perAccount).toBeLessThan(small.perAccount);
    // A cluster inside its allowance is not a farm: a household of four devices keeps its whole
    // share, exactly as a single account does.
    expect(
      effectiveMiningPower({
        power: 2_259,
        accountAgeSeconds: day(30),
        cluster: {
          walletsOnDevice: DIGGO_CONFIG.effectivePower.cluster.deviceAllowance,
          walletsOnNetwork: DIGGO_CONFIG.effectivePower.cluster.networkAllowance,
        },
        mineTotalPower: 500_000,
      }),
    ).toBe(2_259n);
  });
});
