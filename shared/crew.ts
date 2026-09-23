import {
  BPS_DENOMINATOR,
  DIGGO_CONFIG,
  type CrewLevels,
  type CrewTierConfig,
  type CrewComponent,
  type DiggoConfig,
  type MaturityRampPoint,
  rampBps,
} from "./config";

/**
 * Mining Crew branches (spec 10). Each branch has its own strategic meaning:
 * - Miners: base Mining Power.
 * - Drills: efficiency multiplier applied to Miners (never flat power).
 * - Carts: logistics, raising ORE efficiency (never mining power).
 * - Foreman: organisation, reducing upgrade costs and raising ORE efficiency.
 * - Storage: offline capacity and offline hours.
 */
export const CREW_COMPONENTS: readonly CrewComponent[] = [
  "miners",
  "drills",
  "carts",
  "foreman",
  "storage",
];

export function assertCrewLevel(level: number, config: DiggoConfig = DIGGO_CONFIG): void {
  if (
    !Number.isInteger(level) ||
    level < config.crew.minLevel ||
    level > config.crew.maxLevel
  ) {
    throw new Error("Invalid crew level");
  }
}

function assertAllLevels(levels: CrewLevels, config: DiggoConfig): void {
  for (const component of CREW_COMPONENTS) {
    const level = levels[component];
    if (typeof level !== "number") throw new Error("Invalid crew levels");
    if (level < config.crew.minLevel || level > config.crew.maxLevel) {
      throw new Error("Invalid crew levels");
    }
  }
}

/** floor(starterPower * level ^ minerPowerExponent). */
export const MINERS_POWER: readonly number[] = [
  100, 153, 197, 236, 271, 303, 334, 363, 390, 416,
  442, 466, 490, 513, 536, 557, 579, 600, 620, 640,
  660, 679, 698, 717, 735, 753, 771, 789, 806, 823,
  840, 857, 873, 890, 906, 922, 938, 953, 969, 984,
  999, 1014, 1029, 1044, 1059, 1073, 1088, 1102, 1116, 1130,
  1144, 1158, 1172, 1185, 1199, 1213, 1226, 1239, 1252, 1266,
  1279, 1292, 1304, 1317, 1330, 1343, 1355, 1368, 1380, 1393,
  1405, 1417, 1429, 1441, 1453, 1465, 1477, 1489, 1501, 1513,
  1524, 1536, 1548, 1559, 1571, 1582, 1594, 1605, 1616, 1627,
  1639, 1650, 1661, 1672, 1683, 1694, 1705, 1716, 1727, 1737,
];

/** round(10_000 * drillEfficiency(level)). */
export const DRILL_EFFICIENCY_BPS: readonly number[] = [
  10000, 10240, 10461, 10664, 10850, 11022, 11180, 11326, 11460, 11583,
  11696, 11800, 11896, 11985, 12066, 12140, 12209, 12272, 12331, 12384,
  12433, 12479, 12520, 12559, 12594, 12626, 12656, 12684, 12709, 12732,
  12754, 12773, 12792, 12808, 12824, 12838, 12851, 12863, 12874, 12884,
  12893, 12902, 12909, 12917, 12923, 12929, 12935, 12940, 12945, 12949,
  12953, 12957, 12961, 12964, 12967, 12969, 12972, 12974, 12976, 12978,
  12980, 12981, 12983, 12984, 12986, 12987, 12988, 12989, 12990, 12990,
  12991, 12992, 12993, 12993, 12994, 12994, 12995, 12995, 12995, 12996,
  12996, 12996, 12997, 12997, 12997, 12997, 12998, 12998, 12998, 12998,
  12998, 12998, 12999, 12999, 12999, 12999, 12999, 12999, 12999, 12999,
];

