/**
 * Server-driven notification generation.
 *
 * The point of these tests is that the *server* decides a player has a notification, for every
 * relevant player, with or without a client open. So they drive the cron entry points
 * (runSocialCron, sweepNotifications) rather than generateNotifications directly, and they assert
 * on what a second, independent read of the same database reports.
 *
 * Three properties are covered that a per-wallet test cannot see:
 *   - every relevant player is reached in one sweep, across all seven kinds;
 *   - the same event is not claimed by whichever account happened to be swept first
 *     (notifications.dedupe_key is UNIQUE across the whole table);
 *   - a sweep that hits its row budget drains the backlog on the following ticks instead of
 *     re-selecting the accounts it already notified.
 *
 * Everything runs against worker/test/d1-sqlite.ts, a SQLite-backed fake of D1 with every migration
 * in migrations/ applied.
 */
import { describe, expect, it } from "vitest";
import { listNotifications, runSocialCron, sweepNotifications } from "../notifications";
import { countRows, createTestHarness, seedDiscovery, seedPlayer, seedToken } from "./d1-sqlite";

const NOW = 1_800_000_000;
const MINUTE = 60;
const HOUR = 3_600;
const DAY = 86_400;

/** The kinds stored for one wallet, oldest row last, as the bell would read them. */
async function storedKinds(env: Parameters<typeof listNotifications>[0], wallet: string): Promise<string[]> {
  const listed = await listNotifications(env, wallet);
  return listed.notifications.map((entry) => (entry as { kind: string }).kind);
}

