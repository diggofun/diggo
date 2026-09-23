/**
 * The on-chain v2 rules as pure functions (WS-G).
 *
 * The harness in engine.ts/model.ts plays the v4 economy: a keeper-attested power number, USD
 * discovery caps, an off-chain risk gate that can hold a claim, and a commit-reveal discovery
 * flow. On-chain v2 removes all four and adds four rules that did not exist before:
 *
 *   1. a flat, refundable 0.07 SOL bond, identical for every wallet, with a seven-day cooldown;
 *   2. starter mode for a wallet with no bond: 25% of the same power and no discovery at all;
 *   3. the starter tranche cap: the unbonded players of a coin may receive at most 10% of any
 *      block's reward, and whatever a block cannot assign stays in the Mining Reserve;
 *   4. discovery caps denominated in lamports of SOL, priced by the coin's own pool TWAP, with one
 *      seed per (coin, epoch) taken from a future slot's SlotHashes entry.
 *
 * This file is those four rules and nothing else. It deliberately does not import shared/config.ts
 * or shared/rewardIndex.ts: WS-A/B/C own those and are rewriting them to the same rules while this
 * runs, so importing them would make the answer depend on which workstream had landed. The chain
 * is pinned by the parity vectors under tests/vectors/, not by this file.
 */
import { createHash } from "node:crypto";

/** Constants from programs/diggo-protocol/src/constants.rs. */
export const BPS = 10_000n;
export const BOND_LAMPORTS = 70_000_000n;
export const BOND_COOLDOWN_SECONDS = 604_800n;
export const STARTER_EFFICIENCY_BPS = 2_500n;
export const STARTER_TRANCHE_BPS = 1_000n;
export const DISCOVERY_DAY_SECONDS = 86_400n;
export const DISCOVERY_WEEK_SECONDS = 604_800n;
export const DEFAULT_DAILY_CAP_LAMPORTS = 1_000_000_000n;
export const DEFAULT_WEEKLY_CAP_LAMPORTS = 4_000_000_000n;
export const DEFAULT_GLOBAL_DAILY_CAP_LAMPORTS = 50_000_000_000n;
export const DEFAULT_EPOCH_BUDGET_LAMPORTS = 2_000_000_000n;

/** One rarity tier: cumulative chance in bps and the value it pays, in lamports. */
export interface Tier {
  cumulativeBps: number;
  valueLamports: bigint;
}

/** The five live tiers of design 4.3, seeded from the product's own table. */
export const DEFAULT_TIERS: readonly Tier[] = [
  { cumulativeBps: 7_000, valueLamports: 100_000n },
  { cumulativeBps: 9_000, valueLamports: 250_000n },
  { cumulativeBps: 9_700, valueLamports: 600_000n },
  { cumulativeBps: 9_950, valueLamports: 1_500_000n },
  { cumulativeBps: 10_000, valueLamports: 3_000_000n },
];

export interface Split {
  starterTake: bigint;
  bondedTake: bigint;
  /** What the block could not assign, which stays in the Mining Reserve. */
  remainder: bigint;
}

/**
 * Splits one block between the two tranches, exactly as the frozen amendment describes it:
 *
 *   starter_take = min(block_reward * STARTER_TRANCHE_BPS / BPS,
 *                      block_reward * starter_power / (starter_power + bonded_power))
 *   bonded_take  = block_reward - starter_take
 *
 * and when a coin has no bonded power at all there is nobody to pay the bonded side to, so the
 * remainder stays in the Mining Reserve: never burned, never handed to the starter index. That is
 * the property the amendment makes non-negotiable, and it is the only branch here.
 */
export function splitBlock(
  blockReward: bigint,
  bondedPower: bigint,
  starterPower: bigint,
  trancheCap: boolean,
): Split {
  const total = bondedPower + starterPower;
  if (total === 0n || blockReward === 0n) {
    return { starterTake: 0n, bondedTake: 0n, remainder: blockReward };
  }
  const proRataStarter = (blockReward * starterPower) / total;
  const cap = trancheCap ? (blockReward * STARTER_TRANCHE_BPS) / BPS : blockReward;
  const starterTake = proRataStarter < cap ? proRataStarter : cap;
  if (bondedPower === 0n) {
    return { starterTake, bondedTake: 0n, remainder: blockReward - starterTake };
  }
  return { starterTake, bondedTake: blockReward - starterTake, remainder: 0n };
}

/** A wallet's mining power: starter mode is a quarter of the same maturity-adjusted value. */
export function effectivePower(
  basePower: bigint,
  bonded: boolean,
  starterEfficiency: boolean,
): bigint {
  if (bonded || !starterEfficiency) return basePower;
  return (basePower * STARTER_EFFICIENCY_BPS) / BPS;
}

/** The maturity ramp of design 5: day 1 20%, day 3 40%, day 7 70%, then 100%. */
export function maturityBps(day: number): bigint {
  if (day < 1) return 2_000n;
  if (day < 3) return 2_000n;
  if (day < 7) return 4_000n;
  return 10_000n;
}

/** Scales a peak power by the maturity ramp of a given day, in bps. */
export function matured(power: bigint, day: number): bigint {
  return (power * maturityBps(day)) / BPS;
}

