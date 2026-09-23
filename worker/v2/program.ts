/**
 * The indexer's view of the v2 program: one seam, no second decode layer.
 *
 * WS-D owns `shared/program.ts` and `shared/pdas.ts`, which are the single transcription of the
 * frozen contract - every account layout, discriminator table, PDA seed list, instruction builder,
 * error catalogue and event name. This module re-exports all of it, so a worker file imports the v2
 * program from one path and cannot decode a byte differently from the client. The duplicated copy
 * that stood here while WS-D's decoders were still landing is gone.
 *
 * What is left is only what `shared/program.ts` does not publish: the Anchor event *payload*
 * reader, the trade-instruction reader the indexer needs because v2 emits no trade event, and a few
 * byte and display helpers. Nothing in this file is authoritative for anything, nothing here talks
 * to RPC, and nothing here can move a lamport.
 */
export * from "../../shared/program";

import { sha256 } from "@noble/hashes/sha2.js";
import bs58 from "bs58";
import {
  ACCOUNT_DISCRIMINATORS,
  EVENT_DISCRIMINATORS,
  INSTRUCTION_DISCRIMINATORS,
  type CoinStatusName,
  type DecodedCoin,
  type DiggoAccountName,
} from "../../shared/program";

export const LAMPORTS_PER_SOL = 1_000_000_000;

// --- the names the worker has always used, aliased to the one table -------------------------

/**
 * The shared discriminator tables as lowercase hex.
 *
 * The tables themselves live in `shared/program.ts` and hold bytes; a log line, an
 * `getProgramAccounts` filter and every caller here compare hex, so the hex view is derived from
 * the one source rather than restated as a second literal table.
 */
function hexTable<T extends string>(table: Record<T, Uint8Array>): Record<T, string> {
  const out = {} as Record<T, string>;
  for (const [name, bytes] of Object.entries(table) as [T, Uint8Array][]) {
    out[name] = bytesToHex(bytes);
  }
  return out;
}

export const ACCOUNT_DISCRIMINATOR = hexTable(ACCOUNT_DISCRIMINATORS);
export const EVENT_DISCRIMINATOR = hexTable(EVENT_DISCRIMINATORS);
export const INSTRUCTION_DISCRIMINATOR = hexTable(INSTRUCTION_DISCRIMINATORS);

export type V2AccountName = DiggoAccountName;

/**
 * The status code the read model stores for a coin.
 *
 * The shared decoder publishes the client-facing names (Launching, MiningActive, FullyMined) and
 * the raw byte beside them. D1's status column is read by src/mineView.ts, which switches on the
 * upper-snake codes, so the indexer translates rather than storing a name the UI does not know.
 */
export function coinStatusWireCode(
  status: CoinStatusName,
): "LAUNCHING" | "MINING_ACTIVE" | "FULLY_MINED" {
  if (status === "FullyMined") return "FULLY_MINED";
  if (status === "MiningActive") return "MINING_ACTIVE";
  return "LAUNCHING";
}

/** The account name a body belongs to, or null when the discriminator is not a v2 account. */
export function accountNameOf(data: Uint8Array): V2AccountName | null {
  if (data.length < 8) return null;
  const hex = bytesToHex(data.subarray(0, 8));
  for (const [name, discriminator] of Object.entries(ACCOUNT_DISCRIMINATOR)) {
    if (discriminator === hex) return name as V2AccountName;
  }
  return null;
}

// --- byte and display helpers ---------------------------------------------------------------

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Base64 to bytes, without Buffer (the Worker is not a Node runtime). */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** An all-zero pubkey, which is what an absent optional account reads as. */
export const DEFAULT_PUBKEY = bs58.encode(new Uint8Array(32));

export function isDefaultPubkey(value: string): boolean {
  return value === DEFAULT_PUBKEY;
}

/** Recomputed with the same rule `shared/program.ts` builds its tables from. */
export function anchorDiscriminator(preimage: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(preimage)).subarray(0, 8));
}

