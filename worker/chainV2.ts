/**
 * Reads v2 program state over RPC.
 *
 * This module is the indexer's only way to learn a chain fact, and it is deliberately
 * read-mostly: everything here either fetches an account, fetches a transaction's events, or
 * sends a transaction the caller already built and signed. It cannot decide anything.
 *
 * Every decoder comes from `worker/v2/program.ts`, so an account whose discriminator is not a
 * v2 account is rejected rather than guessed at.
 */
import {
  type Address,
  type Base58EncodedBytes,
  address,
  createSolanaRpc,
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  type RpcTransport,
  type Instruction,
  type KeyPairSigner,
  type Rpc,
  type SolanaRpcApi,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import {
  ACCOUNT_DISCRIMINATOR,
  type DecodedCoin,
  type DecodedDiggoEvent,
  type DecodedDiscoveryOpportunity,
  type DecodedGlobalBudget,
  type DecodedLiquidityPool,
  type DecodedMiningPosition,
  type DecodedPlayerAccount,
  type DecodedProtocolConfig,
  type DecodedSponsorEvent,
  type DecodedSponsorGrant,
  type DecodedSponsorVault,
  type V2AccountName,
  base64ToBytes,
  bytesToHex,
  decodeCoin,
  decodeDiscoveryOpportunity,
  decodeGlobalBudget,
  decodeLiquidityPool,
  decodeMiningPosition,
  decodePlayerAccount,
  decodeProgramEvents,
  decodeProtocolConfig,
  decodeSponsorEvent,
  decodeSponsorGrant,
  decodeSponsorVault,
  deriveCoinPda,
  deriveGlobalBudgetPda,
  derivePoolPda,
  derivePlayerPda,
  derivePositionPda,
  deriveProtocolPda,
  deriveSponsorVaultPda,
  hexToBytes,
} from "./v2/program";
import bs58 from "bs58";

export const DEFAULT_DEVNET_RPC = "https://api.devnet.solana.com";
export const DEVNET_PROGRAM_ID = "H3Y8GgTnvwv5U1bajfzj386YSPC48vvwjFroXYyHZFj5";
export const SOLANA_CLUSTERS = ["devnet", "mainnet-beta"] as const;
export const LAMPORTS_PER_SOL = 1_000_000_000;

export interface ChainEnv {
  SOLANA_CLUSTER?: string;
  DIGGO_RPC_URL?: string;
  /** Comma-separated fallback RPC endpoints, tried after DIGGO_RPC_URL. */
  DIGGO_RPC_URLS?: string;
  DIGGO_PROGRAM_ID: string;
  /** Present in deployed and local Wrangler runtimes when the version_metadata binding exists. */
  CF_VERSION_METADATA?: { id: string; tag: string; timestamp: string };
}

export type SolanaCluster = (typeof SOLANA_CLUSTERS)[number];

export class ChainConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainConfigurationError";
  }
}

export interface ResolvedChainConfig {
  cluster: SolanaCluster;
  programId: Address;
  rpcUrl: string;
  rpcUrls: string[];
}

