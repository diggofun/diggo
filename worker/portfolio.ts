/**
 * A wallet portfolio: what the v2 index knows about it, and nothing it does not.
 *
 * The rule this module is built around is the one migration 0021 established - the Worker copies
 * what the program said and computes nothing. So every field below is either
 *
 *   - a copy of an indexed program account (`player_accounts`, `coins`, `mining_positions_v2`,
 *     `discovery_events`, `reward_events`), or
 *   - a **labelled** conversion of one (whole-unit, SOL and USD display fields), or
 *   - `null`.
 *
 * Null is the load-bearing part. Two facts a portfolio wants cannot be attributed to a wallet by
 * the index on its own, and neither is guessed at here:
 *
 *   - **Token balances.** No indexed table holds them: `coins`/`tokens` are the public read model
 *     and `player_accounts` mirrors the player, not their token accounts. They are read from chain
 *     (SPL Token and Token-2022) and reported as `positions.source`. When that read fails the
 *     positions are `unavailable`, never empty-but-plausible.
 *   - **Which trades are the wallet's.** `trades` is indexed from the trade instruction and
 *     stores no trader: docs/API.md says as much, and `recordTrades` keeps the input, the fill and
 *     the venue's observed spot price without a wallet column. What it can do honestly is take the
 *     signatures the wallet itself signed and intersect them with the indexed trades, which is
 *     exact for a wallet that trades for itself. `stats.tradeAttribution` names the mechanism so
 *     a reader can tell.
 *
 * A cost basis is deliberately not derived here. Indexed buys and sells do not include transfers,
 * mined or granted tokens, or a complete wallet history, so a lifetime-average or FIFO-looking
 * number would be fabricated. Cost basis and PnL stay unknown until those facts are indexed.
 *
 * Nothing in this module writes anything, and nothing in it can move a token, a lamport, a claim
 * or a reserve. Every claim the portfolio screen offers is an instruction the player signs (see
 * src/onchain/actions.ts).
 */
import { address } from "@solana/kit";
import { TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS } from "../shared/program";
import { getChainRpc, LAMPORTS_PER_SOL } from "./chainV2";
import type { RuntimeEnv } from "./env";
import { apiError, isBase58Address, json } from "./http";
import { nowSeconds } from "./indexStore";
import {
  activationStateOf,
  bondView,
  crewLevelsOf,
  crewLevelsUsable,
  crewStatsOf,
  loadPlayerAccount,
  loadPlayerRow,
  type PlayerAccountRow,
} from "./player";
import { usernameFor } from "./profile";
import type { ActivationState, CrewLevelsView } from "./v2/types";

/** How many of the wallet signatures are walked when attributing indexed trades. */
export const PORTFOLIO_SIGNATURE_LIMIT = 400;
/** The grant list is a bounded preview; its total comes from a separate COUNT query. */
export const PORTFOLIO_DISCOVERY_GRANT_PREVIEW_LIMIT = 50;
/** Rows per D1 lookup. D1 bounds the parameters one statement may bind. */
const LOOKUP_CHUNK = 40;

// --- the view ------------------------------------------------------------------------------

export interface OpenPositionView {
  mint: string;
  coin: string | null;
  slug: string | null;
  symbol: string | null;
  name: string | null;
  /** The wallet token balance, in base units, as the token account states it. */
  balance: string;
  balanceWhole: number;
  /** Token-2022 transfer fees withheld from the account, in base units. */
  withheld: string;
  withheldWhole: number;
  decimals: number;
  priceSol: number | null;
  /** balance x priceSol. Display only. */
  valueSol: number | null;
  valueUsd: number | null;
  /** Mean price of this wallet own indexed buys of this mint, or null when it never bought. */
  avgEntrySol: number | null;
  costBasisSol: number | null;
  unrealizedPnlSol: number | null;
  unrealizedPnlPct: number | null;
}

export interface ClosedPositionView {
  mint: string;
  coin: string | null;
  slug: string | null;
  symbol: string | null;
  name: string | null;
  boughtTokens: number;
  boughtSol: number;
  soldTokens: number;
  soldSol: number | null;
  avgEntrySol: number | null;
  /** soldSol minus avgEntrySol x soldTokens. Null when no buy ever established a basis. */
  realizedPnlSol: number | null;
  realizedPnlPct: number | null;
  lastTradeAt: number;
}

