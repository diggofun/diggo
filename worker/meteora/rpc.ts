import {
  AccountRole,
  address,
  type Instruction,
} from "@solana/kit";
import bs58 from "bs58";
import { getChainRpc, type ChainEnv } from "../chainV2";
import { findProgramAddressSync, seedAddress } from "../../shared/pdas";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  METEORA_DBC_PROGRAM_ID,
  METEORA_TOKEN_PROGRAM_ID,
  type MeteoraPoolRecord,
  type MeteoraRpcEnv,
} from "./types";

export const METEORA_CONFIG_OFFSET = 72;
export const VIRTUAL_POOL_DISCRIMINATOR = Uint8Array.of(213, 224, 5, 209, 98, 69, 119, 92);
export const TRANSFER_HOOK_POOL_DISCRIMINATOR = Uint8Array.of(237, 219, 184, 23, 42, 189, 169, 35);
// PoolConfig is a fixed-layout bytemuck account. These offsets include the
// Anchor discriminator and the complete fee/vesting/padding prefix.
export const POOL_CONFIG_TOKEN_DECIMAL_OFFSET = 236;
export const POOL_CONFIG_MIGRATION_THRESHOLD_OFFSET = 264;

export interface MeteoraRpcAccount {
  pubkey: string;
  lamports: bigint;
  data: Uint8Array;
  owner?: string;
}

export interface MeteoraSignatureInfo {
  signature: string;
  slot: bigint;
  blockTime: number | null;
  failed: boolean;
}

export interface MeteoraTransaction {
  signature: string;
  slot: bigint;
  blockTime: number | null;
  failed: boolean;
  accountKeys: string[];
  signatures: string[];
  instructions: { programId: string; accounts: string[]; data: string }[];
  /** Top-level message instructions, before inner CPI instructions are appended. */
  topLevelInstructions?: { programId: string; accounts: string[]; data: string }[];
  logs: string[];
  preTokenBalances: { accountIndex: number; mint: string; owner: string | null; amount: string }[];
  postTokenBalances: { accountIndex: number; mint: string; owner: string | null; amount: string }[];
}

function wireBase64(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
}

