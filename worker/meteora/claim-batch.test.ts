/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpcState = vi.hoisted(() => ({
  blockHeight: 100n,
  signatures: [] as Array<{ signature: string; slot: bigint; blockTime: number | null; failed: boolean }>,
  wire: null as string | null,
  historyCalls: 0,
  historyError: null as Error | null,
  confirmationStatus: "finalized" as "processed" | "confirmed" | "finalized" | null,
  statusSlot: 95n,
  statusError: null as unknown,
  transaction: null as Record<string, unknown> | null,
  transactionMeta: null as Record<string, unknown> | null,
  proofError: null as Error | null,
  proofErrorStage: null as "status" | "wire" | "transaction" | null,
  proofCalls: 0,
}));

vi.mock("../chainV2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../chainV2")>();
  return {
    ...actual,
    getChainRpc: () => ({
      getBlockHeight: () => ({ send: async () => rpcState.blockHeight }),
      getSignatureStatuses: () => ({
        send: async () => {
          if (rpcState.proofError && rpcState.proofErrorStage === "status") throw rpcState.proofError;
          return {
            context: { slot: rpcState.statusSlot },
            value: [{
              slot: rpcState.statusSlot,
              confirmations: null,
              err: rpcState.statusError,
              status: rpcState.statusError ? { Err: rpcState.statusError } : { Ok: null },
              confirmationStatus: rpcState.confirmationStatus,
            }],
          };
        },
      }),
      getTransaction: () => ({
        send: async () => {
          rpcState.proofCalls += 1;
          const stage = rpcState.proofCalls === 1 ? "wire" : "transaction";
          if (rpcState.proofError && rpcState.proofErrorStage === stage) throw rpcState.proofError;
          const value = rpcState.transaction ?? (rpcState.wire === null ? null : {
            slot: rpcState.statusSlot,
            blockTime: null,
            meta: rpcState.transactionMeta,
            transaction: {
              signatures: ["signature-placeholder"],
              message: { accountKeys: [], instructions: [] },
            },
          });
          if (stage === "wire") return { slot: rpcState.statusSlot, transaction: value ? [rpcState.wire] : null };
          return value;
        },
      }),
      getLatestBlockhash: () => ({
        send: async () => ({ context: { slot: 100n }, value: { blockhash: bs58.encode(new Uint8Array(32).fill(7)), lastValidBlockHeight: 150n } }),
      }),
    }),
  };
});

vi.mock("./rpc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./rpc")>();
  return {
    ...actual,
    readSignatures: async (_env: unknown, _address: string, _options: { before?: string } = {}) => {
      if (rpcState.historyError) throw rpcState.historyError;
      if (rpcState.historyCalls === 0) {
        rpcState.historyCalls += 1;
        return rpcState.signatures;
      }
      rpcState.historyCalls += 1;
      if (rpcState.signatures.length < 20) return [];
      return Array.from({ length: 20 }, (_, index) => ({
        signature: bs58.encode(Uint8Array.from({ length: 64 }, () => (rpcState.historyCalls + index) % 251)),
        slot: BigInt(200 - index),
        blockTime: null,
        failed: false,
      }));
    },
    readAccount: async () => ({ pubkey: "vault-ata", lamports: 0n, data: new Uint8Array(64) }),
    readTransactionWire: async () => rpcState.wire,
  };
});

import { confirmClaimBatch, loadMiningVaultSigner, prepareClaimBatch } from "./vault";
import { deriveAssociatedTokenAddress } from "./rpc";

type SqlValue = string | number | bigint | null;

class Statement {
  constructor(private readonly db: DatabaseSync, private readonly sql: string, private readonly values: readonly SqlValue[] = []) {}
  bind(...values: unknown[]): Statement {
    return new Statement(this.db, this.sql, values.map((value) => {
      if (value === undefined || value === null) return null;
      return typeof value === "number" && Number.isSafeInteger(value) ? BigInt(value) : value as SqlValue;
    }));
  }
  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...this.values) as T | undefined) ?? null;
  }
  async all<T>(): Promise<{ results: T[]; success: true; meta: { changes: number } }> {
    return { results: this.db.prepare(this.sql).all(...this.values) as T[], success: true, meta: { changes: 0 } };
  }
  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const result = this.db.prepare(this.sql).run(...this.values);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