/** round(10_000 * max(minimumUpgradeCostMultiplier, 2 - foremanDiscount(level))). */
export const FOREMAN_COST_BPS: readonly number[] = [
  10000, 9807, 9626, 9456, 9298, 9150, 9011, 8881, 8760, 8646,
  8540, 8441, 8348, 8261, 8180, 8104, 8032, 7966, 7904, 7845,
  7791, 7740, 7692, 7647, 7606, 7567, 7530, 7496, 7464, 7434,
  7406, 7380, 7355, 7332, 7311, 7291, 7272, 7255, 7238, 7223,
  7208, 7195, 7182, 7171, 7160, 7149, 7140, 7131, 7122, 7114,
  7107, 7100, 7094, 7088, 7082, 7077, 7072, 7067, 7063, 7059,
  7055, 7051, 7048, 7045, 7042, 7039, 7037, 7034, 7032, 7030,
  7028, 7026, 7025, 7023, 7022, 7020, 7019, 7018, 7017, 7015,
  7014, 7014, 7013, 7012, 7011, 7010, 7010, 7009, 7008, 7008,
  7007, 7007, 7007, 7006, 7006, 7005, 7005, 7005, 7004, 7004,
];

// ---- the on-chain mirror (math/power.rs) --------------------------------------------------
//
// These are the protocol's own numbers. `crewPower` and `upgradeOreCost` below return them
// whenever they are called with the deployed config, so the client, the indexer and the sim
// weight and price a crew exactly as the chain does. A custom config still falls back to the
// reference float implementation, which the chain never uses.
//
// shared/parity/player.json holds the same tables and the golden vectors, emitted from the
// Rust side; WS-G asserts the two against each other and the Rust value wins when they differ.

/** Highest crew level the tables carry; the chain refuses to buy past it. */
export const ONCHAIN_MAX_CREW_LEVEL = 100;
/** Slots in one day at Solana's 400 ms target slot time (math/power.rs SLOTS_PER_DAY). */
export const SLOTS_PER_DAY = 216_000;

/** The maturity schedule of design section 5: day 1 20%, day 3 40%, day 7 70%, then 100%. */
export const ONCHAIN_MATURITY_RAMP: readonly MaturityRampPoint[] = [
  { upToDay: 1, bps: 2_000 },
  { upToDay: 3, bps: 4_000 },
  { upToDay: 7, bps: 7_000 },
  { upToDay: Number.POSITIVE_INFINITY, bps: BPS_DENOMINATOR },
];

