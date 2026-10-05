import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "./env";
import { readAccount } from "./meteora/rpc";
import { METEORA_TOKEN_PROGRAM_ID } from "./meteora/types";
import type { MeteoraRpcEnv } from "./meteora/types";
import { adminCloseSponsoredMine, adminRegisterSponsoredMine, inspectSponsoredMint } from "./sponsored";

vi.mock("./meteora/rpc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./meteora/rpc")>()),
  readAccount: vi.fn(),
}));

const ADMIN = "6HHEkX5MxsoQwyCJZHvLnewmnsaw19vGT9Y8jhqH7GuJ";
const PLAYER = "11111111111111111111111111111111";
const MINT = "So11111111111111111111111111111111111111112";
const VAULT = "6HHEkX5MxsoQwyCJZHvLnewmnsaw19vGT9Y8jhqH7GuJ";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EHFLC1PE7zxs5ZrDTjfE";

/** A session cache that resolves one bearer token to `wallet`, and a DB that records writes. */
function environment(wallet: string) {
  const writes: string[] = [];
  const statement = (sql: string) => ({
    bind: () => statement(sql),
    run: async () => { writes.push(sql); return { meta: { changes: 1 } }; },
    first: async () => null,
    all: async () => ({ results: [] }),
  });
  const env = {
    DB: { prepare: (sql: string) => statement(sql) },
    TOKEN_CACHE: { get: async (key: string) => (key === "auth:session:s" ? wallet : null) },
    SOLANA_CLUSTER: "devnet",
  } as unknown as RuntimeEnv;
  return { env, writes };
}

function post(path: string, body: unknown): Request {
  return new Request("https://diggo.fun" + path, {
    method: "POST",
    headers: { authorization: "Bearer s", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const registration = { mint: MINT, symbol: "PUMP", name: "Pump", sponsor: "Pump team", reserve: "1000" };

/** Mint account bytes: supply at 36, decimals at 44. */
function mintData(decimals: number): Uint8Array {
  const data = new Uint8Array(82);
  data[44] = decimals;
  return data;
}

function tokenAccount(amount: bigint): Uint8Array {
  const data = new Uint8Array(165);
  for (let index = 0; index < 8; index += 1) data[64 - 16 + index] = Number((amount >> BigInt(index * 8)) & 0xffn);
  return data;
}

describe("sponsored mine admin routes", () => {
  it("refuse a wallet that is not an admin, before touching the database", async () => {
    const { env, writes } = environment(PLAYER);
    expect((await adminRegisterSponsoredMine(post("/api/admin/sponsored-mines", registration), env)).status).toBe(401);
    expect((await adminCloseSponsoredMine(post("/api/admin/sponsored-mines/close", { mint: MINT }), env)).status).toBe(401);
    expect(writes.filter((sql) => /sponsored_mines/.test(sql))).toEqual([]);
  });

  it("refuse an admin session without a signed confirmation of this exact change", async () => {
    const { env, writes } = environment(ADMIN);
    const response = await adminRegisterSponsoredMine(post("/api/admin/sponsored-mines", registration), env);
    expect(response.status).toBe(401);
    const closed = await adminCloseSponsoredMine(post("/api/admin/sponsored-mines/close", { mint: MINT }), env);
    expect(closed.status).toBe(401);
    expect(writes.filter((sql) => /INSERT INTO sponsored_mines|UPDATE sponsored_mines/.test(sql))).toEqual([]);
  });

  it("reject invalid input before asking for a signature", async () => {
    const { env } = environment(ADMIN);
    const response = await adminRegisterSponsoredMine(post("/api/admin/sponsored-mines", { ...registration, reserve: "0" }), env);
    expect(response.status).toBe(400);
  });
});

describe("inspectSponsoredMint", () => {
  const rpcEnv = {} as MeteoraRpcEnv;
  beforeEach(() => vi.mocked(readAccount).mockReset());

  it("reads the decimals and the vault's balance of a classic SPL mint", async () => {
    vi.mocked(readAccount).mockImplementation(async (_env, account) => account === MINT
      ? { pubkey: MINT, lamports: 1n, data: mintData(6), owner: METEORA_TOKEN_PROGRAM_ID }
      : { pubkey: account, lamports: 1n, data: tokenAccount(5_000_000n), owner: METEORA_TOKEN_PROGRAM_ID });
    await expect(inspectSponsoredMint(rpcEnv, MINT, VAULT)).resolves.toEqual({ decimals: 6, vaultBalance: 5_000_000n });
  });

  it("reports an empty vault as zero", async () => {
    vi.mocked(readAccount).mockImplementation(async (_env, account) => account === MINT
      ? { pubkey: MINT, lamports: 1n, data: mintData(9), owner: METEORA_TOKEN_PROGRAM_ID }
      : null);
    await expect(inspectSponsoredMint(rpcEnv, MINT, VAULT)).resolves.toEqual({ decimals: 9, vaultBalance: 0n });
  });

  it("refuses Token-2022 and missing mints", async () => {
    vi.mocked(readAccount).mockResolvedValue({ pubkey: MINT, lamports: 1n, data: mintData(6), owner: TOKEN_2022 });
    await expect(inspectSponsoredMint(rpcEnv, MINT, VAULT)).rejects.toThrow(/Token-2022/);
    vi.mocked(readAccount).mockResolvedValue(null);
    await expect(inspectSponsoredMint(rpcEnv, MINT, VAULT)).rejects.toThrow(/does not exist/);
  });
});
