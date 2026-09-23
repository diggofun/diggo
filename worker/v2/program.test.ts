/**
 * The decode layer's own tests.
 *
 * Two things are pinned here that nothing else can pin. First, the discriminator table: the
 * literals in `program.ts` are written out rather than computed, so this file recomputes every
 * one of them from the Anchor rule and fails if a literal is wrong. Second, the field order and
 * therefore the size of every v2 account: the fixtures below are built field by field from
 * `CONTRACTS.md`, and each one asserts the total length the contract states. A field inserted in
 * the wrong place moves that number.
 */
import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import bs58 from "bs58";
import { address } from "@solana/kit";
import {
  ACCOUNT_DISCRIMINATOR,
  BPS,
  DIGGO_EVENT_NAMES,
  EVENT_DISCRIMINATOR,
  INSTRUCTION_DISCRIMINATOR,
  V2_EVENT_NAMES,
  V4_LEGACY_EVENT_NAMES,
  accountNameOf,
  anchorDiscriminator,
  bytesToHex,
  coinLedgerInvariant,
  decodeCoin,
  decodeDiscoveryOpportunity,
  decodeEventData,
  decodeMiningPosition,
  decodePlayerAccount,
  decodeProgramEvents,
  decodeTradeInstruction,
  deriveCoinPda,
  derivePlayerPda,
  derivePositionPda,
  hexToBytes,
  lamportsToSol,
  opportunityStatusName,
} from "./program";
import { blockSplit, curveSpotPriceLamports, poolSpotPriceLamports, spotPriceLamports } from "./market";

// --- a minimal borsh writer, so fixtures are built the way the program writes them -------------

class Writer {
  private readonly bytes: number[] = [];
  u8(value: number): this {
    this.bytes.push(value & 0xff);
    return this;
  }
  u16(value: number): this {
    return this.u8(value).u8(value >> 8);
  }
  u32(value: number): this {
    return this.u8(value).u8(value >> 8).u8(value >> 16).u8(value >>> 24);
  }
  u64(value: bigint): this {
    let rest = value;
    for (let i = 0; i < 8; i++) {
      this.u8(Number(rest & 0xffn));
      rest >>= 8n;
    }
    return this;
  }
  u128(value: bigint): this {
    let rest = value;
    for (let i = 0; i < 16; i++) {
      this.u8(Number(rest & 0xffn));
      rest >>= 8n;
    }
    return this;
  }
  i64(value: bigint): this {
    return this.u64(value < 0n ? value + (1n << 64n) : value);
  }
  pubkey(value: string): this {
    for (const byte of bs58.decode(value)) this.u8(byte);
    return this;
  }
  raw(value: Uint8Array): this {
    for (const byte of value) this.u8(byte);
    return this;
  }
  done(discriminator: string): Uint8Array {
    return Uint8Array.from([...hexToBytes(discriminator), ...this.bytes]);
  }
  get length(): number {
    return this.bytes.length;
  }
}

/** A deterministic but non-trivial base58 pubkey, so a mix-up between fields is visible. */
function pubkey(seed: number): string {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = (seed * 31 + i * 7) % 256;
  return bs58.encode(bytes);
}

const CREATOR = pubkey(1);
const VAULT = pubkey(2);
const MINT = pubkey(3);
const OWNER = pubkey(4);
const COIN = pubkey(5);
const PROGRAM = "H3Y8GgTnvwv5U1bajfzj386YSPC48vvwjFroXYyHZFj5";

// --- discriminators ---------------------------------------------------------------------------

describe("discriminator tables", () => {
  it("recomputes every account discriminator from the Anchor rule", () => {
    for (const [name, literal] of Object.entries(ACCOUNT_DISCRIMINATOR)) {
      expect(anchorDiscriminator(`account:${name}`), name).toBe(literal);
      expect(bytesToHex(sha256(new TextEncoder().encode(`account:${name}`)).subarray(0, 8))).toBe(literal);
    }
  });

  it("recomputes every event discriminator", () => {
    for (const [name, literal] of Object.entries(EVENT_DISCRIMINATOR)) {
      expect(anchorDiscriminator(`event:${name}`), name).toBe(literal);
    }
  });

  it("recomputes every instruction discriminator", () => {
    for (const [name, literal] of Object.entries(INSTRUCTION_DISCRIMINATOR)) {
      expect(anchorDiscriminator(`global:${name}`), name).toBe(literal);
    }
  });

  it("names an account by its discriminator and rejects anything else", () => {
    expect(accountNameOf(hexToBytes(ACCOUNT_DISCRIMINATOR.Coin))).toBe("Coin");
    expect(accountNameOf(hexToBytes("00112233445566ff"))).toBeNull();
    expect(accountNameOf(new Uint8Array(3))).toBeNull();
  });
});

