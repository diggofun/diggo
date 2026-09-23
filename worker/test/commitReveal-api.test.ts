/**
 * The public half of the commit-reveal RNG (spec 55, 56).
 *
 * worker/discovery.ts decides the rolls; these tests are about the promise it makes around them: the
 * commitment for an epoch is on record before that epoch's first roll, the seed never leaves the
 * API while the epoch is still running, and once the epoch ends the seed is enough for anyone to
 * recompute the roll that produced a real grant.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DIGGO_CONFIG } from "../../shared/config";
import {
  commitmentOf,
  commitRevealRoll,
  deriveEpochSeed,
  epochOf,
  verifyCommitment,
} from "../../shared/commitReveal";
import { rollDiscoveryRarity } from "../../shared/rarity";
import {
  discoveryCommitmentReveal,
  discoveryCommitments,
  prepublishRngCommitments,
  rollDiscovery,
} from "../discovery";
import type { RuntimeEnv } from "../env";
import {
  DAY,
  countRows,
  createHarness,
  readValue,
  seedPlayer,
  seedPriceSample,
  seedToken,
  seedTrade,
  type DiscoveryTestHarness,
} from "./discovery-d1";

const NOW_MS = 1_800_000_123_000;
const NOW = Math.floor(NOW_MS / 1_000);
const EPOCH_SECONDS = 86_400;
const EPOCH = epochOf(NOW, EPOCH_SECONDS);
const EPOCH_ENDS_AT = (EPOCH + 1) * EPOCH_SECONDS;
const SECRET = "test-discovery-secret-0123456789";
/** Sorted ascending, which is the order candidateTokens returns them in. */
const MINTS = [
  "AaMine11111111111111111111111111111111111111",
  "BbMine11111111111111111111111111111111111111",
  "CcMine11111111111111111111111111111111111111",
];

let harness: DiscoveryTestHarness;
let env: RuntimeEnv;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW_MS));
  harness = createHarness();
  env = harness.env;
});

afterEach(() => {
  harness.close();
  vi.useRealTimers();
});

/** Three healthy mines and one eligible Crew: everything a legitimate roll needs. */
function seedEligibleWallet(wallet: string): void {
  seedPlayer(env, wallet);
  for (const mint of MINTS) {
    // The price history belongs to the mint, not to the wallet, so a second eligible wallet in the
    // same test reuses it instead of writing the same observation twice.
    if (readValue<number>(env, "SELECT COUNT(*) AS total FROM token_price_samples WHERE mint = '" + mint + "'", "total")) {
      continue;
    }
    seedToken(env, { mint, priceUsd: 0.01, discoveryReserveRemaining: 5_000, symbol: mint.slice(0, 4) });
    for (let index = 0; index < 3; index += 1) {
      seedPriceSample(env, mint, 0.01, NOW - 60 * (index + 1));
    }
    seedTrade(env, mint, 0.01, 1_000_000, NOW - 600);
  }
}

function get(path: string): Request {
  return new Request("https://diggo.fun" + path);
}

function commitmentRow(epoch: number): { commitment: string; seed: string | null } | null {
  const row = readValue<string>(
    env,
    "SELECT commitment FROM rng_commitments WHERE epoch = " + epoch,
    "commitment",
  );
  if (row === null) return null;
  return {
    commitment: row,
    seed: readValue<string>(env, "SELECT seed FROM rng_commitments WHERE epoch = " + epoch, "seed"),
  };
}

async function commitmentBody(epoch: number): Promise<{
  commitment: { epoch: number; commitment: string; seed: string | null; revealed: boolean; endsAt: number };
  verification: { domain: string };
}> {
  const response = await discoveryCommitmentReveal(get("/api/discovery/commitments/" + epoch), env, String(epoch));
  expect(response.status).toBe(200);
  return (await response.json()) as never;
}

