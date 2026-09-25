/**
 * The indexer: it reads the v2 program and writes what it read.
 *
 * This module is the whole of the worker's relationship with the chain, and it has one job -
 * keep D1 an honest mirror of program state. It decides nothing:
 *
 *  - no activation, streak, ORE, crew, power or discovery outcome is computed here, because all
 *    of them are program state now;
 *  - no payout is triggered here, because every payout is an instruction anyone can send;
 *  - no authority is held here, because the only key the worker can hold is the optional crank's
 *    fee payer, which has none.
 *
 * Two intake paths feed it, as the design requires (section 6): a Helius webhook for events as
 * they land, and a cron sweep that walks program accounts and recent signatures so the index
 * converges even with no webhook configured at all.
 */
import {
  type DecodedDiggoEvent,
  base64ToBytes,
  bytesToHex,
  decodeCoin,
  decodeDiscoveryOpportunity,
  decodeMiningPosition,
  decodeTradeInstruction,
  isDefaultPubkey,
  lamportsToSol,
} from "./v2/program";
import { coinLimit, maxSignaturePages, signatureLimit, type RuntimeEnv } from "./env";
import { address } from "@solana/kit";
import {
  type ChainEnv,
  getProgramAddress,
  listCoins,
  listGlobalBudgets,
  listPools,
  listSponsorEvents,
  listSponsorGrants,
  listSponsorVaults,
  readCoinByAddress,
  readCoinByMint,
  readCurrentSlot,
  readDecodedAccount,
  readMintInfo,
  readPlayerByOwner,
  readPosition,
  readProgramSignatures,
  readProtocolConfig,
  readTokenAccountAmount,
  readTransactionEvents,
} from "./chainV2";
import type { IndexerJob } from "./v2/types";
import { apiError, json, readJson, sameSecret } from "./http";
import { spotPriceLamports } from "./v2/market";
import { derivePositionPda } from "./v2/program";
import {
  type IndexerRunResult,
  type TokenMetrics,
  beginRun,
  coinSlug,
  deletePosition,
  ensurePlayerRow,
  finishRun,
  jsonSafe,
  nowSeconds,
  readCursor,
  recordAdvisory,
  TOKEN_CACHE_KEY,
  writeCoin,
  writeCursor,
  writeGlobalBudget,
  writePlayerAccount,
  writePool,
  writePosition,
  writePriceSample,
  writeProtocolConfig,
  writeSponsorEvent,
  writeSponsorGrant,
  writeSponsorVault,
  writeTokenRow,
} from "./indexStore";
import { metric } from "./telemetry";

/** How long a price observation is kept. Display history only. */
export const PRICE_SAMPLE_RETENTION_SECONDS = 7 * 24 * 3_600;

// --- display helpers ------------------------------------------------------------------------

/**
 * The SOL/USD rate used for the display-only USD columns.
 *
 * The oracle is display-only in v2 - the program prices its own discovery caps from its own pool
 * TWAP - so a missing rate degrades a page, never a payout. A missing rate is zero for derived USD
 * columns and is accompanied by an explicit availability flag.
 */
export async function displaySolUsd(env: RuntimeEnv): Promise<number> {
  try {
    const { getSolUsd } = await import("./oracle");
    const quote = await getSolUsd(env);
    return quote.available ? quote.priceUsd : 0;
  } catch {
    return 0;
  }
}

/**
 * The honest 24h window, measured from this coin's own indexed observations.
 *
 * A change needs a sample at least a day old and at least one indexed trade behind it. With
 * either missing it is null, because null is unknown and zero is a measurement.
 */
export async function read24hMetrics(
  env: RuntimeEnv,
  mint: string,
  priceSol: number,
): Promise<TokenMetrics> {
  const cutoff = nowSeconds() - 24 * 3_600;
  const baseline = await env.DB.prepare(
    "SELECT observed_at, price_sol FROM coin_price_samples" +
      " WHERE mint = ?1 AND observed_at <= ?2 ORDER BY observed_at DESC LIMIT 1",
  )
    .bind(mint, cutoff)
    .first<{ observed_at: number; price_sol: number }>();
  const traded = await env.DB.prepare(
    "SELECT COUNT(*) AS trades FROM trades WHERE mint = ?1 AND block_time >= ?2",
  )
    .bind(mint, cutoff)
    .first<{ trades: number }>();
  const trades24h = traded?.trades ?? 0;
  const volume = await env.DB.prepare(
    "SELECT COALESCE(SUM(price_sol * CAST(amount_in AS REAL)), 0) AS volume FROM trades" +
      " WHERE mint = ?1 AND block_time >= ?2",
  )
    .bind(mint, cutoff)
    .first<{ volume: number }>();
  const volume24hUsd = (volume?.volume ?? 0) * (await displaySolUsd(env));
  if (!baseline || baseline.price_sol <= 0 || trades24h === 0) {
    return { change24h: null, change24hAt: 0, volume24hUsd, trades24h };
  }
  const change = ((priceSol - baseline.price_sol) / baseline.price_sol) * 100;
  return {
    change24h: Math.round(change * 100) / 100,
    change24hAt: baseline.observed_at,
    volume24hUsd,
    trades24h,
  };
}

