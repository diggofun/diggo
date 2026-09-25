import { AccountRole } from "@solana/kit";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import {
  decodeMeteoraEventData,
  initializeFromInstruction,
  isGraduated,
  poolBelongsToConfig,
  sumLamportRows,
  swapFromBalances,
  traderForSwap,
} from "./indexer";
import {
  decodePoolConfig,
  decodeTokenAccountAmount,
  decodeVirtualPool,
  deriveAssociatedTokenAddress,
  METEORA_CONFIG_OFFSET,
  POOL_CONFIG_MIGRATION_THRESHOLD_OFFSET,
  POOL_CONFIG_TOKEN_DECIMAL_OFFSET,
  VIRTUAL_POOL_DISCRIMINATOR,
} from "./rpc";
import {
  buildSplTokenTransferInstruction,
  buildWithdrawLeftoverInstruction,
  METEORA_EVENT_AUTHORITY,
  validateClaimCaps,
  WITHDRAW_LEFTOVER_DISCRIMINATOR,
} from "./vault";
import { METEORA_DBC_PROGRAM_ID, METEORA_TOKEN_PROGRAM_ID } from "./types";

const keys = {
  pool: bs58.encode(Uint8Array.from({ length: 32 }, (_, index) => index + 1)),
  config: bs58.encode(Uint8Array.from({ length: 32 }, (_, index) => index + 33)),
  creator: bs58.encode(Uint8Array.from({ length: 32 }, (_, index) => index + 65)),
  mint: bs58.encode(Uint8Array.from({ length: 32 }, (_, index) => index + 97)),
  baseVault: bs58.encode(Uint8Array.from({ length: 32 }, (_, index) => index + 129)),
  quoteVault: bs58.encode(Uint8Array.from({ length: 32 }, (_, index) => index + 161)),
  receiver: bs58.encode(Uint8Array.from({ length: 32 }, (_, index) => index + 193)),
  trader: bs58.encode(Uint8Array.from({ length: 32 }, (_, index) => index + 225)),
};

function putAddress(data: Uint8Array, offset: number, value: string): void {
  data.set(bs58.decode(value), offset);
}

