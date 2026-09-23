import { describe, expect, it } from "vitest";

import {
  EPOCH_SEED_DELAY_SLOTS,
  SLOT_HASHES_WINDOW,
  bytesToHex,
  discoveryDigest,
  discoveryRollBps,
  hexToBytes,
  isCoveredBy,
  planSeedReveal,
  predictEpochSpanSlots,
  sha256
} from "./epochSeed";

/**
 * The Rust side of the parity gate is the unit test `mining_parity_vectors` in
 * programs/diggo-protocol/src/math/index.rs, which emits shared/parity/mining.json. Every
 * literal below is copied from that file, so a divergence between the program and the client
 * shows up here rather than as a client that quietly disagrees about who is owed what.
 */

const SEED = new Uint8Array(32).fill(0x01);
const OWNER = new Uint8Array(32).fill(0x02);

const DERIVATION_VECTORS = [
  {
    windowIndex: 0,
    digestHex: "c20a6fd2329070420058915cba61711a8fc14592e481cf85d6ef73097da840c4",
    rollBps: 2_754
  },
  {
    windowIndex: 1,
    digestHex: "6201108cccc1158bdc551eb4010d5b52aa630e4b6bcf2cc6aa6516a427300ee5",
    rollBps: 354
  },
  {
    windowIndex: 258,
    digestHex: "f7ce5e6d1afcc20f6b21eeb0f398dde53f7002241adcafb70eccaf97500c2dd3",
    rollBps: 2_983
  },
  {
    windowIndex: 65_535,
    digestHex: "9fc24d4796d7f1952eb07585628552ed7dab39bfd71a2bbbc73bd394953fec8f",
    rollBps: 9_823
  }
] as const;