export interface PortfolioView {
  wallet: string;
  username: string | null;
  /** The profile row creation time, or null when this wallet has never been seen before. */
  joined: number | null;
  /** Whether the PlayerAccount PDA has been indexed; false means the wallet never initialized. */
  indexed: boolean;
  stats: {
    volumeBoughtSol: number | null;
    volumeSoldSol: number | null;
    trades: number | null;
    /** "signature" when the wallet signed transactions were intersected with the index. */
    tradeAttribution: "signature" | "unavailable";
    /** False when the signature scan hit its bound, so counts and volume are not lifetime totals. */
    tradeHistoryComplete: boolean | null;
    signatureScanLimit: number;
    signaturesScanned: number | null;
    /** Human-facing scope for the two volume fields. */
    volumeScope: "all-signatures-returned" | "latest-signatures" | "unavailable";
    /** How many attributed fills carry a measured received side (trades.fill_source). */
    tradesPriced: number;
    tradesUnpriced: number;
    realizedPnlSol: number | null;
    unrealizedPnlSol: number | null;
    rewardsClaimed: {
      coin: string;
      mint: string | null;
      symbol: string | null;
      amount: string;
      amountWhole: number | null;
      events: number;
    }[];
    coinsCreated: number;
    creatorFeesClaimableLamports: string;
    creatorFeesClaimableSol: number;
    discoveryGrantsPending: number;
    discoveryGrantsPreviewTruncated: boolean;
    discoveryGrantsPreviewLimit: number;
  };
  positions: {
    open: OpenPositionView[];
    closed: ClosedPositionView[];
    /** "chain" when the wallet token accounts were read; "unavailable" when they were not. */
    source: "chain" | "unavailable";
  };
  mining: {
    indexed: boolean;
    activation: ActivationState;
    activeUntil: number;
    activeMine: { coin: string; mint: string | null; slug: string | null; symbol: string | null } | null;
    /** Total assigned power across this wallet MiningPositions, summed as integers. */
    power: string;
    powerWhole: number;
    ore: string;
    oreWhole: number;
    oreEarned: string;
    oreCapacity: number;
    crew: CrewLevelsView;
    crewTier: string;
    crewPower: number;
    /**
     * Where the crew numbers above come from. "mirror" means a mirrored PlayerAccount states a crew
     * the program can hold, so the power, capacity and tier are that crew's. "unavailable" means no
     * usable mirror states one - the wallet has no indexed PlayerAccount, or the row it has holds
     * levels outside the program's range - so the crew block is the zero crew and says nothing about
     * what the wallet mines. The levels are reported exactly as mirrored in both cases.
     */
    crewSource: "mirror" | "unavailable";
    bond: ReturnType<typeof bondView>;
    streak: number;
    longestStreak: number;
    activeDays: number;
    streakFreezes: number;
    /** Unpaid block rewards per coin, straight from each MiningPosition. */
    rewards: {
      position: string;
      coin: string;
      mint: string | null;
      symbol: string | null;
      pendingReward: string;
      pendingRewardWhole: number | null;
    }[];
    /** Rolls created and not yet settled, which is what settle_discovery clears. */
    discoveryGrants: {
      opportunity: string;
      coin: string;
      mint: string | null;
      symbol: string | null;
      windowIndex: number;
      dayIndex: number;
      createdAt: number;
    }[];
  };
  creator: {
    coins: {
      coin: string;
      mint: string | null;
      slug: string | null;
      name: string | null;
      symbol: string | null;
      status: string;
      graduated: boolean;
      priceSol: number | null;
      marketCapUsd: number | null;
      creatorFeesClaimableLamports: string;
      creatorFeesClaimableSol: number;
    }[];
    claimableLamports: string;
    claimableSol: number;
  };
  syncedAt: number;
}

// --- the sources ---------------------------------------------------------------------------

/** One of the wallet token accounts, as the chain states it. */
export interface HoldingRow {
  account: string;
  mint: string;
  program: string;
  /** Spendable account balance in base units. */
  amount: string;
  /** Token-2022 withheld transfer fees in base units; these are not spendable. */
  withheld: string;
  decimals: number;
  state: string;
}

/** One indexed trade the wallet signed. */
export interface WalletTradeRow {
  signature: string;
  mint: string;
  side: string;
  amountIn: string;
  amountOut: string;
  fillSource: string;
  priceSol: number;
  blockTime: number;
}

/** One mint, as the public read model describes it. */
export interface MintMeta {
  coin: string | null;
  slug: string | null;
  name: string | null;
    symbol: string | null;
    decimals: number;
  priceSol: number | null;
  priceUsd: number | null;
}

