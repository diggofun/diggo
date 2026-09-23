/**
 * Commit-reveal RNG (spec 55, 56).
 *
 * The property under test is not "the rolls look random" - it is that a player can reconstruct every
 * roll of a finished epoch from public data alone, and that nothing can reconstruct them before that
 * epoch ends.
 */
import { describe, expect, it } from "vitest";
import {
  COMMIT_REVEAL_ALGORITHM,
  DEFAULT_EPOCH_SECONDS,
  SEED_DERIVATION_DOMAIN,
  commitmentOf,
  commitmentView,
  commitRevealMessage,
  commitRevealRoll,
  createCommitRevealRandomSource,
  deriveEpochSeed,
  epochInfo,
  epochOf,
  revealIsAllowed,
  rollVerificationRecipe,
  seedMessage,
  verifyCommitment,
  type RngCommitmentRecord,
} from "./commitReveal";

const SECRET = "test-discovery-secret-0123456789";
const EPOCH = 20_833;

describe("commitment (spec 55)", () => {
  it("is reproduced exactly by the seed it later reveals", async () => {
    const seed = await deriveEpochSeed(SECRET, EPOCH);
    const commitment = await commitmentOf(seed);
    expect(commitment).toMatch(new RegExp("^[0-9a-f]{64}$"));
    expect(await verifyCommitment(seed, commitment)).toBe(true);
    // A different seed cannot open the same commitment, which is what makes the promise binding.
    expect(await verifyCommitment(await deriveEpochSeed(SECRET, EPOCH + 1), commitment)).toBe(false);
    expect(await verifyCommitment("", commitment)).toBe(false);
    expect(await verifyCommitment(seed, "not-a-commitment")).toBe(false);
  });

  it("derives the seed from the secret and the epoch only", async () => {
    expect(await deriveEpochSeed(SECRET, EPOCH)).toBe(await deriveEpochSeed(SECRET, EPOCH));
    expect(await deriveEpochSeed(SECRET, EPOCH)).toMatch(new RegExp("^[0-9a-f]{64}$"));
    expect(await deriveEpochSeed(SECRET, EPOCH + 1)).not.toBe(await deriveEpochSeed(SECRET, EPOCH));
    // Rotating the secret changes every later seed, so an operator cannot re-derive a favourable
    // seed for an epoch whose commitment is already published.
    expect(await deriveEpochSeed(SECRET + "x", EPOCH)).not.toBe(await deriveEpochSeed(SECRET, EPOCH));
    expect(seedMessage(EPOCH)).toBe(SEED_DERIVATION_DOMAIN + "|" + EPOCH);
  });

  it("never exposes the seed before the epoch has ended", () => {
    const info = epochInfo(EPOCH, DEFAULT_EPOCH_SECONDS);
    const record: RngCommitmentRecord = {
      epoch: info.epoch,
      epochSeconds: info.epochSeconds,
      startsAt: info.startsAt,
      endsAt: info.endsAt,
      commitment: "ab".repeat(32),
      algorithm: COMMIT_REVEAL_ALGORITHM,
      seed: "cd".repeat(32),
      revealedAt: info.endsAt,
      createdAt: info.startsAt,
    };

    for (const moment of [info.startsAt, info.startsAt + 1, info.endsAt - 1]) {
      const view = commitmentView(record, moment);
      expect(view.seed).toBeNull();
      expect(view.revealed).toBe(false);
      expect(view.commitment).toBe(record.commitment);
      expect(revealIsAllowed(info, moment)).toBe(false);
    }

    const revealed = commitmentView(record, info.endsAt);
    expect(revealed.seed).toBe("cd".repeat(32));
    expect(revealed.revealed).toBe(true);
    expect(revealIsAllowed(info, info.endsAt)).toBe(true);

    // An ended epoch whose seed was never stored reports nothing to reveal rather than inventing one.
    const unrevealed = commitmentView({ ...record, seed: null }, info.endsAt + 10_000);
    expect(unrevealed.seed).toBeNull();
    expect(unrevealed.revealed).toBe(false);
  });
});

