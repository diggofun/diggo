/**
 * Usernames over D1 (migrations/0018_usernames.sql, worker/profile.ts, worker/leaderboard.ts).
 *
 * The properties worth asserting are the ones a read-then-write would get wrong: the UNIQUE index on
 * the normalized name is what settles two wallets racing for the same name, and the change cooldown
 * is applied inside the upsert, so two requests cannot both slip past it. Both are checked against a
 * real SQLite database with every migration applied (worker/test/d1-sqlite.ts).
 *
 * The write is gated (worker/risk.ts, action "profile_update") on a six-per-five-minutes wallet
 * budget, so a test that fires many attempts either stays under that budget or expects the refusal.
 * The flood test below relies on exactly that.
 */
import { describe, expect, it } from "vitest";
import { USERNAME_RULES } from "../../shared/username";
import { leaderboards } from "../leaderboard";
import { publicProfile, setUsername } from "../profile";
import {
  countRows,
  createSession,
  createTestHarness,
  seedPlayer,
  sessionRequest,
  tableNames,
  type TestHarness,
} from "./d1-sqlite";

const API = "https://diggo.fun/api";
const COOLDOWN = USERNAME_RULES.cooldownSeconds;

const WALLET_A = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
const WALLET_B = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const WALLET_C = "7Yq3KdRt9XwZbVnM4fHs2GjPcTaEuWy8LmQr5BvNzXd6";
const WALLET_D = "5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqv";

interface UsernameBody {
  username?: string;
  code?: string;
  changed?: boolean;
  retryAfterSec?: number;
  error?: string;
}

interface RankedRow {
  wallet: string;
  username?: string | null;
}

interface LeaderboardsBody {
  crew: RankedRow[];
  miners: RankedRow[];
}

/** The worker only needs ctx.waitUntil from an ExecutionContext (worker/tokens.ts). */
function context(): ExecutionContext {
  return { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
}

/** Signs a wallet in and posts one name, returning the response and its parsed body. */
async function set(
  harness: TestHarness,
  wallet: string,
  username: unknown,
  session = "session-" + wallet,
): Promise<{ status: number; body: UsernameBody; retryAfter: number | null }> {
  await createSession(harness, wallet, session);
  const response = await setUsername(
    sessionRequest(API + "/api/profile/username", session, { method: "POST", body: { username } }),
    harness.env,
  );
  return {
    status: response.status,
    body: (await response.json()) as UsernameBody,
    retryAfter: response.headers.get("retry-after") === null ? null : Number(response.headers.get("retry-after")),
  };
}

function storedRow(harness: TestHarness, wallet: string) {
  return harness.db
    .prepare("SELECT username, username_normalized, updated_at, change_count FROM usernames WHERE wallet = ?1")
    .get(wallet) as
    | { username: string; username_normalized: string; updated_at: number; change_count: number }
    | undefined;
}

describe("usernames migration", () => {
  it("applies 0018 and enforces uniqueness in the database, not in the handler", () => {
    const harness = createTestHarness();
    expect(harness.migrations).toContain("0018_usernames.sql");
    expect(tableNames(harness.db)).toContain("usernames");

    const insert = harness.db.prepare(
      "INSERT INTO usernames (wallet, username, username_normalized, created_at, updated_at)" +
        " VALUES (?1, ?2, ?3, ?4, ?5)",
    );
    insert.run(WALLET_A, "Alice", "alice", 1, 1);
    // The same name in a different case is the same name.
    expect(() => insert.run(WALLET_B, "ALICE", "alice", 1, 1)).toThrow(/UNIQUE/i);
    // One name per wallet, too.
    expect(() => insert.run(WALLET_A, "Other", "other", 1, 1)).toThrow(/UNIQUE|PRIMARY KEY/i);
    expect(countRows(harness.db, "usernames")).toBe(1);
  });
});

describe("setting a username", () => {
  it("stores the display and normalized forms for a signed session", async () => {
    const harness = createTestHarness();
    const result = await set(harness, WALLET_A, "  Alice_Miner  ");
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ username: "Alice_Miner", changed: true });

    const row = storedRow(harness, WALLET_A);
    expect(row?.username).toBe("Alice_Miner");
    expect(row?.username_normalized).toBe("alice_miner");
    expect(Number(row?.change_count)).toBe(1);

    const signals = harness.db
      .prepare("SELECT action, outcome FROM account_signals WHERE wallet = ?1")
      .all(WALLET_A) as { action: string; outcome: string }[];
    expect(signals.some((signal) => signal.action === "profile_update" && signal.outcome === "ok")).toBe(true);
  });

  it("refuses a write with no signed session", async () => {
    const harness = createTestHarness();
    const response = await setUsername(
      new Request(API + "/api/profile/username", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "Anonymous_One" }),
      }),
      harness.env,
    );
    expect(response.status).toBe(401);
    expect(countRows(harness.db, "usernames")).toBe(0);
  });

  it("refuses a name the shared rules reject and writes nothing", async () => {
    const harness = createTestHarness();
    const cases: [string, unknown, string][] = [
      [WALLET_A, "ab", "TOO_SHORT"],
      [WALLET_B, "a".repeat(21), "TOO_LONG"],
      [WALLET_C, "user name", "CHARSET"],
      [WALLET_D, "admin", "RESERVED"],
      [WALLET_A, "shithead", "BLOCKED"],
    ];
    for (const [wallet, username, code] of cases) {
      const result = await set(harness, wallet, username);
      expect(result.status, String(username)).toBe(400);
      expect(result.body.code, String(username)).toBe(code);
      expect(result.body.error).toBeUndefined();
    }
    expect(countRows(harness.db, "usernames")).toBe(0);
  });

  it("lets exactly one of two wallets hold a name that differs only in case", async () => {
    const harness = createTestHarness();
    const first = await set(harness, WALLET_A, "Miner_One");
    expect(first.status).toBe(200);

    const second = await set(harness, WALLET_B, "miner_one");
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("USERNAME_TAKEN");
    expect(countRows(harness.db, "usernames", "WHERE username_normalized = ?1", "miner_one")).toBe(1);
    expect(storedRow(harness, WALLET_B)).toBeUndefined();
    expect(storedRow(harness, WALLET_A)?.username).toBe("Miner_One");
  });
});

