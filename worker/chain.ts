/**
 * Reads live state directly from the diggo_protocol Solana program and keeps D1's `tokens`
 * table as an honest cache of it. Nothing here fabricates data — every numeric field comes
 * from decoding a real account fetched over RPC (see shared/program.ts).
 */
import {
  type Address,
  address,
  createSolanaRpc,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";
import {
  decodeMine,
  deriveMineAddresses,
  bondingCurveSpotPriceLamports,
  poolSpotPriceLamports,
  type DecodedMine,
  type DecodedLaunchMarket,
} from "../shared/program";
// keeperReadVenue lives next to the keeper because the keeper is what graduates a market, and it
// is the one place that knows a market can have two venues. keeper.ts imports getChainRpc from
// this module, so the two form an import cycle — safe here because neither module calls the other
// at module scope, only from inside the functions below.
import { keeperReadVenue, type MarketVenue } from "./keeper";
import {
  type CurveMiningSummary,
  type CurveSellCapacitySummary,
  type TokenChange24h,
  type TokenStatus,
  type TokenSummary,
} from "../shared/types";
import {
  curveMiningProgress,
  curveMiningRoom,
  curveMiningStateOf,
  curveSellCapacity,
  isCurveMiningDisabled,
  isCurveMiningOpen,
} from "../shared/curve";
import { DIGGO_CONFIG, type DiggoConfig } from "../shared/config";
import type { RuntimeEnv } from "./env";
import { getSolUsd, ILLUSTRATIVE_DEVNET_SOL_USD } from "./oracle";

export const DEFAULT_DEVNET_RPC = "https://api.devnet.solana.com";

export const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * The SOL/USD rate used for the display-only USD columns of a synced token.
 *
 * It comes from the oracle's cached observations (worker/oracle.ts), which cron keeps warm from
 * Pyth Hermes and Jupiter. When no source is fresh the oracle itself answers with
 * ILLUSTRATIVE_DEVNET_SOL_USD and says so, so an unconfigured deployment keeps the old behaviour
 * instead of breaking the sync. Never treat priceUsd as authoritative: priceSol, read straight
 * from the bonding curve, is the real value, and settlement never reads the USD columns at all.
 */
async function displaySolUsd(env: RuntimeEnv): Promise<number> {
  try {
    const quote = await getSolUsd(env);
    if (!quote.fromOracle) {
      // Labelled, not hidden: the USD columns are a display conversion and this says out loud
      // that no oracle source was fresh, so nothing downstream can mistake it for a real rate.
      console.warn(
        JSON.stringify({ event: "chain.sol_usd_fallback", source: quote.source, priceUsd: quote.priceUsd }),
      );
    }
    return quote.priceUsd;
  } catch (error) {
    // A display conversion must never fail a chain sync that has already read the accounts.
    console.error(JSON.stringify({ event: "chain.sol_usd_unavailable", error: String(error) }));
    return ILLUSTRATIVE_DEVNET_SOL_USD;
  }
}

let cachedRpc: Rpc<SolanaRpcApi> | null = null;
let cachedRpcUrl: string | null = null;

export function getChainRpc(env: { DIGGO_RPC_URL?: string }): Rpc<SolanaRpcApi> {
  const url = env.DIGGO_RPC_URL || DEFAULT_DEVNET_RPC;
  if (cachedRpc && cachedRpcUrl === url) return cachedRpc;
  cachedRpc = createSolanaRpc(url);
  cachedRpcUrl = url;
  return cachedRpc;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
/** One token's measured 24h window. */
export interface Token24hMetrics {
  /** Percent change against the baseline observation, or null when there is none to show. */
  change24h: TokenChange24h;
  /** The baseline's observed_at, or 0 when no change is reported. */
  change24hAt: number;
  /** Indexed traded volume in the window, in USD. */
  volume24hUsd: number;
  /** Indexed trades in the window. */
  trades24h: number;
}

/**
 * The honest 24h change: the live price against an observation at least a day old, or null.
 *
 * Both halves have to be there. A percentage with no day-old observation is not a 24h change,
 * and one with no indexed trade behind it describes a window in which this token's market did
 * nothing at all, so it answers unknown rather than a fabricated 0%. Null is not zero, and
 * every client is expected to render it that way.
 *
 * Rounded to two decimals because the underlying prices are floats: reporting more digits than
 * the measurement supports would be a different kind of invented precision.
 */
export function change24hOf(input: {
  priceUsd: number;
  baselinePriceUsd: number | null;
  trades24h: number;
}): number | null {
  const baseline = input.baselinePriceUsd;
  if (baseline === null || !(baseline > 0)) return null;
  if (!(input.trades24h > 0)) return null;
  if (!(input.priceUsd > 0)) return null;
  const change = (input.priceUsd / baseline - 1) * 100;
  if (!Number.isFinite(change)) return null;
  return Math.round(change * 100) / 100;
}

/**
 * Reads one token's 24h window out of what the indexer has already recorded: its own price
 * observations (token_price_samples, appended by the epoch sync) and its indexed trades.
 *
 * The baseline is the newest observation at or before now - changeBaselineSeconds, a whole day
 * less an hour of slack: the sampler runs on a schedule rather than exactly on the hour, so
 * demanding a full 24 hours would report nothing at all on a real deployment. Nothing here
 * fabricates a value: a token with no history reads as unknown.
 */
export async function readToken24hMetrics(
  env: RuntimeEnv,
  mint: string,
  priceUsd: number,
  now: number,
  config: DiggoConfig = DIGGO_CONFIG,
): Promise<Token24hMetrics> {
  const baselineBefore = now - config.curve.changeBaselineSeconds;
  const windowStart = now - config.curve.volumeWindowSeconds;
  const [baseline, traded] = await Promise.all([
    env.DB.prepare(
      "SELECT price_usd, observed_at FROM token_price_samples" +
        " WHERE mint = ?1 AND observed_at <= ?2 ORDER BY observed_at DESC LIMIT 1",
    )
      .bind(mint, baselineBefore)
      .first<{ price_usd: number; observed_at: number }>(),
    env.DB.prepare(
      "SELECT COALESCE(SUM(amount * price_usd), 0) AS volume_usd, COUNT(*) AS trades" +
        " FROM trades WHERE mint = ?1 AND block_time >= ?2",
    )
      .bind(mint, windowStart)
      .first<{ volume_usd: number; trades: number }>(),
  ]);
  const trades24h = Math.max(0, Number(traded?.trades ?? 0));
  const volume24hUsd = Math.max(0, Number(traded?.volume_usd ?? 0));
  const baselinePriceUsd = baseline ? Number(baseline.price_usd) : null;
  const change24h = change24hOf({ priceUsd, baselinePriceUsd, trades24h });
  return {
    change24h,
    change24hAt: change24h === null ? 0 : Number(baseline?.observed_at ?? 0),
    volume24hUsd,
    trades24h,
  };
}

export interface MintInfo {
  decimals: number;
  /**
   * A revoked mint authority means no new supply can ever be created, which is what makes a mine's
   * fixed supply honest. Read straight from the SPL mint, not assumed.
   */
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
}

function readU32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0
  );
}

