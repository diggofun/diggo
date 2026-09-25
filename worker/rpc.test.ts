import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEVNET_PROGRAM_ID } from "./chainV2";
import { proxyRpc } from "./rpc";
import { METEORA_DBC_PROGRAM_ID } from "../shared/meteora";

const PROGRAM = new PublicKey(DEVNET_PROGRAM_ID);
const SESSION = "test-session";
const ADDRESS = new PublicKey(new Uint8Array(32).fill(1)).toBase58();
const TOKEN_PROGRAM = new PublicKey(new Uint8Array(32).fill(2)).toBase58();
const SIGNATURE = "1".repeat(64);
const DBC_CONFIG = "5yxCKEmi1rc5ebKmWdHbzj2pEe7caqS8xqvQh5V8duMF";
const VIRTUAL_POOL_DISCRIMINATOR = "cmrfVvtHrjd";

function kv() {
  const values = new Map<string, string>();
  return {
    async get(key: string) {
      return values.get(key) ?? null;
    },
    async put(key: string, value: string) {
      values.set(key, value);
    },
    async delete(key: string) {
      values.delete(key);
    },
    values,
  };
}

function runtime(kvStore = kv(), wallet?: Keypair) {
  if (wallet) kvStore.values.set(`auth:session:${SESSION}`, wallet.publicKey.toBase58());
  return {
    TOKEN_CACHE: kvStore,
    SOLANA_CLUSTER: "devnet",
    DIGGO_PROGRAM_ID: DEVNET_PROGRAM_ID,
    DIGGO_RPC_URL: "https://devnet.example/rpc",
    CF_VERSION_METADATA: { id: "test", tag: "test", timestamp: "" },
  } as never;
}

function request(payload: unknown, url = "https://diggo.fun/api/rpc") {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `diggo_session=${SESSION}` },
    body: JSON.stringify(payload),
  });
}

function encode(transaction: Transaction): string {
  return Buffer.from(transaction.serialize()).toString("base64");
}

function signedTransaction(wallet: Keypair): string {
  const transaction = new Transaction({ feePayer: wallet.publicKey, recentBlockhash: PublicKey.default.toBase58() });
  transaction.add(
    new TransactionInstruction({
      programId: PROGRAM,
      keys: [{ pubkey: wallet.publicKey, isSigner: true, isWritable: false }],
      data: Buffer.from([1, 0, 0, 0]),
    }),
  );
  transaction.add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 }));
  transaction.sign(wallet);
  return encode(transaction);
}

function unsignedTransaction(payer: PublicKey): string {
  const transaction = new Transaction({ feePayer: payer, recentBlockhash: PublicKey.default.toBase58() });
  transaction.add(SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: 1 }));
  return Buffer.from(transaction.serialize({ requireAllSignatures: false, verifySignatures: false })).toString("base64");
}

function poolScan(overrides: { program?: string; filters?: unknown[]; config?: Record<string, unknown> } = {}) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "getProgramAccounts",
    params: [
      overrides.program ?? METEORA_DBC_PROGRAM_ID,
      {
        encoding: "base64",
        commitment: "confirmed",
        filters: overrides.filters ?? [
          { memcmp: { offset: 0, bytes: VIRTUAL_POOL_DISCRIMINATOR, encoding: "base58" } },
          { memcmp: { offset: 72, bytes: DBC_CONFIG, encoding: "base58" } },
        ],
        ...overrides.config,
      },
    ],
  };
}

function meteoraRuntime(kvStore = kv(), wallet?: Keypair) {
  const env = runtime(kvStore, wallet) as unknown as Record<string, unknown>;
  env.METEORA_DBC_CONFIG = DBC_CONFIG;
  return env as never;
}

