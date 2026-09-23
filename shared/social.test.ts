import { describe, expect, it } from "vitest";
import { DIGGO_CONFIG, type RewardState } from "./config";
import { crewTotalLevel } from "./crew";
import {
  ACHIEVEMENT_CATALOG,
  ACHIEVEMENT_ORE_TOTAL_CAP,
  COSMETIC_ALLOWED_NUMERIC_FIELDS,
  COSMETIC_CATALOG,
  COSMETIC_SLOTS,
  DEFAULT_SEASON_ID,
  LEADERBOARD_POLICY,
  NOTIFICATION_THRESHOLDS,
  PURCHASABLE_COSMETICS_ENABLED,
  REFERRAL_POLICY,
  SEASONAL_POINTS_TOTAL_CAP,
  SEASONAL_POINT_VALUES,
  achievementMetrics,
  assertNoCosmeticEffects,
  cappedAchievementOre,
  computeNotifications,
  cosmeticById,
  cosmeticEffectFields,
  cosmeticUnexpectedNumericFields,
  cosmeticUnlocked,
  evaluateAchievements,
  leaderboardEligible,
  nextRewardReductionBoundaryBps,
  rankLeaderboard,
  remainingReserveBps,
  seasonStatus,
  seasonalProgressPoints,
  selectSeason,
  unlockedCosmeticIds,
  type LeaderboardCandidate,
  type CosmeticItem,
  type NotificationInput,
} from "./social";

const STARTER_TOTAL = crewTotalLevel(DIGGO_CONFIG.crew.starterLevels);

function candidate(wallet: string, overrides: Partial<LeaderboardCandidate> = {}): LeaderboardCandidate {
  return {
    wallet,
    rewardState: "NORMAL",
    power: 100,
    crewTier: 1,
    crewTotalLevel: STARTER_TOTAL,
    streak: 0,
    longestStreak: 0,
    activeDays: 0,
    achievementCount: 0,
    seasonalPoints: 0,
    oreBalance: 0,
    activeMint: null,
    ...overrides,
  };
}