describe("sha256", () => {
  it("matches the published known answers", () => {
    expect(bytesToHex(sha256())).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    expect(bytesToHex(sha256(new TextEncoder().encode("abc")))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    // The padding boundaries, which are where a hand-written SHA-256 usually breaks.
    expect(bytesToHex(sha256(new Uint8Array(55)))).toBe(
      "02779466cdec163811d078815c633f21901413081449002f24aa3e80f0b88ef7"
    );
    expect(bytesToHex(sha256(new Uint8Array(56)))).toBe(
      "d4817aa5497628e7c77e6b606107042bbba3130888c5f47a375e6179be789fbb"
    );
    expect(bytesToHex(sha256(new Uint8Array(64)))).toBe(
      "f5a5fd42d16a20302798ef6ed309979b43003d2320d9f0e8ea9831a92759fb4b"
    );
    expect(bytesToHex(sha256(new Uint8Array(119)))).toBe(
      "f616b0d54e78571a9611f343c9f8e022e859e920381ab0e4d3da01e193a7bd7e"
    );
    expect(bytesToHex(sha256(new Uint8Array(120)))).toBe(
      "6edd9f6f9cc92cded36e6c4a580933f9c9f1b90562b46903b806f21902a1a54f"
    );
  });

  it("hashes the concatenation of its parts, not each part separately", () => {
    const joined = new Uint8Array(6).fill(7);
    expect(bytesToHex(sha256(joined))).toBe(
      bytesToHex(sha256(new Uint8Array(3).fill(7), new Uint8Array(3).fill(7)))
    );
  });
});

describe("the discovery derivation", () => {
  it("matches the Rust parity vectors byte for byte", () => {
    for (const vector of DERIVATION_VECTORS) {
      const digest = discoveryDigest(SEED, OWNER, vector.windowIndex);
      expect(bytesToHex(digest)).toBe(vector.digestHex);
      expect(discoveryRollBps(digest)).toBe(vector.rollBps);
    }
  });

  it("binds the wallet and the window, so one seed covers a whole epoch", () => {
    const other = new Uint8Array(32).fill(0x03);
    expect(bytesToHex(discoveryDigest(SEED, OWNER, 0))).not.toBe(
      bytesToHex(discoveryDigest(SEED, other, 0))
    );
    expect(bytesToHex(discoveryDigest(SEED, OWNER, 0))).not.toBe(
      bytesToHex(discoveryDigest(SEED, OWNER, 1))
    );
    const otherSeed = new Uint8Array(32).fill(0x09);
    expect(bytesToHex(discoveryDigest(SEED, OWNER, 0))).not.toBe(
      bytesToHex(discoveryDigest(otherSeed, OWNER, 0))
    );
  });

  it("always produces a live bps roll", () => {
    for (let byte = 0; byte < 256; byte += 1) {
      const digest = new Uint8Array(32).fill(byte);
      const roll = discoveryRollBps(digest);
      expect(roll).toBeGreaterThanOrEqual(0);
      expect(roll).toBeLessThan(10_000);
    }
  });

  it("round-trips hex", () => {
    expect(bytesToHex(hexToBytes("00ff10"))).toBe("00ff10");
  });
});

describe("the reveal plan", () => {
  const VECTORS: readonly {
    readonly currentSlot: number;
    readonly plan: string;
    readonly rearmSlot: number;
    readonly targetSlot?: number;
    readonly maxLatenessSlots?: number;
  }[] = [
    { currentSlot: 1_000, plan: "target", rearmSlot: 0 },
    { currentSlot: 1_511, plan: "target", rearmSlot: 0 },
    { currentSlot: 1_512, plan: "oldest", rearmSlot: 0 },
    { currentSlot: 1_513, plan: "rearm", rearmSlot: 1_545 },
    { currentSlot: 2_000, plan: "oldest", rearmSlot: 0, maxLatenessSlots: 2_048 }
  ];

  it("matches the Rust parity vectors", () => {
    for (const vector of VECTORS) {
      const plan = planSeedReveal(
        vector.targetSlot ?? 1_000,
        vector.currentSlot,
        vector.maxLatenessSlots ?? 512,
        32
      );
      expect(plan?.kind).toBe(vector.plan);
      if (plan?.kind === "rearm") expect(plan.slot).toBe(vector.rearmSlot);
    }
  });

  it("refuses an unarmed or future target", () => {
    expect(planSeedReveal(0, 999)).toBeNull();
    expect(planSeedReveal(1_000, 999)).toBeNull();
  });

  it("always re-arms at a slot that has not been produced yet", () => {
    const plan = planSeedReveal(1_000, 100_000, 512, EPOCH_SEED_DELAY_SLOTS);
    expect(plan).toEqual({ kind: "rearm", slot: 100_000 + EPOCH_SEED_DELAY_SLOTS });
  });
});

describe("seed coverage", () => {
  it("only lets a seed recorded after the roll settle it", () => {
    const roll = { epochIndex: 4, createdSlot: 500 };
    expect(isCoveredBy(roll, 4, 600)).toBe(true);
    expect(isCoveredBy(roll, 9, 600)).toBe(true);
    expect(isCoveredBy(roll, 4, 0)).toBe(false);
    expect(isCoveredBy(roll, 3, 600)).toBe(false);
    expect(isCoveredBy(roll, 4, 500)).toBe(false);
    expect(isCoveredBy(roll, 4, 499)).toBe(false);
  });
});

describe("the predicted epoch span", () => {
  it("measures the span the previous epoch actually took", () => {
    expect(predictEpochSpanSlots(1_000, 4_000, 1)).toBe(3_000);
    expect(predictEpochSpanSlots(1_000, 4_000, 4)).toBe(750);
  });

  it("falls back to a whole sysvar window when there is nothing to measure", () => {
    expect(predictEpochSpanSlots(0, 4_000, 1)).toBe(SLOT_HASHES_WINDOW);
    expect(predictEpochSpanSlots(9_000, 4_000, 1)).toBe(SLOT_HASHES_WINDOW);
  });
});
