import { deriveKeyedBytes, deriveRoll, type RandomRequest, type RandomSource } from "./random";

/**
 * Verifiable RNG through commit-reveal (spec 55, 56).
 *
 * The HMAC source in ./random.ts is server-authoritative: a client cannot predict or reroll an
 * outcome, but a player also has no way to check after the fact that the roll they were given was
 * the roll the server actually committed to. Commit-reveal closes that gap without waiting for an
 * on-chain VRF:
 *
 *   1. Before a discovery epoch starts, the server publishes `commitment = sha256(seed)`.
 *      The seed is derived deterministically as `HMAC(DISCOVERY_SECRET, epoch)`, so the operator
 *      cannot choose a seed after seeing how the epoch played out - a different seed would need a
 *      different secret, which would invalidate every earlier commitment.
 *   2. During the epoch every roll is `HMAC(seed, epoch|eventId|accountId|window)`, mapped into
 *      [0, 1). Nothing else feeds the outcome.
 *   3. After the epoch ends the seed is revealed. Anyone can then hash it, check it against the
 *      commitment published before the epoch, recompute each roll from the event id the API
 *      returned and confirm the rarity, the target mint and the token amount they received.
 *
 * The seed is therefore unpredictable while it matters and fully auditable afterwards, and
 * `createCommitRevealRandomSource` keeps the RandomSource interface, so a Switchboard VRF can be
 * dropped in later by implementing the same two methods against on-chain randomness instead.
 *
 * Storage caveat, stated plainly: the seed is derived from DISCOVERY_SECRET, so anyone who holds
 * that secret (the operator, or an attacker who exfiltrates it) can compute the seed early. What
 * commit-reveal guarantees is that the seed cannot be *changed* after its commitment is published,
 * which is exactly the manipulation this defends against. Migrating to a VRF removes the operator
 * from the trust model entirely; that is the documented next step, not something this module claims
 * to have already achieved.
 */

/** Domain separator for the per-epoch seed. Changing it invalidates every published commitment. */
export const SEED_DERIVATION_DOMAIN = "diggo.discovery.seed.v1";
/** Domain separator for a roll. Part of the public verification recipe. */
export const ROLL_DOMAIN = "diggo.discovery.commit-reveal.v1";
/** Recorded in rng_commitments.algorithm so a future scheme is distinguishable from this one. */
export const COMMIT_REVEAL_ALGORITHM = "hmac-sha256-commit-reveal-v1";
/** Default epoch length: one day, rolled over at 00:00 UTC. */
export const DEFAULT_EPOCH_SECONDS = 86_400;

export interface EpochInfo {
  epoch: number;
  epochSeconds: number;
  /** Inclusive start of the epoch, unix seconds. */
  startsAt: number;
  /** Exclusive end of the epoch, unix seconds. The seed is publishable from here on. */
  endsAt: number;
}

/** The epoch an instant falls into. */
export function epochOf(now: number, epochSeconds: number = DEFAULT_EPOCH_SECONDS): number {
  const width = Number.isFinite(epochSeconds) && epochSeconds > 0 ? Math.floor(epochSeconds) : DEFAULT_EPOCH_SECONDS;
  return Math.floor(now / width);
}

export function epochInfo(epoch: number, epochSeconds: number = DEFAULT_EPOCH_SECONDS): EpochInfo {
  const width = Number.isFinite(epochSeconds) && epochSeconds > 0 ? Math.floor(epochSeconds) : DEFAULT_EPOCH_SECONDS;
  const index = Math.max(0, Math.floor(epoch));
  return { epoch: index, epochSeconds: width, startsAt: index * width, endsAt: (index + 1) * width };
}

/** True once the epoch has ended, which is the only moment a seed may be revealed. */
export function revealIsAllowed(info: EpochInfo, now: number): boolean {
  return now >= info.endsAt;
}

