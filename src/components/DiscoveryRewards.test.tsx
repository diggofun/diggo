import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { DiscoveryRecord, TokenSummary } from "../../shared/types";
import type { GameState } from "../api";
import { DiscoveriesPanel } from "./DiscoveriesPanel";
import { MeteoraDiscoveriesScreen, discoveryRewardCounts } from "./MeteoraGameScreens";

function token(mint: string, symbol: string, onCurve: boolean): TokenSummary {
  return {
    mint,
    slug: symbol.toLowerCase(),
    name: symbol,
    symbol,
    description: "",
    creator: "",
    imageUrl: null,
    status: onCurve ? "MINING_ACTIVE" : "MINING_ACTIVE",
    priceSol: 0,
    priceUsd: 0,
    change24h: null,
    volume24hUsd: 0,
    trades24h: 0,
    curveMining: {
      open: onCurve,
      onCurve,
      cap: 1,
      mined: 0,
      remaining: 1,
      progress: 0,
      blockReward: 1,
      unpaid: 0,
    },
    sellCapacity: { sol: 0, tokens: 0 },
    marketCapUsd: 0,
    reserveRemaining: 0,
    reserveTotal: 0,
    rewardPerBlock: 0,
    networkPower: 0,
    nextBlockAt: 0,
    nextEpochAt: 0,
    createdAt: 0,
    decimals: 9,
  };
}

function game(overrides: Partial<GameState> = {}): GameState {
  return {
    wallet: "wallet",
    chainMode: "meteora",
    createdAt: 0,
    oreBalance: 0,
    oreEarned: 0,
    streak: 0,
    longestStreak: 0,
    streakFreezes: 0,
    activeUntil: 0,
    lastActivationAt: 0,
    activatedAt: 0,
    lastOreAt: 0,
    activeDays: 5,
    validActivations: 5,
    activeMine: null,
    activation: { active: false, activeUntil: 0 },
    discovery: { eligible: true, epoch: 1, portfolioUsd: 10 },
    crew: { miners: 1, drills: 1, carts: 1, foreman: 1, storage: 1 },
    claims: [],
    balances: [],
    claimAll: { supported: true, count: 0, signatures: 1, maxItems: 12 },
    ...overrides,
  };
}

function renderMeteora(state: GameState, tokens: TokenSummary[]): string {
  return renderToStaticMarkup(
    <MeteoraDiscoveriesScreen
      game={state}
      tokens={tokens}
      connected
      busy={false}
      error=""
      notice=""
      onDiscover={() => undefined}
      claimAllPending={false}
      claimAllError=""
      claimAllNotice=""
      onClaimAll={() => undefined}
    />,
  );
}

describe("Meteora discovery reward status", () => {
  it("separates available graduated rewards from pre-graduation rewards", () => {
    const graduated = token("graduated", "GRAD", false);
    const pending = token("pending", "PEND", true);
    const state = game({
      balances: [
        { mint: graduated.mint, name: "Graduated", symbol: "GRAD", amountWhole: 5 },
        { mint: pending.mint, name: "Pending", symbol: "PEND", amountWhole: 7 },
      ],
      claimAll: { supported: true, count: 1, signatures: 1, maxItems: 12 },
    });

    const markup = renderMeteora(state, [graduated, pending]);

    expect(markup).toContain("AVAILABLE GRADUATED REWARDS");
    expect(markup).toContain("PENDING UNTIL GRADUATION");
    expect(markup).toContain("Available to claim from a graduated coin");
    expect(markup).toContain("Accrued from a pre-graduation coin · not claimable yet");
    expect(markup).toContain("Mining does not guarantee that a coin will graduate");
    expect(markup.match(/Claim all/g)).toHaveLength(1);
  });

  it("fails closed when a reward coin's graduation state is unknown", () => {
    const state = game({
      balances: [{ mint: "unknown", name: "Unknown", symbol: "UNK", amountWhole: 3 }],
      claimAll: { supported: true, count: 0, signatures: 1, maxItems: 12 },
    });

    const markup = renderMeteora(state, []);

    expect(markup).toContain("No rewards from graduated coins are available to claim yet.");
    expect(markup).toContain("Accrued from a pre-graduation coin · not claimable yet");
    expect(markup).not.toContain("Claim all");
  });

  it("adapts to explicit backend available and pending counts when present", () => {
    expect(discoveryRewardCounts({
      supported: true,
      count: 99,
      availableCount: 3,
      pendingCount: 4,
      signatures: 1,
      maxItems: 12,
    }, 0, 1)).toEqual({ available: 3, pending: 4 });

    expect(discoveryRewardCounts({ supported: true, count: 2, signatures: 1, maxItems: 12 }, 2, 1))
      .toEqual({ available: 2, pending: 1 });
    expect(discoveryRewardCounts({ supported: true, count: 2, signatures: 1, maxItems: 12 }, 0, 1))
      .toEqual({ available: 0, pending: 1 });
  });
});

describe("native discovery reward status", () => {
  it("marks transitional pre-graduation records as pending, not claimable", () => {
    const pendingToken = token("pending", "PEND", true);
    const baseDiscovery: Omit<DiscoveryRecord, "id" | "status" | "claimable"> = {
      eventId: "event-1",
      window: "window",
      mint: pendingToken.mint,
      symbol: pendingToken.symbol,
      rarity: "COMMON",
      visualEvent: "Stone",
      tokenAmount: 12,
      valueUsd: 1,
      priceUsd: 0.1,
      eligibilityScore: 1,
      claimedAt: null,
      txSignature: null,
      createdAt: 0,
    };
    const discoveries: DiscoveryRecord[] = [
      { ...baseDiscovery, id: "pending", status: "PENDING", claimable: false },
      { ...baseDiscovery, id: "eligible", status: "ELIGIBLE", claimable: true },
    ];

    const markup = renderToStaticMarkup(
      <DiscoveriesPanel
        signedIn
        discoveries={discoveries}
        opportunity={null}
        tokens={[pendingToken]}
        loading={false}
        rolling={false}
        error=""
        notice=""
        onRequestOpportunity={() => undefined}
        onRoll={() => undefined}
        onOpenToken={() => undefined}
        onTrade={() => undefined}
      />,
    );

    expect(markup).toContain("Pending until this coin graduates · not claimable yet");
    expect(markup.match(/Pending until this coin graduates · not claimable yet/g)).toHaveLength(2);
    expect(markup).not.toContain(">ELIGIBLE<");
  });
});