/** Reads borsh and little-endian integers out of an event body. */
export class BorshReader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}

  get position(): number {
    return this.offset;
  }

  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  private take(length: number): Uint8Array {
    if (this.offset + length > this.bytes.length) {
      throw new Error(
        `borsh read of ${length} bytes past end of buffer (${this.bytes.length} bytes, offset ${this.offset})`,
      );
    }
    const slice = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  u8(): number {
    return this.take(1)[0]!;
  }

  u16(): number {
    const bytes = this.take(2);
    return bytes[0]! | (bytes[1]! << 8);
  }

  u32(): number {
    const bytes = this.take(4);
    return (bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16)) + bytes[3]! * 0x1_000000;
  }

  u64(): bigint {
    return readUnsigned(this.take(8));
  }

  u128(): bigint {
    return readUnsigned(this.take(16));
  }

  i64(): bigint {
    const unsigned = readUnsigned(this.take(8));
    return unsigned >= 1n << 63n ? unsigned - (1n << 64n) : unsigned;
  }

  bytes32(): Uint8Array {
    return Uint8Array.from(this.take(32));
  }

  pubkey(): string {
    return bs58.encode(this.bytes32());
  }
}

function readUnsigned(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i]!);
  return value;
}

/** Lamports to SOL. Display only: every stored amount stays in lamports. */
export function lamportsToSol(lamports: bigint | number): number {
  return Number(lamports) / LAMPORTS_PER_SOL;
}

/** Base units to whole tokens, at the mint's own decimals. */
export function baseUnitsToWhole(amount: bigint | number, decimals: number): number {
  return Number(amount) / 10 ** decimals;
}

/**
 * The vault ledger invariant of design 1.3(a), recomputed off-chain: the vault must hold at
 * least everything the coin's ledgers still owe. The indexer only ever *checks* this - it
 * cannot move a lamport or a token - and a violation is surfaced as an advisory alert.
 */
export function coinLedgerInvariant(
  coin: DecodedCoin,
  vaultAmount: bigint,
): { ok: boolean; shortfall: bigint } {
  const owed =
    coin.tokenReserve + coin.reserveRemaining + coin.discoveryRemaining + coin.outstandingClaims;
  return { ok: vaultAmount >= owed, shortfall: vaultAmount >= owed ? 0n : owed - vaultAmount };
}

// --- the trade instructions, which is how a v2 fill is seen at all --------------------------
//
// The v2 event set deliberately carries no trade event, so the only way to see a fill is to read
// the instruction that caused it. If INTEGRATION-1 ever adds one, the indexer prefers it and this
// reader becomes the fallback: `recordTrades` in worker/indexing.ts takes the event path first.

export type TradeInstructionKind = "buy" | "sell" | "pool_buy" | "pool_sell";

const TRADE_INSTRUCTION_KINDS = new Map<string, TradeInstructionKind>([
  [INSTRUCTION_DISCRIMINATOR.buy, "buy"],
  [INSTRUCTION_DISCRIMINATOR.sell, "sell"],
  [INSTRUCTION_DISCRIMINATOR.pool_buy, "pool_buy"],
  [INSTRUCTION_DISCRIMINATOR.pool_sell, "pool_sell"],
]);

/**
 * Decodes one of the four trade instructions: `(amount_in: u64, min_out: u64)`.
 *
 * `amountIn` is lamports for the two buys and base units for the two sells, exactly as the
 * instruction declares it. It is what the trader offered, not what they received: the received
 * amount is only knowable from the token balance deltas of the transaction, so the indexer
 * records the input and the venue's observed spot price side by side rather than pretending the
 * spot price was the fill.
 */