describe("cosmetics never affect gameplay", () => {
  it("has no gameplay/economic effect fields anywhere in the catalog", () => {
    for (const item of COSMETIC_CATALOG) {
      expect(cosmeticEffectFields(item)).toEqual([]);
    }
    expect(() => assertNoCosmeticEffects()).not.toThrow();
  });

  it("only carries thresholds as numbers", () => {
    for (const item of COSMETIC_CATALOG) {
      expect(cosmeticUnexpectedNumericFields(item)).toEqual([]);
    }
    expect(COSMETIC_ALLOWED_NUMERIC_FIELDS).toEqual(["day", "tier", "points"]);
  });

  it("rejects an injected power or luck field", () => {
    expect(cosmeticEffectFields({ power: 25 })).toEqual(["power"]);
    expect(cosmeticEffectFields({ unlock: { bonus_power: 3 } })).toEqual(["unlock.bonus_power"]);
    expect(cosmeticEffectFields({ list: [{ "Reward-Multiplier": 2 }] })).toEqual(["list[0].Reward-Multiplier"]);
    expect(() =>
      assertNoCosmeticEffects([
        {
          id: "bad",
          kind: "pickaxe",
          name: "Bad",
          description: "",
          source: "earned",
          status: "available",
          unlock: null,
          oreBonus: 10,
        } as unknown as CosmeticItem,
      ]),
    ).toThrow(/oreBonus|orebonus/i);
    expect(cosmeticEffectFields({ day: 7, tier: 3, name: "Steady Digger" })).toEqual([]);
  });

  it("keeps every purchasable cosmetic unlock-free and coming soon", () => {
    const purchasable = COSMETIC_CATALOG.filter((item) => item.source === "purchasable");
    expect(purchasable.length).toBeGreaterThan(0);
    for (const item of purchasable) {
      expect(item.status).toBe("coming_soon");
      expect(item.unlock).toBeNull();
    }
    expect(PURCHASABLE_COSMETICS_ENABLED).toBe(false);
    expect(cosmeticUnlocked(purchasable[0], { streak: 10_000, crewTier: 6, achievementIds: allAchievementIds(), seasonPoints: 1e9 })).toBe(false);
  });

  it("covers every kind in spec 34 and gives each cosmetic a unique id and slot", () => {
    const ids = COSMETIC_CATALOG.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    const kinds = new Set(COSMETIC_CATALOG.map((item) => item.kind));
    expect([...kinds].sort()).toEqual([
      "badge",
      "cart",
      "explosion",
      "mine_theme",
      "miner_outfit",
      "pickaxe",
      "profile_frame",
      "title",
    ]);
    expect(COSMETIC_SLOTS.length).toBe(8);
  });

  it("unlocks earned cosmetics from streak, tier and achievements only", () => {
    const none = { streak: 0, crewTier: 1, achievementIds: [] as string[], seasonPoints: 0 };
    expect(cosmeticUnlocked(cosmeticById("pickaxe_rusted")!, none)).toBe(true);
    expect(cosmeticUnlocked(cosmeticById("pickaxe_iron")!, none)).toBe(false);
    expect(cosmeticUnlocked(cosmeticById("pickaxe_iron")!, { ...none, streak: 7 })).toBe(true);
    expect(cosmeticUnlocked(cosmeticById("outfit_steel")!, { ...none, crewTier: 3 })).toBe(true);
    expect(cosmeticUnlocked(cosmeticById("frame_bronze")!, { ...none, achievementIds: ["FIRST_ACTIVATION"] })).toBe(true);
    expect(unlockedCosmeticIds(none).length).toBeLessThan(COSMETIC_CATALOG.length);
    expect(unlockedCosmeticIds({ streak: 365, crewTier: 6, achievementIds: allAchievementIds(), seasonPoints: 0 }).length)
      .toBe(COSMETIC_CATALOG.length - COSMETIC_CATALOG.filter((item) => item.source === "purchasable" || item.id === "outfit_referral_first").length);
  });

  it("references only real badges and titles from the achievements catalog", () => {
    for (const achievement of ACHIEVEMENT_CATALOG) {
      for (const id of [achievement.badge, achievement.title]) {
        if (id === null) continue;
        const cosmetic = cosmeticById(id);
        expect(cosmetic, id).not.toBeNull();
        expect(cosmetic!.source).toBe("earned");
      }
    }
    for (const item of COSMETIC_CATALOG) {
      if (item.unlock?.type === "achievement") {
        const achievementId = item.unlock.achievementId;
        expect(ACHIEVEMENT_CATALOG.map((entry) => entry.id)).toContain(achievementId);
      }
    }
  });
});

describe("achievements", () => {
  it("awards first activation, 7-day streak, first upgrade, tier and discovery", () => {
    const metrics = achievementMetrics({
      crewLevels: { miners: 3, drills: 2, carts: 1, foreman: 1, storage: 1 },
      activeDays: 1,
      streak: 7,
      discoveries: 1,
    });
    const earned = evaluateAchievements(metrics).map((entry) => entry.id);
    expect(earned).toEqual(["FIRST_ACTIVATION", "FIRST_UPGRADE", "WEEK_STREAK", "FIRST_DISCOVERY"]);
    expect(evaluateAchievements(metrics).length).toBeGreaterThan(0);
  });

  it("does not re-award and is stable across calls", () => {
    const metrics = achievementMetrics({ crewLevels: DIGGO_CONFIG.crew.starterLevels, activeDays: 1 });
    expect(evaluateAchievements(metrics).map((entry) => entry.id)).toEqual(["FIRST_ACTIVATION"]);
    expect(evaluateAchievements(metrics, ["FIRST_ACTIVATION"])).toEqual([]);
    const tier3 = achievementMetrics({ crewLevels: { miners: 20, drills: 8, carts: 4, foreman: 2, storage: 1 } });
    expect(tier3.crewTier).toBeGreaterThanOrEqual(3);
    expect(evaluateAchievements(tier3).map((entry) => entry.id)).toEqual(["FIRST_UPGRADE", "CREW_TIER_3"]);
  });

  it("requires gameplay metrics that cannot be bought", () => {
    const starter = achievementMetrics({ crewLevels: DIGGO_CONFIG.crew.starterLevels });
    expect(evaluateAchievements(starter)).toEqual([]);
    expect(achievementMetrics({ crewLevels: DIGGO_CONFIG.crew.starterLevels, activeDays: -3, streak: Number.NaN }).activeDays).toBe(0);
  });

  it("caps total achievement ORE", () => {
    expect(cappedAchievementOre(0, 400)).toBe(400);
    expect(cappedAchievementOre(ACHIEVEMENT_ORE_TOTAL_CAP - 100, 400)).toBe(100);
    expect(cappedAchievementOre(ACHIEVEMENT_ORE_TOTAL_CAP, 400)).toBe(0);
    expect(cappedAchievementOre(ACHIEVEMENT_ORE_TOTAL_CAP + 5_000, 400)).toBe(0);
    expect(ACHIEVEMENT_ORE_TOTAL_CAP).toBeLessThan(DIGGO_CONFIG.ore.seasonOreCap);
    for (const entry of ACHIEVEMENT_CATALOG) expect(entry.ore).toBeLessThanOrEqual(500);
  });
});