/**
 * SPL Token Mint account layout: mintAuthorityOption (u32) 0, mintAuthority 4..36, supply 36..44,
 * decimals 44, isInitialized 45, freezeAuthorityOption (u32) 46..50, freezeAuthority 50..82.
 * A COption is "Some" when its tag is 1, so authority revoked === tag 0.
 *
 * An unrecognised (too short) layout reports the authorities as NOT revoked: unknown is treated as
 * worse health, so an unreadable mint can only ever lower a discovery's rarity, never raise it.
 */
export async function readMintInfo(rpc: Rpc<SolanaRpcApi>, mint: Address): Promise<MintInfo> {
  const info = await rpc.getAccountInfo(mint, { commitment: "confirmed", encoding: "base64" }).send();
  if (!info.value) throw new Error(`Mint account not found: ${mint}`);
  const bytes = base64ToBytes(info.value.data[0]);
  const recognized = bytes.length >= 82;
  return {
    decimals: bytes[44] ?? 6,
    mintAuthorityRevoked: recognized && readU32LE(bytes, 0) === 0,
    freezeAuthorityRevoked: recognized && readU32LE(bytes, 46) === 0,
  };
}

export function mineStatusToTokenStatus(mine: DecodedMine, market: DecodedLaunchMarket): TokenStatus {
  // The program's own terminal state, which it now only reaches with a spent Mining Reserve
  // after graduation: nothing is left to pay, whatever the venue says.
  if (mine.status === "FullyMined") return "FULLY_MINED";
  if (market.graduated) {
    // Post-graduation the Mining Reserve is the only source, so the mine is finished exactly
    // when that reserve is empty - the walk sets FullyMined a moment later, and reporting it
    // here keeps the cache honest in between.
    return mine.remainingReserve <= 0n ? "FULLY_MINED" : "MINING_ACTIVE";
  }
  // Still on the curve: mining is live from the launch block and its budget is the curve's own
  // token inventory. If that has room, the mine is actively emitting. If it is spent - or the
  // market never had one, which is what a legacy market reads as after migration - the mine is
  // idle: its blocks accrue nothing until graduation, and the Mining Reserve it has not touched
  // is what starts paying then. That is CURVE_CAP_REACHED, deliberately not FULLY_MINED: a
  // FULLY_MINED token is one a client can stop tracking, and this one must stay in the sync
  // loop precisely so that graduation is noticed.
  if (isCurveMiningOpen(curveMiningStateOf(market))) return "MINING_ACTIVE";
  return "CURVE_CAP_REACHED";
}

