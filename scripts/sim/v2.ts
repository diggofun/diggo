/**
 * The v2 scenario runner: what the four new rules do to the farm's share (WS-G).
 *
 * The question this answers is the one design section 9.2 leaves open: with the bond, starter mode,
 * the 10% starter tranche cap and SOL-denominated discovery caps, what does a 10,000-wallet farm
 * actually capture, and what would bonding cost it?
 *
 * Three arms run over the same population and the same block rewards, so the columns compare:
 *
 *   starter-bots  10,000 wallets with no bond: 25% efficiency, no discovery, and the 10% tranche
 *                 cap on every block;
 *   bonded-bots   the same 10,000 wallets bonded: full efficiency and discovery eligibility, at
 *                 0.07 SOL of locked capital each behind a seven-day cooldown;
 *   v4-arm        the same population on the rules v2 replaces: one reward index, no tranche cap,
 *                 no starter mode, no bond. This is the before column.
 *
 * One input is not a contract and is stated as such: how a wallet's power grows over the run. It is
 * a documented rate (powerGrowthBpsPerDay) rather than a re-derivation of the crew curves, because
 * those curves are WS-A's to write and importing them would make this file's answer depend on which
 * workstream had landed. Every rule under test is integer and comes from CONTRACTS.md.
 */
import {
  BOND_LAMPORTS,
  BPS,
  DEFAULT_DAILY_CAP_LAMPORTS,
  DEFAULT_EPOCH_BUDGET_LAMPORTS,
  DEFAULT_GLOBAL_DAILY_CAP_LAMPORTS,
  DEFAULT_TIERS,
  DEFAULT_WEEKLY_CAP_LAMPORTS,
  deriveOutcome,
  effectivePower,
  emptyLedger,
  epochSeedFor,
  matured,
  settle,
  splitBlock,
  tierFor,
  walletFor,
  type Tier,
} from "./v2rules";

export interface V2Options {
  seed: number;
  blocks: number;
  blockIntervalSeconds: number;
  blockReward: bigint;
  bots: number;
  humans: number;
  humanPower: bigint;
  botPower: bigint;
  humanPowerGrowthBpsPerDay: number;
  botPowerGrowthBpsPerDay: number;
  epochBlocks: number;
  rollsPerWalletPerEpoch: number;
  priceLamportsPerToken: bigint;
  discoveryReserveLamports: bigint;
  dailyCapLamports: bigint;
  weeklyCapLamports: bigint;
  globalDailyCapLamports: bigint;
  epochBudgetLamports: bigint;
  tiers: readonly Tier[];
  /**
   * How selective a farm is at settlement. The seed is public before settlement (design 4.2), so a
   * farm settles only the wallets whose derived outcome clears this many bps of the value
   * distribution; an honest player settles every roll it made. The caps bound the uplift.
   */
  farmSelectionBps: number;
}

export const DEFAULT_V2_OPTIONS: V2Options = {
  seed: 20_260_923,
  blocks: 2_880,
  blockIntervalSeconds: 300,
  blockReward: 7_500n,
  bots: 10_000,
  humans: 5_000,
  humanPower: 1_400n,
  botPower: 900n,
  humanPowerGrowthBpsPerDay: 600,
  botPowerGrowthBpsPerDay: 200,
  epochBlocks: 288 * 7,
  rollsPerWalletPerEpoch: 1,
  priceLamportsPerToken: 4_000n,
  discoveryReserveLamports: 500_000_000n,
  dailyCapLamports: DEFAULT_DAILY_CAP_LAMPORTS,
  weeklyCapLamports: DEFAULT_WEEKLY_CAP_LAMPORTS,
  globalDailyCapLamports: DEFAULT_GLOBAL_DAILY_CAP_LAMPORTS,
  epochBudgetLamports: DEFAULT_EPOCH_BUDGET_LAMPORTS,
  tiers: DEFAULT_TIERS,
  farmSelectionBps: 3_000,
};

export type ArmKey = "starter-bots" | "bonded-bots" | "v4-arm";