describe("rolls (spec 56)", () => {
  const input = {
    epoch: EPOCH,
    eventId: "dsc:v1:WaLLeT:w500000",
    accountId: "WaLLeT",
    window: "w500000",
  };

  it("is reproducible by anyone who has the revealed seed", async () => {
    const seed = await deriveEpochSeed(SECRET, EPOCH);
    const roll = await commitRevealRoll(seed, input);
    expect(roll).toBeGreaterThanOrEqual(0);
    expect(roll).toBeLessThan(1);
    expect(await commitRevealRoll(seed, input)).toBe(roll);
    expect(commitRevealMessage(input)).toBe(
      "diggo.discovery.commit-reveal.v1|" + EPOCH + "|" + input.eventId + "|WaLLeT|w500000",
    );
  });

  it("separates hit, target and rarity draws by purpose and by account", async () => {
    const seed = await deriveEpochSeed(SECRET, EPOCH);
    const hit = await commitRevealRoll(seed, input);
    const target = await commitRevealRoll(seed, { ...input, eventId: input.eventId + ":target" });
    const rarity = await commitRevealRoll(seed, { ...input, eventId: input.eventId + ":rarity" });
    const otherAccount = await commitRevealRoll(seed, { ...input, accountId: "SoMeOnE" });
    const otherWindow = await commitRevealRoll(seed, { ...input, window: "w500001" });
    expect(new Set([hit, target, rarity, otherAccount, otherWindow]).size).toBe(5);
  });

  it("changes entirely from one epoch to the next", async () => {
    const first = await commitRevealRoll(await deriveEpochSeed(SECRET, EPOCH), input);
    const second = await commitRevealRoll(await deriveEpochSeed(SECRET, EPOCH + 1), {
      ...input,
      epoch: EPOCH + 1,
    });
    expect(second).not.toBe(first);
  });
});

describe("RandomSource seam for a later VRF (spec 55)", () => {
  const request = { serverSecret: "", eventId: "dsc:v1:w:1", accountId: "w", window: 1 };

  it("implements the RandomSource interface over the epoch seed", async () => {
    const seed = await deriveEpochSeed(SECRET, 9);
    const source = createCommitRevealRandomSource(9, seed);
    const bound = { ...request, serverSecret: seed };
    expect(source.kind).toBe(COMMIT_REVEAL_ALGORITHM);
    expect(await source.roll(bound)).toBe(
      await commitRevealRoll(seed, { epoch: 9, eventId: request.eventId, accountId: "w", window: 1 }),
    );
    const bytes = await source.deriveBytes(bound, 16);
    expect(bytes).toHaveLength(16);
    expect(await source.deriveBytes(bound, 16)).toEqual(bytes);
  });

  it("refuses a seed other than its own epoch seed", async () => {
    const seed = await deriveEpochSeed(SECRET, 9);
    const source = createCommitRevealRandomSource(9, seed);
    const forged = { ...request, serverSecret: await deriveEpochSeed(SECRET, 10) };
    await expect(source.roll(forged)).rejects.toThrow();
    await expect(source.deriveBytes(forged, 8)).rejects.toThrow();
  });
});

describe("epoch arithmetic", () => {
  it("buckets timestamps into half-open epochs", () => {
    expect(epochOf(0)).toBe(0);
    expect(epochOf(DEFAULT_EPOCH_SECONDS - 1)).toBe(0);
    expect(epochOf(DEFAULT_EPOCH_SECONDS)).toBe(1);
    expect(epochInfo(1)).toEqual({
      epoch: 1,
      epochSeconds: DEFAULT_EPOCH_SECONDS,
      startsAt: DEFAULT_EPOCH_SECONDS,
      endsAt: 2 * DEFAULT_EPOCH_SECONDS,
    });
    expect(epochInfo(2, 3_600)).toEqual({ epoch: 2, epochSeconds: 3_600, startsAt: 7_200, endsAt: 10_800 });
    // A nonsense epoch length falls back to the shipped default rather than producing NaN windows.
    expect(epochInfo(1, 0).epochSeconds).toBe(DEFAULT_EPOCH_SECONDS);
    expect(epochInfo(-5).epoch).toBe(0);
  });

  it("publishes a verification recipe a third party can follow", () => {
    const recipe = rollVerificationRecipe();
    expect(recipe.domain).toContain("commit-reveal");
    expect(recipe.message).toContain("eventId");
    expect(recipe.commitmentAlgorithm).toBe("commitment = sha256_hex(seed)");
    expect(recipe.seedDerivation).toContain(SEED_DERIVATION_DOMAIN);
  });
});