export interface ChainSyncedToken {
  mint: string;
  name: string;
  symbol: string;
  creator: string;
  status: TokenStatus;
  priceSol: number;
  priceUsd: number;
  marketCapUsd: number;
  reserveRemaining: number;
  reserveTotal: number;
  rewardPerBlock: number;
  networkPower: number;
  nextBlockAt: number;
  nextEpochAt: number;
  decimals: number;
  /** Program-controlled Discovery Reserve, in whole tokens (spec 23). */
  discoveryReserveRemaining: number;
  discoveryReserveTotal: number;
  discoveryEpochBudget: number;
  discoveryEpochSpent: number;
  discoveryEpochEndsAt: number;
  /** The program's own per-mine discovery circuit breaker (spec 65). */
  discoveryPaused: boolean;
  /** Program-controlled liquidity backing the price, in USD at the oracle's SOL/USD rate. */
  liquidityUsd: number;
  /** Which venue the price came from: the bonding curve, or the locked pool. */
  venue: MarketVenueName;
  /** Real SOL backing the price in that venue, in lamports. */
  liquidityLamports: bigint;
  /**
   * True when the market has genuinely reached its graduation target and still has no pool, i.e.
   * the one state where calling graduate_market can do anything at all (spec 36).
   */
  graduationReady: boolean;
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  /**
   * Always true for this protocol: the bonding-curve SOL and the post-graduation LP are held in
   * program PDAs, so no creator or admin can withdraw them (spec 35, 36).
   */
  liquidityLocked: boolean;
  /**
   * Real 24h change, measured from this token's own indexed observations, or null when it
   * cannot be measured honestly. See change24hOf: null is unknown, never zero.
   */
  change24h: TokenChange24h;
  /** The observed_at the change was measured against, or 0 when there is no change to show. */
  change24hAt: number;
  /** Indexed traded volume over the same 24h window, in USD. */
  volume24hUsd: number;
  /** Indexed trades in that window; the ranking signal when change24h is unknown. */
  trades24h: number;
  /** Curve-phase mining: how much of the pre-graduation budget is left. */
  curveMining: CurveMiningSummary;
  /** What a seller can really get out of the curve right now. */
  sellCapacity: CurveSellCapacitySummary;
}

/**
 * Which venue a market trades on. Before graduation that is its bonding curve; after
 * `graduate_market` moved the curve's whole liquidity into the program-owned constant-product
 * pool, it is the pool, and the market's own curve reserves are zero by design (spec 36).
 */
export type MarketVenueName = "curve" | "pool";

