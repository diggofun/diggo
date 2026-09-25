import { describe, expect, it } from "vitest";
import {
  DAMM_V2_PROGRAM_ID,
  PARAMS,
  buildDiggoConfig,
  buildDiggoCurveBase,
  solString,
} from "./common.ts";

describe("Diggo Meteora configuration", () => {
  it("builds the fixed supply and reserve requirements", () => {
    const base = buildDiggoCurveBase();
    expect(base.token.totalTokenSupply).toBe(1_000_000_000);
    expect(base.token.leftover).toBe(200_000_000);
    expect(base.token.tokenBaseDecimal).toBe(9);
    expect(base.token.tokenType).toBe(0);
  });

  it("builds the configured fees and migration path", () => {
    const base = buildDiggoCurveBase();
    expect(base.fee.baseFeeParams).toMatchObject({
      feeSchedulerParam: {
        startingFeeBps: 300,
        endingFeeBps: 100,
        totalDuration: 3600,
      },
    });
    expect(base.fee.dynamicFeeEnabled).toBe(true);
    expect(base.fee.creatorTradingFeePercentage).toBe(0);
    expect(base.fee.poolCreationFee).toBe(0.01);
    expect(base.migration.migrationOption).toBe(1);
    expect(base.migration.migrationFee.feePercentage).toBe(1);
    expect(base.migration.migratedPoolFee?.poolFeeBps).toBe(100);
    expect(base.migration.migrationOption).toBe(1);
  });

  it("builds the curve migration split and locked partner liquidity", () => {
    const config = buildDiggoConfig("devnet");
    expect(config.migrationQuoteThreshold.toString()).toBe("2000000000");
    expect(config.partnerPermanentLockedLiquidityPercentage).toBe(10);
    expect(config.partnerLiquidityPercentage).toBe(90);
    expect(config.creatorPermanentLockedLiquidityPercentage).toBe(0);
    expect(config.creatorLiquidityPercentage).toBe(0);
    expect(config.curve).toHaveLength(2);
  });

  it("uses cluster-specific migration thresholds", () => {
    expect(buildDiggoConfig("devnet").migrationQuoteThreshold.toString()).toBe("2000000000");
    expect(buildDiggoConfig("mainnet").migrationQuoteThreshold.toString()).toBe("85000000000");
  });

  it("keeps program identifiers and exact cost formatting stable", () => {
    expect(DAMM_V2_PROGRAM_ID).toBe("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
    expect(PARAMS.poolCreationFeeSol).toBe(0.01);
    expect(solString(1_000_005_000n)).toBe("1.000005000 SOL");
    expect(solString(-9_456_965n)).toBe("-0.009456965 SOL");
  });
});