/**
 * The derivation of design 4.1, byte for byte: every outcome of an epoch is
 * sha256(epoch_seed || owner || window_index), expanded in order. The seed here stands in for the
 * SlotHashes entry of a future slot. What matters for the simulation is that the outcome is a
 * function of the coin, the epoch, the wallet and the window and of nothing else, so sponsorship,
 * a bond or a power number cannot enter it.
 */
export function deriveOutcome(
  epochSeed: Uint8Array,
  owner: Uint8Array,
  windowIndex: number,
): { occurRoll: bigint; rarityRoll: bigint; amountRoll: bigint } {
  const hasher = createHash("sha256");
  hasher.update(epochSeed);
  hasher.update(owner);
  const window = Buffer.alloc(2);
  window.writeUInt16LE(windowIndex & 0xffff, 0);
  hasher.update(window);
  const digest = hasher.digest();
  const read = (offset: number): bigint => {
    let value = 0n;
    for (let index = 7; index >= 0; index -= 1) {
      value = (value << 8n) | BigInt(digest[offset + index]);
    }
    return value;
  };
  return {
    occurRoll: read(0) % 10_000n,
    rarityRoll: read(8) % 10_000n,
    amountRoll: read(16) % 10_000n,
  };
}

/** Which tier a rarity roll lands in, by the cumulative table. */
export function tierFor(roll: bigint, tiers: readonly Tier[]): Tier | null {
  for (const tier of tiers) {
    if (roll < BigInt(tier.cumulativeBps)) return tier;
  }
  return tiers.length > 0 ? tiers[tiers.length - 1] : null;
}

/** A deterministic 32-byte epoch seed for the model, standing in for the recorded slot hash. */
export function epochSeedFor(seed: number, epoch: number): Uint8Array {
  const hasher = createHash("sha256");
  hasher.update("diggo-v2-epoch-seed");
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32LE(seed >>> 0, 0);
  buffer.writeUInt32LE(epoch >>> 0, 4);
  hasher.update(buffer);
  return hasher.digest();
}

/** A deterministic wallet address for the model. */
export function walletFor(seed: number, index: number): Uint8Array {
  const hasher = createHash("sha256");
  hasher.update("diggo-v2-wallet");
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32LE(seed >>> 0, 0);
  buffer.writeUInt32LE(index >>> 0, 4);
  hasher.update(buffer);
  return hasher.digest();
}

/** What the model's discovery ledger tracks, so the caps can be seen binding. */
export interface DiscoveryLedger {
  daySpent: Map<string, bigint>;
  weekSpent: Map<string, bigint>;
  globalSpent: Map<number, bigint>;
  epochSpent: bigint;
  paidLamports: bigint;
  settled: number;
  expired: number;
  refusedByCapLamports: bigint;
}

export function emptyLedger(): DiscoveryLedger {
  return {
    daySpent: new Map(),
    weekSpent: new Map(),
    globalSpent: new Map(),
    epochSpent: 0n,
    paidLamports: 0n,
    settled: 0,
    expired: 0,
    refusedByCapLamports: 0n,
  };
}

export interface CapLimits {
  dailyCapLamports: bigint;
  weeklyCapLamports: bigint;
  globalDailyCapLamports: bigint;
  epochBudgetLamports: bigint;
}

function room(limit: bigint, spent: bigint): bigint {
  return limit > spent ? limit - spent : 0n;
}

/**
 * One settlement attempt against every cap of design 4.3, in integer lamports: the wallet's day
 * and week caps, the coin's per-epoch budget, the protocol-wide daily cap and the coin's own
 * remaining Discovery Reserve. Returns what was paid, which is zero when a cap refused it.
 */
export function settle(
  ledger: DiscoveryLedger,
  limits: CapLimits,
  wallet: string,
  dayIndex: number,
  weekIndex: number,
  lamports: bigint,
  reserveRemaining: bigint,
): bigint {
  if (lamports <= 0n) {
    ledger.expired += 1;
    return 0n;
  }
  const dayKey = wallet + ":" + String(dayIndex);
  const weekKey = wallet + ":" + String(weekIndex);
  const available = [
    room(limits.dailyCapLamports, ledger.daySpent.get(dayKey) ?? 0n),
    room(limits.weeklyCapLamports, ledger.weekSpent.get(weekKey) ?? 0n),
    room(limits.globalDailyCapLamports, ledger.globalSpent.get(dayIndex) ?? 0n),
    room(limits.epochBudgetLamports, ledger.epochSpent),
    reserveRemaining,
  ].reduce((lowest, value) => (value < lowest ? value : lowest));
  const paid = lamports < available ? lamports : available;
  if (paid < lamports) {
    ledger.refusedByCapLamports += lamports - paid;
  }
  if (paid === 0n) {
    return 0n;
  }
  ledger.daySpent.set(dayKey, (ledger.daySpent.get(dayKey) ?? 0n) + paid);
  ledger.weekSpent.set(weekKey, (ledger.weekSpent.get(weekKey) ?? 0n) + paid);
  ledger.globalSpent.set(dayIndex, (ledger.globalSpent.get(dayIndex) ?? 0n) + paid);
  ledger.epochSpent += paid;
  ledger.paidLamports += paid;
  ledger.settled += 1;
  return paid;
}
