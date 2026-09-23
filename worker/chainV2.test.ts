import { describe, expect, it } from "vitest";
import {
  ChainConfigurationError,
  DEFAULT_DEVNET_RPC,
  DEVNET_PROGRAM_ID,
  isLocalChainRuntime,
  resolveChainConfig,
} from "./chainV2";

function env(overrides: Partial<Parameters<typeof resolveChainConfig>[0]> = {}) {
  return {
    SOLANA_CLUSTER: "devnet",
    DIGGO_PROGRAM_ID: DEVNET_PROGRAM_ID,
    ...overrides,
  };
}

describe("resolveChainConfig", () => {
  it("keeps the public devnet fallback for local Wrangler", () => {
    const config = resolveChainConfig(env({ CF_VERSION_METADATA: { id: "local", tag: "", timestamp: "" } }));
    expect(config.rpcUrl).toBe(DEFAULT_DEVNET_RPC);
    expect(isLocalChainRuntime(env({ CF_VERSION_METADATA: { id: "local", tag: "", timestamp: "" } }))).toBe(true);
  });

  it("requires an explicit RPC URL for a deployed devnet environment", () => {
    expect(() => resolveChainConfig(env({ CF_VERSION_METADATA: { id: "v1", tag: "v1", timestamp: "" } }), { deployed: true })).toThrow(
      ChainConfigurationError,
    );
  });

  it("accepts an explicit devnet RPC and resolves the pinned program", () => {
    const config = resolveChainConfig(
      env({ DIGGO_RPC_URL: "https://devnet.example/rpc", CF_VERSION_METADATA: { id: "v1", tag: "v1", timestamp: "" } }),
      { deployed: true },
    );
    expect(config).toMatchObject({ cluster: "devnet", programId: DEVNET_PROGRAM_ID, rpcUrl: "https://devnet.example/rpc" });
  });

  it("rejects a mismatched or malformed devnet program id", () => {
    expect(() => resolveChainConfig(env({ DIGGO_PROGRAM_ID: "11111111111111111111111111111111" }))).toThrow(ChainConfigurationError);
    expect(() => resolveChainConfig(env({ DIGGO_PROGRAM_ID: "not-base58" }))).toThrow(ChainConfigurationError);
  });

  it("does not allow the devnet program on mainnet", () => {
    expect(() => resolveChainConfig(env({ SOLANA_CLUSTER: "mainnet-beta", DIGGO_RPC_URL: "https://mainnet.example/rpc" }))).toThrow(
      ChainConfigurationError,
    );
  });
});