export interface PortfolioSources {
  player: { created_at: number } | null;
  account: PlayerAccountRow | null;
  positions: {
    position: string;
    coin: string;
    assigned_power: string;
    pending_reward: string;
    mint: string | null;
    symbol: string | null;
    decimals: number | null;
  }[];
  activeMine: { coin: string; mint: string | null; slug: string | null; symbol: string | null } | null;
  createdCoins: {
    coin: string;
    mint: string | null;
    slug: string | null;
    name: string | null;
    symbol: string | null;
    status: string;
    graduated: number;
    price_sol: number | null;
    market_cap_usd: number | null;
    creator_fee_claimable: string;
  }[];
  discoveryGrants: {
    opportunity: string;
    coin: string;
    window_index: number;
    day_index: number;
    created_at: number;
    mint: string | null;
    symbol: string | null;
  }[];
  /** Total pending rows, counted independently of the bounded preview above. */
  discoveryGrantsPending: number;
  /** Claimed rewards stay separated by coin because their base units are not comparable. */
  rewardsClaimed: {
    coin: string;
    mint: string | null;
    symbol: string | null;
    decimals: number | null;
    amount: string;
    events: number;
  }[];
  /** The wallet token accounts, or null when the chain read did not answer. */
  holdings: HoldingRow[] | null;
  /** The indexed trades the wallet signed, or null when the attribution did not answer. */
  trades: WalletTradeRow[] | null;
  /** Whether the signature scan reached its bound and may have omitted older signatures. */
  tradeHistoryComplete: boolean | null;
  /** Number of wallet signatures returned by the bounded scan, before trade-index filtering. */
  signaturesScanned: number | null;
  /** Price metadata for every mint the derivation mentions. */
  mints: Map<string, MintMeta>;
}

/**
 * The two chain reads a portfolio needs, behind one interface so the derivation is testable
 * without a network. Each returns null rather than throwing when it cannot answer, because an
 * unavailable section is a normal state for this endpoint and a 500 is not.
 */
export interface ChainReads {
  walletSignatures(wallet: string, limit: number): Promise<string[] | null>;
  tokenAccounts(wallet: string): Promise<HoldingRow[] | null>;
}

interface ParsedTokenInfo {
  mint?: string;
  owner?: string;
  state?: string;
  isNative?: boolean;
  tokenAmount?: { amount?: string; decimals?: number };
  extensions?: readonly { extension?: string; state?: Record<string, unknown> }[];
}

/**
 * Any withheld transfer fee in a Token-2022 account parsed extensions, in base units.
 *
 * A withheld fee is value the account still owes a recipient, so an account carrying one is not
 * reclaimable rent even when its balance is zero. Only the transfer-fee amount extension is read;
 * summing every numeric extension field would confuse unrelated configuration with held value.
 */
export function withheldFees(info: ParsedTokenInfo): bigint {
  let withheld = 0n;
  for (const extension of info.extensions ?? []) {
    if (extension?.extension !== "transferFeeAmount") continue;
    const state = extension?.state;
    if (!state || typeof state !== "object") continue;
    const value = (state as { withheldAmount?: unknown }).withheldAmount;
    if (typeof value === "string" && /^[0-9]+$/.test(value)) withheld += BigInt(value);
  }
  return withheld;
}

/**
 * The default chain reads, through the same RPC the indexer uses.
 *
 * jsonParsed is asked for deliberately: the parsed body carries the mint, the owner, the state and
 * the amount, so this module never has to decode a token account itself and cannot disagree with
 * shared/program.ts about the layout.
 */
export function defaultChainReads(env: RuntimeEnv): ChainReads {
  const client = getChainRpc(env) as unknown as {
    getTokenAccountsByOwner(
      owner: unknown,
      filter: { programId: unknown },
      config: { encoding: "jsonParsed" },
    ): { send(): Promise<unknown> };
    getSignaturesForAddress(owner: unknown, config: { limit: number }): { send(): Promise<unknown> };
  };
  return {
    async walletSignatures(wallet, limit) {
      try {
        const rows = (await client
          .getSignaturesForAddress(address(wallet), { limit })
          .send()) as readonly { signature?: string }[];
        return rows.map((row) => row.signature).filter((value): value is string => Boolean(value));
      } catch {
        return null;
      }
    },
    async tokenAccounts(wallet) {
      try {
        const owner = address(wallet);
        const programs = [TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS];
        const pages = await Promise.all(
          programs.map((programId) =>
            client.getTokenAccountsByOwner(owner, { programId }, { encoding: "jsonParsed" }).send(),
          ),
        );
        const holdings: HoldingRow[] = [];
        pages.forEach((page, index) => {
          const value =
            (page as { value?: readonly { pubkey: string; account: { data?: unknown } }[] }).value ?? [];
          for (const entry of value) {
            const parsed = (entry.account?.data as { parsed?: { info?: ParsedTokenInfo } })?.parsed;
            const info = parsed?.info;
            if (!info?.mint) continue;
            const withheld = withheldFees(info);
            holdings.push({
              account: entry.pubkey,
              mint: info.mint,
              program: String(programs[index]),
              amount: info.tokenAmount?.amount ?? "0",
              withheld: withheld.toString(),
              decimals: info.tokenAmount?.decimals ?? 0,
              state: info.state ?? "initialized",
            });
          }
        });
        return holdings;
      } catch {
        return null;
      }
    },
  };
}

// --- loading -------------------------------------------------------------------------------