describe("seasonal points", () => {
  it("counts gameplay events only and ignores token amounts", () => {
    const base = seasonalProgressPoints({ activeDays: 10, crewUpgrades: 4, streak: 7, achievementCount: 3, discoveryCount: 2 });
    const milestones = 2; // streak 7 crosses day 3 and day 7
    expect(base).toBe(
      10 * SEASONAL_POINT_VALUES.activation +
        4 * SEASONAL_POINT_VALUES.crew_upgrade +
        milestones * SEASONAL_POINT_VALUES.streak_milestone +
        3 * SEASONAL_POINT_VALUES.achievement +
        2 * SEASONAL_POINT_VALUES.discovery,
    );
    const withTokenData = seasonalProgressPoints({
      activeDays: 10,
      crewUpgrades: 4,
      streak: 7,
      achievementCount: 3,
      discoveryCount: 2,
      tokenAmountUsd: 5_000_000,
      holdings: 1e12,
      tradeVolume24h: 9e9,
    } as never);
    expect(withTokenData).toBe(base);
  });

  it("is monotone, capped and free of token-valued point sources", () => {
    expect(seasonalProgressPoints({ activeDays: 0, crewUpgrades: 0, streak: 0, achievementCount: 0, discoveryCount: 0 })).toBe(0);
    expect(
      seasonalProgressPoints({ activeDays: 0, crewUpgrades: 0, streak: 0, achievementCount: 0, discoveryCount: 100_000 }),
    ).toBeLessThanOrEqual(SEASONAL_POINTS_TOTAL_CAP);
    expect(Object.keys(SEASONAL_POINT_VALUES).sort()).toEqual([
      "achievement",
      "activation",
      "crew_upgrade",
      "discovery",
      "streak_milestone",
    ]);
    expect(seasonalProgressPoints({ activeDays: 5, crewUpgrades: 0, streak: 0, achievementCount: 0, discoveryCount: 0 }))
      .toBeGreaterThan(seasonalProgressPoints({ activeDays: 4, crewUpgrades: 0, streak: 0, achievementCount: 0, discoveryCount: 0 }));
  });

  it("selects the season covering now", () => {
    const seasons = [
      { id: DEFAULT_SEASON_ID, name: "Genesis", startsAt: 1_000, endsAt: 2_000 },
      { id: "s2", name: "Second", startsAt: 2_000, endsAt: 3_000 },
    ];
    expect(seasonStatus(seasons[0], 1_500)).toBe("ACTIVE");
    expect(seasonStatus(seasons[0], 999)).toBe("UPCOMING");
    expect(seasonStatus(seasons[0], 2_000)).toBe("ENDED");
    expect(selectSeason(seasons, 1_500)?.id).toBe(DEFAULT_SEASON_ID);
    expect(selectSeason(seasons, 2_500)?.id).toBe("s2");
    expect(selectSeason(seasons, 9_999)?.id).toBe("s2");
    expect(selectSeason(seasons, 500)?.id).toBe(DEFAULT_SEASON_ID);
    expect(selectSeason([], 500)).toBeNull();
  });
});

