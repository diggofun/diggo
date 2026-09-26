import { BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import { DynamicBondingCurveIdl } from "@meteora-ag/dynamic-bonding-curve-sdk";
import bs58 from "bs58";
import { describe, expect, beforeEach, it, vi } from "vitest";
import {
  adminDashboard,
  decodeDbcFeeConfig,
  decodeDbcPoolFees,
  readFees,
  resetAdminDashboardCache,
  summarizePartnerFees,
  type DbcPoolFees,
} from "./adminDashboard";
import type { RuntimeEnv } from "./env";
import type { AdminDashboardPayload } from "../shared/adminDashboard";
import { METEORA_WRAPPED_SOL_MINT } from "../shared/meteora";
import { readAccount, readProgramAccounts, VIRTUAL_POOL_DISCRIMINATOR } from "./meteora/rpc";

vi.mock("./meteora/rpc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./meteora/rpc")>()),
  readAccount: vi.fn(),
  readProgramAccounts: vi.fn(),
}));

const OWNER = "GyGjx2nsgG2wDbUESGTw8aHndXh6b8d2znhZPqWSdwcH";
const CONFIG = "5yxCKEmi1rc5ebKmWdHbzj2pEe7caqS8xqvQh5V8duMF";
const POOL = "4g7i7aWVvwnSn6K6VKyvzG5UFf2nFCXgYJ7uJUymhhMB";
const OTHER_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const coder = new BorshAccountsCoder(DynamicBondingCurveIdl as unknown as Idl);

function discriminator(name: string): Uint8Array {
  const account = (DynamicBondingCurveIdl as unknown as Idl).accounts?.find((entry) => entry.name === name);
  if (!account) throw new Error("missing IDL account " + name);
  return Uint8Array.from(account.discriminator);
}

function writeU64(data: Uint8Array, offset: number, value: bigint): void {
  new DataView(data.buffer, data.byteOffset, data.byteLength).setBigUint64(offset, value, true);
}

/** A PoolState account with only the fee fields set, laid out as the DBC program stores it. */
function poolAccount(fees: { partner: bigint; protocol: bigint; totalTrading: bigint; totalProtocol: bigint; bits: number }): Uint8Array {
  const data = new Uint8Array(424);
  data.set(VIRTUAL_POOL_DISCRIMINATOR, 0);
  data.set(bs58.decode(CONFIG), 72);
  writeU64(data, 256, fees.protocol);
  writeU64(data, 272, fees.partner);
  writeU64(data, 320, fees.totalProtocol);
  writeU64(data, 336, fees.totalTrading);
  data[369] = fees.bits;
  return data;
}

function configAccount(quoteMint: string, creatorPercent: number, creationFee: bigint): Uint8Array {
  const data = new Uint8Array(1048);
  data.set(discriminator("PoolConfig"), 0);
  data.set(bs58.decode(quoteMint), 8);
  data[245] = creatorPercent;
  writeU64(data, 368, creationFee);
  return data;
}

/** The mainnet pool on 2026-09-26: nothing claimed yet, creator share 0%. */
const MAINNET_POOL = { partner: 274_084_940n, protocol: 59_229_871n, totalTrading: 274_084_940n, totalProtocol: 59_229_871n, bits: 0 };

class MissingTablesDb {
  prepare(): { bind: () => unknown; first: () => Promise<null>; all: () => Promise<{ results: [] }> } {
    const statement = {
      bind: () => statement,
      first: async () => {
        throw new Error("no such table: optional_dashboard_table");
      },
      all: async () => {
        throw new Error("no such table: optional_dashboard_table");
      },
    };
    return statement;
  }
}

class SessionCache {
  constructor(private readonly wallet: string) {}

  async get(key: string): Promise<string | null> {
    return key === `auth:session:dashboard-session` ? this.wallet : null;
  }
}

function environment(wallet: string): RuntimeEnv {
  return {
    ADMIN_WALLETS: OWNER,
    DB: new MissingTablesDb(),
    TOKEN_CACHE: new SessionCache(wallet),
    SOLANA_CLUSTER: "devnet",
  } as unknown as RuntimeEnv;
}

function request(session: string | null): Request {
  return new Request("https://diggo.fun/api/admin/dashboard", {
    headers: session ? { authorization: `Bearer ${session}` } : {},
  });
}

