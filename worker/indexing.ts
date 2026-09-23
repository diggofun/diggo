/**
 * The indexing pipeline: Helius webhooks land here, are normalized into IndexingEvent jobs on
 * INDEXING_QUEUE, and are applied to D1 and the market Durable Object by the queue consumer.
 * The cron trigger re-reads every live mine from chain through the same queue.
 */
import { crewPower } from "../shared/economics";
import { normalizeHeliusEvent } from "../shared/helius";
import type { IndexingEvent } from "../shared/types";
import { syncTokenToD1 } from "./chain";
import { recordPriceSample, recoverEligibleDiscovery } from "./discovery";
import type { RuntimeEnv } from "./env";
import { apiError, json, readJson, sameSecret } from "./http";
import { keeperClaimDiscovery, keeperDiscoveryReceiptExists, keeperSyncCrewPower } from "./keeper";
import { settleRewardClaim } from "./mining";
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
    const { trade, mint } = event;
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
      const token = await syncTokenToD1(env, event.mint);
      // Every successful chain read is one more independent price observation for robustPrice()
      // (spec 27): a discovery amount is only ever normalized from a sequence of real prices, never
      // from the single cached spot value a small pool could move.
      await recordPriceSample(env, event.mint, token.priceUsd, await hourlyVolumeUsd(env, event.mint));
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

/** Traded value in the last hour for one mint, used to weight a fresh price observation. */
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
 * Pays one committed discovery from its token's own Discovery Reserve (spec 57, 70).
 *
 * Only a discovery in ELIGIBLE may be paid: that state means a wallet-signed, single-use claim won
 * the guarded PENDING -> ELIGIBLE transition, so an unauthenticated queue message can never cause a
 * payout. The row id travels to the program as `discovery_id` and seeds an on-chain receipt, so a
 * retry after a partial failure cannot pay twice.
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
  const result = await env.DB.prepare("SELECT mint FROM tokens WHERE status != 'FULLY_MINED'").all<{
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
