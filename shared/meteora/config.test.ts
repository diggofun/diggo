import { describe, expect, it } from "vitest";
import {
  estimatedMeteoraLaunchCostLamports,
  migrationThresholdLamports,
  normalizeChainMode,
  normalizeMeteoraCluster,
  requireMeteoraConfigPubkey,
} from "./config";

describe("Meteora configuration", () => {
  it("defaults to the temporary Meteora mode and devnet", () => {
    expect(normalizeChainMode(undefined)).toBe("meteora");
    expect(normalizeChainMode("native")).toBe("native");
    expect(normalizeMeteoraCluster(undefined)).toBe("devnet");
    expect(normalizeMeteoraCluster("mainnet-beta")).toBe("mainnet-beta");
  });

  it("uses cluster-specific graduation thresholds", () => {
    expect(migrationThresholdLamports("devnet")).toBe(2_000_000_000n);
    expect(migrationThresholdLamports("mainnet")).toBe(85_000_000_000n);
  });

  it("includes the partner creation fee, rent and transaction estimate", () => {
    expect(estimatedMeteoraLaunchCostLamports()).toEqual({
      poolCreationFeeLamports: 10_000_000n,
      rentLamports: 20_000_000n,
      transactionFeeLamports: 2_000_000n,
      totalLamports: 32_000_000n,
    });
  });

  it("fails clearly when bootstrap has not published a config pubkey", () => {
    expect(() => requireMeteoraConfigPubkey("")).toThrow(/config pubkey/i);
    expect(requireMeteoraConfigPubkey("11111111111111111111111111111111")).toBe(
      "11111111111111111111111111111111",
    );
  });
});
