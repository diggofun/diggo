/**
 * The indexing pipeline: Helius webhooks land here, are normalized into IndexingEvent jobs on
 * INDEXING_QUEUE, and are applied to D1 and the market Durable Object by the queue consumer.
 * The cron trigger re-reads every live mine from chain through the same queue.
 */
import { crewPower } from "../shared/economics";
import { normalizeHeliusEvent } from "../shared/helius";
import type { IndexingEvent, MarketTrade } from "../shared/types";
import { isBreakerOpen } from "./breakers";
import { readTokenFromChain, syncTokenWithVenue, type ChainSyncedToken } from "./chain";
import { recordPriceSample, recoverEligibleDiscovery } from "./discovery";
import type { RuntimeEnv } from "./env";
import { apiError, json, readJson, sameSecret } from "./http";
import {
  keeperAdvanceMine,
  keeperClaimDiscovery,
  keeperDiscoveryReceiptExists,
  keeperGraduateMarket,
  keeperSyncCrewPower,
  isSyncBehindError,
} from "./keeper";
import { settleRewardClaim } from "./mining";
import { getSolUsd, refreshExternalQuotesSafely } from "./oracle";
import { crewLevelsOf, type PlayerRow } from "./player";
import { metric } from "./telemetry";
import { TOKEN_CACHE_KEY } from "./tokens";

export async function heliusWebhook(request: Request, env: RuntimeEnv): Promise<Response> {
  if (!sameSecret(request.headers.get("authorization"), env.HELIUS_WEBHOOK_AUTH)) {
    return apiError("Unauthorized", 401);
  }
  const payload = await readJson<unknown>(request, 1_000_000);
  const events = Array.isArray(payload) ? payload : [payload];
  const normalized = events.map(normalizeHeliusEvent).filter((event) => event !== null);
  if (normalized.length !== events.length || normalized.length === 0) {
    return apiError("Invalid Helius event payload", 400);
  }
  for (let index = 0; index < normalized.length; index += 100) {
    await env.INDEXING_QUEUE.sendBatch(
      normalized.slice(index, index + 100).map((body) => ({ body })),
    );
  }
  return json({ accepted: normalized.length });
}

