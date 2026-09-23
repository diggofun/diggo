/**
 * Worker entry point: the fetch router, the cron trigger and the queue consumer. All real work
 * lives in the domain modules beside this file (auth, player, mining, crew, discovery, tokens,
 * leaderboard, rpc, indexing, market); this file only wires paths to them.
 */
import type { IndexingEvent } from "../shared/types";
import { DIGGO_CONFIG } from "../shared/config";
import { adminAbuse, adminBreakers, adminMetrics, adminRestrictions, adminStepUp } from "./admin";
import { adminAppeals, adminResolveAppeal, submitAppeal } from "./appeals";
import { createChallenge, sessionWallet, verifyWallet, walletSession } from "./auth";
import { crewUpgrade } from "./crew";
import { equipCosmetic, getCosmetics, playerAchievements, syncSeasonalPoints, unequipCosmetic } from "./cosmetics";
import {
  claimDiscovery,
  claimDiscoveryChallenge,
  discoveryCommitmentReveal,
  discoveryCommitments,
  discoveryOpportunity,
  listDiscoveries,
  prepublishRngCommitments,
  rollDiscoveryRequest,
} from "./discovery";
import type { RuntimeEnv } from "./env";
import { apiError, json } from "./http";
import { heliusWebhook, processQueueEvent, queueEpochSync } from "./indexing";
import { leaderboards } from "./leaderboard";
import {
  activateChallenge,
  activateMine,
  claimReward,
  claimRewardChallenge,
  collectMiningReport,
  confirmRewardClaim,
  listRewardClaims,
  mineInfo,
  switchMine,
} from "./mining";
import { getNotifications, markNotificationsRead, runSocialCron } from "./notifications";
import { AccountCreationDenied, playerProfile } from "./player";
import { PlayerLockTimeoutError, withPlayerLock } from "./playerLock";
import {
  deletePushSubscription,
  pushPublicKey,
  registerPushSubscription,
  startTelegramLink,
  telegramWebhook,
} from "./push";
import { reconcileReserves } from "./reconcile";
import { riskCron, verifyChallenge } from "./risk";
import { proxyRpc } from "./rpc";
import { reportError } from "./telemetry";
import {
  bootstrap,
  listTokens,
  recordTrade,
  registerLaunchedToken,
  serveMedia,
  tokenBySlug,
  tokenLimit,
  uploadMedia,
} from "./tokens";

// The TokenMarket Durable Object class has to be exported from the Worker entry module for the
// MARKETS binding in wrangler.jsonc to resolve; it is defined in ./market.
export { TokenMarket } from "./market";

// Same for the PLAYER_LOCK binding: the per-wallet mutation mutex, defined in ./playerLock.
export { PlayerLock } from "./playerLock";

/**
 * Runs one sensitive, per-wallet mutation while holding the PLAYER_LOCK lease (worker/playerLock.ts).
 *
 * The lock is taken at the router so the domain modules stay unaware of it, and it is keyed on the
 * signed session wallet rather than on a body field: a request that has no session yet is simply
 * passed through, and the handler answers 401 itself. Without the binding (tests, a local run
 * without it) withPlayerLock executes the handler directly.
 */
async function locked(
  request: Request,
  env: RuntimeEnv,
  handler: (request: Request) => Promise<Response>,
): Promise<Response> {
  const wallet = await sessionWallet(request, env);
  if (!wallet) return handler(request);
  return withPlayerLock(env, wallet, () => handler(request));
}

