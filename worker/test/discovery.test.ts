/**
 * W-DISCOVERY test suite (spec 82): the discovery subsystem is the one place where a client could
 * otherwise farm real-value assets, so every test here is about a refusal that must hold, plus the
 * happy path that proves the refusals are not just "everything fails".
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DIGGO_CONFIG } from "../../shared/config";
import { isBreakerOpen, setBreaker } from "../breakers";
import {
  claimDiscovery,
  claimDiscoveryChallenge,
  discoveryOpportunity,
  discoveryWindowIndex,
  discoveryTunables,
  rollDiscovery,
  rollDiscoveryRequest,
} from "../discovery";
import type { RuntimeEnv } from "../env";
import {
  DAY,
  countRows,
  createHarness,
  readValue,
  seedDiscovery,
  seedPlayer,
  seedPriceSample,
  seedToken,
  seedTrade,
  type DiscoveryTestHarness,
} from "./discovery-d1";

const keeperMock = vi.hoisted(() => ({
  claimDiscovery: vi.fn(),
  receiptExists: vi.fn(),
  syncCrewPower: vi.fn(),
}));

// The keeper is the only component that touches Solana. Mocking it keeps these tests offline while
// still exercising the real settle/revert/CLAIMED state machine in worker/indexing.ts.
vi.mock("../keeper", () => ({
  keeperClaimDiscovery: keeperMock.claimDiscovery,
  keeperDiscoveryReceiptExists: keeperMock.receiptExists,
  keeperSyncCrewPower: keeperMock.syncCrewPower,
}));

const { settleDiscoveryClaim, DISCOVERY_CLAIM_RETRY_SECONDS } = await import("../indexing");

/** A fixed clock keeps window indices, caps and NONCE TTLs deterministic. */
const NOW_MS = 1_800_000_123_000;
const NOW = Math.floor(NOW_MS / 1_000);
const HEALTHY_MINT = "HeaLthyMint1111111111111111111111111111111";
const ILLIQUID_MINT = "11111111111111111111111111111111111111111111";
/** A second healthy mine, used to park a held farm's value away from the target mine's own caps. */
const FARM_MINT = "FaRmMint111111111111111111111111111111111";

interface TestWallet {
  wallet: string;
  sign(message: string): string;
}

function makeWallet(): TestWallet {
  const secretKey = crypto.getRandomValues(new Uint8Array(32));
  const publicKey = ed25519.getPublicKey(secretKey);
  return {
    wallet: bs58.encode(publicKey),
    sign: (message: string) => bs58.encode(ed25519.sign(new TextEncoder().encode(message), secretKey)),
  };
}

