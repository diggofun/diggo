import { describe, expect, it } from "vitest";
import { MINING_RESERVE, TOKEN_SCALE } from "./contracts";
import { accrueMining, discoveryId, isPortfolioEligible, releasedMiningAllocation } from "./rules";
import { MemoryGameStore, mineConservation, starterCrew } from "./store";

const MINT = "So11111111111111111111111111111111111111112";
const WALLET = "11111111111111111111111111111111";

function coin(startsAt: number, graduated = false) {
  return { mint: MINT, symbol: "D", name: "Diggo", createdAt: startsAt, miningStartsAt: startsAt, graduated };
}

describe("off-chain game rules", () => {
  it("releases the 200M reserve lazily and never beyond the cap", () => {
    const start = 1_000_000;
    const half = start + 3_650 * 86_400 / 2;
    expect(releasedMiningAllocation(start, start)).toBe(0n);
    expect(releasedMiningAllocation(half, start)).toBe(MINING_RESERVE / 2n);
    expect(releasedMiningAllocation(start + 3_650 * 86_400 * 100, start)).toBe(MINING_RESERVE);
  });

  it("accrues proportionally with integer rounding", () => {
    const result = accrueMining({
      mine: coin(0), wallet: WALLET, now: 2, lastSettledAt: 1, assignedPower: 1, totalEligiblePower: 3,
      releasedBefore: 0n, releasedNow: 10n, claimableBefore: 2n, reserveRemainingBefore: MINING_RESERVE,
      committedBefore: 0n,
    });
    expect(result.claimable).toBe(5n);
    expect(result.committed).toBe(3n);
    expect(result.reserveRemaining).toBe(MINING_RESERVE - 3n);
  });

  it("keeps claims idempotent and pending until payout", async () => {
    const store = new MemoryGameStore();
    await store.ensurePlayer(WALLET, 0, starterCrew());
    const mine = await store.ensureMine(MINT, 0, 1, 1);
    await store.saveMine({ ...mine, released: 10n, committed: 10n, remaining: MINING_RESERVE - 10n }, 0);
    await store.saveBalance({ wallet: WALLET, mint: MINT, claimable: 10n, lastSettledAt: 2 }, 0n);
    const claim = { id: "claim-1", wallet: WALLET, mint: MINT, amount: 10n, kind: "MINING" as const, status: "PENDING" as const, signature: null, createdAt: 3 };
    expect(await store.createClaim(claim, 10n)).toMatchObject({ status: "PENDING" });
    expect(await store.createClaim(claim, 10n)).toMatchObject({ status: "PENDING" });
    expect((await store.getBalance(WALLET, MINT)).claimable).toBe(0n);
    expect(store.claims.size).toBe(1);
    expect(await store.markClaimPaid(claim.id, "sig")).toBe(true);
    expect((await store.getClaim(claim.id))?.status).toBe("PAID");
    expect((await store.getMine(MINT))?.paid).toBe(10n);
  });

  it("never lets outstanding balances plus paid exceed committed", async () => {
    const store = new MemoryGameStore();
    const mine = await store.ensureMine(MINT, 0, 1, 1);
    await store.saveMine({ ...mine, released: 100n, committed: 100n, remaining: MINING_RESERVE - 100n }, 0);
    const saved = (await store.getMine(MINT))!;
    expect(mineConservation(saved, 0n, 0n)).toBe(true);
    expect(saved.committed).toBeLessThanOrEqual(MINING_RESERVE);
  });

  it("applies referral caps and deterministic discovery seeds", async () => {
    const store = new MemoryGameStore();
    for (let i = 0; i < 25; i += 1) {
      expect(await store.applyReferralCredit({ id: `r${i}`, referrer: "ref", referee: `user${i}`, amount: 250, week: 1, createdAt: i })).toBe(true);
    }
    expect(await store.applyReferralCredit({ id: "r25", referrer: "ref", referee: "user25", amount: 250, week: 1, createdAt: 25 })).toBe(false);
    expect(await store.applyReferralCredit({ id: "r-over", referrer: "ref", referee: "user-over", amount: 251, week: 2, createdAt: 26 })).toBe(false);
    expect(discoveryId({ secret: "s", epoch: 1, wallet: WALLET })).toBe(discoveryId({ secret: "s", epoch: 1, wallet: WALLET }));
    expect(isPortfolioEligible(10)).toBe(true);
    expect(isPortfolioEligible(9.99)).toBe(false);
    expect(TOKEN_SCALE).toBe(1_000_000_000n);
  });
});
