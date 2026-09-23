/**
 * D1-backed tests for the social layer: the UNIQUE notification dedupe index, idempotent achievement
 * awarding with its ORE cap, the cosmetics catalog and equip rules, and the leaderboard query that
 * must never advertise a non-NORMAL account.
 *
 * Everything runs against worker/test/d1-sqlite.ts, a SQLite-backed fake of D1 with every migration
 * in migrations/ applied.
 */
import { describe, expect, it } from "vitest";
import { ACHIEVEMENT_ORE_TOTAL_CAP, COSMETIC_CATALOG } from "../../shared/social";
import { equipCosmetic, getCosmetics, syncAchievements, unequipCosmetic } from "../cosmetics";
import { leaderboardCandidatesSql, rankCandidates, rowToCandidate, type LeaderboardRow } from "../leaderboard";
import { generateNotifications, listNotifications, markNotificationsRead } from "../notifications";
import {
  countRows,
  createSession,
  createTestHarness,
  seedDiscovery,
  seedPlayer,
  seedToken,
  sessionRequest,
  tableNames,
  type TestHarness,
} from "./d1-sqlite";

const NOW = 1_800_000_000;
const HOUR = 3_600;
const API = "https://diggo.fun/api";

describe("social migrations", () => {
  it("applies every migration including 0011_social", () => {
    const harness = createTestHarness();
    expect(harness.migrations).toContain("0011_social.sql");
    const tables = tableNames(harness.db);
    for (const table of [
      "achievements",
      "cosmetics",
      "notifications",
      "player_achievements",
      "player_cosmetics",
      "player_loadout",
      "player_social_metrics",
      "seasonal_point_events",
      "seasonal_points",
      "seasons",
    ]) {
      expect(tables, table).toContain(table);
    }
    expect(countRows(harness.db, "seasons")).toBe(1);
  });

  it("enforces the unique notification dedupe key", () => {
    const harness = createTestHarness();
    seedPlayer(harness.db, { wallet: "w1" });
    const insert = harness.db.prepare(
      "INSERT OR IGNORE INTO notifications (wallet, kind, payload, dedupe_key, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
    );
    insert.run("w1", "MINE_EXPIRED", "{}", "MINE_EXPIRED:1", NOW);
    expect(Number(insert.run("w1", "MINE_EXPIRED", "{}", "MINE_EXPIRED:1", NOW + 60).changes)).toBe(0);
    expect(countRows(harness.db, "notifications")).toBe(1);
    // A foreign key to players keeps notifications tied to a real account.
    expect(() => insert.run("ghost", "MINE_EXPIRED", "{}", "MINE_EXPIRED:2", NOW)).toThrow();
  });
});

