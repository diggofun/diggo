import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSigner } from "@solana/kit";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";

vi.mock("../onchain/tx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../onchain/tx")>()),
  awaitConfirmation: vi.fn(async () => true),
}));

import { describeSimulationFailure, isBlockhashExpiry, sendMeteoraTransaction } from "./client";

type RpcCall = { method: string; params: unknown[] };

const blockhashes = [Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58()];
let rpcCalls: RpcCall[];
let simulation: { err: unknown; logs: string[] };

function connection() {
  let index = 0;
  return {
    getLatestBlockhash: vi.fn(async () => ({ blockhash: blockhashes[Math.min(index++, 1)], lastValidBlockHeight: 1_000 + index })),
  };
}

/** What Anchor's .transaction() returns: instructions only, no blockhash and no fee payer. */
function sdkTransaction(payer: PublicKey, extra?: PublicKey): Transaction {
  const transaction = new Transaction();
  transaction.add(SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: 1_000 }));
  if (extra) {
    transaction.add(SystemProgram.createAccount({ fromPubkey: payer, newAccountPubkey: extra, lamports: 1_000_000, space: 0, programId: SystemProgram.programId }));
  }
  expect(transaction.recentBlockhash).toBeUndefined();
  expect(transaction.feePayer).toBeUndefined();
  return transaction;
}

function walletConnect(payer: PublicKey, signAndSendTransaction: (tx: Transaction) => Promise<string>) {
  return { kind: "walletconnect" as const, address: payer.toBase58() as never, provider: { signAndSendTransaction } as never };
}

beforeEach(() => {
  rpcCalls = [];
  simulation = { err: null, logs: [] };
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const call = JSON.parse(String(init.body)) as RpcCall;
    rpcCalls.push(call);
    const result = call.method === "simulateTransaction" ? { value: simulation } : "sent-signature";
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
  }));
});

afterEach(() => vi.unstubAllGlobals());

describe("sendMeteoraTransaction", () => {
  it("hands the wallet a transaction with a fresh blockhash, lifetime and fee payer after simulating it", async () => {
    const payer = Keypair.generate().publicKey;
    const seen: Transaction[] = [];
    const wallet = walletConnect(payer, async (tx) => {
      expect(rpcCalls.map((call) => call.method)).toEqual(["simulateTransaction"]);
      seen.push(tx);
      return "wallet-signature";
    });

    const result = await sendMeteoraTransaction(wallet, sdkTransaction(payer), { action: "trade", connection: connection() });

    expect(result).toMatchObject({ signature: "wallet-signature", confirmed: true });
    expect(seen).toHaveLength(1);
    expect(seen[0].recentBlockhash).toBe(blockhashes[0]);
    expect(seen[0].lastValidBlockHeight).toBeGreaterThan(0);
    expect(seen[0].feePayer?.equals(payer)).toBe(true);
    const [, options] = rpcCalls[0].params as [string, Record<string, unknown>];
    expect(options).toMatchObject({ encoding: "base64", sigVerify: false, replaceRecentBlockhash: false });
    const simulated = Transaction.from(Buffer.from(rpcCalls[0].params[0] as string, "base64"));
    expect(simulated.recentBlockhash).toBe(blockhashes[0]);
    expect(simulated.feePayer?.equals(payer)).toBe(true);
  });

  it("never prompts the wallet when the simulation fails and explains why", async () => {
    const payer = Keypair.generate().publicKey;
    const signAndSend = vi.fn(async () => "never");
    simulation = { err: { InstructionError: [0, { Custom: 1 }] }, logs: ["Transfer: insufficient lamports 5, need 1000"] };

    await expect(sendMeteoraTransaction(walletConnect(payer, signAndSend), sdkTransaction(payer), { action: "trade", connection: connection() }))
      .rejects.toThrow("does not have enough SOL for this trade");
    expect(signAndSend).not.toHaveBeenCalled();
  });

  it("rebuilds with a new blockhash and retries once when the first one expired", async () => {
    const payer = Keypair.generate().publicKey;
    const hashes: (string | undefined)[] = [];
    const signAndSend = vi.fn(async (tx: Transaction) => {
      hashes.push(tx.recentBlockhash);
      if (hashes.length === 1) throw new Error("Transaction simulation failed: Blockhash not found");
      return "second-try";
    });

    const result = await sendMeteoraTransaction(walletConnect(payer, signAndSend), sdkTransaction(payer), { action: "trade", connection: connection() });

    expect(result.signature).toBe("second-try");
    expect(hashes).toEqual(blockhashes);
    expect(rpcCalls.filter((call) => call.method === "simulateTransaction")).toHaveLength(2);
  });

  it("stops after one retry with a clear expiry message", async () => {
    const payer = Keypair.generate().publicKey;
    const signAndSend = vi.fn(async () => { throw new Error("block height exceeded"); });

    await expect(sendMeteoraTransaction(walletConnect(payer, signAndSend), sdkTransaction(payer), { action: "trade", connection: connection() }))
      .rejects.toThrow("The trade expired before it was approved");
    expect(signAndSend).toHaveBeenCalledTimes(2);
  });

  it("signs a Wallet Standard launch with both the wallet and the new mint", async () => {
    const signer = await generateKeyPairSigner();
    const payer = new PublicKey(signer.address);
    const mint = Keypair.generate();

    const result = await sendMeteoraTransaction(signer, sdkTransaction(payer, mint.publicKey), {
      action: "launch",
      additionalSigners: [mint],
      connection: connection(),
    });

    const send = rpcCalls.find((call) => call.method === "sendTransaction");
    expect(send).toBeDefined();
    const sent = Transaction.from(Buffer.from(send!.params[0] as string, "base64"));
    expect(sent.recentBlockhash).toBe(blockhashes[0]);
    expect(sent.feePayer?.equals(payer)).toBe(true);
    expect(sent.signatures.map((entry) => entry.publicKey.toBase58()).sort()).toEqual([payer.toBase58(), mint.publicKey.toBase58()].sort());
    expect(sent.verifySignatures()).toBe(true);
    expect(result.confirmed).toBe(true);
  });
});

describe("Meteora transaction error text", () => {
  it("recognizes blockhash expiry in its common forms", () => {
    expect(isBlockhashExpiry("BlockhashNotFound")).toBe(true);
    expect(isBlockhashExpiry(new Error("Signature abc has expired: block height exceeded."))).toBe(true);
    expect(isBlockhashExpiry(new Error("User rejected the request."))).toBe(false);
  });

  it("surfaces the program's own error message from simulation logs", () => {
    expect(describeSimulationFailure("trade", { InstructionError: [2, { Custom: 6006 }] }, ["Program log: AnchorError occurred. Error Code: ExceededSlippage. Error Number: 6006. Error Message: Exceeded slippage tolerance."]))
      .toBe("The trade would fail on-chain: Exceeded slippage tolerance. Nothing was sent.");
  });
});

