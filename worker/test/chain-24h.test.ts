/**
 * The 24h metrics worker/chain.ts reports, and the status it gives a mine that is still on its
 * curve.
 *
 * Both are the same rule seen twice: never invent a number. A 24h change is measured from this
 * token's own recorded observations and trades, or it is null; a mine on its curve is MINING_ACTIVE
 * while its curve budget has room, and stops being mineable when the budget is spent rather than
 * pretending a flat zero. The tests below run the real migrations and real SQL, because the
 * interesting part is what the queries find - and what they refuse to find.
 */
import { describe, expect, it } from "vitest";
import { change24hOf, mineStatusToTokenStatus, readToken24hMetrics } from "../chain";
import { createTestHarness, seedToken } from "./d1-sqlite";
import { DIGGO_CONFIG } from "../../shared/config";
import type { DecodedLaunchMarket, DecodedMine } from "../../shared/program";
import type { RuntimeEnv } from "../env";

const MINT = "Mint24h111111111111111111111111111111111111";
const NOW = 1_800_000_000;
const HOUR = 3_600;
/** The slack the baseline window allows: a day less an hour, so a scheduled sampler qualifies. */
const BASELINE_CUTOFF = NOW - DIGGO_CONFIG.curve.changeBaselineSeconds;

let sampleSeq = 0;

function harness(): { env: RuntimeEnv; close(): void } {
  const h = createTestHarness();
  seedToken(h.db, { mint: MINT, status: "MINING_ACTIVE" });
  return { env: h.env, close: () => h.db.close() };
}

function seedSample(env: RuntimeEnv, priceUsd: number, observedAt: number): void {
  sampleSeq += 1;
  env.DB.prepare(
    "INSERT INTO token_price_samples (id, mint, price_usd, volume_usd, observed_at)" +
      " VALUES (?1, ?2, ?3, ?4, ?5)",
  )
    .bind("sample-" + sampleSeq, MINT, priceUsd, 1_000, observedAt)
    .run();
}

function seedTrade(env: RuntimeEnv, priceUsd: number, amount: number, blockTime: number): void {
  env.DB.prepare(
    "INSERT OR REPLACE INTO trades (signature, mint, side, price_usd, price_sol, amount, block_time)" +
      " VALUES (?1, ?2, 'buy', ?3, 0, ?4, ?5)",
  )
    .bind("sig-" + blockTime + "-" + amount, MINT, priceUsd, amount, blockTime)
    .run();
}

describe("the 24h change a token reports", () => {
  it("measures against the observation closest to a day old", async () => {
    const h = harness();
    // Two observations old enough to be a baseline: the newer one is the one that is used.
    seedSample(h.env, 100, NOW - 26 * HOUR);
    seedSample(h.env, 120, NOW - 25 * HOUR);
    seedTrade(h.env, 150, 10, NOW - 2 * HOUR);

    const metrics = await readToken24hMetrics(h.env, MINT, 150, NOW);
    expect(metrics.change24h).toBeCloseTo(25, 6);
    expect(metrics.change24hAt).toBe(NOW - 25 * HOUR);
    expect(metrics.trades24h).toBe(1);
    expect(metrics.volume24hUsd).toBeCloseTo(1_500, 6);
    h.close();
  });

  it("reports unknown, never a flat zero, without an observation a day old", async () => {
    const h = harness();
    seedSample(h.env, 100, NOW - 2 * HOUR);
    seedTrade(h.env, 150, 10, NOW - HOUR);

    const metrics = await readToken24hMetrics(h.env, MINT, 150, NOW);
    expect(metrics.change24h).toBeNull();
    expect(metrics.change24hAt).toBe(0);
    // The trades that did happen are still reported: they are what a client ranks on instead.
    expect(metrics.trades24h).toBe(1);
    h.close();
  });

  it("accepts a baseline the sampler took just inside the window, and refuses a younger one", async () => {
    const inside = harness();
    seedSample(inside.env, 100, BASELINE_CUTOFF);
    seedTrade(inside.env, 200, 1, NOW - HOUR);
    expect((await readToken24hMetrics(inside.env, MINT, 200, NOW)).change24h).toBeCloseTo(100, 6);
    inside.close();

    // A minute younger than the window is not a 24h baseline, however close it looks: the
    // measurement is a day's change or nothing.
    const tooYoung = harness();
    seedSample(tooYoung.env, 100, BASELINE_CUTOFF + 1);
    seedTrade(tooYoung.env, 200, 1, NOW - HOUR);
    expect((await readToken24hMetrics(tooYoung.env, MINT, 200, NOW)).change24h).toBeNull();
    tooYoung.close();
  });

  it("reports unknown when nothing has traded in the window", async () => {
    const h = harness();
    seedSample(h.env, 100, NOW - 25 * HOUR);
    expect((await readToken24hMetrics(h.env, MINT, 150, NOW)).change24h).toBeNull();

    // A trade older than the window is not activity in it.
    seedTrade(h.env, 120, 5, NOW - 30 * HOUR);
    const metrics = await readToken24hMetrics(h.env, MINT, 150, NOW);
    expect(metrics.change24h).toBeNull();
    expect(metrics.trades24h).toBe(0);
    expect(metrics.volume24hUsd).toBe(0);
    h.close();
  });

  it("measures volume and trade count over the window and nothing else", async () => {
    const h = harness();
    seedSample(h.env, 100, NOW - 25 * HOUR);
    seedTrade(h.env, 10, 100, NOW - HOUR);
    seedTrade(h.env, 20, 50, NOW - 20 * HOUR);
    seedTrade(h.env, 999, 1_000, NOW - 30 * HOUR);

    const metrics = await readToken24hMetrics(h.env, MINT, 125, NOW);
    expect(metrics.trades24h).toBe(2);
    expect(metrics.volume24hUsd).toBeCloseTo(10 * 100 + 20 * 50, 6);
    expect(metrics.change24h).toBeCloseTo(25, 6);
    h.close();
  });

  it("refuses a baseline of zero, which no percentage can be taken against", async () => {
    const h = harness();
    seedSample(h.env, 0, NOW - 25 * HOUR);
    seedTrade(h.env, 150, 1, NOW - HOUR);
    expect((await readToken24hMetrics(h.env, MINT, 150, NOW)).change24h).toBeNull();
    h.close();
  });
});

