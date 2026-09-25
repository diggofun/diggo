import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { address } from "@solana/kit";
import bs58 from "bs58";
import "./walletConnect";
import { IconArrowUpRight, IconBadge, IconHammer } from "./icons";

import type { DiscoveryOpportunity, DiscoveryRecord, MineInfo, MiningReport, PlayerProfile, TokenSummary } from "../shared/types";
import {
  claimReward as claimRewardRequest,
  confirmRewardClaimPayout,
  getDiscoveries,
  getBootstrap,
  getChallenge,
  getMineInfo,
  getMiningState,
  getPlayerProfile,
  getPortfolio,
  getPlayerRewards,
  getReferrals,
  getRewardClaimChallenge,
  getWalletSession,
  getToken,
  verifyWallet,
  ApiError,
  type RewardClaimView,
  type DiggoConfig,
  type PortfolioSummary,
  type GameState,
  type MeteoraPortfolio,
  activateGame,
  prepareGameClaimAll,
  confirmGameClaimAll,
  getGameState,
  getMeteoraPortfolio,
  requestGameActivationChallenge,
  runGameDiscovery,
  upgradeGameCrew,
} from "./api";
import { track, trackOnce } from "./analytics";
import { TURNSTILE_SITE_KEY } from "./constants";
import { NEUTRAL_VERIFICATION_TEXT, runGated, VerificationRequiredError } from "./verification";
import { CREW_COMPONENT_LABELS, CREW_COMPONENTS } from "./crewLabels";
import { useDiggoWallet } from "./wallet";
import { clearEquippedCosmetics, loadEquippedCosmetics } from "./cosmetics";
import { AppHeader, type PageId } from "./components/AppHeader";
import { ExploreBoard, FinalCta, HomeHero, HowItWorks, SelectedMine, SiteFooter, Ticker } from "./components/HomeSections";
import { EmptyState, ErrorState, LoadingScreen, RouteFallback } from "./components/StatusViews";
import { useVerificationGate } from "./components/VerificationGate";
import { ConsentBanner } from "./components/ConsentBanner";
import { PushToggle } from "./components/PushToggle";
import { WatchlistPanel } from "./components/WatchlistPanel";
import { isLegalPath } from "./components/legal/routes";
import { usePendingTransaction } from "./onchain";
import { signPreparedClaim } from "./onchain/preparedClaim";
import { settledClaimAllNotice } from "./claimAll";
import { startMeteoraMining } from "./meteoraGameFlow";
import { crewPower } from "../shared/economics";
import { MeteoraCrewScreen, MeteoraDiscoveriesScreen, MeteoraMineDashboard, MeteoraPortfolioScreen } from "./components/MeteoraGameScreens";
import { RouteErrorBoundary } from "./components/RouteErrorBoundary";

/*
 * Every screen below the landing page is its own chunk: the swap terminal (lightweight-charts and
 * the Solana program client), the launch builder, the game screens and the admin tools only
 * download on the route that renders them.
 */
const AdminScreen = lazy(() => import("./components/AdminScreen").then((module) => ({ default: module.AdminScreen })));
const CosmeticsScreen = lazy(() => import("./components/CosmeticsScreen").then((module) => ({ default: module.CosmeticsScreen })));
const CrewScreen = lazy(() => import("./components/CrewScreen").then((module) => ({ default: module.CrewScreen })));
const DashboardPanel = lazy(() => import("./components/DashboardPanel").then((module) => ({ default: module.DashboardPanel })));
/**
 * The player's own onboarding, loaded lazily for the same reason the trade panel is: it pulls in
 * the on-chain client, and a visitor who never connects a wallet should not pay for it.
 */
const PlayerOnboarding = lazy(() =>
  import("./components/PlayerOnboarding").then((module) => ({ default: module.PlayerOnboarding })),
);
const PortfolioScreen = lazy(() => import("./components/PortfolioScreen").then((module) => ({ default: module.PortfolioScreen })));
const ReferralsScreen = lazy(() => import("./components/ReferralsScreen").then((module) => ({ default: module.ReferralsScreen })));
const DiscoveriesPanel = lazy(() => import("./components/DiscoveriesPanel").then((module) => ({ default: module.DiscoveriesPanel })));
const EconomyPanels = lazy(() => import("./components/EconomyPanels").then((module) => ({ default: module.EconomyPanels })));
const LaunchModal = lazy(() => import("./components/LaunchModal").then((module) => ({ default: module.LaunchModal })));
const LeaderboardsScreen = lazy(() => import("./components/LeaderboardsScreen").then((module) => ({ default: module.LeaderboardsScreen })));
const MineInfoPanel = lazy(() => import("./components/MineInfoPanel").then((module) => ({ default: module.MineInfoPanel })));
const MiningReportModal = lazy(() => import("./components/MiningReportModal").then((module) => ({ default: module.MiningReportModal })));
const SwapPanel = lazy(() => import("./components/SwapPanel").then((module) => ({ default: module.SwapPanel })));
/** The official coin's trade page. Lazy for the same reason: it pulls in the swap terminal. */
const DiggoTradePage = lazy(() => import("./components/DiggoTradePage").then((module) => ({ default: module.DiggoTradePage })));
const RentReclaimPanel = lazy(() => import("./components/RentReclaimPanel").then((module) => ({ default: module.RentReclaimPanel })));
/** Terms, Privacy, Risk and Cookies: their own chunk, because most visits never open one. */
const LegalRoute = lazy(() => import("./components/legal/LegalPage").then((module) => ({ default: module.LegalRoute })));
/** Design review gallery; only exists in the Vite dev server and is dropped from production builds. */
const UiGallery = import.meta.env.DEV ? lazy(() => import("./dev/UiGallery").then((module) => ({ default: module.UiGallery }))) : null;

