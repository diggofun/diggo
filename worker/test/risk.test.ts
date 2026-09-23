/**
 * Anti-abuse regression tests (spec 82). These run the real migrations against an in-memory
 * SQLite database, so the queries and constraints are exercised for real rather than mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DIGGO_CONFIG } from "../../shared/config";
import { RISK_OPS, createRiskOpsConfig } from "../../shared/riskOps";
import { createChallenge, verifyWallet } from "../auth";
import { breakerAudit, isBreakerOpen, setBreaker } from "../breakers";
import { gateAction, refreshAccountRisk, riskCron, verifyChallenge } from "../risk";
import { AccountCreationDenied, getOrCreatePlayer } from "../player";
import { type RequestFingerprint, fingerprintRequest, setRestriction } from "../signals";
import {
  countRows,
  createTestEnv,
  makeRequest,
  newWallet,
  seedDiscovery,
  seedPlayer,
  seedSignal,
  type TestEnv,
} from "./risk-d1";

const MINE = "4rT8mQ2vN6kY3cW9pF1sJ7aB5eH8uL2xG6zP9diggo";
const OTHER_MINE = "9xK2hM7qT4vB8nP6sR3wY5cF1aG7uJ2eL8mN4diggo";
const BREAKER_MESSAGE = "Rewards are temporarily paused. Please try again later.";

/**
 * Launch default is shadow enforcement (spec 63), so anything that wants to assert what the score
 * *does* to an account has to ask for enforce mode explicitly. Keeping both configs side by side is
 * what makes the difference between "recorded" and "applied" testable.
 */
const ENFORCE_OPS = createRiskOpsConfig({ enforcement: { mode: "enforce" } });

/**
 * Every test in this file runs on a frozen clock.
 *
 * Rate limits are counted in fixed buckets keyed by floor(now / windowSeconds), so a test that ran
 * across a bucket boundary would see its counters reset halfway through and then assert a different
 * number depending on when CI happened to start it. Freezing the clock makes the buckets - and the
 * exact counts these tests assert - deterministic.
 */
const FROZEN_NOW_MS = 1_767_225_600_000;
const FROZEN_NOW = Math.floor(FROZEN_NOW_MS / 1_000);

function freezeClock(): void {
  vi.useFakeTimers();
  vi.setSystemTime(FROZEN_NOW_MS);
}