describe("change24hOf", () => {
  it("needs a usable baseline and real activity, and rounds to two decimals", async () => {
    expect(change24hOf({ priceUsd: 150, baselinePriceUsd: null, trades24h: 5 })).toBeNull();
    expect(change24hOf({ priceUsd: 150, baselinePriceUsd: 0, trades24h: 5 })).toBeNull();
    expect(change24hOf({ priceUsd: 150, baselinePriceUsd: 100, trades24h: 0 })).toBeNull();
    expect(change24hOf({ priceUsd: 0, baselinePriceUsd: 100, trades24h: 5 })).toBeNull();
    expect(change24hOf({ priceUsd: 150, baselinePriceUsd: 100, trades24h: 5 })).toBe(50);
    expect(change24hOf({ priceUsd: 50, baselinePriceUsd: 100, trades24h: 5 })).toBe(-50);
    expect(change24hOf({ priceUsd: 100.123_456, baselinePriceUsd: 100, trades24h: 5 })).toBe(0.12);
  });
});

describe("the status of a mine that is still on its curve", () => {
  function mine(status: DecodedMine["status"], curveMiningOpen = false): DecodedMine {
    return { status, curveMiningOpen } as unknown as DecodedMine;
  }
  function market(
    overrides: { graduated?: boolean; cap?: bigint; mined?: bigint } = {},
  ): DecodedLaunchMarket {
    return {
      graduated: overrides.graduated ?? false,
      curveMiningCap: overrides.cap ?? 0n,
      curveMiningMined: overrides.mined ?? 0n,
    } as unknown as DecodedLaunchMarket;
  }

  it("is MINING_ACTIVE from the launch block, while the curve budget has room", async () => {
    expect(mineStatusToTokenStatus(mine("MiningActive"), market({ cap: 47_500n }))).toBe(
      "MINING_ACTIVE",
    );
    // A legacy account whose status byte still says Launching but whose market has a budget is
    // just as mineable, because the budget is what pays.
    expect(mineStatusToTokenStatus(mine("Launching"), market({ cap: 47_500n }))).toBe(
      "MINING_ACTIVE",
    );
  });

  it("goes idle, not finished, when the curve budget is spent and the market has not graduated", async () => {
    // CURVE_CAP_REACHED and not FULLY_MINED: the mine's Mining Reserve is untouched, and the
    // indexing loop has to keep re-reading this market precisely so that it notices graduation.
    // A FULLY_MINED token is one the sync pass is allowed to stop following, which would leave
    // this mine idle for good.
    expect(
      mineStatusToTokenStatus(mine("MiningActive"), market({ cap: 47_500n, mined: 47_500n })),
    ).toBe("CURVE_CAP_REACHED");
    // Graduation turns it back on: the Mining Reserve is untouched and is now the source.
    expect(
      mineStatusToTokenStatus(
        mine("MiningActive"),
        market({ graduated: true, cap: 47_500n, mined: 47_500n }),
      ),
    ).toBe("MINING_ACTIVE");
    // ...until that reserve runs out, which is the only state the program calls finished.
    expect(
      mineStatusToTokenStatus(
        { status: "MiningActive", remainingReserve: 0n } as unknown as DecodedMine,
        market({ graduated: true, cap: 47_500n, mined: 47_500n }),
      ),
    ).toBe("FULLY_MINED");
  });

  it("reports the curve phase a market cannot pay out of as idle, whatever its status byte says", async () => {
    // A legacy market has no curve budget - a migration can only ever default the cap to zero -
    // and before graduation nothing else may pay a block, so nothing is mineable until it
    // graduates. It is idle, not finished, and it stays in the sync loop.
    expect(mineStatusToTokenStatus(mine("Launching"), market())).toBe("CURVE_CAP_REACHED");
    expect(mineStatusToTokenStatus(mine("MiningActive"), market())).toBe("CURVE_CAP_REACHED");
    // A launch that asked for a zero share is the same case by construction.
    expect(mineStatusToTokenStatus(mine("MiningActive"), market({ cap: 0n }))).toBe(
      "CURVE_CAP_REACHED",
    );
  });

  it("reports FULLY_MINED for a mine the program has finished, whatever the market says", async () => {
    expect(mineStatusToTokenStatus(mine("FullyMined"), market({ cap: 47_500n }))).toBe("FULLY_MINED");
    expect(
      mineStatusToTokenStatus(mine("FullyMined"), market({ graduated: true, cap: 47_500n })),
    ).toBe("FULLY_MINED");
  });
});
