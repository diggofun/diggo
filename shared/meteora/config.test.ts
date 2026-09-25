import { describe, expect, it } from "vitest";
import {
  METEORA_FEE_CLAIMER,
  estimatedMeteoraLaunchCostLamports,
  isMeteoraConfigPubkey,
  migrationThresholdLamports,
  normalizeChainMode,
  normalizeMeteoraCluster,
  requireMeteoraConfigPubkey,
} from "./config";

describe("Meteora configuration", () => {
  it("pins the canonical platform fee destination", () => {
    expect(METEORA_FEE_CLAIMER).toBe("6HHEkX5MxsoQwyCJZHvLnewmnsaw19vGT9Y8jhqH7GuJ");
  });

  it("defaults to the temporary Meteora mode and mainnet", () => {
    expect(normalizeChainMode(undefined)).toBe("meteora");
    expect(normalizeChainMode("native")).toBe("native");
    expect(normalizeMeteoraCluster(undefined)).toBe("mainnet-beta");
    expect(normalizeMeteoraCluster("devnet")).toBe("devnet");
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

  it("rejects the launch placeholder as a pubkey", () => {
    expect(isMeteoraConfigPubkey("SET_AFTER_CREATE")).toBe(false);
    expect(() => requireMeteoraConfigPubkey("SET_AFTER_CREATE")).toThrow(/config pubkey/i);
  });
});
