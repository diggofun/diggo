/**
 * Worker entry point: the fetch router, the cron trigger and the queue consumer. All real work
 * lives in the domain modules beside this file (auth, player, mining, crew, discovery, tokens,
 * leaderboard, rpc, indexing, market); this file only wires paths to them.
 */
import type { IndexingEvent } from "../shared/types";
import { DIGGO_CONFIG } from "../shared/config";
import { adminAbuse, adminBreakers, adminMetrics, adminRestrictions } from "./admin";
import { createChallenge, verifyWallet, walletSession } from "./auth";
import { crewUpgrade } from "./crew";
import { equipCosmetic, getCosmetics, playerAchievements, syncSeasonalPoints, unequipCosmetic } from "./cosmetics";
import {
  claimDiscovery,
  claimDiscoveryChallenge,
  discoveryOpportunity,
  listDiscoveries,
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
  listRewardClaims,
  mineInfo,
  switchMine,
} from "./mining";
import { getNotifications, markNotificationsRead, runSocialCron } from "./notifications";
import { AccountCreationDenied, playerProfile } from "./player";
import { riskCron, verifyChallenge } from "./risk";
import { proxyRpc } from "./rpc";
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
      return activateMine(request, env);
    }
    if (request.method === "POST" && pathname === "/api/crew/upgrade") {
      return crewUpgrade(request, env);
    }
    if (request.method === "POST" && pathname === "/api/mine/switch") {
      return switchMine(request, env);
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
      return claimReward(request, env);
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
      return rollDiscoveryRequest(request, env);
    }
    if (request.method === "POST" && pathname === "/api/discovery/claim/challenge") {
      return claimDiscoveryChallenge(request, env);
    }
    if (request.method === "POST" && pathname === "/api/discovery/claim") {
      return claimDiscovery(request, env);
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
    if (request.method === "POST" && pathname === "/webhooks/helius") {
      return heliusWebhook(request, env);
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
    const requestId = crypto.randomUUID();
    console.error(JSON.stringify({ event: "request.failed", requestId, pathname, error: String(error) }));
    return json({ error: "Request failed", requestId }, { status: 500 });
  }
}

export default {
  fetch: handleFetch,
  async scheduled(_controller: ScheduledController, env: RuntimeEnv): Promise<void> {
    const queued = await queueEpochSync(env);
    console.log(JSON.stringify({ event: "epoch.cron", queued }));
    // Social sweep: achievements, cosmetic unlocks, seasonal point high-water marks and the
    // notifications due for recently active accounts (spec 68, 75).
    const social = await runSocialCron(env);
    console.log(JSON.stringify({ event: "social.cron", ...social }));
    const risk = await riskCron(env);
    console.log(JSON.stringify({ event: "risk.cron", ...risk }));
  },
  async queue(batch: MessageBatch<IndexingEvent>, env: RuntimeEnv): Promise<void> {
    for (const message of batch.messages) {
      try {
        await processQueueEvent(message.body, env);
        message.ack();
      } catch (error) {
        console.error(JSON.stringify({ event: "queue.failed", id: message.id, error: String(error) }));
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<RuntimeEnv, IndexingEvent>;
