/**
 * Solana JSON-RPC proxy. Reads are anonymously available from a strict allowlist. A signed
 * transaction (or simulation of one) requires a wallet session, must be paid by that wallet, and
 * may call only the Diggo program and Solana's core program helpers.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS } from "../shared/pdas";
import {
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
} from "../shared/program";
import { sessionWallet } from "./auth";
import { isLocalChainRequest, isLocalChainRuntime, resolveChainConfig } from "./chainV2";
import type { RuntimeEnv } from "./env";
import { apiError, checkRateLimit, checkWalletRateLimit } from "./http";
import { METEORA_DAMM_V2_PROGRAM_ID, METEORA_DBC_PROGRAM_ID, normalizeMeteoraConfigPubkey } from "../shared/meteora";

const RPC_READ_METHOD_ALLOWLIST = new Set([
  "getAccountInfo",
  "getMultipleAccounts",
  "getBalance",
  "getLatestBlockhash",
  "getSignatureStatuses",
  "getTokenAccountBalance",
  // Needed by src/onchain/rentReclaim.ts: enumerating a wallet's own token accounts is the only
  // way to find the empty ones whose rent can be closed back to it. Read-only.
  "getTokenAccountsByOwner",
  "getMinimumBalanceForRentExemption",
  "getSlot",
  "getBlockTime",
  "getVersion",
  // Needed by the platform-fee card to list Meteora DBC pools under the published config. Only
  // the exact SDK query shape (pool discriminator + config memcmp) is accepted; see below.
  "getProgramAccounts",
]);

/** Anchor discriminators (base58) of the DBC VirtualPool and TransferHookPool accounts. */
const DBC_POOL_ACCOUNT_DISCRIMINATORS = new Set(["cmrfVvtHrjd", "gnXMCshfb9U"]);
/** Byte offset of PoolState::config inside both DBC pool accounts. */
const DBC_POOL_CONFIG_OFFSET = 72;
const MAX_PROGRAM_ACCOUNT_READS_PER_MINUTE = 20;

const RPC_WRITE_METHOD_ALLOWLIST = new Set(["sendTransaction", "simulateTransaction"]);
const COMMITMENTS = new Set(["processed", "confirmed", "finalized"]);
const MAX_RPC_BODY_BYTES = 65_536;
const MAX_RPC_BATCH = 10;
const MAX_MULTIPLE_ACCOUNTS = 100;
const MAX_SIGNATURE_STATUSES = 100;
const MAX_RENT_EXEMPTION_DATA_SIZE = 10_000_000;
const MAX_DATA_SLICE_LENGTH = 65_536;
const MAX_INSTRUCTIONS = 40;
const MAX_TRANSACTION_BYTES = 1_232;
const MAX_MIN_CONTEXT_SLOT = Number.MAX_SAFE_INTEGER;