// --- Coin -------------------------------------------------------------------------------------

function coinFixture() {
  const w = new Writer();
  w.pubkey(CREATOR).pubkey(VAULT);
  for (const value of [1_000_000n, 500n, 40n, 7n, 60n, 900n, 800n, 100n]) w.u64(value);
  w.u128(123_456_789n).u128(30_864_197n);
  w.u64(250n).u32(300).i64(1_700_000_000n);
  w.u32(9).u32(604_800).i64(1_700_600_000n).u64(1_234_567n);
  w.u16(2_500).u64(10n);
  for (const value of [400_000n, 12_000_000n, 3_000_000n, 50_000_000n, 11n, 13n]) w.u64(value);
  w.u16(50).u16(50);
  for (const value of [300_000n, 120_000n, 5_000n, 25n]) w.u64(value);
  w.u8(1).u8(0).i64(0n);
  for (const value of [50_000n, 4_000n, 250n]) w.u64(value);
  w.u32(9).u8(0);
  w.u128(987_654_321n).u64(1_234_000n).u128(1_111n).u64(1_233_000n).u128(2_222n);
  w.raw(new Uint8Array(32).fill(0xab));
  w.u32(8).u64(1_234_900n).u64(1_234_950n);
  w.u8(1).u8(254).u8(5);
  return { bytes: w.done(ACCOUNT_DISCRIMINATOR.Coin), bodyLength: w.length };
}

describe("decodeCoin", () => {
  const { bytes, bodyLength } = coinFixture();

  it("consumes exactly the 456-byte body CONTRACTS.md states", () => {
    expect(bodyLength).toBe(456);
    expect(bytes.length).toBe(464);
  });

  it("reads every field in declaration order", () => {
    const coin = decodeCoin(bytes);
    expect(coin.creator).toBe(CREATOR);
    expect(coin.vault).toBe(VAULT);
    expect(coin.totalSupply).toBe(1_000_000n);
    expect(coin.reserveRemaining).toBe(500n);
    expect(coin.discoveryRemaining).toBe(40n);
    expect(coin.outstandingClaims).toBe(7n);
    expect(coin.cumulativeDistributed).toBe(60n);
    expect(coin.totalPower).toBe(900n);
    expect(coin.bondedPower).toBe(800n);
    expect(coin.starterPower).toBe(100n);
    expect(coin.bondedIndex).toBe(123_456_789n);
    expect(coin.starterIndex).toBe(30_864_197n);
    expect(coin.currentBlockReward).toBe(250n);
    expect(coin.blockInterval).toBe(300);
    expect(coin.nextBlockAt).toBe(1_700_000_000n);
    expect(coin.epochIndex).toBe(9);
    expect(coin.epochLength).toBe(604_800);
    expect(coin.epochEndsAt).toBe(1_700_600_000n);
    expect(coin.epochEndsSlot).toBe(1_234_567n);
    expect(coin.reductionBps).toBe(2_500);
    expect(coin.minimumReward).toBe(10n);
    expect(coin.tokenReserve).toBe(400_000n);
    expect(coin.solReserve).toBe(12_000_000n);
    expect(coin.virtualSolReserve).toBe(3_000_000n);
    expect(coin.graduationTarget).toBe(50_000_000n);
    expect(coin.creatorFeeClaimable).toBe(11n);
    expect(coin.platformFeeClaimable).toBe(13n);
    expect(coin.creatorFeeBps).toBe(50);
    expect(coin.platformFeeBps).toBe(50);
    expect(coin.curveMiningCap).toBe(300_000n);
    expect(coin.curveMiningMined).toBe(120_000n);
    expect(coin.curveMiningUnpaid).toBe(5_000n);
    expect(coin.curveMiningBlockReward).toBe(25n);
    expect(coin.curveMiningOpen).toBe(true);
    expect(coin.graduated).toBe(false);
    expect(coin.discoveryReserveTotal).toBe(50_000n);
    expect(coin.discoveryEpochBudget).toBe(4_000n);
    expect(coin.discoveryEpochSpent).toBe(250n);
    expect(coin.discoveryEpochIndex).toBe(9);
    expect(coin.discoveryPaused).toBe(false);
    expect(coin.twapCumPriceLamportsPerUnit).toBe(987_654_321n);
    expect(coin.twapLastUpdateSlot).toBe(1_234_000n);
    expect(bytesToHex(coin.epochSeed)).toBe("ab".repeat(32));
    expect(coin.epochSeedEpoch).toBe(8);
    expect(coin.epochSeedTargetSlot).toBe(1_234_900n);
    expect(coin.epochSeedRecordedSlot).toBe(1_234_950n);
    expect(coin.status).toBe("MiningActive");
    expect(coin.statusByte).toBe(1);
    expect(coin.bump).toBe(254);
    expect(coin.version).toBe(5);
  });

  it("refuses a body with the wrong discriminator rather than guessing", () => {
    const wrong = Uint8Array.from([...hexToBytes(ACCOUNT_DISCRIMINATOR.PlayerAccount), ...bytes.subarray(8)]);
    expect(() => decodeCoin(wrong)).toThrow(/expected the Coin discriminator/);
  });
});

