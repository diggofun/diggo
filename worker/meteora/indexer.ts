import bs58 from "bs58";
import {
  decodeTokenMint,
  decodePoolConfig,
  readMint,
  readMintMetadata,
  readMetadataImage,
  readPoolMetadata,
  TRANSFER_HOOK_POOL_DISCRIMINATOR,
  VIRTUAL_POOL_DISCRIMINATOR,
  decodeVirtualPool,
  METEORA_CONFIG_OFFSET,
  readAccount,
  readProgramAccounts,
  readSignatures,
  readTransaction,
} from "./rpc";
import type { MeteoraTransaction } from "./rpc";
import {
  METEORA_DBC_PROGRAM_ID,
  type MeteoraEvent,
  type MeteoraInitializeEvent,
  type MeteoraPoolRecord,
  type MeteoraRpcEnv,
  type MeteoraSwapEvent,
} from "./types";

const EVT_SWAP2 = Uint8Array.of(189, 66, 51, 168, 38, 80, 117, 153);
const EVT_CURVE_COMPLETE = Uint8Array.of(229, 231, 86, 84, 156, 134, 75, 24);
const EVT_INITIALIZE = Uint8Array.of(228, 50, 246, 85, 203, 66, 134, 37);
const IX_INITIALIZE = Uint8Array.of(140, 85, 215, 176, 102, 54, 104, 79);
const IX_SWAP2 = Uint8Array.of(65, 75, 63, 76, 235, 91, 91, 136);
// Devnet currently returns the upgraded program's instruction prefixes. Keep the
// SDK IDL values above for compatibility with older/mainnet transactions.
const IX_INITIALIZE_UPGRADED = Uint8Array.of(70, 196, 61, 166, 7, 13, 202, 178);
const IX_SWAP2_UPGRADED = Uint8Array.of(76, 106, 185, 89, 238, 20, 170, 75);
const IX_SWAP = Uint8Array.of(248, 198, 158, 145, 225, 117, 135, 200);
const TRADE_DIRECTION_BASE_TO_QUOTE = 0;
const SOL_MINT = "So11111111111111111111111111111111111111112";
// Signature listing is cheap (1000 per call); transaction reads are not, so they are capped per tick.
const SIGNATURE_PAGE_SIZE = 1000;
const SIGNATURE_MAX_PAGES = 5;
const MAX_TRANSACTIONS_PER_ACCOUNT = 200;

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isInitialize(data: Uint8Array): boolean {
  return equal(data.subarray(0, 8), IX_INITIALIZE) || equal(data.subarray(0, 8), IX_INITIALIZE_UPGRADED);
}

function isSwap2(data: Uint8Array): boolean {
  return equal(data.subarray(0, 8), IX_SWAP2) || equal(data.subarray(0, 8), IX_SWAP2_UPGRADED);
}

function isSwap(data: Uint8Array): boolean {
  return isSwap2(data) || equal(data.subarray(0, 8), IX_SWAP);
}

function u64(data: Uint8Array, offset: number): bigint {
  if (offset + 8 > data.length) throw new Error("truncated u64");
  let value = 0n;
  for (let index = 7; index >= 0; index -= 1) value = (value << 8n) | BigInt(data[offset + index]);
  return value;
}

function pubkey(data: Uint8Array, offset: number): string {
  if (offset + 32 > data.length) throw new Error("truncated pubkey");
  return bs58.encode(data.subarray(offset, offset + 32));
}

function booleanByte(data: Uint8Array, offset: number): boolean {
  if (offset >= data.length) throw new Error("truncated bool");
  if (data[offset] !== 0 && data[offset] !== 1) throw new Error("invalid bool");
  return data[offset] === 1;
}

function decodeBase64(body: string): Uint8Array {
  return Uint8Array.from(atob(body), (character) => character.charCodeAt(0));
}