async function handleFetch(request: Request, env: RuntimeEnv, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  try {
    if (request.method === "GET" && pathname === "/api/config") {
      return json({
        cluster: env.SOLANA_CLUSTER,
        posthogApiKey: env.POSTHOG_API_KEY,
        posthogHost: env.POSTHOG_HOST,
        turnstileSiteKey: env.TURNSTILE_SITE_KEY,
        programId: env.DIGGO_PROGRAM_ID,
        vanitySuffix: env.VANITY_SUFFIX,
      });
    }
    if (request.method === "GET" && pathname === "/api/bootstrap") {
      return bootstrap(env, ctx, tokenLimit(url.searchParams.get("limit")));
    }
    if (request.method === "GET" && pathname === "/api/tokens") {
      return listTokens(env, ctx, tokenLimit(url.searchParams.get("limit")));
    }
    if (request.method === "GET" && pathname === "/api/leaderboards") return leaderboards(env, ctx);
    const tokenMatch = pathname.match(/^\/api\/tokens\/([^/]+)$/);
    if (request.method === "GET" && tokenMatch) return tokenBySlug(tokenMatch[1], env);
    const liveMatch = pathname.match(/^\/api\/tokens\/([^/]+)\/live$/);
    if (request.method === "GET" && liveMatch) {
      const market = env.MARKETS.getByName(liveMatch[1]);
      return market.fetch(request);
    }
    const tradeMatch = pathname.match(/^\/api\/tokens\/([^/]+)\/trades$/);
    if (request.method === "POST" && tradeMatch) return recordTrade(request, env, tradeMatch[1]);
    if (request.method === "POST" && pathname === "/api/auth/challenge") {
      return createChallenge(request, env);
    }
    if (request.method === "POST" && pathname === "/api/auth/verify") {
      return verifyWallet(request, env);
    }
    if (request.method === "GET" && pathname === "/api/auth/session") {
      return walletSession(request, env);
    }
    if (request.method === "POST" && pathname === "/api/media") return uploadMedia(request, env);
    if (request.method === "POST" && pathname === "/api/tokens/register") {
      return registerLaunchedToken(request, env);
    }
    if (request.method === "POST" && pathname === "/api/rpc") return proxyRpc(request, env);
    if (request.method === "POST" && pathname === "/api/mine/activate/challenge") {
      return activateChallenge(request, env);
    }
    if (request.method === "POST" && pathname === "/api/mine/activate") {
      return locked(request, env, () => activateMine(request, env));
    }
    if (request.method === "POST" && pathname === "/api/crew/upgrade") {
      return locked(request, env, () => crewUpgrade(request, env));
    }
    if (request.method === "POST" && pathname === "/api/mine/switch") {
      return locked(request, env, () => switchMine(request, env));
    }
    // Mining Report (spec 29), mine information (spec 33) and reward claims (spec 53, 57).
    // COLLECT is idempotent per activation window, and a claim only ever transitions
    // ELIGIBLE -> CLAIMED through one conditional UPDATE.
    if (request.method === "POST" && pathname === "/api/mine/report/collect") {
      return collectMiningReport(request, env);
    }
    const mineInfoMatch = pathname.match(/^\/api\/mines\/([^/]+)\/info$/);
    if (request.method === "GET" && mineInfoMatch) return mineInfo(request, env, mineInfoMatch[1]);
    if (request.method === "POST" && pathname === "/api/rewards/claim/challenge") {
      return claimRewardChallenge(request, env);
    }
    if (request.method === "POST" && pathname === "/api/rewards/claim") {
      return locked(request, env, () => claimReward(request, env));
    }
    // The player's own on-chain claim_rewards transaction is reported here and verified against
    // chain before the payout is recorded (see confirmRewardClaim in worker/mining.ts).
    if (request.method === "POST" && pathname === "/api/rewards/claim/confirm") {
      return confirmRewardClaim(request, env);
    }
    const rewardsMatch = pathname.match(/^\/api\/player\/([^/]+)\/rewards$/);
    if (request.method === "GET" && rewardsMatch) return listRewardClaims(request, env, rewardsMatch[1]);
    // Discovery is its own security surface: the opportunity is authored server-side once per
    // window, the roll consumes it, and the claim needs a signed single-use challenge before the
    // keeper may pay (see worker/discovery.ts).
    if (request.method === "POST" && pathname === "/api/discovery/opportunity") {
      return discoveryOpportunity(request, env);
    }
    if (request.method === "POST" && pathname === "/api/discovery/roll") {
      return locked(request, env, () => rollDiscoveryRequest(request, env));
    }
    if (request.method === "POST" && pathname === "/api/discovery/claim/challenge") {
      return claimDiscoveryChallenge(request, env);
    }
    if (request.method === "POST" && pathname === "/api/discovery/claim") {
      return locked(request, env, () => claimDiscovery(request, env));
    }
    // RNG commitments (spec 55): public and unauthenticated, because a commitment nobody can read
    // proves nothing. The seed only appears here once its epoch has ended.
    if (request.method === "GET" && pathname === "/api/discovery/commitments") {
      return discoveryCommitments(request, env);
    }
    const commitmentEpochMatch = pathname.match(/^\/api\/discovery\/commitments\/([^/]+)$/);
    if (request.method === "GET" && commitmentEpochMatch) {
      return discoveryCommitmentReveal(request, env, commitmentEpochMatch[1]);
    }
    // Progressive friction (spec 52) and the admin anti-abuse surface (spec 65-67). Both are
    // read-mostly: a challenge only clears friction for a short window, and the admin endpoints
    // can only place restrictions or halt discoveries/claims - never move funds.
    if (request.method === "POST" && pathname === "/api/verify/challenge") {
      return verifyChallenge(request, env);
    }
    if (request.method === "GET" && pathname === "/api/admin/abuse") {
      return adminAbuse(request, env);
    }
    if (request.method === "POST" && pathname === "/api/admin/restrictions") {
      return adminRestrictions(request, env);
    }
    if (request.method === "POST" && pathname === "/api/admin/breakers") {
      return adminBreakers(request, env);
    }
    if (request.method === "GET" && pathname === "/api/admin/metrics") {
      return adminMetrics(request, env);
    }
    // Admin step-up (spec 65): the short-lived signature every mutating admin call has to carry.
    if (request.method === "POST" && pathname === "/api/admin/stepup") {
      return adminStepUp(request, env);
    }
    // Appeals (spec 53, 62): a player asks a person to look again, an operator decides from a
    // queue. Filing one changes nothing by itself, and deciding one can only lift restrictions.
    if (request.method === "POST" && pathname === "/api/appeals") {
      return submitAppeal(request, env);
    }
    if (pathname === "/api/admin/appeals") {
      return request.method === "GET" ? adminAppeals(request, env) : adminResolveAppeal(request, env);
    }
    const playerMatch = pathname.match(/^\/api\/player\/([^/]+)$/);
    if (request.method === "GET" && playerMatch) return playerProfile(request, env, playerMatch[1]);
    const discoveriesMatch = pathname.match(/^\/api\/player\/([^/]+)\/discoveries$/);
    if (request.method === "GET" && discoveriesMatch) return listDiscoveries(request, env, discoveriesMatch[1]);
    const achievementsMatch = pathname.match(/^\/api\/player\/([^/]+)\/achievements$/);
    if (request.method === "GET" && achievementsMatch) {
      return playerAchievements(request, env, achievementsMatch[1]);
    }
    // Cosmetics (spec 34) are visual only; seasonal points (spec 68) come from gameplay progression.
    if (request.method === "GET" && pathname === "/api/cosmetics") return getCosmetics(request, env);
    if (request.method === "POST" && pathname === "/api/cosmetics/equip") return equipCosmetic(request, env);
    if (request.method === "POST" && pathname === "/api/cosmetics/unequip") return unequipCosmetic(request, env);
    if (request.method === "POST" && pathname === "/api/seasonal/sync") return syncSeasonalPoints(request, env);
    // Notifications (spec 75).
    if (request.method === "GET" && pathname === "/api/notifications") return getNotifications(request, env);
    if (request.method === "POST" && pathname === "/api/notifications/read") {
      return markNotificationsRead(request, env);
    }
    // Web Push opt-in (worker/push.ts). The key endpoint is readable before sign-in because a
    // browser cannot subscribe without the application server key; the subscription endpoints only
    // ever touch devices belonging to the signed-in wallet.
    if (request.method === "GET" && pathname === "/api/push/key") return pushPublicKey(request, env);
    if (request.method === "POST" && pathname === "/api/push/subscription") {
      return registerPushSubscription(request, env);
    }
    if (request.method === "DELETE" && pathname === "/api/push/subscription") {
      return deletePushSubscription(request, env);
    }
    // Optional Telegram channel: a one-time code for the signed-in wallet, and the bot webhook that
    // consumes it. The webhook fails closed when TELEGRAM_WEBHOOK_SECRET is unset or wrong.
    if (request.method === "POST" && pathname === "/api/telegram/link") {
      return startTelegramLink(request, env);
    }
    if (request.method === "POST" && pathname === "/webhooks/helius") {
      return heliusWebhook(request, env);
    }
    if (request.method === "POST" && pathname === "/webhooks/telegram") {
      return telegramWebhook(request, env);
    }
    if (request.method === "GET" && pathname.startsWith("/media/")) return serveMedia(pathname, env);
    if (request.method === "GET" && pathname === "/ARCHITECTURE.md") {
      return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
    }
    if (pathname.startsWith("/api/") || pathname.startsWith("/webhooks/")) {
      return apiError("Route not found", 404);
    }
    return env.ASSETS.fetch(request);
  } catch (error) {
    // A brand-new wallet refused an account is a rate limit, not a fault (spec 48, 62). The copy
    // stays neutral and reveals nothing about how the anti-abuse layer decided.
    if (error instanceof AccountCreationDenied) {
      const { gate } = error;
      const message = gate.publicMessage ?? DIGGO_CONFIG.risk.publicStatus[gate.rewardState];
      return gate.retryAfterSec === undefined
        ? json({ code: gate.rewardState, message }, { status: 403 })
        : json(
            { code: "RATE_LIMITED", message },
            { status: 429, headers: { "retry-after": String(gate.retryAfterSec) } },
          );
    }
    if (error instanceof PlayerLockTimeoutError) {
      // Two overlapping mutations for one wallet: this one waited out the lease budget without
      // being granted it. Nothing was applied, so a retry is always safe.
      return json(
        { code: "BUSY", message: "Another request for this wallet is still in progress." },
        { status: 429, headers: { "retry-after": "2" } },
      );
    }
    const requestId = crypto.randomUUID();
    console.error(JSON.stringify({ event: "request.failed", requestId, pathname, error: String(error) }));
    // Sentry reporting is fire-and-forget and a no-op when SENTRY_DSN is unset.
    ctx.waitUntil(reportError(env, error, { pathname, requestId, method: request.method }));
    return json({ error: "Request failed", requestId }, { status: 500 });
  }
}