class D1 {
  constructor(readonly db: DatabaseSync) {}
  prepare(sql: string): Statement { return new Statement(this.db, sql); }
  async batch(statements: readonly Statement[]) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

const WALLET = bs58.encode(new Uint8Array(32).fill(1));
const OTHER_WALLET = bs58.encode(new Uint8Array(32).fill(2));
const MINT = bs58.encode(new Uint8Array(32).fill(3));
const SIGNATURE = bs58.encode(new Uint8Array(64).fill(4));
const WIRE = "stored-prepared-wire";
const DAY = 20_000;
const ITEMS = [{ claimIds: ["claim-1"], mint: MINT, amount: 10n }];

function harness() {
  const db = new DatabaseSync(":memory:");
  const directory = fileURLToPath(new URL("../../migrations/", import.meta.url));
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(directory, file), "utf8"));
  }
  const env = {
    DB: new D1(db),
    DIGGO_RPC_URL: "http://127.0.0.1:8899",
  } as never;
  return { db, env };
}

function seedBatch(db: DatabaseSync, options: { wallet?: string; lastValid?: number; slot?: number } = {}) {
  db.prepare(
    "INSERT INTO meteora_claim_batches (id, wallet, status, items, prepared_transaction, prepared_expires_at, " +
    "prepared_last_valid_block_height, prepared_slot, cap_reserved, day_index, created_at, updated_at) " +
    "VALUES ('base', ?1, 'SENT', ?2, ?3, 1, ?4, ?5, 1, ?6, 1, 1)",
  ).run(options.wallet ?? WALLET, JSON.stringify(ITEMS.map((item) => ({ ...item, amount: item.amount.toString() }))), WIRE, options.lastValid ?? 150, options.slot ?? 90, DAY);
  db.prepare(
    "INSERT INTO meteora_daily_claim_caps (mint, wallet, day_index, reserved, settled, revision) VALUES (?1, ?2, ?3, '10', '0', 0)",
  ).run(MINT, options.wallet ?? WALLET, DAY);
}