describe("the event reader set", () => {
  it("covers exactly the contract's v2 events, so a new one cannot decode to null", () => {
    // The readers are the worker's own (shared/program.ts names an event but does not read its
    // body), so this pins the set they cover against the shared table: an event added to the
    // contract fails here until a payload reader exists for it.
    const legacy = new Set<string>(V4_LEGACY_EVENT_NAMES);
    const contractV2 = DIGGO_EVENT_NAMES.filter((name) => !legacy.has(name));
    expect([...V2_EVENT_NAMES].sort()).toEqual([...contractV2].sort());
  });
});

describe("coinLedgerInvariant", () => {
  const coin = decodeCoin(coinFixture().bytes);
  const owed = coin.tokenReserve + coin.reserveRemaining + coin.discoveryRemaining + coin.outstandingClaims;

  it("holds exactly at the boundary and reports the shortfall below it", () => {
    expect(coinLedgerInvariant(coin, owed)).toEqual({ ok: true, shortfall: 0n });
    expect(coinLedgerInvariant(coin, owed + 1n)).toEqual({ ok: true, shortfall: 0n });
    expect(coinLedgerInvariant(coin, owed - 1n)).toEqual({ ok: false, shortfall: 1n });
  });
});

// --- PlayerAccount and MiningPosition ----------------------------------------------------------

describe("decodePlayerAccount", () => {
  it("consumes exactly the 208-byte body and reads the bond block last", () => {
    const w = new Writer();
    w.u64(111n).i64(1_700_000_000n).i64(1_700_086_400n).i64(1_699_000_000n);
    for (const value of [5, 9, 4, 12, 12]) w.u16(value);
    w.u8(1);
    for (const value of [3, 4, 5, 6, 7]) w.u16(value);
    for (const value of [100n, 200n, 50n]) w.u64(value);
    w.i64(1_700_000_000n).pubkey(COIN);
    w.u16(20_000).u16(2_857).u64(1_000n).u64(4_000n).u16(19_999).u16(3).i64(1_699_900_000n);
    w.u64(70_000_000n).i64(1_699_000_000n).i64(1_699_604_800n).u8(1).pubkey(VAULT).u8(253).u8(5);
    expect(w.length).toBe(208);
    const account = decodePlayerAccount(w.done(ACCOUNT_DISCRIMINATOR.PlayerAccount));
    expect(account.createdSlot).toBe(111n);
    expect(account.crewLevels).toEqual([3, 4, 5, 6, 7]);
    expect(account.oreBalance).toBe(100n);
    expect(account.activeMine).toBe(COIN);
    expect(account.dayIndex).toBe(20_000);
    expect(account.bondLamports).toBe(70_000_000n);
    expect(account.bondSource).toBe("sponsor");
    expect(account.bondSourceByte).toBe(1);
    expect(account.bondSponsorVault).toBe(VAULT);
    expect(account.version).toBe(5);
  });
});