describe("publication (spec 55)", () => {
  it("records a commitment for the epoch before that epoch's first roll", async () => {
    const wallet = "WaLLeT1111111111111111111111111111111111111";
    seedEligibleWallet(wallet);

    // Nothing is published until something needs the epoch's seed or cron asks for it.
    expect(commitmentRow(EPOCH)).toBeNull();
    await rollDiscovery(env, wallet, null);

    const row = commitmentRow(EPOCH);
    expect(row).not.toBeNull();
    const seed = await deriveEpochSeed(SECRET, EPOCH);
    expect(row!.commitment).toBe(await commitmentOf(seed));
    expect(await verifyCommitment(seed, row!.commitment)).toBe(true);
  });

  it("pre-publishes the next epoch and reveals the epochs that have ended", async () => {
    const summary = await prepublishRngCommitments(env, NOW);
    expect(summary.currentEpoch).toBe(EPOCH);
    expect(summary.nextEpoch).toBe(EPOCH + 1);
    expect(summary.published).toEqual([EPOCH, EPOCH + 1]);
    expect(summary.revealed).toEqual([]);
    expect(commitmentRow(EPOCH + 1)).not.toBeNull();

    // Time travel past the end of the next epoch: its seed is revealed, the one after is published.
    const later = EPOCH_ENDS_AT + EPOCH_SECONDS + 60;
    const revealed = await prepublishRngCommitments(env, later);
    expect(revealed.revealed).toContain(EPOCH);
    expect(revealed.revealed).toContain(EPOCH + 1);
    expect(await verifyCommitment(
      await deriveEpochSeed(SECRET, EPOCH),
      commitmentRow(EPOCH)!.commitment,
    )).toBe(true);
  });

  it("cannot unseal a running epoch, even by running the reveal statement directly", async () => {
    await prepublishRngCommitments(env, NOW);
    const premature = await env.DB.prepare(
      "UPDATE rng_commitments SET seed = ?1, revealed_at = ?2 WHERE epoch = ?3 AND ends_at <= ?2 AND seed IS NULL",
    )
      .bind("ff".repeat(32), EPOCH_ENDS_AT - 1, EPOCH)
      .run();
    expect(premature.meta.changes).toBe(0);
    expect(commitmentRow(EPOCH)!.seed).toBeNull();
  });

  it("refuses to roll once the secret no longer matches the published commitment", async () => {
    const first = "WaLLeT1111111111111111111111111111111111111";
    seedEligibleWallet(first);
    expect(await rollDiscovery(env, first, null)).not.toBeNull();

    // Rotating the secret makes the epoch derive a different seed than the one already committed to,
    // and the epoch is then unverifiable. Failing closed costs one roll; rolling anyway would hand
    // out an outcome nobody can check.
    (env as unknown as { DISCOVERY_SECRET: string }).DISCOVERY_SECRET = "rotated-discovery-secret-0123456789";
    const second = "OtHeR11111111111111111111111111111111111111";
    seedEligibleWallet(second);
    expect(await rollDiscovery(env, second, null)).toBeNull();
    expect(
      countRows(env, "SELECT COUNT(*) AS total FROM metrics_counters WHERE name = 'discovery.commitment_mismatch'"),
    ).toBeGreaterThan(0);
  });
});