export async function processQueueEvent(event: IndexingEvent, env: RuntimeEnv): Promise<void> {
  if (event.type === "trade") {
    const { mint } = event;
    // Index the fill at the price its own venue reports, not the price the event carried. A market
    // that graduated between the trade and this job has zero curve reserves, so a curve-derived
    // price would index a real fill at nothing; the pool's reserves are the price after graduation.
    const trade = priceTrade(event.trade, await readVenuePrice(env, mint));
    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO trades (signature, mint, side, price_usd, price_sol, amount, block_time) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
      ).bind(trade.signature, mint, trade.side, trade.priceUsd, trade.priceSol, trade.amount, trade.timestamp),
      env.DB.prepare("UPDATE tokens SET price_usd = ?1, price_sol = ?2 WHERE mint = ?3").bind(
        trade.priceUsd,
        trade.priceSol,
        mint,
      ),
    ]);
    const market = env.MARKETS.getByName(mint);
    await market.applyTrade(trade);
    await env.TOKEN_CACHE.delete(TOKEN_CACHE_KEY);
    return;
  }
  if (event.type === "helius") {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO chain_events (signature, event_type, mint, payload, block_time) VALUES (?1, ?2, ?3, ?4, ?5)",
    )
      .bind(
        event.signature,
        `HELIUS_${event.eventType}`,
        event.mint,
        JSON.stringify({ ...event.payload, diggoSource: event.source, diggoSlot: event.slot }),
        event.timestamp,
      )
      .run();
    return;
  }
  if (event.type === "epoch_sync") {
    // Re-read this mine's Mine/LaunchMarket accounts straight from chain — this is what keeps
    // price/reserve/status honest between real trade events (which require a Helius webhook
    // that is not wired up yet; see docs/ARCHITECTURE.md "Not yet wired").
    try {
      // Catch the mine's ledger up first, so the read below sees the state the program is actually
      // in. advance_mine is permissionless and walks a bounded 64 segments per call, and a mine more
      // than that far behind refuses claim_rewards/assign_power with SyncBehind until someone calls
      // it - so this tick is what keeps a player's own claim from being blocked by an idle mine.
      // Bounded per tick on purpose: the rest of a long catch-up waits for the next tick.
      //
      // Whether the ledger reached the present is also what graduation now depends on: the
      // program walks the mine itself before it ends the curve phase, and refuses with SyncBehind
      // while the mine is further behind than one bounded walk can cover. That answer is reacted
      // to below rather than predicted here: what this tick learned is only whether it finished
      // the catch-up itself, and the program is the authority on whether that mattered.
      try {
        const advance = await keeperAdvanceMine(env, event.mint);
        if (advance.signatures.length > 0 || !advance.caughtUp) {
          await metric(env, "keeper.mine_advanced", advance.signatures.length, { mint: event.mint });
          console.log(JSON.stringify({ event: "keeper.mine_advanced", ...advance }));
        }
      } catch (error) {
        console.error(
          JSON.stringify({ event: "keeper.mine_advance_failed", mint: event.mint, error: String(error) }),
        );
      }
      // One read of the mine's accounts answers both questions this branch has: the price to index
      // (from whichever venue holds the liquidity) and whether the market still needs graduating.
      const { token, chain: chainToken } = await syncTokenWithVenue(env, event.mint);
      // Every successful chain read is one more independent price observation for robustPrice()
      // (spec 27): a discovery amount is only ever normalized from a sequence of real prices, never
      // from the single cached spot value a small pool could move.
      //
      // The chain's own priceUsd is converted at the oracle's SOL/USD rate and only falls back to
      // the labelled illustrative constant when no source is fresh (worker/chain.ts). This sample
      // is what the roll path reads, so when the oracle is reachable the conversion is re-done here
      // against the rate that quote itself returned rather than against whatever the sync used.
      //
      // The price this samples is the venue's spot price read a moment ago, so a block the mining
      // ledger just paid out of the curve is already in it: curve-phase emission moves the token
      // side of the curve exactly where a buy of the same token amount would, and nothing here
      // adjusts for it.
      const sol = await getSolUsd(env);
      const priceUsd = sol.fromOracle ? token.priceSol * sol.priceUsd : token.priceUsd;
      await recordPriceSample(env, event.mint, priceUsd, await hourlyVolumeUsd(env, event.mint));
      // External evidence (Jupiter for a graduated mine, Pyth for SOL/USD) is refreshed on the same
      // cadence, so getRobustPrice() has an independent source to corroborate the history with
      // rather than having to trust it alone. Never throws: an aggregator outage must not fail a
      // chain sync.
      await refreshExternalQuotesSafely(env, event.mint, {
        // Graduation is a venue question, not a status one: a mine whose curve-phase budget is
        // spent reads CURVE_CAP_REACHED while its market is still on the curve, and it has no
        // external market for the aggregator to corroborate. Only the pool has one.
        graduated: chainToken.venue === "pool",
        fetch: typeof fetch === "function" ? fetch : null,
      });
      // Graduation last, so nothing about it can cost this pass its price sample: a market whose
      // curve has reached its target is moved into its locked pool here, and the next pass retries
      // if that fails.
      const graduated = await maybeGraduateMarket(env, event.mint, chainToken);
      if (graduated) {
        // Everything the read above wrote describes the curve: its reserves, its venue and the
        // price they imply. Graduation has just moved all of that into the pool, so re-read once
        // and let the row describe the venue that actually holds the liquidity - otherwise the API
        // serves a curve price and curve reserves for up to five minutes after the pool took them.
        // A failure here costs only the fresh row, which the next pass re-reads anyway.
        try {
          await syncTokenWithVenue(env, event.mint);
        } catch (error) {
          console.error(
            JSON.stringify({
              event: "chain.graduation_reread_failed",
              mint: event.mint,
              error: String(error),
            }),
          );
        }
      }
    } catch (error) {
      console.error(JSON.stringify({ event: "epoch.sync_failed", mint: event.mint, error: String(error) }));
    }
    await env.TOKEN_CACHE.delete(TOKEN_CACHE_KEY);
    return;
  }
  if (event.type === "sync_power") {
    const row = await env.DB.prepare("SELECT * FROM players WHERE wallet = ?1").bind(event.wallet).first<PlayerRow>();
    if (!row) return;
    const power = crewPower(crewLevelsOf(row));
    try {
      const signature = await keeperSyncCrewPower(env, event.wallet, event.mint, BigInt(power));
      if (signature) {
        await env.DB.prepare("UPDATE players SET power_synced_onchain = 1 WHERE wallet = ?1").bind(event.wallet).run();
        console.log(JSON.stringify({ event: "keeper.power_synced", wallet: event.wallet, mint: event.mint, power, signature }));
      }
    } catch (error) {
      console.error(JSON.stringify({ event: "keeper.power_sync_failed", wallet: event.wallet, mint: event.mint, error: String(error) }));
    }
    return;
  }
  if (event.type === "claim_discovery") {
    await settleDiscoveryClaim(env, event.discoveryId);
    return;
  }
  if (event.type === "reward_claim") {
    // A mining reward is paid by the player's own signed claim_rewards transaction, never by the
    // keeper (see settleRewardClaim in worker/mining.ts), so this job either exposes the claim as
    // ready or records the payout the player's confirmed transaction produced.
    const settlement = await settleRewardClaim(env, event);
    console.log(JSON.stringify({ event: "mining.reward_claim_settled", ...settlement }));
    return;
  }
}