export function decodeTradeInstruction(
  data: Uint8Array,
): { kind: TradeInstructionKind; amountIn: bigint; minOut: bigint } | null {
  if (data.length < 8) return null;
  const kind = TRADE_INSTRUCTION_KINDS.get(bytesToHex(data.subarray(0, 8)));
  if (!kind) return null;
  const reader = new BorshReader(data.subarray(8));
  try {
    return { kind, amountIn: reader.u64(), minOut: reader.u64() };
  } catch {
    return null;
  }
}

// --- events -------------------------------------------------------------------------------

/**
 * The v2 event set, decoded. Each variant carries the payload `events.rs` declares.
 *
 * This is the one thing `shared/program.ts` does not publish: it names an event from its
 * discriminator (`diggoEventNameFromData`) but does not read the body, and the indexer needs the
 * fields. Reported in docs/API.md as the gap it is.
 */
export type DecodedDiggoEvent =
  | { name: "ProtocolInitialized"; authority: string; treasury: string; crankPool: string; version: number }
  | { name: "CoinLaunched"; coin: string; mint: string; creator: string; sponsorEvent: string }
  | { name: "EpochAdvanced"; coin: string; epochIndex: number; epochEndsAt: bigint; epochEndsSlot: bigint }
  | { name: "EpochSeedTargetArmed"; coin: string; epochIndex: number; targetSlot: bigint }
  | {
      name: "EpochSeedCommitted";
      coin: string;
      epochIndex: number;
      targetSlot: bigint;
      recordedSlot: bigint;
      seed: Uint8Array;
    }
  | { name: "EpochSeedRearmed"; coin: string; epochIndex: number; targetSlot: bigint }
  | { name: "PlayerInitialized"; player: string; owner: string; sponsorEvent: string }
  | { name: "Activated"; player: string; activeUntil: bigint; streak: number; validActivations: number }
  | { name: "OreCollected"; player: string; amount: bigint; balance: bigint; overflow: bigint }
  | {
      name: "ReferralOreCredited";
      referrer: string;
      referee: string;
      amount: bigint;
      balance: bigint;
      weekIndex: bigint;
    }
  | { name: "CrewUpgraded"; player: string; component: number; level: number; oreSpent: bigint }
  | { name: "BondPosted"; player: string; lamports: bigint; source: number; sponsorVault: string }
  | { name: "UnbondRequested"; player: string; unbondAvailableAt: bigint }
  | { name: "BondWithdrawn"; player: string; lamports: bigint; recipient: string }
  | { name: "PowerAssigned"; coin: string; owner: string; power: bigint; tranche: number }
  | { name: "PowerRemoved"; coin: string; owner: string; pendingReward: bigint }
  | { name: "MineSwitched"; owner: string; fromCoin: string; toCoin: string }
  | { name: "RewardsClaimed"; coin: string; owner: string; amount: bigint }
  | {
      name: "DiscoveryRollCreated";
      opportunity: string;
      coin: string;
      owner: string;
      windowIndex: number;
      dayIndex: number;
    }
  | {
      name: "DiscoverySettled";
      opportunity: string;
      coin: string;
      owner: string;
      rarity: number;
      units: bigint;
      valueLamports: bigint;
    }
  | { name: "DiscoveryExpired"; opportunity: string; coin: string; owner: string }
  | { name: "MarketGraduated"; coin: string; pool: string; tokenReserve: bigint; solReserve: bigint }
  | { name: "FeesSwept"; coin: string; treasuryLamports: bigint; creatorLamports: bigint; crankPoolLamports: bigint }
  | { name: "CrankTipPaid"; coin: string; payer: string; lamports: bigint }
  | { name: "SponsorVaultInitialized"; vault: string; sponsorOwner: string }
  | {
      name: "SponsorEventCreated";
      event: string;
      vault: string;
      kind: number;
      startAt: bigint;
      endAt: bigint;
      budgetLamports: bigint;
      perCoinLimitLamports: bigint;
      perWalletLimitLamports: bigint;
    }
  | { name: "SponsorSpend"; grant: string; kind: number; lamports: bigint };

type EventReader = (r: BorshReader) => DecodedDiggoEvent;