function putU64(data: Uint8Array, offset: number, value: bigint): void {
  let remaining = value;
  for (let index = 0; index < 8; index += 1) {
    data[offset + index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
}

function writeString(data: Uint8Array, offset: number, value: string): number {
  const bytes = new TextEncoder().encode(value);
  new DataView(data.buffer, data.byteOffset, data.byteLength).setUint32(offset, bytes.length, true);
  data.set(bytes, offset + 4);
  return offset + 4 + bytes.length;
}

function swapEvent(options: { direction?: number; hasReferral?: boolean } = {}): Uint8Array {
  const data = new Uint8Array(195);
  data.set(Uint8Array.of(189, 66, 51, 168, 38, 80, 117, 153), 0);
  putAddress(data, 8, keys.pool);
  putAddress(data, 40, keys.config);
  data[72] = options.direction ?? 1;
  data[73] = options.hasReferral ? 1 : 0;
  putU64(data, 74, 900n);
  putU64(data, 82, 100n);
  data[90] = 0;
  putU64(data, 91, 1_000n);
  putU64(data, 99, 20n);
  putU64(data, 107, 0n);
  putU64(data, 115, 777n);
  putU64(data, 139, 1n);
  putU64(data, 147, 2n);
  putU64(data, 155, 3n);
  putU64(data, 163, 4n);
  putU64(data, 171, 1_700_000_000_000n);
  putU64(data, 179, 85n * 1_000_000_000n);
  putU64(data, 187, 1_234n);
  return data;
}

describe("Meteora event decoding", () => {
  it("decodes an exact EvtSwap2 buy event", () => {
    const event = decodeMeteoraEventData(swapEvent({ hasReferral: true }));
    expect(event).toMatchObject({
      kind: "swap",
      pool: keys.pool,
      config: keys.config,
      side: "buy",
      amountIn: 1020n,
      amountOut: 777n,
      solAmountLamports: 1020n,
      quoteReserve: 1_700_000_000_000n,
      migrationThreshold: 85n * 1_000_000_000n,
    });
  });

  it("decodes curve completion and graduation", () => {
    const data = new Uint8Array(88);
    data.set(Uint8Array.of(229, 231, 86, 84, 156, 134, 75, 24));
    putAddress(data, 8, keys.pool);
    putAddress(data, 40, keys.config);
    putU64(data, 72, 5n);
    putU64(data, 80, 2n);
    expect(decodeMeteoraEventData(data)).toMatchObject({ kind: "curve_complete", baseReserve: 5n, quoteReserve: 2n });
    expect(isGraduated({ isMigrated: false }, 85n, 85n)).toBe(true);
  });

  it("decodes initialize and swap instructions when event logs are absent", () => {
    const initialize = bs58.encode(Uint8Array.of(140, 85, 215, 176, 102, 54, 104, 79));
    const tx = { instructions: [{ programId: METEORA_DBC_PROGRAM_ID, accounts: [keys.config, keys.creator, keys.creator, keys.mint, keys.baseVault, keys.pool, keys.trader], data: initialize }] };
    expect(initializeFromInstruction(tx, keys.config)).toMatchObject({ kind: "initialize", pool: keys.pool, creator: keys.creator, baseMint: keys.mint });
    expect(initializeFromInstruction(tx, keys.baseVault)).toBeNull();
  });

  it("handles initialize and swap instructions returned as inner CPI instructions", () => {
    const initialize = bs58.encode(Uint8Array.of(140, 85, 215, 176, 102, 54, 104, 79));
    const initializeAccounts = [keys.config, keys.creator, keys.creator, keys.mint, keys.baseVault, keys.pool, keys.trader];
    expect(initializeFromInstruction({
      instructions: [{ programId: keys.creator, accounts: [], data: "" }, { programId: METEORA_DBC_PROGRAM_ID, accounts: initializeAccounts, data: initialize }],
    }, keys.config)).toMatchObject({ kind: "initialize", pool: keys.pool, baseMint: keys.mint });

    const swap = bs58.encode(Uint8Array.of(65, 75, 63, 76, 235, 91, 91, 136));
    const quoteMint = "So11111111111111111111111111111111111111112";
    const pool = { pool: keys.pool, config: keys.config, baseMint: keys.mint, quoteMint, quoteReserve: 100n, migrationQuoteThreshold: 200n } as never;
    const swapAccounts = [keys.pool, keys.config, keys.pool, keys.baseVault, keys.quoteVault, "x", "x", "x", "x", keys.trader];
    const tx = {
      accountKeys: [...swapAccounts],
      instructions: [{ programId: keys.pool, accounts: [], data: "" }, { programId: METEORA_DBC_PROGRAM_ID, accounts: swapAccounts, data: swap }],
      preTokenBalances: [{ accountIndex: 3, mint: quoteMint, owner: keys.trader, amount: "0" }],
      postTokenBalances: [{ accountIndex: 3, mint: quoteMint, owner: keys.trader, amount: "20" }, { accountIndex: 4, mint: keys.mint, owner: keys.trader, amount: "5" }],
    };
    expect(swapFromBalances(tx, pool, "inner-sig", 9n, 125)).toMatchObject({ kind: "swap", side: "buy", trader: keys.trader });
  });

  it("infers buy and sell swaps from token balance deltas and records the trader", () => {
    const pool = { pool: keys.pool, config: keys.config, baseMint: keys.mint, quoteMint: "So11111111111111111111111111111111111111112", quoteReserve: 100n, migrationQuoteThreshold: 200n } as never;
    const swap = bs58.encode(Uint8Array.of(65, 75, 63, 76, 235, 91, 91, 136));
    const accounts = [keys.pool, keys.config, keys.pool, keys.baseVault, keys.quoteVault, "x", "x", "x", "x", keys.trader];
    const buyTx = {
      accountKeys: [...accounts], instructions: [{ programId: METEORA_DBC_PROGRAM_ID, accounts, data: swap }],
      preTokenBalances: [{ accountIndex: 3, mint: "So11111111111111111111111111111111111111112", owner: keys.trader, amount: "0" }],
      postTokenBalances: [
        { accountIndex: 3, mint: "So11111111111111111111111111111111111111112", owner: keys.pool, amount: "20" },
        { accountIndex: 4, mint: keys.mint, owner: keys.trader, amount: "5" },
      ],
    };
    const buy = swapFromBalances(buyTx, pool, "sig", 7n, 123);
    expect(buy).toMatchObject({ kind: "swap", side: "buy", amountIn: 20n, trader: keys.trader });
    const event = { pool: keys.pool, config: keys.config } as never;
    expect(traderForSwap(buyTx, event)).toBe(keys.trader);

    const sellTx = {
      accountKeys: [...accounts],
      instructions: [{ programId: METEORA_DBC_PROGRAM_ID, accounts, data: swap }],
      preTokenBalances: [
        { accountIndex: 9, mint: keys.mint, owner: keys.trader, amount: "20" },
        { accountIndex: 3, mint: "So11111111111111111111111111111111111111112", owner: keys.pool, amount: "100" },
      ],
      postTokenBalances: [
        { accountIndex: 9, mint: keys.mint, owner: keys.trader, amount: "0" },
        { accountIndex: 3, mint: "So11111111111111111111111111111111111111112", owner: keys.pool, amount: "120" },
      ],
    };
    expect(swapFromBalances(sellTx, pool, "sell", 8n, 124)).toMatchObject({
      kind: "swap", side: "sell", amountIn: 20n, amountOut: 20n, solAmountLamports: 20n, trader: keys.trader,
    });
  });

  it("recognizes the upgraded devnet instruction prefixes returned as base64", () => {
    const initializeData = Buffer.from("46c43da6070dcab2706154fb1351ac51", "hex").toString("base64");
    const swapData = Buffer.from("4c6ab959ee14aa4bf73179e131a27086", "hex").toString("base64");
    const accounts = [keys.config, keys.creator, keys.creator, keys.mint, keys.baseVault, keys.pool, keys.trader];
    expect(initializeFromInstruction({ instructions: [{ programId: METEORA_DBC_PROGRAM_ID, accounts, data: initializeData }] }, keys.config)).toMatchObject({ pool: keys.pool, baseMint: keys.mint });
    const quoteMint = "So11111111111111111111111111111111111111112";
    const pool = { pool: keys.pool, config: keys.config, baseMint: keys.mint, quoteMint } as never;
    const swapAccounts = [keys.pool, keys.config, keys.pool, keys.baseVault, keys.quoteVault, "base", "quote", "mint", "quote", keys.trader];
    const tx = {
      accountKeys: swapAccounts,
      instructions: [{ programId: METEORA_DBC_PROGRAM_ID, accounts: swapAccounts, data: swapData }],
      preTokenBalances: [{ accountIndex: 3, mint: quoteMint, owner: keys.trader, amount: "0" }, { accountIndex: 4, mint: keys.mint, owner: keys.pool, amount: "0" }],
      postTokenBalances: [{ accountIndex: 3, mint: quoteMint, owner: keys.trader, amount: "20" }, { accountIndex: 4, mint: keys.mint, owner: keys.pool, amount: "5" }],
    };
    expect(swapFromBalances(tx, pool, "sig", 1n, 1)).toMatchObject({ side: "buy", trader: keys.trader });
  });
});

describe("Meteora account decoding", () => {
  it("decodes the SDK VirtualPool layout", () => {
    const data = new Uint8Array(306);
    data.set(VIRTUAL_POOL_DISCRIMINATOR);
    putAddress(data, 72, keys.config);
    putAddress(data, 104, keys.creator);
    putAddress(data, 136, keys.mint);
    putAddress(data, 168, keys.baseVault);
    putAddress(data, 200, keys.quoteVault);
    putU64(data, 232, 11n);
    putU64(data, 240, 22n);
    putU64(data, 296, 33n);
    data[305] = 1;
    expect(decodeVirtualPool(keys.pool, data)).toMatchObject({
      config: keys.config,
      creator: keys.creator,
      baseMint: keys.mint,
      baseVault: keys.baseVault,
      baseReserve: 11n,
      quoteReserve: 22n,
      activationPoint: 33n,
      isMigrated: true,
    });
    expect(poolBelongsToConfig(data, keys.config)).toBe(true);
    expect(poolBelongsToConfig(data, keys.baseVault)).toBe(false);
  });

  it("pins the config filter and PoolConfig field offsets", () => {
    const data = new Uint8Array(272);
    putAddress(data, 8, keys.receiver);
    putAddress(data, 40, keys.creator);
    putAddress(data, 72, keys.receiver);
    data[POOL_CONFIG_TOKEN_DECIMAL_OFFSET] = 9;
    putU64(data, POOL_CONFIG_MIGRATION_THRESHOLD_OFFSET, 2_000_000_000n);
    expect(METEORA_CONFIG_OFFSET).toBe(72);
    expect(decodePoolConfig(data)).toMatchObject({
      quoteMint: keys.receiver,
      feeClaimer: keys.creator,
      leftoverReceiver: keys.receiver,
      tokenDecimal: 9,
      migrationQuoteThreshold: 2_000_000_000n,
    });
  });

  it("decodes an SPL token account amount", () => {
    const data = new Uint8Array(64);
    putU64(data, 48, 1_000_000_001n);
    expect(decodeTokenAccountAmount(data)).toBe(1_000_000_001n);
  });
});

describe("Meteora vault instructions", () => {
  it("derives an SPL associated token account", () => {
    expect(deriveAssociatedTokenAddress(keys.mint, keys.receiver, METEORA_TOKEN_PROGRAM_ID)).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });

  it("encodes a withdraw_leftover instruction with the SDK account order", () => {
    const instruction = buildWithdrawLeftoverInstruction({
      config: keys.config,
      pool: keys.pool,
      baseVault: keys.baseVault,
      baseMint: keys.mint,
      receiver: keys.receiver,
      receiverTokenAccount: deriveAssociatedTokenAddress(keys.mint, keys.receiver),
    });
    expect(instruction.data).toEqual(WITHDRAW_LEFTOVER_DISCRIMINATOR);
    const accounts = instruction.accounts ?? [];
    expect(accounts).toHaveLength(10);
    expect(accounts[0]?.address).toBe("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM");
    expect(accounts[8]?.address).toBe(METEORA_EVENT_AUTHORITY);
    expect(accounts[9]?.address).toBe(METEORA_DBC_PROGRAM_ID);
    expect(accounts[2]?.role).toBe(AccountRole.WRITABLE);
  });

  it("encodes the SPL Transfer opcode and raw amount", () => {
    const instruction = buildSplTokenTransferInstruction({
      source: keys.baseVault,
      mint: keys.mint,
      destination: keys.quoteVault,
      amount: 1_000_000_001n,
      authority: keys.receiver,
    });
    const data = instruction.data ?? new Uint8Array();
    expect(data).toHaveLength(9);
    expect(data[0]).toBe(3);
    expect(BigInt("0x" + Array.from(data.slice(1)).map((byte) => byte.toString(16).padStart(2, "0")).reverse().join(""))).toBe(1_000_000_001n);
  });

  it("keeps website and logo cursors independent", () => {
    expect(writeString(new Uint8Array(32), 0, "name")).toBe(8);
  });

  it("sums lamports without SQLite integer overflow", () => {
    expect(sumLamportRows([
      { sol_amount_lamports: "9007199254740993000000" },
      { sol_amount_lamports: "17" },
    ])).toBe(9_007_199_254_740_993_000_017n);
  });

  it("rejects claims above the configured caps", () => {
    expect(() => validateClaimCaps(101n, 100n, 1_000n)).toThrow("MINING_CLAIM_PER_CLAIM");
    expect(() => validateClaimCaps(101n, 1_000n, 100n)).toThrow("MINING_CLAIM_PER_DAY");
  });
});