type CrewComponentKey = (typeof CREW_COMPONENTS)[number];

const ROUTES: Record<string, PageId> = {
  "/": "home",
  "/mine": "mine",
  "/explore": "explore",
  "/diggo": "diggo",
  "/trade": "trade",
  "/leaderboards": "leaderboards",
  "/mines": "mines",
  "/create": "create",
  "/crew": "crew",
  "/discoveries": "discoveries",
  "/cosmetics": "cosmetics",
  "/profile": "profile",
  "/portfolio": "profile",
  "/referrals": "referrals",
  "/admin": "admin",
  ...(import.meta.env.DEV ? { "/__ui": "ui" as const } : {}),
};

const PAGE_TITLES: Partial<Record<PageId, string>> = {
  mine: "Mine",
  crew: "Crew",
  discoveries: "Discoveries",
  explore: "Explore mines",
  diggo: "Trade $DIGGO",
  trade: "Trade",
  leaderboards: "Leaderboards",
  mines: "Mine details",
  cosmetics: "Cosmetics",
  create: "Create a coin",
  profile: "Your profile",
  referrals: "Referrals",
  admin: "Admin",
};

/**
 * The one place a failure becomes user copy. A verification prompt or a second
 * VERIFICATION_REQUIRED answer collapses to the single neutral sentence the spec allows; anything
 * else is the Worker's own message.
 */