/** The off-chain display metadata a coin may have been given, if any. */
async function displayMeta(
  env: RuntimeEnv,
  mint: string,
  solUsd: number,
): Promise<{ name: string; symbol: string; description: string; imageKey: string | null; solUsd: number; usdPriceAvailable: boolean }> {
  const row = await env.DB.prepare(
    "SELECT name, symbol, description, image_key FROM tokens WHERE mint = ?1",
  )
    .bind(mint)
    .first<{ name: string; symbol: string; description: string; image_key: string | null }>();
  const mintInfo = await readMintInfo(env as ChainEnv, mint).catch(() => null);
  return {
    name: row?.name || mintInfo?.name || "",
    symbol: row?.symbol || mintInfo?.symbol || "",
    description: row?.description ?? "",
    imageKey: row?.image_key ?? null,
    solUsd,
    usdPriceAvailable: solUsd > 0,
  };
}

// --- refreshers ----------------------------------------------------------------------------

/** Re-reads one coin from chain and rewrites every row derived from it. */
export async function refreshCoin(env: RuntimeEnv, mint: string): Promise<boolean> {
  const coin = await readCoinByMint(env as ChainEnv, mint);
  if (!coin) return false;
  const pools = await listPools(env as ChainEnv).catch(() => []);
  const pool = pools.find((entry) => entry.data.mint === mint)?.data ?? null;
  const decimals = (await readMintInfo(env as ChainEnv, mint).catch(() => null))?.decimals ?? 6;
  const solUsd = await displaySolUsd(env);
  const priceSol = spotPriceLamports(coin.data, pool, decimals) / 1_000_000_000;
  const metrics = await read24hMetrics(env, mint, priceSol);
  await writeCoin(env, coin.address, mint, coin.data, coin.slot);
  await writeTokenRow(env, coin.address, mint, coin.data, pool, decimals, metrics, await displayMeta(env, mint, solUsd));
  await writePriceSample(env, mint, priceSol, coin.slot, PRICE_SAMPLE_RETENTION_SECONDS);
  await checkLedgerInvariant(env, mint, coin.data);
  return true;
}

/** Re-reads one coin by its own address, for events that name the coin rather than the mint. */
export async function refreshCoinByAddress(env: RuntimeEnv, coinAddress: string): Promise<boolean> {
  const coin = await readCoinByAddress(env as ChainEnv, coinAddress);
  if (!coin) return false;
  const pools = await listPools(env as ChainEnv).catch(() => []);
  const pool = pools.find((entry) => entry.data.coin === coinAddress)?.data ?? null;
  const mint = pool?.mint ?? (await mintOfCoin(env, coinAddress));
  if (!mint) return false;
  const decimals = (await readMintInfo(env as ChainEnv, mint).catch(() => null))?.decimals ?? 6;
  const solUsd = await displaySolUsd(env);
  const priceSol = spotPriceLamports(coin.data, pool, decimals) / 1_000_000_000;
  const metrics = await read24hMetrics(env, mint, priceSol);
  await writeCoin(env, coinAddress, mint, coin.data, coin.slot);
  await writeTokenRow(env, coinAddress, mint, coin.data, pool, decimals, metrics, await displayMeta(env, mint, solUsd));
  await writePriceSample(env, mint, priceSol, coin.slot, PRICE_SAMPLE_RETENTION_SECONDS);
  await checkLedgerInvariant(env, mint, coin.data);
  return true;
}

/**
 * The mint a Coin PDA belongs to.
 *
 * A Coin account does not store its mint: the mint is the PDA seed. The vault token account it
 * does store names the mint, so that is where the first sight of a coin gets it from, and after
 * that the indexer's own row answers without an RPC.
 */
export async function mintOfCoin(env: RuntimeEnv, coinAddress: string): Promise<string> {
  const row = await env.DB.prepare("SELECT mint FROM coins WHERE coin = ?1")
    .bind(coinAddress)
    .first<{ mint: string }>();
  if (row?.mint) return row.mint;
  const coin = await readDecodedAccount(env as ChainEnv, coinAddress, "Coin", decodeCoin).catch(
    () => null,
  );
  if (!coin) return "";
  const { getChainRpc } = await import("./chainV2");
  const rpc = getChainRpc(env as ChainEnv);
  const info = await rpc
    .getAccountInfo(coin.data.vault as never, { commitment: "confirmed", encoding: "jsonParsed" })
    .send()
    .catch(() => null);
  const parsed = info?.value as unknown as { data?: { parsed?: { info?: { mint?: string } } } } | null;
  return parsed?.data?.parsed?.info?.mint ?? "";
}