describe("the seed stays sealed (spec 55, 56)", () => {
  it("is absent from both endpoints while the epoch is running", async () => {
    const wallet = "WaLLeT1111111111111111111111111111111111111";
    seedEligibleWallet(wallet);
    const discovery = await rollDiscovery(env, wallet, null);
    expect(discovery).not.toBeNull();

    const list = await discoveryCommitments(get("/api/discovery/commitments"), env);
    const body = (await list.json()) as {
      currentEpoch: number;
      current: { commitment: string; seed: string | null; revealed: boolean };
      next: { epoch: number; seed: string | null };
      revealedEpochs: unknown[];
    };
    expect(body.currentEpoch).toBe(EPOCH);
    expect(body.current.commitment).toMatch(new RegExp("^[0-9a-f]{64}$"));
    expect(body.current.seed).toBeNull();
    expect(body.current.revealed).toBe(false);
    expect(body.next.epoch).toBe(EPOCH + 1);
    expect(body.next.seed).toBeNull();
    expect(body.revealedEpochs).toEqual([]);

    const single = await commitmentBody(EPOCH);
    expect(single.commitment.seed).toBeNull();
    expect(single.commitment.revealed).toBe(false);
    expect(single.verification.domain).toContain("commit-reveal");

    // The seed is genuinely unavailable, not merely unlisted: it is not in the row either.
    expect(commitmentRow(EPOCH)!.seed).toBeNull();
  });

  it("hides a seed that is already stored while its epoch is still running", async () => {
    await prepublishRngCommitments(env, NOW);
    // Plant a seed behind the running epoch's commitment, as a bug or a manual reveal would.
    await env.DB.prepare("UPDATE rng_commitments SET seed = ?1, revealed_at = ?2 WHERE epoch = ?3")
      .bind("ab".repeat(32), NOW, EPOCH)
      .run();

    const running = await commitmentBody(EPOCH);
    expect(running.commitment.seed).toBeNull();
    expect(running.commitment.revealed).toBe(false);

    // The endpoint keys on the epoch's own end time, so the same stored seed appears once it is
    // legitimate to show it.
    vi.setSystemTime(new Date((EPOCH_ENDS_AT + 60) * 1_000));
    const ended = await commitmentBody(EPOCH);
    expect(ended.commitment.seed).toBe("ab".repeat(32));
    expect(ended.commitment.revealed).toBe(true);
  });

  it("answers 404 for an epoch nobody committed to", async () => {
    const unknown = await discoveryCommitmentReveal(get("/api/discovery/commitments/999999"), env, "999999");
    expect(unknown.status).toBe(404);
    const malformed = await discoveryCommitmentReveal(get("/api/discovery/commitments/abc"), env, "abc");
    expect(malformed.status).toBe(404);
  });
});

