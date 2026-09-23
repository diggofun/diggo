/**
 * Mining, streak, block-accounting and reward-claim tests (spec 82).
 *
 * These run against real SQLite (see ./test/mining-d1.ts): every migration is applied, so the
 * CHECK/UNIQUE constraints and the conditional-UPDATE semantics the Worker depends on are real.
 * Time is driven with vi.setSystemTime, which is the only clock the mining code reads.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MineInfo, MiningReport, PlayerProfile } from "../shared/types";
import { crewUpgrade } from "./crew";
import {
  activateChallenge,
  activateMine,
  claimReward,
  claimRewardChallenge,
  collectMiningReport,
  mineInfo,
  settleRewardClaim,
  simulateAdvance,
  switchMine,
  type MineState,
  type PositionSettlement,
  type PositionSnapshot,
} from "./mining";
import {
  createHarness,
  getRequest,
  jsonRequest,
  openBreaker,
  patchClaim,
  readClaims,
  readMineState,
  readPlayer,
  readPosition,
  readSocialMetrics,
  readTokenStatus,
  clearRestriction,
  seedClaim,
  seedPlayer,
  seedRestriction,
  seedToken,
  type Harness,
  type TestWallet,
} from "./test/mining-d1";

const START = 1_800_000_000;
const DAY = 86_400;
const MINT_A = "MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const MINT_B = "MintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const MINT_C = "MintCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

/** A crew at minimum levels mines exactly 100 Power, which keeps the block math exact. */
const MIN_POWER = 100;

interface ActivationBody {
  report: MiningReport;
  player: PlayerProfile;
  settlements: PositionSettlement[];
  streakOutcome: { streak: number; kind: string; freezes: number; usedFreeze: boolean };
}

interface ClaimBody {
  claimed: boolean;
  alreadyClaimed?: boolean;
  claim: { id: string; status: string; amount: number } | null;
}

function at(seconds: number): void {
  vi.setSystemTime((START + seconds) * 1_000);
}

async function body<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** Runs the real signed-challenge flow: request a nonce, sign it, activate. */
async function activate(
  h: Harness,
  wallet: TestWallet,
  mint?: string,
): Promise<{ response: Response; request: { wallet: string; nonce: string; signature: string; mint?: string } }> {
  const challenge = await body<{ nonce: string; message: string }>(
    await activateChallenge(jsonRequest("/api/mine/activate/challenge", { wallet: wallet.address }), h.env),
  );
  const request = {
    wallet: wallet.address,
    nonce: challenge.nonce,
    signature: h.sign(wallet, challenge.message),
    mint,
  };
  return { response: await activateMine(jsonRequest("/api/mine/activate", request), h.env), request };
}

async function claimOnce(
  h: Harness,
  wallet: TestWallet,
  rewardId: string,
  headers: Record<string, string>,
): Promise<Response> {
  const challenge = await body<{ nonce: string; message: string }>(
    await claimRewardChallenge(jsonRequest("/api/rewards/claim/challenge", { wallet: wallet.address, rewardId }), h.env),
  );
  return claimReward(
    jsonRequest(
      "/api/rewards/claim",
      { rewardId, nonce: challenge.nonce, signature: h.sign(wallet, challenge.message) },
      headers,
    ),
    h.env,
  );
}

function mineStateFixture(overrides: Partial<MineState> = {}): MineState {
  return {
    mint: "FIXTURE",
    rewardIndex: 0n,
    lastBlock: 1_000,
    remainingReserve: 1_000_000n,
    initialReserve: 1_000_000n,
    epoch: 0,
    status: "MINING_ACTIVE",
    totalEligiblePower: 100n,
    rewardPerBlock: 1_000n,
    committed: 0n,
    dustScaled: 0n,
    blockInterval: 300,
    epochLength: 604_800,
    epochEndsAt: 0,
    authority: "OFFCHAIN",
    ...overrides,
  };
}

function positionFixture(overrides: Partial<PositionSnapshot> = {}): PositionSnapshot {
  return {
    wallet: "WALLET",
    assignedPower: 100n,
    lastRewardIndex: 0n,
    pendingReward: 0n,
    activatedAt: 700,
    activeUntil: 1_300,
    paused: false,
    ...overrides,
  };
}