export async function refreshPlayer(env: RuntimeEnv, wallet: string): Promise<boolean> {
  const player = await readPlayerByOwner(env as ChainEnv, wallet);
  if (!player) {
    // A wallet that has never initialized its PlayerAccount still gets a profile row: the
    // profile is off-chain, and a username is worth having before the first activation.
    await ensurePlayerRow(env, wallet, nowSeconds());
    return false;
  }
  await ensurePlayerRow(env, wallet, Number(player.data.createdAt));
  await writePlayerAccount(env, player.address, wallet, player.data, player.slot);
  return true;
}

/**
 * Re-reads one position. A position whose account is gone is deleted rather than left behind,
 * because a closed account is exactly what `remove_power` produces.
 */
export async function refreshPosition(
  env: RuntimeEnv,
  coin: string,
  owner: string,
): Promise<boolean> {
  const position = await readPosition(env as ChainEnv, coin, owner);
  if (position) {
    await writePosition(env, position.address, coin, owner, position.data, position.slot);
    return true;
  }
  const positionAddress = await derivePositionPda(
    env.DIGGO_PROGRAM_ID ? address(env.DIGGO_PROGRAM_ID) : getProgramAddress(env as ChainEnv),
    address(coin),
    address(owner),
  );
  await deletePosition(env, positionAddress);
  return false;
}

/**
 * The vault ledger invariant of design 1.3(a), checked off-chain and reported.
 *
 * The indexer cannot move a token, so this is an alert and nothing else: it exists so a
 * divergence is visible in the same pass that indexed the account that caused it, instead of
 * being discovered later by a player whose claim failed.
 */
export async function checkLedgerInvariant(
  env: RuntimeEnv,
  mint: string,
  coin: { vault: string; tokenReserve: bigint; reserveRemaining: bigint; discoveryRemaining: bigint; outstandingClaims: bigint },
): Promise<{ ok: boolean; shortfall: bigint }> {
  const vaultAmount = await readTokenAccountAmount(env as ChainEnv, coin.vault).catch(() => null);
  if (vaultAmount === null) return { ok: true, shortfall: 0n };
  const owed =
    coin.tokenReserve + coin.reserveRemaining + coin.discoveryRemaining + coin.outstandingClaims;
  if (vaultAmount >= owed) return { ok: true, shortfall: 0n };
  const shortfall = owed - vaultAmount;
  await recordAdvisory(env, {
    kind: "vault_ledger_invariant",
    subject: mint,
    severity: "CRITICAL",
    detail: `vault holds ${vaultAmount} but the coin's ledgers owe ${owed}: short by ${shortfall}`,
  });
  return { ok: false, shortfall };
}

// --- events --------------------------------------------------------------------------------

export interface EventContext {
  signature: string;
  slot: bigint;
  blockTime: number | null;
  eventIndex?: number;
}

/** Every wallet a decoded event names, so the indexer knows whose account to re-read. */
function walletsIn(event: DecodedDiggoEvent): string[] {
  const wallets: string[] = [];
  if ("owner" in event && typeof event.owner === "string") wallets.push(event.owner);
  if ("player" in event && typeof event.player === "string") wallets.push(event.player);
  if ("payer" in event && typeof event.payer === "string") wallets.push(event.payer);
  return wallets;
}

/** The coin a decoded event names, when it names one. */
function coinIn(event: DecodedDiggoEvent): string | null {
  if ("coin" in event && typeof event.coin === "string") return event.coin;
  return null;
}

/**
 * Applies one decoded event.
 *
 * The event log is written first and always: it is the indexer's own record of what the chain
 * said, and a read-model update that fails afterwards can be rebuilt from it. Every read-model
 * update that follows is a refresh from chain rather than arithmetic on the event, so an event
 * that arrives twice cannot double-count anything.
 */
