import { describe, expect, it } from "vitest";
import { DIGGO_CONFIG, createDiggoConfig } from "./config";
import {
  activationEligibility,
  activationWindow,
  applyActivation,
  freezeDeadline,
  freezesEarnedByInterval,
  grantFreezes,
  isEligibleForBlock,
  milestoneRewards,
  nextStreak,
  streakDeadline,
  type ActivationRecord,
} from "./streak";

const HOUR = 3_600;
const DAY = 86_400;

function record(overrides: Partial<ActivationRecord> = {}): ActivationRecord {
  return {
    activatedAt: null,
    activeUntil: null,
    lastActivationAt: null,
    streak: 0,
    longestStreak: 0,
    streakFreezes: 0,
    ...overrides,
  };
}

describe("daily activation eligibility", () => {
  it("uses the configured duration and grace window", () => {
    const window = activationWindow(0);
    expect(window.activeUntil).toBe(DIGGO_CONFIG.streak.activationSeconds);
    expect(window.graceUntil).toBe(DIGGO_CONFIG.streak.activationSeconds + DIGGO_CONFIG.streak.graceSeconds);
    expect(streakDeadline(0)).toBe(window.graceUntil);
    expect(freezeDeadline(0)).toBe(window.graceUntil + DIGGO_CONFIG.streak.activationSeconds);
  });

  it("accepts a first activation and rate limits repeats", () => {
    expect(activationEligibility(record(), 0).eligible).toBe(true);
    const tooSoon = activationEligibility(record({ lastActivationAt: 0 }), HOUR);
    expect(tooSoon.eligible).toBe(false);
    expect(tooSoon.reason).toBe("too_soon");
    expect(tooSoon.nextEligibleAt).toBe(DIGGO_CONFIG.streak.minimumReactivationSeconds);
    expect(activationEligibility(record({ lastActivationAt: 0 }), 20 * HOUR).eligible).toBe(true);
  });

  it("blocks activation replay attempts before the window opens", () => {
    const first = activationEligibility(record(), 0);
    expect(first.eligible).toBe(true);
    const replay = activationEligibility(record({ lastActivationAt: 0, activeUntil: DAY }), 60);
    expect(replay.eligible).toBe(false);
    expect(replay.reason).toBe("too_soon");
  });
});

describe("streak continue, break and freeze consumption", () => {
  it("continues a streak inside the grace window", () => {
    expect(nextStreak(0, 30 * HOUR, 6, 0)).toEqual({ streak: 7, freezes: 0, usedFreeze: false });
    expect(nextStreak(0, streakDeadline(0), 6, 0)).toEqual({ streak: 7, freezes: 0, usedFreeze: false });
  });

  it("consumes exactly one freeze per missed window", () => {
    expect(nextStreak(0, 48 * HOUR, 6, 1)).toEqual({ streak: 7, freezes: 0, usedFreeze: true });
    expect(nextStreak(0, freezeDeadline(0), 6, 2)).toEqual({ streak: 7, freezes: 1, usedFreeze: true });
    expect(nextStreak(0, 48 * HOUR, 6, 0)).toEqual({ streak: 1, freezes: 0, usedFreeze: false });
  });

  it("breaks the streak past the freeze deadline", () => {
    expect(nextStreak(0, freezeDeadline(0) + 1, 12, 3)).toEqual({ streak: 1, freezes: 3, usedFreeze: false });
  });

  it("honours a reconfigured duration and grace", () => {
    const fast = createDiggoConfig({ streak: { activationSeconds: HOUR, graceSeconds: 0 } });
    expect(nextStreak(0, HOUR, 3, 0, fast)).toEqual({ streak: 4, freezes: 0, usedFreeze: false });
    expect(nextStreak(0, HOUR + 1, 3, 0, fast).streak).toBe(1);
    expect(nextStreak(0, HOUR + 1, 3, 1, fast)).toEqual({ streak: 4, freezes: 0, usedFreeze: true });
  });

  it("reports the activation outcome and keeps the longest streak", () => {
    const first = applyActivation(record(), 0);
    expect(first.kind).toBe("first_activation");
    expect(first.streak).toBe(1);
    expect(first.window.activeUntil).toBe(DAY);

    const continued = applyActivation(record({ lastActivationAt: 0, streak: 6 }), 24 * HOUR);
    expect(continued.kind).toBe("continued");
    expect(continued.streak).toBe(7);

    const frozen = applyActivation(record({ lastActivationAt: 0, streak: 6, streakFreezes: 1 }), 48 * HOUR);
    expect(frozen.kind).toBe("freeze_consumed");
    expect(frozen.usedFreeze).toBe(true);
    expect(frozen.streak).toBe(7);

    const broken = applyActivation(
      record({ lastActivationAt: 0, streak: 10, longestStreak: 12, streakFreezes: 0 }),
      100 * HOUR,
    );
    expect(broken.kind).toBe("broken");
    expect(broken.streak).toBe(1);
    expect(broken.longestStreak).toBe(12);
  });
});