function isValidBase58Address(value: string): boolean {
  try {
    return bs58.decode(value).length === 32;
  } catch {
    return false;
  }
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

function rpcUrlsFromEnv(primary: string | undefined, fallbacks: string | undefined): string[] {
  const values = [primary, ...(fallbacks ?? "").split(/[\s,]+/)]
    .map((value) => value?.trim() ?? "")
    .filter((value) => value.length > 0);
  const urls: string[] = [];
  for (const value of values) {
    if (!isValidHttpUrl(value)) throw new ChainConfigurationError("RPC endpoints must be absolute HTTP(S) URLs without embedded credentials");
    if (!urls.includes(value)) urls.push(value);
  }
  return urls;
}

function isFailoverError(error: unknown): boolean {
  const candidate = error as { context?: { statusCode?: number }; statusCode?: number; message?: string };
  const status = candidate?.context?.statusCode ?? candidate?.statusCode;
  if (status === 403 || status === 429 || (typeof status === "number" && status >= 500)) return true;
  const message = String(candidate?.message ?? error ?? "").toLowerCase();
  return /http (403|429|5\d\d)|too many requests|rate limit|server error|service unavailable|bad gateway|gateway timeout|fetch failed|network error/.test(message);
}

function isFailoverResponse(response: unknown): boolean {
  const error = (response as { error?: { code?: number; message?: string } } | null)?.error;
  if (!error) return false;
  if (error.code === 429 || error.code === -32005) return true;
  return isFailoverError(error);
}

function createFailoverTransport(urls: string[]): RpcTransport {
  const transports = urls.map((url) => createDefaultRpcTransport({ url: url as never }) as RpcTransport);
  return async function failoverTransport<TResponse>(config: Parameters<RpcTransport>[0]): Promise<TResponse> {
    let lastError: unknown;
    for (const transport of transports) {
      try {
        const response = await transport(config);
        if (!isFailoverResponse(response)) return response as TResponse;
        lastError = response;
      } catch (error) {
        if (!isFailoverError(error)) throw error;
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("all Solana RPC endpoints failed");
  };
}

/**
 * Local worker development keeps the public devnet fallback. A request for a non-local hostname
 * is a deployed runtime and must name its RPC explicitly, so production cannot silently depend on
 * the rate-limited public endpoint.
 */
export function isLocalChainRequest(request: Request): boolean {
  const hostname = new URL(request.url).hostname.toLowerCase().replace(/\.$/, "");
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".localhost")
  );
}

/**
 * Miniflare supplies version metadata with an empty tag for local Wrangler development. A deployed
 * Worker has a real version binding, so chain-backed background work must not use the public
 * devnet fallback there. Request hostnames are still used for fetch handlers because tests and
 * local tooling can construct Requests without the binding.
 */
export function isLocalChainRuntime(env: ChainEnv): boolean {
  // A missing binding means this is a unit-test or a small local harness, not a deployed Wrangler
  // version. Real deployed environments get the binding declared in wrangler.jsonc.
  return env.CF_VERSION_METADATA === undefined || env.CF_VERSION_METADATA.tag === "";
}

export function resolveChainConfig(env: ChainEnv, options: { deployed?: boolean } = {}): ResolvedChainConfig {
  const cluster = env.SOLANA_CLUSTER?.trim().toLowerCase();
  if (cluster !== "devnet" && cluster !== "mainnet-beta") {
    throw new ChainConfigurationError("SOLANA_CLUSTER must be explicitly set to devnet or mainnet-beta");
  }

  const programId = env.DIGGO_PROGRAM_ID?.trim();
  if (!programId || !isValidBase58Address(programId)) {
    throw new ChainConfigurationError("DIGGO_PROGRAM_ID must be a valid 32-byte base58 address");
  }
  if (cluster === "devnet" && programId !== DEVNET_PROGRAM_ID) {
    throw new ChainConfigurationError("SOLANA_CLUSTER devnet does not match the configured Diggo program");
  }
  if (cluster === "mainnet-beta" && programId === DEVNET_PROGRAM_ID) {
    throw new ChainConfigurationError("SOLANA_CLUSTER mainnet-beta cannot use the Diggo devnet program");
  }

  const configuredRpc = env.DIGGO_RPC_URL?.trim();
  const configuredRpcUrls = rpcUrlsFromEnv(configuredRpc, env.DIGGO_RPC_URLS);
  if (cluster === "mainnet-beta" && configuredRpcUrls.length === 0) {
    throw new ChainConfigurationError("DIGGO_RPC_URL is required for mainnet-beta");
  }
  if (options.deployed && configuredRpcUrls.length === 0) {
    throw new ChainConfigurationError("DIGGO_RPC_URL is required for deployed environments");
  }

  const rpcUrls = configuredRpcUrls.length > 0 ? configuredRpcUrls : [DEFAULT_DEVNET_RPC];
  return {
    cluster,
    programId: address(programId),
    rpcUrl: rpcUrls[0]!,
    rpcUrls,
  };
}

let cachedRpc: Rpc<SolanaRpcApi> | null = null;
let cachedRpcUrl: string | null = null;

export function getChainRpc(env: ChainEnv): Rpc<SolanaRpcApi> {
  const config = resolveChainConfig(env, { deployed: !isLocalChainRuntime(env) });
  const key = config.rpcUrls.join("\n");
  if (cachedRpc && cachedRpcUrl === key) return cachedRpc;
  cachedRpc = config.rpcUrls.length === 1
    ? createSolanaRpc(config.rpcUrls[0] as never)
    : createSolanaRpcFromTransport(createFailoverTransport(config.rpcUrls));
  cachedRpcUrl = key;
  return cachedRpc;
}

export function getProgramAddress(env: ChainEnv): Address {
  return resolveChainConfig(env).programId;
}

/**
 * The base64 payload of an RPC account, whichever shape the client returned it in.
 * @solana/kit encodes `data` as a `[base64, "base64"]` tuple; some paths hand back the bare
 * string. Both are accepted so a client upgrade cannot silently stop the indexer.
 */
function dataOf(account: { data: unknown }): Uint8Array | null {
  const { data } = account;
  if (typeof data === "string") return base64ToBytes(data);
  if (Array.isArray(data) && typeof data[0] === "string") return base64ToBytes(data[0]);
  if (Array.isArray(data) && data[0] instanceof Uint8Array) return data[0];
  return null;
}

/** One decoded account, with the metadata an indexer needs to record it. */
export interface DecodedAccount<T> {
  address: string;
  lamports: bigint;
  slot: bigint;
  data: T;
}

/** Fetches and decodes one account, or null when it does not exist yet. */
export async function readDecodedAccount<T>(
  env: ChainEnv,
  accountAddress: string,
  expected: V2AccountName,
  decode: (bytes: Uint8Array) => T,
): Promise<DecodedAccount<T> | null> {
  const rpc = getChainRpc(env);
  const response = await rpc
    .getAccountInfo(address(accountAddress), { commitment: "confirmed", encoding: "base64" })
    .send();
  const value = response.value;
  if (!value) return null;
  const bytes = dataOf(value as unknown as { data: unknown });
  if (!bytes) return null;
  const discriminator = bytesToHex(bytes.subarray(0, 8));
  if (discriminator !== ACCOUNT_DISCRIMINATOR[expected]) return null;
  return {
    address: accountAddress,
    lamports: BigInt(value.lamports),
    slot: BigInt(response.context.slot),
    data: decode(bytes),
  };
}

/**
 * Every account of one v2 kind, filtered on its discriminator.
 *
 * The filter is on the discriminator rather than on a field because a v2 account stores no
 * identity it could be filtered by: `MiningPosition` and `DiscoveryOpportunity` keep neither
 * the owner nor the coin (both are PDA seeds), so their identity is only ever known from a
 * derived address or from an event.
 */
export async function listDecodedAccounts<T>(
  env: ChainEnv,
  expected: V2AccountName,
  decode: (bytes: Uint8Array) => T,
  /** The slot the caller observed. `getProgramAccounts` does not report one. */
  observedSlot = 0n,
): Promise<DecodedAccount<T>[]> {
  const rpc = getChainRpc(env);
  const response = await rpc
    .getProgramAccounts(getProgramAddress(env), {
      commitment: "confirmed",
      encoding: "base64",
      filters: [
        {
          memcmp: {
            offset: 0n,
            bytes: asBase58(bs58Encode(hexToBytes(ACCOUNT_DISCRIMINATOR[expected]))),
            encoding: "base58",
          },
        },
      ],
    })
    .send();
  const out: DecodedAccount<T>[] = [];
  for (const entry of response as unknown as readonly {
    pubkey: string;
    account: { data: unknown; lamports: bigint };
  }[]) {
    const bytes = dataOf(entry.account);
    if (!bytes) continue;
    try {
      out.push({
        address: entry.pubkey,
        lamports: BigInt(entry.account.lamports),
        slot: observedSlot,
        data: decode(bytes),
      });
    } catch {
      // A body that will not decode is skipped, never guessed at.
    }
  }
  return out;
}

/** Accounts of one kind whose first stored field equals `value` (a `has_one`-style filter). */
export async function listDecodedAccountsByField<T>(
  env: ChainEnv,
  expected: V2AccountName,
  fieldOffset: number,
  value: string,
  decode: (bytes: Uint8Array) => T,
  observedSlot = 0n,
): Promise<DecodedAccount<T>[]> {
  const rpc = getChainRpc(env);
  const response = await rpc
    .getProgramAccounts(getProgramAddress(env), {
      commitment: "confirmed",
      encoding: "base64",
      filters: [
        {
          memcmp: {
            offset: 0n,
            bytes: asBase58(bs58Encode(hexToBytes(ACCOUNT_DISCRIMINATOR[expected]))),
            encoding: "base58",
          },
        },
        { memcmp: { offset: BigInt(fieldOffset), bytes: asBase58(value), encoding: "base58" } },
      ],
    })
    .send();
  const out: DecodedAccount<T>[] = [];
  for (const entry of response as unknown as readonly {
    pubkey: string;
    account: { data: unknown; lamports: bigint };
  }[]) {
    const bytes = dataOf(entry.account);
    if (!bytes) continue;
    try {
      out.push({
        address: entry.pubkey,
        lamports: BigInt(entry.account.lamports),
        slot: observedSlot,
        data: decode(bytes),
      });
    } catch {
      // Same rule as above: an undecodable body is skipped.
    }
  }
  return out;
}

function bs58Encode(bytes: Uint8Array): string {
  return bs58.encode(bytes);
}

/** The RPC's branded base58 string, which a plain `string` is not assignable to. */
const asBase58 = (value: string): Base58EncodedBytes => value as Base58EncodedBytes;

// --- typed readers ------------------------------------------------------------------------

export const readProtocolConfig = (env: ChainEnv): Promise<DecodedAccount<DecodedProtocolConfig> | null> =>
  deriveProtocolPda(getProgramAddress(env)).then((pda) =>
    readDecodedAccount(env, pda, "ProtocolConfig", decodeProtocolConfig),
  );

export const readCoinByMint = (
  env: ChainEnv,
  mint: string,
): Promise<DecodedAccount<DecodedCoin> | null> =>
  deriveCoinPda(getProgramAddress(env), address(mint)).then((pda) =>
    readDecodedAccount(env, pda, "Coin", decodeCoin),
  );

export const readCoinByAddress = (
  env: ChainEnv,
  coin: string,
): Promise<DecodedAccount<DecodedCoin> | null> => readDecodedAccount(env, coin, "Coin", decodeCoin);

export const listCoins = (env: ChainEnv): Promise<DecodedAccount<DecodedCoin>[]> =>
  listDecodedAccounts(env, "Coin", decodeCoin);

export const readPoolByMint = (
  env: ChainEnv,
  mint: string,
): Promise<DecodedAccount<DecodedLiquidityPool> | null> =>
  derivePoolPda(getProgramAddress(env), address(mint)).then((pda) =>
    readDecodedAccount(env, pda, "LiquidityPool", decodeLiquidityPool),
  );

export const listPools = (env: ChainEnv): Promise<DecodedAccount<DecodedLiquidityPool>[]> =>
  listDecodedAccounts(env, "LiquidityPool", decodeLiquidityPool);

export const readPlayerByOwner = (
  env: ChainEnv,
  owner: string,
): Promise<DecodedAccount<DecodedPlayerAccount> | null> =>
  derivePlayerPda(getProgramAddress(env), address(owner)).then((pda) =>
    readDecodedAccount(env, pda, "PlayerAccount", decodePlayerAccount),
  );

export const readPosition = (
  env: ChainEnv,
  coin: string,
  owner: string,
): Promise<DecodedAccount<DecodedMiningPosition> | null> =>
  derivePositionPda(getProgramAddress(env), address(coin), address(owner)).then((pda) =>
    readDecodedAccount(env, pda, "MiningPosition", decodeMiningPosition),
  );

export const listPositions = (env: ChainEnv): Promise<DecodedAccount<DecodedMiningPosition>[]> =>
  listDecodedAccounts(env, "MiningPosition", decodeMiningPosition);

export const listOpportunities = (
  env: ChainEnv,
): Promise<DecodedAccount<DecodedDiscoveryOpportunity>[]> =>
  listDecodedAccounts(env, "DiscoveryOpportunity", decodeDiscoveryOpportunity);

export const listGlobalBudgets = (env: ChainEnv): Promise<DecodedAccount<DecodedGlobalBudget>[]> =>
  listDecodedAccounts(env, "GlobalBudget", decodeGlobalBudget);

export const readGlobalBudget = (
  env: ChainEnv,
  dayIndex: number,
): Promise<DecodedAccount<DecodedGlobalBudget> | null> =>
  deriveGlobalBudgetPda(getProgramAddress(env), dayIndex).then((pda) =>
    readDecodedAccount(env, pda, "GlobalBudget", decodeGlobalBudget),
  );

export const listSponsorVaults = (env: ChainEnv): Promise<DecodedAccount<DecodedSponsorVault>[]> =>
  listDecodedAccounts(env, "SponsorVault", decodeSponsorVault);

export const readSponsorVault = (
  env: ChainEnv,
  sponsorOwner: string,
): Promise<DecodedAccount<DecodedSponsorVault> | null> =>
  deriveSponsorVaultPda(getProgramAddress(env), address(sponsorOwner)).then((pda) =>
    readDecodedAccount(env, pda, "SponsorVault", decodeSponsorVault),
  );

/** `SponsorEvent.vault` is the first stored field, so it filters at offset 8. */
export const listSponsorEventsForVault = (
  env: ChainEnv,
  vault: string,
): Promise<DecodedAccount<DecodedSponsorEvent>[]> =>
  listDecodedAccountsByField(env, "SponsorEvent", 8, vault, decodeSponsorEvent);

export const listSponsorEvents = (env: ChainEnv): Promise<DecodedAccount<DecodedSponsorEvent>[]> =>
  listDecodedAccounts(env, "SponsorEvent", decodeSponsorEvent);

/** `SponsorGrant`'s event is not stored, so grants are swept whole. */
export const listSponsorGrants = (env: ChainEnv): Promise<DecodedAccount<DecodedSponsorGrant>[]> =>
  listDecodedAccounts(env, "SponsorGrant", decodeSponsorGrant);

// --- mints --------------------------------------------------------------------------------

export interface MintInfo {
  decimals: number;
  supply: bigint;
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  /** Token-2022 metadata, when the mint carries it. Empty strings when it does not. */
  name: string;
  symbol: string;
  uri: string;
}

const TOKEN_2022_EXTENSION = { METADATA_POINTER: 18, TOKEN_METADATA: 19 } as const;

/**
 * Decodes an SPL/Token-2022 mint: the 82-byte base state, then (for Token-2022) the account
 * type byte and the TLV extension block.
 *
 * The metadata extension is located by walking the TLV entries and confirming that the
 * extension's own embedded `mint` field equals the mint we asked about. That check is what
 * makes the walk safe: a wrong start offset cannot produce a match, so the extension is either
 * found correctly or reported absent.
 */
export function decodeMint(mintAddress: string, data: Uint8Array): MintInfo {
  if (data.length < 82) throw new Error(`mint ${mintAddress} is shorter than the 82-byte base state`);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const supply = view.getBigUint64(36, true);
  const decimals = data[44]!;
  const mintAuthorityRevoked = view.getUint32(0, true) === 0;
  const freezeAuthorityRevoked = view.getUint32(46, true) === 0;
  const metadata = findTokenMetadata(data, mintAddress);
  return {
    decimals,
    supply,
    mintAuthorityRevoked,
    freezeAuthorityRevoked,
    name: metadata?.name ?? "",
    symbol: metadata?.symbol ?? "",
    uri: metadata?.uri ?? "",
  };
}

/**
 * The TLV extension block. Token-2022 places the account type byte after the base state and
 * pads to an eight-byte boundary before the extensions, so the first entry is not always at a
 * fixed offset; every candidate start is tried and only a validated match is returned.
 */
function findTokenMetadata(
  data: Uint8Array,
  mintAddress: string,
): { name: string; symbol: string; uri: string } | null {
  const baseLen = 82;
  for (let start = baseLen + 1; start <= baseLen + 8 && start < data.length; start++) {
    const found = walkExtensions(data, start, mintAddress);
    if (found) return found;
  }
  return null;
}

function walkExtensions(
  data: Uint8Array,
  start: number,
  mintAddress: string,
): { name: string; symbol: string; uri: string } | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = start;
  let sawPointer = false;
  while (offset + 4 <= data.length) {
    const type = view.getUint16(offset, true);
    const length = view.getUint16(offset + 2, true);
    const body = offset + 4;
    if (length === 0 && type === 0) break;
    if (body + length > data.length) return null;
    if (type === TOKEN_2022_EXTENSION.METADATA_POINTER && length >= 64) {
      sawPointer = true;
    }
    if (type === TOKEN_2022_EXTENSION.TOKEN_METADATA) {
      const parsed = parseTokenMetadata(data, body, length, mintAddress);
      if (parsed) return parsed;
      return null;
    }
    offset = body + length;
    // A metadata pointer that is present but a metadata body that is not means this start
    // offset walked a plausible TLV chain that is not the real one; stop and let the caller
    // try the next alignment.
    if (sawPointer && offset >= data.length) return null;
  }
  return null;
}