/** floor(upgradeCostBase[component] * level ^ upgradeCostExponent), [component][level - 1]. */
export const UPGRADE_ORE_COST: Readonly<Record<string, readonly number[]>> = {
  miners: [
  80, 211, 372, 557, 761, 982, 1219, 1470, 1733, 2009,
  2296, 2593, 2901, 3218, 3545, 3880, 4223, 4575, 4935, 5303,
  5678, 6060, 6449, 6845, 7247, 7656, 8072, 8493, 8921, 9355,
  9794, 10239, 10690, 11147, 11608, 12075, 12547, 13025, 13507, 13995,
  14487, 14984, 15486, 15992, 16503, 17019, 17539, 18064, 18593, 19127,
  19664, 20206, 20752, 21303, 21857, 22415, 22978, 23544, 24114, 24688,
  25266, 25848, 26434, 27023, 27616, 28213, 28813, 29417, 30024, 30635,
  31250, 31868, 32489, 33114, 33742, 34373, 35008, 35646, 36288, 36933,
  37581, 38232, 38886, 39544, 40204, 40868, 41535, 42205, 42878, 43554,
  44233, 44915, 45600, 46288, 46978, 47672, 48369, 49068, 49771, 50476,
  ],
  drills: [
  115, 303, 535, 800, 1094, 1412, 1753, 2113, 2492, 2888,
  3301, 3728, 4170, 4626, 5095, 5577, 6071, 6577, 7095, 7623,
  8162, 8711, 9270, 9839, 10418, 11006, 11603, 12210, 12824, 13448,
  14080, 14719, 15368, 16023, 16687, 17358, 18037, 18723, 19417, 20117,
  20825, 21540, 22261, 22989, 23724, 24465, 25213, 25967, 26728, 27495,
  28268, 29047, 29832, 30623, 31419, 32222, 33031, 33845, 34664, 35490,
  36321, 37157, 37999, 38846, 39698, 40556, 41419, 42287, 43160, 44038,
  44922, 45810, 46703, 47601, 48504, 49412, 50325, 51242, 52164, 53091,
  54022, 54958, 55899, 56844, 57794, 58748, 59706, 60669, 61637, 62609,
  63585, 64565, 65550, 66539, 67532, 68529, 69530, 70536, 71546, 72560,
  ],
  carts: [
  120, 316, 558, 835, 1142, 1474, 1829, 2205, 2600, 3014,
  3444, 3890, 4352, 4827, 5317, 5820, 6335, 6863, 7403, 7954,
  8517, 9090, 9673, 10267, 10871, 11485, 12108, 12740, 13382, 14033,
  14692, 15359, 16036, 16720, 17413, 18113, 18821, 19537, 20261, 20992,
  21730, 22476, 23229, 23989, 24755, 25529, 26309, 27096, 27890, 28690,
  29497, 30309, 31129, 31954, 32786, 33623, 34467, 35316, 36172, 37033,
  37900, 38773, 39651, 40535, 41424, 42319, 43220, 44125, 45037, 45953,
  46875, 47802, 48734, 49671, 50613, 51560, 52513, 53470, 54432, 55399,
  56371, 57348, 58329, 59316, 60307, 61302, 62302, 63307, 64317, 65331,
  66349, 67372, 68400, 69432, 70468, 71509, 72554, 73603, 74656, 75714,
  ],
  foreman: [
  190, 501, 884, 1323, 1808, 2334, 2896, 3492, 4118, 4772,
  5453, 6160, 6890, 7644, 8419, 9215, 10031, 10867, 11722, 12594,
  13485, 14392, 15316, 16257, 17213, 18185, 19171, 20173, 21189, 22218,
  23262, 24319, 25390, 26474, 27570, 28679, 29801, 30935, 32080, 33238,
  34407, 35587, 36779, 37982, 39196, 40421, 41657, 42903, 44159, 45426,
  46703, 47990, 49287, 50594, 51911, 53237, 54573, 55918, 57272, 58636,
  60008, 61390, 62781, 64180, 65589, 67006, 68431, 69866, 71308, 72759,
  74219, 75686, 77162, 78646, 80138, 81638, 83145, 84661, 86184, 87716,
  89255, 90801, 92355, 93917, 95486, 97062, 98646, 100237, 101835, 103441,
  105053, 106673, 108300, 109934, 111574, 113222, 114877, 116538, 118206, 119881,
  ],
  storage: [
  150, 395, 698, 1044, 1427, 1842, 2286, 2756, 3251, 3767,
  4305, 4863, 5440, 6034, 6646, 7275, 7919, 8579, 9254, 9943,
  10646, 11362, 12092, 12834, 13589, 14356, 15135, 15926, 16728, 17541,
  18365, 19199, 20045, 20900, 21766, 22641, 23527, 24422, 25326, 26240,
  27163, 28095, 29036, 29986, 30944, 31911, 32887, 33871, 34863, 35863,
  36871, 37887, 38911, 39943, 40982, 42029, 43084, 44145, 45215, 46291,
  47375, 48466, 49564, 50669, 51780, 52899, 54025, 55157, 56296, 57441,
  58593, 59752, 60917, 62089, 63266, 64451, 65641, 66838, 68040, 69249,
  70464, 71685, 72912, 74145, 75383, 76628, 77878, 79134, 80396, 81664,
  82937, 84215, 85500, 86790, 88085, 89386, 90692, 92004, 93321, 94643,
  ],
};