describe("admin dashboard", () => {
  beforeEach(() => {
    resetAdminDashboardCache();
    vi.mocked(readAccount).mockReset();
    vi.mocked(readProgramAccounts).mockReset();
  });

  it("rejects a signed session for a wallet outside the allowlist", async () => {
    const response = await adminDashboard(request("dashboard-session"), environment("11111111111111111111111111111111"));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Admin session required" });
  });

  it("returns the typed payload for an admin while optional tables are missing", async () => {
    const response = await adminDashboard(request("dashboard-session"), environment(OWNER));
    const payload = (await response.json()) as AdminDashboardPayload;

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("private");
    expect(payload).toMatchObject({
      actor: OWNER,
      chainMode: expect.any(String),
      cluster: "devnet",
      launches: { total: null, last24h: null, last7d: null },
      graduated: { total: null, last24h: null, last7d: null },
      tradingVolume: {
        all: { sol: null },
        last24h: { sol: null },
        last7d: { sol: null },
      },
      fees: {
        status: "unavailable",
        claimableSol: null,
        partnerTrading: { claimableSol: null, lifetimeSol: null, claimedSol: null },
        creation: { claimableSol: null, lifetimeSol: null, claimedSol: null },
      },
      claims: { pending: null, paid: null },
      players: { total: null, last24h: null, last7d: null },
      crews: { active24h: null },
      referrals: { invited: null, qualified: null, oreCredited: null },
      jobs: {
        indexer: { lastSuccessfulAt: null, lastError: null },
        vaultSweep: { lastSuccessfulAt: null, lastError: null },
        cron: { lastSuccessfulAt: null, lastError: null },
      },
    });
    expect(payload.vault).toMatchObject({ address: null, solBalance: null, tokenBalances: [] });
    expect(payload.addresses.treasury).toBeNull();
  });

  it("reports the on-chain claimable partner fees and caches the read", async () => {
    vi.mocked(readAccount).mockResolvedValue({ pubkey: CONFIG, lamports: 1n, data: configAccount(METEORA_WRAPPED_SOL_MINT, 0, 10_000_000n) });
    vi.mocked(readProgramAccounts).mockResolvedValue([
      { pubkey: POOL, lamports: 1n, data: poolAccount(MAINNET_POOL) },
      { pubkey: CONFIG, lamports: 1n, data: configAccount(METEORA_WRAPPED_SOL_MINT, 0, 10_000_000n) },
    ]);
    const env = { ...environment(OWNER), METEORA_DBC_CONFIG: CONFIG, DIGGO_RPC_URL: "https://rpc.invalid" } as RuntimeEnv;

    const payload = (await (await adminDashboard(request("dashboard-session"), env)).json()) as AdminDashboardPayload;

    expect(payload.fees).toMatchObject({ status: "live", claimableSol: "0.28308494", pools: 1, config: CONFIG, error: null });
    expect(readProgramAccounts).toHaveBeenCalledWith(expect.anything(), { memcmpOffset: 72, memcmpBytes: bs58.decode(CONFIG) });
    await readFees(env);
    expect(readAccount).toHaveBeenCalledTimes(1);
    expect(readProgramAccounts).toHaveBeenCalledTimes(1);
  });

  it("shows fees as unavailable, never estimated, when the RPC read fails", async () => {
    vi.mocked(readAccount).mockRejectedValue(new Error("429 Too Many Requests"));
    vi.mocked(readProgramAccounts).mockResolvedValue([]);
    const env = { ...environment(OWNER), METEORA_DBC_CONFIG: CONFIG, DIGGO_RPC_URL: "https://rpc.invalid" } as RuntimeEnv;
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await adminDashboard(request("dashboard-session"), env);
    const payload = (await response.json()) as AdminDashboardPayload;
    errors.mockRestore();

    expect(response.status).toBe(200);
    expect(payload.fees).toEqual({
      status: "unavailable",
      claimableSol: null,
      partnerTrading: { claimableSol: null, lifetimeSol: null, claimedSol: null },
      creation: { claimableSol: null, lifetimeSol: null, claimedSol: null },
      protocol: { tradingLifetimeSol: null, tradingUnclaimedSol: null, creationLifetimeSol: null },
      pools: null,
      config: CONFIG,
      readAt: null,
      error: "On-chain fee read failed",
    });
  });
});

