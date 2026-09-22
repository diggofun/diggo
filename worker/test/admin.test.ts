/**
 * Admin anti-abuse surface tests (spec 65-67, 82).
 *
 * The most important assertion in this file is a negative one: there is no admin path to funds.
 * It is checked twice - against the module's export surface and against the router's own route
 * table - because "an admin cannot withdraw the reserve" has to be a property of the code, not
 * a promise in a comment.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as adminModule from "../admin";
import { adminAbuse, adminBreakers, adminMetrics, adminRestrictions } from "../admin";
import { gateAction } from "../risk";
import { fingerprintRequest } from "../signals";
import {
  countRows,
  createTestEnv,
  makeRequest,
  newWallet,
  openSession,
  seedPlayer,
  type TestEnv,
} from "./risk-d1";

const ADMIN_SOURCE = readFileSync(fileURLToPath(new URL("../admin.ts", import.meta.url)), "utf8");
const ROUTER_SOURCE = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");

const ABUSE_KEYS = [
  "accountAgeSeconds",
  "activeDays",
  "claimedValueUsd",
  "crewLevel",
  "crewTier",
  "discoveries",
  "flags",
  "relatedAccounts",
  "restrictions",
  "rewardState",
  "riskLevel",
  "streak",
  "trust",
  "wallet",
];

const METRIC_KEYS = [
  "activationsPerHour",
  "avgDiscoveryValueUsd",
  "claimsPerHour",
  "discoveriesPerHour",
  "discoveryValuePerAccountUsd",
  "failedChallengesPerHour",
  "newAccountsPerHour",
  "rateLimitHitsPerHour",
  "replayAttemptsPerHour",
  "reserveDrainVelocityUsdPerHour",
  "reserveDrainedFraction",
  "synchronizedActivityShare",
  "walletsPerDeviceCluster",
  "walletsPerNetworkCluster",
];

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

describe("admin anti-abuse surface", () => {
  let test: TestEnv;
  let adminWallet: string;
  let adminSession: string;

  beforeEach(async () => {
    test = createTestEnv();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    adminWallet = newWallet().wallet;
    test.env.ADMIN_WALLETS = adminWallet + ", " + newWallet().wallet;
    adminSession = await openSession(test, adminWallet);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    test.close();
  });

  it("exposes only restriction, breaker and read functions", () => {
    const exported = Object.keys(adminModule).sort();
    expect(exported).toEqual([
      "adminAbuse",
      "adminActor",
      "adminBreakers",
      "adminMetrics",
      "adminRestrictions",
      "adminWallets",
      "isAdminWallet",
      "recentAudit",
    ]);
    for (const name of exported) {
      expect(name).not.toMatch(/withdraw|payout|refund|transfer|seize|credit|reserve/i);
    }
    // Nothing in the module can reach a signer, a transfer or the keeper at all. Comments are
    // stripped first so that prose explaining the boundary cannot mask a real call site.
    const code = ADMIN_SOURCE.split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    expect(code).not.toMatch(/from "\.\/keeper"|signTransaction|sendTransaction|SystemProgram|closeAccount/);
    expect(code).not.toMatch(/withdraw\(|payout\(|refund\(|seize\(|\.transfer\(/i);
  });

  it("has no admin route that could move funds", () => {
    const adminRoutes = Array.from(
      ROUTER_SOURCE.matchAll(/pathname === "(\/api\/admin\/[a-z]+)"/g),
      (match) => match[1],
    ).sort();
    expect(adminRoutes).toEqual([
      "/api/admin/abuse",
      "/api/admin/breakers",
      "/api/admin/metrics",
      "/api/admin/restrictions",
    ]);
    expect(ROUTER_SOURCE).not.toMatch(/\/api\/admin\/(?:withdraw|reserve|payout|transfer|claim)/);
  });

  it("requires a signed session belonging to a listed admin wallet", async () => {
    const anonymous = await adminAbuse(
      makeRequest({ url: "https://diggo.fun/api/admin/abuse", method: "GET" }),
      test.env,
    );
    expect(anonymous.status).toBe(401);

    const signedInOutsider = newWallet().wallet;
    const outsiderSession = await openSession(test, signedInOutsider);
    const outsider = await adminAbuse(
      makeRequest({ url: "https://diggo.fun/api/admin/abuse", method: "GET", session: outsiderSession }),
      test.env,
    );
    expect(outsider.status).toBe(401);

    const admin = await adminAbuse(
      makeRequest({ url: "https://diggo.fun/api/admin/abuse", method: "GET", session: adminSession }),
      test.env,
    );
    expect(admin.status).toBe(200);
    expect((await readJson<{ actor: string }>(admin)).actor).toBe(adminWallet);
  });

  it("lists the anti-abuse view without raw IP, device or session data", async () => {
    const account = newWallet().wallet;
    seedPlayer(test, account, { activeDays: 12, streak: 6 });
    const request = makeRequest({ ip: "203.0.113.55", device: "raw-device-string", session: "leaky-session" });
    const fingerprint = await fingerprintRequest(test.env, request);
    for (let index = 0; index < 3; index += 1) {
      test.db
        .prepare(
          "INSERT INTO account_signals (wallet, ts, action, ip_hash, network_hash, device_hash, session_id, outcome) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          index === 0 ? account : "related-wallet-" + index,
          Math.floor(Date.now() / 1_000),
          "activate",
          fingerprint.ipHash,
          fingerprint.networkHash,
          fingerprint.deviceHash,
          fingerprint.sessionId,
          "ok",
        );
    }

    const response = await adminAbuse(
      makeRequest({ url: "https://diggo.fun/api/admin/abuse", method: "GET", session: adminSession }),
      test.env,
    );
    expect(response.status).toBe(200);
    const body = await readJson<{ accounts: Record<string, unknown>[] }>(response);
    const entry = body.accounts.find((row) => row.wallet === account);
    expect(entry).toBeDefined();
    expect(Object.keys(entry ?? {}).sort()).toEqual(ABUSE_KEYS);
    expect(entry?.relatedAccounts).toBe(3);
    expect(entry?.riskLevel).toBe("LOW");

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("203.0.113.55");
    expect(serialized).not.toContain("raw-device-string");
    expect(serialized).not.toContain("leaky-session");
    expect(serialized).not.toContain(fingerprint.deviceHash as string);
    expect(serialized).not.toContain(fingerprint.ipHash as string);
  });

  it("places and lifts a restriction, and audits both", async () => {
    const account = newWallet().wallet;
    seedPlayer(test, account);
    const placed = await adminRestrictions(
      makeRequest({
        url: "https://diggo.fun/api/admin/restrictions",
        session: adminSession,
        body: { wallet: account, kind: "DISCOVERY_BLOCK", reasonCode: "manual_review" },
      }),
      test.env,
    );
    expect(placed.status).toBe(200);
    expect(countRows(test.db, "SELECT COUNT(*) AS n FROM account_restrictions WHERE wallet = ?1", account)).toBe(1);
    expect(countRows(test.db, "SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'restriction.set'")).toBe(1);

    const gated = await gateAction(test.env, {
      wallet: account,
      request: makeRequest({ device: "restricted" }),
      action: "discovery_roll",
    });
    expect(gated.allowed).toBe(false);
    expect(gated.rewardState).toBe("HELD");

    const lifted = await adminRestrictions(
      makeRequest({
        url: "https://diggo.fun/api/admin/restrictions",
        session: adminSession,
        body: { wallet: account, kind: "DISCOVERY_BLOCK", lift: true },
      }),
      test.env,
    );
    expect(lifted.status).toBe(200);
    expect(countRows(test.db, "SELECT COUNT(*) AS n FROM account_restrictions WHERE wallet = ?1", account)).toBe(0);
    expect(countRows(test.db, "SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'restriction.lift'")).toBe(1);

    const rejected = await adminRestrictions(
      makeRequest({
        url: "https://diggo.fun/api/admin/restrictions",
        session: adminSession,
        body: { wallet: account, kind: "MOVE_FUNDS" },
      }),
      test.env,
    );
    expect(rejected.status).toBe(400);
  });

  it("opens and closes breakers with an audit trail and a mandatory reason", async () => {
    const opened = await adminBreakers(
      makeRequest({
        url: "https://diggo.fun/api/admin/breakers",
        session: adminSession,
        body: { scope: "discoveries", open: true, reason: "drain_anomaly" },
      }),
      test.env,
    );
    expect(opened.status).toBe(200);
    expect(countRows(test.db, "SELECT COUNT(*) AS n FROM circuit_breakers WHERE open = 1")).toBe(1);
    expect(countRows(test.db, "SELECT COUNT(*) AS n FROM breaker_audit")).toBe(1);
    expect(countRows(test.db, "SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'breaker.open'")).toBe(1);

    const noReason = await adminBreakers(
      makeRequest({
        url: "https://diggo.fun/api/admin/breakers",
        session: adminSession,
        body: { scope: "discoveries", open: true, reason: "   " },
      }),
      test.env,
    );
    expect(noReason.status).toBe(400);

    const badScope = await adminBreakers(
      makeRequest({
        url: "https://diggo.fun/api/admin/breakers",
        session: adminSession,
        body: { scope: "trading", open: true, reason: "stop_all_trading" },
      }),
      test.env,
    );
    expect(badScope.status).toBe(400);

    const badMint = await adminBreakers(
      makeRequest({
        url: "https://diggo.fun/api/admin/breakers",
        session: adminSession,
        body: { scope: "discovery_reserve", mint: "not-a-mint", open: true, reason: "tainted" },
      }),
      test.env,
    );
    expect(badMint.status).toBe(400);

    const closed = await adminBreakers(
      makeRequest({
        url: "https://diggo.fun/api/admin/breakers",
        session: adminSession,
        body: { scope: "discoveries", open: false, reason: "resolved" },
      }),
      test.env,
    );
    expect(closed.status).toBe(200);
    expect(countRows(test.db, "SELECT COUNT(*) AS n FROM circuit_breakers WHERE open = 0")).toBe(1);
    expect(countRows(test.db, "SELECT COUNT(*) AS n FROM breaker_audit")).toBe(2);
  });

  it("returns the spec-66 metric set and the breaker state", async () => {
    const account = newWallet().wallet;
    const now = Math.floor(Date.now() / 1_000);
    // A brand-new account that just activated: one new account and one activation this hour.
    seedPlayer(test, account, { createdAt: now - 60, lastActivationAt: now - 30 });
    const response = await adminMetrics(
      makeRequest({ url: "https://diggo.fun/api/admin/metrics", method: "GET", session: adminSession }),
      test.env,
    );
    expect(response.status).toBe(200);
    const body = await readJson<{
      metrics: Record<string, number>;
      alerts: unknown[];
      breakers: unknown[];
      counters: unknown[];
      audit: unknown[];
    }>(response);
    expect(Object.keys(body.metrics).sort()).toEqual(METRIC_KEYS);
    expect(body.metrics.activationsPerHour).toBe(1);
    expect(body.metrics.newAccountsPerHour).toBe(1);
    expect(body.alerts).toEqual([]);
    expect(Array.isArray(body.breakers)).toBe(true);
  });
});