/** The indexed trades among these signatures, newest last, in chunks D1 will bind. */
async function indexedTradesFor(
  env: RuntimeEnv,
  signatures: readonly string[],
): Promise<WalletTradeRow[]> {
  const rows: WalletTradeRow[] = [];
  for (let start = 0; start < signatures.length; start += LOOKUP_CHUNK) {
    const chunk = signatures.slice(start, start + LOOKUP_CHUNK);
    const placeholders = chunk.map((_, index) => "?" + (index + 1)).join(", ");
    const page = await env.DB.prepare(
      "SELECT signature, mint, side, amount_in, amount_out, fill_source, price_sol, block_time" +
        " FROM trades WHERE signature IN (" + placeholders + ") ORDER BY block_time ASC",
    )
      .bind(...chunk)
      .all<{
        signature: string;
        mint: string;
        side: string;
        amount_in: string;
        amount_out: string;
        fill_source: string;
        price_sol: number;
        block_time: number;
      }>();
    for (const row of page.results ?? []) {
      rows.push({
        signature: row.signature,
        mint: row.mint,
        side: row.side,
        amountIn: row.amount_in,
        amountOut: row.amount_out,
        fillSource: row.fill_source,
        priceSol: row.price_sol,
        blockTime: row.block_time,
      });
    }
  }
  return rows;
}

/** Everything the derivation reads: the index, plus the two chain reads when they answer. */
export async function loadPortfolioSources(
  env: RuntimeEnv,
  wallet: string,
  chain: ChainReads = defaultChainReads(env),
): Promise<PortfolioSources> {
  const account = await loadPlayerAccount(env, wallet);
  const activeMineAddress = account?.active_mine ? account.active_mine : null;
  const [player, positions, createdCoins, grants, grantCount, rewardRows, activeMine, holdings, signatures] =
    await Promise.all([
      loadPlayerRow(env, wallet),
      env.DB.prepare(
        "SELECT p.position, p.coin, p.assigned_power, p.pending_reward, c.mint AS mint," +
          " t.symbol AS symbol, t.decimals AS decimals FROM mining_positions_v2 p" +
          " LEFT JOIN coins c ON c.coin = p.coin" +
          " LEFT JOIN tokens t ON t.mint = c.mint" +
          " WHERE p.owner = ?1 ORDER BY p.assigned_power DESC",
      )
        .bind(wallet)
        .all<{
          position: string;
          coin: string;
          assigned_power: string;
          pending_reward: string;
          mint: string | null;
          symbol: string | null;
          decimals: number | null;
        }>(),
      env.DB.prepare(
        "SELECT c.coin, c.mint, c.slug, c.creator_fee_claimable, c.graduated, c.status," +
          " t.name AS name, t.symbol AS symbol, t.price_sol, t.market_cap_usd" +
          " FROM coins c LEFT JOIN tokens t ON t.mint = c.mint" +
          " WHERE c.creator = ?1 ORDER BY c.indexed_at DESC",
      )
        .bind(wallet)
        .all<{
          coin: string;
          mint: string;
          slug: string;
          creator_fee_claimable: string;
          graduated: number;
          status: string;
          name: string | null;
          symbol: string | null;
          price_sol: number | null;
          market_cap_usd: number | null;
        }>(),
      env.DB.prepare(
        "SELECT d.opportunity, d.coin, d.window_index, d.day_index, d.created_at," +
          " c.mint AS mint, t.symbol AS symbol FROM discovery_events d" +
          " LEFT JOIN coins c ON c.coin = d.coin" +
          " LEFT JOIN tokens t ON t.mint = c.mint" +
          " WHERE d.wallet = ?1 AND d.status = 'PENDING'" +
          " ORDER BY d.block_time DESC LIMIT ?2",
      )
        .bind(wallet, PORTFOLIO_DISCOVERY_GRANT_PREVIEW_LIMIT)
        .all<{
          opportunity: string;
          coin: string;
          window_index: number;
          day_index: number;
          created_at: number;
          mint: string | null;
          symbol: string | null;
        }>(),
      env.DB.prepare(
        "SELECT COUNT(*) AS count FROM discovery_events" +
          " WHERE wallet = ?1 AND status = 'PENDING'",
      )
        .bind(wallet)
        .first<{ count: number }>(),
      env.DB.prepare(
        "SELECT r.coin, r.amount, c.mint AS mint, t.symbol AS symbol, t.decimals AS decimals" +
          " FROM reward_events r LEFT JOIN coins c ON c.coin = r.coin" +
          " LEFT JOIN tokens t ON t.mint = c.mint WHERE r.wallet = ?1" +
          " ORDER BY r.block_time ASC, r.signature ASC, r.event_index ASC",
      )
        .bind(wallet)
        .all<{
          coin: string;
          amount: string;
          mint: string | null;
          symbol: string | null;
          decimals: number | null;
        }>(),
      activeMineAddress
        ? env.DB.prepare(
            "SELECT c.coin, c.mint, c.slug, t.symbol AS symbol FROM coins c" +
              " LEFT JOIN tokens t ON t.mint = c.mint WHERE c.coin = ?1",
          )
            .bind(activeMineAddress)
            .first<{ coin: string; mint: string; slug: string; symbol: string | null }>()
        : Promise.resolve(null),
      chain.tokenAccounts(wallet),
      chain.walletSignatures(wallet, PORTFOLIO_SIGNATURE_LIMIT),
    ]);

  const trades = signatures ? await indexedTradesFor(env, signatures) : null;
  const positionRows = positions.results ?? [];
  const mintSet = new Set<string>();
  for (const row of holdings ?? []) mintSet.add(row.mint);
  for (const row of trades ?? []) mintSet.add(row.mint);
  for (const row of positionRows) if (row.mint) mintSet.add(row.mint);
  for (const row of createdCoins.results ?? []) if (row.mint) mintSet.add(row.mint);
  if (activeMine?.mint) mintSet.add(activeMine.mint);

  return {
    player: player ? { created_at: player.created_at } : null,
    account,
    positions: positionRows,
    activeMine: activeMine
      ? { coin: activeMine.coin, mint: activeMine.mint, slug: activeMine.slug, symbol: activeMine.symbol }
      : null,
    createdCoins: (createdCoins.results ?? []).map((row) => ({
      coin: row.coin,
      mint: row.mint,
      slug: row.slug,
      name: row.name,
      symbol: row.symbol,
      status: row.status,
      graduated: row.graduated,
      price_sol: row.price_sol,
      market_cap_usd: row.market_cap_usd,
      creator_fee_claimable: row.creator_fee_claimable,
    })),
    discoveryGrants: grants.results ?? [],
    discoveryGrantsPending: Number(grantCount?.count ?? 0),
    rewardsClaimed: (rewardRows.results ?? []).map((row) => ({
      coin: row.coin,
      mint: row.mint,
      symbol: row.symbol,
      decimals: row.decimals,
      amount: row.amount,
      events: 1,
    })),
    holdings,
    trades,
    tradeHistoryComplete:
      signatures === null ? null : signatures.length < PORTFOLIO_SIGNATURE_LIMIT,
    signaturesScanned: signatures?.length ?? null,
    mints: await loadMintMetadata(env, [...mintSet]),
  };
}