describe("partner fee mapping", () => {
  it("decodes the fee fields at the offsets the DBC SDK coder uses", () => {
    const pool = decodeDbcPoolFees(POOL, poolAccount({ partner: 11n, protocol: 22n, totalTrading: 33n, totalProtocol: 44n, bits: 0b10 }));
    // The raw IDL coder keeps the program's snake_case names; the SDK camel-cases the same fields.
    const sdkPool = coder.decode("VirtualPool", Buffer.from(poolAccount({ partner: 11n, protocol: 22n, totalTrading: 33n, totalProtocol: 44n, bits: 0b10 }))).pool_state;
    expect(pool).toEqual({
      pool: POOL,
      partnerQuoteFee: BigInt(sdkPool.partner_quote_fee.toString()),
      protocolQuoteFee: BigInt(sdkPool.protocol_quote_fee.toString()),
      totalTradingQuoteFee: BigInt(sdkPool.metrics.total_trading_quote_fee.toString()),
      totalProtocolQuoteFee: BigInt(sdkPool.metrics.total_protocol_quote_fee.toString()),
      creationFeeBits: sdkPool.creation_fee_bits,
    });
    expect(pool).toMatchObject({ partnerQuoteFee: 11n, protocolQuoteFee: 22n, totalTradingQuoteFee: 33n, totalProtocolQuoteFee: 44n, creationFeeBits: 2 });

    const config = configAccount(METEORA_WRAPPED_SOL_MINT, 25, 10_000_000n);
    const sdkConfig = coder.decode("PoolConfig", Buffer.from(config));
    expect(decodeDbcFeeConfig(config)).toEqual({
      quoteMint: sdkConfig.quote_mint.toBase58(),
      creatorTradingFeePercentage: sdkConfig.creator_trading_fee_percentage,
      poolCreationFeeLamports: BigInt(sdkConfig.pool_creation_fee.toString()),
    });
  });

  it("matches the mainnet partner claimable: trading fee plus the unclaimed creation fee", () => {
    const fees = summarizePartnerFees(CONFIG, { quoteMint: METEORA_WRAPPED_SOL_MINT, creatorTradingFeePercentage: 0, poolCreationFeeLamports: 10_000_000n }, [
      decodeDbcPoolFees(POOL, poolAccount(MAINNET_POOL)),
    ], 1_790_000_000);
    expect(fees).toEqual({
      status: "live",
      claimableSol: "0.28308494",
      partnerTrading: { claimableSol: "0.27408494", lifetimeSol: "0.27408494", claimedSol: "0" },
      creation: { claimableSol: "0.009", lifetimeSol: "0.009", claimedSol: "0" },
      protocol: { tradingLifetimeSol: "0.059229871", tradingUnclaimedSol: "0.059229871", creationLifetimeSol: "0.001" },
      pools: 1,
      config: CONFIG,
      readAt: 1_790_000_000,
      error: null,
    });
  });

  it("splits the creator share off lifetime fees and counts claimed trading and creation fees", () => {
    const pools: DbcPoolFees[] = [
      { pool: "a", partnerQuoteFee: 100n, protocolQuoteFee: 0n, totalTradingQuoteFee: 1_000n, totalProtocolQuoteFee: 250n, creationFeeBits: 0b10 },
      { pool: "b", partnerQuoteFee: 800n, protocolQuoteFee: 5n, totalTradingQuoteFee: 1_000n, totalProtocolQuoteFee: 250n, creationFeeBits: 0b01 },
    ];
    const fees = summarizePartnerFees(CONFIG, { quoteMint: METEORA_WRAPPED_SOL_MINT, creatorTradingFeePercentage: 20, poolCreationFeeLamports: 1_000_000_000n }, pools, 1);
    expect(fees.partnerTrading).toEqual({ claimableSol: "0.0000009", lifetimeSol: "0.0000016", claimedSol: "0.0000007" });
    expect(fees.creation).toEqual({ claimableSol: "0.9", lifetimeSol: "1.8", claimedSol: "0.9" });
    expect(fees.claimableSol).toBe("0.9000009");
    expect(fees.protocol).toEqual({ tradingLifetimeSol: "0.0000005", tradingUnclaimedSol: "0.000000005", creationLifetimeSol: "0.2" });
  });

  it("refuses to report SOL figures for a config that is not SOL-quoted", () => {
    const fees = summarizePartnerFees(CONFIG, { quoteMint: OTHER_MINT, creatorTradingFeePercentage: 0, poolCreationFeeLamports: 0n }, [], 1);
    expect(fees).toMatchObject({ status: "unavailable", claimableSol: null, error: "Config is not SOL-quoted" });
  });

  it("rejects truncated accounts instead of reading zeros", () => {
    expect(() => decodeDbcPoolFees(POOL, new Uint8Array(300))).toThrow("truncated");
    expect(() => decodeDbcFeeConfig(new Uint8Array(200))).toThrow("truncated");
  });
});