describe("notifications over D1", () => {
  function harnessWithMiner(wallet: string, options: { expiresIn: number; reserveBps?: number; streak?: number }) {
    const harness = createTestHarness();
    seedPlayer(harness.db, {
      wallet,
      activeMint: "mint1",
      lastActivationAt: NOW - HOUR,
      activationExpiresAt: NOW + options.expiresIn,
      streak: options.streak ?? 5,
    });
    seedToken(harness.db, {
      mint: "mint1",
      symbol: "DRILL",
      reserveRemaining: ((options.reserveBps ?? 10_000) / 10_000) * 10_000,
      reserveTotal: 10_000,
    });
    return harness;
  }

  it("inserts each due notification once, however often the sweep runs", async () => {
    const harness = harnessWithMiner("w1", { expiresIn: 2 * HOUR, reserveBps: 8_000 });
    const first = await generateNotifications(harness.env, "w1", NOW);
    expect(first.kinds).toEqual(["MINE_EXPIRES_3H", "REWARD_REDUCTION_APPROACHING"]);
    expect(first.inserted).toBe(2);
    const second = await generateNotifications(harness.env, "w1", NOW);
    expect(second.inserted).toBe(0);
    const third = await generateNotifications(harness.env, "w1", NOW + 60);
    expect(third.inserted).toBe(0);
    expect(countRows(harness.db, "notifications")).toBe(2);

    const listed = await listNotifications(harness.env, "w1");
    expect(listed.unread).toBe(2);
    expect(listed.notifications).toHaveLength(2);
  });

  it("marks notifications read by id and in bulk", async () => {
    const harness = harnessWithMiner("w1", { expiresIn: 2 * HOUR });
    await generateNotifications(harness.env, "w1", NOW);
    const session = await createSession(harness, "w1");
    const listed = await listNotifications(harness.env, "w1");
    const ids = listed.notifications.map((entry) => (entry as { id: number }).id);
    expect(ids).toHaveLength(1);

    const one = await markNotificationsRead(
      sessionRequest(`${API}/notifications/read`, session, { method: "POST", body: { ids } }),
      harness.env,
    );
    expect(await one.json()).toEqual({ updated: 1, unread: 0 });
    const again = await markNotificationsRead(
      sessionRequest(`${API}/notifications/read`, session, { method: "POST", body: { ids } }),
      harness.env,
    );
    expect(await again.json()).toEqual({ updated: 0, unread: 0 });
  });

  it("marks every unread notification when no ids are given", async () => {
    const harness = harnessWithMiner("w1", { expiresIn: 2 * HOUR, reserveBps: 8_000 });
    await generateNotifications(harness.env, "w1", NOW);
    const session = await createSession(harness, "w1");
    const response = await markNotificationsRead(
      sessionRequest(`${API}/notifications/read`, session, { method: "POST", body: {} }),
      harness.env,
    );
    expect(await response.json()).toEqual({ updated: 2, unread: 0 });
  });

  it("rejects a malformed read payload without touching the notifications", async () => {
    const harness = harnessWithMiner("w1", { expiresIn: 2 * HOUR });
    await generateNotifications(harness.env, "w1", NOW);
    const session = await createSession(harness, "w1");
    const brokenJson = await markNotificationsRead(
      new Request(`${API}/notifications/read`, {
        method: "POST",
        headers: { authorization: `Bearer ${session}`, "content-type": "application/json" },
        body: "{",
      }),
      harness.env,
    );
    expect(brokenJson.status).toBe(400);
    const wrongType = await markNotificationsRead(
      sessionRequest(`${API}/notifications/read`, session, { method: "POST", body: { ids: ["nope"] } }),
      harness.env,
    );
    expect(wrongType.status).toBe(400);
    expect((await listNotifications(harness.env, "w1")).unread).toBe(1);
  });

  it("keeps the 3 hour expiry boundary exact", async () => {
    const atBoundary = harnessWithMiner("w1", { expiresIn: 3 * HOUR });
    expect((await generateNotifications(atBoundary.env, "w1", NOW)).kinds).toEqual(["MINE_EXPIRES_3H"]);
    const past = harnessWithMiner("w2", { expiresIn: 3 * HOUR + 1 });
    expect((await generateNotifications(past.env, "w2", NOW)).inserted).toBe(0);
    const expired = harnessWithMiner("w3", { expiresIn: -60 });
    expect((await generateNotifications(expired.env, "w3", NOW)).kinds).toEqual(["MINE_EXPIRED"]);
  });

  it("notifies once per rare discovery", async () => {
    const harness = harnessWithMiner("w1", { expiresIn: 20 * HOUR });
    harness.db.prepare("UPDATE players SET active_mint = NULL WHERE wallet = 'w1'").run();
    seedDiscovery(harness.db, { id: "d1", wallet: "w1", rarity: "epic", createdAt: NOW - 60 });
    const first = await generateNotifications(harness.env, "w1", NOW);
    expect(first.kinds).toEqual(["RARE_DISCOVERY_FOUND"]);
    expect((await generateNotifications(harness.env, "w1", NOW)).inserted).toBe(0);
  });
});