/** The display metadata and price of every mint the derivation mentions, one query per chunk. */
async function loadMintMetadata(
  env: RuntimeEnv,
  mints: readonly string[],
): Promise<Map<string, MintMeta>> {
  const table = new Map<string, MintMeta>();
  for (let start = 0; start < mints.length; start += LOOKUP_CHUNK) {
    const chunk = mints.slice(start, start + LOOKUP_CHUNK);
    const placeholders = chunk.map((_, index) => "?" + (index + 1)).join(", ");
    const rows = await env.DB.prepare(
      "SELECT t.mint, t.coin, t.slug, t.name, t.symbol, t.decimals, t.price_sol, t.price_usd" +
        " FROM tokens t WHERE t.mint IN (" + placeholders + ")",
    )
      .bind(...chunk)
      .all<{
        mint: string;
        coin: string;
        slug: string;
        name: string;
        symbol: string;
        decimals: number;
        price_sol: number;
        price_usd: number;
      }>();
    for (const row of rows.results ?? []) {
      table.set(row.mint, {
        coin: row.coin,
        slug: row.slug,
        name: row.name,
        symbol: row.symbol,
        decimals: row.decimals,
        priceSol: row.price_sol,
        priceUsd: row.price_usd,
      });
    }
  }
  return table;
}

// --- derivation ----------------------------------------------------------------------------

const SOL = LAMPORTS_PER_SOL;

/** The crew a wallet with no mirrored PlayerAccount holds: no crew, so every branch is zero. */
const NO_CREW: CrewLevelsView = {
  miners: 0,
  drills: 0,
  carts: 0,
  foreman: 0,
  storage: 0,
  total: 0,
};

/**
 * The crew levels a wallet mirrored PlayerAccount states, reported exactly as it states them.
 *
 * Nothing is clamped. A wallet with no mirror has no crew, and a mirror holding levels outside
 * `crew.minLevel..maxLevel` is a decode or indexing fault; reading either as the minimum level would
 * invent an upgrade nobody bought, and pricing it would report Mining Power for a crew nobody holds.
 * So the levels stay visible as they are and `crewStatsOf` is left to refuse to price them, which is
 * what `worker/player.ts` reports for the same wallet.
 */
function crewLevelsFor(row: PlayerAccountRow | null): CrewLevelsView {
  return row ? crewLevelsOf(row) : NO_CREW;
}

/**
 * The crew block a portfolio reports: the levels the mirror states, the numbers the shared tables
 * price them to, and whether they could be priced at all.
 *
 * The gate is the profile's own - `crewStatsOf` prices a mirror only when `crewLevelsUsable`
 * accepts it - so a portfolio and a profile cannot disagree about the same wallet. A wallet the
 * indexer has not reached yet, and a row the program could not have written, are both reported as
 * the zero crew with zero power and capacity, and `source` says so rather than leaving a reader to
 * read zero as "this wallet mines nothing".
 */
