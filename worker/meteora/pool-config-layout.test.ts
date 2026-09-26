/// <reference types="node" />
import { BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import { DynamicBondingCurveIdl } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { describe, expect, it } from "vitest";
import fixture from "./fixtures/mainnet-diggo-pool.json";
import { decodePoolConfig, POOL_CONFIG_MIGRATION_THRESHOLD_OFFSET, POOL_CONFIG_TOKEN_DECIMAL_OFFSET } from "./rpc";

describe("PoolConfig layout against the DBC SDK decoder", () => {
  it("reads token decimals and the migration threshold where the SDK does", () => {
    const account = (fixture.accounts as Record<string, { data: string[] }>)[fixture.config]!;
    const bytes = Buffer.from(account.data[0]!, "base64");
    const sdk = new BorshAccountsCoder(DynamicBondingCurveIdl as unknown as Idl).decode("PoolConfig", bytes) as {
      token_decimal: number;
      version: number;
      migration_quote_threshold: { toString(): string };
      quote_mint: { toBase58(): string };
    };
    const ours = decodePoolConfig(new Uint8Array(bytes));
    // token_decimal is byte 235; byte 236 is the config version, which read 0 as "decimals".
    expect(POOL_CONFIG_TOKEN_DECIMAL_OFFSET).toBe(235);
    expect(bytes[POOL_CONFIG_TOKEN_DECIMAL_OFFSET + 1]).toBe(sdk.version);
    expect(ours.tokenDecimal).toBe(sdk.token_decimal);
    expect(ours.tokenDecimal).toBe(9);
    expect(ours.migrationQuoteThreshold.toString()).toBe(sdk.migration_quote_threshold.toString());
    expect(POOL_CONFIG_MIGRATION_THRESHOLD_OFFSET).toBe(264);
    expect(ours.quoteMint).toBe(sdk.quote_mint.toBase58());
  });
});