describe("achievements over D1", () => {
  async function playerRow(harness: TestHarness, wallet: string) {
    return harness.d1.prepare("SELECT ore_balance FROM players WHERE wallet = ?1").bind(wallet).first<{ ore_balance: number }>();
  }

  it("awards once, grants capped ORE and clamps to storage capacity", async () => {
    const harness = createTestHarness();
    seedPlayer(harness.db, { wallet: "a1", activeDays: 1, streak: 7 });
    const first = await syncAchievements(harness.env, "a1", NOW);
    expect(first.awarded.map((entry) => entry.id)).toEqual(["FIRST_ACTIVATION", "WEEK_STREAK"]);
    expect(first.oreGranted).toBe(175);
    expect((await playerRow(harness, "a1"))?.ore_balance).toBe(175);

    const second = await syncAchievements(harness.env, "a1", NOW + 60);
    expect(second.awarded).toEqual([]);
    expect(second.oreGranted).toBe(0);
    expect((await playerRow(harness, "a1"))?.ore_balance).toBe(175);
    expect(countRows(harness.db, "player_achievements", "WHERE wallet = 'a1'")).toBe(2);

    seedPlayer(harness.db, { wallet: "a2", activeDays: 1, oreBalance: 795 });
    const clamped = await syncAchievements(harness.env, "a2", NOW);
    expect(clamped.oreGranted).toBe(25);
    expect((await playerRow(harness, "a2"))?.ore_balance).toBe(800);
  });

  it("stops granting ORE once the achievement cap is reached", async () => {
    const harness = createTestHarness();
    seedPlayer(harness.db, { wallet: "capped", activeDays: 1 });
    harness.db
      .prepare("INSERT INTO player_achievements (wallet, achievement_id, ore_granted, awarded_at) VALUES (?1, 'LEGACY_GRANT', ?2, ?3)")
      .run("capped", ACHIEVEMENT_ORE_TOTAL_CAP, NOW - 1_000);
    const result = await syncAchievements(harness.env, "capped", NOW);
    expect(result.awarded.map((entry) => entry.id)).toEqual(["FIRST_ACTIVATION"]);
    expect(result.oreGranted).toBe(0);
    expect((await playerRow(harness, "capped"))?.ore_balance).toBe(0);
    expect(countRows(harness.db, "player_achievements", "WHERE wallet = 'capped'")).toBe(2);
  });

  it("awards nothing for a fresh account", async () => {
    const harness = createTestHarness();
    seedPlayer(harness.db, { wallet: "fresh" });
    const result = await syncAchievements(harness.env, "fresh", NOW);
    expect(result.awarded).toEqual([]);
    expect(result.oreGranted).toBe(0);
  });
});

describe("cosmetics over D1", () => {
  it("seeds the catalog, unlocks starters and never exposes an effect field", async () => {
    const harness = createTestHarness();
    seedPlayer(harness.db, { wallet: "c1" });
    const session = await createSession(harness, "c1");
    const response = await getCosmetics(sessionRequest(`${API}/cosmetics`, session), harness.env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      catalog: { id: string; source: string; status: string; unlocked: boolean; slot: string | null }[];
      purchasesEnabled: boolean;
      equipped: Record<string, string>;
    };
    expect(body.catalog).toHaveLength(COSMETIC_CATALOG.length);
    expect(body.purchasesEnabled).toBe(false);
    expect(body.equipped).toEqual({});
    expect(JSON.stringify(body)).not.toContain("\"power\"");
    expect(countRows(harness.db, "cosmetics")).toBe(COSMETIC_CATALOG.length);
    expect(countRows(harness.db, "achievements")).toBe(9);
    expect(body.catalog.filter((item) => item.unlocked).map((item) => item.id).sort()).toEqual([
      "cart_standard",
      "explosion_dust",
      "pickaxe_rusted",
      "theme_standard",
    ]);
    for (const item of body.catalog.filter((entry) => entry.source === "purchasable")) {
      expect(item.status).toBe("coming_soon");
      expect(item.unlocked).toBe(false);
      expect(item.slot).toBeTruthy();
    }
  });

  it("refuses purchases, unowned cosmetics and unauthenticated equips", async () => {
    const harness = createTestHarness();
    seedPlayer(harness.db, { wallet: "c1" });
    const session = await createSession(harness, "c1");
    const equip = (cosmeticId: string) =>
      equipCosmetic(sessionRequest(`${API}/cosmetics/equip`, session, { method: "POST", body: { cosmeticId } }), harness.env);

    expect((await equip("outfit_neon")).status).toBe(409);
    expect((await equip("pickaxe_iron")).status).toBe(403);
    expect((await equip("not_a_cosmetic")).status).toBe(404);
    expect(countRows(harness.db, "player_loadout")).toBe(0);

    const anonymous = await equipCosmetic(
      new Request(`${API}/cosmetics/equip`, { method: "POST", body: "{}" }),
      harness.env,
    );
    expect(anonymous.status).toBe(401);
  });

  it("equips an unlocked cosmetic into its slot and unequips it", async () => {
    const harness = createTestHarness();
    seedPlayer(harness.db, { wallet: "c1" });
    const session = await createSession(harness, "c1");
    const equipped = await equipCosmetic(
      sessionRequest(`${API}/cosmetics/equip`, session, { method: "POST", body: { cosmeticId: "pickaxe_rusted" } }),
      harness.env,
    );
    expect(equipped.status).toBe(200);
    expect(await equipped.json()).toEqual({ equipped: { pickaxe: "pickaxe_rusted" }, slot: "pickaxe", cosmeticId: "pickaxe_rusted" });
    expect(countRows(harness.db, "player_loadout")).toBe(1);

    const replaced = await equipCosmetic(
      sessionRequest(`${API}/cosmetics/equip`, session, { method: "POST", body: { cosmeticId: "theme_standard" } }),
      harness.env,
    );
    expect(replaced.status).toBe(200);
    expect(countRows(harness.db, "player_loadout")).toBe(2);

    const removed = await unequipCosmetic(
      sessionRequest(`${API}/cosmetics/unequip`, session, { method: "POST", body: { slot: "pickaxe" } }),
      harness.env,
    );
    expect(removed.status).toBe(200);
    expect(countRows(harness.db, "player_loadout")).toBe(1);

    const badSlot = await unequipCosmetic(
      sessionRequest(`${API}/cosmetics/unequip`, session, { method: "POST", body: { slot: "hat" } }),
      harness.env,
    );
    expect(badSlot.status).toBe(400);
  });
});