function parseTokenMetadata(
  data: Uint8Array,
  body: number,
  length: number,
  mintAddress: string,
): { name: string; symbol: string; uri: string } | null {
  if (length < 68) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const embedded = bs58.encode(data.subarray(body + 32, body + 64));
  if (embedded !== mintAddress) return null;
  const end = body + length;
  let cursor = body + 64;
  const readString = (): string | null => {
    if (cursor + 4 > end) return null;
    const size = view.getUint32(cursor, true);
    cursor += 4;
    if (cursor + size > end) return null;
    const value = new TextDecoder().decode(data.subarray(cursor, cursor + size));
    cursor += size;
    return value;
  };
  const name = readString();
  const symbol = readString();
  const uri = readString();
  if (name === null || symbol === null || uri === null) return null;
  return { name, symbol, uri };
}

export async function readMintInfo(env: ChainEnv, mint: string): Promise<MintInfo | null> {
  const rpc = getChainRpc(env);
  const response = await rpc
    .getAccountInfo(address(mint), { commitment: "confirmed", encoding: "base64" })
    .send();
  const value = response.value;
  if (!value) return null;
  const bytes = dataOf(value as unknown as { data: unknown });
  if (!bytes) return null;
  return decodeMint(mint, bytes);
}

export async function readTokenAccountAmount(env: ChainEnv, tokenAccount: string): Promise<bigint | null> {
  const rpc = getChainRpc(env);
  const response = await rpc
    .getAccountInfo(address(tokenAccount), { commitment: "confirmed", encoding: "base64" })
    .send();
  const value = response.value;
  if (!value) return null;
  const bytes = dataOf(value as unknown as { data: unknown });
  if (!bytes || bytes.length < 72) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getBigUint64(64, true);
}