describe("block boundaries (spec 77)", () => {
  it("does not credit a block that lands exactly on active_until", () => {
    const outcome = simulateAdvance({
      state: mineStateFixture(),
      positions: [positionFixture({ activeUntil: 1_300 })],
      upTo: 1_300,
    });
    expect(outcome.blocksAdvanced).toBe(1);
    expect(outcome.expiries).toHaveLength(1);
    expect(outcome.expiries[0].earned).toBe(0n);
    expect(outcome.state.totalEligiblePower).toBe(0n);
    // A block with no eligible power leaves the reserve untouched.
    expect(outcome.state.remainingReserve).toBe(1_000_000n);
  });

  it("credits the block immediately before active_until", () => {
    const outcome = simulateAdvance({
      state: mineStateFixture(),
      positions: [positionFixture({ activeUntil: 1_301 })],
      upTo: 1_300,
    });
    expect(outcome.blocksAdvanced).toBe(1);
    expect(outcome.expiries).toHaveLength(0);
    expect(outcome.state.remainingReserve).toBe(999_000n);
    expect(outcome.state.rewardIndex).toBe(10_000_000_000_000n);
  });

  it("keeps the block landing exactly on activation for the newly armed position", () => {
    const before = simulateAdvance({
      state: mineStateFixture({ lastBlock: 1_000, totalEligiblePower: 0n }),
      positions: [],
      upTo: 1_300,
      exclusive: true,
    });
    // exclusive: the block at 1_300 is still unclaimed, so a position armed at 1_300 can earn it.
    expect(before.blocksAdvanced).toBe(0);
    const armed: PositionSnapshot = positionFixture({ activatedAt: 1_300, activeUntil: 2_500 });
    const after = simulateAdvance({
      // The pure function does not maintain the mine's power total; arming a position does that.
      state: { ...before.state, totalEligiblePower: 100n },
      positions: [armed],
      upTo: 1_300,
    });
    expect(after.blocksAdvanced).toBe(1);
    expect(after.state.rewardIndex).toBe(10_000_000_000_000n);
  });
});

describe("activation and streak", () => {
  let h: Harness;

  beforeEach(async () => {
    vi.useFakeTimers();
    at(0);
    h = await createHarness();
    await seedToken(h.env, { mint: MINT_A });
  });

  afterEach(() => {
    h.close();
    vi.useRealTimers();
  });

  it("rejects a reused activation nonce and never credits ORE twice", async () => {
    const wallet = h.createWallet();
    await seedPlayer(h.env, wallet.address, { created_at: START - 30 * DAY, miners_level: 1 });

    const first = await activate(h, wallet, MINT_A);
    expect(first.response.status).toBe(200);
    const payload = await body<ActivationBody>(first.response);
    expect(payload.report.oreGained).toBe(50);
    expect(payload.report.streak).toBe(1);
    expect(payload.report.accounting?.source).toBe("OFFCHAIN");
    expect(payload.player.activationState).toBe("ACTIVE");

    const afterFirst = await readPlayer(h.env, wallet.address);
    expect(afterFirst.ore_balance).toBe(50);
    expect(afterFirst.streak).toBe(1);
    expect(afterFirst.activation_expires_at).toBe(START + DAY);
    expect(afterFirst.activated_at).toBe(START);

    // The nonce was consumed, so the very same signed request is refused (spec 47).
    const replay = await activateMine(jsonRequest("/api/mine/activate", first.request), h.env);
    expect(replay.status).toBe(401);
    const afterReplay = await readPlayer(h.env, wallet.address);
    expect(afterReplay.ore_balance).toBe(50);
    expect(afterReplay.active_days).toBe(1);
  });

  it("rejects an old signature presented under a fresh nonce", async () => {
    const wallet = h.createWallet();
    await seedPlayer(h.env, wallet.address, { created_at: START - 30 * DAY, miners_level: 1 });
    const first = await activate(h, wallet, MINT_A);
    expect(first.response.status).toBe(200);

    const challenge = await body<{ nonce: string; message: string }>(
      await activateChallenge(jsonRequest("/api/mine/activate/challenge", { wallet: wallet.address }), h.env),
    );
    const stale = await activateMine(
      jsonRequest("/api/mine/activate", {
        wallet: wallet.address,
        nonce: challenge.nonce,
        signature: first.request.signature,
      }),
      h.env,
    );
    expect(stale.status).toBe(401);
    const player = await readPlayer(h.env, wallet.address);
    expect(player.ore_balance).toBe(50);
  });

  it("answers 403 VERIFICATION_REQUIRED for a wallet that must clear a challenge", async () => {
    const wallet = h.createWallet();
    await seedPlayer(h.env, wallet.address, { created_at: START - 30 * DAY, miners_level: 1 });
    await seedRestriction(h.env, wallet.address, "CHALLENGE_REQUIRED");
    const attempt = await activate(h, wallet, MINT_A);
    expect(attempt.response.status).toBe(403);
    const refusal = await body<{ code: string; message: string }>(attempt.response);
    expect(refusal.code).toBe("VERIFICATION_REQUIRED");
    expect(refusal.message).toBe("Additional verification required.");
    const player = await readPlayer(h.env, wallet.address);
    expect(player.ore_balance).toBe(0);
  });

  it("grants milestone rewards, XP, badges and earned freezes on the streak", async () => {
    const wallet = h.createWallet();
    await seedPlayer(h.env, wallet.address, {
      created_at: START - 30 * DAY,
      miners_level: 1,
      streak: 2,
      last_activation_at: START - 20 * 3_600,
      activation_expires_at: START + 4 * 3_600,
      ore_collected_at: START - 20 * 3_600,
    });

    const attempt = await activate(h, wallet, MINT_A);
    expect(attempt.response.status).toBe(200);
    const payload = await body<ActivationBody>(attempt.response);
    // 20h of work (400) + activation bonus (50) + the day-3 milestone (75).
    expect(payload.report.activeSeconds).toBe(20 * 3_600);
    expect(payload.report.oreGained).toBe(525);
    expect(payload.report.milestones?.[0]?.day).toBe(3);
    expect(payload.streakOutcome.streak).toBe(3);

    const player = await readPlayer(h.env, wallet.address);
    expect(player.streak).toBe(3);
    expect(player.longest_streak).toBe(3);
    expect(player.xp).toBe(25);
    expect(player.badges).toContain("FIRST_STEPS");
    expect(player.streak_grace_until).toBe(START + DAY + 12 * 3_600);
  });

  it("earns a Streak Freeze at the configured interval and banks it", async () => {
    const wallet = h.createWallet();
    await seedPlayer(h.env, wallet.address, {
      created_at: START - 30 * DAY,
      miners_level: 1,
      streak: 6,
      last_activation_at: START - 21 * 3_600,
      activation_expires_at: START + 3 * 3_600,
      ore_collected_at: START - 21 * 3_600,
    });
    const attempt = await activate(h, wallet, MINT_A);
    const payload = await body<ActivationBody>(attempt.response);
    expect(payload.streakOutcome.streak).toBe(7);
    const player = await readPlayer(h.env, wallet.address);
    expect(player.streak_freezes).toBe(1);
    expect(player.titles).toContain("Steady Digger");
  });

  it("reports ORE overflow instead of silently dropping it", async () => {
    const wallet = h.createWallet();
    // Starter storage holds 800 ORE; leaving 10 free makes the window overflow.
    await seedPlayer(h.env, wallet.address, {
      created_at: START - 30 * DAY,
      miners_level: 1,
      streak: 2,
      ore_balance: 790,
      last_activation_at: START - 20 * 3_600,
      activation_expires_at: START + 4 * 3_600,
      ore_collected_at: START - 3_600,
    });
    const payload = await body<ActivationBody>((await activate(h, wallet, MINT_A)).response);
    expect(payload.report.oreGained).toBe(10);
    expect(payload.report.oreOverflow).toBe(135);
    const player = await readPlayer(h.env, wallet.address);
    expect(player.ore_balance).toBe(800);
    expect(player.ore_overflow).toBe(135);
  });

  it("arms the mining position on activation and keeps the activation rate limit", async () => {
    const wallet = h.createWallet();
    await seedPlayer(h.env, wallet.address, { created_at: START - 30 * DAY, miners_level: 1 });
    await activate(h, wallet, MINT_A);
    const position = await readPosition(h.env, wallet.address, MINT_A);
    expect(position?.assigned_power).toBe(String(MIN_POWER));
    expect(position?.active_until).toBe(START + DAY);
    expect(position?.paused).toBe(0);
    const mine = await readMineState(h.env, MINT_A);
    expect(mine.totalEligiblePower).toBe(BigInt(MIN_POWER));
    expect(mine.authority).toBe("OFFCHAIN");
    expect(h.queue.some((event) => event.type === "sync_power")).toBe(true);

    // The gate's own wallet budget is 6 activations per 300s; the seventh request is refused.
    let last = 0;
    for (let index = 0; index < 7; index += 1) {
      const challenge = await activateChallenge(
        jsonRequest("/api/mine/activate/challenge", { wallet: wallet.address }),
        h.env,
      );
      last = challenge.status;
    }
    expect(last).toBe(429);
  });
});