export async function applyEvent(
  env: RuntimeEnv,
  event: DecodedDiggoEvent,
  ctx: EventContext,
): Promise<void> {
  const coin = coinIn(event);
  const wallet = walletsIn(event)[0] ?? null;
  await env.DB.prepare(
    "INSERT OR IGNORE INTO coin_events" +
      " (signature, event_index, name, coin, wallet, slot, block_time, payload, created_at)" +
      " VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
  )
    .bind(
      ctx.signature,
      ctx.eventIndex ?? 0,
      event.name,
      coin,
      wallet,
      Number(ctx.slot),
      ctx.blockTime ?? 0,
      jsonSafe(event),
      nowSeconds(),
    )
    .run();
  switch (event.name) {
    case "CoinLaunched":
      await refreshCoin(env, event.mint);
      return;
    case "EpochSeedCommitted":
      await env.DB.prepare(
        "INSERT INTO epoch_seeds (coin, epoch_index, seed, target_slot, recorded_slot," +
          " signature, block_time, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)" +
          " ON CONFLICT(coin, epoch_index) DO UPDATE SET seed = excluded.seed," +
          " target_slot = excluded.target_slot, recorded_slot = excluded.recorded_slot," +
          " signature = excluded.signature, block_time = excluded.block_time",
      )
        .bind(
          event.coin,
          event.epochIndex,
          bytesToHex(event.seed),
          event.targetSlot.toString(),
          event.recordedSlot.toString(),
          ctx.signature,
          ctx.blockTime ?? 0,
          nowSeconds(),
        )
        .run();
      if (coin) await refreshCoinByAddress(env, coin);
      return;
    case "RewardsClaimed":
      await env.DB.prepare(
        "INSERT OR IGNORE INTO reward_events" +
          " (signature, event_index, coin, wallet, amount, slot, block_time, created_at)" +
          " VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
      )
        .bind(
          ctx.signature,
          ctx.eventIndex ?? 0,
          event.coin,
          event.owner,
          event.amount.toString(),
          Number(ctx.slot),
          ctx.blockTime ?? 0,
          nowSeconds(),
        )
        .run();
      await refreshPosition(env, event.coin, event.owner);
      return;
    case "DiscoveryRollCreated":
      await env.DB.prepare(
        "INSERT INTO discovery_events" +
          " (id, opportunity, coin, wallet, window_index, day_index, status, signature, slot," +
          "  block_time, created_at)" +
          " VALUES (?1,?2,?3,?4,?5,?6,'PENDING',?7,?8,?9,?10)" +
          " ON CONFLICT(opportunity) DO UPDATE SET window_index = excluded.window_index," +
          " day_index = excluded.day_index, signature = excluded.signature",
      )
        .bind(
          event.opportunity,
          event.opportunity,
          event.coin,
          event.owner,
          event.windowIndex,
          event.dayIndex,
          ctx.signature,
          Number(ctx.slot),
          ctx.blockTime ?? 0,
          nowSeconds(),
        )
        .run();
      await refreshPlayer(env, event.owner);
      return;
    case "DiscoverySettled":
      await env.DB.prepare(
        "UPDATE discovery_events SET status = 'SETTLED', rarity = ?1, units = ?2," +
          " value_lamports = ?3, signature = ?4, block_time = ?5 WHERE opportunity = ?6",
      )
        .bind(
          event.rarity,
          event.units.toString(),
          event.valueLamports.toString(),
          ctx.signature,
          ctx.blockTime ?? 0,
          event.opportunity,
        )
        .run();
      if (coin) await refreshCoinByAddress(env, coin);
      return;
    case "DiscoveryExpired":
      await env.DB.prepare(
        "UPDATE discovery_events SET status = 'EXPIRED', signature = ?1, block_time = ?2" +
          " WHERE opportunity = ?3",
      )
        .bind(ctx.signature, ctx.blockTime ?? 0, event.opportunity)
        .run();
      return;
    case "PlayerInitialized":
    case "Activated":
    case "OreCollected":
    case "CrewUpgraded":
    case "BondPosted":
    case "UnbondRequested":
    case "BondWithdrawn":
      await refreshPlayer(env, wallet ?? "");
      return;
    case "PowerAssigned":
    case "PowerRemoved":
      await refreshPosition(env, event.coin, event.owner);
      if (coin) await refreshCoinByAddress(env, coin);
      return;
    case "MineSwitched":
      await refreshPlayer(env, event.owner);
      await refreshPosition(env, event.fromCoin, event.owner);
      await refreshPosition(env, event.toCoin, event.owner);
      return;
    case "MarketGraduated":
    case "FeesSwept":
    case "CrankTipPaid":
    case "EpochAdvanced":
    case "EpochSeedTargetArmed":
    case "EpochSeedRearmed":
      if (coin) await refreshCoinByAddress(env, coin);
      return;
    case "SponsorVaultInitialized":
    case "SponsorEventCreated":
    case "SponsorSpend":
      await sweepSponsors(env);
      return;
    case "ProtocolInitialized":
      await sweepProtocolConfig(env);
      return;
  }
}

// --- sweeps --------------------------------------------------------------------------------

/** Walks recent signatures, applies their events, and records their trade instructions. */
export async function sweepSignatures(env: RuntimeEnv, reason: string): Promise<IndexerRunResult> {
  const run = await beginRun(env, `signatures:${reason}`);
  let events = 0;
  let accounts = 0;
  try {
    const cursor = await readCursor(env, "signatures");
    let until: string | undefined = cursor.cursor || undefined;
    let newest: { signature: string; slot: bigint } | null = null;
    for (let page = 0; page < maxSignaturePages(env); page++) {
      const batch = await readProgramSignatures(env as ChainEnv, {
        until,
        limit: signatureLimit(env),
      });
      if (batch.length === 0) break;
      const head = batch[0]!;
      if (!newest) newest = { signature: head.signature, slot: head.slot };
      for (const entry of batch) {
        const transaction = await readTransactionEvents(env as ChainEnv, entry.signature);
        if (!transaction) continue;
        for (const event of transaction.events) {
          await applyEvent(env, event, {
            signature: transaction.signature,
            slot: transaction.slot,
            blockTime: transaction.blockTime,
          });
          events += 1;
        }
        accounts += await recordTrades(
          env,
          transaction.signature,
          transaction.slot,
          transaction.blockTime,
        );
      }
      until = batch[batch.length - 1]!.signature;
    }
    if (newest) await writeCursor(env, "signatures", newest.signature, Number(newest.slot));
    await finishRun(env, run, { accounts, events });
    return { accounts, events };
  } catch (error) {
    await finishRun(env, run, { accounts, events, detail: String(error) }, "FAILED");
    throw error;
  }
}