function nowSeconds(): number {
  return FROZEN_NOW;
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

describe("risk gate", () => {
  let test: TestEnv;

  beforeEach(() => {
    freezeClock();
    test = createTestEnv();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    test.close();
  });

  describe("multi-key rate limiting", () => {
    it("lets a household share one IP at low volume", async () => {
      const wallets = Array.from({ length: 6 }, () => newWallet().wallet);
      for (const wallet of wallets) seedPlayer(test, wallet);
      for (const [index, wallet] of wallets.entries()) {
        const request = makeRequest({
          ip: "203.0.113.7",
          device: "household-device-" + index,
          session: "session-" + index,
        });
        const verdict = await gateAction(test.env, { wallet, request, action: "activate" });
        expect(verdict.allowed).toBe(true);
        expect(verdict.challengeRequired).toBe(false);
        expect(verdict.rewardState).toBe("NORMAL");
      }
      // The wallet dimension is really counted, not just the IP: every wallet has its own key.
      for (const wallet of wallets) {
        expect(Array.from(test.kv.keys()).some((key) => key.includes("wallet:" + wallet))).toBe(true);
      }
    });

    it("refuses on the device dimension while the shared IP still has budget", async () => {
      const wallets = Array.from({ length: 15 }, () => newWallet().wallet);
      const verdicts = [];
      for (const wallet of wallets) {
        seedPlayer(test, wallet);
        const request = makeRequest({ ip: "203.0.113.9", device: "one-shared-rig" });
        verdicts.push(await gateAction(test.env, { wallet, request, action: "activate" }));
      }
      const allowed = verdicts.filter((verdict) => verdict.allowed).length;
      expect(allowed).toBe(RISK_OPS.rateLimits.activate.device);
      // The IP budget (30) was never reached, so the refusal cannot have come from IP alone.
      expect(allowed).toBeLessThan(RISK_OPS.rateLimits.activate.ip);
      const refused = verdicts.filter((verdict) => !verdict.allowed);
      expect(refused[0]?.retryAfterSec).toBe(RISK_OPS.rateLimits.activate.windowSeconds);
      expect(refused[0]?.challengeRequired).toBe(false);
    });

    it("records a rate-limited outcome as an account signal", async () => {
      const wallet = newWallet().wallet;
      seedPlayer(test, wallet);
      for (let attempt = 0; attempt < RISK_OPS.rateLimits.activate.wallet + 2; attempt += 1) {
        const request = makeRequest({ ip: "203.0.113.11", device: "rig-" + attempt });
        await gateAction(test.env, { wallet, request, action: "activate" });
      }
      expect(
        countRows(
          test.db,
          "SELECT COUNT(*) AS n FROM account_signals WHERE wallet = ?1 AND outcome = 'rate_limited'",
          wallet,
        ),
      ).toBeGreaterThan(0);
    });
  });

  describe("progressive friction", () => {
    it("requires a challenge, clears it for a short window, and refuses a replayed nonce", async () => {
      const account = newWallet();
      seedPlayer(test, account.wallet);
      await setRestriction(test.env, {
        wallet: account.wallet,
        kind: "CHALLENGE_REQUIRED",
        reasonCode: "test_challenge",
        createdBy: "admin",
      });
      const request = makeRequest({ ip: "203.0.113.21", device: "challenge-device" });
      const blocked = await gateAction(test.env, { wallet: account.wallet, request, action: "activate" });
      expect(blocked.allowed).toBe(false);
      expect(blocked.challengeRequired).toBe(true);
      expect(blocked.publicMessage).toBe(RISK_OPS.challenge.publicMessage);

      const issue = await verifyChallenge(
        makeRequest({
          url: "https://diggo.fun/api/verify/challenge",
          body: { wallet: account.wallet, action: "activate" },
          ip: "203.0.113.21",
          device: "challenge-device",
        }),
        test.env,
      );
      expect(issue.status).toBe(202);
      const issued = await readJson<{ strategy: string; nonce: string; message: string }>(issue);
      expect(issued.strategy).toBe("signature");

      const solved = await verifyChallenge(
        makeRequest({
          url: "https://diggo.fun/api/verify/challenge",
          body: {
            wallet: account.wallet,
            action: "activate",
            nonce: issued.nonce,
            signature: account.sign(issued.message),
          },
          ip: "203.0.113.21",
          device: "challenge-device",
        }),
        test.env,
      );
      expect(solved.status).toBe(200);
      expect((await readJson<{ cleared: boolean }>(solved)).cleared).toBe(true);

      const allowed = await gateAction(test.env, { wallet: account.wallet, request, action: "activate" });
      expect(allowed.allowed).toBe(true);
      expect(allowed.challengeRequired).toBe(false);

      const replayed = await verifyChallenge(
        makeRequest({
          url: "https://diggo.fun/api/verify/challenge",
          body: {
            wallet: account.wallet,
            action: "activate",
            nonce: issued.nonce,
            signature: account.sign(issued.message),
          },
          ip: "203.0.113.21",
          device: "challenge-device",
        }),
        test.env,
      );
      expect(replayed.status).toBe(409);
      expect(
        countRows(
          test.db,
          "SELECT COUNT(*) AS n FROM account_signals WHERE wallet = ?1 AND outcome = 'replay'",
          account.wallet,
        ),
      ).toBe(1);

      const stranger = await verifyChallenge(
        makeRequest({
          url: "https://diggo.fun/api/verify/challenge",
          body: { wallet: newWallet().wallet, action: "activate" },
          ip: "203.0.113.22",
        }),
        test.env,
      );
      expect(stranger.status).toBe(202);
    });
  });

  describe("account risk", () => {
    it("keeps one weak signal at NORMAL", async () => {
      const target = newWallet().wallet;
      const request = makeRequest({ device: "shared-device-30", ip: "198.51.100.10" });
      const fingerprint = await fingerprintRequest(test.env, request);
      const now = nowSeconds();
      for (let index = 0; index < 29; index += 1) {
        // Spread the cluster over ~15 hours with irregular gaps: 30 wallets on one device is
        // the signal under test, and evenly spaced or clustered activations would (correctly)
        // light up the timing signals as well.
        const ts = now - (index * 1_900 + ((index * 7_919) % 3_170));
        seedSignal(test, {
          wallet: "cluster-wallet-" + index,
          deviceHash: fingerprint.deviceHash,
          ts,
        });
      }
      seedPlayer(test, target);
      seedSignal(test, { wallet: target, deviceHash: fingerprint.deviceHash, ts: now });

      const risk = await refreshAccountRisk(test.env, target, { fingerprint });
      expect(risk.flags.strong).toEqual([]);
      expect(risk.score).toBeLessThanOrEqual(DIGGO_CONFIG.risk.weakEvidenceScoreCeiling);
      expect(risk.level).toBe("LOW");
      expect(risk.rewardState).toBe("NORMAL");
      const verdict = await gateAction(test.env, { wallet: target, request, action: "discovery_roll" });
      expect(verdict.allowed).toBe(true);
    });

    it("classifies a 300-wallet device cluster as HIGH and holds rewards without banning", async () => {
      // Enforce mode: this is the escalation path itself, so the score's verdict has to be applied.
      const target = newWallet().wallet;
      const request = makeRequest({ device: "farm-rig-300", ip: "198.51.100.30" });
      const fingerprint = await fingerprintRequest(test.env, request);
      const now = nowSeconds();
      const bucketStart = now - 600 - ((now - 600) % RISK_OPS.synchronyBucketSeconds);
      for (let index = 0; index < 299; index += 1) {
        const wallet = "cluster-wallet-" + index;
        seedPlayer(test, wallet, { createdAt: now - 3_600, activeMint: MINE });
        seedSignal(test, {
          wallet,
          deviceHash: fingerprint.deviceHash,
          networkHash: fingerprint.networkHash,
          ts: bucketStart + index,
        });
      }
      seedPlayer(test, target, { createdAt: now - 3_600, activeMint: MINE });
      seedSignal(test, {
        wallet: target,
        deviceHash: fingerprint.deviceHash,
        networkHash: fingerprint.networkHash,
        ts: bucketStart + 299,
      });

      const risk = await refreshAccountRisk(test.env, target, { fingerprint, config: ENFORCE_OPS });
      expect(risk.level).toBe("HIGH");
      expect(risk.rewardState).toBe("HELD");
      expect(risk.flags.strong.length).toBeGreaterThanOrEqual(3);
      expect(risk.flags.response).not.toBe("ban");

      const discovery = await gateAction(test.env, { wallet: target, request, action: "discovery_roll" }, { config: ENFORCE_OPS });
      expect(discovery.allowed).toBe(false);
      expect(discovery.challengeRequired).toBe(false);
      expect(discovery.rewardState).toBe("HELD");
      expect(discovery.publicMessage).toBe(DIGGO_CONFIG.risk.publicStatus.HELD);
      // Neutral copy: no score, no thresholds, no numbers at all (spec 62).
      expect(discovery.publicMessage).not.toMatch(/[0-9]/);

      // Mining accounting keeps running for a held account (spec 53).
      const activation = await gateAction(test.env, { wallet: target, request, action: "activate" }, { config: ENFORCE_OPS });
      expect(activation.allowed).toBe(true);

      // The gameplay modules read players.risk_state, so it has to be in sync.
      const row = test.db.prepare("SELECT risk_state, risk_score FROM players WHERE wallet = ?").get(target) as
        | { risk_state: string; risk_score: number }
        | undefined;
      expect(row?.risk_state).toBe("HELD");
      expect(row?.risk_score).toBe(risk.score);
    });
  });

  describe("circuit breakers", () => {
    it("halts discoveries and reserve payouts without touching claims", async () => {
      const target = newWallet().wallet;
      seedPlayer(test, target);
      const request = makeRequest({ device: "breaker-device" });

      await setBreaker(test.env, {
        scope: "discoveries",
        open: true,
        reason: "manual_test",
        actor: "admin-wallet",
      });
      const halted = await gateAction(test.env, { wallet: target, request, action: "discovery_roll" });
      expect(halted.allowed).toBe(false);
      expect(halted.publicMessage).toBe(BREAKER_MESSAGE);
      expect(await isBreakerOpen(test.env, "discoveries")).toBe(true);
      // A halt on discoveries also stops reserve payouts, which is the whole point of a pause.
      expect(await isBreakerOpen(test.env, "discovery_reserve", MINE)).toBe(true);
      const claims = await gateAction(test.env, { wallet: target, request, action: "claim_reward" });
      expect(claims.allowed).toBe(true);

      await setBreaker(test.env, {
        scope: "discoveries",
        open: false,
        reason: "manual_test_done",
        actor: "admin-wallet",
      });
      expect((await gateAction(test.env, { wallet: target, request, action: "discovery_roll" })).allowed).toBe(true);

      await setBreaker(test.env, {
        scope: "discovery_reserve",
        mint: MINE,
        open: true,
        reason: "tainted_mine",
        actor: "admin-wallet",
      });
      expect(await isBreakerOpen(test.env, "discovery_reserve", MINE)).toBe(true);
      expect(await isBreakerOpen(test.env, "discovery_reserve", OTHER_MINE)).toBe(false);
      expect((await breakerAudit(test.env)).length).toBe(3);
    });
  });

  describe("auth replay protection", () => {
    it("consumes a sign-in nonce once and records the replay", async () => {
      const account = newWallet();
      const challengeResponse = await createChallenge(
        makeRequest({ url: "https://diggo.fun/api/auth/challenge", body: { wallet: account.wallet } }),
        test.env,
      );
      expect(challengeResponse.status).toBe(200);
      const challenge = await readJson<{ nonce: string; message: string }>(challengeResponse);
      const body = { wallet: account.wallet, nonce: challenge.nonce, signature: account.sign(challenge.message) };

      const first = await verifyWallet(
        makeRequest({ url: "https://diggo.fun/api/auth/verify", body }),
        test.env,
      );
      expect(first.status).toBe(200);
      expect(first.headers.get("set-cookie")).toContain("diggo_session");

      const second = await verifyWallet(
        makeRequest({ url: "https://diggo.fun/api/auth/verify", body }),
        test.env,
      );
      expect(second.status).toBe(409);
      expect(second.headers.get("set-cookie")).toBeNull();
      expect(
        countRows(
          test.db,
          "SELECT COUNT(*) AS n FROM account_signals WHERE wallet = ?1 AND action = 'auth' AND outcome = 'replay'",
          account.wallet,
        ),
      ).toBe(1);
      expect(
        countRows(
          test.db,
          "SELECT COUNT(*) AS n FROM account_signals WHERE wallet = ?1 AND action = 'auth' AND outcome = 'ok'",
          account.wallet,
        ),
      ).toBe(1);
    });
  });

  describe("scheduled maintenance", () => {
    function seedDrain(target: TestEnv, discoveries: number, valueUsd: number): void {
      const now = nowSeconds();
      const wallet = newWallet().wallet;
      seedPlayer(target, wallet, { createdAt: now - 3_600 });
      for (let index = 0; index < discoveries; index += 1) {
        seedDiscovery(target, { wallet, valueUsd, createdAt: now - 60 });
      }
    }

    it("auto-opens the discovery breaker on a reserve drain anomaly", async () => {
      seedDrain(test, 12, 3);
      const report = await riskCron(test.env);
      expect(report.snapshot.reserveDrainVelocityUsdPerHour).toBe(36);
      expect(report.breakerOpened).toBe(true);
      expect(await isBreakerOpen(test.env, "discoveries")).toBe(true);
      const audit = test.db.prepare("SELECT actor, scope FROM breaker_audit ORDER BY created_at DESC").get() as
        | { actor: string; scope: string }
        | undefined;
      expect(audit?.actor).toBe("risk-cron");
      expect(audit?.scope).toBe("discoveries");
    });

    it("does not re-open a breaker an admin just closed", async () => {
      seedDrain(test, 12, 3);
      const now = nowSeconds();
      test.db
        .prepare(
          "INSERT INTO admin_audit (id, actor, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(crypto.randomUUID(), "admin-wallet", "breaker.close", "discoveries", "{}", now - 30);
      const report = await riskCron(test.env);
      expect(report.breakerOpened).toBe(false);
      expect(await isBreakerOpen(test.env, "discoveries")).toBe(false);
    });

    it("closes a breaker the cron opened once the drain normalises", async () => {
      seedDrain(test, 12, 3);
      expect((await riskCron(test.env)).breakerOpened).toBe(true);
      test.db.prepare("UPDATE discoveries SET created_at = ?").run(nowSeconds() - 86_400 * 3);
      const report = await riskCron(test.env);
      expect(report.snapshot.reserveDrainVelocityUsdPerHour).toBe(0);
      expect(report.breakerClosed).toBe(true);
      expect(await isBreakerOpen(test.env, "discoveries")).toBe(false);
    });
  });
});

describe("enforcement modes (spec 63)", () => {
  let test: TestEnv;

  beforeEach(() => {
    freezeClock();
    test = createTestEnv();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    test.close();
  });

  /** The 300-wallet farm cluster that reliably scores HIGH, rebuilt per test. */
  function seedFarmCluster(target: string, fingerprint: RequestFingerprint, now: number): void {
    const bucketStart = now - 600 - ((now - 600) % RISK_OPS.synchronyBucketSeconds);
    for (let index = 0; index < 299; index += 1) {
      const wallet = "farm-wallet-" + index;
      seedPlayer(test, wallet, { createdAt: now - 3_600, activeMint: MINE });
      seedSignal(test, {
        wallet,
        deviceHash: fingerprint.deviceHash,
        networkHash: fingerprint.networkHash,
        ts: bucketStart + index,
      });
    }
    seedPlayer(test, target, { createdAt: now - 3_600, activeMint: MINE });
    seedSignal(test, {
      wallet: target,
      deviceHash: fingerprint.deviceHash,
      networkHash: fingerprint.networkHash,
      ts: bucketStart + 299,
    });
  }

  it("records a score refusal instead of acting on it while the mode shadows", async () => {
    const target = newWallet().wallet;
    const request = makeRequest({ device: "shadow-farm", ip: "198.51.100.44" });
    const fingerprint = await fingerprintRequest(test.env, request);
    const now = nowSeconds();
    seedFarmCluster(target, fingerprint, now);

    const risk = await refreshAccountRisk(test.env, target, { fingerprint, now });
    // The score still reaches its verdict, and it is still recorded in full.
    expect(risk.level).toBe("HIGH");
    expect(risk.computedState).toBe("HELD");
    expect(risk.flags.strong.length).toBeGreaterThanOrEqual(3);
    expect(risk.flags.shadowed).toBe(true);
    // Nothing is enforced, so nothing is stored as enforced either - including the copy of the
    // state that every gameplay module reads.
    expect(risk.rewardState).toBe("NORMAL");
    const stored = test.db.prepare("SELECT reward_state, computed_state FROM account_risk WHERE wallet = ?").get(target) as
      | { reward_state: string; computed_state: string }
      | undefined;
    expect(stored?.reward_state).toBe("NORMAL");
    expect(stored?.computed_state).toBe("HELD");
    const player = test.db.prepare("SELECT risk_state FROM players WHERE wallet = ?").get(target) as
      | { risk_state: string }
      | undefined;
    expect(player?.risk_state).toBe("NORMAL");

    const discovery = await gateAction(test.env, { wallet: target, request, action: "discovery_roll" }, { now });
    expect(discovery.allowed).toBe(true);
    expect(discovery.challengeRequired).toBe(false);
    expect(discovery.rewardState).toBe("NORMAL");
    expect(discovery.shadowState).toBe("HELD");
    // Neutral: the shadow verdict must not leak into anything the caller can show a player.
    expect(discovery.publicMessage).toBeUndefined();

    // The decision is reviewable: one signal row and one counter, both named for what they are.
    expect(
      countRows(
        test.db,
        "SELECT COUNT(*) AS n FROM account_signals WHERE wallet = ?1 AND outcome = 'shadow_would_block'",
        target,
      ),
    ).toBe(1);
    expect(
      countRows(test.db, "SELECT COUNT(*) AS n FROM metrics_counters WHERE name = 'risk.shadow_would_block'"),
    ).toBe(1);
  });

  it("blocks the same action once the mode says enforce", async () => {
    const target = newWallet().wallet;
    const request = makeRequest({ device: "enforced-farm", ip: "198.51.100.45" });
    const fingerprint = await fingerprintRequest(test.env, request);
    const now = nowSeconds();
    seedFarmCluster(target, fingerprint, now);

    const risk = await refreshAccountRisk(test.env, target, { fingerprint, now, config: ENFORCE_OPS });
    expect(risk.rewardState).toBe("HELD");
    expect(risk.computedState).toBe("HELD");
    expect(risk.flags.shadowed).toBe(false);

    const discovery = await gateAction(
      test.env,
      { wallet: target, request, action: "discovery_roll" },
      { config: ENFORCE_OPS, now },
    );
    expect(discovery.allowed).toBe(false);
    expect(discovery.rewardState).toBe("HELD");
    expect(discovery.publicMessage).toBe(DIGGO_CONFIG.risk.publicStatus.HELD);
    expect(discovery.shadowState).toBeUndefined();
    // The observation count stays at zero: nothing was shadowed, so nothing is recorded as such.
    expect(
      countRows(test.db, "SELECT COUNT(*) AS n FROM account_signals WHERE outcome = 'shadow_would_block'"),
    ).toBe(0);
  });

  it("lets one action be enforced by override while the default keeps shadowing", async () => {
    const staged = createRiskOpsConfig({ enforcement: { overrides: { discovery_roll: "enforce" } } });
    const target = newWallet().wallet;
    const request = makeRequest({ device: "staged-farm", ip: "198.51.100.46" });
    const fingerprint = await fingerprintRequest(test.env, request);
    const now = nowSeconds();
    seedFarmCluster(target, fingerprint, now);
    await refreshAccountRisk(test.env, target, { fingerprint, now, config: staged });

    const discovery = await gateAction(
      test.env,
      { wallet: target, request, action: "discovery_roll" },
      { config: staged, now },
    );
    expect(discovery.allowed).toBe(false);
    expect(discovery.rewardState).toBe("HELD");

    // The very same account, one action over. A real-value claim is held whatever the mode says
    // (spec 53, 63): holding is reversible and destroys nothing, so it is the one score-derived
    // response that is never shadowed - which is what keeps an undetected farm from draining real
    // tokens before an operator has looked at it (spec 64).
    const claim = await gateAction(
      test.env,
      { wallet: target, request, action: "claim_reward" },
      { config: staged, now },
    );
    expect(claim.allowed).toBe(false);
    expect(claim.challengeRequired).toBe(false);
    expect(claim.rewardState).toBe("HELD");
    expect(claim.shadowState).toBeUndefined();
    expect(claim.publicMessage).toBe(DIGGO_CONFIG.risk.publicStatus.HELD);

    // The launch default (shadow everywhere) holds the same claim for the same reason.
    const shadowClaim = await gateAction(
      test.env,
      { wallet: target, request, action: "claim_reward" },
      { config: RISK_OPS, now },
    );
    expect(shadowClaim.allowed).toBe(false);
    expect(shadowClaim.rewardState).toBe("HELD");
  });

  it("still enforces rate limits, breakers and an operator restriction while shadowing", async () => {
    const account = newWallet().wallet;
    seedPlayer(test, account);
    const request = makeRequest({ device: "hard-safety", ip: "203.0.113.90" });

    // An operator restriction is not a score decision, so shadow mode does not touch it.
    await setRestriction(test.env, {
      wallet: account,
      kind: "CLAIM_HOLD",
      reasonCode: "operator_review",
      createdBy: "admin-wallet",
    });
    const held = await gateAction(test.env, { wallet: account, request, action: "claim_reward" });
    expect(held.allowed).toBe(false);
    expect(held.rewardState).toBe("HELD");
    expect(held.shadowState).toBeUndefined();
    await setRestriction(test.env, {
      wallet: account,
      kind: "ACCOUNT_BLOCK",
      reasonCode: "operator_block",
      createdBy: "admin-wallet",
    });
    const blocked = await gateAction(test.env, { wallet: account, request, action: "activate" });
    expect(blocked.allowed).toBe(false);
    expect(blocked.rewardState).toBe("BLOCKED");

    // So is a circuit breaker, and so is a rate limit.
    const breakerAccount = newWallet().wallet;
    seedPlayer(test, breakerAccount);
    await setBreaker(test.env, { scope: "discoveries", open: true, reason: "manual_test", actor: "admin-wallet" });
    const halted = await gateAction(test.env, {
      wallet: breakerAccount,
      request: makeRequest({ device: "hard-safety-breaker", ip: "203.0.113.92" }),
      action: "discovery_roll",
    });
    expect(halted.allowed).toBe(false);
    expect(halted.publicMessage).toBe(BREAKER_MESSAGE);
    await setBreaker(test.env, { scope: "discoveries", open: false, reason: "manual_test_done", actor: "admin-wallet" });

    const tight = createRiskOpsConfig({ rateLimits: { activate: { wallet: 1 } } });
    const second = newWallet().wallet;
    seedPlayer(test, second);
    const budgetRequest = makeRequest({ device: "tight-budget", ip: "203.0.113.91" });
    expect((await gateAction(test.env, { wallet: second, request: budgetRequest, action: "activate" }, { config: tight })).allowed).toBe(true);
    const exhausted = await gateAction(
      test.env,
      { wallet: second, request: budgetRequest, action: "activate" },
      { config: tight },
    );
    expect(exhausted.allowed).toBe(false);
    expect(exhausted.retryAfterSec).toBeGreaterThan(0);
  });
});


describe("account creation gate (spec 48, 58)", () => {
  let test: TestEnv;

  beforeEach(() => {
    freezeClock();
    test = createTestEnv();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    test.close();
  });

  it("stops one device from minting accounts past the bootstrap budget", async () => {
    // Every wallet is brand new, so only the shared dimensions can run out. With no session
    // cookie the tightest applicable budget is the per-device one, and the IP and network
    // budgets are deliberately looser so a shared household or CGNAT egress stays playable.
    const device = "device-under-test";
    const perDevice = RISK_OPS.rateLimits.bootstrap.device;
    expect(perDevice).toBeGreaterThan(0);
    expect(perDevice).toBeLessThan(RISK_OPS.rateLimits.bootstrap.ip);

    const created: string[] = [];
    for (let index = 0; index < perDevice; index += 1) {
      const wallet = newWallet().wallet;
      const row = await getOrCreatePlayer(test.env, wallet, makeRequest({ device, ip: "203.0.113.7" }));
      expect(row.wallet).toBe(wallet);
      created.push(wallet);
    }
    expect(countRows(test.db, "SELECT COUNT(*) AS n FROM players")).toBe(perDevice);

    const refusedWallet = newWallet().wallet;
    await expect(
      getOrCreatePlayer(test.env, refusedWallet, makeRequest({ device, ip: "203.0.113.7" })),
    ).rejects.toBeInstanceOf(AccountCreationDenied);
    // A refused creation must not leave a half-made account behind.
    expect(countRows(test.db, "SELECT COUNT(*) AS n FROM players")).toBe(perDevice);

    // The gate is on creation only: an account that already exists is never re-gated, so a
    // limiter can never lock a player out of their own account.
    const existing = await getOrCreatePlayer(test.env, created[0], makeRequest({ device, ip: "203.0.113.7" }));
    expect(existing.wallet).toBe(created[0]);
  });

  it("records the refused attempt as account activity without revealing a reason", async () => {
    const device = "noisy-device";
    const perDevice = RISK_OPS.rateLimits.bootstrap.device;
    for (let index = 0; index < perDevice; index += 1) {
      await getOrCreatePlayer(test.env, newWallet().wallet, makeRequest({ device }));
    }
    const refusedWallet = newWallet().wallet;
    await expect(getOrCreatePlayer(test.env, refusedWallet, makeRequest({ device }))).rejects.toBeInstanceOf(
      AccountCreationDenied,
    );

    // The refusal is visible to the anti-abuse layer (spec 49, 66) and the public copy says only
    // that the caller should slow down (spec 62).
    expect(
      countRows(
        test.db,
        "SELECT COUNT(*) AS n FROM account_signals WHERE action = 'bootstrap' AND outcome = 'rate_limited'",
      ),
    ).toBeGreaterThan(0);
    const gate = await gateAction(test.env, {
      wallet: newWallet().wallet,
      request: makeRequest({ device }),
      action: "bootstrap",
    });
    expect(gate.allowed).toBe(false);
    expect(gate.publicMessage).toBe("Too many requests. Please slow down.");
    expect(JSON.stringify(gate)).not.toContain("device");
  });

  it("gates sign-in too, so a farm cannot ask for nonces in a loop", async () => {
    // Distinct wallets and distinct source IPs, one device: only the shared device budget can run
    // out, which is exactly the dimension the gate is supposed to catch (spec 48, 50).
    const device = "auth-flood";
    const perDevice = RISK_OPS.rateLimits.auth.device;
    expect(perDevice).toBeGreaterThan(0);

    const statuses: number[] = [];
    for (let index = 0; index < perDevice + 2; index += 1) {
      const response = await createChallenge(
        makeRequest({ device, ip: "198.51.100." + index, body: { wallet: newWallet().wallet } }),
        test.env,
      );
      statuses.push(response.status);
    }
    expect(statuses.slice(0, perDevice)).toEqual(new Array(perDevice).fill(200));
    expect(statuses.slice(perDevice)).toEqual([429, 429]);
  });
});