describe("decodeMiningPosition", () => {
  it("consumes the 43-byte body and reports the tranche byte", () => {
    const w = new Writer();
    w.u64(1_200n).u128(555n).u64(9n).u8(1).u64(1_234n).u8(252).u8(5);
    expect(w.length).toBe(43);
    const position = decodeMiningPosition(w.done(ACCOUNT_DISCRIMINATOR.MiningPosition));
    expect(position.assignedPower).toBe(1_200n);
    expect(position.lastRewardIndex).toBe(555n);
    expect(position.pendingReward).toBe(9n);
    expect(position.tranche).toBe("starter");
    expect(position.trancheByte).toBe(1);
    expect(position.createdSlot).toBe(1_234n);
  });
});

describe("decodeDiscoveryOpportunity", () => {
  it("consumes the 116-byte body, reserved units, and names the status byte", () => {
    const w = new Writer();
    w.pubkey(COIN).pubkey(OWNER).u16(19_999).u16(20_000).u32(9).u64(1_000n);
    w.u64(500n).i64(1_700_000_000n).u64(1_234n).i64(1_701_209_600n).u8(2).u8(0).u8(251).u8(5);
    expect(w.length).toBe(116);
    const opportunity = decodeDiscoveryOpportunity(w.done(ACCOUNT_DISCRIMINATOR.DiscoveryOpportunity));
    expect(opportunity.coin).toBe(COIN);
    expect(opportunity.owner).toBe(OWNER);
    expect(opportunity.epochIndex).toBe(9);
    expect(opportunity.reservedUnits).toBe(500n);
    expect(opportunity.status).toBe("Expired");
    expect(opportunityStatusName(1)).toBe("Settled");
  });
});

// --- events -----------------------------------------------------------------------------------

describe("decodeEventData", () => {
  it("decodes CoinLaunched, including the zero pubkey that means no sponsor", () => {
    const w = new Writer();
    w.pubkey(COIN).pubkey(MINT).pubkey(CREATOR).raw(new Uint8Array(32));
    const event = decodeEventData(w.done(EVENT_DISCRIMINATOR.CoinLaunched));
    expect(event).toEqual({
      name: "CoinLaunched",
      coin: COIN,
      mint: MINT,
      creator: CREATOR,
      sponsorEvent: bs58.encode(new Uint8Array(32)),
    });
  });

  it("decodes EpochSeedCommitted with the seed bytes intact", () => {
    const w = new Writer();
    w.pubkey(COIN).u32(9).u64(1_234_900n).u64(1_234_950n).raw(new Uint8Array(32).fill(7));
    const event = decodeEventData(w.done(EVENT_DISCRIMINATOR.EpochSeedCommitted));
    expect(event?.name).toBe("EpochSeedCommitted");
    if (event?.name !== "EpochSeedCommitted") throw new Error("wrong event");
    expect(event.epochIndex).toBe(9);
    expect(event.targetSlot).toBe(1_234_900n);
    expect(event.recordedSlot).toBe(1_234_950n);
    expect(bytesToHex(event.seed)).toBe("07".repeat(32));
  });

  it("decodes DiscoverySettled, which is what a payout is verified against", () => {
    const w = new Writer();
    w.pubkey(pubkey(9)).pubkey(COIN).pubkey(OWNER).u8(4).u64(1_000_000n).u64(50_000_000n);
    const event = decodeEventData(w.done(EVENT_DISCRIMINATOR.DiscoverySettled));
    expect(event).toEqual({
      name: "DiscoverySettled",
      opportunity: pubkey(9),
      coin: COIN,
      owner: OWNER,
      rarity: 4,
      units: 1_000_000n,
      valueLamports: 50_000_000n,
    });
  });

  it("returns null for an unknown discriminator and never throws", () => {
    expect(decodeEventData(hexToBytes("0011223344556677"))).toBeNull();
    expect(decodeEventData(new Uint8Array(4))).toBeNull();
  });
});

describe("decodeProgramEvents", () => {
  it("reads only the Program data lines and skips the ones it cannot parse", () => {
    const w = new Writer();
    w.pubkey(COIN).u32(1).i64(1_700_600_000n).u64(1_234_567n);
    const encoded = Buffer.from(w.done(EVENT_DISCRIMINATOR.EpochAdvanced)).toString("base64");
    const events = decodeProgramEvents([
      "Program 11111111111111111111111111111111 invoke [1]",
      `Program data: ${encoded}`,
      "Program data: bm90LWEtZGlnZ28tZXZlbnQ=",
      "Program log: Instruction: AdvanceMine",
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]?.name).toBe("EpochAdvanced");
  });
});

// --- trade instructions -----------------------------------------------------------------------