describe("paused mines", () => {
  let h: Harness;

  beforeEach(async () => {
    vi.useFakeTimers();
    at(0);
    h = await createHarness();
    await seedToken(h.env, { mint: MINT_A });
  });

  afterEach(() => {
    h.close();
    vi.useRealTimers();
  });

  it("generates no ORE after active_until has passed", async () => {
    const wallet = h.createWallet();
    await seedPlayer(h.env, wallet.address, {
      created_at: START - 30 * DAY,
      miners_level: 1,
      streak: 1,
      activated_at: START,
      last_activation_at: START,
      activation_expires_at: START + DAY,
      ore_collected_at: START,
      active_mint: MINT_A,
    });
    // 30h later: only the 24h the crew was actually active may be credited.
    at(30 * 3_600);
    const headers = await h.sessionFor(wallet.address);
    const response = await collectMiningReport(jsonRequest("/api/mine/report/collect", {}, headers), h.env);
    expect(response.status).toBe(200);
    const payload = await body<{ report: MiningReport }>(response);
    expect(payload.report.activeSeconds).toBe(DAY);
    expect(payload.report.oreGained).toBe(480);
    const player = await readPlayer(h.env, wallet.address);
    expect(player.ore_balance).toBe(480);
  });

  it("earns no block rewards at or after active_until", async () => {
    const wallet = h.createWallet();
    await seedPlayer(h.env, wallet.address, { created_at: START - 30 * DAY, miners_level: 1 });
    // A real activation arms the position for exactly 24h.
    expect((await activate(h, wallet, MINT_A)).response.status).toBe(200);
    at(30 * 3_600);
    const headers = await h.sessionFor(wallet.address);
    const response = await collectMiningReport(jsonRequest("/api/mine/report/collect", {}, headers), h.env);
    expect(response.status).toBe(200);

    const position = await readPosition(h.env, wallet.address, MINT_A);
    // Blocks land every 300s: 287 of them fall strictly inside the 24h window (the block at
    // exactly active_until does not count), each worth the full 1000-token block reward.
    expect(position?.pending_reward).toBe("0");
    expect(position?.assigned_power).toBe("0");
    expect(position?.paused).toBe(1);
    const claims = await readClaims(h.env, wallet.address);
    expect(claims).toHaveLength(1);
    expect(claims[0].amount).toBe(String(287 * 1_000));
    const mine = await readMineState(h.env, MINT_A);
    expect(mine.totalEligiblePower).toBe(0n);
  });
});