export async function readLamports(env: ChainEnv, accountAddress: string): Promise<bigint | null> {
  const rpc = getChainRpc(env);
  const response = await rpc.getBalance(address(accountAddress), { commitment: "confirmed" }).send();
  return BigInt(response.value);
}

export async function readCurrentSlot(env: ChainEnv): Promise<bigint> {
  const rpc = getChainRpc(env);
  return BigInt(await rpc.getSlot({ commitment: "confirmed" }).send());
}

// --- events -------------------------------------------------------------------------------

export interface ChainTransactionEvents {
  signature: string;
  slot: bigint;
  blockTime: number | null;
  events: DecodedDiggoEvent[];
  failed: boolean;
}

/**
 * Every v2 event a transaction emitted, decoded from its log messages.
 *
 * A failed transaction is reported as failed and its events are dropped: a program that
 * reverted emitted no state change, and indexing the events of a reverted instruction would
 * invent history.
 */
export async function readTransactionEvents(
  env: ChainEnv,
  signature: string,
): Promise<ChainTransactionEvents | null> {
  const rpc = getChainRpc(env);
  const response = await rpc
    .getTransaction(signature as never, {
      commitment: "confirmed",
      encoding: "json",
      maxSupportedTransactionVersion: 0,
    })
    .send();
  const result = response as unknown as {
    slot: number | bigint;
    blockTime?: number | bigint | null;
    meta?: { err?: unknown; logMessages?: readonly string[] | null } | null;
  } | null;
  if (!result) return null;
  const failed = Boolean(result.meta?.err);
  const logs = result.meta?.logMessages ?? [];
  return {
    signature,
    slot: BigInt(result.slot),
    blockTime: result.blockTime === null || result.blockTime === undefined ? null : Number(result.blockTime),
    failed,
    events: failed ? [] : decodeProgramEvents(logs),
  };
}