function crewViewFor(row: PlayerAccountRow | null): {
  levels: CrewLevelsView;
  power: number;
  capacity: number;
  tier: string;
  source: "mirror" | "unavailable";
} {
  const levels = crewLevelsFor(row);
  const stats = crewStatsOf(levels, row !== null);
  return {
    levels,
    power: stats.power,
    capacity: stats.capacity,
    tier: stats.tier,
    source: crewLevelsUsable(levels) ? "mirror" : "unavailable",
  };
}

/** Base units in one whole token, given its decimals. */
function units(decimals: number): number {
  return Math.pow(10, decimals);
}

/** The spendable balance of a holding, in base units. */
function heldBaseUnits(holding: HoldingRow): bigint {
  try {
    return BigInt(holding.amount ?? "0");
  } catch {
    return 0n;
  }
}

function withheldBaseUnits(holding: HoldingRow): bigint {
  try {
    return BigInt(holding.withheld ?? "0");
  } catch {
    return 0n;
  }
}

/** A bigint read out of a text column, or 0n when the column holds something unusable. */
function bigintOrZero(value: string | null | undefined): bigint {
  try {
    return BigInt(value ?? "0");
  } catch {
    return 0n;
  }
}

/**
 * Indexed buy flow for one mint. This is deliberately not a cost basis: transfers, mined and
 * granted tokens, and a bounded history all mean the buys alone cannot identify the lots sold.
 *
 * Only fills whose received side was measured count as tokens. When trades.fill_source is
 * "instruction" the indexer had no balance table to read, so amount_out is 0 by definition, and
 * treating that as "bought nothing for that SOL" would push the mean price to infinity. Those
 * SOL still count toward volume, because the input was recorded.
 */
export function tradeFlowSummary(
  trades: readonly WalletTradeRow[],
  mint: string,
  decimals: number,
): { boughtTokens: number; boughtSol: number } {
  let boughtTokens = 0;
  let boughtSol = 0;
  for (const trade of trades) {
    if (trade.mint !== mint || trade.side !== "BUY") continue;
    boughtSol += Number(trade.amountIn) / SOL;
    if (trade.fillSource === "meta") boughtTokens += Number(trade.amountOut) / units(decimals);
  }
  return { boughtTokens, boughtSol };
}

/**
 * The whole portfolio, derived from what was loaded. Pure, so it is testable on its own: every
 * input it reads is in PortfolioSources, and it performs no I/O of any kind.
 */