function messageOf(error: unknown): string {
  if (error instanceof VerificationRequiredError) return NEUTRAL_VERIFICATION_TEXT;
  if (error instanceof ApiError && error.verificationRequired) return NEUTRAL_VERIFICATION_TEXT;
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

export default function App() {
  const [tokens, setTokens] = useState<TokenSummary[]>([]);
  const [selected, setSelected] = useState<TokenSummary | null>(null);
  const [now, setNow] = useState(Date.now());
  const [player, setPlayer] = useState<PlayerProfile | null>(null);
  const [miningReport, setMiningReport] = useState<MiningReport | null>(null);
  const [crewOpen, setCrewOpen] = useState(false);
  const [activating, setActivating] = useState(false);
  const [activateError, setActivateError] = useState("");
  const [launchOpen, setLaunchOpen] = useState(false);
  const [session, setSession] = useState<string | null>(null);
  const [solBalance, setSolBalance] = useState<number | null>(null);
  const [summary, setSummary] = useState<PortfolioSummary | null>(null);
  const [game, setGame] = useState<GameState | null>(null);
  const [meteoraPortfolio, setMeteoraPortfolio] = useState<MeteoraPortfolio | null>(null);
  const [loadingTokens, setLoadingTokens] = useState(true);
  const [bootstrapFailed, setBootstrapFailed] = useState(false);
  const [config, setConfig] = useState<DiggoConfig>({
    cluster: "mainnet-beta",
    chainMode: "meteora",
    meteoraConfigPubkey: "",
    // No official mint until the Worker publishes one: /diggo shows its "launches soon" state.
    officialMint: null,
    turnstileSiteKey: "",
    programId: "",
    vanitySuffix: "diggo",
  });
  const connected = useDiggoWallet();
  /**
   * The connected address as a primitive. Effects and callbacks depend on this rather than on the
   * connection object, so their identity only changes when the wallet itself does. src/wallet.ts
   * memoizes the object too, but depending on the address keeps that guarantee local here.
   */
  const walletAddress = connected?.address ?? null;
  const [mineInfo, setMineInfo] = useState<MineInfo | null>(null);
  const [mineInfoLoading, setMineInfoLoading] = useState(false);
  const [mineInfoError, setMineInfoError] = useState("");
  const [collecting, setCollecting] = useState(false);
  const [reportCollected, setReportCollected] = useState(false);
  const [reportError, setReportError] = useState("");
  const [crewPending, setCrewPending] = useState<string | null>(null);
  const [crewError, setCrewError] = useState("");
  const [crewNotice, setCrewNotice] = useState("");
  const [claims, setClaims] = useState<RewardClaimView[]>([]);
  const [claimsLoading, setClaimsLoading] = useState(false);
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [claimError, setClaimError] = useState("");
  const [claimAllPending, setClaimAllPending] = useState(false);
  const [claimAllError, setClaimAllError] = useState("");
  const [claimAllNotice, setClaimAllNotice] = useState("");
  const [discoveries, setDiscoveries] = useState<DiscoveryRecord[]>([]);
  const [opportunity, setOpportunity] = useState<DiscoveryOpportunity | null>(null);
  const [discoveriesLoading, setDiscoveriesLoading] = useState(false);
  const [rolling, setRolling] = useState(false);
  const [discoveryError, setDiscoveryError] = useState("");
  const [discoveryNotice, setDiscoveryNotice] = useState("");
  const verification = useVerificationGate(config.turnstileSiteKey || TURNSTILE_SITE_KEY);
  const pendingTransaction = usePendingTransaction();

  /**
   * Every gated call goes through here. The Worker answers 403 VERIFICATION_REQUIRED for an
   * account it wants to slow down; runGated clears that friction once and retries, and the UI only
   * ever shows the neutral sentence (spec 52, 62).
   */
  const gated = useCallback(
    async <T,>(action: string, resource: string | undefined, run: () => Promise<T>): Promise<T> => {
      if (!connected) throw new Error("Connect your wallet first");
      return runGated(
        {
          wallet: connected.address,
          action,
          resource,
          signMessage: (message) => connected.signMessage(message),
          requestTurnstileToken: verification.requestTurnstileToken,
        },
        run,
      );
    },
    [connected, verification.requestTurnstileToken],
  );

  const page: PageId = useMemo(() => ROUTES[window.location.pathname] ?? "home", []);
  const analyticsConfigured = Boolean(config.posthogApiKey && config.posthogHost);
  /**
   * The legal documents render in place of the home page at their own paths. They get no PageId on
   * purpose: that union is AppHeader.tsx's, and a legal notice belongs nowhere in the game nav.
   */
  const legal = useMemo(() => isLegalPath(window.location.pathname), []);

  useEffect(() => {
    const title = PAGE_TITLES[page];
    document.title = title ? title + " · Diggo.fun" : "Diggo.fun — Build and manage your memecoin mining crew";
  }, [page]);

  useEffect(() => {
    if (!analyticsConfigured) return;
    const referralCode = new URLSearchParams(window.location.search).get("ref");
    if (referralCode?.trim()) return trackOnce("referral_landed");
  }, [analyticsConfigured]);

  useEffect(() => {
    if (page !== "discoveries" || !analyticsConfigured) return;
    return trackOnce("discoveries_viewed", { network: config.cluster });
  }, [analyticsConfigured, config.cluster, page]);

  const fetchBootstrap = useCallback(async (): Promise<void> => {
    try {
      const result = await getBootstrap();
      setTokens(result.tokens);
      const requestedMint = new URLSearchParams(window.location.search).get("mint");
      setSelected(result.tokens.find((token) => token.mint === requestedMint) ?? result.tokens[0] ?? null);
      setConfig(result.config);
      setBootstrapFailed(false);
    } catch {
      setBootstrapFailed(true);
    } finally {
      setLoadingTokens(false);
    }
  }, []);

  function retryBootstrap(): void {
    setLoadingTokens(true);
    void fetchBootstrap();
  }

  useEffect(() => {
    void fetchBootstrap();
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [fetchBootstrap]);

  useEffect(() => {
    let current = true;
    void getWalletSession().then((storedSession) => {
      if (current && storedSession) setSession(storedSession.wallet);
    }).catch(() => {
      // An absent or expired HttpOnly cookie simply means the wallet must sign in again.
    });
    return () => { current = false; };
  }, []);

  useEffect(() => {
    if (config.chainMode === "meteora") {
      setPlayer(null);
      return;
    }
    if (!session || !walletAddress || session !== walletAddress) {
      setPlayer(null);
      return;
    }
    getPlayerProfile(walletAddress).then(setPlayer).catch(() => setPlayer(null));
  }, [config.chainMode, session, walletAddress]);

  useEffect(() => {
    if (config.chainMode === "meteora") {
      setSummary(null);
      return;
    }
    if (!session || !walletAddress || session !== walletAddress) {
      setSummary(null);
      return;
    }
    let current = true;
    void getPortfolio<PortfolioSummary>(walletAddress)
      .then((value) => { if (current) setSummary(value); })
      .catch(() => { if (current) setSummary(null); });
    return () => { current = false; };
  }, [config.chainMode, session, walletAddress]);

  useEffect(() => {
    const connectedAddress = connected?.address ?? null;
    if (!session || !connectedAddress || session !== connectedAddress) {
      setSolBalance(null);
      return;
    }
    let current = true;
    void import("./onchain")
      .then(({ fetchSolBalance }) => fetchSolBalance(address(connectedAddress)))
      .then((lamports) => {
        if (current) setSolBalance(Number(lamports) / 1_000_000_000);
      })
      .catch(() => {
        if (current) setSolBalance(null);
      });
    return () => { current = false; };
  }, [connected?.address, session]);

  const featured = selected ?? tokens[0] ?? null;
  const isMiningActive = player?.activationState === "ACTIVE";
  const signedIn = Boolean(session && walletAddress && session === walletAddress);

  useEffect(() => {
    if (page !== "referrals" || !signedIn || !analyticsConfigured) return;
    let current = true;
    let cancelTrackedOnce: (() => void) | undefined;
    void getReferrals()
      .then((panel) => {
        if (current && panel.totals.qualified > 0) cancelTrackedOnce = trackOnce("referral_qualified");
      })
      .catch(() => {
        // The referral dashboard owns its own error state; absence of this observation is not a
        // qualification event.
      });
    return () => {
      current = false;
      cancelTrackedOnce?.();
    };
  }, [analyticsConfigured, page, signedIn]);

  const refreshGame = useCallback(async (): Promise<void> => {
    if (!walletAddress || config.chainMode !== "meteora") return;
    try {
      const next = await getGameState(walletAddress);
      setGame(next);
      setMeteoraPortfolio(await getMeteoraPortfolio(walletAddress));
      setActivateError("");
    } catch (error) {
      setActivateError(messageOf(error));
    }
  }, [config.chainMode, walletAddress]);

  useEffect(() => {
    if (config.chainMode === "meteora") void refreshGame();
    else { setGame(null); setMeteoraPortfolio(null); }
  }, [config.chainMode, refreshGame]);

  // The Worker settles mining lazily when the player state is read. Polling keeps the dashboard's
  // accrued balance current while the browser is open, so activation does not require a reload or
  // a second mine-selection request.
  useEffect(() => {
    if (config.chainMode !== "meteora" || !signedIn) return;
    const timer = window.setInterval(() => void refreshGame(), 15_000);
    return () => window.clearInterval(timer);
  }, [config.chainMode, refreshGame, signedIn]);

  const loadMineInfo = useCallback(async (mint: string): Promise<void> => {
    setMineInfoLoading(true);
    try {
      setMineInfo(await getMineInfo(mint));
      setMineInfoError("");
    } catch {
      setMineInfoError("Mine information is unavailable right now.");
    } finally {
      setMineInfoLoading(false);
    }
  }, []);

  const refreshClaims = useCallback(async (): Promise<void> => {
    if (config.chainMode === "meteora") {
      setClaims([]);
      return;
    }
    if (!walletAddress || !signedIn) {
      setClaims([]);
      return;
    }
    setClaimsLoading(true);
    try {
      setClaims(await getPlayerRewards(walletAddress));
      setClaimError("");
    } catch {
      setClaimError("Could not load your reward ledger.");
    } finally {
      setClaimsLoading(false);
    }
  }, [config.chainMode, walletAddress, signedIn]);

  const refreshDiscoveries = useCallback(async (): Promise<void> => {
    if (config.chainMode === "meteora") {
      setDiscoveries([]);
      setOpportunity(null);
      return;
    }
    if (!walletAddress || !signedIn) {
      setDiscoveries([]);
      setOpportunity(null);
      return;
    }
    setDiscoveriesLoading(true);
    try {
      const result = await getDiscoveries(walletAddress);
      setDiscoveries(result.discoveries);
      setOpportunity(result.opportunity);
      setDiscoveryError("");
    } catch {
      setDiscoveryError("Could not load your discoveries.");
    } finally {
      setDiscoveriesLoading(false);
    }
  }, [config.chainMode, walletAddress, signedIn]);

  useEffect(() => {
    void refreshClaims();
  }, [refreshClaims]);

  useEffect(() => {
    void refreshDiscoveries();
  }, [refreshDiscoveries]);

  /**
   * The dashboard draws the player's mine, so it needs the equipped cosmetics too. Loading them
   * once here means the look is right on the first visit to the dashboard rather than only after
   * a trip to the cosmetics page; src/cosmetics.ts de-duplicates the request with that screen.
   */
  useEffect(() => {
    if (signedIn) void loadEquippedCosmetics();
    else clearEquippedCosmetics();
  }, [signedIn]);

  /**
   * A reward the player collected on chain has just been confirmed to the backend, so the ledger
   * it came from is stale: re-read it rather than guessing what the row now says. Without this the
   * panel keeps offering a claim whose tokens are already in the wallet, and the reconciliation
   * sweep sees a settled reward it cannot match to a signature.
   */
  const handleCollected = useCallback((): void => {
    void refreshClaims();
  }, [refreshClaims]);

  async function handleCollectReport(): Promise<void> {
    if (!signedIn) return;
    setCollecting(true);
    setReportError("");
    try {
      // v2: the mining report is a read of chain state, not a server-authored event. The
      // Worker indexes the coin's ledger and the player's position; the panel shows what those
      // accounts say. There is no report to "collect", so this only refreshes the view.
      const result = await gated("mining_report", walletAddress ?? undefined, () =>
        getMiningState(walletAddress ?? ""),
      );
      setPlayer(result.player);
      if (result.report) setMiningReport(result.report);
      if (result.mine) setMineInfo(result.mine);
      setReportCollected(true);
      track("mining_report_viewed", { network: config.cluster });
      await refreshClaims();
    } catch (error) {
      setReportError(messageOf(error));
    } finally {
      setCollecting(false);
    }
  }

  async function handleUpgradeCrew(component: CrewComponentKey): Promise<void> {
    if (config.chainMode === "meteora") {
      if (!signedIn) { setCrewError("Sign in to upgrade your crew."); return; }
      setCrewPending(component);
      setCrewError("");
      setCrewNotice("");
      try {
        await upgradeGameCrew(component);
        await refreshGame();
        setCrewNotice(CREW_COMPONENT_LABELS[component] + " upgraded.");
      } catch (error) { setCrewError(messageOf(error)); }
      finally { setCrewPending(null); }
      return;
    }
    if (!pendingTransaction.canSubmit()) return;
    if (!connected || !config.programId) {
      setCrewError("Connect a wallet that can sign transactions to upgrade your crew.");
      return;
    }
    setCrewPending(component);
    setCrewError("");
    setCrewNotice("");
    try {
      // The price and the effect both come from the program's own curve table, so this is one
      // wallet-signed transaction and the Worker only re-reads the result afterwards.
      const { address, upgradeCrew } = await import("./solanaProgram");
      const signature = await upgradeCrew({
        programAddress: address(config.programId),
        wallet: connected.wallet,
        component: CREW_COMPONENTS.indexOf(component),
      });
      await ensureSession();
      const profile = await getPlayerProfile(connected.address);
      setPlayer(profile);
      const mint = profile.activeMint ?? featured?.mint;
      if (mint) void loadMineInfo(mint);
      setCrewNotice(
        CREW_COMPONENT_LABELS[component] +
          " upgraded on-chain. Signature " +
          signature.slice(0, 8) +
          "…",
      );
      track("crew_upgraded", { component });
    } catch (error) {
      if (!pendingTransaction.record(error, "Crew upgrade")) setCrewError(messageOf(error));
      else setCrewError("");
    } finally {
      setCrewPending(null);
    }
  }

  async function handleClaimReward(claim: RewardClaimView): Promise<void> {
    if (!pendingTransaction.canSubmit()) return;
    if (!connected || !config.programId) {
      setClaimError("Connect the wallet that owns this reward to collect it.");
      return;
    }
    setClaimingId(claim.id);
    setClaimError("");
    try {
      // v2: the tokens leave the coin's vault only through `claim_rewards`, signed by the
      // player's own wallet. The Worker has no key on this path, so the claim is the transaction
      // and the API call afterwards only records the signature it verified on chain.
      const { address, claimRewards } = await import("./solanaProgram");
      const result = await claimRewards({
        programAddress: address(config.programId),
        wallet: connected.wallet,
        mint: address(claim.mint),
      });
      if (!result.confirmed) {
        pendingTransaction.recordSubmission(result.signature, "Reward claim");
        return;
      }
      await ensureSession();
      await confirmRewardClaimPayout(claim.id, result.signature);
      track("reward_claimed", { network: config.cluster });
      await refreshClaims();
    } catch (error) {
      if (!pendingTransaction.record(error, "Reward claim")) setClaimError(messageOf(error));
      else setClaimError("");
    } finally {
      setClaimingId(null);
    }
  }

  async function handleClaimAll(): Promise<void> {
    if (config.chainMode !== "meteora" || !connected) {
      setClaimAllError("Connect the wallet that owns these mined rewards.");
      return;
    }
    setClaimAllPending(true);
    setClaimAllError("");
    setClaimAllNotice("");
    try {
      const prepared = await prepareGameClaimAll();
      if (prepared.signatureCount !== 1) {
        throw new Error("The backend did not prepare the required one-signature collection. No rewards were claimed.");
      }
      const submission = await signPreparedClaim({
        wallet: connected.wallet,
        payout: prepared.batch,
        nowSeconds: Math.floor(Date.now() / 1_000),
      });
      track("claim_all_submitted", { network: config.cluster });

      // Confirmation is idempotent. Poll this exact batch/signature pair after submission instead
      // of ever sending the transaction again or asking the player for another signature.
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const result = await confirmGameClaimAll(prepared.batch.id, submission.signature);
        if (result.batch.status === "SETTLED") {
          await refreshGame();
          setClaimAllNotice(settledClaimAllNotice(prepared));
          track("claim_all_settled", { network: config.cluster });
          return;
        }
        if (attempt < 5) await new Promise((resolve) => window.setTimeout(resolve, 2_000));
      }
      await refreshGame();
      setClaimAllNotice("Collection is submitted and still confirming. Do not sign or submit it again.");
    } catch (error) {
      setClaimAllError(messageOf(error));
    } finally {
      setClaimAllPending(false);
    }
  }

  async function handleRequestOpportunity(): Promise<void> {
    if (!connected || !config.programId) {
      setDiscoveryError("Connect a wallet to roll for discoveries.");
      return;
    }
    setRolling(true);
    setDiscoveryError("");
    setDiscoveryNotice("");
    try {
      // Eligibility is a fact about the on-chain PlayerAccount, so this reads it rather than
      // asking the Worker whether the player may roll. The answer is the program's own, and it
      // turns on the player's own history rather than on anything they have to post: there is no
      // bond and no paid tier, so a wallet holding only rent and network-fee SOL is as eligible
      // as any other.
      const { address, fetchCoin, fetchPlayer } = await import("./solanaProgram");
      const programAddress = address(config.programId);
      const mint = player?.activeMint ?? featured?.mint;
      if (!mint) {
        setDiscoveryNotice("Join a mine first — a roll is locked against one coin.");
        return;
      }
      const [onChain, coin] = await Promise.all([
        fetchPlayer(programAddress, address(connected.address)),
        fetchCoin(programAddress, address(mint)),
      ]);
      if (!onChain) {
        setDiscoveryNotice("Create your player account first: one transaction and 0.0024 SOL of rent.");
        return;
      }
      if (coin?.discoveryPaused) {
        setDiscoveryNotice("This coin's discovery payouts are paused right now.");
        return;
      }
      setDiscoveryNotice("You are eligible. Roll to lock this window's opportunity on chain.");
    } catch (error) {
      setDiscoveryError(messageOf(error));
    } finally {
      setRolling(false);
    }
  }

  async function handleRollDiscovery(): Promise<void> {
    if (config.chainMode === "meteora") {
      if (!signedIn) { setDiscoveryError("Sign in to run a discovery."); return; }
      setRolling(true); setDiscoveryError(""); setDiscoveryNotice("");
      try {
        const result = await runGameDiscovery();
        const discoveredName = result.claim?.name ?? result.claim?.symbol;
        setDiscoveryNotice(
          result.discovered
            ? discoveredName
              ? `Your crew found ${discoveredName}. Its reward is accrued in Discoveries.`
              : "Your crew found a new memecoin. Its reward is accrued in Discoveries."
            : result.reason ?? "No discovery this time.",
        );
        await refreshGame();
      } catch (error) { setDiscoveryError(messageOf(error)); }
      finally { setRolling(false); }
      return;
    }
    if (!pendingTransaction.canSubmit()) return;
    if (!connected || !config.programId) {
      setDiscoveryError("Connect a wallet to roll for discoveries.");
      return;
    }
    const mint = player?.activeMint ?? featured?.mint;
    if (!mint) {
      setDiscoveryError("Join a mine before rolling for discoveries.");
      return;
    }
    setRolling(true);
    setDiscoveryError("");
    setDiscoveryNotice("");
    try {
      // Two instructions, and neither of them carries an outcome. The roll charges this
      // window's budget and writes the opportunity PDA while the epoch's seed is still unknown;
      // settlement recomputes sha256(seed || owner || window) in the program and pays. Anyone
      // can settle, which is why the second step failing is not a loss.
      const { address, createDiscoveryRoll, settleDiscovery } = await import("./solanaProgram");
      const programAddress = address(config.programId);
      await createDiscoveryRoll({ programAddress, wallet: connected.wallet, mint: address(mint) });
      setDiscoveryNotice("Opportunity locked on chain. Settling against the epoch seed…");
      try {
        await settleDiscovery({ programAddress, wallet: connected.wallet, mint: address(mint) });
        setDiscoveryNotice("Settled. The program derived your outcome from the recorded epoch seed.");
      } catch (error) {
        if (pendingTransaction.record(error, "Discovery settlement")) {
          setDiscoveryError("");
          return;
        }
        setDiscoveryNotice(
          "Locked. This epoch's seed is not revealed yet, so settlement waits — the roll is already yours and anyone can settle it once the seed lands.",
        );
      }
      await refreshDiscoveries();
      await refreshClaims();
    } catch (error) {
      if (!pendingTransaction.record(error, "Discovery roll")) setDiscoveryError(messageOf(error));
      else setDiscoveryError("");
    } finally {
      setRolling(false);
    }
  }

  async function ensureSession(): Promise<void> {
    if (!connected || session === connected.address) return;
    const challenge = await getChallenge(connected.address);
    const signature = await connected.signMessage(new TextEncoder().encode(challenge.message));
    const referralCode = new URLSearchParams(window.location.search).get("ref");
    const verified = await verifyWallet(connected.address, challenge.nonce, bs58.encode(signature), referralCode);
    setSession(verified.wallet);
    track("wallet_signed_in", { network: config.cluster });
  }

  async function handleActivate() {
    if (config.chainMode === "meteora") {
      if (!connected) { setActivateError("Connect a wallet to activate your shift."); return; }
      setActivating(true); setActivateError("");
      try {
        if (!signedIn) await ensureSession();
        const challenge = await requestGameActivationChallenge(connected.address);
        const signature = await connected.signMessage(new TextEncoder().encode(challenge.message));
        const streak = await startMeteoraMining({
          activate: () => activateGame(challenge.nonce, bs58.encode(signature)),
          refresh: refreshGame,
        });
        track("mine_activated", { streak, network: config.cluster });
      } catch (error) { setActivateError(messageOf(error)); }
      finally { setActivating(false); }
      return;
    }
    if (!pendingTransaction.canSubmit()) return;
    if (!connected || !config.programId) {
      setActivateError("Connect a wallet that can sign transactions to activate.");
      return;
    }
    setActivating(true);
    setActivateError("");
    try {
      // v2: `activate` is a wallet-signed instruction. It settles accrual, rolls the window and
      // applies the streak rule on chain, and it is free — no ORE, no tokens, only the network
      // fee every Solana transaction costs. The Worker only re-reads the result.
      const { address, activatePlayer } = await import("./solanaProgram");
      const programAddress = address(config.programId);
      await activatePlayer({ programAddress, wallet: connected.wallet });
      await ensureSession();
      const profile = await getPlayerProfile(connected.address);
      setPlayer(profile);
      const mint = profile.activeMint ?? featured?.mint;
      if (mint) await loadMineInfo(mint);
      setReportCollected(false);
      setReportError("");
      const state = await getMiningState(connected.address);
      if (state.report) setMiningReport(state.report);
      await refreshClaims();
        track("mine_activated", { streak: profile.streak, network: config.cluster });
    } catch (error) {
      if (!pendingTransaction.record(error, "Player activation")) setActivateError(messageOf(error));
      else setActivateError("");
    } finally {
      setActivating(false);
    }
  }

  async function handleClaimRewards() {
    if (config.chainMode === "meteora") return;
    if (!connected || !config.programId || !featured) return;
    if (!pendingTransaction.canSubmit()) return;
    setActivateError("");
    try {
      const { address, claimRewards } = await import("./solanaProgram");
      const submission = await claimRewards({
        programAddress: address(config.programId),
        wallet: connected.wallet,
        mint: address(featured.mint),
      });
      if (!submission.confirmed) {
        pendingTransaction.recordSubmission(submission.signature, "Reward claim");
        return;
      }
      track("rewards_claimed", { network: config.cluster });
      await refreshFeaturedToken();
    } catch (error) {
      if (!pendingTransaction.record(error, "Reward claim")) {
        setActivateError(error instanceof Error ? error.message : "Nothing to claim yet");
      } else setActivateError("");
    }
  }

  async function refreshFeaturedToken() {
    if (!featured) return;
    try {
      const updated = await getToken(featured.mint);
      setTokens((current) => current.map((t) => (t.mint === updated.mint ? updated : t)));
      setSelected(updated);
    } catch {
      // best-effort — the cron sync will catch up within a few minutes regardless
    }
  }

  useEffect(() => {
    // The dashboard's countdowns belong to the mine the crew is actually working; the market pages
    // describe the mine the player selected.
    const marketPage = page === "mines" || page === "trade" || page === "home";
    const mint = marketPage ? featured?.mint : (config.chainMode === "meteora" ? game?.activeMine?.coin.mint : player?.activeMint) ?? featured?.mint;
    if (mint) void loadMineInfo(mint);
  }, [page, config.chainMode, game?.activeMine?.coin.mint, player?.activeMint, featured?.mint, loadMineInfo, session]);

  const activeMineToken = config.chainMode === "meteora"
    ? (game?.activeMine?.coin.mint
      ? (tokens.find((token) => token.mint === game.activeMine?.coin.mint) ?? null)
      : null)
    : (player?.activeMint
      ? (tokens.find((token) => token.mint === player.activeMint) ?? featured ?? null)
      : (featured ?? null));

  /**
   * Navigation into a mine page or the trade panel for one mint. Both are plain URL loads, which
   * is what the router (pathname + ?mint= selection at bootstrap) already understands.
   */
  function openTokenPage(mint: string): void {
    window.location.assign("/mines?mint=" + encodeURIComponent(mint));
  }

  function openTradePage(mint: string): void {
    window.location.assign("/trade?mint=" + encodeURIComponent(mint));
  }

  if (loadingTokens) return <LoadingScreen />;

  const openLaunch = () => setLaunchOpen(true);
  const economy = (
    <EconomyPanels
      player={player}
      tokens={tokens}
      claims={claims}
      loading={claimsLoading}
      signedIn={signedIn}
      claimingId={claimingId}
      claimError={claimError}
      onClaim={(claim) => void handleClaimReward(claim)}
      onOpenToken={openTokenPage}
      onCollected={handleCollected}
    />
  );
  const mineInfoPanel = (token: TokenSummary | null) =>
    token && (
      <MineInfoPanel
        mine={mineInfo}
        mineName={token.name}
        now={now}
        loading={mineInfoLoading}
        error={mineInfoError}
      />
    );

  return (
    <div className={"app page-" + page}>
      <a className="skip-link" href="#content">Skip to content</a>
      <AppHeader
        page={page}
        session={session}
        signedIn={signedIn}
        summary={summary}
        game={config.chainMode === "meteora" ? game : null}
        solBalance={solBalance}
        onLaunch={openLaunch}
        onAuthenticated={setSession}
      />

      <main id="content" tabIndex={-1}>
        {bootstrapFailed && (
          <div className="page-shell page-alert">
            <ErrorState title="The mines are unreachable right now." onRetry={retryBootstrap}>
              Diggo could not load live mine data. Your wallet and rewards are unaffected.
            </ErrorState>
          </div>
        )}

        <RouteErrorBoundary>
        <Suspense fallback={<RouteFallback />}>
          {legal && <LegalRoute pathname={window.location.pathname} />}

          {!legal && page === "home" && (
            <>
              <HomeHero
                featured={featured}
                player={config.chainMode === "meteora" && game ? {
                  wallet: game.wallet, createdAt: game.createdAt, crewLevels: game.crew, power: crewPower(game.crew),
                  oreBalance: game.oreBalance, oreCapacity: 0, streak: game.streak, streakFreezes: game.streakFreezes,
                  activationState: game.activation.active ? "ACTIVE" : "PAUSED", lastActivationAt: game.lastActivationAt,
                  activationExpiresAt: game.activation.activeUntil || null, activeMint: game.activeMine?.coin.mint ?? null,
                  accountAgeSeconds: 0, maturityBps: 0, discoveryEligible: game.discovery.eligible, riskState: "NORMAL",
                } : player}
                connected={Boolean(connected)}
                now={now}
                activating={activating}
                error={activateError}
                onActivate={() => void handleActivate()}
                onManageCrew={() => setCrewOpen(true)}
                onLaunch={openLaunch}
                onClaimRewards={config.chainMode === "meteora" ? undefined : () => void handleClaimRewards()}
              />
              <Ticker tokens={tokens} />
              <ExploreBoard tokens={tokens} limit={3} onLaunch={openLaunch} />
              <WatchlistPanel
                tokens={tokens}
                onSelectCoin={openTokenPage}
                onConnect={() => window.dispatchEvent(new Event("diggo:open-wallet"))}
              />
              {economy}
              <HowItWorks />
              <FinalCta onLaunch={openLaunch} />
            </>
          )}

          {page === "mine" && config.chainMode === "meteora" && (
            <MeteoraMineDashboard game={game} mine={activeMineToken} now={now} connected={Boolean(connected)} activating={activating} error={activateError} onActivate={() => void handleActivate()} />
          )}

          {page === "mine" && config.chainMode !== "meteora" && (
            <>
              <DashboardPanel
                player={player}
                mine={activeMineToken}
                mineInfo={mineInfo}
                now={now}
                connected={Boolean(connected)}
                activating={activating}
                collecting={collecting}
                error={activateError}
                onActivate={() => void handleActivate()}
                onManageCrew={() => setCrewOpen(true)}
                onCollect={() => void handleCollectReport()}
              />
              {config.programId && (
                <Suspense fallback={<RouteFallback />}>
                  <PlayerOnboarding
                    programAddress={config.programId}
                    wallet={connected?.wallet ?? null}
                    onChanged={() => {
                      // The on-chain write is the truth; this only re-reads the indexer's copy so
                      // the dashboard's numbers catch up with the account the player just wrote.
                      if (walletAddress) {
                        void getPlayerProfile(walletAddress)
                          .then(setPlayer)
                          .catch(() => {});
                      }
                    }}
                  />
                </Suspense>
              )}
              {mineInfoPanel(activeMineToken)}
            </>
          )}

          {page === "crew" && config.chainMode === "meteora" && (
            <MeteoraCrewScreen game={game} pending={crewPending} error={crewError} notice={crewNotice} onUpgrade={(component) => void handleUpgradeCrew(component)} />
          )}

          {page === "crew" && config.chainMode !== "meteora" && (
            <>
              {player ? (
                <CrewScreen
                  player={player}
                  pending={crewPending}
                  error={crewError}
                  notice={crewNotice}
                  onUpgrade={(component) => void handleUpgradeCrew(component)}
                />
              ) : (
                <section className="crew-screen page-shell">
                  <EmptyState
                    icon={<IconHammer size={26} />}
                    title={connected ? "Loading your crew…" : "Your crew is waiting for a boss."}
                  >
                    {connected
                      ? "Fetching crew levels, ORE and Mining Power."
                      : "Connect and sign in with your wallet to hire Miners, add Drills and grow your operation."}
                  </EmptyState>
                </section>
              )}
            </>
          )}

          {page === "discoveries" && config.chainMode === "meteora" && (
            <MeteoraDiscoveriesScreen
              game={game}
              tokens={tokens}
              connected={signedIn}
              busy={rolling}
              error={discoveryError}
              notice={discoveryNotice}
              onDiscover={() => void handleRollDiscovery()}
              claimAllPending={claimAllPending}
              claimAllError={claimAllError}
              claimAllNotice={claimAllNotice}
              onClaimAll={() => void handleClaimAll()}
            />
          )}

          {page === "discoveries" && config.chainMode !== "meteora" && (
            <DiscoveriesPanel
              signedIn={signedIn}
              discoveries={discoveries}
              opportunity={opportunity}
              tokens={tokens}
              loading={discoveriesLoading}
              rolling={rolling}
              error={discoveryError}
              notice={discoveryNotice}
              onRequestOpportunity={() => void handleRequestOpportunity()}
              onRoll={() => void handleRollDiscovery()}
              onOpenToken={openTokenPage}
              onTrade={openTradePage}
            />
          )}

          {page === "explore" && (
            <>
              <Ticker tokens={tokens} />
              <ExploreBoard tokens={tokens} onLaunch={openLaunch} />
            </>
          )}

          {page === "leaderboards" && <LeaderboardsScreen tokens={tokens} onSelectMine={openTokenPage} />}

          {page === "diggo" && (
            <DiggoTradePage
              officialMint={config.officialMint}
              programAddress={config.programId}
              cluster={config.cluster}
              chainMode={config.chainMode}
              meteoraConfigPubkey={config.meteoraConfigPubkey}
              signer={connected?.wallet ?? null}
              onTraded={() => void fetchBootstrap()}
            />
          )}

          {page === "mines" && (featured ? (
            <>
              <SelectedMine
                token={featured}
                mineInfo={mineInfo}
                now={now}
              />
              {mineInfoPanel(featured)}
              {(config.chainMode === "meteora" || config.programId) && (
                <SwapPanel token={featured} programAddress={config.programId} cluster={config.cluster} chainMode={config.chainMode} meteoraConfigPubkey={config.meteoraConfigPubkey} signer={connected?.wallet ?? null} onTraded={() => void refreshFeaturedToken()} />
              )}
            </>
          ) : (
            <section className="page-shell"><EmptyState title="No mine selected">Pick a mine from the board to see its reserve, power and market.</EmptyState></section>
          ))}

          {page === "trade" && (featured && (config.chainMode === "meteora" || config.programId) ? (
            <SwapPanel token={featured} programAddress={config.programId} cluster={config.cluster} chainMode={config.chainMode} meteoraConfigPubkey={config.meteoraConfigPubkey} signer={connected?.wallet ?? null} onTraded={() => void refreshFeaturedToken()} />
          ) : (
            <section className="page-shell">
              <EmptyState title="Nothing to trade yet">Trading opens once a mine is live.</EmptyState>
            </section>
          ))}

          {page === "create" && (
            <section className="create-coin-page page-shell">
              <div>
                <h1>START A<br /><span>NEW MINE.</span></h1>
                <p>Create a fixed-supply Solana coin, allocate its mining reserve, and optionally make the first real buy into its bonding curve.</p>
              </div>
              <div className="create-coin-card">
                <span>MAINNET LAUNCH</span>
                <h2>{config.chainMode === "meteora" ? "Launch the next mine." : "Everything settles on-chain."}</h2>
                <p>{config.chainMode === "meteora" ? "Create a coin, then send your crew to work in its market." : "Your creator wallet signs the launch and, if selected, the initial liquidity buy in one transaction."}</p>
                <button className="btn btn-primary" onClick={openLaunch}>Open launch builder <IconArrowUpRight size={17} /></button>
              </div>
            </section>
          )}

          {page === "cosmetics" && <CosmeticsScreen signedIn={signedIn} />}
          {page === "profile" && connected && config.chainMode === "meteora" && (
            <>
              <MeteoraPortfolioScreen game={game} portfolio={meteoraPortfolio} tokens={tokens} />
              <section className="page-shell" aria-label="Rent reclaim status">
                <p className="form-message">
                  Rent reclaim is unavailable in Meteora mode. The native-program account authority
                  does not support this action, so no reclaim transaction can be started here.
                </p>
              </section>
            </>
          )}
          {page === "profile" && connected && config.chainMode !== "meteora" && (
            <>
              <PortfolioScreen wallet={connected.address} programAddress={config.programId} signer={connected.wallet} />
              {config.programId && (
                <Suspense fallback={<RouteFallback />}>
                  <RentReclaimPanel programAddress={config.programId} signer={connected.wallet} />
                </Suspense>
              )}
            </>
          )}
          {page === "profile" && !connected && (
            <section className="page-shell">
              <EmptyState icon={<IconBadge size={26} />} title="Your profile is waiting">
                Connect a wallet to see your portfolio.
              </EmptyState>
            </section>
          )}
          {page === "referrals" && <ReferralsScreen signedIn={signedIn} />}
          {page === "admin" && <AdminScreen signedIn={signedIn} chainMode={config.chainMode} programId={config.programId || undefined} />}
          {page === "ui" && UiGallery && <UiGallery />}
        </Suspense>
        </RouteErrorBoundary>

        <PushToggle />
      </main>

      <SiteFooter />

      <Suspense fallback={null}>
        {launchOpen && (
          <LaunchModal
            onClose={() => setLaunchOpen(false)}
            session={session}
            onAuthenticated={setSession}
            config={config}
            onLaunched={(token) => {
              setTokens((current) => [token, ...current.filter((existing) => existing.mint !== token.mint)]);
              setSelected(token);
              track("launch_succeeded", { chain_mode: config.chainMode, network: config.cluster });
            }}
          />
        )}
        {miningReport && (
          <MiningReportModal
            report={miningReport}
            mineSymbol={activeMineToken?.symbol ?? null}
            collecting={collecting}
            collected={reportCollected}
            error={reportError}
            onCollect={() => void handleCollectReport()}
            onClose={() => setMiningReport(null)}
            onManageCrew={() => { setMiningReport(null); setCrewOpen(true); }}
          />
        )}
        {crewOpen && player && (
          <CrewScreen
            variant="modal"
            player={player}
            pending={crewPending}
            error={crewError}
            notice={crewNotice}
            onUpgrade={(component) => void handleUpgradeCrew(component)}
            onClose={() => setCrewOpen(false)}
          />
        )}
      </Suspense>
      {verification.verificationModal}
      <ConsentBanner />
    </div>
  );
}