/**
 * The price the venue that backs a mint reports right now — the bonding curve before graduation,
 * the locked pool after it. Null when the accounts could not be read, or when the venue has no
 * price at all, so the caller falls back explicitly instead of being handed a number nobody read.
 */
async function readVenuePrice(
  env: RuntimeEnv,
  mint: string,
): Promise<{ priceSol: number; priceUsd: number; venue: ChainSyncedToken["venue"] } | null> {
  try {
    const token = await readTokenFromChain(env, mint);
    if (!(token.priceSol > 0)) return null;
    if (token.venue === "pool") {
      console.log(JSON.stringify({ event: "indexing.pool_venue_read", mint }));
    }
    return { priceSol: token.priceSol, priceUsd: token.priceUsd, venue: token.venue };
  } catch (error) {
    console.error(
      JSON.stringify({ event: "indexing.venue_price_failed", mint, error: String(error) }),
    );
    return null;
  }
}

/**
 * One trade priced at its venue's own quote. With no fresh read the event's own price is kept: a
 * fill that really happened still belongs in the index, and dropping it would leave a hole in the
 * chart the market Durable Object replays.
 */
export function priceTrade(
  trade: MarketTrade,
  venuePrice: { priceSol: number; priceUsd: number } | null,
): MarketTrade {
  if (!venuePrice || !(venuePrice.priceSol > 0)) return trade;
  return { ...trade, priceSol: venuePrice.priceSol, priceUsd: venuePrice.priceUsd };
}

/**
 * Graduates a market whose bonding curve has reached its target, from the indexing loop
 * (docs/ONCHAIN.md §6). The call is idempotent by construction — keeperGraduateMarket reads the
 * market and returns null rather than throwing when there is no market, no pool, an already
 * graduated market or a curve still short of its target — and this only asks when the fresh chain
 * read says there is something to do, so a healthy graduated market costs nothing.
 *
 * The mine's ledger has to be caught up first. graduate_market walks the mine to the present under
 * the curve phase before it ends that phase — every block that landed before graduation is paid
 * out of the curve's own token inventory — and refuses with SyncBehind while the mine is further
 * behind than one bounded walk can cover.
 *
 * That refusal is the program's verdict, and this loop reacts to it rather than predicting it.
 * This tick has already advanced the mine as far as its call budget allowed, and a SyncBehind
 * answer defers graduation to the next tick, which advances it again and asks again. Predicting it
 * off the worker's own model of the ledger is what used to stall: a mine with no power owes
 * nothing, so the program answers CaughtUp without moving its cursor, and a keeper that read that
 * untouched cursor as "still behind" deferred every tick and never formed the pool. A wasted
 * transaction is an acceptable price for never stalling a graduation the program would allow.
 *
 * A failure is counted and swallowed, never rethrown: the queue consumer retries the whole epoch
 * sync on a throw, and the price sample this pass already wrote is not idempotent, so a retry
 * would add a second identical observation to the robust-price history. The next sync (every five
 * minutes) retries graduation naturally, and until it lands the market simply keeps trading on its
 * curve, which the program still allows.
 *
 * Returns whether the market graduated, which is what tells the caller that its own read of the
 * mine is a pre-graduation one.
 */