export default {
  fetch: handleFetch,
  async scheduled(
    _controller: ScheduledController,
    env: RuntimeEnv,
    ctx: ExecutionContext,
  ): Promise<void> {
    try {
      const queued = await queueEpochSync(env);
      console.log(JSON.stringify({ event: "epoch.cron", queued }));
      // Social sweep: achievements, cosmetic unlocks, seasonal point high-water marks and the
      // notifications due for recently active accounts (spec 68, 75).
      const social = await runSocialCron(env);
      console.log(JSON.stringify({ event: "social.cron", ...social }));
      const risk = await riskCron(env);
      console.log(JSON.stringify({ event: "risk.cron", ...risk }));
      // Reserve reconciliation (spec 57, 78): compare each mine's D1 accounting against the
      // program's own Mine account and reserve vault, and halt claims for a mine that diverged.
      const reconcile = await reconcileReserves(env);
      console.log(JSON.stringify({ event: "reconcile.cron", ...reconcile }));
      // RNG commitments (spec 55): publish the commitment for the running epoch and the next one,
      // and reveal the seeds of epochs that have ended, so every discovery roll can be recomputed
      // by anyone after the fact.
      const rng = await prepublishRngCommitments(env);
      console.log(JSON.stringify({ event: "rng.commitments", ...rng }));
    } catch (error) {
      console.error(JSON.stringify({ event: "scheduled.failed", error: String(error) }));
      ctx.waitUntil(reportError(env, error, { trigger: "scheduled" }));
      // Rethrow so Cloudflare still records the failed invocation.
      throw error;
    }
  },
  async queue(batch: MessageBatch<IndexingEvent>, env: RuntimeEnv, ctx: ExecutionContext): Promise<void> {
    for (const message of batch.messages) {
      try {
        await processQueueEvent(message.body, env);
        message.ack();
      } catch (error) {
        console.error(JSON.stringify({ event: "queue.failed", id: message.id, error: String(error) }));
        ctx.waitUntil(reportError(env, error, { trigger: "queue", messageId: message.id }));
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<RuntimeEnv, IndexingEvent>;