describe("claim-all batch security", () => {
  beforeEach(() => {
    rpcState.blockHeight = 100n;
    rpcState.signatures = [];
    rpcState.wire = null;
    rpcState.historyCalls = 0;
    rpcState.historyError = null;
    rpcState.confirmationStatus = "finalized";
    rpcState.statusSlot = 95n;
    rpcState.statusError = null;
    rpcState.transaction = null;
    rpcState.transactionMeta = null;
    rpcState.proofError = null;
    rpcState.proofErrorStage = null;
    rpcState.proofCalls = 0;
  });

  it("returns the identical live envelope after wall-clock expiry", async () => {
    const { db, env } = harness();
    seedBatch(db);
    const result = await prepareClaimBatch({ env, wallet: WALLET, items: ITEMS, batchId: "base" });
    expect(result).toMatchObject({ id: "base", transaction: WIRE, expiresAt: 1 });
    expect((db.prepare("SELECT COUNT(*) AS count FROM meteora_claim_batches").get() as { count: number }).count).toBe(1);
    expect((db.prepare("SELECT reserved FROM meteora_daily_claim_caps").get() as { reserved: string }).reserved).toBe("10");
  });

  it("releases only the expired row's reservation after chain reconciliation and retains an audit successor", async () => {
    const { db, env } = harness();
    seedBatch(db, { lastValid: 99, slot: 90 });
    rpcState.blockHeight = 100n;
    rpcState.signatures = [{ signature: bs58.encode(new Uint8Array(64).fill(6)), slot: 95n, blockTime: null, failed: false }];
    rpcState.wire = "different-transaction";
    // The replacement stops at the missing vault configuration after the audited rollback.
    const envWithoutSigner = { ...(env as Record<string, unknown>), MINING_VAULT_SECRET: undefined } as never;
    await expect(prepareClaimBatch({ env: envWithoutSigner, wallet: WALLET, items: ITEMS, batchId: "base" })).rejects.toThrow("MINING_VAULT_SECRET");
    const old = db.prepare("SELECT * FROM meteora_claim_batches WHERE id='base'").get() as Record<string, unknown>;
    expect(old.status).toBe("FAILED");
    expect(old.cap_reserved).toBe(0);
    expect(old.replacement_id).toMatch(/^base:attempt:/);
    expect((db.prepare("SELECT reserved FROM meteora_daily_claim_caps").get() as { reserved: string }).reserved).toBe("0");
    expect((db.prepare("SELECT COUNT(*) AS count FROM meteora_claim_batches").get() as { count: number }).count).toBe(2);
  });

  it("fails closed when expiry cannot be reconciled", async () => {
    const { db, env } = harness();
    seedBatch(db, { lastValid: 99, slot: 90 });
    rpcState.blockHeight = 100n;
    rpcState.historyError = new Error("history RPC unavailable");
    await expect(prepareClaimBatch({ env, wallet: WALLET, items: ITEMS, batchId: "base" })).rejects.toThrow("history RPC unavailable");
    expect((db.prepare("SELECT status FROM meteora_claim_batches WHERE id='base'").get() as { status: string }).status).toBe("SENT");
    expect((db.prepare("SELECT reserved FROM meteora_daily_claim_caps").get() as { reserved: string }).reserved).toBe("10");
  });

  it("rejects a foreign wallet before any chain or secret access", async () => {
    const { db, env } = harness();
    seedBatch(db);
    await expect(confirmClaimBatch(env, OTHER_WALLET, "base", SIGNATURE)).rejects.toThrow("claim batch not found");
    expect(rpcState.wire).toBeNull();
    expect((db.prepare("SELECT status FROM meteora_claim_batches WHERE id='base'").get() as { status: string }).status).toBe("SENT");
  });

  it("rejects a signature for different wire bytes without mutating the batch", async () => {
    const { db, env } = harness();
    seedBatch(db);
    rpcState.wire = "unrelated-wire";
    await expect(confirmClaimBatch(env, WALLET, "base", SIGNATURE)).rejects.toThrow("does not match the prepared claim transaction");
    const row = db.prepare("SELECT status, signature, cap_reserved FROM meteora_claim_batches WHERE id='base'").get() as Record<string, unknown>;
    expect(row).toMatchObject({ status: "SENT", signature: null, cap_reserved: 1 });
    expect((db.prepare("SELECT reserved, settled FROM meteora_daily_claim_caps").get() as Record<string, string>)).toMatchObject({ reserved: "10", settled: "0" });
  });

  it("keeps a confirmed-only transaction pending without mutating the batch", async () => {
    const { db, env } = harness();
    seedBatch(db);
    rpcState.confirmationStatus = "confirmed";
    rpcState.wire = WIRE;
    expect(await confirmClaimBatch(env, WALLET, "base", SIGNATURE)).toEqual([]);
    expect(rpcState.proofCalls).toBe(0);
    expectBatchPending(db);
  });

  it("keeps an orphaned signature pending without reading or mutating the batch", async () => {
    const { db, env } = harness();
    seedBatch(db);
    rpcState.confirmationStatus = null;
    expect(await confirmClaimBatch(env, WALLET, "base", SIGNATURE)).toEqual([]);
    expect(rpcState.proofCalls).toBe(0);
    expectBatchPending(db);
  });

  it("fails closed when finality RPC lookup fails without mutating the batch", async () => {
    const { db, env } = harness();
    seedBatch(db);
    rpcState.proofError = new Error("finality RPC unavailable");
    rpcState.proofErrorStage = "status";
    await expect(confirmClaimBatch(env, WALLET, "base", SIGNATURE)).rejects.toThrow("finality RPC unavailable");
    expectBatchPending(db);
  });

  it("settles only after finalized wire and transfer effects match, then replays idempotently", async () => {
    const { db, env } = harness();
    const vaultPrivateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 9);
    const vaultSecretBytes = new Uint8Array([...vaultPrivateKey, ...ed25519.getPublicKey(vaultPrivateKey)]);
    const vaultSecret = bs58.encode(vaultSecretBytes);
    const configuredEnv = { ...(env as Record<string, unknown>), MINING_VAULT_SECRET: vaultSecret } as never;
    const signer = await loadMiningVaultSigner(configuredEnv);
    seedBatch(db);
    const vault = signer.address;
    const source = deriveAssociatedTokenAddress(MINT, vault);
    const destination = deriveAssociatedTokenAddress(MINT, WALLET);
    const systemProgram = "11111111111111111111111111111111";
    const tokenProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    const associatedTokenProgram = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
    rpcState.wire = WIRE;
    rpcState.transactionMeta = {
      err: null,
      logMessages: [],
      innerInstructions: [],
      preTokenBalances: [
        { accountIndex: 1, mint: MINT, owner: vault, uiTokenAmount: { amount: "20" } },
        { accountIndex: 2, mint: MINT, owner: WALLET, uiTokenAmount: { amount: "5" } },
      ],
      postTokenBalances: [
        { accountIndex: 1, mint: MINT, owner: vault, uiTokenAmount: { amount: "10" } },
        { accountIndex: 2, mint: MINT, owner: WALLET, uiTokenAmount: { amount: "15" } },
      ],
    };
    rpcState.transaction = {
      slot: rpcState.statusSlot,
      blockTime: null,
      meta: rpcState.transactionMeta,
      transaction: {
        signatures: [SIGNATURE, bs58.encode(Uint8Array.from({ length: 64 }, () => 8))],
        message: {
          accountKeys: [WALLET, source, destination, vault, MINT, systemProgram, tokenProgram],
          instructions: [
            {
              programId: associatedTokenProgram,
              accounts: [WALLET, destination, WALLET, MINT, systemProgram, tokenProgram],
              data: bs58.encode(Uint8Array.of(1)),
            },
            {
              programId: tokenProgram,
              accounts: [source, MINT, destination, vault],
              data: bs58.encode(Uint8Array.of(12, 10, 0, 0, 0, 0, 0, 0, 0, 9)),
            },
          ],
        },
      },
    };

    expect(await confirmClaimBatch(configuredEnv, WALLET, "base", SIGNATURE)).toEqual(ITEMS);
    const settled = db.prepare("SELECT status, signature, cap_reserved FROM meteora_claim_batches WHERE id='base'").get() as Record<string, unknown>;
    expect(settled).toMatchObject({ status: "SETTLED", signature: SIGNATURE, cap_reserved: 0 });
    expect(db.prepare("SELECT reserved, settled FROM meteora_daily_claim_caps").get()).toMatchObject({ reserved: "10", settled: "10" });

    const proofCallsAfterFirstConfirmation = rpcState.proofCalls;
    expect(await confirmClaimBatch(configuredEnv, WALLET, "base", SIGNATURE)).toEqual(ITEMS);
    expect(rpcState.proofCalls).toBe(proofCallsAfterFirstConfirmation);
  });

  it("keeps a finalized transaction pending when its transfer effects do not match", async () => {
    const { db, env } = harness();
    const vaultPrivateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 9);
    const vaultSecretBytes = new Uint8Array([...vaultPrivateKey, ...ed25519.getPublicKey(vaultPrivateKey)]);
    const vaultSecret = bs58.encode(vaultSecretBytes);
    const configuredEnv = { ...(env as Record<string, unknown>), MINING_VAULT_SECRET: vaultSecret } as never;
    const signer = await loadMiningVaultSigner(configuredEnv);
    seedBatch(db);
    const vault = signer.address;
    const source = deriveAssociatedTokenAddress(MINT, vault);
    const destination = deriveAssociatedTokenAddress(MINT, WALLET);
    const systemProgram = "11111111111111111111111111111111";
    const tokenProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    const associatedTokenProgram = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
    rpcState.wire = WIRE;
    rpcState.transactionMeta = {
      err: null,
      preTokenBalances: [
        { accountIndex: 1, mint: MINT, owner: vault, uiTokenAmount: { amount: "20" } },
        { accountIndex: 2, mint: MINT, owner: WALLET, uiTokenAmount: { amount: "5" } },
      ],
      postTokenBalances: [
        { accountIndex: 1, mint: MINT, owner: vault, uiTokenAmount: { amount: "11" } },
        { accountIndex: 2, mint: MINT, owner: WALLET, uiTokenAmount: { amount: "14" } },
      ],
    };
    rpcState.transaction = {
      slot: rpcState.statusSlot,
      meta: rpcState.transactionMeta,
      transaction: {
        signatures: [SIGNATURE, bs58.encode(Uint8Array.from({ length: 64 }, () => 8))],
        message: {
          accountKeys: [WALLET, source, destination, vault, MINT, systemProgram, tokenProgram],
          instructions: [
            { programId: associatedTokenProgram, accounts: [WALLET, destination, WALLET, MINT, systemProgram, tokenProgram], data: bs58.encode(Uint8Array.of(1)) },
            { programId: tokenProgram, accounts: [source, MINT, destination, vault], data: bs58.encode(Uint8Array.of(12, 10, 0, 0, 0, 0, 0, 0, 0, 9)) },
          ],
        },
      },
    };

    expect(await confirmClaimBatch(configuredEnv, WALLET, "base", SIGNATURE)).toEqual([]);
    expectBatchPending(db);
  });
});

function expectBatchPending(db: DatabaseSync): void {
  const row = db.prepare("SELECT status, signature, cap_reserved FROM meteora_claim_batches WHERE id='base'").get() as Record<string, unknown>;
  expect(row).toMatchObject({ status: "SENT", signature: null, cap_reserved: 1 });
  expect(db.prepare("SELECT reserved, settled FROM meteora_daily_claim_caps").get()).toMatchObject({ reserved: "10", settled: "0" });
}