describe("leaderboard query over D1", () => {
  async function candidates(harness: TestHarness) {
    const rows = (await harness.d1.prepare(leaderboardCandidatesSql(true)).bind("s1-genesis").all<LeaderboardRow>()).results;
    return rows.map(rowToCandidate);
  }

  it("never selects UNDER_REVIEW, HELD or BLOCKED accounts", async () => {
    const harness = createTestHarness();
    seedPlayer(harness.db, { wallet: "honest", activeDays: 3 });
    seedPlayer(harness.db, { wallet: "heldWhale", minersLevel: 90, riskState: "HELD" });
    seedPlayer(harness.db, { wallet: "reviewed", minersLevel: 40, riskState: "UNDER_REVIEW" });
    seedPlayer(harness.db, { wallet: "blocked", minersLevel: 40, riskState: "BLOCKED" });

    const selected = await candidates(harness);
    expect(selected.map((entry) => entry.wallet)).toEqual(["honest"]);
    const legacyRows = (await harness.d1.prepare(leaderboardCandidatesSql(false)).all<LeaderboardRow>()).results;
    expect(legacyRows.map((row) => row.wallet)).toEqual(["honest"]);
    expect(rankCandidates(selected).crew.map((entry) => entry.wallet)).toEqual(["honest"]);
  });

  it("derives seasonal points from gameplay and prefers a stored high-water mark", async () => {
    const harness = createTestHarness();
    seedPlayer(harness.db, { wallet: "honest", activeDays: 3 });
    const derived = await candidates(harness);
    expect(derived[0].seasonalPoints).toBe(30);
    expect(derived[0].achievementCount).toBe(0);
    expect(derived[0].power).toBeGreaterThan(0);

    harness.db.prepare("INSERT INTO seasonal_points (wallet, season_id, points, updated_at) VALUES ('honest', 's1-genesis', 500, ?1)").run(NOW);
    harness.db.prepare("INSERT INTO player_achievements (wallet, achievement_id, ore_granted, awarded_at) VALUES ('honest', 'FIRST_ACTIVATION', 25, ?1)").run(NOW);
    const stored = await candidates(harness);
    expect(stored[0].seasonalPoints).toBe(500);
    expect(stored[0].achievementCount).toBe(1);
    expect(rankCandidates(stored).seasonal_points[0].seasonalPoints).toBe(500);
    expect(rankCandidates(stored).achievements[0].achievementCount).toBe(1);
  });
});