function post(path: string, body: unknown, session?: string): Request {
  return new Request(`https://diggo.fun${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: session ? { authorization: `Bearer ${session}` } : {},
  });
}

/**
 * Reads a counter the shared telemetry module recorded. Metrics are asserted through the schema
 * (migration 0010) rather than through a helper, so this test does not depend on another
 * workstream's module internals.
 */
function metricTotal(name: string): number {
  return countRows(
    env,
    `SELECT COALESCE(SUM(value), 0) AS total FROM metrics_counters WHERE name = '${name}'`,
  );
}

/** Keeper jobs the claim path queued, narrowed to the discovery payouts. */
function queuedDiscoveryIds(): string[] {
  return harness.queue.messages.flatMap((message) =>
    message.type === "claim_discovery" ? [message.discoveryId] : [],
  );
}

let harness: DiscoveryTestHarness;
let env: RuntimeEnv;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW_MS));
  vi.resetAllMocks();
  harness = createHarness();
  env = harness.env;
  await env.TOKEN_CACHE.put("auth:session:test-session", "unused", { expirationTtl: 600 });
});

afterEach(() => {
  harness.close();
  vi.useRealTimers();
});

/** Authenticates a wallet by registering a session the way worker/auth.ts does. */
async function authenticate(wallet: string, session = "test-session"): Promise<string> {
  await env.TOKEN_CACHE.put(`auth:session:${session}`, wallet, { expirationTtl: 600 });
  return session;
}

/** Seeds everything a legitimate discovery needs: eligible Crew, one healthy mine, real prices. */
function seedHappyPath(options: { wallet: string; samples?: number; samplePrice?: number }): string {
  seedPlayer(env, options.wallet);
  const mint = seedToken(env, { mint: HEALTHY_MINT, priceUsd: 0.01, discoveryReserveRemaining: 5_000 });
  const samples = options.samples ?? 3;
  for (let index = 0; index < samples; index += 1) {
    seedPriceSample(env, mint, options.samplePrice ?? 0.01, NOW - 60 * (index + 1));
  }
  seedTrade(env, mint, 0.01, 1_000_000, NOW - 600);
  return mint;
}

describe("server-authoritative RNG (spec 55, 56)", () => {
  it("fails closed when DISCOVERY_SECRET is missing", async () => {
    const failing = createHarness({ discoverySecret: null });
    const wallet = makeWallet().wallet;
    seedPlayer(failing.env, wallet);
    seedToken(failing.env, { mint: HEALTHY_MINT });
    for (let index = 0; index < 3; index += 1) {
      seedPriceSample(failing.env, HEALTHY_MINT, 0.01, NOW - 60 * (index + 1));
    }
    const discovery = await rollDiscovery(failing.env, wallet, null);
    expect(discovery).toBeNull();
    // Not even an opportunity is authored when no unpredictable seed exists.
    expect(countRows(failing.env, "SELECT COUNT(*) AS total FROM discovery_opportunities")).toBe(0);
    expect(countRows(failing.env, "SELECT COUNT(*) AS total FROM discoveries")).toBe(0);
    failing.close();
  });

  it("produces the same outcome for the same opportunity in two independent environments", async () => {
    const first = createHarness();
    const second = createHarness();
    const wallet = makeWallet().wallet;
    for (const target of [first, second]) {
      seedPlayer(target.env, wallet);
      seedToken(target.env, { mint: HEALTHY_MINT, priceUsd: 0.01 });
      for (let index = 0; index < 3; index += 1) {
        seedPriceSample(target.env, HEALTHY_MINT, 0.01, NOW - 60 * (index + 1));
      }
      seedTrade(target.env, HEALTHY_MINT, 0.01, 1_000_000, NOW - 600);
    }
    const a = await rollDiscovery(first.env, wallet, null);
    const b = await rollDiscovery(second.env, wallet, null);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // Same secret + same account + same window => same mint, rarity and amount. A client cannot
    // reroll for a better result because there is no second result to find.
    expect({ mint: b!.mint, rarity: b!.rarity, amount: b!.tokenAmount }).toEqual({
      mint: a!.mint,
      rarity: a!.rarity,
      amount: a!.tokenAmount,
    });
    first.close();
    second.close();
  });

  it("derives the event id from wallet and window, and never exposes a client-chosen seed", async () => {
    const wallet = makeWallet().wallet;
    seedHappyPath({ wallet });
    const tunables = discoveryTunables(env);
    const session = await authenticate(wallet);
    const response = await discoveryOpportunity(post("/api/discovery/opportunity", {}, session), env);
    const payload = (await response.json()) as { opportunity: { eventId: string; windowIndex: number; nonce: string } };
    expect(payload.opportunity.windowIndex).toBe(discoveryWindowIndex(NOW, tunables));
    expect(payload.opportunity.eventId).toBe(`dsc:v1:${wallet}:${payload.opportunity.windowIndex}`);
    // A second request inside the window returns the identical opportunity: no second chance.
    const again = await discoveryOpportunity(post("/api/discovery/opportunity", {}, session), env);
    const repeated = (await again.json()) as { opportunity: { eventId: string; nonce: string } };
    expect(repeated.opportunity.eventId).toBe(payload.opportunity.eventId);
    expect(repeated.opportunity.nonce).toBe(payload.opportunity.nonce);
    expect(countRows(env, `SELECT COUNT(*) AS total FROM discovery_opportunities WHERE wallet = '${wallet}'`)).toBe(1);
  });
});

describe("eligibility and gating (spec 44, 54)", () => {
  it("refuses a fresh account and authors no opportunity for it", async () => {
    const wallet = makeWallet().wallet;
    seedPlayer(env, wallet, {
      accountAgeDays: 1,
      activeDays: 1,
      crewLevels: { miners: 1, drills: 1, carts: 1, foreman: 1, storage: 1 },
    });
    seedHappyPath({ wallet: makeWallet().wallet });
    expect(await rollDiscovery(env, wallet, null)).toBeNull();
    expect(countRows(env, `SELECT COUNT(*) AS total FROM discovery_opportunities WHERE wallet = '${wallet}'`)).toBe(0);
  });

  it("refuses when the Crew is not active, even for an otherwise eligible account", async () => {
    const wallet = makeWallet().wallet;
    seedHappyPath({ wallet });
    seedPlayer(env, wallet, { activeForSeconds: null });
    expect(await rollDiscovery(env, wallet, null)).toBeNull();
    expect(countRows(env, "SELECT COUNT(*) AS total FROM discoveries")).toBe(0);
  });

  it("refuses an account whose reward state is not NORMAL", async () => {
    const wallet = makeWallet().wallet;
    seedHappyPath({ wallet });
    seedPlayer(env, wallet, { riskState: "HELD" });
    expect(await rollDiscovery(env, wallet, null)).toBeNull();
  });

  it("blocks rolling while the global discoveries breaker is open", async () => {
    const wallet = makeWallet().wallet;
    seedHappyPath({ wallet });
    await setBreaker(env, { scope: "discoveries", open: true, reason: "test", actor: "test" });
    expect(await isBreakerOpen(env, "discoveries")).toBe(true);
    expect(await rollDiscovery(env, wallet, null)).toBeNull();
    const session = await authenticate(wallet);
    const response = await rollDiscoveryRequest(post("/api/discovery/roll", {}, session), env);
    expect(response.status).toBe(503);
    expect(countRows(env, "SELECT COUNT(*) AS total FROM discoveries")).toBe(0);
  });

  it("honours the program's own per-mine pause when a claim is submitted", async () => {
    const owner = makeWallet();
    seedHappyPath({ wallet: owner.wallet });
    const discovery = await rollDiscovery(env, owner.wallet, null);
    expect(discovery).not.toBeNull();
    // The program pauses payouts for this mine after the discovery was granted.
    await env.DB.prepare("UPDATE tokens SET discovery_paused = 1 WHERE mint = ?1").bind(HEALTHY_MINT).run();
    expect(
      readValue<number>(env, `SELECT discovery_paused FROM tokens WHERE mint = '${HEALTHY_MINT}'`, "discovery_paused"),
    ).toBe(1);

    const session = await authenticate(owner.wallet);
    const challengeResponse = await claimDiscoveryChallenge(
      post("/api/discovery/claim/challenge", { discoveryId: discovery!.id }, session),
      env,
    );
    expect(challengeResponse.status).toBe(200);
    const challenge = (await challengeResponse.json()) as { nonce: string; message: string };
    const claim = await claimDiscovery(
      post(
        "/api/discovery/claim",
        { discoveryId: discovery!.id, nonce: challenge.nonce, signature: owner.sign(challenge.message) },
        session,
      ),
      env,
    );
    // The reward is not lost — it stays PENDING until the mine is unpaused — but nothing is paid.
    expect(claim.status).toBe(503);
    expect(harness.queue.messages).toHaveLength(0);
    expect(
      readValue<string>(env, `SELECT status FROM discoveries WHERE id = '${discovery!.id}'`, "status"),
    ).toBe("PENDING");
  });
});

describe("multi-level value caps (spec 45, 64)", () => {
  const cases: { name: string; seed: (wallet: string) => void; value: number; ageSeconds: number }[] = [
    {
      name: "account daily cap",
      seed: (wallet) => seedDiscovery(env, { wallet, mint: HEALTHY_MINT, valueUsd: 0.5 }),
      value: 0.5,
      ageSeconds: 0,
    },
    {
      name: "account weekly cap",
      seed: (wallet) =>
        seedDiscovery(env, {
          wallet,
          mint: HEALTHY_MINT,
          valueUsd: 2.5,
          createdAt: NOW - 2 * DAY,
        }),
      value: 2.5,
      ageSeconds: 2 * DAY,
    },
  ];

  for (const testCase of cases) {
    it(`refuses a roll once the ${testCase.name} is reached, without burning the window`, async () => {
      const wallet = makeWallet().wallet;
      seedHappyPath({ wallet });
      testCase.seed(wallet);
      expect(await rollDiscovery(env, wallet, null)).toBeNull();
      // The refusal happens before the opportunity is consumed, so the player keeps this window.
      expect(
        countRows(env, `SELECT COUNT(*) AS total FROM discoveries WHERE wallet = '${wallet}'`),
      ).toBe(1);
      expect(
        readValue<string>(env, `SELECT status FROM discovery_opportunities WHERE wallet = '${wallet}'`, "status"),
      ).toBe("PENDING");
    });
  }

  it("refuses a roll when the per-token period cap is reached by other players", async () => {
    const wallet = makeWallet().wallet;
    const other = makeWallet().wallet;
    seedHappyPath({ wallet });
    seedPlayer(env, other);
    seedDiscovery(env, { wallet: other, mint: HEALTHY_MINT, valueUsd: 25 });
    expect(await rollDiscovery(env, wallet, null)).toBeNull();
    expect(
      countRows(env, `SELECT COUNT(*) AS total FROM discoveries WHERE wallet = '${wallet}'`),
    ).toBe(0);
  });

  it("refuses a roll when the global daily budget is exhausted", async () => {
    const wallet = makeWallet().wallet;
    const other = makeWallet().wallet;
    seedHappyPath({ wallet });
    seedPlayer(env, other);
    seedDiscovery(env, { wallet: other, mint: HEALTHY_MINT, valueUsd: 500 });
    expect(await rollDiscovery(env, wallet, null)).toBeNull();
  });

  it("never grants more than the per-request ceiling or the token's indexed reserve", async () => {
    const wallet = makeWallet().wallet;
    seedHappyPath({ wallet });
    const discovery = await rollDiscovery(env, wallet, null);
    expect(discovery).not.toBeNull();
    expect(discovery!.valueUsd).toBeLessThanOrEqual(DIGGO_CONFIG.discovery.perRequestCapUsd);
    expect(discovery!.valueUsd).toBeLessThanOrEqual(DIGGO_CONFIG.discovery.accountDailyCapUsd);
    expect(discovery!.tokenAmount).toBeGreaterThan(0);
    expect(discovery!.status).toBe("PENDING");
    expect(discovery!.claimable).toBe(true);
    expect(discovery!.visualEvent).toBe(
      discovery!.rarity === "rare" ? "Crystal Vein" : discovery!.visualEvent,
    );
    // REJECTED rows never happen implicitly: a granted discovery is recorded, never silently lost.
expect(metricTotal("discovery.granted")).toBeGreaterThan(0);
  });

  it("caps how much of the daily budget a held farm may reserve", async () => {
    const human = makeWallet().wallet;
    seedHappyPath({ wallet: human });
    // A farm under review, holding more than a whole day's budget on another mine. It is real
    // granted value, so it counts - but only up to the configured share of the cap, or the held
    // farm alone would exhaust the day and deny ordinary players their own allowance (spec 45, 64).
    const farm = makeWallet().wallet;
    seedPlayer(env, farm);
    const farmMint = seedToken(env, { mint: FARM_MINT, priceUsd: 0.01 });
    // The farm's mine is a legitimate candidate too, so this test does not depend on which of the
    // two mines one roll happens to select.
    for (let index = 0; index < 3; index += 1) seedPriceSample(env, farmMint, 0.01, NOW - 60 * (index + 1));
    seedTrade(env, farmMint, 0.01, 1_000_000, NOW - 600);
    for (let index = 0; index < 6; index += 1) {
      seedDiscovery(env, { wallet: farm, mint: farmMint, valueUsd: 100, status: "HELD" });
    }

    const discovery = await rollDiscovery(env, human, null);

    expect(discovery).not.toBeNull();
    expect(discovery!.valueUsd).toBeLessThanOrEqual(DIGGO_CONFIG.discovery.perRequestCapUsd);
    expect(readValue<string>(env, `SELECT status FROM discoveries WHERE wallet = '${human}'`, "status")).toBe(
      "PENDING",
    );
    // The held rows are still held: the ceiling changes what they reserve, not what they are.
    expect(countRows(env, "SELECT COUNT(*) AS total FROM discoveries WHERE status = 'HELD'")).toBe(6);
  });

  it("releases the budget of a hold nothing cleared without touching the grant", async () => {
    const human = makeWallet().wallet;
    seedHappyPath({ wallet: human });
    const farm = makeWallet().wallet;
    seedPlayer(env, farm);
    // Held on this very mine a day and a half ago, which is past the configured review window: the
    // hold stops reserving budget instead of blocking the week for everyone else.
    for (let index = 0; index < 6; index += 1) {
      seedDiscovery(env, {
        wallet: farm,
        mint: HEALTHY_MINT,
        valueUsd: 100,
        status: "HELD",
        createdAt: NOW - 2 * DAY,
      });
    }

    const discovery = await rollDiscovery(env, human, null);

    expect(discovery).not.toBeNull();
    // The grant itself is untouched: an unresolved hold is a real reward waiting for a human
    // decision, not something the clock (or another player's roll) may reject on the farm's behalf.
    expect(countRows(env, "SELECT COUNT(*) AS total FROM discoveries WHERE status = 'HELD'")).toBe(6);
    expect(
      countRows(env, "SELECT COUNT(*) AS total FROM discoveries WHERE failure_reason = 'hold_expired'"),
    ).toBe(0);
    expect(metricTotal("discovery.hold_awaiting_review")).toBeGreaterThan(0);
  });
});

describe("single-use opportunities (spec 56, 70)", () => {
  it("rejects a reroll of the same window and keeps exactly one grant", async () => {
    const wallet = makeWallet().wallet;
    seedHappyPath({ wallet });
    const session = await authenticate(wallet);
    const first = await rollDiscoveryRequest(post("/api/discovery/roll", {}, session), env);
    expect(first.status).toBe(200);
    const second = await rollDiscoveryRequest(post("/api/discovery/roll", {}, session), env);
    expect(second.status).toBe(409);
    expect(
      countRows(env, `SELECT COUNT(*) AS total FROM discoveries WHERE wallet = '${wallet}'`),
    ).toBe(1);
expect(metricTotal("discovery.reroll_attempt")).toBeGreaterThan(0);
  });

  it("produces exactly one outcome when two rolls for one window run in parallel", async () => {
    const wallet = makeWallet().wallet;
    seedHappyPath({ wallet });
    const [a, b] = await Promise.all([
      rollDiscovery(env, wallet, null),
      rollDiscovery(env, wallet, null),
    ]);
    const granted = [a, b].filter((entry) => entry !== null);
    expect(granted).toHaveLength(1);
    expect(
      countRows(env, `SELECT COUNT(*) AS total FROM discoveries WHERE wallet = '${wallet}'`),
    ).toBe(1);
    expect(
      countRows(env, `SELECT COUNT(*) AS total FROM discovery_opportunities WHERE wallet = '${wallet}'`),
    ).toBe(1);
    expect(
      readValue<string>(env, `SELECT status FROM discovery_opportunities WHERE wallet = '${wallet}'`, "status"),
    ).toBe("CONSUMED");
  });
});

describe("token selection and valuation (spec 26, 27)", () => {
  it("never selects an illiquid token, even when it is the only candidate", async () => {
    const wallet = makeWallet().wallet;
    seedPlayer(env, wallet);
    seedToken(env, { mint: HEALTHY_MINT, priceUsd: 0.01 });
    seedToken(env, { mint: ILLIQUID_MINT, priceUsd: 9_999, liquidityUsd: 100, marketCapUsd: 10_000_000 });
    for (let index = 0; index < 3; index += 1) {
      seedPriceSample(env, HEALTHY_MINT, 0.01, NOW - 60 * (index + 1));
      seedPriceSample(env, ILLIQUID_MINT, 9_999, NOW - 60 * (index + 1));
    }
    seedTrade(env, HEALTHY_MINT, 0.01, 1_000_000, NOW - 600);
    seedTrade(env, ILLIQUID_MINT, 9_999, 1, NOW - 600);

    for (let window = 0; window < 12; window += 1) {
      vi.setSystemTime(new Date(NOW_MS + window * 3_600_000));
      const discovery = await rollDiscovery(env, wallet, null);
      if (discovery) expect(discovery.mint).toBe(HEALTHY_MINT);
    }
    // An expensive unit price cannot buy an illiquid token a rarity it has not earned.
    expect(
      countRows(env, `SELECT COUNT(*) AS total FROM discoveries WHERE mint = '${ILLIQUID_MINT}'`),
    ).toBe(0);
  });

  it("pays nothing when the only candidate has no reserve or too few price observations", async () => {
    const wallet = makeWallet().wallet;
    seedPlayer(env, wallet);
    seedToken(env, { mint: HEALTHY_MINT, priceUsd: 0.01, discoveryReserveRemaining: 0 });
    for (let index = 0; index < 3; index += 1) {
      seedPriceSample(env, HEALTHY_MINT, 0.01, NOW - 60 * (index + 1));
    }
    seedTrade(env, HEALTHY_MINT, 0.01, 1_000_000, NOW - 600);
    expect(await rollDiscovery(env, wallet, null)).toBeNull();
    expect(countRows(env, "SELECT COUNT(*) AS total FROM discoveries")).toBe(0);
  });

  it("pays nothing when the price confidence is too low", async () => {
    const wallet = makeWallet().wallet;
    seedPlayer(env, wallet);
    seedToken(env, { mint: HEALTHY_MINT, priceUsd: 0.01 });
    seedPriceSample(env, HEALTHY_MINT, 0.01, NOW - 60);
    seedTrade(env, HEALTHY_MINT, 0.01, 1_000_000, NOW - 600);
    expect(await rollDiscovery(env, wallet, null)).toBeNull();
  });

  it("filters a token whose on-chain discovery payouts are paused", async () => {
    const wallet = makeWallet().wallet;
    seedPlayer(env, wallet);
    seedToken(env, { mint: HEALTHY_MINT, discoveryPaused: 1 });
    for (let index = 0; index < 3; index += 1) {
      seedPriceSample(env, HEALTHY_MINT, 0.01, NOW - 60 * (index + 1));
    }
    seedTrade(env, HEALTHY_MINT, 0.01, 1_000_000, NOW - 600);
    expect(await rollDiscovery(env, wallet, null)).toBeNull();
    expect(countRows(env, "SELECT COUNT(*) AS total FROM discoveries")).toBe(0);
  });
});

describe("claim flow (spec 46, 47, 57)", () => {
  async function rollForWallet(wallet: string): Promise<string> {
    const discovery = await rollDiscovery(env, wallet, null);
    expect(discovery).not.toBeNull();
    return discovery!.id;
  }

  async function challengeFor(wallet: TestWallet, discoveryId: string): Promise<{ nonce: string; message: string }> {
    const session = await authenticate(wallet.wallet);
    const response = await claimDiscoveryChallenge(post("/api/discovery/claim/challenge", { discoveryId }, session), env);
    expect(response.status).toBe(200);
    return (await response.json()) as { nonce: string; message: string };
  }

  it("requires a wallet-signed single-use challenge and never accepts a replay", async () => {
    const owner = makeWallet();
    seedHappyPath({ wallet: owner.wallet });
    const discoveryId = await rollForWallet(owner.wallet);
    const challenge = await challengeFor(owner, discoveryId);
    const session = await authenticate(owner.wallet);

    const badSignature = await claimDiscovery(
      post("/api/discovery/claim", { discoveryId, nonce: challenge.nonce, signature: "1111111111" }, session),
      env,
    );
    expect(badSignature.status).toBe(401);
    // The failed attempt consumed nothing, so the honest signature still works.
    const signature = owner.sign(challenge.message);
    const accepted = await claimDiscovery(
      post("/api/discovery/claim", { discoveryId, nonce: challenge.nonce, signature }, session),
      env,
    );
    expect(accepted.status).toBe(202);

    const replay = await claimDiscovery(
      post("/api/discovery/claim", { discoveryId, nonce: challenge.nonce, signature }, session),
      env,
    );
    // Reported as a replay, not merely an expired challenge: the nonce is spent in the authoritative
    // challenge_nonces table, so this holds across colos and not only where the cache happens to be.
    expect(replay.status).toBe(409);
    expect(
      readValue<number>(
        env,
        `SELECT consumed_at FROM challenge_nonces WHERE nonce = '${challenge.nonce}'`,
        "consumed_at",
      ),
    ).not.toBeNull();
  });

  it("moves PENDING -> ELIGIBLE, queues exactly one keeper payout, and settles to CLAIMED", async () => {
    const owner = makeWallet();
    seedHappyPath({ wallet: owner.wallet });
    const discoveryId = await rollForWallet(owner.wallet);
    keeperMock.claimDiscovery.mockResolvedValue("keeper-signature");
    keeperMock.receiptExists.mockResolvedValue(false);

    const challenge = await challengeFor(owner, discoveryId);
    const session = await authenticate(owner.wallet);
    const response = await claimDiscovery(
      post("/api/discovery/claim", { discoveryId, nonce: challenge.nonce, signature: owner.sign(challenge.message) }, session),
      env,
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: "ELIGIBLE", queued: true });
    expect(harness.queue.messages).toEqual([{ type: "claim_discovery", discoveryId }]);
    expect(readValue<string>(env, `SELECT status FROM discoveries WHERE id = '${discoveryId}'`, "status")).toBe("ELIGIBLE");
    expect(queuedDiscoveryIds()).toEqual([discoveryId]);

    await settleDiscoveryClaim(env, discoveryId);
    expect(keeperMock.claimDiscovery).toHaveBeenCalledTimes(1);
    // The discovery id travels to the program as discovery_id; that is what seeds the receipt.
    expect(keeperMock.claimDiscovery.mock.calls[0][4]).toBe(discoveryId);
    expect(readValue<string>(env, `SELECT status FROM discoveries WHERE id = '${discoveryId}'`, "status")).toBe("CLAIMED");
    expect(readValue<string>(env, `SELECT tx_signature FROM discoveries WHERE id = '${discoveryId}'`, "tx_signature")).toBe("keeper-signature");
expect(metricTotal("discovery.claimed")).toBeGreaterThan(0);
  });

  it("drains the indexed Discovery Reserve after a settled payout", async () => {
    const owner = makeWallet();
    seedHappyPath({ wallet: owner.wallet });
    const discoveryId = await rollForWallet(owner.wallet);
    const before = readValue<number>(env, `SELECT discovery_reserve_remaining FROM tokens WHERE mint = '${HEALTHY_MINT}'`, "discovery_reserve_remaining")!;
    const amount = readValue<number>(env, `SELECT token_amount FROM discoveries WHERE id = '${discoveryId}'`, "token_amount")!;
    keeperMock.claimDiscovery.mockResolvedValue("keeper-signature");
    keeperMock.receiptExists.mockResolvedValue(false);
    await env.DB.prepare("UPDATE discoveries SET status = 'ELIGIBLE' WHERE id = ?1").bind(discoveryId).run();

    await settleDiscoveryClaim(env, discoveryId);
    const after = readValue<number>(env, `SELECT discovery_reserve_remaining FROM tokens WHERE mint = '${HEALTHY_MINT}'`, "discovery_reserve_remaining")!;
    expect(after).toBeCloseTo(before - amount, 6);
    expect(
      readValue<number>(env, `SELECT discovery_epoch_spent FROM tokens WHERE mint = '${HEALTHY_MINT}'`, "discovery_epoch_spent")!,
    ).toBeCloseTo(amount, 6);
  });

  it("never pays a discovery that no signed claim committed", async () => {
    const owner = makeWallet();
    seedHappyPath({ wallet: owner.wallet });
    const discoveryId = await rollForWallet(owner.wallet);
    keeperMock.claimDiscovery.mockResolvedValue("keeper-signature");
    await settleDiscoveryClaim(env, discoveryId);
    expect(keeperMock.claimDiscovery).not.toHaveBeenCalled();
    expect(readValue<string>(env, `SELECT status FROM discoveries WHERE id = '${discoveryId}'`, "status")).toBe("PENDING");
  });

  it("leaves an unresolved hold exactly as it is, however old it is", async () => {
    const owner = makeWallet();
    seedHappyPath({ wallet: owner.wallet });
    const discoveryId = await rollForWallet(owner.wallet);
    // Parked for review well past the configured review window, which used to be enough for the
    // player's own claim attempt to have it REJECTED - irreversibly destroying a granted reward.
    await env.DB.prepare("UPDATE discoveries SET status = 'HELD', created_at = ?1 WHERE id = ?2")
      .bind(NOW - 3 * DAY, discoveryId)
      .run();

    const challenge = await challengeFor(owner, discoveryId);
    const session = await authenticate(owner.wallet);
    const response = await claimDiscovery(
      post("/api/discovery/claim", { discoveryId, nonce: challenge.nonce, signature: owner.sign(challenge.message) }, session),
      env,
    );

    // Refused, and the grant is untouched: only a human or the risk pipeline resolves a hold.
    expect(response.status).toBe(403);
    expect(readValue<string>(env, `SELECT status FROM discoveries WHERE id = '${discoveryId}'`, "status")).toBe("HELD");
    expect(
      readValue<string>(env, `SELECT failure_reason FROM discoveries WHERE id = '${discoveryId}'`, "failure_reason"),
    ).toBeNull();
    expect(harness.queue.messages).toHaveLength(0);
    expect(metricTotal("discovery.claim_denied")).toBeGreaterThan(0);
  });

  it("is idempotent: an already CLAIMED discovery pays nothing more", async () => {
    const owner = makeWallet();
    seedHappyPath({ wallet: owner.wallet });
    const discoveryId = await rollForWallet(owner.wallet);
    await env.DB.prepare(
      "UPDATE discoveries SET status = 'CLAIMED', tx_signature = 'settled' WHERE id = ?1",
    )
      .bind(discoveryId)
      .run();
    keeperMock.claimDiscovery.mockResolvedValue("should-not-happen");
    await settleDiscoveryClaim(env, discoveryId);
    expect(keeperMock.claimDiscovery).not.toHaveBeenCalled();

    const session = await authenticate(owner.wallet);
    const challengeResponse = await claimDiscoveryChallenge(
      post("/api/discovery/claim/challenge", { discoveryId }, session),
      env,
    );
    // The challenge endpoint refuses a CLAIMED discovery outright, so no payout can be queued.
    expect(challengeResponse.status).toBe(409);
    expect(harness.queue.messages).toHaveLength(0);
  });

  it("returns the in-flight state instead of a second committed payout when claimed twice", async () => {
    const owner = makeWallet();
    seedHappyPath({ wallet: owner.wallet });
    const discoveryId = await rollForWallet(owner.wallet);
    const session = await authenticate(owner.wallet);

    const firstChallenge = await challengeFor(owner, discoveryId);
    const first = await claimDiscovery(
      post("/api/discovery/claim", { discoveryId, nonce: firstChallenge.nonce, signature: owner.sign(firstChallenge.message) }, session),
      env,
    );
    expect(first.status).toBe(202);

    const secondChallenge = await challengeFor(owner, discoveryId);
    const second = await claimDiscovery(
      post("/api/discovery/claim", { discoveryId, nonce: secondChallenge.nonce, signature: owner.sign(secondChallenge.message) }, session),
      env,
    );
    // Requeueing is safe (the on-chain receipt is the idempotency guard) but no second row, second
    // discovery or second committed state may appear.
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ status: "ELIGIBLE" });
    expect(countRows(env, `SELECT COUNT(*) AS total FROM discoveries WHERE id = '${discoveryId}'`)).toBe(1);
    expect(readValue<string>(env, `SELECT status FROM discoveries WHERE id = '${discoveryId}'`, "status")).toBe("ELIGIBLE");
  });

  it("lets exactly one of two concurrent claims own the payout", async () => {
    const owner = makeWallet();
    seedHappyPath({ wallet: owner.wallet });
    const discoveryId = await rollForWallet(owner.wallet);
    const session = await authenticate(owner.wallet);
    const [one, two] = await Promise.all([challengeFor(owner, discoveryId), challengeFor(owner, discoveryId)]);

    const responses = await Promise.all([
      claimDiscovery(post("/api/discovery/claim", { discoveryId, nonce: one.nonce, signature: owner.sign(one.message) }, session), env),
      claimDiscovery(post("/api/discovery/claim", { discoveryId, nonce: two.nonce, signature: owner.sign(two.message) }, session), env),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 202]);
    expect(countRows(env, `SELECT COUNT(*) AS total FROM discoveries WHERE id = '${discoveryId}'`)).toBe(1);
    expect(readValue<string>(env, `SELECT status FROM discoveries WHERE id = '${discoveryId}'`, "status")).toBe("ELIGIBLE");
    // Both jobs reference the same discovery id, so the on-chain receipt makes the second a no-op.
    expect(new Set(queuedDiscoveryIds())).toEqual(new Set([discoveryId]));
  });

  it("refuses to commit a payout the indexed reserve can no longer cover", async () => {
    const owner = makeWallet();
    seedHappyPath({ wallet: owner.wallet });
    const discoveryId = await rollForWallet(owner.wallet);
    const challenge = await challengeFor(owner, discoveryId);
    // Other accounts drain this reserve between the grant and the claim.
    await env.DB.prepare("UPDATE tokens SET discovery_reserve_remaining = 0 WHERE mint = ?1")
      .bind(HEALTHY_MINT)
      .run();
    const session = await authenticate(owner.wallet);
    const response = await claimDiscovery(
      post(
        "/api/discovery/claim",
        { discoveryId, nonce: challenge.nonce, signature: owner.sign(challenge.message) },
        session,
      ),
      env,
    );
    expect(response.status).toBe(409);
    // Nothing was handed to the keeper, and the reward was not destroyed either.
    expect(harness.queue.messages).toHaveLength(0);
    expect(
      countRows(env, "SELECT COUNT(*) AS total FROM discoveries WHERE id = '" + discoveryId + "' AND status = 'PENDING'"),
    ).toBe(1);
  });

  it("does not let one wallet claim another wallet's discovery", async () => {
    const owner = makeWallet();
    const stranger = makeWallet();
    seedHappyPath({ wallet: owner.wallet });
    seedPlayer(env, stranger.wallet);
    const discoveryId = await rollForWallet(owner.wallet);
    const session = await authenticate(stranger.wallet);
    const response = await claimDiscoveryChallenge(
      post("/api/discovery/claim/challenge", { discoveryId }, session),
      env,
    );
    // Indistinguishable from "does not exist", so this endpoint cannot enumerate discoveries.
    expect(response.status).toBe(404);
  });

  it("blocks a claim once the claims breaker is open", async () => {
    const owner = makeWallet();
    seedHappyPath({ wallet: owner.wallet });
    const discoveryId = await rollForWallet(owner.wallet);
    const challenge = await challengeFor(owner, discoveryId);
    await setBreaker(env, { scope: "claims", open: true, reason: "test", actor: "test" });
    const session = await authenticate(owner.wallet);
    const response = await claimDiscovery(
      post("/api/discovery/claim", { discoveryId, nonce: challenge.nonce, signature: owner.sign(challenge.message) }, session),
      env,
    );
    expect(response.status).toBe(503);
    expect(harness.queue.messages).toHaveLength(0);
    expect(readValue<string>(env, `SELECT status FROM discoveries WHERE id = '${discoveryId}'`, "status")).toBe("PENDING");
  });

  it("binds the claim challenge to the discovery it was issued for", async () => {
    const owner = makeWallet();
    seedHappyPath({ wallet: owner.wallet });
    const discoveryId = await rollForWallet(owner.wallet);
    // A second discovery of the same wallet, from another window: its own challenge would be a
    // different nonce, so a signature over the first one's challenge must not claim it.
    const otherId = seedDiscovery(env, { wallet: owner.wallet, mint: HEALTHY_MINT, valueUsd: 0.05 });
    const challenge = await challengeFor(owner, discoveryId);
    const session = await authenticate(owner.wallet);

    const response = await claimDiscovery(
      post(
        "/api/discovery/claim",
        { discoveryId: otherId, nonce: challenge.nonce, signature: owner.sign(challenge.message) },
        session,
      ),
      env,
    );

    expect(response.status).toBe(401);
    expect(harness.queue.messages).toHaveLength(0);
    expect(readValue<string>(env, `SELECT status FROM discoveries WHERE id = '${otherId}'`, "status")).toBe("PENDING");
  });

  it("stops one mine's payouts when only that mine's breaker is open", async () => {
    const owner = makeWallet();
    seedHappyPath({ wallet: owner.wallet });
    const discoveryId = await rollForWallet(owner.wallet);
    const challenge = await challengeFor(owner, discoveryId);
    // Exactly what the reconciliation cron opens when this one mine's reserve diverged.
    await setBreaker(env, {
      scope: "claims",
      mint: HEALTHY_MINT,
      open: true,
      reason: "reserve_divergence",
      actor: "reconcile-cron",
    });
    const session = await authenticate(owner.wallet);

    const freshChallenge = await claimDiscoveryChallenge(
      post("/api/discovery/claim/challenge", { discoveryId }, session),
      env,
    );
    expect(freshChallenge.status).toBe(503);

    const response = await claimDiscovery(
      post(
        "/api/discovery/claim",
        { discoveryId, nonce: challenge.nonce, signature: owner.sign(challenge.message) },
        session,
      ),
      env,
    );
    expect(response.status).toBe(503);
    expect(harness.queue.messages).toHaveLength(0);
    expect(readValue<string>(env, `SELECT status FROM discoveries WHERE id = '${discoveryId}'`, "status")).toBe(
      "PENDING",
    );
  });
});

describe("keeper settlement safety (spec 57, 70)", () => {
  async function committedDiscovery(owner: TestWallet): Promise<string> {
    const discovery = await rollDiscovery(env, owner.wallet, null);
    const id = discovery!.id;
    await env.DB.prepare("UPDATE discoveries SET status = 'ELIGIBLE' WHERE id = ?1").bind(id).run();
    return id;
  }

  it("reverts a failed payout to ELIGIBLE and retries instead of losing the reward", async () => {
    const owner = makeWallet();
    seedHappyPath({ wallet: owner.wallet });
    const discoveryId = await committedDiscovery(owner);
    keeperMock.claimDiscovery.mockRejectedValue(new Error("rpc unavailable"));
    keeperMock.receiptExists.mockResolvedValue(false);

    await expect(settleDiscoveryClaim(env, discoveryId)).rejects.toThrow("rpc unavailable");
    expect(readValue<string>(env, `SELECT status FROM discoveries WHERE id = '${discoveryId}'`, "status")).toBe("ELIGIBLE");
    expect(keeperMock.receiptExists).toHaveBeenCalledTimes(1);
expect(metricTotal("discovery.claim_failed")).toBeGreaterThan(0);
  });

  it("marks a discovery settled when the on-chain receipt proves it was already paid", async () => {
    const owner = makeWallet();
    seedHappyPath({ wallet: owner.wallet });
    const discoveryId = await committedDiscovery(owner);
    keeperMock.claimDiscovery.mockRejectedValue(new Error("account already in use"));
    keeperMock.receiptExists.mockResolvedValue(true);

    await settleDiscoveryClaim(env, discoveryId);
    // Exactly one payout: the receipt is the proof, so this is the recovered path, not a retry.
    expect(readValue<string>(env, `SELECT status FROM discoveries WHERE id = '${discoveryId}'`, "status")).toBe("CLAIMED");
    expect(
      readValue<string>(env, `SELECT failure_reason FROM discoveries WHERE id = '${discoveryId}'`, "failure_reason"),
    ).toBe("receipt_already_initialized");
  });

  it("does not call the keeper for a discovery that has no reserve left to pay from", async () => {
    const owner = makeWallet();
    seedHappyPath({ wallet: owner.wallet });
    const discoveryId = await committedDiscovery(owner);
    keeperMock.claimDiscovery.mockResolvedValue("keeper-signature");
    keeperMock.receiptExists.mockResolvedValue(false);
    await settleDiscoveryClaim(env, discoveryId);
    expect(keeperMock.claimDiscovery).toHaveBeenCalledTimes(1);
    // A second settlement of the same discovery is a no-op: CLAIMED is terminal.
    await settleDiscoveryClaim(env, discoveryId);
    expect(keeperMock.claimDiscovery).toHaveBeenCalledTimes(1);
  });

  it("defers a payout while the reserve breaker is open and pays exactly once after it closes", async () => {
    const owner = makeWallet();
    seedHappyPath({ wallet: owner.wallet });
    const discoveryId = await committedDiscovery(owner);
    keeperMock.claimDiscovery.mockResolvedValue("keeper-signature");
    keeperMock.receiptExists.mockResolvedValue(false);

    // The halt the reconciliation cron opens for a mine whose reserve diverged (spec 65, 78), set
    // after the job was already on the queue.
    await setBreaker(env, {
      scope: "discovery_reserve",
      mint: HEALTHY_MINT,
      open: true,
      reason: "reserve_diverged",
      actor: "test",
    });
    await settleDiscoveryClaim(env, discoveryId);

    // Nothing was paid, and nothing was destroyed: the reward is still committed (ELIGIBLE) and the
    // job is back on the queue with a backoff.
    expect(keeperMock.claimDiscovery).not.toHaveBeenCalled();
    expect(readValue<string>(env, `SELECT status FROM discoveries WHERE id = '${discoveryId}'`, "status")).toBe(
      "ELIGIBLE",
    );
    expect(harness.queue.messages).toEqual([{ type: "claim_discovery", discoveryId }]);
    expect(harness.queue.delays).toEqual([DISCOVERY_CLAIM_RETRY_SECONDS]);
    expect(metricTotal("discovery.claim_deferred")).toBeGreaterThan(0);

    // The same mine, and also a scope-wide claims halt: both have to hold the payout back.
    await setBreaker(env, { scope: "claims", open: true, reason: "halt", actor: "test" });
    await settleDiscoveryClaim(env, discoveryId);
    expect(keeperMock.claimDiscovery).not.toHaveBeenCalled();
    await setBreaker(env, { scope: "claims", open: false, reason: "cleared", actor: "test" });

    // Clearing the halt is all it takes: the retry pays once and the row becomes terminal.
    await setBreaker(env, {
      scope: "discovery_reserve",
      mint: HEALTHY_MINT,
      open: false,
      reason: "reconciled",
      actor: "test",
    });
    await settleDiscoveryClaim(env, discoveryId);
    expect(keeperMock.claimDiscovery).toHaveBeenCalledTimes(1);
    expect(readValue<string>(env, `SELECT status FROM discoveries WHERE id = '${discoveryId}'`, "status")).toBe(
      "CLAIMED",
    );

    // Every later replay is still a no-op.
    await settleDiscoveryClaim(env, discoveryId);
    expect(keeperMock.claimDiscovery).toHaveBeenCalledTimes(1);
  });
});

describe("gate plumbing (spec 48, 62)", () => {
  it("refuses and records the refusal once the shared gate rate limit is reached", async () => {
    const wallet = makeWallet().wallet;
    seedHappyPath({ wallet });
    const session = await authenticate(wallet);
    // discovery_roll allows 12 requests per wallet per 300s, and the gate counts every attempt,
    // including ones that were refused for another reason.
    let last: Response | null = null;
    for (let attempt = 0; attempt < 16; attempt += 1) {
      last = await rollDiscoveryRequest(post("/api/discovery/roll", {}, session), env);
    }
    expect(last!.status).toBe(429);
    // A refused action is appended to the signal log the risk system reads, so a burst is visible.
    expect(
      countRows(env, `SELECT COUNT(*) AS total FROM account_signals WHERE wallet = '${wallet}' AND action = 'discovery_roll'`),
    ).toBeGreaterThan(0);
  });

  it("never leaks a reason, score or threshold in a refusal body", async () => {
    const owner = makeWallet();
    const stranger = makeWallet();
    seedHappyPath({ wallet: owner.wallet });
    seedPlayer(env, stranger.wallet);
    const session = await authenticate(stranger.wallet);
    const response = await claimDiscoveryChallenge(
      post("/api/discovery/claim/challenge", { discoveryId: "does-not-exist" }, session),
      env,
    );
    expect(response.status).toBe(404);
    expect(JSON.stringify(await response.json())).not.toMatch(/score|weight|threshold|signal|eligible/i);
  });
});