interface JsonRpcCall {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRpcCalls(value: unknown): JsonRpcCall[] | null {
  const calls = Array.isArray(value) ? value : [value];
  if (calls.length === 0 || calls.length > MAX_RPC_BATCH) return null;
  const parsed: JsonRpcCall[] = [];
  for (const candidate of calls) {
    if (!isRecord(candidate) || candidate.jsonrpc !== "2.0") return null;
    if (candidate.id !== null && typeof candidate.id !== "string" && typeof candidate.id !== "number") return null;
    if (typeof candidate.method !== "string") return null;
    if (candidate.params !== undefined && !Array.isArray(candidate.params)) return null;
    parsed.push({ jsonrpc: "2.0", id: candidate.id ?? null, method: candidate.method, params: candidate.params });
  }
  return parsed;
}

function strictBase64(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  try {
    const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
    const encoded = btoa(String.fromCharCode(...bytes));
    return encoded === value ? bytes : null;
  } catch {
    return null;
  }
}

function transactionParam(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string" && value[1] === "base64") return value[0];
  return null;
}

function validateSendOptions(options: unknown): void {
  if (options === undefined) return;
  if (!isRecord(options)) throw new Error("sendTransaction options must be an object");
  const keys = Object.keys(options);
  if (keys.some((key) => !["encoding", "preflightCommitment", "maxRetries", "skipPreflight", "minContextSlot"].includes(key))) {
    throw new Error("sendTransaction option is not allowed");
  }
  if (options.encoding !== undefined && options.encoding !== "base64") throw new Error("Only base64 encoding is allowed");
  if (options.preflightCommitment !== undefined && !COMMITMENTS.has(String(options.preflightCommitment))) {
    throw new Error("Invalid preflight commitment");
  }
  if (options.maxRetries !== undefined && options.maxRetries !== 0) throw new Error("maxRetries must be zero");
  if (options.skipPreflight !== undefined && options.skipPreflight !== false) throw new Error("skipPreflight must be false");
  if (options.minContextSlot !== undefined && (typeof options.minContextSlot !== "number" || !Number.isSafeInteger(options.minContextSlot) || options.minContextSlot < 0)) {
    throw new Error("Invalid minContextSlot");
  }
}

/**
 * `unsigned` is the preflight path for a transaction the wallet has not signed yet. It must say
 * `sigVerify: false` explicitly and may ask the node to use a fresh blockhash; a signed simulation
 * keeps the strict defaults.
 */
function validateSimulateOptions(options: unknown, unsigned = false): void {
  if (unsigned && !isRecord(options)) throw new Error("Unsigned simulation must set sigVerify to false");
  if (options === undefined) return;
  if (!isRecord(options)) throw new Error("simulateTransaction options must be an object");
  const keys = Object.keys(options);
  const allowed = new Set([
    "encoding",
    "commitment",
    "sigVerify",
    "replaceRecentBlockhash",
    "minContextSlot",
    "innerInstructions",
    "accounts",
    "returnSerializedTransaction",
  ]);
  if (keys.some((key) => !allowed.has(key))) throw new Error("simulateTransaction option is not allowed");
  if (options.encoding !== undefined && options.encoding !== "base64") throw new Error("Only base64 encoding is allowed");
  if (options.commitment !== undefined && !COMMITMENTS.has(String(options.commitment))) throw new Error("Invalid commitment");
  if (unsigned) {
    if (options.sigVerify !== false) throw new Error("Unsigned simulation must set sigVerify to false");
    if (options.replaceRecentBlockhash !== undefined && typeof options.replaceRecentBlockhash !== "boolean") {
      throw new Error("replaceRecentBlockhash must be a boolean");
    }
  } else {
    if (options.sigVerify !== undefined && options.sigVerify !== true) throw new Error("sigVerify must be true");
    if (options.replaceRecentBlockhash !== undefined && options.replaceRecentBlockhash !== false) {
      throw new Error("replaceRecentBlockhash must be false");
    }
  }
  if (options.innerInstructions !== undefined && typeof options.innerInstructions !== "boolean") {
    throw new Error("innerInstructions must be a boolean");
  }
  if (options.accounts !== undefined && !isRecord(options.accounts)) {
    throw new Error("accounts must be an object");
  }
  if (options.accounts !== undefined) {
    if (Object.keys(options.accounts).some((key) => !["encoding", "addresses"].includes(key))) {
      throw new Error("accounts config is not allowed");
    }
    if (options.accounts.encoding !== undefined && options.accounts.encoding !== "base64") {
      throw new Error("Only base64 account encoding is allowed");
    }
    if (
      options.accounts.addresses !== undefined &&
      (!Array.isArray(options.accounts.addresses) ||
        options.accounts.addresses.length > 64 ||
        options.accounts.addresses.some((entry) => isRecord(entry) || typeof entry !== "string"))
    ) {
      throw new Error("Invalid account addresses");
    }
  }
  if (
    options.returnSerializedTransaction !== undefined &&
    typeof options.returnSerializedTransaction !== "boolean"
  ) {
    throw new Error("returnSerializedTransaction must be a boolean");
  }
  if (options.minContextSlot !== undefined && (typeof options.minContextSlot !== "number" || !Number.isSafeInteger(options.minContextSlot) || options.minContextSlot < 0)) {
    throw new Error("Invalid minContextSlot");
  }
}

function validateSimulationConfig(config: unknown): void {
  if (config === undefined) return;
  if (!isRecord(config)) throw new Error("simulateTransaction config must be an object");
  const allowed = new Set(["encoding", "commitment", "minContextSlot"]);
  if (Object.keys(config).some((key) => !allowed.has(key))) throw new Error("simulateTransaction config is not allowed");
  validateSimulateOptions({
    ...config,
    sigVerify: true,
    replaceRecentBlockhash: false,
  });
}

function requireParamCount(method: string, params: unknown[], min: number, max: number): void {
  if (params.length < min) throw new Error(`Missing RPC parameters for ${method}`);
  if (params.length > max) throw new Error("Too many RPC parameters");
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error(`${label} contains an unsupported field`);
}

function validateAddress(value: unknown): void {
  if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) {
    throw new Error("Invalid RPC address");
  }
}

function validateCommitment(value: unknown): void {
  if (value !== undefined && !COMMITMENTS.has(String(value))) throw new Error("Invalid commitment");
}