describe("username change cooldown", () => {
  it("holds a change until the window passes, then lets one through", async () => {
    const harness = createTestHarness();
    expect((await set(harness, WALLET_A, "First_Name")).status).toBe(200);

    const blocked = await set(harness, WALLET_A, "Second_Name");
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe("USERNAME_TOO_SOON");
    expect(blocked.retryAfter).toBeGreaterThan(0);
    expect(blocked.retryAfter).toBeLessThanOrEqual(COOLDOWN);
    expect(storedRow(harness, WALLET_A)?.username).toBe("First_Name");

    // The cooldown is a clock, not a lock: move the stored change back past the window.
    const now = Math.floor(Date.now() / 1_000);
    harness.db
      .prepare("UPDATE usernames SET updated_at = ?1 WHERE wallet = ?2")
      .run(now - COOLDOWN - 1, WALLET_A);

    const allowed = await set(harness, WALLET_A, "Third_Name");
    expect(allowed.status).toBe(200);
    expect(allowed.body).toEqual({ username: "Third_Name", changed: true });
    // Two changes actually landed: the refused attempt in between changed nothing.
    expect(Number(storedRow(harness, WALLET_A)?.change_count)).toBe(2);
  });

  it("treats a repeat of the stored name as a retry rather than a change", async () => {
    const harness = createTestHarness();
    await set(harness, WALLET_A, "Keeper_One");
    const again = await set(harness, WALLET_A, "Keeper_One");
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ username: "Keeper_One", changed: false });
    expect(Number(storedRow(harness, WALLET_A)?.change_count)).toBe(1);
  });

  it("stops a wallet flooding the endpoint with the gate's own budget", async () => {
    const harness = createTestHarness();
    await createSession(harness, WALLET_A, "flood");
    const attempts: { status: number; body: UsernameBody }[] = [];
    for (let index = 0; index < 7; index += 1) {
      const response = await setUsername(
        sessionRequest(API + "/api/profile/username", "flood", {
          method: "POST",
          body: { username: "Flood_" + index },
        }),
        harness.env,
      );
      attempts.push({ status: response.status, body: (await response.json()) as UsernameBody });
    }
    expect(attempts[0]?.status).toBe(200);
    expect(attempts[1]?.body.code).toBe("USERNAME_TOO_SOON");
    // The sixth request is the last one the gate's wallet budget allows.
    expect(attempts[6]?.status).toBe(429);
    expect(attempts[6]?.body.code).toBe("RATE_LIMITED");
  });
});

describe("reading a username", () => {
  it("answers publicly, with null before a name is set", async () => {
    const harness = createTestHarness();
    const before = await publicProfile(new Request(API + "/api/profile/" + WALLET_B), harness.env, WALLET_B);
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual({ wallet: WALLET_B, username: null });

    await set(harness, WALLET_B, "Quiet_Miner");
    const after = await publicProfile(new Request(API + "/api/profile/" + WALLET_B), harness.env, WALLET_B);
    expect(await after.json()).toEqual({ wallet: WALLET_B, username: "Quiet_Miner" });
  });

  it("rejects something that is not a wallet address", async () => {
    const harness = createTestHarness();
    const response = await publicProfile(new Request(API + "/api/profile/not-a-wallet"), harness.env, "not-a-wallet");
    expect(response.status).toBe(400);
  });
});

describe("usernames on the leaderboard", () => {
  it("shows a name for a NORMAL account, never for one under review, and nothing when unset", async () => {
    const harness = createTestHarness();
    seedPlayer(harness.db, { wallet: WALLET_A, activeDays: 5 });
    seedPlayer(harness.db, { wallet: WALLET_B, activeDays: 4 });
    seedPlayer(harness.db, { wallet: WALLET_C, activeDays: 3, riskState: "UNDER_REVIEW" });
    seedPlayer(harness.db, { wallet: WALLET_D, activeDays: 1 });
    await set(harness, WALLET_A, "Board_Alice");
    await set(harness, WALLET_B, "Board_Bob");
    // Seeded directly rather than through the endpoint: the gate recomputes an account's reward
    // state on every gated write, so this is what a name looks like on an account that was NORMAL
    // when it was chosen and is under review now.
    harness.db
      .prepare(
        "INSERT INTO usernames (wallet, username, username_normalized, created_at, updated_at)" +
          " VALUES (?1, ?2, ?3, ?4, ?4)",
      )
      .run(WALLET_C, "Hidden_Carol", "hidden_carol", Math.floor(Date.now() / 1_000));

    const view = (await (await leaderboards(harness.env, context())).json()) as LeaderboardsBody;
    expect(view.crew.find((entry) => entry.wallet === WALLET_A)?.username).toBe("Board_Alice");
    expect(view.miners.find((entry) => entry.wallet === WALLET_B)?.username).toBe("Board_Bob");
    // A name belonging to a reviewed account must not reach a public board.
    expect(view.crew.some((entry) => entry.wallet === WALLET_C)).toBe(false);
    expect(JSON.stringify(view)).not.toContain("Hidden_Carol");
    // No name set: the UI falls back to the shortened wallet, so the field is simply empty.
    expect(view.crew.find((entry) => entry.wallet === WALLET_D)?.username).toBeNull();
  });
});
