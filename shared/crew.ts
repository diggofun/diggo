import {
  BPS_DENOMINATOR,
  DIGGO_CONFIG,
  type CrewLevels,
  type CrewTierConfig,
  type CrewComponent,
  type DiggoConfig,
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
  const raw = base * Math.pow(currentLevel, config.crew.upgradeCostExponent);
  return Math.floor(raw * upgradeCostMultiplier(foremanLevel, config));
}

export function crewTotalLevel(levels: CrewLevels): number {
  return CREW_COMPONENTS.reduce((sum, component) => sum + levels[component], 0);
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