describe("decodeTradeInstruction", () => {
  it("decodes all four trade instructions and ignores everything else", () => {
    const w = new Writer();
    w.u64(1_000_000n).u64(900_000n);
    const body = w.done(INSTRUCTION_DISCRIMINATOR.buy);
    expect(decodeTradeInstruction(body)).toEqual({ kind: "buy", amountIn: 1_000_000n, minOut: 900_000n });
    for (const [name, kind] of [
      ["sell", "sell"],
      ["pool_buy", "pool_buy"],
      ["pool_sell", "pool_sell"],
    ] as const) {
      const data = Uint8Array.from([...hexToBytes(INSTRUCTION_DISCRIMINATOR[name]), ...body.subarray(8)]);
      expect(decodeTradeInstruction(data)?.kind).toBe(kind);
    }
    expect(decodeTradeInstruction(body.subarray(0, 8))).toBeNull();
    expect(decodeTradeInstruction(hexToBytes("0011223344556677"))).toBeNull();
  });
});

// --- PDAs -------------------------------------------------------------------------------------

describe("PDA derivation", () => {
  it("is deterministic, and every derived address is a 32-byte base58 pubkey", async () => {
    const coin = await deriveCoinPda(address(PROGRAM), address(MINT));
    expect(coin).toBe(await deriveCoinPda(address(PROGRAM), address(MINT)));
    expect(bs58.decode(coin)).toHaveLength(32);
    const player = await derivePlayerPda(address(PROGRAM), address(OWNER));
    expect(bs58.decode(player)).toHaveLength(32);
    const position = await derivePositionPda(address(PROGRAM), coin, address(OWNER));
    expect(bs58.decode(position)).toHaveLength(32);
    // Different seeds must not collide, which is the property a mix-up would break.
    expect(new Set([coin, player, position]).size).toBe(3);
  });
});

// --- display arithmetic -----------------------------------------------------------------------

describe("venue arithmetic", () => {
  const coin = decodeCoin(coinFixture().bytes);

  it("prices the curve from its effective SOL over its token inventory", () => {
    // (12,000,000 + 3,000,000) lamports over 0.4 whole tokens at six decimals.
    expect(curveSpotPriceLamports(coin, 6)).toBeCloseTo(37_500_000, 6);
  });

  it("prices the pool from the pool's own reserves", () => {
    expect(
      poolSpotPriceLamports(
        {
          coin: address(COIN),
          mint: address(MINT),
          tokenVault: address(VAULT),
          solVault: address(VAULT),
          tokenReserve: 1_000_000n,
          solReserve: 20_000_000n,
          graduatedAt: 0n,
          cumPriceLamportsPerUnit: 0n,
          lastUpdateSlot: 0n,
          bump: 0,
        },
        6,
      ),
    ).toBeCloseTo(20_000_000, 6);
  });

  it("reports zero rather than a curve price once graduated without a pool", () => {
    const graduated = { ...coin, graduated: true };
    expect(spotPriceLamports(graduated, null, 6)).toBe(0);
  });
});

describe("blockSplit", () => {
  const base = decodeCoin(coinFixture().bytes);

  it("caps the starter tranche at the configured share of the block", () => {
    // 100 starter power against 800 bonded: the proportional share is ~11%, over the 10% cap.
    const split = blockSplit(base, 1_000);
    expect(split.starter).toBe((250n * 1_000n) / BigInt(BPS));
    expect(split.bonded).toBe(250n - split.starter);
    expect(split.bonded * 10n).toBeGreaterThanOrEqual(250n * 9n);
  });

  it("leaves the whole block in the reserve when nothing is bonded", () => {
    const starterOnly = { ...base, bondedPower: 0n, starterPower: 500n };
    const split = blockSplit(starterOnly, 1_000);
    expect(split.starter).toBe((250n * 1_000n) / BigInt(BPS));
    expect(split.unassigned).toBe(250n - split.starter);
  });

  it("assigns nothing when the block reward is zero", () => {
    expect(blockSplit({ ...base, currentBlockReward: 0n }, 1_000)).toEqual({
      bonded: 0n,
      starter: 0n,
      unassigned: 0n,
    });
  });
});

describe("lamportsToSol", () => {
  it("converts without inventing precision", () => {
    expect(lamportsToSol(70_000_000n)).toBe(0.07);
    expect(lamportsToSol(0n)).toBe(0);
  });
});
