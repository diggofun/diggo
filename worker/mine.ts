/**
 * Mine information and the mining report, both read-only.
 *
 * In v4 this module also held the activation, mining-report and reward-claim decision paths: it
 * decided who was eligible for a block, accrued a report, and recorded a payout after verifying
 * the player's transaction. All three are now program instructions (`activate`,
 * `claim_rewards`, and the ledger walk inside every instruction that touches a coin), so what is
 * left here is the presentation of indexed state and the two checks a reader can make for
 * themselves: whether the vault ledger invariant holds, and whether a permissionless advance
 * would do anything.
 */
import type { RuntimeEnv } from "./env";
import { apiError, json } from "./http";
import { coinLedgerInvariant, decodeCoin } from "./v2/program";
import { advanceDueCoins } from "./indexing";
import type { MineInfoView } from "./v2/types";
import { nowSeconds } from "./indexStore";
import { getChainRpc } from "./chainV2";
import { readCoinByMint, readTokenAccountAmount } from "./chainV2";

interface CoinRow {
  coin: string;
  mint: string;
  slug: string;
  symbol: string;
  status: string;
  graduated: number;
  venue: string;
  reserve_remaining: string;
  cumulative_distributed: string;
  discovery_remaining: string;
  discovery_reserve_total: string;
  discovery_epoch_budget: string;
  discovery_epoch_spent: string;
  total_power: string;
  bonded_power: string;
  starter_power: string;
  creator_fee_claimable: string;
  platform_fee_claimable: string;
  epoch_index: number;
  epoch_ends_at: number;
  epoch_ends_slot: string;
  epoch_seed_recorded_slot: string;
  graduation_target: string;
  sol_reserve: string;
  next_block_at: number;
  decimals: number;
}

/**
 * GET /api/mines/:slug/info
 *
 * The information panel. The ledger block is the vault invariant of design 1.3(a), recomputed
 * from a fresh vault read and reported rather than enforced: the indexer cannot move a token, so
 * the honest thing is to show the arithmetic and let a reader check it.
 */
export async function mineInfo(_request: Request, env: RuntimeEnv, slug: string): Promise<Response> {
  const row = await env.DB.prepare(
    "SELECT c.*, t.symbol AS symbol, t.slug AS slug, t.decimals AS decimals" +
      " FROM coins c JOIN tokens t ON t.mint = c.mint WHERE t.slug = ?1",
  )
    .bind(slug)
    .first<CoinRow>();
  if (!row) return apiError("Mine not found", 404);
  const view = await buildMineInfo(env, row);
  return json({ mine: view });
}