function validateMinContextSlot(value: unknown): void {
  if (
    value !== undefined &&
    (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_MIN_CONTEXT_SLOT)
  ) {
    throw new Error("Invalid minContextSlot");
  }
}

function validateEncoding(value: unknown, allowed: ReadonlySet<string>): void {
  if (value !== undefined && (typeof value !== "string" || !allowed.has(value))) throw new Error("Invalid RPC encoding");
}

function validateDataSlice(value: unknown): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw new Error("dataSlice must be an object");
  rejectUnknownKeys(value, new Set(["offset", "length"]), "dataSlice");
  if (
    typeof value.offset !== "number" ||
    !Number.isSafeInteger(value.offset) ||
    value.offset < 0 ||
    typeof value.length !== "number" ||
    !Number.isSafeInteger(value.length) ||
    value.length < 0 ||
    value.length > MAX_DATA_SLICE_LENGTH
  ) {
    throw new Error("Invalid dataSlice");
  }
}

function readConfig(value: unknown, allowed: Set<string>, label: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  rejectUnknownKeys(value, allowed, label);
  validateCommitment(value.commitment);
  validateMinContextSlot(value.minContextSlot);
  return value;
}

function validateAddressArray(value: unknown, maximum: number, label: string): void {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) throw new Error(`Invalid ${label}`);
  value.forEach(validateAddress);
}

function validateSignatureArray(value: unknown): void {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SIGNATURE_STATUSES) {
    throw new Error("Invalid signature list");
  }
  if (value.some((entry) => typeof entry !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{64}$/.test(entry))) {
    throw new Error("Invalid signature");
  }
}

function validateMemcmpFilter(value: unknown): { offset: number; bytes: string } {
  if (!isRecord(value)) throw new Error("Invalid program account filter");
  rejectUnknownKeys(value, new Set(["memcmp"]), "program account filter");
  const memcmp = value.memcmp;
  if (!isRecord(memcmp)) throw new Error("Invalid program account filter");
  rejectUnknownKeys(memcmp, new Set(["offset", "bytes", "encoding"]), "memcmp filter");
  if (memcmp.encoding !== undefined && memcmp.encoding !== "base58") throw new Error("memcmp encoding must be base58");
  if (typeof memcmp.offset !== "number" || typeof memcmp.bytes !== "string") throw new Error("Invalid memcmp filter");
  return { offset: memcmp.offset, bytes: memcmp.bytes };
}

/**
 * The only program-account scan the proxy serves: every DBC pool (standard or transfer-hook)
 * created under this deployment's published Meteora config. Anything broader is refused, so the
 * scan stays bounded by that config's pool count.
 */
function validateProgramAccountsParams(args: unknown[], dbcConfig: string): void {
  requireParamCount("getProgramAccounts", args, 2, 2);
  if (args[0] !== METEORA_DBC_PROGRAM_ID) throw new Error("getProgramAccounts is limited to Meteora DBC pools");
  if (!dbcConfig) throw new Error("No Meteora config is published for pool scans");
  const config = readConfig(args[1], new Set(["commitment", "minContextSlot", "encoding", "filters"]), "getProgramAccounts config");
  if (config.encoding !== "base64") throw new Error("getProgramAccounts must use base64 encoding");
  if (!Array.isArray(config.filters) || config.filters.length !== 2) throw new Error("getProgramAccounts needs the pool and config filters");
  const [kind, owner] = config.filters.map(validateMemcmpFilter);
  if (kind.offset !== 0 || !DBC_POOL_ACCOUNT_DISCRIMINATORS.has(kind.bytes)) throw new Error("getProgramAccounts is limited to DBC pool accounts");
  if (owner.offset !== DBC_POOL_CONFIG_OFFSET || owner.bytes !== dbcConfig) {
    throw new Error("getProgramAccounts is limited to pools under the published Meteora config");
  }
}

