/**
 * The epoch seed, and the derivation every discovery outcome comes from (design 4.1).
 *
 * Mirrors, in order, `state/epoch.rs` (the reveal plan and the coverage rule),
 * `math/rarity.rs` (the digest and the roll) and `math/index.rs` (the epoch span the walk
 * predicts). The chain is authoritative: `shared/parity/mining.json` is generated from the
 * Rust unit test `mining_parity_vectors`, and the vectors below are asserted against the same
 * numbers on both sides.
 *
 * Nothing here is a secret and nothing here is an operator input. The seed is a slot hash
 * that could not be known while the epoch's rolls were being created, and the wallet and the
 * roll window are unique per roll, so anyone can recompute any past outcome from the seed the
 * program recorded on the coin.
 */

/** Slots between an epoch's end and the SlotHashes entry its seed is taken from. */
export const EPOCH_SEED_DELAY_SLOTS = 32;

/** How late a reveal may be before the seed re-arms instead of being committed. */
export const EPOCH_SEED_MAX_LATENESS_SLOTS = 512;

/** How many slot hashes the SlotHashes sysvar keeps: the window a reveal must land in. */
export const SLOT_HASHES_WINDOW = 512;

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
  0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
  0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
  0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
  0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
  0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2
]);

function rotr(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

/**
 * SHA-256 of the concatenation of the parts.
 *
 * Implemented here rather than imported so the client and the sim need no hashing dependency
 * and so the derivation is byte-for-byte the same function the program runs. The program
 * carries its own copy for the same reason; both are pinned by the same golden vectors.
 */
export function sha256(...parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const bitLength = BigInt(total) * 8n;
  // One 0x80 byte plus an eight-byte length, rounded up to whole 64-byte blocks. The total is
  // 9 bytes short of the block boundary that forces an extra block, so the boundary is
  // total + 8: a message whose length is 55 mod 64 needs one block, not two.
  const padded = new Uint8Array((((total + 8) >> 6) + 1) << 6);
  let offset = 0;
  for (const part of parts) {
    padded.set(part, offset);
    offset += part.length;
  }
  padded[total] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Number((bitLength >> 32n) & 0xffffffffn));
  view.setUint32(padded.length - 4, Number(bitLength & 0xffffffffn));

  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
    0x5be0cd19
  ]);
  const schedule = new Uint32Array(64);
  for (let block = 0; block < padded.length; block += 64) {
    for (let index = 0; index < 16; index += 1) {
      schedule[index] = view.getUint32(block + index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const s0 =
        rotr(schedule[index - 15], 7) ^ rotr(schedule[index - 15], 18) ^ (schedule[index - 15] >>> 3);
      const s1 =
        rotr(schedule[index - 2], 17) ^ rotr(schedule[index - 2], 19) ^ (schedule[index - 2] >>> 10);
      schedule[index] =
        (schedule[index - 16] + s0 + schedule[index - 7] + s1) >>> 0;
    }
    let a = state[0];
    let b = state[1];
    let c = state[2];
    let d = state[3];
    let e = state[4];
    let f = state[5];
    let g = state[6];
    let h = state[7];
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + s1 + ch + SHA256_K[index] + schedule[index]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let index = 0; index < 8; index += 1) outView.setUint32(index * 4, state[index]);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

/**
 * The discovery derivation: sha256(seed || owner || window index), with the window
 * little-endian and two bytes wide. Byte for byte the same preimage the program hashes.
 */
export function discoveryDigest(
  seed: Uint8Array,
  owner: Uint8Array,
  windowIndex: number
): Uint8Array {
  const window = new Uint8Array(2);
  new DataView(window.buffer).setUint16(0, windowIndex & 0xffff, true);
  return sha256(seed, owner, window);
}

/** The roll the digest decides, in bps of 10,000. */
export function discoveryRollBps(digest: Uint8Array): number {
  const raw = digest[0] | (digest[1] << 8);
  return Math.min(raw % 10_000, 9_999);
}

export type SeedRevealPlan =
  | { readonly kind: "target" }
  | { readonly kind: "oldest" }
  | { readonly kind: "rearm"; readonly slot: number };

/**
 * The deterministic miss handling of design 4.1, decided from slots alone.
 *
 * Both bounds are SLOT_HASHES_WINDOW, so the target is inside the sysvar while the crank is
 * less than a window late, the oldest surviving hash covers the single slot of lateness at
 * exactly a window, and past the lateness bound the seed re-arms at a slot that has not been
 * produced yet rather than being taken from one whose hash was already public.
 */
export function planSeedReveal(
  targetSlot: number,
  currentSlot: number,
  maxLatenessSlots: number = EPOCH_SEED_MAX_LATENESS_SLOTS,
  delaySlots: number = EPOCH_SEED_DELAY_SLOTS
): SeedRevealPlan | null {
  if (targetSlot <= 0 || targetSlot > currentSlot) return null;
  const lateness = currentSlot - targetSlot;
  if (lateness < SLOT_HASHES_WINDOW) return { kind: "target" };
  if (lateness <= maxLatenessSlots) return { kind: "oldest" };
  return { kind: "rearm", slot: currentSlot + Math.max(1, delaySlots) };
}

/**
 * True when a recorded seed may settle an opportunity: a seed exists, its epoch covers the
 * opportunity's, and the roll was created strictly before the seed was recorded - which is
 * what stops a wallet from reading the published seed and only rolling the outcomes it likes.
 */
export function isCoveredBy(
  opportunity: { readonly epochIndex: number; readonly createdSlot: bigint | number },
  seedEpoch: number,
  seedRecordedSlot: bigint | number
): boolean {
  const recorded = BigInt(seedRecordedSlot);
  return recorded > 0n && seedEpoch >= opportunity.epochIndex && BigInt(opportunity.createdSlot) < recorded;
}

/**
 * The slot span the walk predicts for one epoch, measured from the span the previous epoch
 * actually took. Nothing on chain maps a duration to a slot count, so the observable answer
 * is the honest one; with nothing to observe it falls back to a whole sysvar window, which is
 * far enough ahead that the armed target is still in the future.
 */
export function predictEpochSpanSlots(
  epochEndsSlot: bigint | number,
  slot: bigint | number,
  epochsRolled: number
): number {
  const ends = BigInt(epochEndsSlot);
  const now = BigInt(slot);
  if (ends === 0n || now <= ends) return SLOT_HASHES_WINDOW;
  const perEpoch = (now - ends) / BigInt(Math.max(1, epochsRolled));
  return Number(perEpoch < 1n ? 1n : perEpoch);
}
