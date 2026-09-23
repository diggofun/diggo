/**
 * Mining, streak, block-accounting and reward-claim tests (spec 82).
 *
 * These run against real SQLite (see ./test/mining-d1.ts): every migration is applied, so the
 * CHECK/UNIQUE constraints and the conditional-UPDATE semantics the Worker depends on are real.
 * Time is driven with vi.setSystemTime, which is the only clock the mining code reads.
 */
import bs58 from "bs58";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MineInfo, MiningReport, PlayerProfile } from "../shared/types";
import { crewUpgrade } from "./crew";
import { crewPower, upgradeOreCost } from "../shared/crew";
import { oreCapacity } from "../shared/ore";
import { DIGGO_CONFIG } from "../shared/config";
import { launchRunwayReward } from "../shared/rewardIndex";
import {
  activateChallenge,
  activateMine,
  advanceMineTo,
  armPosition,
  claimReward,
  claimRewardChallenge,
  collectMiningReport,
  mineInfo,
  reconcileArmedPosition,
  releaseArmedPositions,
  rowToMineState,
  settlePositionAt,
  settleRewardClaim,
  simulateAdvance,
  toRewardIndexState,
  MAX_EPOCHS_PER_ADVANCE,
  switchMine,
  type MineState,
  type ClaimTransactionReader,
  type PositionSettlement,
  type PositionRow,
  type RawClaimTransaction,
  type PositionSnapshot,
} from "./mining";
import { activationStateOf, crewLevelsOf } from "./player";
import { auditReserve, type MiningPosition } from "../shared/rewardIndex";
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

/**
 * Reads one telemetry counter through the real table (migration 0010) rather than a helper, so this
 * suite asserts the counter the cron and the dashboards read.
 */