/**
 * The reserves that actually back a market's price.
 *
 * A graduated market's `token_reserve` and `sol_reserve` are both zero — the liquidity lives in
 * the pool — so pricing a graduated mine from its market account alone would index it at zero.
 * Reads the pool whenever the market is graduated, whether or not the pool account came back
 * this time: a zero is the honest answer to "the venue I must price from is unreadable", and it
 * is visibly wrong rather than plausibly wrong.
 */
export function venueSpotPriceLamports(venue: MarketVenue, decimals: number): number {
  if (venue.graduated) {
    return venue.pool ? poolSpotPriceLamports(venue.pool, decimals) : 0;
  }
  return bondingCurveSpotPriceLamports(venue.market, decimals);
}

/** Real SOL backing the price, in lamports, read from whichever venue holds it. */
export function venueLiquidityLamports(venue: MarketVenue): bigint {
  return venue.graduated && venue.pool ? venue.pool.solReserve : venue.market.solReserve;
}

/**
 * True only when the indexing loop should ask the keeper to graduate this market: the curve has
 * reached its target, the market is not graduated yet, and no pool exists. This mirrors
 * keeperGraduateMarket's own no-op conditions, so the loop does not spend a keeper call (and a
 * fee-payer's SOL) on a market that has nothing to do. A zero target is not a graduation target
 * and never triggers one.
 */
export function needsGraduation(venue: MarketVenue): boolean {
  return (
    !venue.graduated &&
    venue.pool === null &&
    venue.market.graduationTarget > 0n &&
    venue.market.solReserve >= venue.market.graduationTarget
  );
}

export interface SyncedTokenInput {
  mintAddress: string;
  mine: DecodedMine;
  venue: MarketVenue;
  mintInfo: MintInfo;
  decimals: number;
  /** SOL/USD for the display-only USD columns; see displaySolUsd. */
  solUsd: number;
  /** The token's measured 24h window, read from what the indexer has already recorded. */
  metrics: Token24hMetrics;
}

/**
 * Assembles the `tokens` cache fields from already-decoded accounts. Kept pure and separate from
 * the RPC reads so the venue arithmetic — price, liquidity, market cap — can be exercised
 * directly, including the post-graduation case where reading the market alone yields zero.
 */
export function buildSyncedToken(input: SyncedTokenInput): ChainSyncedToken {
  const { mine, venue, decimals, solUsd } = input;
  const scale = 10 ** decimals;
  const priceSol = venueSpotPriceLamports(venue, decimals) / 1_000_000_000;
  const priceUsd = priceSol * solUsd;
  const totalSupplyWhole = Number(mine.totalSupply) / scale;
  const liquidityLamports = venueLiquidityLamports(venue);
  const whole = (value: bigint) => Number(value) / scale;
  // The curve ledger lives on the market, so it is read from whichever account the venue
  // read actually returned. A graduated market reports a closed, empty ledger: its emission
  // moved to the Mining Reserve and its curve inventory moved into the pool.
  const curve = curveMiningStateOf(venue.market);
  const capacity = curveSellCapacity(venue.market);
  return {
    mint: input.mintAddress,
    name: mine.name,
    symbol: mine.symbol,
    creator: mine.creator,
    status: mineStatusToTokenStatus(mine, venue.market),
    priceSol,
    priceUsd,
    marketCapUsd: priceUsd * totalSupplyWhole,
    reserveRemaining: Number(mine.remainingReserve) / scale,
    reserveTotal: Number(mine.remainingReserve + mine.cumulativeDistributed) / scale,
    rewardPerBlock: Number(mine.currentBlockReward) / scale,
    networkPower: Number(mine.totalPower),
    nextBlockAt: Number(mine.nextBlockAt),
    nextEpochAt: Number(mine.epochEndsAt),
    decimals,
    discoveryReserveRemaining: Number(mine.remainingDiscoveryReserve) / scale,
    discoveryReserveTotal: Number(mine.discoveryReserveTotal) / scale,
    discoveryEpochBudget: Number(mine.discoveryEpochBudget) / scale,
    discoveryEpochSpent: Number(mine.discoveryEpochSpent) / scale,
    discoveryEpochEndsAt: Number(mine.discoveryEpochEndsAt),
    discoveryPaused: mine.discoveryPaused,
    liquidityUsd: (Number(liquidityLamports) / 1_000_000_000) * solUsd,
    venue: venue.graduated ? "pool" : "curve",
    liquidityLamports,
    graduationReady: needsGraduation(venue),
    mintAuthorityRevoked: input.mintInfo.mintAuthorityRevoked,
    freezeAuthorityRevoked: input.mintInfo.freezeAuthorityRevoked,
    liquidityLocked: true,
    change24h: input.metrics.change24h,
    change24hAt: input.metrics.change24hAt,
    volume24hUsd: input.metrics.volume24hUsd,
    trades24h: input.metrics.trades24h,
   curveMining: {
     open: isCurveMiningOpen(curve),
      // A market on its curve that never had a budget at all - launched with a zero share, or
      // written before the ledger existed, where a migration can only default the cap to zero.
      // The UI has to say "mining starts at graduation" for these rather than draw a progress
      // bar over a budget that was never granted.
      disabled: isCurveMiningDisabled(curve),
      onCurve: !venue.graduated,
      cap: whole(curve.cap),
      mined: whole(curve.mined),
      remaining: whole(curveMiningRoom(curve)),
      progress: curveMiningProgress(curve),
      blockReward: whole(curve.blockReward),
      unpaid: whole(curve.unpaid),
    },
    sellCapacity: {
      sol: Number(capacity.realSolLamports) / LAMPORTS_PER_SOL,
      tokens: capacity.tokensForFullCapacity === null ? null : whole(capacity.tokensForFullCapacity),
    },
  };
}