export function derivePortfolio(
  wallet: string,
  now: number,
  username: string | null,
  sources: PortfolioSources,
): PortfolioView {
  const trades = sources.trades;
  const holdings = sources.holdings;
  const account = sources.account;
  const crew = crewViewFor(account);
  const bond = bondView(account, now);

  // --- open positions ------------------------------------------------------------------------
  const open: OpenPositionView[] = [];
  const heldMints = new Set<string>();
  if (holdings) {
    const byMint = new Map<string, HoldingRow>();
    for (const holding of holdings) {
      // A wallet can hold one mint in several accounts, so the balances are added rather than the
      // last one winning. The decimals come from the index when it knows the mint, because a token
      // account read is not a place to learn them from.
      const previous = byMint.get(holding.mint);
      const total = (previous ? heldBaseUnits(previous) : 0n) + heldBaseUnits(holding);
      const withheld = (previous ? withheldBaseUnits(previous) : 0n) + withheldBaseUnits(holding);
      byMint.set(holding.mint, {
        ...holding,
        amount: total.toString(),
        withheld: withheld.toString(),
      });
    }
    for (const [mint, holding] of byMint) {
      const balance = heldBaseUnits(holding);
      const withheld = withheldBaseUnits(holding);
      if (balance <= 0n && withheld <= 0n) continue;
      heldMints.add(mint);
      const meta = sources.mints.get(mint);
      const decimals = meta?.decimals ?? holding.decimals;
      const balanceWhole = Number(balance) / units(decimals);
      const priceSol = meta?.priceSol ?? null;
      const valueSol = priceSol === null ? null : balanceWhole * priceSol;
      // Transfers, grants and mining mean the current balance cannot establish a FIFO lot basis.
      const avgEntrySol: number | null = null;
      const costBasisSol: number | null = null;
      open.push({
        mint,
        coin: meta?.coin ?? null,
        slug: meta?.slug ?? null,
        symbol: meta?.symbol ?? null,
        name: meta?.name ?? null,
        balance: balance.toString(),
        balanceWhole,
        withheld: withheld.toString(),
        withheldWhole: Number(withheld) / units(decimals),
        decimals,
        priceSol,
        valueSol,
        valueUsd: meta?.priceUsd === null || meta?.priceUsd === undefined
          ? null
          : balanceWhole * meta.priceUsd,
        avgEntrySol,
        costBasisSol,
        unrealizedPnlSol: null,
        unrealizedPnlPct: null,
      });
    }
    open.sort((left, right) => (right.valueSol ?? -1) - (left.valueSol ?? -1));
  }

  // --- closed positions ----------------------------------------------------------------------
  const closed: ClosedPositionView[] = [];
  if (trades && holdings) {
    for (const mint of new Set(trades.map((trade) => trade.mint))) {
      // Closed means the wallet has no balance left in a mint it traded. This needs both sides: a
      // mint whose holdings could not be read is unknown, not closed, and reporting it as closed
      // would invent a realized gain out of a failed RPC call.
      if (heldMints.has(mint)) continue;
      const meta = sources.mints.get(mint);
      const decimals = meta?.decimals ?? 0;
      const flow = tradeFlowSummary(trades, mint, decimals);
      let soldTokens = 0;
      let soldSol = 0;
      let sellCount = 0;
      let pricedSells = 0;
      let lastTradeAt = 0;
      for (const trade of trades) {
        if (trade.mint !== mint) continue;
        lastTradeAt = Math.max(lastTradeAt, trade.blockTime);
        if (trade.side !== "SELL") continue;
        sellCount += 1;
        soldTokens += Number(trade.amountIn) / units(decimals);
        // A sell receives lamports. When the indexer had no balance table the received side is 0,
        // and the honest report is that this fill proceeds are unknown, so it is left out of the
        // sum rather than priced at the venue spot, which is not what the trader received.
        if (trade.fillSource === "meta") {
          soldSol += Number(trade.amountOut) / SOL;
          pricedSells += 1;
        }
      }
      if (soldTokens <= 0) continue;
      closed.push({
        mint,
        coin: meta?.coin ?? null,
        slug: meta?.slug ?? null,
        symbol: meta?.symbol ?? null,
        name: meta?.name ?? null,
        boughtTokens: flow.boughtTokens,
        boughtSol: flow.boughtSol,
        soldTokens,
        soldSol: pricedSells === sellCount ? soldSol : null,
        avgEntrySol: null,
        realizedPnlSol: null,
        realizedPnlPct: null,
        lastTradeAt,
      });
    }
    closed.sort((left, right) => right.lastTradeAt - left.lastTradeAt);
  }

  // --- stats ---------------------------------------------------------------------------------
  let volumeBoughtSol: number | null = null;
  let volumeSoldSol: number | null = null;
  let tradesPriced = 0;
  let tradesUnpriced = 0;
  if (trades) {
    volumeBoughtSol = 0;
    volumeSoldSol = 0;
    let sells = 0;
    let pricedSells = 0;
    for (const trade of trades) {
      const priced = trade.fillSource === "meta";
      if (priced) tradesPriced += 1;
      else tradesUnpriced += 1;
      if (trade.side === "BUY") {
        volumeBoughtSol += Number(trade.amountIn) / SOL;
        continue;
      }
      if (trade.side !== "SELL") continue;
      sells += 1;
      if (!priced) continue;
      volumeSoldSol += Number(trade.amountOut) / SOL;
      pricedSells += 1;
    }
    // Sells with no measured received side are not zero proceeds, they are unknown proceeds: the
    // whole column would be a lower bound, so it is reported as unknown instead.
    if (sells > 0 && pricedSells !== sells) volumeSoldSol = null;
  }

  // PnL is always unknown: the index has no token transfer, grant or mining ledger from which to
  // establish complete FIFO lots, and the signature scan may itself be truncated.
  const realizedPnlSol = null;
  const unrealizedPnlSol = null;

  const claimedByCoin = new Map<string, { mint: string | null; symbol: string | null; decimals: number | null; amount: bigint; events: number }>();
  for (const claim of sources.rewardsClaimed) {
    const current = claimedByCoin.get(claim.coin) ?? {
      mint: claim.mint,
      symbol: claim.symbol,
      decimals: claim.decimals,
      amount: 0n,
      events: 0,
    };
    current.amount += bigintOrZero(claim.amount);
    current.events += claim.events;
    claimedByCoin.set(claim.coin, current);
  }
  const rewardsClaimed = [...claimedByCoin].map(([coin, claim]) => ({
    coin,
    mint: claim.mint,
    symbol: claim.symbol,
    amount: claim.amount.toString(),
    amountWhole: claim.decimals === null ? null : Number(claim.amount) / units(claim.decimals),
    events: claim.events,
  }));
  let creatorClaimable = 0n;
  for (const coin of sources.createdCoins) creatorClaimable += bigintOrZero(coin.creator_fee_claimable);

  // --- mining --------------------------------------------------------------------------------
  let power = 0n;
  const rewards: PortfolioView["mining"]["rewards"] = [];
  for (const position of sources.positions) {
    power += bigintOrZero(position.assigned_power);
    const pending = bigintOrZero(position.pending_reward);
    if (pending <= 0n) continue;
    rewards.push({
      position: position.position,
      coin: position.coin,
      mint: position.mint,
      symbol: position.symbol,
      pendingReward: pending.toString(),
      pendingRewardWhole: position.decimals === null ? null : Number(pending) / units(position.decimals),
    });
  }

  const ore = bigintOrZero(account?.ore_balance);
  const oreEarned = bigintOrZero(account?.ore_earned);

  return {
    wallet,
    username,
    joined: sources.player?.created_at ?? null,
    indexed: account !== null,
    stats: {
      volumeBoughtSol,
      volumeSoldSol,
      trades: trades === null ? null : trades.length,
      tradeAttribution: trades === null ? "unavailable" : "signature",
      tradeHistoryComplete: sources.tradeHistoryComplete,
      signatureScanLimit: PORTFOLIO_SIGNATURE_LIMIT,
      signaturesScanned: sources.signaturesScanned,
      volumeScope:
        trades === null
          ? "unavailable"
          : sources.tradeHistoryComplete === false
            ? "latest-signatures"
            : "all-signatures-returned",
      tradesPriced,
      tradesUnpriced,
      realizedPnlSol,
      unrealizedPnlSol,
      rewardsClaimed,
      coinsCreated: sources.createdCoins.length,
      creatorFeesClaimableLamports: creatorClaimable.toString(),
      creatorFeesClaimableSol: Number(creatorClaimable) / SOL,
      discoveryGrantsPending: sources.discoveryGrantsPending,
      discoveryGrantsPreviewTruncated:
        sources.discoveryGrantsPending > sources.discoveryGrants.length,
      discoveryGrantsPreviewLimit: PORTFOLIO_DISCOVERY_GRANT_PREVIEW_LIMIT,
    },
    positions: {
      open,
      closed,
      source: holdings === null ? "unavailable" : "chain",
    },
    mining: {
      indexed: account !== null,
      activation: activationStateOf(account, now),
      activeUntil: account?.active_until ?? 0,
      activeMine: sources.activeMine,
      power: power.toString(),
      powerWhole: Number(power),
      ore: ore.toString(),
      oreWhole: Number(ore),
      oreEarned: oreEarned.toString(),
      oreCapacity: crew.capacity,
      crew: crew.levels,
      crewTier: crew.tier,
      crewPower: crew.power,
      crewSource: crew.source,
      bond,
      streak: account?.streak ?? 0,
      longestStreak: account?.longest_streak ?? 0,
      activeDays: account?.active_days ?? 0,
      streakFreezes: account?.streak_freezes ?? 0,
      rewards,
      discoveryGrants: sources.discoveryGrants.map((grant) => ({
        opportunity: grant.opportunity,
        coin: grant.coin,
        mint: grant.mint,
        symbol: grant.symbol,
        windowIndex: grant.window_index,
        dayIndex: grant.day_index,
        createdAt: grant.created_at,
      })),
    },
    creator: {
      coins: sources.createdCoins.map((coin) => ({
        coin: coin.coin,
        mint: coin.mint,
        slug: coin.slug,
        name: coin.name,
        symbol: coin.symbol,
        status: coin.status,
        graduated: coin.graduated === 1,
        priceSol: coin.price_sol,
        marketCapUsd: coin.market_cap_usd,
        creatorFeesClaimableLamports: coin.creator_fee_claimable,
        creatorFeesClaimableSol: Number(bigintOrZero(coin.creator_fee_claimable)) / SOL,
      })),
      claimableLamports: creatorClaimable.toString(),
      claimableSol: Number(creatorClaimable) / SOL,
    },
    syncedAt: nowSeconds(),
  };
}