/** Table index of a crew level, exactly as math/power.rs bounds it. */
export function onchainLevelIndex(level: number): number {
  if (!Number.isInteger(level) || level < 1 || level > ONCHAIN_MAX_CREW_LEVEL) {
    throw new Error("Invalid crew level");
  }
  return level - 1;
}

/** Branch order, matching the chain's [miners, drills, carts, foreman, storage]. */
export function onchainComponentIndex(component: CrewComponent | number): number {
  const index = typeof component === "number" ? component : CREW_COMPONENTS.indexOf(component);
  if (!Number.isInteger(index) || index < 0 || index >= CREW_COMPONENTS.length) {
    throw new Error("Unknown crew component");
  }
  return index;
}

/**
 * The upgrade-cost table in branch order, which is how the chain indexes it: the generated
 * table above is keyed by component name so a reader can check it by eye, and this is the same
 * data as an array.
 */
export const UPGRADE_ORE_COST_BY_INDEX: readonly (readonly number[])[] = CREW_COMPONENTS.map(
  (component) => UPGRADE_ORE_COST[component],
);


/** floor(miners_power[miners] * drill_bps[drills] / BPS): math/power.rs crew_power. */
export function onchainCrewPower(levels: CrewLevels): number {
  const miners = MINERS_POWER[onchainLevelIndex(levels.miners)];
  const drills = DRILL_EFFICIENCY_BPS[onchainLevelIndex(levels.drills)];
  return Math.floor((miners * drills) / BPS_DENOMINATOR);
}

/** floor(cost[component][level] * foreman_bps[foreman] / BPS): math/power.rs upgrade_ore_cost. */
export function onchainUpgradeOreCost(
  component: CrewComponent | number,
  level: number,
  foremanLevel: number,
): number {
  const row = UPGRADE_ORE_COST_BY_INDEX[onchainComponentIndex(component)];
  const base = row[onchainLevelIndex(level)];
  const discount = FOREMAN_COST_BPS[onchainLevelIndex(foremanLevel)];
  return Math.floor((base * discount) / BPS_DENOMINATOR);
}

/** The maturity ramp as bps for a whole number of days. */
export function onchainMaturityRampBps(days: number): number {
  if (!Number.isFinite(days) || days < 0) return 0;
  for (const point of ONCHAIN_MATURITY_RAMP) {
    if (days < point.upToDay) return point.bps;
  }
  return BPS_DENOMINATOR;
}

/** Maturity from the PlayerAccount's creation slot, in bps of full power. */
export function onchainPowerMaturityBps(createdSlot: number, nowSlot: number): number {
  if (nowSlot < createdSlot) return 0;
  return onchainMaturityRampBps(Math.floor((nowSlot - createdSlot) / SLOTS_PER_DAY));
}

/**
 * The power a position is armed with: the crew's raw power, throttled by maturity and by nothing
 * else. There is no deposit to post and no starter mode to leave, so a wallet's power depends only
 * on its crew and its account's age - never on how much SOL it is holding.
 */
export function onchainMiningPower(levels: CrewLevels, maturityBps: number): number {
  return Math.floor((onchainCrewPower(levels) * maturityBps) / BPS_DENOMINATOR);
}

/**
 * Saturating efficiency curve. Returns 1 at the minimum level and approaches
 * 1 + gain at the maximum level, so no branch can grow without bound.
 */
function saturating(level: number, gain: number, scale: number, config: DiggoConfig): number {
  const steps = level - config.crew.minLevel;
  if (steps <= 0) return 1;
  return 1 + gain * (1 - Math.exp(-steps / scale));
}

/** Drills multiply Miner output rather than adding a second flat power term. */
export function drillEfficiency(drillsLevel: number, config: DiggoConfig = DIGGO_CONFIG): number {
  assertCrewLevel(drillsLevel, config);
  return saturating(drillsLevel, config.crew.drillEfficiencyGain, config.crew.drillEfficiencyScale, config);
}

