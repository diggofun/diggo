/**
 * Appeals and admin step-up end to end (spec 53, 62, 65, 67).
 *
 * These run against the real migrations, so the appeal table, the single-use step-up nonces and
 * the neutral copy are all exercised the way the deployed Worker exercises them. The two
 * properties worth protecting are negative ones: filing an appeal changes nothing about an
 * account, and a step-up signature works exactly once, for exactly one payload.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RISK_OPS, createRiskOpsConfig } from "../../shared/riskOps";
import { adminAppeals, adminResolveAppeal, submitAppeal } from "../appeals";
import { adminStepUp } from "../admin";
import { setRestriction } from "../signals";
import {
  countRows,
  createTestEnv,
  makeRequest,
  newWallet,
  openSession,
  seedPlayer,
  type TestEnv,
} from "./risk-d1";

type RiskState = "NORMAL" | "UNDER_REVIEW" | "HELD" | "BLOCKED";

function nowSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

describe("appeals (spec 62, 65)", () => {
  let test: TestEnv;
  let wallet: string;
  let session: string;
  let adminWallet: string;
  let adminSession: string;
  let adminSign: (message: string) => string;

  const MESSAGE = "I mined every day on this phone for three weeks and the hold looks wrong to me.";

  beforeEach(async () => {
    test = createTestEnv();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const account = newWallet();
    wallet = account.wallet;
    session = await openSession(test, wallet);
    seedPlayer(test, wallet);
    const admin = newWallet();
    adminWallet = admin.wallet;
    adminSign = admin.sign;
    test.env.ADMIN_WALLETS = adminWallet;
    adminSession = await openSession(test, adminWallet);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    test.close();
  });

  /** The risk record a refresh would have written for this account. */
  function setRiskState(target: string, state: RiskState): void {
    test.db
      .prepare(
        "INSERT INTO account_risk (wallet, score, level, reward_state, computed_state, trust, flags, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(target, 80, "HIGH", state, state, 10, "{}", nowSeconds());
  }

  function file(body: unknown, options: { session?: string | null } = {}): Promise<Response> {
    const useSession = options.session === undefined ? session : options.session;
    return submitAppeal(
      makeRequest({
        url: "https://diggo.fun/api/appeals",
        ip: "203.0.113.200",
        device: "appeal-device",
        ...(useSession === null ? {} : { session: useSession }),
        body,
      }),
      test.env,
    );
  }

  it("requires a signed-in wallet, and reveals nothing without one", async () => {
    setRiskState(wallet, "HELD");
    const anonymous = await file({ message: MESSAGE }, { session: null });
    expect(anonymous.status).toBe(401);
    expect(countRows(test.db, "SELECT COUNT(*) AS n FROM appeals")).toBe(0);
  });

  it("files an appeal for an account that is under something, in neutral language", async () => {
    setRiskState(wallet, "HELD");
    const response = await file({ message: MESSAGE });
    expect(response.status).toBe(201);
    const body = await readJson<{ id: string; received: boolean; message: string }>(response);
    expect(body.received).toBe(true);
    expect(body.message).toBe(RISK_OPS.appeals.publicMessage);
    // Neutral copy: no score, no reason, not even a number (spec 62).
    expect(body.message).not.toMatch(/[0-9]/);

    const rows = test.db
      .prepare("SELECT wallet, message, status, state_at_submission FROM appeals WHERE id = ?")
      .all(body.id) as { wallet: string; message: string; status: string; state_at_submission: string }[];
    expect(rows.length).toBe(1);
    // The wallet comes from the session, never from the body: nobody files for somebody else.
    expect(rows[0].wallet).toBe(wallet);
    expect(rows[0].message).toBe(MESSAGE);
    expect(rows[0].status).toBe("OPEN");
    expect(rows[0].state_at_submission).toBe("HELD");
  });

  it("refuses an account with nothing under review, without saying what the risk layer thinks", async () => {
    const response = await file({ message: MESSAGE });
    expect(response.status).toBe(409);
    const body = await readJson<{ received: boolean; message: string }>(response);
    expect(body.received).toBe(false);
    expect(body.message).toBe(RISK_OPS.appeals.notEligibleMessage);
    expect(body.message).not.toMatch(/[0-9]/);
    expect(countRows(test.db, "SELECT COUNT(*) AS n FROM appeals")).toBe(0);
  });

  it("accepts an appeal from an operator hold and from a blocked account too", async () => {
    await setRestriction(test.env, {
      wallet,
      kind: "ACCOUNT_BLOCK",
      reasonCode: "operator_block",
      createdBy: adminWallet,
    });
    const blocked = await file({ message: MESSAGE });
    expect(blocked.status).toBe(201);
    const rows = test.db.prepare("SELECT state_at_submission FROM appeals").all() as {
      state_at_submission: string;
    }[];
    expect(rows[0].state_at_submission).toBe("BLOCKED");
  });
  it("still lets a shadowed account appeal when a staged override is refusing it", async () => {
    // The score would hold this account; the mode is shadowing, so nothing is enforced and the
    // stored state stays NORMAL. The player still gets a way to ask, and the queue shows why.
    test.db
      .prepare(
        "INSERT INTO account_risk (wallet, score, level, reward_state, computed_state, trust, flags, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(wallet, 88, "HIGH", "NORMAL", "HELD", 10, "{}", nowSeconds());
    const response = await file({ message: MESSAGE });
    expect(response.status).toBe(201);
    const rows = test.db.prepare("SELECT state_at_submission FROM appeals").all() as {
      state_at_submission: string;
    }[];
    expect(rows[0].state_at_submission).toBe("HELD");
  });


  it("bounds the message length in both directions", async () => {
    setRiskState(wallet, "HELD");
    const tooShort = await file({ message: "too short" });
    expect(tooShort.status).toBe(400);
    const tooLong = await file({ message: "x".repeat(RISK_OPS.appeals.maxMessageLength + 1) });
    expect(tooLong.status).toBe(400);
    const notAString = await file({ message: 42 });
    expect(notAString.status).toBe(400);
    expect(countRows(test.db, "SELECT COUNT(*) AS n FROM appeals")).toBe(0);
  });

  it("rate limits appeals per wallet, and says only that the player should wait", async () => {
    setRiskState(wallet, "HELD");
    // A tight wallet budget with a roomy open-appeal cap, so only the limiter can refuse.
    const config = createRiskOpsConfig({
      appeals: { wallet: 2, session: 2, device: 2, ip: 2, network: 2, maxOpenPerAccount: 10 },
    });
    const send = () =>
      submitAppeal(
        makeRequest({
          url: "https://diggo.fun/api/appeals",
          ip: "203.0.113.201",
          session,
          body: { message: MESSAGE },
        }),
        test.env,
        { config },
      );

    expect((await send()).status).toBe(201);
    expect((await send()).status).toBe(201);
    const limited = await send();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
    const body = await readJson<{ received: boolean; code: string; message: string }>(limited);
    expect(body.code).toBe("APPEAL_RATE_LIMITED");
    expect(body.received).toBe(false);
    expect(body.message).toBe(RISK_OPS.appeals.tooManyMessage);
    expect(body.message).not.toMatch(/[0-9]/);
    // The limiter is the only thing that refused: the two that got through are the two on file.
    expect(countRows(test.db, "SELECT COUNT(*) AS n FROM appeals")).toBe(2);
  });

  it("caps how many appeals one account may keep open", async () => {
    setRiskState(wallet, "HELD");
    const config = createRiskOpsConfig({
      appeals: { wallet: 10, session: 10, device: 10, ip: 10, network: 10, maxOpenPerAccount: 2 },
    });
    const send = () =>
      submitAppeal(
        makeRequest({ url: "https://diggo.fun/api/appeals", ip: "203.0.113.202", session, body: { message: MESSAGE } }),
        test.env,
        { config },
      );
    expect((await send()).status).toBe(201);
    expect((await send()).status).toBe(201);
    const capped = await send();
    expect(capped.status).toBe(429);
    const body = await readJson<{ code?: string; message: string }>(capped);
    expect(body.code).toBeUndefined();
    expect(body.message).toBe(RISK_OPS.appeals.tooManyMessage);
    expect(countRows(test.db, "SELECT COUNT(*) AS n FROM appeals")).toBe(2);
  });

  it("keeps the queue admin-only", async () => {
    const outsider = await adminAppeals(
      makeRequest({ url: "https://diggo.fun/api/admin/appeals", method: "GET", session }),
      test.env,
    );
    expect(outsider.status).toBe(401);
    const anonymous = await adminAppeals(
      makeRequest({ url: "https://diggo.fun/api/admin/appeals", method: "GET" }),
      test.env,
    );
    expect(anonymous.status).toBe(401);
  });

  it("decides an open appeal once, requires a step-up, and only ever lifts restrictions", async () => {
    setRiskState(wallet, "HELD");
    await setRestriction(test.env, {
      wallet,
      kind: "CLAIM_HOLD",
      reasonCode: "operator_review",
      createdBy: adminWallet,
    });
    const filed = await readJson<{ id: string }>(await file({ message: MESSAGE }));

    const queue = await adminAppeals(
      makeRequest({ url: "https://diggo.fun/api/admin/appeals?status=OPEN", method: "GET", session: adminSession }),
      test.env,
    );
    expect(queue.status).toBe(200);
    const listed = await readJson<{
      actor: string;
      open: number;
      appeals: { id: string; wallet: string; status: string; publicMessage: string }[];
    }>(queue);
    expect(listed.actor).toBe(adminWallet);
    expect(listed.open).toBe(1);
    expect(listed.appeals[0].id).toBe(filed.id);
    expect(listed.appeals[0].status).toBe("OPEN");
    // The serialised queue never carries a fingerprint, an IP or a device hash (spec 67).
    expect(JSON.stringify(listed)).not.toContain("203.0.113");
    expect(JSON.stringify(listed)).not.toContain("appeal-device");

    const decision = { id: filed.id, resolution: "accepted", note: "checked the mining history", liftKinds: ["CLAIM_HOLD"] };
    const unsigned = await adminResolveAppeal(
      makeRequest({ url: "https://diggo.fun/api/admin/appeals", session: adminSession, body: decision }),
      test.env,
    );
    expect(unsigned.status).toBe(401);
    expect(countRows(test.db, "SELECT COUNT(*) AS n FROM appeals WHERE status = 'OPEN'")).toBe(1);
    expect(countRows(test.db, "SELECT COUNT(*) AS n FROM account_restrictions WHERE wallet = ?1", wallet)).toBe(1);

    const issued = await adminStepUp(
      makeRequest({
        url: "https://diggo.fun/api/admin/stepup",
        session: adminSession,
        body: { action: "appeal.resolve", payload: decision },
      }),
      test.env,
    );
    const proof = await readJson<{ nonce: string; message: string }>(issued);
    const stepUp = { nonce: proof.nonce, signature: adminSign(proof.message) };

    const resolved = await adminResolveAppeal(
      makeRequest({ url: "https://diggo.fun/api/admin/appeals", session: adminSession, body: { ...decision, stepUp } }),
      test.env,
    );
    expect(resolved.status).toBe(200);
    const decided = await readJson<{
      appeal: { status: string; resolvedBy: string; resolvedAt: number; resolutionNote: string; publicMessage: string };
      lifted: string[];
    }>(resolved);
    expect(decided.appeal.status).toBe("ACCEPTED");
    expect(decided.appeal.resolvedBy).toBe(adminWallet);
    expect(decided.appeal.publicMessage).toBe(RISK_OPS.appeals.statusMessages.ACCEPTED);
    expect(decided.appeal.publicMessage).not.toMatch(/[0-9]/);
    // Accepting lifted only the restriction the operator named, and that is all it can do.
    expect(decided.lifted).toEqual(["CLAIM_HOLD"]);
    expect(countRows(test.db, "SELECT COUNT(*) AS n FROM account_restrictions WHERE wallet = ?1", wallet)).toBe(0);
    expect(countRows(test.db, "SELECT COUNT(*) AS n FROM appeals WHERE wallet = ?1 AND status = 'ACCEPTED'", wallet)).toBe(1);
    expect(countRows(test.db, "SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'appeal.resolve'")).toBe(1);

    // Nothing left to decide, and the spent step-up cannot be reused either.
    const again = await adminResolveAppeal(
      makeRequest({ url: "https://diggo.fun/api/admin/appeals", session: adminSession, body: { ...decision, stepUp } }),
      test.env,
    );
    expect(again.status).toBe(409);
    expect(countRows(test.db, "SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'appeal.resolve'")).toBe(1);
  });
});