/**
 * Fetches a mine's Mine + LaunchMarket accounts (plus its pool once it has graduated, and its
 * mint's decimals) directly from the chain and returns the fields diggo's `tokens` cache needs.
 * Throws if the mine has not actually been launched on-chain — callers should not silently fall
 * back to fabricated data.
 *
 * The venue read is what keeps a graduated mine priced: after graduation the market's own
 * reserves are zero and only the pool has liquidity.
 */
export async function readTokenFromChain(
  env: RuntimeEnv,
  mintAddress: string,
): Promise<ChainSyncedToken> {
  const rpc = getChainRpc(env);
  const programAddress = address(env.DIGGO_PROGRAM_ID);
  const mint = address(mintAddress);
  const { mine } = await deriveMineAddresses(programAddress, mint);

  const [mineInfo, mintInfo, venueRead] = await Promise.all([
    rpc.getAccountInfo(mine, { commitment: "confirmed", encoding: "base64" }).send(),
    readMintInfo(rpc, mint),
    keeperReadVenue(env, mintAddress),
  ]);
  if (!mineInfo.value) throw new Error(`Mine account not found on-chain for mint ${mintAddress}`);
  if (!venueRead) throw new Error(`Market account not found on-chain for mint ${mintAddress}`);

  const venue = await settledVenue(env, mintAddress, venueRead);
  const solUsd = await displaySolUsd(env);
  const decodedMine = decodeMine(base64ToBytes(mineInfo.value.data[0]));
  const metrics = await readToken24hMetrics(
    env,
    mintAddress,
    venueSpotPriceLamports(venue, mintInfo.decimals) / 1_000_000_000 * solUsd,
    Math.floor(Date.now() / 1_000),
  );
  return buildSyncedToken({
    mintAddress,
    mine: decodedMine,
    venue,
    mintInfo,
    decimals: mintInfo.decimals,
    solUsd,
    metrics,
  });
}

/**
 * graduation creates the flag and the pool in a single instruction, so a graduated market always
 * has a pool and one unreadable pool account means this RPC had not caught up yet. Re-reading
 * once turns that transient miss into the right price; a second miss is logged and left to be
 * corrected by the next sync pass rather than papered over with a made-up price.
 */
async function settledVenue(
  env: RuntimeEnv,
  mintAddress: string,
  first: MarketVenue,
): Promise<MarketVenue> {
  if (!first.graduated || first.pool) return first;
  await new Promise((resolve) => setTimeout(resolve, 250));
  const second = await keeperReadVenue(env, mintAddress);
  if (second?.pool) return second;
  console.warn(
    JSON.stringify({
      event: "chain.pool_unreadable",
      mint: mintAddress,
      solReserve: first.market.solReserve.toString(),
    }),
  );
  return second ?? first;
}