describe("switch mine with unsettled rewards (spec 30)", () => {
  let h: Harness;

  beforeEach(async () => {
    vi.useFakeTimers();
    at(0);
    h = await createHarness();
    await seedToken(h.env, { mint: MINT_A });
    await seedToken(h.env, { mint: MINT_B });
  });

  afterEach(() => {
    h.close();
    vi.useRealTimers();
  });

  it("settles the old position, keeps activation and streak, and arms the new mine", async () => {
    const wallet = h.createWallet();
    await seedPlayer(h.env, wallet.address, { created_at: START - 30 * DAY, miners_level: 1 });
    await activate(h, wallet, MINT_A);
    at(600);

    const headers = await h.sessionFor(wallet.address);
    const response = await switchMine(jsonRequest("/api/mine/switch", { mint: MINT_B }, headers), h.env);
    expect(response.status).toBe(200);
    const payload = await body<{ player: PlayerProfile; settlements: PositionSettlement[] }>(response);
    expect(payload.settlements).toHaveLength(1);
    expect(payload.settlements[0].settled).toBe(2_000);
    expect(payload.settlements[0].released).toBe(true);
    expect(payload.settlements[0].claimId).not.toBeNull();

    const player = await readPlayer(h.env, wallet.address);
    expect(player.active_mint).toBe(MINT_B);
    // Activation and streak are untouched by a switch.
    expect(player.activation_expires_at).toBe(START + DAY);
    expect(player.last_activation_at).toBe(START);
    expect(player.streak).toBe(1);

    const oldPosition = await readPosition(h.env, wallet.address, MINT_A);
    expect(oldPosition?.assigned_power).toBe("0");
    expect(oldPosition?.pending_reward).toBe("0");
    const oldMine = await readMineState(h.env, MINT_A);
    expect(oldMine.totalEligiblePower).toBe(0n);

    const claims = await readClaims(h.env, wallet.address);
    expect(claims).toHaveLength(1);
    expect(claims[0].amount).toBe("2000");
    expect(claims[0].status).toBe("ELIGIBLE");

    const newPosition = await readPosition(h.env, wallet.address, MINT_B);
    expect(newPosition?.assigned_power).toBe(String(MIN_POWER));
    expect(newPosition?.active_until).toBe(START + DAY);
    const newMine = await readMineState(h.env, MINT_B);
    expect(newMine.totalEligiblePower).toBe(BigInt(MIN_POWER));

    // The settled reward is claimable exactly once.
    const claim = await claimOnce(h, wallet, claims[0].id, headers);
    expect(claim.status).toBe(200);
    expect((await body<ClaimBody>(claim)).claimed).toBe(true);
  });

  it("refuses to switch into a fully mined mine", async () => {
    const wallet = h.createWallet();
    await seedPlayer(h.env, wallet.address, { created_at: START - 30 * DAY, miners_level: 1 });
    await activate(h, wallet, MINT_A);
    const headers = await h.sessionFor(wallet.address);
    const response = await switchMine(
      jsonRequest("/api/mine/switch", { mint: MINT_C }, headers),
      h.env,
    );
    expect(response.status).toBe(404);
  });
});