async function buildMineInfo(env: RuntimeEnv, row: CoinRow): Promise<MineInfoView> {
  const decimals = row.decimals ?? 6;
  const scale = 10 ** decimals;
  const coin = await readCoinByMint(env, row.mint);
  const vaultAmount = coin
    ? ((await readTokenAccountAmount(env, coin.data.vault).catch(() => null)) ?? 0n)
    : 0n;
  const invariant = coin ? coinLedgerInvariant(coin.data, vaultAmount) : { ok: true, shortfall: 0n };
  const pool = await env.DB.prepare(
    "SELECT pool, sol_reserve, token_reserve FROM pools WHERE mint = ?1",
  )
    .bind(row.mint)
    .first<{ pool: string; sol_reserve: string; token_reserve: string }>();
  const due = await advanceDueCoins(env, nowSeconds());
  const owed = coin
    ? coin.data.tokenReserve +
      coin.data.reserveRemaining +
      coin.data.discoveryRemaining +
      coin.data.outstandingClaims
    : 0n;
  return {
    mint: row.mint,
    coin: row.coin,
    slug: row.slug,
    symbol: row.symbol,
    status: row.status as MineInfoView["status"],
    venue: row.venue as MineInfoView["venue"],
    ledger: {
      vaultAmount: vaultAmount.toString(),
      owed: owed.toString(),
      ok: invariant.ok,
      shortfall: invariant.shortfall.toString(),
    },
    reserve: {
      remaining: Number(row.reserve_remaining) / scale,
      total: (Number(row.reserve_remaining) + Number(row.cumulative_distributed)) / scale,
      cumulativeDistributed: Number(row.cumulative_distributed) / scale,
    },
    discovery: {
      remaining: Number(row.discovery_remaining) / scale,
      total: Number(row.discovery_reserve_total) / scale,
      epochBudget: Number(row.discovery_epoch_budget) / scale,
      epochSpent: Number(row.discovery_epoch_spent) / scale,
    },
    power: {
      total: Number(row.total_power),
      bonded: Number(row.bonded_power),
      starter: Number(row.starter_power),
    },
    fees: {
      creatorClaimableLamports: row.creator_fee_claimable,
      platformClaimableLamports: row.platform_fee_claimable,
    },
    epoch: {
      index: row.epoch_index,
      endsAt: row.epoch_ends_at,
      endsSlot: row.epoch_ends_slot,
      seedCommitted: BigInt(row.epoch_seed_recorded_slot || "0") > 0n,
    },
    pool: pool
      ? {
          pool: pool.pool,
          solReserveLamports: pool.sol_reserve,
          tokenReserve: pool.token_reserve,
        }
      : null,
    graduationReady:
      row.graduated !== 1 &&
      pool === null &&
      BigInt(row.graduation_target) > 0n &&
      BigInt(row.sol_reserve) >= BigInt(row.graduation_target),
    advanceDue: due.includes(row.mint),
  };
}

/**
 * GET /api/mines/:slug/report
 *
 * What the player has actually earned on this coin, from the index: their position's assigned
 * power, its unclaimed reward and the coin's current block. The v4 report was a server-side
 * ledger walk with an operator's own accounting; this one is a read of two mirrored accounts, and
 * the authoritative version of every number in it is one `getAccountInfo` away.
 *
 * A position is not reported with a tranche label any more. The bond is retired, so there is no
 * lesser tier to report a wallet into; the tranche byte the program still stores is a legacy fact
 * of a position armed before the change, and the client reads it from the account itself.
 */
export async function mineReport(request: Request, env: RuntimeEnv, slug: string): Promise<Response> {
  const wallet = new URL(request.url).searchParams.get("wallet");
  const row = await env.DB.prepare(
    "SELECT c.*, t.symbol AS symbol, t.decimals AS decimals FROM coins c" +
      " JOIN tokens t ON t.mint = c.mint WHERE t.slug = ?1",
  )
    .bind(slug)
    .first<CoinRow>();
  if (!row) return apiError("Mine not found", 404);
  const position = wallet
    ? await env.DB.prepare(
        "SELECT assigned_power, pending_reward FROM mining_positions_v2" +
          " WHERE coin = ?1 AND owner = ?2",
      )
        .bind(row.coin, wallet)
        .first<{ assigned_power: string; pending_reward: string }>()
    : null;
  const coin = await readCoinByMint(env, row.mint);
  return json({
    mine: {
      mint: row.mint,
      coin: row.coin,
      symbol: row.symbol,
      status: row.status,
      blockReward: coin ? Number(coin.data.currentBlockReward) / 10 ** (row.decimals ?? 6) : 0,
      nextBlockAt: row.next_block_at,
      totalPower: Number(row.total_power),
      bondedPower: Number(row.bonded_power),
      starterPower: Number(row.starter_power),
    },
    position: position
      ? {
          assignedPower: position.assigned_power,
          pendingReward: position.pending_reward,
          pendingRewardWhole: Number(position.pending_reward) / 10 ** (row.decimals ?? 6),
        }
      : null,
    note: "claim_rewards is signed by the player; this report is a read of the index",
  });
}

/** Whether the RPC is reachable at all. Used by the health endpoint, never by a game path. */
export async function chainReachable(env: RuntimeEnv): Promise<boolean> {
  try {
    await getChainRpc(env).getVersion().send();
    return true;
  } catch {
    return false;
  }
}

/** Exported for the tests that pin the report's decimals handling. */
export { decodeCoin };