function validateReadParams(method: string, params: unknown[] | undefined, dbcConfig = ""): void {
  const args = params ?? [];
  const accountConfig = new Set(["commitment", "minContextSlot", "encoding", "dataSlice"]);
  const basicConfig = new Set(["commitment", "minContextSlot"]);
  const encodings = new Set(["base58", "base64", "jsonParsed"]);

  switch (method) {
    case "getAccountInfo": {
      requireParamCount(method, args, 1, 2);
      validateAddress(args[0]);
      const config = readConfig(args[1], accountConfig, "getAccountInfo config");
      validateEncoding(config.encoding, encodings);
      validateDataSlice(config.dataSlice);
      return;
    }
    case "getMultipleAccounts": {
      requireParamCount(method, args, 1, 2);
      validateAddressArray(args[0], MAX_MULTIPLE_ACCOUNTS, "account list");
      const config = readConfig(args[1], accountConfig, "getMultipleAccounts config");
      validateEncoding(config.encoding, encodings);
      validateDataSlice(config.dataSlice);
      return;
    }
    case "getBalance":
    case "getTokenAccountBalance": {
      requireParamCount(method, args, 1, 2);
      validateAddress(args[0]);
      readConfig(args[1], basicConfig, `${method} config`);
      return;
    }
    case "getLatestBlockhash":
    case "getSlot": {
      requireParamCount(method, args, 0, 1);
      readConfig(args[0], basicConfig, `${method} config`);
      return;
    }
    case "getBlockTime": {
      requireParamCount(method, args, 1, 1);
      if (typeof args[0] !== "number" || !Number.isSafeInteger(args[0]) || args[0] < 0) {
        throw new Error("Invalid block time slot");
      }
      return;
    }
    case "getSignatureStatuses": {
      requireParamCount(method, args, 1, 2);
      validateSignatureArray(args[0]);
      const config = readConfig(args[1], new Set(["searchTransactionHistory"]), "getSignatureStatuses config");
      if (config.searchTransactionHistory !== undefined && typeof config.searchTransactionHistory !== "boolean") {
        throw new Error("searchTransactionHistory must be a boolean");
      }
      if (config.searchTransactionHistory === true) throw new Error("Transaction history search is not allowed");
      return;
    }
    case "getTokenAccountsByOwner": {
      requireParamCount(method, args, 2, 3);
      validateAddress(args[0]);
      if (!isRecord(args[1])) throw new Error("Invalid token account filter");
      rejectUnknownKeys(args[1], new Set(["programId"]), "token account filter");
      validateAddress(args[1].programId);
      const config = readConfig(args[2], accountConfig, "getTokenAccountsByOwner config");
      validateEncoding(config.encoding, encodings);
      validateDataSlice(config.dataSlice);
      return;
    }
    case "getMinimumBalanceForRentExemption": {
      requireParamCount(method, args, 1, 2);
      if (
        typeof args[0] !== "number" ||
        !Number.isSafeInteger(args[0]) ||
        args[0] < 0 ||
        args[0] > MAX_RENT_EXEMPTION_DATA_SIZE
      ) {
        throw new Error("Invalid rent exemption data size");
      }
      readConfig(args[1], new Set(["commitment"]), "getMinimumBalanceForRentExemption config");
      return;
    }
    case "getVersion":
      requireParamCount(method, args, 0, 0);
      return;
    case "getProgramAccounts":
      validateProgramAccountsParams(args, dbcConfig);
      return;
  }
}

/**
 * `signatures: "required"` (the default) demands a valid signature from every required signer.
 * `"unsigned"` is only for simulations with `sigVerify: false`: every signature slot must be
 * empty, so a signed transaction can never be pushed through the relaxed path.
 */
export function validateSignedTransaction(
  encoded: string,
  sessionAddress: string,
  diggoProgramId: string | null,
  allowMeteora = false,
  signatures: "required" | "unsigned" = "required",
): { bytes: Uint8Array; version: "legacy" | 0 } {
  const bytes = strictBase64(encoded);
  if (!bytes || bytes.length > MAX_TRANSACTION_BYTES) throw new Error("Invalid or oversized transaction");
  const transaction = VersionedTransaction.deserialize(bytes);
  const { message } = transaction;
  if (message.version === 1) throw new Error("Transaction version 1 is not supported");
  if (message.version === 0 && message.addressTableLookups.length > 0) throw new Error("Address lookup tables are not supported");
  if (message.header.numRequiredSignatures < 1 || message.header.numRequiredSignatures > 8) throw new Error("Invalid signer count");
  if (message.compiledInstructions.length === 0 || message.compiledInstructions.length > MAX_INSTRUCTIONS) throw new Error("Invalid instruction count");

  const staticKeys = message.staticAccountKeys;
  let payer: PublicKey;
  try {
    payer = new PublicKey(sessionAddress);
  } catch {
    throw new Error("Invalid session wallet");
  }
  if (staticKeys.length === 0 || !staticKeys[0].equals(payer)) throw new Error("Session wallet must be the fee payer");
  const messageBytes = message.serialize();
  for (let index = 0; index < message.header.numRequiredSignatures; index += 1) {
    const signature = transaction.signatures[index];
    if (signatures === "unsigned") {
      if (!signature || signature.some((byte) => byte !== 0)) throw new Error("Unsigned simulation must not carry signatures");
      continue;
    }
    if (!signature || signature.length !== 64 || signature.every((byte) => byte === 0) || !ed25519.verify(signature, messageBytes, staticKeys[index].toBytes())) {
      throw new Error("Transaction is unsigned or has an invalid signature");
    }
  }

  const allowed = new Set([
    ...(diggoProgramId ? [diggoProgramId] : []),
    ...(allowMeteora ? [METEORA_DBC_PROGRAM_ID, METEORA_DAMM_V2_PROGRAM_ID] : []),
    SYSTEM_PROGRAM_ADDRESS,
    TOKEN_PROGRAM_ADDRESS,
    TOKEN_2022_PROGRAM_ADDRESS,
    ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    COMPUTE_BUDGET_PROGRAM_ADDRESS,
  ]);
  for (const instruction of message.compiledInstructions) {
    if (instruction.programIdIndex >= staticKeys.length) throw new Error("Invalid program account index");
    if (!allowed.has(staticKeys[instruction.programIdIndex].toBase58())) {
      throw new Error("Transaction calls a program that is not allowed");
    }
  }
  return { bytes, version: message.version };
}