function slugify(symbol: string, mint: string): string {
  const base = symbol.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return base ? `${base}-${mint.slice(0, 4).toLowerCase()}` : mint.toLowerCase();
}

/**
 * Re-reads a mine from chain and upserts D1's cache row, returning both the row the API serves and
 * the chain facts D1 does not store — the venue the price came from and whether the market still
 * needs graduating. One read answers both questions, so the indexing loop does not pay for a
 * second pass over the same accounts.
 */
export async function syncTokenWithVenue(
  env: RuntimeEnv,
  mintAddress: string,
  metadata?: { description?: string; imageKey?: string | null },
): Promise<{ token: TokenSummary; chain: ChainSyncedToken }> {
  const chain = await readTokenFromChain(env, mintAddress);
  const existing = await env.DB.prepare("SELECT slug, description, image_key, created_at FROM tokens WHERE mint = ?1")
    .bind(mintAddress)
    .first<{ slug: string; description: string; image_key: string | null; created_at: number }>();

  const slug = existing?.slug ?? slugify(chain.symbol, mintAddress);
  const description = metadata?.description ?? existing?.description ?? "";
  const imageKey = metadata?.imageKey !== undefined ? metadata.imageKey : (existing?.image_key ?? null);
  const now = Math.floor(Date.now() / 1_000);
  const createdAt = existing?.created_at ?? now;

  await env.DB.prepare(
    `INSERT INTO tokens (
       mint, slug, name, symbol, description, creator, image_key, status,
       price_usd, price_sol, change_24h, market_cap_usd, reserve_remaining, reserve_total,
       reward_per_block, network_power, next_block_at, next_epoch_at, decimals, synced_at, created_at,
       discovery_reserve_remaining, discovery_reserve_total, discovery_epoch_budget,
       discovery_epoch_spent, discovery_epoch_ends_at, discovery_paused, liquidity_usd,
       mint_authority_revoked, freeze_authority_revoked, liquidity_locked, discovery_synced_at,
       venue, curve_mining_open, curve_mining_cap, curve_mining_mined, curve_mining_unpaid,
       curve_mining_block_reward, curve_mining_synced_at, curve_sell_capacity_sol,
       curve_sell_capacity_tokens, change_24h_at, volume_24h_usd, trades_24h
    ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?43,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,
              ?23,?24,?25,?26,?27,?28,?29,?30,?31,?32,?33,
              ?34,?35,?36,?37,?38,?39,?40,?41,?42,?44,?45,?46)
    ON CONFLICT(mint) DO UPDATE SET
      name = excluded.name, symbol = excluded.symbol, creator = excluded.creator,
      status = excluded.status, price_usd = excluded.price_usd, price_sol = excluded.price_sol,
      market_cap_usd = excluded.market_cap_usd, reserve_remaining = excluded.reserve_remaining,
      reserve_total = excluded.reserve_total, reward_per_block = excluded.reward_per_block,
      network_power = excluded.network_power, next_block_at = excluded.next_block_at,
      next_epoch_at = excluded.next_epoch_at, decimals = excluded.decimals, synced_at = excluded.synced_at,
      discovery_reserve_remaining = excluded.discovery_reserve_remaining,
      discovery_reserve_total = excluded.discovery_reserve_total,
      discovery_epoch_budget = excluded.discovery_epoch_budget,
      discovery_epoch_spent = excluded.discovery_epoch_spent,
      discovery_epoch_ends_at = excluded.discovery_epoch_ends_at,
      discovery_paused = excluded.discovery_paused,
      liquidity_usd = excluded.liquidity_usd,
      mint_authority_revoked = excluded.mint_authority_revoked,
      freeze_authority_revoked = excluded.freeze_authority_revoked,
      liquidity_locked = excluded.liquidity_locked,
      discovery_synced_at = excluded.discovery_synced_at,
      change_24h = excluded.change_24h,
      change_24h_at = excluded.change_24h_at,
      volume_24h_usd = excluded.volume_24h_usd,
      trades_24h = excluded.trades_24h,
      venue = excluded.venue,
      curve_mining_open = excluded.curve_mining_open,
      curve_mining_cap = excluded.curve_mining_cap,
      curve_mining_mined = excluded.curve_mining_mined,
      curve_mining_unpaid = excluded.curve_mining_unpaid,
      curve_mining_block_reward = excluded.curve_mining_block_reward,
      curve_mining_synced_at = excluded.curve_mining_synced_at,
      curve_sell_capacity_sol = excluded.curve_sell_capacity_sol,
      curve_sell_capacity_tokens = excluded.curve_sell_capacity_tokens,
      description = CASE WHEN ?21 THEN excluded.description ELSE tokens.description END,
      image_key = CASE WHEN ?22 THEN excluded.image_key ELSE tokens.image_key END`,
  )
    .bind(
      mintAddress, slug, chain.name, chain.symbol, description, chain.creator, imageKey, chain.status,
      chain.priceUsd, chain.priceSol, chain.marketCapUsd, chain.reserveRemaining, chain.reserveTotal,
      chain.rewardPerBlock, chain.networkPower, chain.nextBlockAt, chain.nextEpochAt, chain.decimals,
      now, createdAt,
      metadata?.description !== undefined ? 1 : 0,
      metadata?.imageKey !== undefined ? 1 : 0,
      chain.discoveryReserveRemaining,
      chain.discoveryReserveTotal,
      chain.discoveryEpochBudget,
      chain.discoveryEpochSpent,
      chain.discoveryEpochEndsAt,
      chain.discoveryPaused ? 1 : 0,
      chain.liquidityUsd,
      chain.mintAuthorityRevoked ? 1 : 0,
      chain.freezeAuthorityRevoked ? 1 : 0,
      chain.liquidityLocked ? 1 : 0,
      now,
      // The curve-mining ledger and the read-only sell capacity, straight from the market.
      chain.venue,
      chain.curveMining.open ? 1 : 0,
      chain.curveMining.cap,
      chain.curveMining.mined,
      chain.curveMining.unpaid,
      chain.curveMining.blockReward,
      now,
      chain.sellCapacity.sol,
      chain.sellCapacity.tokens,
      // change_24h_at = 0 is what makes change_24h "unknown": the column is NOT NULL, so the
      // percentage itself defaults to 0 and is only ever read when a baseline was recorded.
      chain.change24h ?? 0,
      chain.change24hAt,
      chain.volume24hUsd,
      chain.trades24h,
    )
    .run();

  const token: TokenSummary = {
    mint: mintAddress,
    slug,
    name: chain.name,
    symbol: chain.symbol,
    description,
    creator: chain.creator,
    imageUrl: imageKey ? `/media/${imageKey}` : null,
    status: chain.status,
    priceSol: chain.priceSol,
    priceUsd: chain.priceUsd,
    change24h: chain.change24h,
    volume24hUsd: chain.volume24hUsd,
    trades24h: chain.trades24h,
    curveMining: chain.curveMining,
    sellCapacity: chain.sellCapacity,
    marketCapUsd: chain.marketCapUsd,
    reserveRemaining: chain.reserveRemaining,
    reserveTotal: chain.reserveTotal,
    rewardPerBlock: chain.rewardPerBlock,
    networkPower: chain.networkPower,
    nextBlockAt: chain.nextBlockAt,
    nextEpochAt: chain.nextEpochAt,
    createdAt,
    decimals: chain.decimals,
  };
  return { token, chain };
}

/**
 * Re-reads a mine from chain and upserts D1's cache row. `imageKey`/`description` are only
 * ever used to fill in display metadata the chain doesn't store — every numeric/status field
 * always comes from the fresh on-chain read, never from the caller.
 */
export async function syncTokenToD1(
  env: RuntimeEnv,
  mintAddress: string,
  metadata?: { description?: string; imageKey?: string | null },
): Promise<TokenSummary> {
  return (await syncTokenWithVenue(env, mintAddress, metadata)).token;
}