describe("reward claims (spec 53, 57)", () => {
  let h: Harness;

  beforeEach(async () => {
    vi.useFakeTimers();
    at(0);
    h = await createHarness();
    await seedToken(h.env, { mint: MINT_A });
  });

  afterEach(() => {
    h.close();
    vi.useRealTimers();
  });

  async function seedClaimWallet(eligibleUntil = START + DAY): Promise<{
    wallet: TestWallet;
    headers: Record<string, string>;
  }> {
    const wallet = h.createWallet();
    await seedPlayer(h.env, wallet.address, { created_at: START - 30 * DAY, miners_level: 1 });
    await seedClaim(h.env, {
      id: "claim:test:1",
      wallet: wallet.address,
      mint: MINT_A,
      amount: "2000",
      eligibleUntil,
    });
    return { wallet, headers: await h.sessionFor(wallet.address) };
  }

  it("claims once, then reports the duplicate as already claimed", async () => {
    const { wallet, headers } = await seedClaimWallet();
    const first = await claimOnce(h, wallet, "claim:test:1", headers);
    expect(first.status).toBe(200);
    const firstBody = await body<ClaimBody>(first);
    expect(firstBody.claimed).toBe(true);
    expect(firstBody.claim?.status).toBe("CLAIMED");

    const second = await claimOnce(h, wallet, "claim:test:1", headers);
    expect(second.status).toBe(200);
    const secondBody = await body<ClaimBody>(second);
    expect(secondBody.claimed).toBe(false);
    expect(secondBody.alreadyClaimed).toBe(true);

    const claims = await readClaims(h.env, wallet.address);
    expect(claims).toHaveLength(1);
    expect(claims[0].status).toBe("CLAIMED");
    expect(claims[0].claimed_at).toBe(START);
  });

  it("lets exactly one of two concurrent claims win", async () => {
    const { wallet, headers } = await seedClaimWallet();
    const [left, right] = await Promise.all([
      claimOnce(h, wallet, "claim:test:1", headers),
      claimOnce(h, wallet, "claim:test:1", headers),
    ]);
    const bodies = [await body<ClaimBody>(left), await body<ClaimBody>(right)];
    expect(bodies.filter((entry) => entry.claimed === true)).toHaveLength(1);
    expect(bodies.filter((entry) => entry.alreadyClaimed === true)).toHaveLength(1);
    const claims = await readClaims(h.env, wallet.address);
    expect(claims[0].status).toBe("CLAIMED");
  });

  it("refuses a replayed claim nonce", async () => {
    const { wallet, headers } = await seedClaimWallet();
    const challenge = await body<{ nonce: string; message: string }>(
      await claimRewardChallenge(
        jsonRequest("/api/rewards/claim/challenge", { wallet: wallet.address, rewardId: "claim:test:1" }),
        h.env,
      ),
    );
    const request = {
      rewardId: "claim:test:1",
      nonce: challenge.nonce,
      signature: h.sign(wallet, challenge.message),
    };
    expect((await claimReward(jsonRequest("/api/rewards/claim", request, headers), h.env)).status).toBe(200);
    expect((await claimReward(jsonRequest("/api/rewards/claim", request, headers), h.env)).status).toBe(401);
  });

  it("refuses a claim once its eligibility window has passed", async () => {
    const { wallet, headers } = await seedClaimWallet(START + 60);
    const challenge = await body<{ nonce: string; message: string }>(
      await claimRewardChallenge(
        jsonRequest("/api/rewards/claim/challenge", { wallet: wallet.address, rewardId: "claim:test:1" }),
        h.env,
      ),
    );
    const request = {
      rewardId: "claim:test:1",
      nonce: challenge.nonce,
      signature: h.sign(wallet, challenge.message),
    };
    at(120);
    const response = await claimReward(jsonRequest("/api/rewards/claim", request, headers), h.env);
    expect(response.status).toBe(410);
    const claims = await readClaims(h.env, wallet.address);
    expect(claims[0].status).toBe("EXPIRED");
  });

  it("binds the signed challenge to the reward id", async () => {
    const { wallet, headers } = await seedClaimWallet();
    await seedClaim(h.env, {
      id: "claim:test:2",
      wallet: wallet.address,
      mint: MINT_A,
      amount: "500",
      eligibleUntil: START + DAY,
      settlementSeq: 2,
    });
    const challenge = await body<{ nonce: string; message: string }>(
      await claimRewardChallenge(
        jsonRequest("/api/rewards/claim/challenge", { wallet: wallet.address, rewardId: "claim:test:2" }),
        h.env,
      ),
    );
    const response = await claimReward(
      jsonRequest(
        "/api/rewards/claim",
        {
          rewardId: "claim:test:1",
          nonce: challenge.nonce,
          signature: h.sign(wallet, challenge.message),
        },
        headers,
      ),
      h.env,
    );
    expect(response.status).toBe(401);
  });

  it("holds a reward while the account is under review and releases it afterwards", async () => {
    const { wallet, headers } = await seedClaimWallet();
    await seedRestriction(h.env, wallet.address, "CLAIM_HOLD");
    const held = await claimOnce(h, wallet, "claim:test:1", headers);
    expect(held.status).toBe(403);
    let claims = await readClaims(h.env, wallet.address);
    expect(claims[0].status).toBe("HELD");

    await clearRestriction(h.env, wallet.address, "CLAIM_HOLD");
    const released = await claimOnce(h, wallet, "claim:test:1", headers);
    expect(released.status).toBe(200);
    expect((await body<ClaimBody>(released)).claimed).toBe(true);
    claims = await readClaims(h.env, wallet.address);
    expect(claims[0].status).toBe("CLAIMED");
  });

  it("answers 403 VERIFICATION_REQUIRED when the gate wants a challenge", async () => {
    const { wallet, headers } = await seedClaimWallet();
    await seedRestriction(h.env, wallet.address, "CHALLENGE_REQUIRED");
    const challenge = await body<{ nonce: string; message: string }>(
      await claimRewardChallenge(
        jsonRequest("/api/rewards/claim/challenge", { wallet: wallet.address, rewardId: "claim:test:1" }),
        h.env,
      ),
    );
    const response = await claimReward(
      jsonRequest(
        "/api/rewards/claim",
        {
          rewardId: "claim:test:1",
          nonce: challenge.nonce,
          signature: h.sign(wallet, challenge.message),
        },
        headers,
      ),
      h.env,
    );
    expect(response.status).toBe(403);
    expect((await body<{ code: string }>(response)).code).toBe("VERIFICATION_REQUIRED");
  });

  it("halts claims while the claims breaker is open", async () => {
    const { wallet, headers } = await seedClaimWallet();
    await openBreaker(h.env, "claims");
    const response = await claimOnce(h, wallet, "claim:test:1", headers);
    expect(response.status).toBe(503);
    const claims = await readClaims(h.env, wallet.address);
    expect(claims[0].status).toBe("ELIGIBLE");
  });

  it("requires a session wallet that owns the claim", async () => {
    const { wallet } = await seedClaimWallet();
    const anonymous = await claimOnce(h, wallet, "claim:test:1", {});
    expect(anonymous.status).toBe(401);
  });
});