/** One entry of a transaction's token balance table, as the runtime reports it. */
interface TokenBalanceEntry {
  accountIndex?: number;
  mint?: string;
  owner?: string;
  uiTokenAmount?: { amount?: string };
}

/** What one trade's received side is, and which path produced it. */
export interface TradeFill {
  amountOut: bigint;
  source: "meta" | "instruction";
  /** Wallet whose token balance moved; signer index 0 is the instruction fallback. */
  trader: string;
}

/**
 * The received amount of one trade, read from the transaction's own balance table.
 *
 * v2 emits no trade event, so this is what stands in for one: the wallet whose token balance for
 * this mint moved is the trader, and the size of that move is the fill. A buy receives tokens; a
 * sell receives lamports, which is the wallet's lamport delta plus the network fee it paid (the
 * fee is not part of what the venue paid out). Nothing here is inferred from a price: a spot price
 * written into a "received" column would be an invention, and this is the accounting the runtime
 * already did.
 *
 * Returns null when the response carries no balance table - a pruned or partially fetched
 * transaction - which the caller records as the instruction's input with source "instruction".
 * If the contract ever declares a v2 trade event, that event becomes the first source and this
 * becomes the second; the column it fills does not change.
 */
export function tradeFillFromMeta(input: {
  side: "BUY" | "SELL";
  mint: string;
  preTokenBalances?: readonly TokenBalanceEntry[];
  postTokenBalances?: readonly TokenBalanceEntry[];
  accountKeys: readonly string[];
  preBalances?: readonly number[];
  postBalances?: readonly number[];
  fee?: number;
}): TradeFill | null {
  const held = new Map<string, bigint>();
  for (const entry of input.preTokenBalances ?? []) {
    if (entry.mint !== input.mint || !entry.owner) continue;
    held.set(entry.owner, BigInt(entry.uiTokenAmount?.amount ?? "0"));
  }
  const moved = new Map<string, bigint>();
  for (const entry of input.postTokenBalances ?? []) {
    if (entry.mint !== input.mint || !entry.owner) continue;
    const before = held.get(entry.owner) ?? 0n;
    const after = BigInt(entry.uiTokenAmount?.amount ?? "0");
    if (after !== before) moved.set(entry.owner, after - before);
  }
  if (moved.size !== 1) return null;
  const [trader, tokenDelta] = [...moved.entries()][0]!;

  if (input.side === "BUY") {
    return tokenDelta > 0n ? { amountOut: tokenDelta, source: "meta", trader } : null;
  }
  if (tokenDelta >= 0n) return null;
  const index = input.accountKeys.indexOf(trader);
  const before = index >= 0 ? input.preBalances?.[index] : undefined;
  const after = index >= 0 ? input.postBalances?.[index] : undefined;
  if (before === undefined || after === undefined) return null;
  const received = BigInt(after - before) + BigInt(input.fee ?? 0);
  return received > 0n ? { amountOut: received, source: "meta", trader } : null;
}

/**
 * Records the trade instructions in one transaction.
 *
 * v2 emits no trade event, so a fill is read from the instruction that caused it and its received
 * side from the transaction's balance table (tradeFillFromMeta). What is stored is the input the
 * trader offered, what they received, where that number came from, and the venue's observed spot
 * price at that slot, each in its own column: writing the spot price as though it were the fill
 * would be an invention.
 */