export interface ArmResult {
  key: ArmKey;
  title: string;
  botTokens: bigint;
  humanTokens: bigint;
  botShareBps: number;
  reserveRemainderTokens: bigint;
  peakStarterBlockShareBps: number;
  botBondLamports: bigint;
  botDiscoveryLamports: bigint;
  humanDiscoveryLamports: bigint;
  botDiscoveryTokens: bigint;
  humanDiscoveryTokens: bigint;
  refusedByCapLamports: bigint;
  settled: number;
  expired: number;
  capitalPerShareBps: bigint;
}

interface Wallet {
  key: string;
  owner: Uint8Array;
  bonded: boolean;
  peakPower: bigint;
  growthBpsPerDay: number;
  cohort: "bot" | "human";
}

function walletsFor(options: V2Options, botsBonded: boolean, v4: boolean): Wallet[] {
  const wallets: Wallet[] = [];
  for (let index = 0; index < options.bots; index += 1) {
    wallets.push({
      key: "bot-" + String(index),
      owner: walletFor(options.seed, index),
      bonded: v4 ? true : botsBonded,
      peakPower: options.botPower,
      growthBpsPerDay: options.botPowerGrowthBpsPerDay,
      cohort: "bot",
    });
  }
  for (let index = 0; index < options.humans; index += 1) {
    wallets.push({
      key: "human-" + String(index),
      owner: walletFor(options.seed + 1, index),
      bonded: true,
      peakPower: options.humanPower,
      growthBpsPerDay: options.humanPowerGrowthBpsPerDay,
      cohort: "human",
    });
  }
  return wallets;
}

/** A wallet's power on a given day: the maturity ramp, then the crew growth rate. */
function powerOn(wallet: Wallet, day: number): bigint {
  const growthBps =
    BPS + (BigInt(Math.max(0, wallet.growthBpsPerDay)) * BigInt(day - 1) * BPS) / BPS;
  return (matured(wallet.peakPower, day) * growthBps) / BPS;
}

export interface ArmConfig {
  /** The farm's wallets accrue in the bonded tranche: full efficiency, discovery eligible. */
  botsBonded: boolean;
  /** Apply the 10% starter tranche cap. */
  trancheCap: boolean;
  /** Apply starter mode's 25% efficiency to unbonded power. Off reproduces the v4 economy. */
  starterEfficiency: boolean;
  /** Discovery requires a bond. The v4 economy had no bond at all, so its arm does not. */
  discoveryRequiresBond: boolean;
  v4: boolean;
}

/**
 * Runs one arm. Every block splits its reward by the frozen rule; every epoch, each eligible wallet
 * makes its rolls, and each outcome is derived from the recorded seed, priced by the coin's own TWAP
 * and charged against all four caps.
 */
