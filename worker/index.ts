/**
 * Worker entry point: the fetch router, the cron trigger and the queue consumer.
 *
 * What this Worker is, in one sentence: an indexer of the v2 program, a read API over that index,
 * a notification sender, and an optional crank. What it is not, and cannot be: an authority over
 * any player's money. There is no keeper key, no RNG secret, no payout path, no hold and no
 * operator-signed instruction anywhere below - every value movement in the protocol is an
 * instruction a player or a stranger signs.
 *
 * The one privileged surface left is admin: it can restrict a wallet's *off-chain* surfaces and
 * read metrics, and it has no code path to a balance, a reserve, a claim or a coin.
 */
import { adminAbuse, adminMetrics, adminRestrictions, adminStepUp } from "./admin";
import { adminDashboard } from "./adminDashboard";
import { adminAppeals, adminResolveAppeal, submitAppeal } from "./appeals";
import { createChallenge, verifyWallet, walletSession } from "./auth";
import { equipCosmetic, getCosmetics, playerAchievements, syncSeasonalPoints, unequipCosmetic } from "./cosmetics";
import { crankHistory, runCrank } from "./crank";
import {
  globalBudget,
  listCoinDiscoveries,
  listDiscoveries,
  listEpochSeeds,
} from "./discovery";
import { optionalBinding, type RuntimeEnv } from "./env";
import { apiError, checkRateLimit, isBase58Address, json, sameSecret } from "./http";
import {
  heliusWebhook,
  indexerCron,
  processIndexerJob,
  refreshCoin,
  refreshPlayer,
} from "./indexing";
import { recordJobRun } from "./indexStore";
import { leaderboards } from "./leaderboard";
import { chainReachable, mineInfo, mineReport } from "./mine";
import { getNotifications, markNotificationsRead, runSocialCron } from "./notifications";
import { getSolUsd } from "./oracle";
import { playerProfile } from "./player";
import { portfolioForWallet } from "./portfolio";
import { publicProfile, setUsername } from "./profile";
import {
  deletePushSubscription,
  pushPublicKey,
  registerPushSubscription,
  startTelegramLink,
  telegramWebhook,
} from "./push";
import { reconcileIndex } from "./reconcile";
import { riskCron, verifyChallenge } from "./risk";
import { sponsorEvents, sponsorEventsForOwner } from "./sponsors";
import { proxyRpc } from "./rpc";
import { ChainConfigurationError, isLocalChainRequest, isLocalChainRuntime, resolveChainConfig } from "./chainV2";
import { reportError } from "./telemetry";
import { watchlistRoute } from "./watchlist";
import {
  captureReferralForSession,
  changeReferralCode,
  referralAvailability,
  referralPanel,
  sweepMeteoraReferralOre,
  sweepReferralOre,
} from "./referrals";
import {
  bootstrap,
  coinTrades,
  listTokens,
  registerLaunchedToken,
  serveMedia,
  tokenBySlug,
  tokenLimit,
  uploadMedia,
} from "./tokens";
import type { IndexerJob } from "./v2/types";
import { officialMintFromEnv } from "../shared/officialMint";
import { handleMeteoraGameRoute, meteoraBootstrap, meteoraConfig, meteoraMineInfo, meteoraPlayerProfile, meteoraPortfolio, meteoraTokenBySlug, runMeteoraScheduled } from "./modes/meteora";
import { registerMeteoraPool } from "./meteora/registration";
import { meteoraCandles } from "./candles";

// The TokenMarket Durable Object is exported from the entry module so the MARKETS binding in
// wrangler.jsonc resolves; it is defined in ./market.
export { TokenMarket } from "./market";