/**
 * One payload reader per v2 event, keyed by the name CONTRACTS.md uses.
 *
 * The keys are the v2 event set as this reader knows it, and program.test.ts pins that set against
 * shared/program.ts's own table, so an event added to the contract fails the worker's test until a
 * reader is added here rather than silently decoding to null.
 */
const EVENT_READERS = {
  ProtocolInitialized: (r) => ({
    name: "ProtocolInitialized",
    authority: r.pubkey(),
    treasury: r.pubkey(),
    crankPool: r.pubkey(),
    version: r.u8(),
  }),
  CoinLaunched: (r) => ({
    name: "CoinLaunched",
    coin: r.pubkey(),
    mint: r.pubkey(),
    creator: r.pubkey(),
    sponsorEvent: r.pubkey(),
  }),
  EpochAdvanced: (r) => ({
    name: "EpochAdvanced",
    coin: r.pubkey(),
    epochIndex: r.u32(),
    epochEndsAt: r.i64(),
    epochEndsSlot: r.u64(),
  }),
  EpochSeedTargetArmed: (r) => ({
    name: "EpochSeedTargetArmed",
    coin: r.pubkey(),
    epochIndex: r.u32(),
    targetSlot: r.u64(),
  }),
  EpochSeedCommitted: (r) => ({
    name: "EpochSeedCommitted",
    coin: r.pubkey(),
    epochIndex: r.u32(),
    targetSlot: r.u64(),
    recordedSlot: r.u64(),
    seed: r.bytes32(),
  }),
  EpochSeedRearmed: (r) => ({
    name: "EpochSeedRearmed",
    coin: r.pubkey(),
    epochIndex: r.u32(),
    targetSlot: r.u64(),
  }),
  PlayerInitialized: (r) => ({
    name: "PlayerInitialized",
    player: r.pubkey(),
    owner: r.pubkey(),
    sponsorEvent: r.pubkey(),
  }),
  Activated: (r) => ({
    name: "Activated",
    player: r.pubkey(),
    activeUntil: r.i64(),
    streak: r.u16(),
    validActivations: r.u16(),
  }),
  OreCollected: (r) => ({
    name: "OreCollected",
    player: r.pubkey(),
    amount: r.u64(),
    balance: r.u64(),
    overflow: r.u64(),
  }),
  ReferralOreCredited: (r) => ({
    name: "ReferralOreCredited",
    referrer: r.pubkey(),
    referee: r.pubkey(),
    amount: r.u64(),
    balance: r.u64(),
    weekIndex: r.i64(),
  }),
  CrewUpgraded: (r) => ({
    name: "CrewUpgraded",
    player: r.pubkey(),
    component: r.u8(),
    level: r.u16(),
    oreSpent: r.u64(),
  }),
  BondPosted: (r) => ({
    name: "BondPosted",
    player: r.pubkey(),
    lamports: r.u64(),
    source: r.u8(),
    sponsorVault: r.pubkey(),
  }),
  UnbondRequested: (r) => ({
    name: "UnbondRequested",
    player: r.pubkey(),
    unbondAvailableAt: r.i64(),
  }),
  BondWithdrawn: (r) => ({
    name: "BondWithdrawn",
    player: r.pubkey(),
    lamports: r.u64(),
    recipient: r.pubkey(),
  }),
  PowerAssigned: (r) => ({
    name: "PowerAssigned",
    coin: r.pubkey(),
    owner: r.pubkey(),
    power: r.u64(),
    tranche: r.u8(),
  }),
  PowerRemoved: (r) => ({
    name: "PowerRemoved",
    coin: r.pubkey(),
    owner: r.pubkey(),
    pendingReward: r.u64(),
  }),
  MineSwitched: (r) => ({
    name: "MineSwitched",
    owner: r.pubkey(),
    fromCoin: r.pubkey(),
    toCoin: r.pubkey(),
  }),
  RewardsClaimed: (r) => ({
    name: "RewardsClaimed",
    coin: r.pubkey(),
    owner: r.pubkey(),
    amount: r.u64(),
  }),
  DiscoveryRollCreated: (r) => ({
    name: "DiscoveryRollCreated",
    opportunity: r.pubkey(),
    coin: r.pubkey(),
    owner: r.pubkey(),
    windowIndex: r.u16(),
    dayIndex: r.u16(),
  }),
  DiscoverySettled: (r) => ({
    name: "DiscoverySettled",
    opportunity: r.pubkey(),
    coin: r.pubkey(),
    owner: r.pubkey(),
    rarity: r.u8(),
    units: r.u64(),
    valueLamports: r.u64(),
  }),
  DiscoveryExpired: (r) => ({
    name: "DiscoveryExpired",
    opportunity: r.pubkey(),
    coin: r.pubkey(),
    owner: r.pubkey(),
  }),
  MarketGraduated: (r) => ({
    name: "MarketGraduated",
    coin: r.pubkey(),
    pool: r.pubkey(),
    tokenReserve: r.u64(),
    solReserve: r.u64(),
  }),
  FeesSwept: (r) => ({
    name: "FeesSwept",
    coin: r.pubkey(),
    treasuryLamports: r.u64(),
    creatorLamports: r.u64(),
    crankPoolLamports: r.u64(),
  }),
  CrankTipPaid: (r) => ({ name: "CrankTipPaid", coin: r.pubkey(), payer: r.pubkey(), lamports: r.u64() }),
  SponsorVaultInitialized: (r) => ({
    name: "SponsorVaultInitialized",
    vault: r.pubkey(),
    sponsorOwner: r.pubkey(),
  }),
  SponsorEventCreated: (r) => ({
    name: "SponsorEventCreated",
    event: r.pubkey(),
    vault: r.pubkey(),
    kind: r.u8(),
    startAt: r.i64(),
    endAt: r.i64(),
    budgetLamports: r.u64(),
    perCoinLimitLamports: r.u64(),
    perWalletLimitLamports: r.u64(),
  }),
  SponsorSpend: (r) => ({ name: "SponsorSpend", grant: r.pubkey(), kind: r.u8(), lamports: r.u64() }),
} satisfies Record<string, EventReader>;

