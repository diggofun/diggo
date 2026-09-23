/**
 * Server-authoritative randomness (spec 55, 56).
 *
 * The frontend never decides whether a discovery happened, which token was
 * found, which rarity was rolled or how many tokens are paid out. Every reward
 * decision derives its roll from (serverSecret, eventId, accountId, window) via
 * HMAC-SHA256, which makes the outcome deterministic per opportunity: a client
 * cannot reroll, cannot request a better result and cannot predict the seed
 * without the server secret.
 *
 * The RandomSource abstraction keeps the door open for a later migration to a
 * verifiable or on-chain RNG without touching call sites.
 */

export const RANDOM_DOMAIN = "diggo.discovery.v1";

export interface RandomRequest {
  /** Server-only secret. Loaded from Wrangler secrets, never sent to clients. */
  serverSecret: string;
  /** Stable identifier of the reward opportunity. One roll per eventId. */
  eventId: string;
  accountId: string;
  /** Scoping window, such as an epoch second bucket, block slot or day index. */
  window: number | string;
}

export interface RandomSource {
  readonly kind: string;
  /** Uniform roll in [0, 1). */
  roll(request: RandomRequest): Promise<number>;
  /** Deterministic keyed bytes for derivation of any extra randomness. */
  deriveBytes(request: RandomRequest, byteLength: number): Promise<Uint8Array>;
}

/** Canonical, unambiguous message. Field order and separator are fixed. */
export function randomMessage(request: RandomRequest): string {
  return [RANDOM_DOMAIN, request.eventId, request.accountId, String(request.window)].join("|");
}

/** Idempotency key for a single opportunity: reuse means replay, not a reroll. */
export function opportunityKey(request: RandomRequest): string {
  return [request.eventId, request.accountId, String(request.window)].join(":");
}

function concatBytes(parts: readonly Uint8Array[]) {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function resolveSubtle(subtle?: SubtleCrypto): SubtleCrypto {
  const resolved = subtle ?? (typeof globalThis.crypto === "undefined" ? undefined : globalThis.crypto.subtle);
  if (!resolved) throw new Error("WebCrypto SubtleCrypto is unavailable");
  return resolved;
}

const HMAC_ALGORITHM = { name: "HMAC", hash: "SHA-256" } as const;
const BLOCK_BYTES = 32;

/**
 * Keyed byte derivation. The first block is HMAC(secret, message || 0x01) and
 * further blocks chain like HKDF-Expand, so any byte length is supported while
 * staying deterministic.
 */
export async function deriveKeyedBytes(
  serverSecret: string,
  message: string,
  byteLength: number,
  subtle?: SubtleCrypto,
): Promise<Uint8Array> {
  const api = resolveSubtle(subtle);
  const keyBytes = new TextEncoder().encode(serverSecret);
  const messageBytes = new TextEncoder().encode(message);
  if (keyBytes.length === 0) {
    // Fail closed: without a server secret the roll would be predictable.
    throw new Error("RandomSource requires a non-empty server secret");
  }
  const key = await api.importKey("raw", keyBytes, HMAC_ALGORITHM, false, ["sign"]);
  const blocks = Math.max(1, Math.ceil(byteLength / BLOCK_BYTES));
  const out = new Uint8Array(blocks * BLOCK_BYTES);
  let previous = new Uint8Array(0);
  for (let index = 0; index < blocks; index += 1) {
    const counter = new Uint8Array([index + 1]);
    const signature = new Uint8Array(await api.sign("HMAC", key, concatBytes([previous, messageBytes, counter])));
    out.set(signature, index * BLOCK_BYTES);
    previous = signature;
  }
  return out.slice(0, Math.max(0, byteLength));
}

/** Uniform roll in [0, 1) from 64 bits of HMAC-SHA256 output. */
export async function deriveRoll(
  serverSecret: string,
  message: string,
  subtle?: SubtleCrypto,
): Promise<number> {
  const bytes = await deriveKeyedBytes(serverSecret, message, 8, subtle);
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return Number(value >> 11n) / 9007199254740992;
}

/** HMAC-SHA256 random source backed by WebCrypto, safe to run in Workers. */
export function createHmacRandomSource(subtle?: SubtleCrypto): RandomSource {
  return {
    kind: "hmac-sha256",
    async roll(request: RandomRequest): Promise<number> {
      return deriveRoll(request.serverSecret, randomMessage(request), subtle);
    },
    async deriveBytes(request: RandomRequest, byteLength: number): Promise<Uint8Array> {
      return deriveKeyedBytes(request.serverSecret, randomMessage(request), byteLength, subtle);
    },
  };
}

/**
 * Single-use opportunity ledger (spec 56, 57). A consumed opportunity can never
 * be rolled again, so a client cannot spam requests hoping for a better result.
 */
export class OpportunityRegistry {
  private readonly consumed = new Set<string>();

  /** Returns false when the opportunity was already consumed. */
  consume(request: RandomRequest): boolean {
    const key = opportunityKey(request);
    if (this.consumed.has(key)) return false;
    this.consumed.add(key);
    return true;
  }

  has(request: RandomRequest): boolean {
    return this.consumed.has(opportunityKey(request));
  }

  get size(): number {
    return this.consumed.size;
  }
}