export async function recordTrades(
  env: RuntimeEnv,
  signature: string,
  slot: bigint,
  blockTime: number | null,
): Promise<number> {
  const { getChainRpc, getProgramAddress } = await import("./chainV2");
  const rpc = getChainRpc(env as ChainEnv);
  const response = await rpc
    .getTransaction(signature as never, {
      commitment: "confirmed",
      encoding: "json",
      maxSupportedTransactionVersion: 0,
    })
    .send()
    .catch(() => null);
  const result = response as unknown as {
    transaction?: {
      message?: {
        instructions?: readonly { programIdIndex?: number; data?: string }[];
        accountKeys?: readonly (string | { pubkey: string })[];
      };
    };
    meta?: {
      fee?: number;
      preBalances?: readonly number[];
      postBalances?: readonly number[];
      preTokenBalances?: readonly TokenBalanceEntry[];
      postTokenBalances?: readonly TokenBalanceEntry[];
      loadedAddresses?: { writable?: readonly string[]; readonly?: readonly string[] };
    };
  } | null;
  const message = result?.transaction?.message;
  if (!message) return 0;
  const program = getProgramAddress(env as ChainEnv);
  const staticKeys = (message.accountKeys ?? []).map((key) =>
    typeof key === "string" ? key : key.pubkey,
  );
  const allKeys = [
    ...staticKeys,
    ...(result?.meta?.loadedAddresses?.writable ?? []),
    ...(result?.meta?.loadedAddresses?.readonly ?? []),
  ];
  let recorded = 0;
  const instructions = message.instructions ?? [];
  for (let index = 0; index < instructions.length; index++) {
    const instruction = instructions[index]!;
    if (allKeys[instruction.programIdIndex ?? -1] !== program) continue;
    if (typeof instruction.data !== "string") continue;
    const decoded = decodeTradeInstruction(base64ToBytes(instruction.data));
    if (!decoded) continue;
    // Every trade instruction lists the coin account first, before the mint and the vaults.
    const coinAddress = allKeys[1] ?? "";
    const coinRow = await env.DB.prepare("SELECT mint, venue FROM coins WHERE coin = ?1")
      .bind(coinAddress)
      .first<{ mint: string; venue: string }>();
    if (!coinRow) continue;
    const sample = await env.DB.prepare(
      "SELECT price_sol FROM coin_price_samples WHERE mint = ?1 ORDER BY observed_at DESC LIMIT 1",
    )
      .bind(coinRow.mint)
      .first<{ price_sol: number }>();
    const side = decoded.kind === "buy" || decoded.kind === "pool_buy" ? "BUY" : "SELL";
    const trader = allKeys[0] ?? "";
    const fill = tradeFillFromMeta({
      side,
      mint: coinRow.mint,
      preTokenBalances: result?.meta?.preTokenBalances,
      postTokenBalances: result?.meta?.postTokenBalances,
      accountKeys: allKeys,
      preBalances: result?.meta?.preBalances,
      postBalances: result?.meta?.postBalances,
      fee: result?.meta?.fee,
    }) ?? { amountOut: 0n, source: "instruction" as const, trader };
    await env.DB.prepare(
      "INSERT OR IGNORE INTO trades" +
        " (signature, instruction_index, mint, coin, side, venue, amount_in, amount_out," +
        "  fill_source, price_sol, block_time, slot, indexed_at, trader_wallet)" +
        " VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
    )
      .bind(
        signature,
        index,
        coinRow.mint,
        coinAddress,
        side,
        coinRow.venue,
        decoded.amountIn.toString(),
        fill.amountOut.toString(),
        fill.source,
        sample?.price_sol ?? 0,
        blockTime ?? 0,
        slot.toString(),
        nowSeconds(),
        fill.trader,
      )
      .run();
    recorded += 1;
  }
  if (recorded > 0) {
    await env.DB.batch(
      allKeys.map((wallet) =>
        env.DB.prepare("INSERT OR IGNORE INTO trade_participants (signature, wallet) VALUES (?1, ?2)")
          .bind(signature, wallet),
      ),
    );
  }
  return recorded;
}

/** Re-reads every program account of every v2 kind, plus every wallet it has seen. */
export async function sweepAccounts(env: RuntimeEnv): Promise<IndexerRunResult> {
  const run = await beginRun(env, "accounts");
  let accounts = 0;
  try {
    const slot = await readCurrentSlot(env as ChainEnv);
    await sweepProtocolConfig(env, slot);
    accounts += 1;
    const pools = await listPools(env as ChainEnv);
    for (const pool of pools) {
      await writePool(env, pool.address, pool.data, slot);
      accounts += 1;
    }
    const coins = (await listCoins(env as ChainEnv)).slice(0, coinLimit(env));
    for (const coin of coins) {
      const mint = pools.find((pool) => pool.data.coin === coin.address)?.data.mint ??
        (await mintOfCoin(env, coin.address));
      if (!mint) continue;
      const pool = pools.find((entry) => entry.data.mint === mint)?.data ?? null;
      const decimals = (await readMintInfo(env as ChainEnv, mint).catch(() => null))?.decimals ?? 6;
      const solUsd = await displaySolUsd(env);
      const priceSol = spotPriceLamports(coin.data, pool, decimals) / 1_000_000_000;
      const metrics = await read24hMetrics(env, mint, priceSol);
      await writeCoin(env, coin.address, mint, coin.data, slot);
      await writeTokenRow(
        env,
        coin.address,
        mint,
        coin.data,
        pool,
        decimals,
        metrics,
        await displayMeta(env, mint, solUsd),
      );
      await writePriceSample(env, mint, priceSol, slot, PRICE_SAMPLE_RETENTION_SECONDS);
      await checkLedgerInvariant(env, mint, coin.data);
      accounts += 1;
    }
    for (const budget of await listGlobalBudgets(env as ChainEnv)) {
      await writeGlobalBudget(env, budget.data, slot);
      accounts += 1;
    }
    accounts += await sweepSponsors(env, slot);
    accounts += await sweepPositions(env, slot);
    accounts += await sweepPendingOpportunities(env);
    // Every wallet the indexer has ever seen, oldest mirror first, so a player's own row follows
    // the chain even when no webhook is configured.
    const wallets = await env.DB.prepare(
      "SELECT wallet FROM players ORDER BY COALESCE(indexed_at, 0) ASC LIMIT ?1",
    )
      .bind(coinLimit(env))
      .all<{ wallet: string }>();
    for (const row of wallets.results ?? []) {
      if (await refreshPlayer(env, row.wallet)) accounts += 1;
    }
    await writeCursor(env, "accounts", "", Number(slot));
    await finishRun(env, run, { accounts, events: 0 });
    return { accounts, events: 0 };
  } catch (error) {
    await finishRun(env, run, { accounts, events: 0, detail: String(error) }, "FAILED");
    throw error;
  }
}