export type V2EventName = keyof typeof EVENT_READERS;

/** The 26 v2 events, in the order CONTRACTS.md lists them. */
export const V2_EVENT_NAMES = Object.keys(EVENT_READERS) as V2EventName[];

const EVENT_READER_BY_DISCRIMINATOR = new Map<string, EventReader>(
  (V2_EVENT_NAMES as V2EventName[]).map((name) => [EVENT_DISCRIMINATOR[name], EVENT_READERS[name]]),
);

/** Decodes one Anchor event body, discriminator included, or null when it is not a v2 event. */
export function decodeEventData(data: Uint8Array): DecodedDiggoEvent | null {
  if (data.length < 8) return null;
  const reader = EVENT_READER_BY_DISCRIMINATOR.get(bytesToHex(data.subarray(0, 8)));
  if (!reader) return null;
  return reader(new BorshReader(data.subarray(8)));
}

/**
 * Every v2 event in a transaction's log messages.
 *
 * Anchor prints each event as a `Program data: <base64>` line. Anything else in the log is
 * ignored, and an unreadable line is skipped rather than throwing: a log the indexer cannot
 * parse must not stop it from indexing the lines it can.
 */
export function decodeProgramEvents(logs: readonly string[]): DecodedDiggoEvent[] {
  const events: DecodedDiggoEvent[] = [];
  for (const line of logs) {
    const prefix = "Program data: ";
    if (!line.startsWith(prefix)) continue;
    try {
      const event = decodeEventData(base64ToBytes(line.slice(prefix.length).trim()));
      if (event) events.push(event);
    } catch {
      // A truncated or non-diggo `Program data` line: not ours to index.
    }
  }
  return events;
}