describe("proxyRpc", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("blocks anonymous sendTransaction and simulateTransaction", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await proxyRpc(request({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: ["AQ=="] }), runtime());
    expect(response.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("blocks unknown methods", async () => {
    const response = await proxyRpc(request({ jsonrpc: "2.0", id: 1, method: "requestAirdrop", params: [] }), runtime());
    expect(response.status).toBe(403);
  });

  it("forwards an anonymous allowed read and preserves single response shape", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 42 })));
    const response = await proxyRpc(request({ jsonrpc: "2.0", id: 1, method: "getSlot" }), runtime());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 1, result: 42 });
  });

  it("allows a bounded getBlockTime read used by Meteora quotes", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1_790_360_500 })));
    const payload = { jsonrpc: "2.0", id: 1, method: "getBlockTime", params: [350_000_000] };
    const response = await proxyRpc(request(payload), runtime());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 1, result: 1_790_360_500 });
    expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))).toEqual(payload);
  });

  it.each([[], [-1], [1.5], ["350000000"], [Number.MAX_SAFE_INTEGER + 1], [350_000_000, {}]])(
    "rejects invalid getBlockTime slot params %j before forwarding",
    async (...params) => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const response = await proxyRpc(request({ jsonrpc: "2.0", id: 1, method: "getBlockTime", params }), runtime());
      expect(response.status).toBe(403);
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it("forwards normal bounded read calls and their supported configs", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([
        { jsonrpc: "2.0", id: 1, result: { value: [] } },
        { jsonrpc: "2.0", id: 2, result: { value: [null] } },
        { jsonrpc: "2.0", id: 3, result: { value: [] } },
      ])),
    );
    const payload = [
      { jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [[ADDRESS], { encoding: "base64", dataSlice: { offset: 0, length: 32 }, commitment: "confirmed" }] },
      { jsonrpc: "2.0", id: 2, method: "getSignatureStatuses", params: [[SIGNATURE], { searchTransactionHistory: false }] },
      { jsonrpc: "2.0", id: 3, method: "getTokenAccountsByOwner", params: [ADDRESS, { programId: TOKEN_PROGRAM }, { encoding: "jsonParsed", commitment: "confirmed" }] },
    ];

    const response = await proxyRpc(request(payload), runtime());

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))).toEqual(payload);
  });

  it("rejects oversized getMultipleAccounts arrays", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await proxyRpc(request({
      jsonrpc: "2.0",
      id: 1,
      method: "getMultipleAccounts",
      params: [Array.from({ length: 101 }, () => ADDRESS)],
    }), runtime());
    expect(response.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects oversized getSignatureStatuses arrays", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await proxyRpc(request({
      jsonrpc: "2.0",
      id: 1,
      method: "getSignatureStatuses",
      params: [Array.from({ length: 101 }, () => SIGNATURE)],
    }), runtime());
    expect(response.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects transaction history searches for anonymous reads", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await proxyRpc(request({
      jsonrpc: "2.0",
      id: 1,
      method: "getSignatureStatuses",
      params: [[SIGNATURE], { searchTransactionHistory: true }],
    }), runtime());
    expect(response.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects unsupported anonymous read config fields", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await proxyRpc(request({
      jsonrpc: "2.0",
      id: 1,
      method: "getMultipleAccounts",
      params: [[ADDRESS], { commitment: "confirmed", searchTransactionHistory: true }],
    }), runtime());
    expect(response.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("forwards a valid session-bound signed transaction", async () => {
    const wallet = Keypair.generate();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "sig" })));
    const transaction = signedTransaction(wallet);
    const response = await proxyRpc(request({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [transaction, { encoding: "base64" }] }), runtime(kv(), wallet));
    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith("https://devnet.example/rpc", expect.objectContaining({ method: "POST" }));
  });

  it("rejects a transaction paid by a different wallet", async () => {
    const wallet = Keypair.generate();
    const other = Keypair.generate();
    const response = await proxyRpc(request({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [signedTransaction(other)] }), runtime(kv(), wallet));
    expect(response.status).toBe(403);
  });

  it("does not forward a deployed request with a mismatched chain config", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const env = runtime();
    delete (env as unknown as Record<string, unknown>).DIGGO_RPC_URL;
    await expect(proxyRpc(request({ jsonrpc: "2.0", id: 1, method: "getSlot" }), env)).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("simulates an unsigned transaction paid by the session wallet when sigVerify is false", async () => {
    const wallet = Keypair.generate();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: { err: null } } })));
    const options = { encoding: "base64", commitment: "confirmed", sigVerify: false, replaceRecentBlockhash: true };
    const response = await proxyRpc(
      request({ jsonrpc: "2.0", id: 1, method: "simulateTransaction", params: [unsignedTransaction(wallet.publicKey), options] }),
      runtime(kv(), wallet),
    );
    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it.each([
    ["without sigVerify false", { encoding: "base64" }],
    ["with sigVerify true", { encoding: "base64", sigVerify: true }],
    ["with no options", undefined],
  ])("rejects an unsigned simulation %s", async (_label, options) => {
    const wallet = Keypair.generate();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const params = options ? [unsignedTransaction(wallet.publicKey), options] : [unsignedTransaction(wallet.publicKey)];
    const response = await proxyRpc(request({ jsonrpc: "2.0", id: 1, method: "simulateTransaction", params }), runtime(kv(), wallet));
    expect(response.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects unsigned simulations paid by another wallet, anonymous ones, and unsigned sends", async () => {
    const wallet = Keypair.generate();
    const other = Keypair.generate();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const options = { encoding: "base64", sigVerify: false };
    const foreign = await proxyRpc(
      request({ jsonrpc: "2.0", id: 1, method: "simulateTransaction", params: [unsignedTransaction(other.publicKey), options] }),
      runtime(kv(), wallet),
    );
    expect(foreign.status).toBe(403);
    const anonymous = await proxyRpc(
      request({ jsonrpc: "2.0", id: 1, method: "simulateTransaction", params: [unsignedTransaction(wallet.publicKey), options] }),
      runtime(),
    );
    expect(anonymous.status).toBe(401);
    const send = await proxyRpc(
      request({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [unsignedTransaction(wallet.publicKey), { encoding: "base64" }] }),
      runtime(kv(), wallet),
    );
    expect(send.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not let a signed transaction use the relaxed sigVerify false path", async () => {
    const wallet = Keypair.generate();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await proxyRpc(
      request({ jsonrpc: "2.0", id: 1, method: "simulateTransaction", params: [signedTransaction(wallet), { encoding: "base64", sigVerify: false }] }),
      runtime(kv(), wallet),
    );
    expect(response.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("forwards the SDK scan of DBC pools under the published config", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] })));
    const payload = poolScan();
    const response = await proxyRpc(request(payload), meteoraRuntime());
    expect(response.status).toBe(200);
    expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))).toEqual(payload);
  });

  it.each([
    ["another program", poolScan({ program: TOKEN_PROGRAM })],
    ["another config", poolScan({ filters: [
      { memcmp: { offset: 0, bytes: VIRTUAL_POOL_DISCRIMINATOR } },
      { memcmp: { offset: 72, bytes: ADDRESS } },
    ] })],
    ["another account type", poolScan({ filters: [
      { memcmp: { offset: 0, bytes: "11111111111" } },
      { memcmp: { offset: 72, bytes: DBC_CONFIG } },
    ] })],
    ["a missing config filter", poolScan({ filters: [{ memcmp: { offset: 0, bytes: VIRTUAL_POOL_DISCRIMINATOR } }] })],
    ["an extra filter", poolScan({ filters: [
      { memcmp: { offset: 0, bytes: VIRTUAL_POOL_DISCRIMINATOR } },
      { memcmp: { offset: 72, bytes: DBC_CONFIG } },
      { dataSize: 424 },
    ] })],
    ["a dataSize filter", poolScan({ filters: [{ dataSize: 424 }, { memcmp: { offset: 72, bytes: DBC_CONFIG } }] })],
    ["jsonParsed encoding", poolScan({ config: { encoding: "jsonParsed" } })],
    ["a dataSlice", poolScan({ config: { dataSlice: { offset: 0, length: 8 } } })],
  ])("rejects a program account scan with %s", async (_label, payload) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await proxyRpc(request(payload), meteoraRuntime());
    expect(response.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects program account scans when no Meteora config is published", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await proxyRpc(request(poolScan()), runtime());
    expect(response.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
