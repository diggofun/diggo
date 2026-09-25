import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChainConfigurationError,
  DEFAULT_DEVNET_RPC,
  DEVNET_PROGRAM_ID,
  isLocalChainRuntime,
  getChainRpc,
  resolveChainConfig,
} from "./chainV2";

afterEach(() => {
  vi.restoreAllMocks();
});

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
    expect(() => resolveChainConfig(env({ CHAIN_MODE: "native", SOLANA_CLUSTER: "mainnet-beta", DIGGO_RPC_URL: "https://mainnet.example/rpc" }))).toThrow(
      ChainConfigurationError,
    );
  });

  it("allows mainnet Meteora mode without a native program id", () => {
    const config = resolveChainConfig(env({
      CHAIN_MODE: "meteora",
      SOLANA_CLUSTER: "mainnet-beta",
      DIGGO_PROGRAM_ID: undefined,
      DIGGO_RPC_URL: "https://mainnet.example/rpc",
    }));
    expect(config).toMatchObject({ cluster: "mainnet-beta", programId: null, rpcUrl: "https://mainnet.example/rpc" });
  });

  it("still requires a valid native program id in native mode", () => {
    expect(() => resolveChainConfig(env({ CHAIN_MODE: "native", DIGGO_PROGRAM_ID: undefined }))).toThrow(ChainConfigurationError);
    expect(() => resolveChainConfig(env({ CHAIN_MODE: undefined, DIGGO_PROGRAM_ID: undefined }))).toThrow(ChainConfigurationError);
  });

  it("fails over to the next RPC on 403 and keeps the ordered URL list", async () => {
    const primary = "https://primary.example/rpc";
    const fallback = "https://fallback.example/rpc";
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("forbidden", { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: null } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    const config = resolveChainConfig(env({ DIGGO_RPC_URL: primary, DIGGO_RPC_URLS: fallback }));
    expect(config.rpcUrls).toEqual([primary, fallback]);
    const result = await getChainRpc(env({ DIGGO_RPC_URL: primary, DIGGO_RPC_URLS: fallback }))
      .getAccountInfo("So11111111111111111111111111111111111111112" as never, { commitment: "confirmed" } as never)
      .send();
    expect(result).toEqual({ context: { slot: 1n }, value: null });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