/**
 * Signatures that touched the program, newest first.
 *
 * `until` is exclusive in the RPC, so the caller passes the last signature it already
 * indexed; the first page after a cold start has none and simply reads the most recent ones.
 */
export async function readProgramSignatures(
  env: ChainEnv,
  options: { until?: string; before?: string; limit?: number } = {},
): Promise<{ signature: string; slot: bigint; blockTime: number | null; failed: boolean }[]> {
  const rpc = getChainRpc(env);
  const response = await rpc
    .getSignaturesForAddress(getProgramAddress(env), {
      commitment: "confirmed",
      limit: options.limit ?? 100,
      ...(options.until ? { until: options.until as never } : {}),
      ...(options.before ? { before: options.before as never } : {}),
    })
    .send();
  return (response as unknown as readonly {
    signature: string;
    slot: number | bigint;
    blockTime?: number | bigint | null;
    err: unknown;
  }[]).map((entry) => ({
    signature: entry.signature,
    slot: BigInt(entry.slot),
    blockTime: entry.blockTime === null || entry.blockTime === undefined ? null : Number(entry.blockTime),
    failed: Boolean(entry.err),
  }));
}

// --- sending ------------------------------------------------------------------------------

/**
 * Signs and sends one transaction with a single fee payer.
 *
 * The only caller is the optional crank bot, and the only key it holds pays fees: every
 * instruction it sends is one a stranger could send with their own wallet (design section 6),
 * so a compromised crank key buys nothing but the fees it already pays.
 */
