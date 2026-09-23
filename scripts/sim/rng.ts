/**
 * Deterministic pseudo-random source for the economy simulation harness.
 *
 * Production randomness for real-value outcomes lives in `shared/random.ts` (HMAC-SHA256 keyed by a
 * server secret) and is deliberately not reimplemented here. The harness needs tens of millions of
 * draws per run, so it uses counter-based integer mixing instead:
 *
 *   - every draw is a pure function of (seed, key...), never of iteration order, so a run is
 *     reproducible and the population can be processed in any order;
 *   - `pairWithHmacSource()` in selfcheck.ts re-checks the distribution against the real
 *     `createHmacRandomSource()` from shared/random.ts, so the stand-in stays honest.
 */

/** FNV-1a over a string, used to turn named streams into a stable 32-bit key. */
export function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** One avalanche round: mixes a 32-bit accumulator with a 32-bit value. */
function mix32(accumulator: number, value: number): number {
  let x = (accumulator ^ Math.imul(value | 0, 0x9e3779b1)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

/**
 * Uniform draw in [0, 1) keyed by up to four integers. Allocation-free, so the hot loops
 * (one draw per player per discovery window) stay cheap.
 */
export function unitFromInts(seed: number, a = 0, b = 0, c = 0, d = 0): number {
  const mixed = mix32(mix32(mix32(mix32(seed >>> 0, a), b), c), d);
  return mixed / 4_294_967_296;
}

/** Uniform draw in [0, 1) keyed by a seed and a name. */
export function unitFromKey(seed: number, ...parts: (string | number)[]): number {
  let mixed = seed >>> 0;
  for (const part of parts) mixed = mix32(mixed, typeof part === "number" ? part : hashString(part));
  return mixed / 4_294_967_296;
}

/** A reproducible stream. Same seed and same call order always yields the same values. */
export class RngStream {
  private state: number;

  constructor(seed: number, ...parts: (string | number)[]) {
    let mixed = (seed >>> 0) ^ 0x2545f491;
    for (const part of parts) mixed = mix32(mixed, typeof part === "number" ? part : hashString(part));
    this.state = mixed >>> 0;
  }

  /** splitmix32 next value in [0, 1). */
  next(): number {
    this.state = (this.state + 0x9e3779b9) >>> 0;
    let z = this.state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    z = (z ^ (z >>> 15)) >>> 0;
    return z / 4_294_967_296;
  }

  /** Integer in [0, max). */
  int(max: number): number {
    if (max <= 0) return 0;
    return Math.min(max - 1, Math.floor(this.next() * max));
  }

  chance(probability: number): boolean {
    if (!(probability > 0)) return false;
    if (probability >= 1) return true;
    return this.next() < probability;
  }

  /** Triangular-ish jitter in [-spread, spread] with a symmetric two-draw mean. */
  jitter(spread: number): number {
    return (this.next() - this.next()) * spread;
  }
}

/** A stable 32-bit digest of a list of numbers, used to fingerprint simulation results. */
export function digest(parts: readonly (number | string)[]): string {
  let hash = 0x811c9dc5;
  for (const part of parts) {
    const text = typeof part === "number" ? Math.round(part * 1_000).toString(36) : part;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return hash.toString(16).padStart(8, "0");
}