describe("mining report and mine information", () => {
  let h: Harness;

  beforeEach(async () => {
    vi.useFakeTimers();
    at(0);
    h = await createHarness();
    await seedToken(h.env, { mint: MINT_A });
  });

  afterEach(() => {
    h.close();
    vi.useRealTimers();
  });

  it("collects the same report twice without crediting ORE twice", async () => {
    const wallet = h.createWallet();
    await seedPlayer(h.env, wallet.address, { created_at: START - 30 * DAY, miners_level: 1 });
    await activate(h, wallet, MINT_A);
    at(600);
    const headers = await h.sessionFor(wallet.address);

    const first = await body<{ report: MiningReport; idempotent: boolean }>(
      await collectMiningReport(jsonRequest("/api/mine/report/collect", {}, headers), h.env),
    );
    expect(first.idempotent).toBe(false);
    expect(first.report.activeSeconds).toBe(600);
    expect(first.report.oreGained).toBe(3);
    expect(first.report.blockRewards?.[0]?.amount).toBe(2_000);
    expect(first.report.blockRewards?.[0]?.claimId).not.toBeNull();
    expect(first.report.discoveries?.total).toBe(0);

    const second = await body<{ report: MiningReport; idempotent: boolean }>(
      await collectMiningReport(jsonRequest("/api/mine/report/collect", {}, headers), h.env),
    );
    expect(second.idempotent).toBe(true);
    expect(second.report).toEqual(first.report);

    const player = await readPlayer(h.env, wallet.address);
    expect(player.ore_balance).toBe(53);
    expect(player.last_report_at).toBe(START + 600);
  });

  it("describes a mine with an estimate label and no ROI promise (spec 33)", async () => {
    const first = h.createWallet();
    const second = h.createWallet();
    await seedPlayer(h.env, first.address, { created_at: START - 30 * DAY, miners_level: 1 });
    await seedPlayer(h.env, second.address, { created_at: START - 30 * DAY, miners_level: 1 });
    await activate(h, first, MINT_A);
    await activate(h, second, MINT_A);

    const headers = await h.sessionFor(first.address);
    const response = await mineInfo(getRequest("/api/mines/" + MINT_A + "/info", headers), h.env, MINT_A);
    expect(response.status).toBe(200);
    const mine = (await body<{ mine: MineInfo }>(response)).mine;
    expect(mine.blockReward).toBe(1_000);
    expect(mine.totalMiningPower).toBe(200);
    expect(mine.playerPower).toBe(100);
    expect(mine.estimatedShare).toBe(0.5);
    expect(mine.estimatedRewardPerBlock).toBe(500);
    expect(mine.estimateLabel).toBe("Estimate based on current conditions.");
    expect(mine.reductionSchedule[0]).toBe(1_000);
    expect(mine.reductionSchedule[1]).toBe(750);
    expect(mine.remainingReserve).toBe(1_000_000);
    expect(mine.fullyMinedProgress).toBe(0);
    expect(mine.accounting.source).toBe("OFFCHAIN");
    expect(mine.accounting.authoritative).toBe(true);

    const anonymous = await body<{ mine: MineInfo }>(
      await mineInfo(getRequest("/api/mines/" + MINT_A + "/info"), h.env, MINT_A),
    );
    expect(anonymous.mine.estimatedShare).toBeNull();
    expect(anonymous.mine.playerPower).toBeNull();
  });

  it("ends mining at FULLY_MINED, caps the last block and blocks new crew", async () => {
    await seedToken(h.env, { mint: MINT_C, reserveRemaining: 1_500, reserveTotal: 1_000_000 });
    const wallet = h.createWallet();
    await seedPlayer(h.env, wallet.address, { created_at: START - 30 * DAY, miners_level: 1 });
    await activate(h, wallet, MINT_C);
    at(600);
    const headers = await h.sessionFor(wallet.address);
    await collectMiningReport(jsonRequest("/api/mine/report/collect", {}, headers), h.env);

    const mine = await readMineState(h.env, MINT_C);
    expect(mine.status).toBe("FULLY_MINED");
    expect(mine.remainingReserve).toBe(0n);
    expect(await readTokenStatus(h.env, MINT_C)).toBe("FULLY_MINED");
    const claims = await readClaims(h.env, wallet.address);
    expect(claims[0].amount).toBe("1500");

    const newcomer = h.createWallet();
    await seedPlayer(h.env, newcomer.address, { created_at: START - 30 * DAY, miners_level: 1 });
    const attempt = await activate(h, newcomer, MINT_C);
    expect(attempt.response.status).toBe(409);
  });

  it("settles before a crew upgrade changes power", async () => {
    const wallet = h.createWallet();
    await seedPlayer(h.env, wallet.address, {
      created_at: START - 30 * DAY,
      miners_level: 1,
      ore_balance: 1_000,
    });
    await activate(h, wallet, MINT_A);
    at(300);
    const headers = await h.sessionFor(wallet.address);
    const response = await crewUpgrade(jsonRequest("/api/crew/upgrade", { component: "miners" }, headers), h.env);
    expect(response.status).toBe(200);

    const claims = await readClaims(h.env, wallet.address);
    expect(claims).toHaveLength(1);
    expect(claims[0].amount).toBe("1000");

    const position = await readPosition(h.env, wallet.address, MINT_A);
    expect(position?.assigned_power).toBe("153");
    const mine = await readMineState(h.env, MINT_A);
    expect(mine.totalEligiblePower).toBe(153n);
    const player = await readPlayer(h.env, wallet.address);
    expect(player.miners_level).toBe(2);
    // Cost of miners level 1 -> 2 with no Foreman discount is 120 ORE.
    expect(player.ore_balance).toBe(880);
  });

  it("keeps a claim recoverable after an expiry check on a HELD row", async () => {
    const wallet = h.createWallet();
    await seedPlayer(h.env, wallet.address, { created_at: START - 30 * DAY, miners_level: 1 });
    await seedClaim(h.env, {
      id: "claim:test:9",
      wallet: wallet.address,
      mint: MINT_A,
      amount: "10",
      eligibleUntil: START + DAY,
      status: "HELD",
    });
    const headers = await h.sessionFor(wallet.address);
    await patchClaim(h.env, "claim:test:9", { eligible_until: START + DAY });
    const response = await claimOnce(h, wallet, "claim:test:9", headers);
    expect(response.status).toBe(200);
    expect((await body<ClaimBody>(response)).claimed).toBe(true);
  });
});

