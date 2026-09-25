import { beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/mainnet-diggo-pool.json";

// Real mainnet responses for the $DIGGO launch: a legacy createPool transaction followed by a
// version 1 swap transaction on the same DBC config (see fixtures/mainnet-diggo-pool.json).
type RpcTransaction = { version: "legacy" | number };
type SignatureRow = { signature: string };

const chain = vi.hoisted(() => ({
  listedSignatures: [] as SignatureRow[],
  unreadable: new Set<string>(),
  missingAccounts: new Set<string>(),
  transactionReads: [] as string[],
}));

vi.mock("../chainV2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../chainV2")>();
  const send = <T>(value: () => T) => ({ send: async () => value() });
  return {
    ...actual,
    getChainRpc: () => ({
      getSignaturesForAddress: (account: string, options: { limit: number; until?: string; before?: string }) => send(() => {
        if (account !== fixture.config) return [];
        let rows = chain.listedSignatures;
        if (options.before) rows = rows.slice(rows.findIndex((row) => row.signature === options.before) + 1);
        if (options.until) {
          const at = rows.findIndex((row) => row.signature === options.until);
          if (at >= 0) rows = rows.slice(0, at);
        }
        return rows.slice(0, options.limit);
      }),
      getTransaction: (signature: string, options: { maxSupportedTransactionVersion?: number }) => send(() => {
        chain.transactionReads.push(signature);
        if (chain.unreadable.has(signature)) throw new Error("RPC timeout");
        const transaction = (fixture.transactions as Record<string, RpcTransaction>)[signature] ?? null;
        // Mirrors the mainnet RPC: a newer transaction version than requested fails the call.
        if (transaction && typeof transaction.version === "number" && transaction.version > (options.maxSupportedTransactionVersion ?? -1)) {
          throw new Error(`Transaction version (${transaction.version}) is not supported by the requesting client.`);
        }
        return transaction;
      }),
      getAccountInfo: (account: string) => send(() => ({
        value: chain.missingAccounts.has(account) ? null : (fixture.accounts as Record<string, unknown>)[account] ?? null,
      })),
      getProgramAccounts: (_program: string, options: { filters: unknown[] }) => send(() => (
        JSON.stringify(options.filters) === JSON.stringify(fixture.programAccounts.filters) ? fixture.programAccounts.value : []
      )),
    }),
  };
});

const { discoverMeteoraPools } = await import("./indexer");
const { decodeMetaplexMetadata, mintMetadataAddress } = await import("./rpc");

function memoryDb(configCursor: string | null) {
  const state = { configCursor, pools: new Map<string, unknown[]>() };
  const prepare = (sql: string) => {
    let args: unknown[] = [];
    const statement = {
      bind: (...values: unknown[]) => { args = values; return statement; },
      first: async () => sql.includes("FROM meteora_config_scan") ? (state.configCursor ? { signature_cursor: state.configCursor } : null) : null,
      all: async () => ({ results: [...state.pools.keys()].map((pool) => ({ pool })) }),
      run: async () => {
        if (sql.startsWith("INSERT INTO meteora_config_scan")) state.configCursor = String(args[1]);
        if (sql.startsWith("INSERT INTO meteora_pools")) state.pools.set(String(args[0]), args);
        return { meta: {} };
      },
    };
    return statement;
  };
  return { state, db: { prepare } };
}

function env(db: unknown) {
  return { DB: db, DIGGO_RPC_URL: "https://rpc.invalid", SOLANA_CLUSTER: "mainnet-beta", CHAIN_MODE: "meteora", METEORA_DBC_CONFIG: fixture.config } as never;
}

describe("Meteora pool discovery on mainnet", () => {
  beforeEach(() => {
    chain.listedSignatures = [...fixture.signatures];
    chain.unreadable.clear();
    chain.missingAccounts.clear();
    chain.transactionReads = [];
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("finds the pool behind a newer version 1 transaction and moves the cursor to the newest signature", async () => {
    const { state, db } = memoryDb(fixture.cursorBeforeCreate);
    const pools = await discoverMeteoraPools(env(db));
    expect(pools.map((pool) => [pool.pool, pool.baseMint, pool.config])).toEqual([[fixture.pool, fixture.mint, fixture.config]]);
    expect(state.pools.has(fixture.pool)).toBe(true);
    expect(state.configCursor).toBe(fixture.signatures[0].signature);
    // The reverted transaction is skipped from the signature list without a transaction read.
    expect(chain.transactionReads).not.toContain(fixture.signatures[0].signature);
  });

  it("takes the symbol from the mint's Metaplex metadata and the image from the DBC logo", async () => {
    const { db } = memoryDb(fixture.cursorBeforeCreate);
    const [pool] = await discoverMeteoraPools(env(db));
    expect(mintMetadataAddress(fixture.mint)).toBe(fixture.mintMetadata);
    expect([pool.name, pool.symbol, pool.uri]).toEqual(["Diggo", "DIGGO", "https://diggo.fun/media/official-diggo-logo-v1.png"]);
  });

  it("falls back to the image in the Metaplex JSON when the DBC pool has no logo", async () => {
    chain.missingAccounts.add(fixture.dbcPoolMetadata);
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ image: "https://diggo.fun/media/from-json.png" })));
    vi.stubGlobal("fetch", fetcher);
    try {
      const { db } = memoryDb(fixture.cursorBeforeCreate);
      const [pool] = await discoverMeteoraPools(env(db));
      expect([pool.symbol, pool.uri]).toEqual(["DIGGO", "https://diggo.fun/media/from-json.png"]);
      expect(fetcher).toHaveBeenCalledWith("https://diggo.fun/media/official-diggo-metadata-v1.json", expect.anything());
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("decodes Metaplex metadata only from a MetadataV1 account", () => {
    const [data] = (fixture.accounts as Record<string, { data: string[] }>)[fixture.mintMetadata].data;
    const bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
    expect(decodeMetaplexMetadata(bytes)).toEqual({ name: "Diggo", symbol: "DIGGO", uri: "https://diggo.fun/media/official-diggo-metadata-v1.json" });
    expect(decodeMetaplexMetadata(Uint8Array.of(7, ...bytes.subarray(1)))).toBeNull();
  });

  it("reconciles a pool whose create transaction never appears in the signature scan", async () => {
    chain.listedSignatures = [];
    const { state, db } = memoryDb(fixture.signatures[0].signature);
    const pools = await discoverMeteoraPools(env(db));
    expect(pools.map((pool) => pool.pool)).toEqual([fixture.pool]);
    expect(state.pools.has(fixture.pool)).toBe(true);
  });

  it("keeps the cursor before a transaction it could not read and still indexes the pool", async () => {
    const create = fixture.signatures[2].signature;
    chain.unreadable.add(create);
    const { state, db } = memoryDb(fixture.cursorBeforeCreate);
    const pools = await discoverMeteoraPools(env(db));
    expect(state.configCursor).toBe(fixture.cursorBeforeCreate);
    expect(pools.map((pool) => pool.pool)).toEqual([fixture.pool]);
  });
});