export function minersBasePower(minersLevel: number, config: DiggoConfig = DIGGO_CONFIG): number {
  assertCrewLevel(minersLevel, config);
  return config.crew.starterPower * Math.pow(minersLevel, config.crew.minerPowerExponent);
}

export function crewPower(levels: CrewLevels, config: DiggoConfig = DIGGO_CONFIG): number {
  assertAllLevels(levels, config);
  if (config === DIGGO_CONFIG) return onchainCrewPower(levels);
  const base = minersBasePower(levels.miners, config);
  return Math.floor(base * drillEfficiency(levels.drills, config));
}

/**
 * Highest possible ratio between a max-level crew and a starter crew, derived
 * from the configured curve. Used as a guard test against runaway scaling.
 */
export function maxCrewPowerRatio(config: DiggoConfig = DIGGO_CONFIG): number {
  const minerRatio =
    Math.pow(config.crew.maxLevel, config.crew.minerPowerExponent) /
    Math.pow(config.crew.minLevel, config.crew.minerPowerExponent);
  return minerRatio * (1 + config.crew.drillEfficiencyGain);
}

export function upgradeCostMultiplier(
  foremanLevel: number,
  config: DiggoConfig = DIGGO_CONFIG,
): number {
  assertCrewLevel(foremanLevel, config);
  const reduction = saturating(
    foremanLevel,
    config.crew.foremanDiscountGain,
    config.crew.foremanDiscountScale,
    config,
  );
  return Math.max(config.crew.minimumUpgradeCostMultiplier, 2 - reduction);
}

/**
 * ORE cost of the next level. The Foreman branch discounts the price, which is
 * why the signature accepts an optional foreman level while staying compatible
 * with the original two-argument call.
 */
export function upgradeOreCost(
  component: CrewComponent,
  currentLevel: number,
  foremanLevel: number = DIGGO_CONFIG.crew.minLevel,
  config: DiggoConfig = DIGGO_CONFIG,
): number {
  if (
    !Number.isInteger(currentLevel) ||
    currentLevel < config.crew.minLevel ||
    currentLevel >= config.crew.upgradeCostMaxLevel
  ) {
    throw new Error("Invalid crew level");
  }
  const base = config.crew.upgradeCostBase[component];
  if (typeof base !== "number") throw new Error("Unknown crew component");
  if (config === DIGGO_CONFIG) return onchainUpgradeOreCost(component, currentLevel, foremanLevel);
  const raw = base * Math.pow(currentLevel, config.crew.upgradeCostExponent);
  return Math.floor(raw * upgradeCostMultiplier(foremanLevel, config));
}

/**
 * Total crew levels across the five branches.
 *
 * One implementation, because the number gates two different things: the crew tier here, and
 * discovery eligibility in `shared/discovery.ts` (`DISCOVERY_MIN_TOTAL_CREW_LEVEL`). The two
 * callers hold the levels in the two shapes the protocol produces - the config states them as a
 * record, a decoded `PlayerAccount` as the five-element array - so this reads either rather than
 * letting a second copy of the sum drift.
 */
export function crewTotalLevel(levels: CrewLevels | readonly number[]): number {
  const values = "miners" in levels ? CREW_COMPONENTS.map((component) => levels[component]) : levels;
  return values.reduce((sum, level) => sum + level, 0);
}

export function crewTier(levels: CrewLevels, config: DiggoConfig = DIGGO_CONFIG): CrewTierConfig {
  const totalLevel = crewTotalLevel(levels);
  let current: CrewTierConfig = config.crew.tiers[0];
  for (const tier of config.crew.tiers) {
    if (totalLevel >= tier.minTotalLevel) current = tier;
  }
  return current;
}

// --- effective Mining Power (spec 40, 53, 58, 61, 64) -------------------------------------

/** Device and network cluster sizes one wallet belongs to, read from account_signals (spec 61). */
export interface ClusterSignal {
  walletsOnDevice: number;
  walletsOnNetwork: number;
}