async function handleFetch(request: Request, env: RuntimeEnv, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  try {
    // Temporary Meteora mode owns the off-chain game routes and the alternate indexed data. Keep
    // this block separate from the native router so native behaviour remains unchanged.
    if (String(env.CHAIN_MODE || "meteora") !== "native") {
      const gameRoute = await handleMeteoraGameRoute(request, env, pathname);
      if (gameRoute) return gameRoute;
      if (request.method === "GET" && pathname === "/api/config") return json(meteoraConfig(env));
      if (request.method === "GET" && pathname === "/api/bootstrap") return meteoraBootstrap(env, ctx);
      if (request.method === "GET" && pathname === "/api/tokens") return meteoraBootstrap(env, ctx);
      const meteoraTokenMatch = pathname.match(/^\/api\/tokens\/([^/]+)$/);
      if (request.method === "GET" && meteoraTokenMatch) return meteoraTokenBySlug(env, meteoraTokenMatch[1]!);
      const meteoraCandlesMatch = pathname.match(/^\/api\/tokens\/([^/]+)\/candles$/);
      if (request.method === "GET" && meteoraCandlesMatch) return meteoraCandles(env, meteoraCandlesMatch[1]!, url.searchParams.get("interval"));
      if (request.method === "POST" && pathname === "/api/meteora/pools/register") return registerMeteoraPool(request, env);
      const meteoraPlayerMatch = pathname.match(/^\/api\/player\/([^/]+)$/);
      if (request.method === "GET" && meteoraPlayerMatch) return meteoraPlayerProfile(env, meteoraPlayerMatch[1]!);
      const meteoraPortfolioMatch = pathname.match(/^\/api\/portfolio\/([^/]+)$/);
      if (request.method === "GET" && meteoraPortfolioMatch) return meteoraPortfolio(env, meteoraPortfolioMatch[1]!);
      const meteoraMineMatch = pathname.match(/^\/api\/mines\/([^/]+)\/info$/);
      if (request.method === "GET" && meteoraMineMatch) return meteoraMineInfo(env, meteoraMineMatch[1]!, url.searchParams.get("wallet"));
    }
    if (request.method === "GET" && pathname === "/api/config") {
      const chain = resolveChainConfig(env, {
        deployed: !isLocalChainRequest(request) && !isLocalChainRuntime(env),
      });
      return json({
        cluster: chain.cluster,
        posthogApiKey: env.POSTHOG_API_KEY,
        posthogHost: env.POSTHOG_HOST,
        turnstileSiteKey: env.TURNSTILE_SITE_KEY,
        programId: chain.programId ?? "",
        vanitySuffix: env.VANITY_SUFFIX,
        // Validated, not passed through: a blank or mistyped var reads as "not launched" (null).
        officialMint: officialMintFromEnv(optionalBinding<string>(env, "DIGGO_OFFICIAL_MINT")),
      });
    }
    // The read API. Every payload shape below is WS-E's, and the frontend consumes it as-is.
    if (request.method === "GET" && pathname === "/api/bootstrap") {
      resolveChainConfig(env, { deployed: !isLocalChainRequest(request) && !isLocalChainRuntime(env) });
      return bootstrap(env, ctx, tokenLimit(url.searchParams.get("limit")));
    }
    if (request.method === "GET" && pathname === "/api/tokens") {
      return listTokens(env, ctx, tokenLimit(url.searchParams.get("limit")));
    }
    const tokenMatch = pathname.match(/^\/api\/tokens\/([^/]+)$/);
    if (request.method === "GET" && tokenMatch) return tokenBySlug(tokenMatch[1]!, env);
    const tradesMatch = pathname.match(/^\/api\/tokens\/([^/]+)\/trades$/);
    if (request.method === "GET" && tradesMatch) {
      return coinTrades(env, tradesMatch[1]!, Number.parseInt(url.searchParams.get("limit") ?? "", 10) || 100);
    }
    const liveMatch = pathname.match(/^\/api\/tokens\/([^/]+)\/live$/);
    if (request.method === "GET" && liveMatch) {
      const market = env.MARKETS.getByName(liveMatch[1]!);
      return market.fetch(request);
    }
    if (request.method === "GET" && pathname === "/api/leaderboards") {
      return leaderboards(request, env, Number.parseInt(url.searchParams.get("limit") ?? "", 10) || 25);
    }
    const mineInfoMatch = pathname.match(/^\/api\/mines\/([^/]+)\/info$/);
    if (request.method === "GET" && mineInfoMatch) return mineInfo(request, env, mineInfoMatch[1]!);
    const mineReportMatch = pathname.match(/^\/api\/mines\/([^/]+)\/report$/);
    if (request.method === "GET" && mineReportMatch) {
      return mineReport(request, env, mineReportMatch[1]!);
    }
    const coinDiscoveriesMatch = pathname.match(/^\/api\/coins\/([^/]+)\/discoveries$/);
    if (request.method === "GET" && coinDiscoveriesMatch) {
      return listCoinDiscoveries(request, env, coinDiscoveriesMatch[1]!);
    }
    // Discovery is read-only here. The roll, the settle and the expiry are all instructions; the
    // seed feed below is what lets anyone recompute an outcome without trusting this server.
    if (request.method === "GET" && pathname === "/api/discovery/seeds") {
      return listEpochSeeds(request, env);
    }
    if (request.method === "GET" && pathname === "/api/discovery/budget") {
      return globalBudget(request, env);
    }
    // Sponsorship: the indexer is the only thing that can enumerate events, because they are PDAs
    // keyed on (vault, event_id) with no on-chain registry. The client re-reads each one on chain.
    if (request.method === "GET" && pathname === "/api/sponsors/events") {
      return sponsorEvents(request, env);
    }
    const sponsorOwnerMatch = pathname.match(/^\/api\/sponsors\/([^/]+)\/events$/);
    if (request.method === "GET" && sponsorOwnerMatch) {
      return sponsorEventsForOwner(request, env, sponsorOwnerMatch[1]!);
    }
    const playerMatch = pathname.match(/^\/api\/player\/([^/]+)$/);
    if (request.method === "GET" && playerMatch) return playerProfile(request, env, playerMatch[1]!);
    const discoveriesMatch = pathname.match(/^\/api\/player\/([^/]+)\/discoveries$/);
    if (request.method === "GET" && discoveriesMatch) {
      return listDiscoveries(request, env, discoveriesMatch[1]!);
    }
    const achievementsMatch = pathname.match(/^\/api\/player\/([^/]+)\/achievements$/);
    if (request.method === "GET" && achievementsMatch) {
      return playerAchievements(request, env, achievementsMatch[1]!);
    }
    // Session and identity. A username is off-chain by design; there is no game state here.
    if (request.method === "POST" && pathname === "/api/auth/challenge") {
      return createChallenge(request, env);
    }
    if (request.method === "POST" && pathname === "/api/auth/verify") return verifyWallet(request, env);
    if (request.method === "GET" && pathname === "/api/auth/session") return walletSession(request, env);
    if (request.method === "GET" && pathname === "/api/referrals") {
      return referralPanel(request, env, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
    }
    const referralCodeMatch = pathname.match(/^\/api\/referrals\/code\/([^/]+)$/);
    if (request.method === "GET" && referralCodeMatch) return referralAvailability(decodeURIComponent(referralCodeMatch[1]!), env);
    if (request.method === "POST" && pathname === "/api/referrals/code") return changeReferralCode(request, env);
    // Referrals are mode-independent, so this sits below the Meteora block on purpose: the capture
    // endpoint must answer in both modes.
    if (request.method === "POST" && pathname === "/api/referrals/capture") return captureReferralForSession(request, env);
    const profileMatch = pathname.match(/^\/api\/profile\/([^/]+)$/);
    if (request.method === "GET" && profileMatch) return publicProfile(request, env, profileMatch[1]!);
    // The watchlist (session-scoped) and the portfolio (a projection of the index).
    if (pathname.startsWith("/api/watchlist")) return watchlistRoute(request, env, pathname);
    const portfolioMatch = pathname.match(/^\/api\/portfolio\/([^/]+)$/);
    if (request.method === "GET" && portfolioMatch) {
      return portfolioForWallet(request, env, portfolioMatch[1]!);
    }
    if (request.method === "POST" && pathname === "/api/profile/username") {
      return setUsername(request, env);
    }
    if (request.method === "POST" && pathname === "/api/media") return uploadMedia(request, env);
    if (request.method === "POST" && pathname === "/api/tokens/register") {
      return registerLaunchedToken(request, env);
    }
    if (request.method === "POST" && pathname === "/api/rpc") return proxyRpc(request, env);
    // Cosmetics (visual only), seasonal points and notifications.
    if (request.method === "GET" && pathname === "/api/cosmetics") return getCosmetics(request, env);
    if (request.method === "POST" && pathname === "/api/cosmetics/equip") return equipCosmetic(request, env);
    if (request.method === "POST" && pathname === "/api/cosmetics/unequip") {
      return unequipCosmetic(request, env);
    }
    if (request.method === "POST" && pathname === "/api/seasonal/sync") {
      return syncSeasonalPoints(request, env);
    }
    if (request.method === "GET" && pathname === "/api/notifications") {
      return getNotifications(request, env);
    }
    if (request.method === "POST" && pathname === "/api/notifications/read") {
      return markNotificationsRead(request, env);
    }
    if (request.method === "GET" && pathname === "/api/push/key") return pushPublicKey(request, env);
    if (request.method === "POST" && pathname === "/api/push/subscription") {
      return registerPushSubscription(request, env);
    }
    if (request.method === "DELETE" && pathname === "/api/push/subscription") {
      return deletePushSubscription(request, env);
    }
    if (request.method === "POST" && pathname === "/api/telegram/link") {
      return startTelegramLink(request, env);
    }
    // Friction and the admin anti-abuse surface. Both are advisory: a challenge clears friction
    // for a short window, and admin can restrict off-chain surfaces and read metrics. Neither
    // has a code path to a balance, a reserve, a claim or a coin.
    if (request.method === "POST" && pathname === "/api/verify/challenge") {
      return verifyChallenge(request, env);
    }
    if (request.method === "GET" && pathname === "/api/admin/abuse") return adminAbuse(request, env);
    if (request.method === "POST" && pathname === "/api/admin/restrictions") {
      return adminRestrictions(request, env);
    }
    if (request.method === "GET" && pathname === "/api/admin/metrics") return adminMetrics(request, env);
    if (request.method === "GET" && pathname === "/api/admin/dashboard") return adminDashboard(request, env);
    if (request.method === "POST" && pathname === "/api/admin/stepup") return adminStepUp(request, env);
    if (request.method === "POST" && pathname === "/api/appeals") return submitAppeal(request, env);
    if (pathname === "/api/admin/appeals") {
      return request.method === "GET" ? adminAppeals(request, env) : adminResolveAppeal(request, env);
    }
    // Indexer diagnostics and the crank's own log. Read-only.
    if (request.method === "GET" && pathname === "/api/status") {
      resolveChainConfig(env, { deployed: !isLocalChainRequest(request) && !isLocalChainRuntime(env) });
      return json({
        chainReachable: await chainReachable(env),
        solUsd: await getSolUsd(env),
        crank: { enabled: Boolean(env.DIGGO_CRANK_SECRET_KEY), recent: await crankHistory(env, 10) },
      });
    }
    if (request.method === "POST" && pathname === "/api/indexer/coin") {
      return refreshOne(request, env, "coin", url.searchParams.get("mint"), () =>
        refreshCoin(env, url.searchParams.get("mint")!),
      );
    }
    if (request.method === "POST" && pathname === "/api/indexer/player") {
      return refreshOne(request, env, "player", url.searchParams.get("wallet"), () =>
        refreshPlayer(env, url.searchParams.get("wallet")!),
      );
    }
    if (request.method === "POST" && pathname === "/webhooks/helius") {
      return heliusWebhook(request, env);
    }
    if (request.method === "POST" && pathname === "/webhooks/telegram") {
      return telegramWebhook(request, env);
    }
    if (request.method === "GET" && pathname.startsWith("/media/")) return serveMedia(pathname, env);
    if (pathname.startsWith("/api/") || pathname.startsWith("/webhooks/")) {
      return apiError("Route not found", 404);
    }
    return env.ASSETS.fetch(request);
  } catch (error) {
    const requestId = crypto.randomUUID();
    console.error(JSON.stringify({ event: "request.failed", requestId, pathname, error: String(error) }));
    ctx.waitUntil(reportError(env, error, { pathname, requestId, method: request.method }));
    if (error instanceof ChainConfigurationError) {
      return json({ error: "Chain configuration is invalid", requestId }, { status: 503 });
    }
    return json({ error: "Request failed", requestId }, { status: 500 });
  }
}

/**
 * A manual refresh, for an operator who has just sent a transaction and does not want to wait for
 * the next pass. It is rate limited by the endpoint's own caller and it only re-reads chain.
 */
async function refreshOne(
  request: Request,
  env: RuntimeEnv,
  kind: string,
  subject: string | null,
  run: () => Promise<unknown>,
): Promise<Response> {
  if (!env.INDEXER_ADMIN_SECRET) return apiError("Manual indexer refresh is not configured", 503);
  if (!sameSecret(request.headers.get("authorization"), env.INDEXER_ADMIN_SECRET)) {
    return apiError("Indexer operator authorization required", 401);
  }
  if (!(await checkRateLimit(request, env, `indexer-${kind}`, 6))) {
    return apiError("Too many manual refresh requests", 429);
  }
  if (!subject) return apiError("A mint or wallet is required");
  if (!isBase58Address(subject)) return apiError(`Invalid ${kind} address`);
  const found = await run().catch(() => false);
  return json({ refreshed: Boolean(found), subject });
}

export default {
  fetch: handleFetch,
  /**
   * One cron tick: index, then sweep the advisory layers.
   *
   * The order matters. Indexing goes first and inside its own guard, because everything below
   * reads the index and a failure in a notification sweep must not cost the pass its chain reads.
   * Nothing here throws: a cron failure is a log line, not a retry storm against an unhappy RPC.
   */
  async scheduled(
    _controller: ScheduledController,
    env: RuntimeEnv,
    ctx: ExecutionContext,
  ): Promise<void> {
    if (String(env.CHAIN_MODE || "meteora") !== "native") {
      let cronStatus: "OK" | "FAILED" = "OK";
      try {
        const result = await runMeteoraScheduled(env);
        console.log(JSON.stringify({ event: "meteora.cron", ...result }));
      } catch (error) {
        cronStatus = "FAILED";
        console.error(JSON.stringify({ event: "meteora.cron_failed", error: String(error) }));
        ctx.waitUntil(reportError(env, error, { trigger: "scheduled", step: "meteora" }));
      }
      try {
        const referrals = await sweepMeteoraReferralOre(env);
        console.log(JSON.stringify({ event: "referrals.meteora", ...referrals }));
      } catch (error) {
        cronStatus = "FAILED";
        console.error(JSON.stringify({ event: "referrals.meteora_failed", error: String(error) }));
      }
      try {
        await recordJobRun(env, "cron:meteora", cronStatus, {
          accounts: 0,
          events: 0,
          detail: cronStatus === "FAILED" ? "one or more Meteora scheduled steps failed" : undefined,
        });
      } catch (error) {
        console.error(JSON.stringify({ event: "cron.bookkeeping_failed", error: String(error) }));
      }
      return;
    }
    try {
      resolveChainConfig(env, { deployed: !isLocalChainRuntime(env) });
    } catch (error) {
      console.error(JSON.stringify({ event: "chain.configuration_invalid", error: String(error) }));
      return;
    }
    try {
      const indexed = await indexerCron(env);
      console.log(JSON.stringify({ event: "indexer.cron", ...indexed }));
    } catch (error) {
      console.error(JSON.stringify({ event: "indexer.cron_failed", error: String(error) }));
      ctx.waitUntil(reportError(env, error, { trigger: "scheduled", step: "indexer" }));
    }
    try {
      const reconcile = await reconcileIndex(env);
      console.log(JSON.stringify({ event: "reconcile.cron", ...reconcile }));
    } catch (error) {
      console.error(JSON.stringify({ event: "reconcile.failed", error: String(error) }));
    }
    try {
      const social = await runSocialCron(env);
      console.log(JSON.stringify({ event: "social.cron", ...social }));
    } catch (error) {
      console.error(JSON.stringify({ event: "social.cron_failed", error: String(error) }));
      ctx.waitUntil(reportError(env, error, { trigger: "scheduled", step: "social" }));
    }
    try {
      const risk = await riskCron(env);
      console.log(JSON.stringify({ event: "risk.cron", ...risk }));
    } catch (error) {
      console.error(JSON.stringify({ event: "risk.cron_failed", error: String(error) }));
      ctx.waitUntil(reportError(env, error, { trigger: "scheduled", step: "risk" }));
    }
    try {
      const crank = await runCrank(env);
      if (crank.sent.length > 0 || !crank.enabled) {
        console.log(JSON.stringify({ event: "crank.run", ...crank }));
      }
    } catch (error) {
      console.error(JSON.stringify({ event: "crank.failed", error: String(error) }));
    }
    try {
      const referrals = await sweepReferralOre(env);
      if (referrals.confirmed > 0 || referrals.retried > 0 || !referrals.enabled) {
        console.log(JSON.stringify({ event: "referrals.sweep", ...referrals }));
      }
    } catch (error) {
      console.error(JSON.stringify({ event: "referrals.sweep_failed", error: String(error) }));
    }
  },
  async queue(batch: MessageBatch<IndexerJob>, env: RuntimeEnv, ctx: ExecutionContext): Promise<void> {
    try {
      resolveChainConfig(env, { deployed: !isLocalChainRuntime(env) });
    } catch (error) {
      console.error(JSON.stringify({ event: "chain.configuration_invalid", error: String(error) }));
      for (const message of batch.messages) message.retry();
      return;
    }
    for (const message of batch.messages) {
      try {
        await processIndexerJob(message.body, env);
        message.ack();
      } catch (error) {
        console.error(JSON.stringify({ event: "queue.failed", id: message.id, error: String(error) }));
        ctx.waitUntil(reportError(env, error, { trigger: "queue", messageId: message.id }));
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<RuntimeEnv, IndexerJob>;