/**
 * Positions store neither the coin nor the owner - both are PDA seeds - so their identity has to
 * come from what the indexer already learned, which is the `PowerAssigned` event's (coin, owner)
 * pair. A position whose account is gone is deleted rather than left behind.
 */
async function sweepPositions(env: RuntimeEnv, slot: bigint): Promise<number> {
  const known = await env.DB.prepare(
    "SELECT position, coin, owner FROM mining_positions_v2",
  ).all<{ position: string; coin: string; owner: string }>();
  let accounts = 0;
  for (const row of known.results ?? []) {
    const position = await readDecodedAccount(
      env as ChainEnv,
      row.position,
      "MiningPosition",
      decodeMiningPosition,
    ).catch(() => null);
    if (!position) {
      await deletePosition(env, row.position);
      continue;
    }
    await writePosition(env, row.position, row.coin, row.owner, position.data, slot);
    accounts += 1;
  }
  return accounts;
}

/** Pending opportunities are re-read from their own addresses until an event closes them. */
async function sweepPendingOpportunities(env: RuntimeEnv): Promise<number> {
  const pending = await env.DB.prepare(
    "SELECT opportunity FROM discovery_events WHERE status = 'PENDING'",
  ).all<{ opportunity: string }>();
  let accounts = 0;
  for (const row of pending.results ?? []) {
    const account = await readDecodedAccount(
      env as ChainEnv,
      row.opportunity,
      "DiscoveryOpportunity",
      decodeDiscoveryOpportunity,
    ).catch(() => null);
    if (!account) continue;
    await env.DB.prepare(
      "UPDATE discovery_events SET epoch_index = ?1, budget_lamports = ?2 WHERE opportunity = ?3",
    )
      .bind(account.data.epochIndex, account.data.budgetLamports.toString(), row.opportunity)
      .run();
    accounts += 1;
  }
  return accounts;
}

async function sweepSponsors(env: RuntimeEnv, slot = 0n): Promise<number> {
  let accounts = 0;
  for (const vault of await listSponsorVaults(env as ChainEnv).catch(() => [])) {
    await writeSponsorVault(env, vault.address, vault.data, slot);
    accounts += 1;
  }
  for (const event of await listSponsorEvents(env as ChainEnv).catch(() => [])) {
    await writeSponsorEvent(env, event.address, event.data, slot);
    accounts += 1;
  }
  for (const grant of await listSponsorGrants(env as ChainEnv).catch(() => [])) {
    // The grant's event and subject are PDA seeds and are not stored, so a blind sweep cannot
    // recover them; a grant whose event is already known keeps the one the indexer recorded.
    const existing = await env.DB.prepare(
      "SELECT event, subject FROM sponsor_grants WHERE grant = ?1",
    )
      .bind(grant.address)
      .first<{ event: string; subject: string }>();
    await writeSponsorGrant(
      env,
      grant.address,
      existing?.event ?? "",
      existing?.subject ?? "",
      grant.data,
      slot,
    );
    accounts += 1;
  }
  return accounts;
}

export async function sweepProtocolConfig(env: RuntimeEnv, slot = 0n): Promise<void> {
  const config = await readProtocolConfig(env as ChainEnv).catch(() => null);
  if (config) await writeProtocolConfig(env, config.data, slot || config.slot);
}

// --- intake --------------------------------------------------------------------------------

/** The subset of a Helius webhook item this handler reads. Everything else is ignored. */
export interface HeliusWebhookItem {
  signature?: string;
  slot?: number;
  blockTime?: number | null;
  transaction?: { signatures?: readonly string[] };
  accountData?: readonly { account: string }[];
}

/**
 * The Helius webhook: authenticated, normalized into queue jobs, and never trusted for content.
 *
 * A webhook only ever says "look at this signature" or "look at this account"; the facts are
 * always re-read from chain by the consumer. A forged or replayed delivery can therefore at most
 * cause a redundant read, which is the only failure mode worth having on an unauthenticated-ish
 * boundary.
 */