async function maybeGraduateMarket(
  env: RuntimeEnv,
  mint: string,
  token: ChainSyncedToken,
): Promise<boolean> {
  if (!token.graduationReady) return false;
  try {
    const signature = await keeperGraduateMarket(env, mint);
    if (!signature) {
      await metric(env, "chain.graduation_noop", 1);
      return false;
    }
    await metric(env, "chain.market_graduated", 1);
    console.log(
      JSON.stringify({
        event: "keeper.market_graduated",
        mint,
        signature,
        solReserve: token.liquidityLamports.toString(),
      }),
    );
    return true;
  } catch (error) {
    // The program's own verdict that the mine is still behind: retryable, not a failure. This
    // tick advanced the mine as far as its budget allowed, so the next tick continues from there
    // and asks again.
    if (isSyncBehindError(error)) {
      await metric(env, "chain.graduation_deferred", 1, { mint, reason: "sync_behind" });
      console.log(
        JSON.stringify({ event: "keeper.graduation_deferred", mint, reason: "sync_behind" }),
      );
      return false;
    }
    await metric(env, "chain.graduation_failed", 1);
    console.error(JSON.stringify({ event: "keeper.graduation_failed", mint, error: String(error) }));
    return false;
  }
}

/**
 * Traded value in the last hour for one mint, used to weight a fresh price observation.
 */
async function hourlyVolumeUsd(env: RuntimeEnv, mint: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COALESCE(SUM(amount * price_usd), 0) AS total FROM trades WHERE mint = ?1 AND block_time >= ?2",
  )
    .bind(mint, Math.floor(Date.now() / 1_000) - 3_600)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

interface CommittedDiscovery {
  id: string;
  wallet: string;
  mint: string;
  status: string;
  token_amount: number;
}

/**
 * How long a discovery payout waits before the queue tries it again while its breaker is open.
 * Long enough not to spin on a halted mine, short enough that clearing the halt is all it takes.
 */
export const DISCOVERY_CLAIM_RETRY_SECONDS = 300;

/**
 * Pays one committed discovery from its token's own Discovery Reserve (spec 57, 70).
 *
 * Only a discovery in ELIGIBLE may be paid: that state means a wallet-signed, single-use claim won
 * the guarded PENDING -> ELIGIBLE transition, so an unauthenticated queue message can never cause a
 * payout. The row id travels to the program as `discovery_id` and seeds an on-chain receipt, so a
 * retry after a partial failure cannot pay twice.
 *
 * A breaker is checked before the keeper is called, for the same reason the claim endpoint checks
 * it: `discovery_reserve` also covers the `claims` and `discoveries` scopes for that mint and
 * scope-wide (worker/breakers.ts relevantIds), and a mine whose reserve diverged is exactly the
 * mine a payout must not be attempted against (spec 65, 78). A halted payout is not a lost one: the
 * row stays ELIGIBLE - the state that means "committed, unpaid" - and the job goes back on the
 * queue with a backoff instead of being retried in a tight loop.
 *
 * On failure the discovery is put back to ELIGIBLE (guarded, so a parallel settle that already
 * succeeded is never un-claimed) and the error is rethrown so the queue retries. If the receipt
 * already exists on chain, the discovery was paid and is marked CLAIMED rather than paid again.
 */