function wholeCount(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return 1;
  return Math.floor(value);
}

function decayFactorBps(count: number, allowance: number, decayBps: number): number {
  const free = Math.max(0, Math.floor(Number.isFinite(allowance) ? allowance : 0));
  const extra = count - free;
  if (extra <= 0) return BPS_DENOMINATOR;
  const decay = Math.min(BPS_DENOMINATOR, Math.max(0, Number.isFinite(decayBps) ? decayBps : 0)) / BPS_DENOMINATOR;
  return BPS_DENOMINATOR * Math.pow(decay, extra);
}

/**
 * How much of its crew's power a wallet actually brings to a block, in bps (spec 61, 64).
 *
 * A wallet on its own device and network is never damped, and wallets sharing a device or a network
 * environment keep a configurable share of the previous factor for every wallet past the allowance.
 * A household, a dorm or an office stays well inside the allowance; a thousand wallets on one
 * device are throttled towards the floor, but never to zero (spec 63: a cluster is throttled, not
 * erased). The floor and both allowances are configurable.
 */
export function clusterDampingBps(
  cluster: Partial<ClusterSignal> = {},
  config: DiggoConfig = DIGGO_CONFIG,
): number {
  const limits = config.effectivePower.cluster;
  const device = decayFactorBps(wholeCount(cluster.walletsOnDevice), limits.deviceAllowance, limits.deviceDecayBps);
  const rawNetwork = decayFactorBps(
    wholeCount(cluster.walletsOnNetwork),
    limits.networkAllowance,
    limits.networkDecayBps,
  );
  const networkFloor = Math.min(BPS_DENOMINATOR, Math.max(1, limits.minimumNetworkFactorBps));
  const network = rawNetwork > networkFloor ? rawNetwork : networkFloor;
  const floor = Math.min(BPS_DENOMINATOR, Math.max(0, limits.minimumFactorBps));
  const combined = (device * network) / BPS_DENOMINATOR;
  return Math.max(floor, Math.min(BPS_DENOMINATOR, Math.round(combined)));
}

/** Account-maturity share of Mining Power, in bps (spec 40, 58). */
export function miningPowerMaturityBps(
  accountAgeSeconds: number,
  config: DiggoConfig = DIGGO_CONFIG,
): number {
  if (!Number.isFinite(accountAgeSeconds) || accountAgeSeconds < 0) return 0;
  return rampBps(config.effectivePower.maturityRamp, accountAgeSeconds / config.time.secondsPerDay);
}

/** Maturity times cluster damping, in bps: the share of raw power a wallet brings to a block. */
export function effectivePowerFactorBps(
  accountAgeSeconds: number,
  cluster: Partial<ClusterSignal> = {},
  config: DiggoConfig = DIGGO_CONFIG,
): number {
  const maturity = miningPowerMaturityBps(accountAgeSeconds, config);
  const damping = clusterDampingBps(cluster, config);
  return Math.max(0, Math.min(BPS_DENOMINATOR, Math.round((maturity * damping) / BPS_DENOMINATOR)));
}

export interface EffectiveMiningPowerInput {
  /** The crew's raw Mining Power (shared/crew.ts crewPower). */
  power: bigint | number;
  accountAgeSeconds: number;
  cluster?: Partial<ClusterSignal>;
  /** Power the mine already carries, which is what the per-account share cap is measured against. */
  mineTotalPower?: bigint | number;
  config?: DiggoConfig;
}

function nonNegativeBig(value: bigint | number | undefined): bigint {
  if (typeof value === "bigint") return value > 0n ? value : 0n;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0n;
  return BigInt(Math.floor(value));
}