/** The portfolio for one wallet: load, then derive. */
export async function portfolioView(
  env: RuntimeEnv,
  wallet: string,
  chain: ChainReads = defaultChainReads(env),
): Promise<PortfolioView> {
  const sources = await loadPortfolioSources(env, wallet, chain);
  const username = await usernameFor(env, wallet).catch(() => null);
  return derivePortfolio(wallet, Math.floor(Date.now() / 1_000), username, sources);
}

/**
 * GET /api/portfolio/:wallet
 *
 * Public, like the profile it extends: a wallet coins, positions and mining state are all already
 * readable from the chain by anyone, so gating this would hide nothing. It is not cached, because
 * the chain reads behind it are not, and a stale portfolio is worse than a slow one.
 */
export async function portfolioForWallet(
  _request: Request,
  env: RuntimeEnv,
  wallet: string,
  chain: ChainReads = defaultChainReads(env),
): Promise<Response> {
  if (!isBase58Address(wallet)) return apiError("Invalid wallet");
  try {
    return json(
      { portfolio: await portfolioView(env, wallet, chain) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    // The index is the only thing that can fail here in a way the caller should see; a chain read
    // failing is already represented as an unavailable section, not as an error.
    console.error(JSON.stringify({ event: "portfolio.failed", wallet, error: String(error) }));
    return apiError("Portfolio unavailable", 503);
  }
}