describe("leaderboards", () => {
  it("excludes every non-NORMAL reward state", () => {
    const states: RewardState[] = ["NORMAL", "UNDER_REVIEW", "HELD", "BLOCKED"];
    expect(states.map(leaderboardEligible)).toEqual([true, false, false, false]);
    const ranked = rankLeaderboard(
      [
        candidate("heldWhale", { power: 9_999_999, rewardState: "HELD", seasonalPoints: 9_999 }),
        candidate("reviewed", { power: 8_888_888, rewardState: "UNDER_REVIEW" }),
        candidate("blocked", { power: 7_777_777, rewardState: "BLOCKED" }),
        candidate("honest", { power: 10 }),
      ],
      "crew",
    );
    expect(ranked.map((entry) => entry.wallet)).toEqual(["honest"]);
    expect(ranked[0].rank).toBe(1);
    for (const category of ["crew", "streak", "achievements", "seasonal_points"] as const) {
      expect(rankLeaderboard([candidate("heldWhale", { rewardState: "HELD" })], category)).toEqual([]);
    }
  });

  it("ranks each category by progression with deterministic tiebreaks", () => {
    const pool = [
      candidate("a", { power: 500, crewTier: 2, activeDays: 3 }),
      candidate("b", { power: 500, crewTier: 2, activeDays: 9 }),
      candidate("c", { power: 500, crewTier: 3, activeDays: 1 }),
      candidate("d", { power: 100, streak: 30, longestStreak: 30, achievementCount: 4, seasonalPoints: 40 }),
      candidate("e", { streak: 30, longestStreak: 31, seasonalPoints: 40, achievementCount: 4 }),
    ];
    expect(rankLeaderboard(pool, "crew").map((entry) => entry.wallet)).toEqual(["c", "b", "a", "d", "e"]);
    expect(rankLeaderboard(pool, "streak").map((entry) => entry.wallet)).toEqual(["e", "d", "b", "a", "c"]);
    expect(rankLeaderboard(pool, "seasonal_points").map((entry) => entry.wallet)).toEqual(["d", "e", "b", "a", "c"]);
    expect(rankLeaderboard(pool, "crew", 2).map((entry) => entry.rank)).toEqual([1, 2]);
    expect(rankLeaderboard(pool, "crew", 10_000).length).toBeLessThanOrEqual(100);
    expect(rankLeaderboard([], "crew")).toEqual([]);
  });

  it("keeps prizes non-financial", () => {
    expect(LEADERBOARD_POLICY.realValuePrizes).toBe(false);
    expect(LEADERBOARD_POLICY.rewardsTokenAmounts).toBe(false);
    expect(LEADERBOARD_POLICY.requiresAdditionalAntiSybilProtectionForRealValuePrizes).toBe(true);
    expect(cosmeticEffectFields(LEADERBOARD_POLICY)).toEqual([]);
  });
});

const NOW = 1_800_000_000;

function notificationInput(overrides: Partial<NotificationInput> = {}): NotificationInput {
  return {
    now: NOW,
    player: { wallet: "w", streak: 0, longestStreak: 0, lastActivationAt: null, activationExpiresAt: null },
    mine: null,
    discoveries: [],
    ...overrides,
  };
}

function kindsFor(input: NotificationInput): string[] {
  return computeNotifications(input).map((entry) => entry.kind);
}