describe("notification sweep over D1", () => {
  it("reaches every relevant player in one cron run, across every kind", async () => {
    const harness = createTestHarness();
    const db = harness.db;

    // A mine closing inside the three hour warning.
    seedPlayer(db, { wallet: "closing", activationExpiresAt: NOW + 2 * HOUR, lastActivationAt: NOW - HOUR, streak: 5 });
    // A streak deadline inside the twelve hour warning: 24h activation + 12h grace puts it an hour out.
    seedPlayer(db, { wallet: "atRisk", lastActivationAt: NOW - 35 * HOUR, streak: 4 });
    // The seven day milestone, reached and not yet announced.
    seedPlayer(db, { wallet: "milestone", lastActivationAt: NOW - HOUR, activationExpiresAt: NOW + 23 * HOUR, streak: 7 });
    // A rare find inside the freshness window, with no mine and no streak in play.
    seedPlayer(db, { wallet: "lucky" });
    seedDiscovery(db, { id: "d-epic", wallet: "lucky", rarity: "epic", createdAt: NOW - MINUTE });
    // Restricted accounts are never nudged to chase rewards (spec 53, 63).
    seedPlayer(db, {
      wallet: "held",
      riskState: "HELD",
      activationExpiresAt: NOW + 2 * HOUR,
      lastActivationAt: NOW - HOUR,
      streak: 5,
    });

    const result = await runSocialCron(harness.env, NOW);
    // The held account is not a candidate at all, so the sweep never even loads its inputs.
    expect(result.wallets).toBe(4);

    expect(await storedKinds(harness.env, "closing")).toEqual(["MINE_EXPIRES_3H"]);
    expect(await storedKinds(harness.env, "atRisk")).toEqual(["STREAK_AT_RISK"]);
    expect(await storedKinds(harness.env, "milestone")).toEqual(["STREAK_7_DAY"]);
    expect(await storedKinds(harness.env, "lucky")).toEqual(["RARE_DISCOVERY_FOUND"]);
    expect(await storedKinds(harness.env, "held")).toEqual([]);
    expect(countRows(db, "notifications")).toBe(4);
  });

  it("inserts nothing on a second run of the same cron tick", async () => {
    const harness = createTestHarness();
    seedPlayer(harness.db, {
      wallet: "closing",
      activationExpiresAt: NOW + 2 * HOUR,
      lastActivationAt: NOW - HOUR,
      streak: 5,
      activeMint: "mint1",
    });
    seedToken(harness.db, { mint: "mint1", reserveRemaining: 8_000, reserveTotal: 10_000 });

    const first = await runSocialCron(harness.env, NOW);
    expect(first.notificationsInserted).toBe(2);
    const after = countRows(harness.db, "notifications");

    // The next tick five minutes later, then one an hour later: both are the same sweep as far as
    // the stored rows are concerned, so neither may add anything.
    expect((await runSocialCron(harness.env, NOW + 5 * MINUTE)).notificationsInserted).toBe(0);
    expect((await runSocialCron(harness.env, NOW + HOUR)).notificationsInserted).toBe(0);
    expect(countRows(harness.db, "notifications")).toBe(after);
    expect(await storedKinds(harness.env, "closing")).toEqual([
      "REWARD_REDUCTION_APPROACHING",
      "MINE_EXPIRES_3H",
    ]);
  });

  it("gives the same event to every player it is due for", async () => {
    const harness = createTestHarness();
    // Two wallets in one mine that share an activation expiry to the second: both halves of the
    // dedupe key - the mint and the timestamp - are identical for the two of them.
    const expiresAt = NOW + 2 * HOUR;
    for (const wallet of ["first", "second"]) {
      seedPlayer(harness.db, {
        wallet,
        activationExpiresAt: expiresAt,
        lastActivationAt: NOW - HOUR,
        streak: 5,
        activeMint: "shared",
      });
    }
    seedToken(harness.db, { mint: "shared", reserveRemaining: 400, reserveTotal: 10_000 });

    await runSocialCron(harness.env, NOW);

    // The old wallet-scoped keys would have let the first wallet swept claim the row and deny the
    // second one both of its notifications.
    for (const wallet of ["first", "second"]) {
      expect(await storedKinds(harness.env, wallet), wallet).toEqual([
        "TOKEN_ALMOST_FULLY_MINED",
        "MINE_EXPIRES_3H",
      ]);
    }
    expect(countRows(harness.db, "notifications")).toBe(4);
  });

  it("still notifies a player who has not opened the app for over a month", async () => {
    const harness = createTestHarness();
    // Five days expired, forty days since the last activation: the mine is long paused, which is
    // exactly the state the notification exists to report. Nothing about this player is recent.
    seedPlayer(harness.db, {
      wallet: "dormant",
      lastActivationAt: NOW - 40 * DAY,
      activationExpiresAt: NOW - 5 * DAY,
      streak: 5,
    });

    const result = await runSocialCron(harness.env, NOW);
    expect(result.wallets).toBe(1);
    expect(await storedKinds(harness.env, "dormant")).toEqual(["MINE_EXPIRED"]);
  });

  it("drains a backlog larger than one sweep over consecutive ticks", async () => {
    const harness = createTestHarness();
    const wallets = ["soonest", "middle", "latest"];
    wallets.forEach((wallet, index) => {
      seedPlayer(harness.db, {
        wallet,
        lastActivationAt: NOW - HOUR,
        activationExpiresAt: NOW + (index + 1) * HOUR,
        streak: 5,
      });
    });

    // Two at a time, most urgent first: the sweep is bounded, so the third waits for the next tick
    // rather than being re-selected behind the first two forever.
    expect(await sweepNotifications(harness.env, NOW, 2)).toBe(2);
    expect(await storedKinds(harness.env, "soonest")).toEqual(["MINE_EXPIRES_3H"]);
    expect(await storedKinds(harness.env, "middle")).toEqual(["MINE_EXPIRES_3H"]);
    expect(await storedKinds(harness.env, "latest")).toEqual([]);

    expect(await sweepNotifications(harness.env, NOW, 2)).toBe(1);
    expect(await storedKinds(harness.env, "latest")).toEqual(["MINE_EXPIRES_3H"]);

    // Nothing left owing, so the sweep has nothing to do on the tick after that.
    expect(await sweepNotifications(harness.env, NOW, 2)).toBe(0);
    expect(countRows(harness.db, "notifications")).toBe(3);
  });
});