/**
 * The power a position is armed with: raw crew power scaled by account maturity and cluster
 * damping, and capped at the configured share of one block (spec 40, 58, 61, 64).
 *
 * A cumulative reward index can only apply these levers where a block share is created, which is
 * the moment a position is armed, so the stored `assigned_power` of a position is its effective
 * power rather than the crew's nominal power. Mining accounting itself is untouched: a throttled
 * account still mines, still accrues and still progresses, it just brings less weight to the block
 * while it is young or sitting inside a farm-sized cluster (spec 53).
 *
 * A crew that is registered always keeps at least one unit of weight, so no configuration can turn
 * mining off, and the share cap never cuts an account below the configured share-cap floor: it
 * exists to stop one account from owning a block in a mine that many players share, not to shrink
 * an ordinary crew in a small or brand-new mine.
 *
 * The share cap is a *cluster* ceiling, measured against the power the mine carries outside the
 * cluster. Two things follow from that, and both are the point:
 *
 *   - It cannot be compounded by splitting. A per-account ceiling taken from the mine's running
 *     total is self-defeating: every wallet a farm adds both raises the total the ceiling is a
 *     fraction of and collects a ceiling of its own, so N wallets on one device were allowed
 *     roughly N times one account's share. Measuring the cluster's allowance against the power
 *     *outside* it, and dividing that allowance over the cluster's wallets, bounds what the cluster
 *     can hold however many wallets it is split into.
 *   - It is inert for a single account. The strongest possible crew (a maxed veteran, bounded by
 *     `crew.maxVeteranPowerRatio`) is below `shareCapFloorPower`, so the ceiling only ever binds on
 *     a cluster - never on one ordinary crew, however strong (spec 63).
 *
 * What divides the allowance is the cluster *past its allowance*: the wallets a device or a network
 * environment shares with this one beyond the configured allowance, which is the same line
 * clusterDampingBps draws between a household and a farm. A cluster inside its allowance - a
 * household, a dorm, an office - is not a farm, so it keeps the whole ceiling and the ceiling is
 * inert for it, exactly as it is for a single account. A farm that shares neither signal is bounded
 * by account maturity instead (docs/ECONOMY_SIM.md, "Splitting and the cluster ceiling").
 */
export function effectiveMiningPower(input: EffectiveMiningPowerInput): bigint {
  const config = input.config ?? DIGGO_CONFIG;
  const raw = nonNegativeBig(input.power);
  if (raw === 0n) return 0n;
  const factor = BigInt(effectivePowerFactorBps(input.accountAgeSeconds, input.cluster ?? {}, config));
  let effective = (raw * factor) / BigInt(BPS_DENOMINATOR);

  const capBps = Math.floor(config.effectivePower.perAccountBlockShareCapBps);
  const mineTotal = nonNegativeBig(input.mineTotalPower);
  if (capBps > 0 && mineTotal > 0n) {
    const device = wholeCount(input.cluster?.walletsOnDevice);
    const network = wholeCount(input.cluster?.walletsOnNetwork);
    const clusterSize = BigInt(Math.max(device, network));
    // The cluster's own weight, estimated at this wallet's size: the mine's total already includes
    // it, so leaving it in would let the cluster inflate the ceiling it is measured against.
    const clusterPower = effective * clusterSize;
    const outside = mineTotal > clusterPower ? mineTotal - clusterPower : 0n;
    const allowance = (outside * BigInt(capBps)) / BigInt(BPS_DENOMINATOR);
    const floorPower = nonNegativeBig(config.effectivePower.shareCapFloorPower);
    const clusterCap = allowance > floorPower ? allowance : floorPower;
    // Only the wallets past an allowance divide the ceiling, so a cluster inside one keeps it whole.
    const limits = config.effectivePower.cluster;
    const excess = Math.max(
      Math.max(0, device - wholeCount(limits.deviceAllowance)),
      Math.max(0, network - wholeCount(limits.networkAllowance)),
    );
    const perAccountCap = excess > 1 ? clusterCap / BigInt(excess) : clusterCap;
    if (effective > perAccountCap) effective = perAccountCap;
  }
  return effective > 0n ? effective : 1n;
}