describe("notifications", () => {
  it("warns exactly three hours before the mine expires", () => {
    const at = (secondsLeft: number) =>
      kindsFor(notificationInput({ player: { wallet: "w", streak: 0, longestStreak: 0, lastActivationAt: null, activationExpiresAt: NOW + secondsLeft } }));
    expect(at(NOTIFICATION_THRESHOLDS.mineExpiringSeconds)).toContain("MINE_EXPIRES_3H");
    expect(at(NOTIFICATION_THRESHOLDS.mineExpiringSeconds + 1)).toEqual([]);
    expect(at(1)).toContain("MINE_EXPIRES_3H");
    expect(at(0)).not.toContain("MINE_EXPIRES_3H");
    expect(at(0)).toContain("MINE_EXPIRED");
    expect(at(-NOTIFICATION_THRESHOLDS.expiredFreshnessSeconds)).toContain("MINE_EXPIRED");
    expect(at(-NOTIFICATION_THRESHOLDS.expiredFreshnessSeconds - 1)).toEqual([]);
  });

  it("warns when the streak deadline is 12 hours away, not before or after", () => {
    const fullWindow = DIGGO_CONFIG.streak.activationSeconds + DIGGO_CONFIG.streak.graceSeconds;
    // The activation whose deadline lands exactly on the 12 hour warning boundary.
    const warningBoundary = NOW - fullWindow + NOTIFICATION_THRESHOLDS.streakAtRiskSeconds;
    const at = (lastActivation: number | null, streak = 5) =>
      kindsFor(notificationInput({ player: { wallet: "w", streak, longestStreak: streak, lastActivationAt: lastActivation, activationExpiresAt: null } }));
    expect(at(warningBoundary)).toContain("STREAK_AT_RISK");
    expect(at(warningBoundary - 1)).toContain("STREAK_AT_RISK"); // one second closer to the deadline
    expect(at(warningBoundary + 1)).toEqual([]); // 12h + 1s: outside the warning window
    expect(at(NOW - fullWindow)).toEqual([]); // deadline is exactly now: the window is closed
    expect(at(NOW - fullWindow - 1)).toEqual([]); // deadline already passed
    expect(at(warningBoundary, 1)).toEqual([]); // a one day streak is not worth an alert
    expect(at(null)).toEqual([]);
  });

  it("fires the 7-day milestone once per streak run and dedupes by activation", () => {
    const seven = notificationInput({ player: { wallet: "w", streak: 7, longestStreak: 7, lastActivationAt: NOW - 60, activationExpiresAt: NOW + 60 } });
    const first = computeNotifications(seven);
    const second = computeNotifications(seven);
    expect(first.filter((entry) => entry.kind === "STREAK_7_DAY")).toHaveLength(1);
    expect(first.map((entry) => entry.dedupeKey)).toEqual(second.map((entry) => entry.dedupeKey));
    expect(first[first.length - 1].dedupeKey).toBe("STREAK_7_DAY:" + (NOW - 60));
    const sixDays = { ...seven, player: { ...seven.player, streak: 6 } };
    expect(kindsFor(sixDays)).not.toContain("STREAK_7_DAY");
    const nextRun = { ...seven, player: { ...seven.player, lastActivationAt: NOW - 30 } };
    expect(computeNotifications(nextRun).some((entry) => entry.kind === "STREAK_7_DAY")).toBe(true);
    expect(computeNotifications(nextRun).find((entry) => entry.kind === "STREAK_7_DAY")!.dedupeKey).not.toBe(first[first.length - 1].dedupeKey);
  });

  it("reports rare discoveries only, within a day, once per discovery", () => {
    const discovery = (id: string, rarity: string, createdAt: number) => ({ id, rarity, createdAt });
    const input = notificationInput({
      discoveries: [
        discovery("d1", "common", NOW - 60),
        discovery("d2", "epic", NOW - 60),
        discovery("d3", "legendary", NOW - NOTIFICATION_THRESHOLDS.rareDiscoveryWindowSeconds),
        discovery("d4", "rare", NOW - NOTIFICATION_THRESHOLDS.rareDiscoveryWindowSeconds - 1),
        discovery("d5", "mythic", NOW + 5),
      ],
    });
    const rare = computeNotifications(input).filter((entry) => entry.kind === "RARE_DISCOVERY_FOUND");
    expect(rare.map((entry) => entry.payload.discoveryId).sort()).toEqual(["d2", "d3"]);
    expect(rare[0].dedupeKey).toBe("RARE_DISCOVERY_FOUND:d2");
  });

  it("warns before a reward reduction and when the reserve is nearly empty", () => {
    const mineAt = (remainingBps: number) => ({
      mint: "mint1",
      symbol: "DRILL",
      status: "MINING_ACTIVE" as const,
      reserveRemaining: (remainingBps / 10_000) * 1_000_000,
      reserveTotal: 1_000_000,
    });
    const at = (remainingBps: number) => computeNotifications(notificationInput({ mine: mineAt(remainingBps) }));
    expect(remainingReserveBps(1_000_000, 1_000_000)).toBe(10_000);
    expect(remainingReserveBps(500_000, 1_000_000)).toBe(5_000);
    expect(remainingReserveBps(0, 0)).toBe(0);
    expect(remainingReserveBps(-5, 1_000)).toBe(0);
    expect(nextRewardReductionBoundaryBps(10_000)).toBe(7_500);
    expect(nextRewardReductionBoundaryBps(8_000)).toBe(7_500);
    expect(nextRewardReductionBoundaryBps(7_500)).toBe(7_500);
    expect(nextRewardReductionBoundaryBps(7_499)).toBe(5_000);
    expect(nextRewardReductionBoundaryBps(0)).toBe(0);
    expect(at(10_000)).toEqual([]); // a fresh reserve is nowhere near a reduction
    expect(at(8_000).map((entry) => entry.kind)).toEqual(["REWARD_REDUCTION_APPROACHING"]);
    expect(at(8_001)).toEqual([]);
    expect(at(7_500)[0].dedupeKey).toBe("REWARD_REDUCTION_APPROACHING:mint1:7500");
    expect(at(6_000)).toEqual([]);
    expect(at(5_500).map((entry) => entry.kind)).toEqual(["REWARD_REDUCTION_APPROACHING"]);
    expect(at(NOTIFICATION_THRESHOLDS.tokenAlmostFullyMinedBps)[0].kind).toBe("TOKEN_ALMOST_FULLY_MINED");
    expect(at(501)).toEqual([]);
    expect(at(0)[0].kind).toBe("TOKEN_ALMOST_FULLY_MINED");
    expect(computeNotifications(notificationInput({}))).toEqual([]);
  });

  it("produces stable dedupe keys for repeated sweeps", () => {
    const input = notificationInput({
      player: { wallet: "w", streak: 7, longestStreak: 7, lastActivationAt: NOW - 60, activationExpiresAt: NOW + 3_600 },
      mine: { mint: "m", symbol: "MOLE", status: "MINING_ACTIVE", reserveRemaining: 7_500, reserveTotal: 10_000 },
      discoveries: [{ id: "dx", rarity: "rare", createdAt: NOW }],
    });
    const first = computeNotifications(input);
    const second = computeNotifications(input);
    expect(first.map((entry) => entry.dedupeKey)).toEqual(second.map((entry) => entry.dedupeKey));
    expect(new Set(first.map((entry) => entry.dedupeKey)).size).toBe(first.length);
    expect(first.map((entry) => entry.kind)).toEqual([
      "MINE_EXPIRES_3H",
      "STREAK_7_DAY",
      "RARE_DISCOVERY_FOUND",
      "REWARD_REDUCTION_APPROACHING",
    ]);
  });
});

describe("referral policy note (spec 69)", () => {
  it("never pays a percentage of downstream earnings", () => {
    expect(REFERRAL_POLICY.implemented).toBe(false);
    expect(REFERRAL_POLICY.percentOfDownstreamEarningsBps).toBe(0);
    expect(REFERRAL_POLICY.forbiddenPayoutBases).toContain("earnings");
    expect(REFERRAL_POLICY.forbiddenPayoutBases).toContain("mining_rewards");
    expect(REFERRAL_POLICY.requiresAntiSybilSelfReferralProtection).toBe(true);
  });
});

function allAchievementIds(): string[] {
  return ACHIEVEMENT_CATALOG.map((entry) => entry.id);
}