async function metricValue(env: Harness["env"], name: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COALESCE(SUM(value), 0) AS total FROM metrics_counters WHERE name = ?1",
  )
    .bind(name)
    .first<{ total: number }>();
  return Number(row?.total ?? 0);
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
    released: 0n,
    forfeited: 0n,
    blockInterval: 300,
    epochLength: 604_800,
    epochEndsAt: 0,
    authority: "OFFCHAIN",
    // A mine whose budget is the Mining Reserve, which is what every mine was before curve
    // mining existed; tests that want the curve phase set emissionSource and curve themselves.
    emissionSource: "RESERVE",
    curve: { graduated: true, cap: 0n, mined: 0n, unpaid: 0n, blockReward: 0n },
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

  it("steps a bounded number of epochs per call and resumes where it stopped", () => {
    // One block whose arrival is far past the last epoch boundary. With a one-second epoch length
    // this single block has to cross 130 boundaries, so an unbounded inner walk would do all of that
    // work - and spread the whole schedule - inside one call. The per-call epoch budget splits it.
    const base = mineStateFixture({ epochLength: 1, epochEndsAt: 1_171 });
    const upTo = base.lastBlock + base.blockInterval;

    const first = simulateAdvance({ state: base, positions: [], upTo, maxBlocks: 1 });
    expect(first.blocksAdvanced).toBe(0);
    expect(first.state.epoch).toBe(MAX_EPOCHS_PER_ADVANCE);
    expect(first.state.epochEndsAt).toBe(base.epochEndsAt + MAX_EPOCHS_PER_ADVANCE);
    // The block stays uncredited, so the reserve is untouched until the walk catches up.
    expect(first.state.lastBlock).toBe(base.lastBlock);
    expect(first.state.remainingReserve).toBe(base.remainingReserve);

    // Resuming from what the first call persisted continues the walk instead of restarting it.
    const second = simulateAdvance({ state: first.state, positions: [], upTo, maxBlocks: 1 });
    expect(second.blocksAdvanced).toBe(0);
    expect(second.state.epoch).toBe(2 * MAX_EPOCHS_PER_ADVANCE);

    // Caught up at last: the next call credits the block it was waiting on.
    const third = simulateAdvance({ state: second.state, positions: [], upTo, maxBlocks: 1 });
    expect(third.blocksAdvanced).toBe(1);
    expect(third.state.lastBlock).toBe(upTo);
    expect(third.state.epoch).toBe(130);
  });

  it("never credits one instant repeatedly when the block interval cannot advance", () => {
    // A zero block interval would make every pass credit the same timestamp, bounded only by
    // maxBlocks - a schedule nobody described. It is refused instead of walked.
    const state = mineStateFixture({ blockInterval: 0, epochEndsAt: 0 });
    const outcome = simulateAdvance({
      state,
      positions: [positionFixture()],
      upTo: state.lastBlock + 10_000,
      maxBlocks: 8,
    });

    expect(outcome.blocksAdvanced).toBe(0);
    expect(outcome.state.lastBlock).toBe(state.lastBlock);
    expect(outcome.state.rewardIndex).toBe(state.rewardIndex);
    expect(outcome.state.remainingReserve).toBe(state.remainingReserve);
  });

  it("never walks an epoch of zero length, however long the gap", () => {
    // The case that used to be an unbounded synchronous loop: an epoch that never advances the
    // boundary. Refusing it is what keeps the walk finite.
    const state = mineStateFixture({ epochLength: 0, epochEndsAt: 1_001 });
    const outcome = simulateAdvance({ state, positions: [], upTo: state.lastBlock + 300, maxBlocks: 1 });

    expect(outcome.blocksAdvanced).toBe(0);
    expect(outcome.state.epoch).toBe(state.epoch);
    expect(outcome.state.epochEndsAt).toBe(state.epochEndsAt);
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
    expect(payload.report.activeSeconds).toBe(20 * 3_600);
    // 20h at the configured base rate, plus the activation bonus and the day-3 milestone.
    expect(payload.report.oreGained).toBe(
      20 * DIGGO_CONFIG.ore.baseOrePerActiveHour +
        DIGGO_CONFIG.ore.activationBonusOre +
        DIGGO_CONFIG.streak.milestones[0].ore,
    );
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
    // Leave 10 ORE of free starter storage, so the window overflows by design.
    const capacity = oreCapacity({ miners: 2, drills: 1, carts: 1, foreman: 1, storage: 1 });
    await seedPlayer(h.env, wallet.address, {
      created_at: START - 30 * DAY,
      miners_level: 1,
      streak: 2,
      ore_balance: capacity - 10,
      last_activation_at: START - 20 * 3_600,
      activation_expires_at: START + 4 * 3_600,
      ore_collected_at: START - 3_600,
    });
    const payload = await body<ActivationBody>((await activate(h, wallet, MINT_A)).response);
    expect(payload.report.oreGained).toBe(10);
    // Everything the window earned that the last 10 ORE of storage could not take is reported, not
    // dropped: 1h at the base rate, the activation bonus, and the day-3 milestone.
    const earnedOre =
      DIGGO_CONFIG.ore.baseOrePerActiveHour +
      DIGGO_CONFIG.ore.activationBonusOre +
      DIGGO_CONFIG.streak.milestones[0].ore;
    expect(payload.report.oreOverflow).toBe(earnedOre - 10);
    const player = await readPlayer(h.env, wallet.address);
    expect(player.ore_balance).toBe(capacity);
    expect(player.ore_overflow).toBe(earnedOre - 10);
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
    expect(payload.report.oreGained).toBe(24 * DIGGO_CONFIG.ore.baseOrePerActiveHour);
    const player = await readPlayer(h.env, wallet.address);
    expect(player.ore_balance).toBe(24 * DIGGO_CONFIG.ore.baseOrePerActiveHour);
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

  it("refuses a replayed claim nonce, in the authoritative nonce table", async () => {
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
    // The nonce is spent by a conditional UPDATE against challenge_nonces, so it is spent in every
    // colo rather than only in the KV cache the first request happened to land in (spec 47).
    const spent = await h.db
      .prepare("SELECT consumed_at FROM challenge_nonces WHERE nonce = ?1")
      .bind(challenge.nonce)
      .first<{ consumed_at: number | null }>();
    expect(spent?.consumed_at).not.toBeNull();
    expect((await claimReward(jsonRequest("/api/rewards/claim", request, headers), h.env)).status).toBe(409);
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

  it("does not let a hold outlive the claim's own eligibility window", async () => {
    const { wallet } = await seedClaimWallet();
    await seedRestriction(h.env, wallet.address, "CLAIM_HOLD");
    // The hold starts an hour into the claim's window...
    at(3_600);
    expect((await claimOnce(h, wallet, "claim:test:1", await h.sessionFor(wallet.address))).status).toBe(403);

    // ...and nobody lifts it for a day and a half, so the window would have lapsed while the hold -
    // not the player - was the reason the claim could not be made. The window stops running while
    // the claim is parked, so lifting the hold still leaves a claimable reward.
    at(36 * 3_600);
    await clearRestriction(h.env, wallet.address, "CLAIM_HOLD");
    const released = await claimOnce(h, wallet, "claim:test:1", await h.sessionFor(wallet.address));
    expect(released.status).toBe(200);
    expect((await body<ClaimBody>(released)).claimed).toBe(true);
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
    expect(first.report.oreGained).toBe(Math.floor(DIGGO_CONFIG.ore.baseOrePerActiveHour / 6));
    expect(first.report.blockRewards?.[0]?.amount).toBe(2_000);
    expect(first.report.blockRewards?.[0]?.claimId).not.toBeNull();
    expect(first.report.discoveries?.total).toBe(0);

    const second = await body<{ report: MiningReport; idempotent: boolean }>(
      await collectMiningReport(jsonRequest("/api/mine/report/collect", {}, headers), h.env),
    );
    expect(second.idempotent).toBe(true);
    expect(second.report).toEqual(first.report);

    const player = await readPlayer(h.env, wallet.address);
    // The activation bonus plus ten minutes at the base rate, credited exactly once.
    expect(player.ore_balance).toBe(
      DIGGO_CONFIG.ore.activationBonusOre + Math.floor(DIGGO_CONFIG.ore.baseOrePerActiveHour / 6),
    );
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
    // The mine is on the reserve-runway schedule (spec 21): the next epochs pay what is left of the
    // reserve spread over the blocks left of the target lifetime, never more than the launch reward.
    const firstScheduledReward = launchRunwayReward(1_000_000n, 604_800, 300);
    // Rounded up: an epoch has to be able to finish the reserve it is holding.
    expect(firstScheduledReward).toBe(10n);
    expect(mine.reductionSchedule[0]).toBe(Number(firstScheduledReward));
    for (let index = 1; index < mine.reductionSchedule.length; index += 1) {
      expect(mine.reductionSchedule[index]).toBeLessThanOrEqual(mine.reductionSchedule[index - 1]);
      expect(mine.reductionSchedule[index]).toBeLessThanOrEqual(mine.blockReward);
    }
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
    const beforeUpgrade = await readPlayer(h.env, wallet.address);
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
    // Cost of miners level 1 -> 2 with no Foreman discount, straight from the cost curve.
    expect(player.ore_balance).toBe(beforeUpgrade.ore_balance - upgradeOreCost("miners", 1));
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

  it("refuses to walk a mine whose stored schedule cannot advance, and counts it", async () => {
    const wallet = h.createWallet();
    await seedPlayer(h.env, wallet.address, { created_at: START - 30 * DAY, miners_level: 1 });
    await activate(h, wallet, MINT_A);
    // A row nobody's schedule should follow: no block interval to step by and no epoch length to
    // step epochs by. The fallback mapper substitutes nominal values for display, so this is the
    // path that has to notice and refuse.
    await h.db
      .prepare("UPDATE mine_reward_state SET block_interval = 0, epoch_length = 0 WHERE mint = ?1")
      .bind(MINT_A)
      .run();
    const before = await readMineState(h.env, MINT_A);

    at(3_600);
    const headers = await h.sessionFor(wallet.address);
    await collectMiningReport(jsonRequest("/api/mine/report/collect", {}, headers), h.env);

    const after = await readMineState(h.env, MINT_A);
    // Fail closed: nothing credited, no reserve moved, no schedule invented.
    expect(after.lastBlock).toBe(before.lastBlock);
    expect(after.rewardIndex).toBe(before.rewardIndex);
    expect(after.remainingReserve).toBe(before.remainingReserve);
    expect(after.epoch).toBe(before.epoch);
    expect(await metricValue(h.env, "mining.advance_schedule_invalid")).toBeGreaterThan(0);
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

  it("never records a payout from a wallet-signed transaction that is not this claim's", async () => {
    const wallet = h.createWallet();
    await seedPlayer(h.env, wallet.address, { created_at: START - 30 * DAY, miners_level: 1 });
    await seedClaim(h.env, {
      id: "claim:job:5",
      wallet: wallet.address,
      mint: MINT_A,
      amount: "5000",
      eligibleUntil: START + DAY,
      status: "CLAIMED",
    });
    const programId = bs58.encode(new Uint8Array(32).fill(9));
    (h.env as unknown as { DIGGO_PROGRAM_ID?: string }).DIGGO_PROGRAM_ID = programId;

    // A confirmed transaction this wallet signed that touched the Diggo program but carries no
    // claim_rewards instruction for this reward. "Some wallet-signed program call" is not proof of a
    // payout, so the queue path refuses it exactly like the confirm endpoint would.
    const forged: RawClaimTransaction = {
      blockTime: START + 120,
      meta: {
        err: null,
        preTokenBalances: [],
        postTokenBalances: [],
        innerInstructions: [],
      },
      transaction: {
        message: {
          accountKeys: [
            { pubkey: wallet.address, signer: true },
            { pubkey: programId, signer: false },
          ],
          instructions: [
            {
              programId,
              accounts: [],
              data: bs58.encode(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])),
            },
          ],
        },
      },
    };
    const reader: ClaimTransactionReader = {
      async getTransaction(): Promise<RawClaimTransaction | null> {
        return forged;
      },
    };

    const settlement = await settleRewardClaim(
      h.env,
      {
        claimId: "claim:job:5",
        wallet: wallet.address,
        mint: MINT_A,
        txSignature: bs58.encode(new Uint8Array(64).fill(3)),
      },
      reader,
    );

    expect(settlement).toMatchObject({ outcome: "ignored", reason: "unverified_signature" });
    expect((await readClaims(h.env, wallet.address))[0].tx_signature).toBeNull();
  });
});

/**
 * A damped account's collect (spec 30, 53, 58, 78).
 *
 * What a position stores is the power it brings to a block *after* the maturity ramp, the cluster
 * damping and the share cap; the crew's nominal power is a different number. The reconcile guard
 * compared the two, so it read every damped position as "not armed for this window", re-armed it on
 * the collect path, and reset the index cursor that stood for the accrual it had not settled yet.
 */
describe("a damped position keeps its accrual (spec 30, 78)", () => {
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

  it("credits a young sole miner's whole accrual on collect", async () => {
    const wallet = h.createWallet();
    // Two days old, so the maturity ramp arms it with 40% of its 100 raw power. 40 !== 100 is
    // exactly the mismatch the guard used to fire on.
    await seedPlayer(h.env, wallet.address, { created_at: START - 2 * DAY, miners_level: 1 });
    expect((await activate(h, wallet, MINT_A)).response.status).toBe(200);
    expect((await readPosition(h.env, wallet.address, MINT_A))?.assigned_power).toBe("40");

    // Five hours on a 300s block grid is 60 blocks, and the mine has one miner, so each block is
    // worth the whole 1000-token block reward.
    at(5 * 3_600);
    const headers = await h.sessionFor(wallet.address);
    const response = await collectMiningReport(jsonRequest("/api/mine/report/collect", {}, headers), h.env);
    expect(response.status).toBe(200);

    const claims = await readClaims(h.env, wallet.address);
    // Every one of the 60 blocks is credited, and the collect re-armed nothing to get there.
    expect(claims.reduce((total, claim) => total + Number(claim.amount), 0)).toBe(60 * 1_000);
    expect(claims).toHaveLength(1);
    expect(claims[0].amount).toBe(String(60 * 1_000));
  });

  it("keeps the mine's power total exact when two collects race an interrupted upgrade", async () => {
    const wallet = h.createWallet();
    await seedPlayer(h.env, wallet.address, { created_at: START - 2 * DAY, miners_level: 1 });
    await activate(h, wallet, MINT_A);
    expect((await readPosition(h.env, wallet.address, MINT_A))?.assigned_power).toBe("40");

    // An upgrade that reached the players row but never re-armed the position, which is what an
    // interrupted upgrade leaves behind. Two collects then race to heal it, and the reconcile path
    // used to remove the stored power from the mine outside any compare-and-swap, so both callers
    // could subtract it.
    await h.db.prepare("UPDATE players SET miners_level = 2 WHERE wallet = ?1").bind(wallet.address).run();
    at(600);
    const row = await readPlayer(h.env, wallet.address);
    const collect = async (): Promise<void> => {
      await reconcileArmedPosition(h.env, row, START + 600);
      await settlePositionAt(h.env, wallet.address, MINT_A, START + 600, { releasePower: false });
    };
    await Promise.all([collect(), collect()]);

    const position = await readPosition(h.env, wallet.address, MINT_A);
    const mine = await readMineState(h.env, MINT_A);
    // 153 raw power at a 40% maturity share, and the denominator the index divides by is exactly
    // what the mine's positions hold (spec 78).
    expect(position?.assigned_power).toBe("61");
    expect(mine.totalEligiblePower).toBe(61n);
  });

  it("leaves the position alone when only its effective power differs from raw", async () => {
    const wallet = h.createWallet();
    await seedPlayer(h.env, wallet.address, { created_at: START - 2 * DAY, miners_level: 1 });
    await activate(h, wallet, MINT_A);
    const armed = await readPosition(h.env, wallet.address, MINT_A);

    at(600);
    const row = await readPlayer(h.env, wallet.address);
    expect(await reconcileArmedPosition(h.env, row, START + 600)).toBe(false);

    // A reconcile that decides there is nothing to heal must not move the cursor it would have
    // reset: that cursor is the accrual the next settlement pays out.
    const after = await readPosition(h.env, wallet.address, MINT_A);
    expect(after?.last_reward_index).toBe(armed?.last_reward_index);
    expect(after?.activated_at).toBe(armed?.activated_at);
    expect(after?.assigned_power).toBe("40");
  });
});

/** Deterministic PRNG, so a failure names the seed that reproduces it. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * The accounting's own invariant, over random play (spec 17, 19, 78).
 *
 * Whatever sequence of activation, collection, mine switching, crew upgrades, claims and window
 * expiries a wallet plays, every token that left a mine's Mining Reserve is either sitting in a
 * claim, still owed to a position, forfeited back into the reserve, or rounding dust - and no mine
 * ever hands out more than its reserve.
 *
 * This drives the accounting functions the request handlers call rather than the handlers
 * themselves: the handlers layer per-wallet rate limits on top, which would turn a long random
 * sequence into refusals, and the invariant under test lives below them. The wallets span the whole
 * maturity ramp, and half of them sit inside a device cluster large enough to be damped.
 */
describe("reserve conservation under random play (spec 17, 19, 78)", () => {
  const MINES = [MINT_A, MINT_B, MINT_C];
  const SEEDS = 6;
  const STEPS = 30;
  /** One wallet per step of the maturity ramp, from minutes old to fully mature. */
  const AGES = [0, 12 * 3_600, 2 * DAY, 6 * DAY, 30 * DAY];

  interface RandomWallet {
    wallet: TestWallet;
    /** Shares a device hash with the cluster mates, so its power is damped (spec 61). */
    damped: boolean;
  }

  it("conserves every mine's reserve and never over-distributes", async () => {
    const h = await createHarness();
    vi.useFakeTimers();
    at(0);
    try {
      for (const mint of MINES) {
        await seedToken(h.env, {
          mint,
          reserveTotal: 5_000_000,
          reserveRemaining: 5_000_000,
          rewardPerBlock: 1_000,
        });
      }

      for (let seed = 0; seed < SEEDS; seed += 1) {
        const rng = mulberry32(seed * 7_919 + 13);
        const wallets: RandomWallet[] = [];
        for (let index = 0; index < AGES.length; index += 1) {
          const wallet = h.createWallet();
          await seedPlayer(h.env, wallet.address, { created_at: START - AGES[index], miners_level: 1 });
          wallets.push({ wallet, damped: index % 2 === 0 });
        }
        const deviceHash = "device-shared-" + seed;
        // Enough wallets on that one device hash to be past the configured allowance, so the
        // damped half really is armed with less than its raw power.
        const clusterMates = Array.from({ length: 8 }, (_, index) => "cluster-mate-" + seed + "-" + index);

        let now = START;
        const recordSignals = async (): Promise<void> => {
          for (const entry of wallets) {
            await h.db
              .prepare(
                "INSERT INTO account_signals (wallet, ts, action, device_hash, outcome) VALUES (?1, ?2, 'activate', ?3, 'ok')",
              )
              .bind(entry.wallet.address, now, entry.damped ? deviceHash : null)
              .run();
          }
          for (const mate of clusterMates) {
            await h.db
              .prepare(
                "INSERT INTO account_signals (wallet, ts, action, device_hash, outcome) VALUES (?1, ?2, 'activate', ?3, 'ok')",
              )
              .bind(mate, now, deviceHash)
              .run();
          }
        };

        const arm = async (entry: RandomWallet, mint: string, activatedAt: number, activeUntil: number): Promise<void> => {
          const levels = crewLevelsOf(await readPlayer(h.env, entry.wallet.address));
          await armPosition(h.env, entry.wallet.address, mint, BigInt(crewPower(levels)), activatedAt, activeUntil, now);
        };

        const activateOp = async (entry: RandomWallet): Promise<void> => {
          const mint = MINES[Math.floor(rng() * MINES.length)];
          await releaseArmedPositions(h.env, entry.wallet.address, now);
          await h.db
            .prepare(
              "UPDATE players SET active_mint = ?1, activated_at = ?2, last_activation_at = ?2, activation_expires_at = ?3 WHERE wallet = ?4",
            )
            .bind(mint, now, now + DAY, entry.wallet.address)
            .run();
          await arm(entry, mint, now, now + DAY);
        };

        const collectOp = async (entry: RandomWallet): Promise<void> => {
          const row = await readPlayer(h.env, entry.wallet.address);
          if (activationStateOf(row, now) !== "ACTIVE" || !row.active_mint) return;
          await reconcileArmedPosition(h.env, row, now);
          await settlePositionAt(h.env, entry.wallet.address, row.active_mint, now, { releasePower: false });
          // The player's own claim: marking a settled claim paid out moves no reserve tokens
          // off-chain (the payout is the player's own transaction), so the audit must not move.
          await h.db
            .prepare("UPDATE reward_claims SET status = 'CLAIMED', claimed_at = ?1 WHERE wallet = ?2 AND status = 'ELIGIBLE'")
            .bind(now, entry.wallet.address)
            .run();
        };

        const switchOp = async (entry: RandomWallet): Promise<void> => {
          const row = await readPlayer(h.env, entry.wallet.address);
          if (activationStateOf(row, now) !== "ACTIVE" || !row.active_mint) return;
          const target = MINES[Math.floor(rng() * MINES.length)];
          if (target === row.active_mint) return;
          await releaseArmedPositions(h.env, entry.wallet.address, now);
          await h.db.prepare("UPDATE players SET active_mint = ?1 WHERE wallet = ?2").bind(target, entry.wallet.address).run();
          await arm(entry, target, row.activated_at ?? now, row.activation_expires_at ?? now);
        };

        const upgradeOp = async (entry: RandomWallet): Promise<void> => {
          const row = await readPlayer(h.env, entry.wallet.address);
          if (row.miners_level >= 8) return;
          // An upgrade settles before the power moves, exactly like the crew handler does (spec 30).
          await releaseArmedPositions(h.env, entry.wallet.address, now);
          await h.db.prepare("UPDATE players SET miners_level = miners_level + 1 WHERE wallet = ?1").bind(entry.wallet.address).run();
          if (activationStateOf(row, now) === "ACTIVE" && row.active_mint) {
            await arm(entry, row.active_mint, row.activated_at ?? now, row.activation_expires_at ?? now);
          }
        };

        for (let step = 0; step < STEPS; step += 1) {
          now += 300 * (1 + Math.floor(rng() * 12));
          await recordSignals();
          const entry = wallets[Math.floor(rng() * wallets.length)];
          const roll = rng();
          if (roll < 0.22) await activateOp(entry);
          else if (roll < 0.5) await collectOp(entry);
          else if (roll < 0.68) await switchOp(entry);
          else if (roll < 0.84) await upgradeOp(entry);
          else for (const mint of MINES) await advanceMineTo(h.env, mint, now);

          // The denominator every block share is measured against is exactly the power the mine's
          // positions hold, at every step of the sequence (spec 78).
          for (const mint of MINES) {
            const state = await h.db
              .prepare("SELECT total_eligible_power FROM mine_reward_state WHERE mint = ?1")
              .bind(mint)
              .first<{ total_eligible_power: string }>();
            if (!state) continue; // a mine nobody has touched has no accounting row yet
            const held = await h.db
              .prepare("SELECT COALESCE(SUM(CAST(assigned_power AS INTEGER)), 0) AS total FROM mining_positions WHERE mint = ?1")
              .bind(mint)
              .first<{ total: number }>();
            expect(BigInt(state.total_eligible_power), "seed " + seed + " step " + step).toBe(
              BigInt(held?.total ?? 0),
            );
          }
        }

        // Close the books, so the audit sees a settled ledger, and check the two conservation
        // identities for every mine this sequence touched.
        for (const entry of wallets) await releaseArmedPositions(h.env, entry.wallet.address, now);
        for (const mint of MINES) await advanceMineTo(h.env, mint, now);

        for (const mint of MINES) {
          const state = await h.db
            .prepare("SELECT * FROM mine_reward_state WHERE mint = ?1")
            .bind(mint)
            .first<Parameters<typeof rowToMineState>[0]>();
          if (!state) continue; // a mine nobody has touched has no accounting row yet
          const mine = rowToMineState(state);
          const rows = await h.db.prepare("SELECT * FROM mining_positions WHERE mint = ?1").bind(mint).all<PositionRow>();
          const positions: MiningPosition[] = rows.results.map((row) => ({
            mineId: mint,
            assignedPower: BigInt(row.assigned_power),
            lastRewardIndex: BigInt(row.last_reward_index),
            pendingReward: BigInt(row.pending_reward),
            paused: row.paused === 1,
          }));
          const claimed = await h.db
            .prepare("SELECT COALESCE(SUM(CAST(amount AS INTEGER)), 0) AS total FROM reward_claims WHERE mint = ?1")
            .bind(mint)
            .first<{ total: number }>();
          const audit = auditReserve(toRewardIndexState(mine), mine.initialReserve, positions, BigInt(claimed?.total ?? 0));
          const where = "seed " + seed + " mint " + mint;
          expect(audit.unattributedScaled, where).toBe(0n);
          expect(audit.conserved, where).toBe(true);
          // Never over-distribute: what left the reserve is bounded by the reserve itself.
          expect(audit.drained, where).toBeLessThanOrEqual(mine.initialReserve);
        }
      }
    } finally {
      h.close();
      vi.useRealTimers();
    }
  });
});