export async function settleDiscoveryClaim(env: RuntimeEnv, discoveryId: string): Promise<void> {
  const discovery = await env.DB.prepare(
    "SELECT id, wallet, mint, status, token_amount FROM discoveries WHERE id = ?1",
  )
    .bind(discoveryId)
    .first<CommittedDiscovery>();
  if (!discovery) return; // already gone — nothing to pay
  if (discovery.status === "CLAIMED") return; // idempotent replay
  if (discovery.status !== "ELIGIBLE") return; // not committed by a signed claim, so not payable

  if (await isBreakerOpen(env, "discovery_reserve", discovery.mint)) {
    await metric(env, "discovery.claim_deferred", 1, { reason: "breaker_open", mint: discovery.mint });
    await env.INDEXING_QUEUE.send(
      { type: "claim_discovery", discoveryId: discovery.id } satisfies IndexingEvent,
      { delaySeconds: DISCOVERY_CLAIM_RETRY_SECONDS },
    );
    console.log(
      JSON.stringify({ event: "keeper.discovery_claim_deferred", id: discovery.id, mint: discovery.mint }),
    );
    return;
  }

  const token = await env.DB.prepare("SELECT decimals FROM tokens WHERE mint = ?1")
    .bind(discovery.mint)
    .first<{ decimals: number }>();
  const decimals = token?.decimals ?? 6;
  const amountRaw = BigInt(Math.round(discovery.token_amount * 10 ** decimals));
  if (amountRaw <= 0n) {
    await env.DB.prepare(
      "UPDATE discoveries SET status = 'REJECTED', failure_reason = 'zero_amount' WHERE id = ?1 AND status = 'ELIGIBLE'",
    )
      .bind(discovery.id)
      .run();
    await metric(env, "discovery.claim_denied", 1, { reason: "zero_amount" });
    return;
  }

  const now = Math.floor(Date.now() / 1_000);
  try {
    const signature = await keeperClaimDiscovery(
      env,
      discovery.wallet,
      discovery.mint,
      amountRaw,
      discovery.id,
    );
    const settled = await env.DB.prepare(
      `UPDATE discoveries
          SET status = 'CLAIMED', tx_signature = ?1, claimed_at = ?2, failure_reason = NULL
        WHERE id = ?3 AND status = 'ELIGIBLE'`,
    )
      .bind(signature, now, discovery.id)
      .run();
    if (settled.meta.changes !== 1) {
      // A concurrent settle already recorded this payout; the on-chain receipt means it was paid
      // once, so there is nothing left to do but note the race.
      await metric(env, "discovery.claim_conflict", 1, { stage: "settle" });
      return;
    }
    // Mirror the spend into the indexed reserve immediately. The next chain sync overwrites this
    // with the authoritative on-chain value, and until then it keeps the local view conservative.
    await env.DB.prepare(
      `UPDATE tokens
          SET discovery_reserve_remaining = MAX(0, discovery_reserve_remaining - ?1),
              discovery_epoch_spent = discovery_epoch_spent + ?1
        WHERE mint = ?2`,
    )
      .bind(discovery.token_amount, discovery.mint)
      .run();
    await metric(env, "discovery.claimed", discovery.token_amount, { mint: discovery.mint });
    console.log(
      JSON.stringify({
        event: "keeper.discovery_claimed",
        id: discovery.id,
        wallet: discovery.wallet,
        signature,
      }),
    );
  } catch (error) {
    if (await keeperDiscoveryReceiptExists(env, discovery.mint, discovery.id)) {
      // The program recorded a payout for this discovery id before the D1 write landed, so the
      // reward is already with the player. Mark it settled instead of paying a second time.
      await env.DB.prepare(
        `UPDATE discoveries SET status = 'CLAIMED', claimed_at = ?1, failure_reason = 'receipt_already_initialized'
          WHERE id = ?2 AND status = 'ELIGIBLE'`,
      )
        .bind(now, discovery.id)
        .run();
      await metric(env, "discovery.claimed", discovery.token_amount, { mint: discovery.mint, recovered: "receipt" });
      console.log(
        JSON.stringify({ event: "keeper.discovery_claimed_recovered", id: discovery.id, wallet: discovery.wallet }),
      );
      return;
    }
    await recoverEligibleDiscovery(env, discovery.id, String(error).slice(0, 200));
    await metric(env, "discovery.claim_failed", 1, { mint: discovery.mint });
    console.error(
      JSON.stringify({ event: "keeper.discovery_claim_failed", id: discovery.id, error: String(error) }),
    );
    // Retry through the queue: the row is back to ELIGIBLE and the on-chain receipt makes the
    // retry idempotent, so a flaky RPC cannot permanently strand a real reward.
    throw error;
  }
}

export async function queueEpochSync(env: RuntimeEnv): Promise<number> {
  // Every launched mine gets re-read from chain — including pre-graduation LAUNCHING mines,
  // whose bonding-curve price moves with every buy/sell just as much as a graduated one's.
  //
  // A market that is still on its curve is always re-read, whatever its mining status says:
  // this pass is also the only thing that notices a curve that has reached its graduation
  // target, and an idle mine waiting for exactly that graduation is the state most likely to be
  // skipped. FULLY_MINED only ever excludes a mine the program itself has finished — a spent
  // Mining Reserve after graduation — which has nothing left to re-read.
  const result = await env.DB.prepare(
    "SELECT mint FROM tokens WHERE status != 'FULLY_MINED' OR venue != 'pool'",
  ).all<{
    mint: string;
  }>();
  const timestamp = Date.now();
  for (let index = 0; index < result.results.length; index += 100) {
    await env.INDEXING_QUEUE.sendBatch(
      result.results.slice(index, index + 100).map(({ mint }) => ({
        body: { type: "epoch_sync", mint, timestamp } satisfies IndexingEvent,
      })),
    );
  }
  return result.results.length;
}