function requireString(value: unknown, name: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${name} is required`);
  return text;
}

function rpcNumber(value: unknown): number | null {
  const number = typeof value === "bigint" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : null;
}

export function meteoraRpcEnv(env: MeteoraRpcEnv): ChainEnv {
  const primary = typeof env.DIGGO_RPC_URL === "string" ? env.DIGGO_RPC_URL.trim() : "";
  const fallbacks = typeof env.DIGGO_RPC_URLS === "string" ? env.DIGGO_RPC_URLS.trim() : "";
  if (!primary && !fallbacks) throw new Error("DIGGO_RPC_URL or DIGGO_RPC_URLS is required");
  return {
    ...env,
    DIGGO_RPC_URL: primary || requireString(fallbacks.split(/[\s,]+/)[0], "DIGGO_RPC_URLS"),
  };
}

function accountData(value: unknown): Uint8Array {
  if (typeof value === "string") return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  if (Array.isArray(value) && typeof value[0] === "string") {
    return Uint8Array.from(atob(value[0]), (c) => c.charCodeAt(0));
  }
  if (value instanceof Uint8Array) return value;
  throw new Error("RPC account data is missing");
}

function readU64(data: Uint8Array, offset: number): bigint {
  if (offset + 8 > data.length) throw new Error("truncated u64");
  let value = 0n;
  for (let i = 7; i >= 0; i -= 1) value = (value << 8n) | BigInt(data[offset + i]);
  return value;
}

function readAddress(data: Uint8Array, offset: number): string {
  if (offset + 32 > data.length) throw new Error("truncated pubkey");
  return bs58.encode(data.subarray(offset, offset + 32));
}

export function decodeVirtualPool(addressValue: string, data: Uint8Array): MeteoraPoolRecord {
  if (data.length < 306) throw new Error("truncated VirtualPool account");
  const base = 8 + 64;
  const creator = readAddress(data, base + 32);
  const baseMint = readAddress(data, base + 64);
  const baseVault = readAddress(data, base + 96);
  const baseReserve = readU64(data, base + 160);
  const quoteReserve = readU64(data, base + 168);
  const activationPoint = readU64(data, base + 224);
  const isMigrated = data[base + 233] === 1;
  return {
    pool: addressValue,
    config: readAddress(data, base),
    creator,
    baseMint,
    baseVault,
    quoteMint: "So11111111111111111111111111111111111111112",
    name: null,
    symbol: null,
    uri: null,
    decimals: 9,
    activationPoint,
    baseReserve,
    quoteReserve,
    migrationQuoteThreshold: 0n,
    isGraduated: false,
    isMigrated,
  };
}

export function decodeTokenMint(data: Uint8Array): { decimals: number; owner: string | null } {
  const owner = data.length >= 78 ? readAddress(data, 46) : null;
  return { decimals: data.length >= 45 ? data[44] : 9, owner };
}

export function decodeTokenAccountAmount(data: Uint8Array): bigint {
  if (data.length < 64) throw new Error("truncated SPL token account");
  return readU64(data, 48);
}

export async function readProgramAccounts(
  env: MeteoraRpcEnv,
  options: { program?: string; memcmpOffset?: number; memcmpBytes?: Uint8Array } = {},
): Promise<MeteoraRpcAccount[]> {
  const program = options.program ?? METEORA_DBC_PROGRAM_ID;
  const memcmp = options.memcmpOffset === undefined || !options.memcmpBytes
    ? undefined
    : { offset: options.memcmpOffset, bytes: bs58.encode(options.memcmpBytes) };
  const response = await getChainRpc(meteoraRpcEnv(env)).getProgramAccounts(address(program) as never, {
    commitment: "confirmed",
    encoding: "base64",
    filters: memcmp ? [{ memcmp }] : [],
  } as never).send();
  const entries = (response as { value?: unknown[] }).value ?? [];
  return entries.map((item) => {
    const entry = item as { pubkey: string; account: { lamports: number | bigint; data: unknown; owner?: string } };
    return {
      pubkey: entry.pubkey,
      lamports: BigInt(entry.account.lamports),
      data: accountData(entry.account.data),
      owner: entry.account.owner,
    };
  });
}

export async function readAccount(env: MeteoraRpcEnv, account: string): Promise<MeteoraRpcAccount | null> {
  const response = await getChainRpc(meteoraRpcEnv(env)).getAccountInfo(address(account) as never, {
    commitment: "confirmed",
    encoding: "base64",
  } as never).send();
  const value = (response as unknown as { value?: { lamports: number | bigint; data: unknown; owner?: string } }).value;
  if (!value) return null;
  return { pubkey: account, lamports: BigInt(value.lamports), data: accountData(value.data), owner: value.owner };
}

export async function readMint(env: MeteoraRpcEnv, mint: string) {
  const account = await readAccount(env, mint);
  if (!account) return null;
  return { ...decodeTokenMint(account.data), mint, account: account.pubkey };
}

export async function readPoolMetadata(env: MeteoraRpcEnv, pool: string): Promise<{ name: string | null; symbol: string | null; uri: string | null }> {
  const metadataAddress = findProgramAddressSync(
    [new TextEncoder().encode("virtual_pool_metadata"), seedAddress(address(pool))],
    address(METEORA_DBC_PROGRAM_ID),
  );
  const account = await readAccount(env, metadataAddress);
  if (!account || account.data.length < 136) return { name: null, symbol: null, uri: null };
  const view = new DataView(account.data.buffer, account.data.byteOffset, account.data.byteLength);
  const readString = (offset: number): { value: string; next: number } | null => {
    if (offset + 4 > account.data.length) return null;
    const length = view.getUint32(offset, true);
    const start = offset + 4;
    if (start + length > account.data.length) return null;
    return {
      value: new TextDecoder().decode(account.data.subarray(start, start + length)),
      next: start + length,
    };
  };
  const name = readString(136);
  const website = name === null ? null : readString(name.next);
  const logo = website === null ? null : readString(website.next);
  return { name: name?.value ?? null, symbol: null, uri: logo?.value ?? website?.value ?? null };
}

export async function readSignatures(
  env: MeteoraRpcEnv,
  pool: string,
  options: { limit?: number; before?: string; until?: string } = {},
): Promise<MeteoraSignatureInfo[]> {
  const response = await getChainRpc(meteoraRpcEnv(env)).getSignaturesForAddress(address(pool) as never, {
    commitment: "confirmed",
    limit: options.limit ?? 100,
    ...(options.before ? { before: options.before as never } : {}),
    ...(options.until ? { until: options.until as never } : {}),
  } as never).send();
  const entries = Array.isArray(response)
    ? response
    : (response as unknown as { value?: unknown[] }).value ?? [];
  return entries.map((item) => {
    const entry = item as { signature: string; slot: number | bigint; blockTime?: number | null; err?: unknown };
    return { signature: entry.signature, slot: BigInt(entry.slot), blockTime: rpcNumber(entry.blockTime), failed: Boolean(entry.err) };
  });
}

export async function readTransaction(env: MeteoraRpcEnv, signature: string): Promise<MeteoraTransaction | null> {
  const response = await getChainRpc(meteoraRpcEnv(env)).getTransaction(signature as never, {
    commitment: "confirmed",
    encoding: "json",
    maxSupportedTransactionVersion: 0,
  } as never).send();
  const value = response as unknown as {
    slot: number | bigint;
    blockTime?: number | null;
    meta?: {
      err?: unknown;
      logMessages?: string[] | null;
      innerInstructions?: Array<{ instructions?: unknown[] }> | null;
      preTokenBalances?: Array<{ accountIndex?: unknown; mint?: unknown; owner?: unknown; uiTokenAmount?: { amount?: unknown } }> | null;
      postTokenBalances?: Array<{ accountIndex?: unknown; mint?: unknown; owner?: unknown; uiTokenAmount?: { amount?: unknown } }> | null;
    } | null;
    transaction?: { signatures?: string[]; message?: { accountKeys?: Array<string | { pubkey: string }>; instructions?: unknown[] } };
  } | null;
  if (!value) return null;
  const keys = value.transaction?.message?.accountKeys ?? [];
  const topLevel = value.transaction?.message?.instructions ?? [];
  const inner = (value.meta?.innerInstructions ?? []).flatMap((group) => group.instructions ?? []);
  const accountAt = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (typeof value === "number" && value >= 0 && value < keys.length) {
      const key = keys[value];
      return typeof key === "string" ? key : key.pubkey;
    }
    if (value && typeof value === "object" && "pubkey" in value) {
      const pubkey = (value as { pubkey?: unknown }).pubkey;
      return typeof pubkey === "string" ? pubkey : "";
    }
    return "";
  };
  const instructions = [...topLevel, ...inner]
    .map((raw) => {
      const instruction = raw as { programId?: unknown; programIdIndex?: unknown; program?: unknown; accounts?: unknown[]; data?: string };
      return {
        programId: accountAt(instruction.programId ?? instruction.programIdIndex ?? instruction.program),
        accounts: (instruction.accounts ?? []).map(accountAt),
        data: instruction.data ?? "",
      };
    });
  type RpcTokenBalance = { accountIndex?: unknown; mint?: unknown; owner?: unknown; uiTokenAmount?: { amount?: unknown } };
  const tokenBalances = (rows: RpcTokenBalance[] | null | undefined): MeteoraTransaction["preTokenBalances"] => (rows ?? []).flatMap((row) => {
    if (typeof row.accountIndex !== "number" || typeof row.mint !== "string" || typeof row.uiTokenAmount?.amount !== "string") return [];
    return [{
      accountIndex: row.accountIndex,
      mint: row.mint,
      owner: typeof row.owner === "string" && row.owner ? row.owner : null,
      amount: row.uiTokenAmount.amount,
    }];
  });
  return {
    signature,
    slot: BigInt(value.slot),
    blockTime: rpcNumber(value.blockTime),
    failed: Boolean(value.meta?.err),
    accountKeys: keys.map((key) => typeof key === "string" ? key : key.pubkey),
    signatures: value.transaction?.signatures ?? [],
    instructions,
    topLevelInstructions: instructions.slice(0, topLevel.length),
    logs: value.meta?.logMessages ?? [],
    preTokenBalances: tokenBalances(value.meta?.preTokenBalances),
    postTokenBalances: tokenBalances(value.meta?.postTokenBalances),
  };
}

/** Reads the canonical wire bytes used to prove a reported signature came from our prepared transaction. */
export async function readTransactionWire(env: MeteoraRpcEnv, signature: string): Promise<string | null> {
  const response = await getChainRpc(meteoraRpcEnv(env)).getTransaction(signature as never, {
    commitment: "confirmed",
    encoding: "base64",
    maxSupportedTransactionVersion: 0,
  } as never).send();
  const value = response as unknown as { transaction?: unknown } | null;
  return value ? wireBase64(value.transaction) : null;
}

export function decodePoolConfig(data: Uint8Array): { quoteMint: string; feeClaimer: string; leftoverReceiver: string; tokenDecimal: number; migrationQuoteThreshold: bigint } {
  if (data.length < POOL_CONFIG_MIGRATION_THRESHOLD_OFFSET + 8) throw new Error("truncated PoolConfig account");
  return {
    quoteMint: readAddress(data, 8),
    feeClaimer: readAddress(data, 40),
    leftoverReceiver: readAddress(data, 72),
    tokenDecimal: data[POOL_CONFIG_TOKEN_DECIMAL_OFFSET],
    migrationQuoteThreshold: readU64(data, POOL_CONFIG_MIGRATION_THRESHOLD_OFFSET),
  };
}

export function deriveAssociatedTokenAddress(mint: string, owner: string, tokenProgram = METEORA_TOKEN_PROGRAM_ID): string {
  return findProgramAddressSync(
    [seedAddress(address(owner)), seedAddress(address(tokenProgram)), seedAddress(address(mint))],
    address(ASSOCIATED_TOKEN_PROGRAM_ID),
  );
}

export function buildAssociatedTokenAccountInstruction(params: {
  payer: string;
  owner: string;
  mint: string;
  associatedToken: string;
  meteoraTokenProgram?: string;
}): Instruction {
  return {
    programAddress: address(ASSOCIATED_TOKEN_PROGRAM_ID),
    accounts: [
      { address: address(params.payer), role: AccountRole.WRITABLE_SIGNER },
      { address: address(params.associatedToken), role: AccountRole.WRITABLE },
      { address: address(params.owner), role: AccountRole.READONLY },
      { address: address(params.mint), role: AccountRole.READONLY },
      { address: address("11111111111111111111111111111111"), role: AccountRole.READONLY },
      { address: address(params.meteoraTokenProgram ?? METEORA_TOKEN_PROGRAM_ID), role: AccountRole.READONLY },
    ],
    data: Uint8Array.of(1),
  };
}