describe("achievement counters mining owns (spec 68)", () => {
  let h: Harness;

  beforeEach(async () => {
    vi.useFakeTimers();
    at(0);
    h = await createHarness();
    await seedToken(h.env, { mint: MINT_A });
    await seedToken(h.env, { mint: MINT_B });
  });

  afterEach(() => {
    h.close();
    vi.useRealTimers();
  });

  it("counts the blocks a crew was credited with when its window closes", async () => {
    const wallet = h.createWallet();
    await seedPlayer(h.env, wallet.address, { created_at: START - 30 * DAY, miners_level: 1 });
    expect((await activate(h, wallet, MINT_A)).response.status).toBe(200);
    // Nothing has been mined yet, so the counter does not exist at all.
    expect(await readSocialMetrics(h.env, wallet.address)).toEqual({
      blocks_won: 0,
      mine_switches: 0,
      fully_mined_witnessed: 0,
    });

    at(30 * 3_600);
    const headers = await h.sessionFor(wallet.address);
    const response = await collectMiningReport(jsonRequest("/api/mine/report/collect", {}, headers), h.env);
    expect(response.status).toBe(200);

    // Exactly the 287 blocks that credited the claim: the block landing on active_until does not
    // count (spec 77), and the claim above was paid for those same blocks.
    expect((await readSocialMetrics(h.env, wallet.address)).blocks_won).toBe(287);
    const claims = await readClaims(h.env, wallet.address);
    expect(claims[0].amount).toBe(String(287 * 1_000));
  });

  it("counts a committed mine switch and never a refused one", async () => {
    const wallet = h.createWallet();
    await seedPlayer(h.env, wallet.address, { created_at: START - 30 * DAY, miners_level: 1 });
    await activate(h, wallet, MINT_A);
    const headers = await h.sessionFor(wallet.address);

    // Switching to the mine the crew is already on is refused, so it must not be counted.
    const refused = await switchMine(jsonRequest("/api/mine/switch", { mint: MINT_A }, headers), h.env);
    expect(refused.status).toBe(409);
    expect((await readSocialMetrics(h.env, wallet.address)).mine_switches).toBe(0);

    at(600);
    const switched = await switchMine(jsonRequest("/api/mine/switch", { mint: MINT_B }, headers), h.env);
    expect(switched.status).toBe(200);
    const metrics = await readSocialMetrics(h.env, wallet.address);
    expect(metrics.mine_switches).toBe(1);
    // The two blocks the old position earned before the switch are counted for it.
    expect(metrics.blocks_won).toBe(2);
  });
});