export async function sendWithFeePayer(
  env: ChainEnv,
  feePayer: KeyPairSigner,
  instructions: Instruction[],
): Promise<string> {
  const rpc = getChainRpc(env);
  const { value: latestBlockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(signed);
  await rpc
    .sendTransaction(getBase64EncodedWireTransaction(signed), {
      encoding: "base64",
      preflightCommitment: "confirmed",
    })
    .send();
  return signature;
}

/**
 * Sends a transaction and waits for a confirmed status. Referral settlement uses this stricter
 * path because the database must never record a reward as credited before the chain has accepted
 * the marker. The ordinary crank path intentionally remains fire-and-forget.
 */
export async function sendAndConfirmWithFeePayer(
  env: ChainEnv,
  feePayer: KeyPairSigner,
  instructions: Instruction[],
  timeoutMs = 60_000,
): Promise<string> {
  const rpc = getChainRpc(env);
  const { value: latestBlockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(signed);
  await rpc
    .sendTransaction(getBase64EncodedWireTransaction(signed), {
      encoding: "base64",
      preflightCommitment: "confirmed",
    })
    .send();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await rpc
      .getSignatureStatuses([address(signature)], { searchTransactionHistory: true })
      .send();
    const status = result.value[0];
    if (status?.err) throw new Error(`referral transaction failed: ${String(status.err)}`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      return signature;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error("referral transaction confirmation timed out");
}