/** Canonical message the seed is derived from. Public, so derivation is reproducible. */
export function seedMessage(epoch: number): string {
  return `${SEED_DERIVATION_DOMAIN}|${Math.max(0, Math.floor(epoch))}`;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export async function sha256Hex(input: string, subtle?: SubtleCrypto): Promise<string> {
  const api = subtle ?? (typeof globalThis.crypto === "undefined" ? undefined : globalThis.crypto.subtle);
  if (!api) throw new Error("WebCrypto SubtleCrypto is unavailable");
  const digest = await api.digest("SHA-256", new TextEncoder().encode(input));
  return toHex(new Uint8Array(digest));
}

/**
 * The epoch seed: 32 bytes of HMAC-SHA256(DISCOVERY_SECRET, "diggo.discovery.seed.v1|<epoch>"),
 * hex encoded. Deterministic in (secret, epoch), so the operator has no freedom to choose it.
 */
export async function deriveEpochSeed(
  serverSecret: string,
  epoch: number,
  subtle?: SubtleCrypto,
): Promise<string> {
  return toHex(await deriveKeyedBytes(serverSecret, seedMessage(epoch), 32, subtle));
}

/**
 * The published commitment: sha256 of the hex seed exactly as it will be revealed. Hashing the
 * published text (not the raw bytes) means a verifier only needs sha256 and the string the API
 * returned, in any language.
 */
export async function commitmentOf(seedHex: string, subtle?: SubtleCrypto): Promise<string> {
  return sha256Hex(seedHex, subtle);
}

/** True when `seedHex` is the seed behind `commitment`. Never throws on malformed input. */
export async function verifyCommitment(
  seedHex: string,
  commitment: string,
  subtle?: SubtleCrypto,
): Promise<boolean> {
  if (typeof seedHex !== "string" || typeof commitment !== "string") return false;
  return (await commitmentOf(seedHex, subtle)) === commitment;
}

export interface CommitRevealRollInput {
  epoch: number;
  /** The opportunity's event id, exactly as the API returned it. Purpose suffixes included. */
  eventId: string;
  accountId: string;
  window: number | string;
}

/**
 * The exact string a roll is derived from. Published so a verifier can rebuild it from nothing but
 * the API's own responses: the event id and window come from the opportunity, the account id is
 * the wallet, and the epoch follows from the discovery's created_at.
 */
export function commitRevealMessage(input: CommitRevealRollInput): string {
  return [
    ROLL_DOMAIN,
    String(Math.max(0, Math.floor(input.epoch))),
    input.eventId,
    input.accountId,
    String(input.window),
  ].join("|");
}

/** Uniform roll in [0, 1) for one opportunity, reproducible from the revealed seed alone. */
export async function commitRevealRoll(
  seedHex: string,
  input: CommitRevealRollInput,
  subtle?: SubtleCrypto,
): Promise<number> {
  return deriveRoll(seedHex, commitRevealMessage(input), subtle);
}

/**
 * Deterministic keyed bytes for one opportunity, used for the opportunity nonce. Same message as
 * commitRevealRoll, so the nonce is auditable too.
 */
export async function commitRevealBytes(
  seedHex: string,
  input: CommitRevealRollInput,
  byteLength: number,
  subtle?: SubtleCrypto,
): Promise<Uint8Array> {
  return deriveKeyedBytes(seedHex, commitRevealMessage(input), byteLength, subtle);
}

/**
 * An epoch-bound RandomSource. It owns its seed, so a call site cannot smuggle in a different one:
 * the request still has to carry the same seed as `serverSecret`, and a mismatch throws rather
 * than silently rolling against a seed no one committed to.
 *
 * A future VRF source implements this same interface with on-chain randomness; nothing else in the
 * discovery pipeline has to change.
 */
export function createCommitRevealRandomSource(
  epoch: number,
  seedHex: string,
  subtle?: SubtleCrypto,
): RandomSource {
  const boundEpoch = Math.max(0, Math.floor(epoch));
  const assertBoundSeed = (request: RandomRequest): CommitRevealRollInput => {
    if (request.serverSecret !== seedHex) {
      throw new Error("Commit-reveal source refuses a seed other than its own epoch seed");
    }
    return {
      epoch: boundEpoch,
      eventId: request.eventId,
      accountId: request.accountId,
      window: request.window,
    };
  };
  return {
    kind: COMMIT_REVEAL_ALGORITHM,
    async roll(request: RandomRequest): Promise<number> {
      return commitRevealRoll(seedHex, assertBoundSeed(request), subtle);
    },
    async deriveBytes(request: RandomRequest, byteLength: number): Promise<Uint8Array> {
      return commitRevealBytes(seedHex, assertBoundSeed(request), byteLength, subtle);
    },
  };
}

/** One rng_commitments row, as stored. */
export interface RngCommitmentRecord {
  epoch: number;
  epochSeconds: number;
  startsAt: number;
  endsAt: number;
  commitment: string;
  algorithm: string;
  seed: string | null;
  revealedAt: number | null;
  createdAt: number;
}

export interface CommitmentView {
  epoch: number;
  algorithm: string;
  epochSeconds: number;
  startsAt: number;
  endsAt: number;
  commitment: string;
  /** Null until the epoch has ended. The single guarantee this module exists to make. */
  seed: string | null;
  revealed: boolean;
  revealedAt: number | null;
}

/**
 * The only way a commitment leaves the server. The seed is stripped unless the epoch has ended, so
 * an endpoint cannot leak it by accident just because the column is populated, and the reveal
 * endpoint and the list endpoint cannot drift apart.
 */
export function commitmentView(record: RngCommitmentRecord, now: number): CommitmentView {
  const revealed = record.seed !== null && revealIsAllowed(record, now);
  return {
    epoch: record.epoch,
    algorithm: record.algorithm,
    epochSeconds: record.epochSeconds,
    startsAt: record.startsAt,
    endsAt: record.endsAt,
    commitment: record.commitment,
    seed: revealed ? record.seed : null,
    revealed,
    revealedAt: revealed ? record.revealedAt : null,
  };
}

/**
 * The public recipe for checking one roll, returned next to a revealed seed so a verifier does not
 * have to read the source to reconstruct it.
 */
export interface RollVerificationRecipe {
  domain: string;
  message: string;
  commitmentAlgorithm: string;
  seedDerivation: string;
}

export function rollVerificationRecipe(): RollVerificationRecipe {
  return {
    domain: ROLL_DOMAIN,
    message:
      "message = [ROLL_DOMAIN, epoch, eventId, accountId, window].join('|'); " +
      "roll = toUnitInterval(HMAC_SHA256(seed, message)); " +
      "unit interval takes the top 53 bits of the first 8 bytes, i.e. value >> 11 / 2^53",
    commitmentAlgorithm: "commitment = sha256_hex(seed)",
    seedDerivation: `seed = hmac_sha256_hex(DISCOVERY_SECRET, "${SEED_DERIVATION_DOMAIN}|<epoch>")`,
  };
}