export function decodeMeteoraEventData(data: Uint8Array): MeteoraEvent | null {
  if (equal(data.subarray(0, 8), EVT_INITIALIZE)) {
    if (data.length < 145) return null;
    return {
      kind: "initialize",
      pool: pubkey(data, 8),
      config: pubkey(data, 40),
      creator: pubkey(data, 72),
      baseMint: pubkey(data, 104),
      poolType: data[136],
      activationPoint: u64(data, 137),
      signature: "",
      eventIndex: 0,
      blockTime: null,
      slot: 0n,
    };
  }
  if (equal(data.subarray(0, 8), EVT_CURVE_COMPLETE)) {
    if (data.length < 88) return null;
    return {
      kind: "curve_complete",
      pool: pubkey(data, 8),
      config: pubkey(data, 40),
      baseReserve: u64(data, 72),
      quoteReserve: u64(data, 80),
      signature: "",
      eventIndex: 0,
      blockTime: null,
      slot: 0n,
    };
  }
  if (!equal(data.subarray(0, 8), EVT_SWAP2) || data.length < 187) return null;
  const tradeDirection = data[72];
  let cursor = 73;
  booleanByte(data, cursor);
  cursor += 1;
  cursor += 17; // amount_0, amount_1, swap_mode
  const includedFee = u64(data, cursor);
  const excludedFee = u64(data, cursor + 8);
  const amountLeft = u64(data, cursor + 16);
  const amountOut = u64(data, cursor + 24);
  cursor += 32; // result header; next_sqrt_price is u128
  cursor += 16;
  cursor += 32; // trading, protocol, compounding, referral fees
  const quoteReserve = u64(data, cursor);
  const migrationThreshold = u64(data, cursor + 8);
  return {
    kind: "swap",
    pool: pubkey(data, 8),
    config: pubkey(data, 40),
    mint: "",
    side: tradeDirection === TRADE_DIRECTION_BASE_TO_QUOTE ? "sell" : "buy",
    amountIn: includedFee + excludedFee - amountLeft,
    amountOut,
    solAmountLamports: tradeDirection === TRADE_DIRECTION_BASE_TO_QUOTE ? 0n : includedFee + excludedFee - amountLeft,
    quoteReserve,
    migrationThreshold,
    trader: "",
    signature: "",
    eventIndex: 0,
    blockTime: null,
    slot: 0n,
  };
}

export function parseMeteoraLogs(logs: readonly string[]): Uint8Array[] {
  const result: Uint8Array[] = [];
  for (const log of logs) {
    const marker = "Program data: ";
    const at = log.indexOf(marker);
    if (at < 0) continue;
    try {
      const data = decodeBase64(log.slice(at + marker.length).trim());
      if (equal(data.subarray(0, 8), EVT_SWAP2) || equal(data.subarray(0, 8), EVT_CURVE_COMPLETE) || equal(data.subarray(0, 8), EVT_INITIALIZE)) result.push(data);
    } catch {
      // A third-party program log is not a DBC event and is not an indexer failure.
    }
  }
  return result;
}