export async function heliusWebhook(request: Request, env: RuntimeEnv): Promise<Response> {
  if (!sameSecret(request.headers.get("authorization"), env.HELIUS_WEBHOOK_AUTH)) {
    return apiError("Unauthorized", 401);
  }
  const payload = await readJson<unknown>(request, 1_000_000);
  const items = Array.isArray(payload) ? payload : [payload];
  const jobs: IndexerJob[] = [];
  for (const raw of items as HeliusWebhookItem[]) {
    const signature = raw.signature ?? raw.transaction?.signatures?.[0];
    if (signature) {
      jobs.push({
        type: "events",
        signature,
        slot: Number(raw.slot ?? 0),
        blockTime: raw.blockTime ?? null,
      });
      continue;
    }
    const account = raw.accountData?.[0]?.account;
    if (account) jobs.push({ type: "account", address: account, kind: "unknown" });
  }
  if (jobs.length === 0) return apiError("Invalid Helius payload", 400);
  for (let index = 0; index < jobs.length; index += 100) {
    await env.INDEXING_QUEUE.sendBatch(jobs.slice(index, index + 100).map((body) => ({ body })));
  }
  return json({ accepted: jobs.length });
}

/** Applies one queue job. Every branch re-reads chain; none trusts the job's own payload. */
export async function processIndexerJob(job: IndexerJob, env: RuntimeEnv): Promise<void> {
  switch (job.type) {
    case "events": {
      const transaction = await readTransactionEvents(env as ChainEnv, job.signature);
      if (!transaction) return;
      for (const event of transaction.events) {
        await applyEvent(env, event, {
          signature: transaction.signature,
          slot: transaction.slot,
          blockTime: transaction.blockTime,
        });
      }
      await recordTrades(env, transaction.signature, transaction.slot, transaction.blockTime);
      return;
    }
    case "account": {
      // An account notification is a hint about which coin moved; the coin is re-read by mint.
      const row = await env.DB.prepare("SELECT mint FROM coins WHERE coin = ?1")
        .bind(job.address)
        .first<{ mint: string }>();
      if (row?.mint) await refreshCoin(env, row.mint);
      return;
    }
    case "coin":
      await refreshCoin(env, job.mint);
      return;
    case "player":
      await refreshPlayer(env, job.wallet);
      return;
    case "sweep":
      await sweepSignatures(env, job.reason);
      return;
  }
}

// --- cron ----------------------------------------------------------------------------------

/**
 * One indexing pass. Both intakes run and neither can stop the other: a failed signature sweep
 * still lets the account sweep repair the mirror, and vice versa. Nothing here throws, because a
 * cron failure should be a log line, not a retry storm against an RPC that is already unhappy.
 */
export async function indexerCron(env: RuntimeEnv): Promise<{ events: number; accounts: number }> {
  let events = 0;
  let accounts = 0;
  try {
    events = (await sweepSignatures(env, "cron")).events;
  } catch (error) {
    console.error(JSON.stringify({ event: "indexer.signatures_failed", error: String(error) }));
    await metric(env, "indexer.signatures_failed", 1);
  }
  try {
    accounts = (await sweepAccounts(env)).accounts;
  } catch (error) {
    console.error(JSON.stringify({ event: "indexer.accounts_failed", error: String(error) }));
    await metric(env, "indexer.accounts_failed", 1);
  }
  await pruneDiagnostics(env);
  return { events, accounts };
}

/** Keeps the diagnostic tables from growing without bound. */
async function pruneDiagnostics(env: RuntimeEnv): Promise<void> {
  const cutoff = nowSeconds() - 7 * 24 * 3_600;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM indexer_runs WHERE started_at < ?1").bind(cutoff),
    env.DB.prepare("DELETE FROM coin_events WHERE created_at < ?1").bind(cutoff),
    env.DB.prepare("DELETE FROM advisory_alerts WHERE created_at < ?1").bind(cutoff),
    env.DB.prepare("DELETE FROM crank_runs WHERE created_at < ?1").bind(cutoff),
  ]);
}

/** Coins whose ledger is behind the present, i.e. coins a permissionless advance would help. */
export async function advanceDueCoins(env: RuntimeEnv, now = nowSeconds()): Promise<string[]> {
  const rows = await env.DB.prepare(
    "SELECT mint FROM coins WHERE next_block_at > 0 AND next_block_at < ?1",
  )
    .bind(now)
    .all<{ mint: string }>();
  return (rows.results ?? []).map((row) => row.mint);
}

/** Whether a sponsor event is live right now. Sponsorship never touches power or discovery. */
export function sponsorEventActive(
  event: { startAt: bigint; endAt: bigint; paused: number },
  now: number,
): boolean {
  return event.paused === 0 && BigInt(now) >= event.startAt && BigInt(now) <= event.endAt;
}

/** True when a launch was subsidised: a sponsor event paid the rent rather than the creator. */
export function launchWasSubsidised(sponsorEvent: string): boolean {
  return !isDefaultPubkey(sponsorEvent);
}

/** Lamports to SOL, re-exported for the read API's display conversions. */
export { lamportsToSol, coinSlug, TOKEN_CACHE_KEY };