describe("streak milestones", () => {
  it("awards ORE, XP, badges, titles and freezes at 3/7/14/30/60/100/365", () => {
    expect(DIGGO_CONFIG.streak.milestones.map((milestone) => milestone.day)).toEqual([
      3, 7, 14, 30, 60, 100, 365,
    ]);
    const three = milestoneRewards(2, 3);
    expect(three.milestones.map((milestone) => milestone.day)).toEqual([3]);
    expect(three.rewards.ore).toBe(DIGGO_CONFIG.streak.milestones[0].ore);
    expect(three.rewards.badges).toContain("FIRST_STEPS");

    const multi = milestoneRewards(0, 100);
    expect(multi.milestones.map((milestone) => milestone.day)).toEqual([3, 7, 14, 30, 60, 100]);
    expect(multi.rewards.ore).toBe(9_525);
    expect(multi.rewards.xp).toBe(2_500);
    expect(multi.rewards.titles).toContain("Century Miner");
    expect(multi.rewards.freezes).toBe(2);
  });

  it("never awards token or block-reward multipliers", () => {
    for (const milestone of DIGGO_CONFIG.streak.milestones) {
      expect(Object.keys(milestone).sort()).toEqual(["badges", "day", "freezes", "ore", "titles", "xp"]);
      const serialized = JSON.stringify(milestone).toLowerCase();
      for (const forbidden of ["multiplier", "blockreward", "tokenshare", "luck", "yield", "apr"]) {
        expect(serialized).not.toContain(forbidden);
      }
    }
    const rewards = milestoneRewards(0, 365).rewards;
    expect(Object.keys(rewards).sort()).toEqual(["badges", "freezes", "ore", "titles", "xp"]);
  });

  it("does not award a milestone twice and skips milestones already passed", () => {
    expect(milestoneRewards(7, 8).milestones).toHaveLength(0);
    expect(milestoneRewards(365, 366).rewards.ore).toBe(0);
    expect(milestoneRewards(10, 1).rewards.ore).toBe(0);
  });
});

describe("Streak Freeze economy", () => {
  it("earns freezes from sustained play at the configured interval", () => {
    expect(freezesEarnedByInterval(6, 7)).toBe(1);
    expect(freezesEarnedByInterval(7, 13)).toBe(0);
    expect(freezesEarnedByInterval(13, 14)).toBe(1);
    expect(freezesEarnedByInterval(1, 1)).toBe(0);
  });

  it("caps banked freezes at the configured maximum", () => {
    expect(grantFreezes(0, 5)).toEqual({ freezes: DIGGO_CONFIG.streak.freezeCap, awarded: DIGGO_CONFIG.streak.freezeCap });
    expect(grantFreezes(DIGGO_CONFIG.streak.freezeCap, 1)).toEqual({
      freezes: DIGGO_CONFIG.streak.freezeCap,
      awarded: 0,
    });
  });

  it("earns freezes in game and stops at the cap", () => {
    const atCap = applyActivation(record({ lastActivationAt: 0, streak: 20, streakFreezes: 3 }), 24 * HOUR);
    expect(atCap.streak).toBe(21);
    expect(atCap.freezes).toBe(DIGGO_CONFIG.streak.freezeCap);
    expect(atCap.rewards.freezes).toBe(0);

    const earns = applyActivation(record({ lastActivationAt: 0, streak: 6, streakFreezes: 0 }), 24 * HOUR);
    expect(earns.streak).toBe(7);
    expect(earns.freezes).toBe(1);
    expect(earns.rewards.freezes).toBe(1);
  });
});

describe("block eligibility boundaries (spec 77)", () => {
  it("is half open: the activation instant counts, active_until never does", () => {
    const activeUntil = 18 * HOUR;
    expect(isEligibleForBlock(activeUntil, 18 * HOUR - 1)).toBe(true);
    expect(isEligibleForBlock(activeUntil, 18 * HOUR)).toBe(false);
    expect(isEligibleForBlock(activeUntil, 18 * HOUR + 1)).toBe(false);
    expect(isEligibleForBlock(activeUntil, 0)).toBe(true);
    expect(isEligibleForBlock(activeUntil, -1)).toBe(false);
  });

  it("respects the activation timestamp when supplied", () => {
    const activatedAt = 12 * HOUR;
    const activeUntil = activatedAt + 24 * HOUR;
    expect(isEligibleForBlock(activeUntil, activatedAt, activatedAt)).toBe(true);
    expect(isEligibleForBlock(activeUntil, activatedAt - 1, activatedAt)).toBe(false);
    expect(isEligibleForBlock(activeUntil, activeUntil, activatedAt)).toBe(false);
  });

  it("treats a never-activated or paused crew as ineligible", () => {
    expect(isEligibleForBlock(null, 1_000)).toBe(false);
    expect(isEligibleForBlock(Number.NaN, 1_000)).toBe(false);
    expect(isEligibleForBlock(0, 0)).toBe(false);
  });

  it("counts 24 hourly blocks for a 24h activation and excludes the closing block", () => {
    const window = activationWindow(0);
    const times: number[] = [];
    for (let block = 0; block <= window.activeUntil; block += HOUR) times.push(block);
    const eligible = times.filter((block) => isEligibleForBlock(window.activeUntil, block, window.activatedAt));
    expect(times).toHaveLength(25);
    expect(eligible).toHaveLength(24);
    expect(eligible[eligible.length - 1]).toBe(window.activeUntil - HOUR);
  });
});