export async function proxyRpc(request: Request, env: RuntimeEnv): Promise<Response> {
  const chain = resolveChainConfig(env, {
    deployed: !isLocalChainRequest(request) && !isLocalChainRuntime(env),
  });
  if (!(await checkRateLimit(request, env, "rpc-read", 240))) return apiError("Too many requests", 429);
  const raw = await request.text();
  if (raw.length > MAX_RPC_BODY_BYTES) return apiError("Payload too large", 413);
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return apiError("Invalid JSON-RPC payload");
  }
  const calls = parseRpcCalls(payload);
  if (!calls) return apiError("Invalid JSON-RPC payload");
  const isBatch = Array.isArray(payload);
  const hasWrite = calls.some((call) => RPC_WRITE_METHOD_ALLOWLIST.has(call.method));
  if (!calls.every((call) => RPC_READ_METHOD_ALLOWLIST.has(call.method) || RPC_WRITE_METHOD_ALLOWLIST.has(call.method))) {
    const blocked = calls.find((call) => !RPC_READ_METHOD_ALLOWLIST.has(call.method) && !RPC_WRITE_METHOD_ALLOWLIST.has(call.method));
    return apiError(`RPC method not allowed: ${String(blocked?.method)}`, 403);
  }
  let wallet: string | null = null;
  if (calls.some((call) => call.method === "getProgramAccounts")) {
    if (!(await checkRateLimit(request, env, "rpc-program-accounts", MAX_PROGRAM_ACCOUNT_READS_PER_MINUTE))) {
      return apiError("Too many requests", 429);
    }
  }
  const dbcConfig = normalizeMeteoraConfigPubkey(env.METEORA_DBC_CONFIG);
  if (hasWrite) {
    wallet = await sessionWallet(request, env);
    if (!wallet) return apiError("Wallet authentication required for transaction RPC", 401);
    if (!(await checkWalletRateLimit(env, wallet, "rpc-write", 12))) return apiError("Too many transaction RPC requests", 429);
  }
  for (const call of calls) {
    try {
      if (RPC_WRITE_METHOD_ALLOWLIST.has(call.method)) {
        const params = call.params ?? [];
        if (params.length === 0) return apiError("Transaction is required");
        if (call.method === "sendTransaction" && params.length > 2) return apiError("Too many RPC parameters");
        if (call.method === "simulateTransaction" && params.length > 3) return apiError("Too many RPC parameters");
        const encoded = transactionParam(params[0]);
        if (!encoded || !wallet) return apiError("Invalid base64 transaction");
        const unsignedSimulation = call.method === "simulateTransaction" && isRecord(params[1]) && params[1].sigVerify === false;
        validateSignedTransaction(
          encoded,
          wallet,
          chain.programId,
          String(env.CHAIN_MODE || "").trim().toLowerCase() === "meteora",
          unsignedSimulation ? "unsigned" : "required",
        );
        if (call.method === "sendTransaction") validateSendOptions(params[1]);
        else {
          validateSimulateOptions(params[1], unsignedSimulation);
          validateSimulationConfig(params[2]);
        }
        call.params = [encoded, ...params.slice(1)];
      } else {
        validateReadParams(call.method, call.params, dbcConfig);
      }
    } catch (error) {
      return apiError(String(error instanceof Error ? error.message : "Invalid transaction RPC request"), 403);
    }
  }
  const upstream = await fetch(chain.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // Preserve the caller's single/batch shape: @solana/kit's default transport expects a single
    // call to come back as one JSON-RPC response, not as a one-element array.
    body: JSON.stringify(isBatch ? calls : calls[0]),
  });
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