describe("verification after the fact (spec 55)", () => {
  it("publishes a seed that reproduces the target and the rarity of a real grant", async () => {
    const wallet = "WaLLeT1111111111111111111111111111111111111";
    seedEligibleWallet(wallet);
    const discovery = await rollDiscovery(env, wallet, null);
    expect(discovery).not.toBeNull();

    const opportunity = await env.DB.prepare(
      "SELECT event_id, window FROM discovery_opportunities WHERE wallet = ?1",
    )
      .bind(wallet)
      .first<{ event_id: string; window: string }>();
    expect(opportunity).not.toBeNull();

    // Nothing is revealed yet, so a player cannot check - and cannot predict either.
    vi.setSystemTime(new Date((EPOCH_ENDS_AT + 60) * 1_000));
    const body = await commitmentBody(EPOCH);
    const seed = body.commitment.seed;
    expect(seed).not.toBeNull();
    const commitment = commitmentRow(EPOCH)!.commitment;
    expect(await verifyCommitment(seed!, commitment)).toBe(true);
    expect(commitmentRow(EPOCH)!.seed).toBe(seed);

    const base = { epoch: EPOCH, accountId: wallet, window: opportunity!.window };
    // The target draw is part of the event id, so the same seed selects exactly one candidate.
    const targetRoll = await commitRevealRoll(seed!, { ...base, eventId: opportunity!.event_id + ":target" });
    const expectedMint = MINTS[Math.min(MINTS.length - 1, Math.floor(targetRoll * MINTS.length))];
    expect(discovery!.mint).toBe(expectedMint);

    // And the rarity the player received can never be better than the rarity the seed rolled.
    const rarityRoll = await commitRevealRoll(seed!, { ...base, eventId: opportunity!.event_id + ":rarity" });
    const rolled = rollDiscoveryRarity(rarityRoll, DIGGO_CONFIG);
    const tierIndex = (rarity: string): number =>
      DIGGO_CONFIG.rarity.tiers.findIndex((tier) => tier.rarity === rarity);
    expect(tierIndex(discovery!.rarity)).toBeLessThanOrEqual(tierIndex(rolled));
    expect(tierIndex(discovery!.rarity)).toBeGreaterThanOrEqual(0);
  });

  it("explains a miss as well as a grant: the revealed seed decides the outcome", async () => {
    const wallet = "MiSsEr111111111111111111111111111111111111";
    seedEligibleWallet(wallet);
    // A one-in-ten-thousand window chance, so the outcome is whatever the seed says it is.
    const rare = createHarness({ rollChanceBps: 1 });
    try {
      seedPlayer(rare.env, wallet);
      for (const mint of MINTS) {
        seedToken(rare.env, { mint, priceUsd: 0.01, discoveryReserveRemaining: 5_000 });
        for (let index = 0; index < 3; index += 1) {
          seedPriceSample(rare.env, mint, 0.01, NOW - 60 * (index + 1));
        }
        seedTrade(rare.env, mint, 0.01, 1_000_000, NOW - 600);
      }
      const discovery = await rollDiscovery(rare.env, wallet, null);
      const opportunity = await rare.env.DB.prepare(
        "SELECT event_id, window FROM discovery_opportunities WHERE wallet = ?1",
      )
        .bind(wallet)
        .first<{ event_id: string; window: string }>();
      const seed = await deriveEpochSeed(SECRET, EPOCH);
      const hitRoll = await commitRevealRoll(seed, {
        epoch: EPOCH,
        eventId: opportunity!.event_id,
        accountId: wallet,
        window: opportunity!.window,
      });
      // 1 basis point of 10000: the recomputed roll either cleared it or did not, and the server's
      // answer has to agree with it.
      if (hitRoll < 0.0001) expect(discovery).not.toBeNull();
      else expect(discovery).toBeNull();
    } finally {
      rare.close();
    }
  });

  it("keeps the revealed epoch in the history the list endpoint returns", async () => {
    await prepublishRngCommitments(env, NOW);
    vi.setSystemTime(new Date((EPOCH_ENDS_AT + 120) * 1_000));
    const response = await discoveryCommitments(get("/api/discovery/commitments"), env);
    const body = (await response.json()) as {
      currentEpoch: number;
      revealedEpochs: { epoch: number; seed: string | null; revealed: boolean }[];
    };
    expect(body.currentEpoch).toBe(EPOCH + 1);
    const revealed = body.revealedEpochs.find((entry) => entry.epoch === EPOCH);
    expect(revealed).toBeDefined();
    expect(revealed!.revealed).toBe(true);
    expect(await verifyCommitment(revealed!.seed!, commitmentRow(EPOCH)!.commitment)).toBe(true);
  });

  it("derives the same commitment in two independent environments", async () => {
    const second = createHarness();
    try {
      const first = await prepublishRngCommitments(env, NOW);
      const other = await prepublishRngCommitments(second.env, NOW);
      expect(other.published).toEqual(first.published);
      const a = readValue<string>(env, "SELECT commitment FROM rng_commitments WHERE epoch = " + EPOCH, "commitment");
      const b = readValue<string>(
        second.env,
        "SELECT commitment FROM rng_commitments WHERE epoch = " + EPOCH,
        "commitment",
      );
      expect(b).toBe(a);
    } finally {
      second.close();
    }
  });
});

describe("epoch length", () => {
  it("uses a day by default and refuses to roll a floor beyond the bounds", async () => {
    await prepublishRngCommitments(env, NOW);
    expect(
      readValue<number>(env, "SELECT epoch_seconds FROM rng_commitments WHERE epoch = " + EPOCH, "epoch_seconds"),
    ).toBe(DAY);
    expect(EPOCH_SECONDS).toBe(DAY);

    const short = createHarness();
    try {
      (short.env as unknown as { DISCOVERY_EPOCH_SECONDS: string }).DISCOVERY_EPOCH_SECONDS = "1";
      await prepublishRngCommitments(short.env, NOW);
      // Clamped up to the one-hour floor rather than producing an epoch per second.
      expect(
        readValue<number>(short.env, "SELECT epoch_seconds FROM rng_commitments LIMIT 1", "epoch_seconds"),
      ).toBe(3_600);
    } finally {
      short.close();
    }
  });
});