export function runArm(
  key: ArmKey,
  title: string,
  options: V2Options,
  arm: ArmConfig,
): ArmResult {
  const wallets = walletsFor(options, arm.botsBonded, arm.v4);
  const blocksPerDay = Math.max(1, Math.round(86_400 / options.blockIntervalSeconds));
  const ledger = emptyLedger();
  let botTokens = 0n;
  let humanTokens = 0n;
  let remainder = 0n;
  let peakStarterShareBps = 0;
  let discoveryRemaining = options.discoveryReserveLamports;
  let botDiscoveryLamports = 0n;
  let humanDiscoveryLamports = 0n;

  for (let block = 0; block < options.blocks; block += 1) {
    const day = Math.floor(block / blocksPerDay) + 1;
    let bondedPower = 0n;
    let starterPower = 0n;
    let botBondedPower = 0n;
    let botStarterPower = 0n;
    for (const wallet of wallets) {
      const power = effectivePower(powerOn(wallet, day), wallet.bonded, arm.starterEfficiency);
      if (wallet.bonded) {
        bondedPower += power;
        if (wallet.cohort === "bot") botBondedPower += power;
      } else {
        starterPower += power;
        if (wallet.cohort === "bot") botStarterPower += power;
      }
    }
    const split = splitBlock(
      options.blockReward,
      bondedPower,
      starterPower,
      arm.trancheCap,
    );
    remainder += split.remainder;
    const blockTotal = split.starterTake + split.bondedTake;
    if (blockTotal > 0n) {
      const share = Number((split.starterTake * 10_000n) / blockTotal);
      if (share > peakStarterShareBps) peakStarterShareBps = share;
    }
    if (split.starterTake > 0n && starterPower > 0n) {
      botTokens += (split.starterTake * botStarterPower) / starterPower;
    }
    if (split.bondedTake > 0n && bondedPower > 0n) {
      botTokens += (split.bondedTake * botBondedPower) / bondedPower;
      humanTokens += (split.bondedTake * (bondedPower - botBondedPower)) / bondedPower;
    }

    // Discovery is per epoch, and only for a bonded wallet: starter mode is not eligible at all.
    if ((block + 1) % options.epochBlocks === 0) {
      const epoch = Math.floor((block + 1) / options.epochBlocks);
      const epochSeed = epochSeedFor(options.seed, epoch);
      const weekIndex = Math.floor((block + 1) / (blocksPerDay * 7)) + 1;
      for (const wallet of wallets) {
        if (arm.discoveryRequiresBond && !wallet.bonded) continue;
        for (let roll = 0; roll < options.rollsPerWalletPerEpoch; roll += 1) {
          const window = ((epoch - 1) * options.rollsPerWalletPerEpoch + roll) & 0xffff;
          const outcome = deriveOutcome(epochSeed, wallet.owner, window);
          if (outcome.occurRoll >= 7_000n) {
            ledger.expired += 1;
            continue;
          }
          const tier = tierFor(outcome.rarityRoll, options.tiers);
          if (!tier) continue;
          const selective = BigInt(10_000 - options.farmSelectionBps);
          if (wallet.cohort === "bot" && outcome.amountRoll < selective) continue;
          const paid = settle(
            ledger,
            {
              dailyCapLamports: options.dailyCapLamports,
              weeklyCapLamports: options.weeklyCapLamports,
              globalDailyCapLamports: options.globalDailyCapLamports,
              epochBudgetLamports: options.epochBudgetLamports,
            },
            wallet.key,
            day,
            weekIndex,
            tier.valueLamports,
            discoveryRemaining,
          );
          if (paid > 0n) {
            discoveryRemaining -= paid;
            if (wallet.cohort === "bot") botDiscoveryLamports += paid;
            else humanDiscoveryLamports += paid;
          }
        }
      }
    }
  }

  const total = botTokens + humanTokens;
  const botShareBps = total > 0n ? Number((botTokens * 10_000n) / total) : 0;
  const botBondLamports = arm.v4
    ? 0n
    : arm.botsBonded
      ? BOND_LAMPORTS * BigInt(options.bots)
      : 0n;
  const toTokens = (lamports: bigint): bigint =>
    options.priceLamportsPerToken > 0n ? lamports / options.priceLamportsPerToken : 0n;
  return {
    key,
    title,
    botTokens,
    humanTokens,
    botShareBps,
    reserveRemainderTokens: remainder,
    peakStarterBlockShareBps: peakStarterShareBps,
    botBondLamports,
    botDiscoveryLamports,
    humanDiscoveryLamports,
    botDiscoveryTokens: toTokens(botDiscoveryLamports),
    humanDiscoveryTokens: toTokens(humanDiscoveryLamports),
    refusedByCapLamports: ledger.refusedByCapLamports,
    settled: ledger.settled,
    expired: ledger.expired,
    capitalPerShareBps: botShareBps > 0 ? botBondLamports / BigInt(botShareBps) : 0n,
  };
}

export interface V2Result {
  options: V2Options;
  arms: readonly ArmResult[];
}

/** The three arms of the report. */
export function runV2(options: V2Options = DEFAULT_V2_OPTIONS): V2Result {
  return {
    options,
    arms: [
      runArm("starter-bots", "10k starter-mode wallets vs bonded humans", options, {
        botsBonded: false,
        trancheCap: true,
        starterEfficiency: true,
        discoveryRequiresBond: true,
        v4: false,
      }),
      runArm("bonded-bots", "the same 10k wallets, bonded", options, {
        botsBonded: true,
        trancheCap: true,
        starterEfficiency: true,
        discoveryRequiresBond: true,
        v4: false,
      }),
      // The before column: one index, no cap, no starter mode and no bond. A farm's wallets mine at
      // full efficiency and are discovery eligible, which is exactly what v2 stops.
      runArm("v4-arm", "the same population on the rules v2 replaces", options, {
        botsBonded: false,
        trancheCap: false,
        starterEfficiency: false,
        discoveryRequiresBond: false,
        v4: true,
      }),
    ],
  };
}