function configuredValue(env: MeteoraRpcEnv, name: string): string | undefined {
  const value = (env as unknown as Record<string, unknown>)[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function configAddress(env: MeteoraRpcEnv): string {
  const value = configuredValue(env, "METEORA_DBC_CONFIG");
  if (!value) throw new Error("METEORA_DBC_CONFIG is required");
  return value;
}

export function isMeteoraPoolAccount(data: Uint8Array): boolean {
  return equal(data.subarray(0, 8), VIRTUAL_POOL_DISCRIMINATOR)
    || equal(data.subarray(0, 8), TRANSFER_HOOK_POOL_DISCRIMINATOR);
}

export function poolBelongsToConfig(data: Uint8Array, config: string): boolean {
  return data.length >= 306 && isMeteoraPoolAccount(data) && pubkey(data, METEORA_CONFIG_OFFSET) === config;
}

function safePoolRow(pool: MeteoraPoolRecord) {
  return {
    pool: pool.pool,
    config: pool.config,
    creator: pool.creator,
    baseMint: pool.baseMint,
    baseVault: pool.baseVault,
    quoteMint: pool.quoteMint,
    name: pool.name,
    symbol: pool.symbol,
    uri: pool.uri,
    decimals: pool.decimals,
    activationPoint: pool.activationPoint.toString(),
    baseReserve: pool.baseReserve.toString(),
    quoteReserve: pool.quoteReserve.toString(),
    migrationQuoteThreshold: pool.migrationQuoteThreshold.toString(),
    isGraduated: pool.isGraduated || pool.isMigrated ? 1 : 0,
    isMigrated: pool.isMigrated ? 1 : 0,
  };
}

async function hydratePool(env: MeteoraRpcEnv, accountAddress: string, accountData: Uint8Array): Promise<MeteoraPoolRecord> {
    const config = configAddress(env);
    if (!poolBelongsToConfig(accountData, config)) throw new Error("Meteora pool does not belong to the configured DBC config");
    const pool = decodeVirtualPool(accountAddress, accountData);
    const [configAccount, mint, metadata, mintMetadata] = await Promise.all([
      readAccount(env, pool.config),
      readMint(env, pool.baseMint),
      readPoolMetadata(env, pool.pool),
      readMintMetadata(env, pool.baseMint).catch((error: unknown) => {
        console.warn(JSON.stringify({ event: "meteora.mint_metadata_failed", mint: pool.baseMint, error: String(error) }));
        return null;
      }),
    ]);
    if (!configAccount) throw new Error(`Meteora PoolConfig not found: ${pool.config}`);
    const poolConfig = decodePoolConfig(configAccount.data);
    pool.quoteMint = poolConfig.quoteMint;
    pool.migrationQuoteThreshold = poolConfig.migrationQuoteThreshold;
    pool.decimals = mint?.decimals ?? pool.decimals;
    pool.isGraduated = isGraduated(pool, pool.quoteReserve, pool.migrationQuoteThreshold);
    // The mint's Metaplex metadata is what wallets and explorers show, and it is the only place a
    // DBC coin's symbol lives. The DBC pool metadata contributes its logo URL as the image.
    pool.name = mintMetadata?.name ?? metadata.name;
    pool.symbol = mintMetadata?.symbol ?? metadata.symbol;
    pool.uri = metadata.uri ?? (mintMetadata?.uri ? await readMetadataImage(mintMetadata.uri).catch(() => null) : null);
    return pool;
}

async function upsertPool(env: MeteoraRpcEnv, pool: MeteoraPoolRecord): Promise<void> {
  const row = safePoolRow(pool);
  await env.DB.prepare(
    "INSERT INTO meteora_pools (pool, config, creator, base_mint, base_vault, quote_mint, name, symbol, uri, decimals, activation_point, base_reserve, quote_reserve, migration_quote_threshold, is_graduated, is_migrated, indexed_at, created_at)" +
    " VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?17)" +
    " ON CONFLICT(pool) DO UPDATE SET config=excluded.config, creator=excluded.creator, base_mint=excluded.base_mint, base_vault=excluded.base_vault, quote_mint=excluded.quote_mint, name=COALESCE(excluded.name, meteora_pools.name), symbol=COALESCE(excluded.symbol, meteora_pools.symbol), uri=COALESCE(excluded.uri, meteora_pools.uri), decimals=excluded.decimals, activation_point=excluded.activation_point, base_reserve=excluded.base_reserve, quote_reserve=excluded.quote_reserve, migration_quote_threshold=CASE WHEN excluded.migration_quote_threshold <> '0' THEN excluded.migration_quote_threshold ELSE meteora_pools.migration_quote_threshold END, is_graduated=MAX(meteora_pools.is_graduated, excluded.is_graduated), is_migrated=excluded.is_migrated, indexed_at=excluded.indexed_at",
  ).bind(
    row.pool, row.config, row.creator, row.baseMint, row.baseVault, row.quoteMint, row.name, row.symbol, row.uri,
    row.decimals, row.activationPoint, row.baseReserve, row.quoteReserve, row.migrationQuoteThreshold, row.isGraduated, row.isMigrated,
    Math.floor(Date.now() / 1000),
  ).run();
}

export async function verifyAndIndexMeteoraPool(env: MeteoraRpcEnv, accountAddress: string): Promise<MeteoraPoolRecord> {
  const account = await readAccount(env, accountAddress);
  if (!account) throw new Error("Meteora pool account not found");
  const pool = await hydratePool(env, accountAddress, account.data);
  await upsertPool(env, pool);
  return pool;
}

type SignatureInfo = Awaited<ReturnType<typeof readSignatures>>[number];

/**
 * Lists signatures newer than `cursor` (the newest signature already processed), oldest first.
 * `complete` is false when the backlog is larger than the listing budget; the oldest part of
 * that backlog is then unreachable, which is why pool discovery also reconciles by account scan.
 */
export async function pendingSignatures(
  env: MeteoraRpcEnv,
  account: string,
  cursor: string | undefined,
  options: { pageSize?: number; maxPages?: number } = {},
): Promise<{ signatures: SignatureInfo[]; complete: boolean }> {
  const pageSize = options.pageSize ?? SIGNATURE_PAGE_SIZE;
  const maxPages = options.maxPages ?? SIGNATURE_MAX_PAGES;
  const newestFirst: SignatureInfo[] = [];
  let before: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const batch = await readSignatures(env, account, {
      limit: pageSize,
      ...(cursor ? { until: cursor } : {}),
      ...(before ? { before } : {}),
    });
    for (const info of batch) {
      if (info.signature === cursor) return { signatures: newestFirst.reverse(), complete: true };
      newestFirst.push(info);
    }
    if (batch.length < pageSize) return { signatures: newestFirst.reverse(), complete: true };
    before = batch[batch.length - 1].signature;
  }
  return { signatures: newestFirst.reverse(), complete: false };
}

/**
 * Feeds each successful transaction after `cursor` to `handle`, oldest first, and returns the
 * newest signature that was fully handled. A read or handler failure stops the walk there so the
 * next tick retries it; one bad transaction can no longer abort the scan without progress.
 */
async function followSignatures(
  env: MeteoraRpcEnv,
  account: string,
  cursor: string | undefined,
  handle: (info: SignatureInfo, transaction: MeteoraTransaction) => Promise<void>,
): Promise<string | undefined> {
  const { signatures, complete } = await pendingSignatures(env, account, cursor);
  if (!complete) console.warn(JSON.stringify({ event: "meteora.signature_backlog_truncated", account, listed: signatures.length }));
  let last = cursor;
  for (const info of signatures.slice(0, MAX_TRANSACTIONS_PER_ACCOUNT)) {
    if (!info.failed) {
      try {
        const transaction = await readTransaction(env, info.signature);
        if (!transaction) break; // not visible at this commitment yet; retry next tick
        if (!transaction.failed) await handle(info, transaction);
      } catch (error) {
        console.error(JSON.stringify({ event: "meteora.transaction_index_failed", account, signature: info.signature, error: String(error) }));
        break;
      }
    }
    last = info.signature;
  }
  return last;
}

export function initializedPools(transaction: MeteoraTransaction, config: string): string[] {
  const pools = parseMeteoraLogs(transaction.logs)
    .map((data) => decodeMeteoraEventData(data))
    .flatMap((event) => event?.kind === "initialize" && event.config === config ? [event.pool] : []);
  if (pools.length > 0) return pools;
  const event = initializeFromInstruction(transaction, config);
  return event ? [event.pool] : [];
}

async function scanConfigPools(env: MeteoraRpcEnv): Promise<MeteoraPoolRecord[]> {
  const config = configAddress(env);
  const state = await env.DB.prepare("SELECT signature_cursor FROM meteora_config_scan WHERE config=?1").bind(config)
    .first<{ signature_cursor: string | null }>();
  const cursor = state?.signature_cursor ?? undefined;
  const pools: MeteoraPoolRecord[] = [];
  const next = await followSignatures(env, config, cursor, async (_info, transaction) => {
    for (const pool of initializedPools(transaction, config)) {
      try {
        pools.push(await verifyAndIndexMeteoraPool(env, pool));
      } catch (error) {
        console.error(JSON.stringify({ event: "meteora.pool_verify_failed", pool, error: String(error) }));
      }
    }
  });
  if (next && next !== cursor) {
    await env.DB.prepare("INSERT INTO meteora_config_scan (config, signature_cursor, indexed_at) VALUES (?1, ?2, ?3) ON CONFLICT(config) DO UPDATE SET signature_cursor=excluded.signature_cursor, indexed_at=excluded.indexed_at")
      .bind(config, next, Math.floor(Date.now() / 1000)).run();
  }
  return pools;
}

/**
 * Finds every DBC pool account whose config field matches, independent of signature history.
 * This is the backstop that keeps a missed or unreadable create transaction from hiding a pool.
 */
async function reconcileConfigPools(env: MeteoraRpcEnv, known: ReadonlySet<string>): Promise<MeteoraPoolRecord[]> {
  const config = configAddress(env);
  const accounts = await readProgramAccounts(env, { memcmpOffset: METEORA_CONFIG_OFFSET, memcmpBytes: bs58.decode(config) });
  const pools: MeteoraPoolRecord[] = [];
  for (const account of accounts) {
    if (known.has(account.pubkey) || !poolBelongsToConfig(account.data, config)) continue;
    try {
      const pool = await hydratePool(env, account.pubkey, account.data);
      await upsertPool(env, pool);
      console.warn(JSON.stringify({ event: "meteora.pool_reconciled", pool: pool.pool }));
      pools.push(pool);
    } catch (error) {
      console.error(JSON.stringify({ event: "meteora.pool_verify_failed", pool: account.pubkey, error: String(error) }));
    }
  }
  return pools;
}

export async function discoverMeteoraPools(env: MeteoraRpcEnv): Promise<MeteoraPoolRecord[]> {
  const config = configAddress(env);
  const registered = await env.DB.prepare("SELECT pool FROM meteora_pools WHERE config=?1 ORDER BY created_at").bind(config)
    .all<{ pool: string }>();
  const pools: MeteoraPoolRecord[] = [];
  for (const row of registered.results ?? []) {
    try {
      pools.push(await verifyAndIndexMeteoraPool(env, row.pool));
    } catch (error) {
      console.error(JSON.stringify({ event: "meteora.pool_refresh_failed", pool: row.pool, error: String(error) }));
    }
  }
  const known = new Set(pools.map((pool) => pool.pool));
  try {
    for (const pool of await scanConfigPools(env)) {
      if (known.has(pool.pool)) continue;
      known.add(pool.pool);
      pools.push(pool);
    }
  } catch (error) {
    console.error(JSON.stringify({ event: "meteora.config_scan_failed", error: String(error) }));
  }
  try {
    for (const pool of await reconcileConfigPools(env, known)) {
      known.add(pool.pool);
      pools.push(pool);
    }
  } catch (error) {
    console.error(JSON.stringify({ event: "meteora.config_reconcile_failed", error: String(error) }));
  }
  return pools;
}

export function traderForSwap(transaction: { instructions: { programId: string; accounts: string[]; data: string }[] }, event: MeteoraSwapEvent): string | null {
  for (const instruction of transaction.instructions) {
    const data = instructionData(instruction);
    if (!data || instruction.accounts.length < 10 || !isSwap2(data)) continue;
    if (instruction.accounts[2] !== event.pool || instruction.accounts[1] !== event.config) continue;
    return instruction.accounts[9];
  }
  return null;
}

function instructionData(instruction: { programId: string; accounts: string[]; data: string }): Uint8Array | null {
  if (instruction.programId !== METEORA_DBC_PROGRAM_ID) return null;
  const candidates: Uint8Array[] = [];
  try { candidates.push(decodeBase64(instruction.data)); } catch { /* try the legacy encoding */ }
  try { candidates.push(bs58.decode(instruction.data)); } catch { /* the RPC may return base64 */ }
  return candidates.find((candidate) => isInitialize(candidate) || isSwap2(candidate)) ?? candidates[0] ?? null;
}

export function initializeFromInstruction(transaction: { instructions: { programId: string; accounts: string[]; data: string }[] }, config: string): MeteoraInitializeEvent | null {
  for (const instruction of transaction.instructions) {
    const data = instructionData(instruction);
    if (!data || !isInitialize(data) || instruction.accounts.length < 6) continue;
    const [foundConfig, , creator, baseMint, , pool] = instruction.accounts;
    if (foundConfig !== config || !creator || !baseMint || !pool) continue;
    return { kind: "initialize", pool, config, creator, baseMint, poolType: 0, activationPoint: 0n, signature: "", eventIndex: 0, blockTime: null, slot: 0n };
  }
  return null;
}

type TokenBalance = { accountIndex: number; mint: string; owner: string | null; amount: string };

export function swapFromBalances(
  transaction: { accountKeys: string[]; instructions: { programId: string; accounts: string[]; data: string }[]; preTokenBalances: TokenBalance[]; postTokenBalances: TokenBalance[] },
  pool: MeteoraPoolRecord,
  signature: string,
  slot: bigint,
  blockTime: number | null,
): MeteoraSwapEvent | null {
  for (const instruction of transaction.instructions) {
    const data = instructionData(instruction);
    if (!data || !isSwap(data) || instruction.accounts.length < 10) continue;
    if (instruction.accounts[1] !== pool.config || instruction.accounts[2] !== pool.pool) continue;
    const trader = instruction.accounts[9] ?? "";
    const traderAccountIndex = transaction.accountKeys.indexOf(trader);
    const pre = new Map(transaction.preTokenBalances.map((row) => [`${row.accountIndex}:${row.mint}`, BigInt(row.amount)]));
    const post = new Map(transaction.postTokenBalances.map((row) => [`${row.accountIndex}:${row.mint}`, BigInt(row.amount)]));
    const keys = new Set([...pre.keys(), ...post.keys()]);
    const changes = [...keys].map((key) => {
      const [index, mint] = key.split(":");
      const before = pre.get(key) ?? 0n;
      const after = post.get(key) ?? 0n;
      return {
        accountIndex: Number(index),
        mint,
        owner: transaction.preTokenBalances.find((row) => row.accountIndex === Number(index) && row.mint === mint)?.owner
          ?? transaction.postTokenBalances.find((row) => row.accountIndex === Number(index) && row.mint === mint)?.owner
          ?? null,
        delta: after - before,
      };
    }).filter((row) => row.delta !== 0n);
    const baseChange = changes.find((row) => row.mint === pool.baseMint && row.owner === trader)
      ?? changes.find((row) => row.mint === pool.baseMint && row.accountIndex === traderAccountIndex)
      ?? changes.find((row) => row.mint === pool.baseMint);
    const quoteChange = changes.find((row) => (row.mint === pool.quoteMint || row.mint === SOL_MINT) && row.owner === pool.pool)
      ?? changes.find((row) => row.mint === pool.quoteMint || row.mint === SOL_MINT);
    if (!baseChange || !quoteChange) continue;
    const buy = baseChange.delta > 0n;
    const amountIn = (buy ? quoteChange.delta : baseChange.delta) < 0n
      ? (buy ? -quoteChange.delta : -baseChange.delta)
      : (buy ? quoteChange.delta : baseChange.delta);
    const amountOut = (buy ? baseChange.delta : quoteChange.delta) < 0n
      ? -(buy ? baseChange.delta : quoteChange.delta)
      : (buy ? baseChange.delta : quoteChange.delta);
    if (!amountIn || !amountOut) continue;
    const side = buy ? "buy" as const : "sell" as const;
    return {
      kind: "swap", pool: pool.pool, config: pool.config, mint: pool.baseMint, side,
      amountIn, amountOut, solAmountLamports: side === "buy" ? amountIn : amountOut,
      quoteReserve: pool.quoteReserve, migrationThreshold: pool.migrationQuoteThreshold,
      trader, signature, eventIndex: 0, blockTime, slot,
    };
  }
  return null;
}

async function recordEvent(env: MeteoraRpcEnv, event: MeteoraEvent, pool: MeteoraPoolRecord): Promise<boolean> {
  if (event.kind === "initialize") {
    await upsertPool(env, { ...pool, pool: event.pool, config: event.config, creator: event.creator, baseMint: event.baseMint, activationPoint: event.activationPoint });
    return true;
  }
  if (event.kind === "curve_complete") {
    await env.DB.prepare("UPDATE meteora_pools SET is_graduated=1, base_reserve=?2, quote_reserve=?3, indexed_at=?4 WHERE pool=?1").bind(event.pool, event.baseReserve.toString(), event.quoteReserve.toString(), Math.floor(Date.now() / 1000)).run();
    return true;
  }
  const trader = event.trader;
  if (!trader || !event.amountIn) return false;
  const id = `${event.signature}:${event.eventIndex}`;
  await env.DB.prepare(
    "INSERT OR IGNORE INTO meteora_swaps (id, signature, event_index, pool, config, mint, trader_wallet, side, amount_in, amount_out, sol_amount_lamports, quote_reserve, migration_threshold, slot, block_time, created_at)" +
    " VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
  ).bind(id, event.signature, event.eventIndex, event.pool, event.config, pool.baseMint, trader, event.side, event.amountIn.toString(), event.amountOut.toString(), event.solAmountLamports.toString(), event.quoteReserve.toString(), event.migrationThreshold.toString(), event.slot.toString(), event.blockTime, Math.floor(Date.now() / 1000)).run();
  return true;
}

async function indexPool(env: MeteoraRpcEnv, pool: MeteoraPoolRecord): Promise<{ swaps: number; events: number }> {
  const row = await env.DB.prepare("SELECT signature_cursor FROM meteora_pools WHERE pool=?1").bind(pool.pool).first<{ signature_cursor: string | null }>();
  const cursor = row?.signature_cursor ?? undefined;
  let events = 0;
  let swaps = 0;
  const next = await followSignatures(env, pool.pool, cursor, async (info, transaction) => {
      const eventLogs = parseMeteoraLogs(transaction.logs);
      for (let eventIndex = 0; eventIndex < eventLogs.length; eventIndex += 1) {
        const data = eventLogs[eventIndex];
        const decoded = decodeMeteoraEventData(data);
        if (!decoded) continue;
        decoded.signature = info.signature;
        decoded.eventIndex = eventIndex;
        decoded.slot = info.slot;
        decoded.blockTime = info.blockTime;
        if (decoded.kind === "swap") {
          decoded.mint = pool.baseMint;
          const trader = traderForSwap(transaction, decoded);
          if (!trader) continue;
          decoded.trader = trader;
        }
        if (await recordEvent(env, decoded, pool)) {
          events += 1;
          if (decoded.kind === "swap") swaps += 1;
        }
      }
      if (!eventLogs.some((data) => decodeMeteoraEventData(data)?.kind === "swap")) {
        const fallback = swapFromBalances(transaction, pool, info.signature, info.slot, info.blockTime);
        if (fallback && await recordEvent(env, fallback, pool)) {
          events += 1;
          swaps += 1;
        }
      }
  });
  if (next && next !== cursor) await env.DB.prepare("UPDATE meteora_pools SET signature_cursor=?2, indexed_at=?3 WHERE pool=?1").bind(pool.pool, next, Math.floor(Date.now() / 1000)).run();
  return { swaps, events };
}

export async function getWalletVolumeLamports(env: MeteoraRpcEnv, wallet: string): Promise<bigint> {
  const rows = await env.DB.prepare("SELECT sol_amount_lamports FROM meteora_swaps WHERE trader_wallet=?1").bind(wallet).all<{ sol_amount_lamports: string }>();
  return sumLamportRows(rows.results ?? []);
}

export function sumLamportRows(rows: readonly { sol_amount_lamports: string }[]): bigint {
  return rows.reduce((total, row) => total + BigInt(row.sol_amount_lamports), 0n);
}

export async function runMeteoraIndexer(env: MeteoraRpcEnv): Promise<{ pools: number; swaps: number; events: number }> {
  const pools = await discoverMeteoraPools(env);
  let events = 0;
  let swaps = 0;
  for (const pool of pools) {
    await upsertPool(env, pool);
    const result = await indexPool(env, pool);
    events += result.events;
    swaps += result.swaps;
  }
  return { pools: pools.length, swaps, events };
}

export function isGraduated(pool: { isMigrated: boolean }, quoteReserve: bigint, threshold: bigint): boolean {
  return pool.isMigrated || (threshold > 0n && quoteReserve >= threshold);
}

export { decodeTokenMint, readAccount };