describe("reward claim payout job (spec 57, 65)", () => {
  let h: Harness;

  beforeEach(async () => {
    vi.useFakeTimers();
    at(0);
    h = await createHarness();
    await seedToken(h.env, { mint: MINT_A });
  });

  afterEach(() => {
    h.close();
    vi.useRealTimers();
  });

  it("exposes a settled claim as ready for the user-signed payout and never pays it itself", async () => {
    const wallet = h.createWallet();
    await seedPlayer(h.env, wallet.address, { created_at: START - 30 * DAY, miners_level: 1 });
    await seedClaim(h.env, {
      id: "claim:job:1",
      wallet: wallet.address,
      mint: MINT_A,
      amount: "5000",
      eligibleUntil: START + DAY,
      status: "CLAIMED",
    });

    const settlement = await settleRewardClaim(h.env, {
      claimId: "claim:job:1",
      wallet: wallet.address,
      mint: MINT_A,
    });
    expect(settlement.outcome).toBe("ready");
    expect(settlement.payout).toMatchObject({
      route: "USER_SIGNED",
      instruction: "claim_rewards",
      ready: true,
      txSignature: null,
    });
    // The accounting is untouched: no backend key may move the Mining Reserve.
    const claims = await readClaims(h.env, wallet.address);
    expect(claims[0].status).toBe("CLAIMED");
    expect(claims[0].tx_signature).toBeNull();
    expect(settlement.outstanding).toBe(1);
  });

  it("refuses a job that names another wallet's claim", async () => {
    const wallet = h.createWallet();
    const other = h.createWallet();
    await seedPlayer(h.env, wallet.address, { created_at: START - 30 * DAY, miners_level: 1 });
    await seedClaim(h.env, {
      id: "claim:job:2",
      wallet: wallet.address,
      mint: MINT_A,
      amount: "5000",
      eligibleUntil: START + DAY,
      status: "CLAIMED",
    });

    const mismatch = await settleRewardClaim(h.env, {
      claimId: "claim:job:2",
      wallet: other.address,
      mint: MINT_A,
    });
    expect(mismatch).toMatchObject({ outcome: "ignored", reason: "event_mismatch" });
    expect((await readClaims(h.env, wallet.address))[0].tx_signature).toBeNull();
  });

  it("never turns an unsettled claim into a payout", async () => {
    const wallet = h.createWallet();
    await seedPlayer(h.env, wallet.address, { created_at: START - 30 * DAY, miners_level: 1 });
    await seedClaim(h.env, {
      id: "claim:job:3",
      wallet: wallet.address,
      mint: MINT_A,
      amount: "5000",
      eligibleUntil: START + DAY,
      status: "ELIGIBLE",
    });

    const settlement = await settleRewardClaim(h.env, {
      claimId: "claim:job:3",
      wallet: wallet.address,
      mint: MINT_A,
    });
    expect(settlement).toMatchObject({ outcome: "ignored", reason: "status_eligible" });
    expect((await readClaims(h.env, wallet.address))[0].tx_signature).toBeNull();
  });

  it("does not record an unverified payout signature", async () => {
    const wallet = h.createWallet();
    await seedPlayer(h.env, wallet.address, { created_at: START - 30 * DAY, miners_level: 1 });
    await seedClaim(h.env, {
      id: "claim:job:4",
      wallet: wallet.address,
      mint: MINT_A,
      amount: "5000",
      eligibleUntil: START + DAY,
      status: "CLAIMED",
    });

    // The harness has no program id, so the payout cannot be verified against chain and the
    // reward must stay unclaimed rather than being marked paid on a client's word.
    const settlement = await settleRewardClaim(h.env, {
      claimId: "claim:job:4",
      wallet: wallet.address,
      mint: MINT_A,
      txSignature: "5verVeTeR3DfakeSignatureForTests111111111111111",
    });
    expect(settlement).toMatchObject({ outcome: "ignored", reason: "unverified_signature" });
    expect((await readClaims(h.env, wallet.address))[0].tx_signature).toBeNull();
  });

  it("ignores a job for a claim that does not exist", async () => {
    const wallet = h.createWallet();
    const settlement = await settleRewardClaim(h.env, {
      claimId: "claim:job:missing",
      wallet: wallet.address,
      mint: MINT_A,
    });
    expect(settlement).toMatchObject({ outcome: "ignored", reason: "unknown_claim" });
  });
});
