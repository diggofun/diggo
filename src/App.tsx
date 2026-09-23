import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import bs58 from "bs58";
import "./walletConnect";
import { ArrowUpRight, Hammer } from "lucide-react";

import type { DiscoveryOpportunity, DiscoveryRecord, MineInfo, MiningReport, PlayerProfile, TokenSummary } from "../shared/types";
import {
  activateMine as activateMineRequest,
  claimDiscovery as claimDiscoveryRequest,
  claimReward as claimRewardRequest,
  collectMiningReport,
  getDiscoveries,
  getActivationChallenge,
  getBootstrap,
  getChallenge,
  getDiscoveryClaimChallenge,
  getMineInfo,
  getPlayerProfile,
  getPlayerRewards,
  getRewardClaimChallenge,
  rollDiscovery as rollDiscoveryRequest,
  requestDiscoveryOpportunity,
  getWalletSession,
  getToken,
  switchMine as switchMineRequest,
  upgradeCrew,
  verifyWallet,
  ApiError,
  type RewardClaimView,
  type DiggoConfig,
} from "./api";
import { track } from "./analytics";
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
import { isLegalPath } from "./components/legal/routes";

/*
 * Every screen below the landing page is its own chunk: the swap terminal (lightweight-charts and
 * the Solana program client), the launch builder, the game screens and the admin tools only
 * download on the route that renders them.
 */
const AdminScreen = lazy(() => import("./components/AdminScreen").then((module) => ({ default: module.AdminScreen })));
const CosmeticsScreen = lazy(() => import("./components/CosmeticsScreen").then((module) => ({ default: module.CosmeticsScreen })));
const CrewScreen = lazy(() => import("./components/CrewScreen").then((module) => ({ default: module.CrewScreen })));
const DashboardPanel = lazy(() => import("./components/DashboardPanel").then((module) => ({ default: module.DashboardPanel })));
const DiscoveriesPanel = lazy(() => import("./components/DiscoveriesPanel").then((module) => ({ default: module.DiscoveriesPanel })));
const EconomyPanels = lazy(() => import("./components/EconomyPanels").then((module) => ({ default: module.EconomyPanels })));
const LaunchModal = lazy(() => import("./components/LaunchModal").then((module) => ({ default: module.LaunchModal })));
const LeaderboardsScreen = lazy(() => import("./components/LeaderboardsScreen").then((module) => ({ default: module.LeaderboardsScreen })));
const MineInfoPanel = lazy(() => import("./components/MineInfoPanel").then((module) => ({ default: module.MineInfoPanel })));
const MiningReportModal = lazy(() => import("./components/MiningReportModal").then((module) => ({ default: module.MiningReportModal })));
const SwapPanel = lazy(() => import("./components/SwapPanel").then((module) => ({ default: module.SwapPanel })));
const SwitchMineModal = lazy(() => import("./components/SwitchMineModal").then((module) => ({ default: module.SwitchMineModal })));
/** Terms, Privacy, Risk and Cookies: their own chunk, because most visits never open one. */
const LegalRoute = lazy(() => import("./components/legal/LegalPage").then((module) => ({ default: module.LegalRoute })));
/** Design review gallery; only exists in the Vite dev server and is dropped from production builds. */
const UiGallery = import.meta.env.DEV ? lazy(() => import("./dev/UiGallery").then((module) => ({ default: module.UiGallery }))) : null;

type CrewComponentKey = (typeof CREW_COMPONENTS)[number];

const ROUTES: Record<string, PageId> = {
  "/": "home",
  "/mine": "mine",
  "/explore": "explore",
  "/trade": "trade",
  "/leaderboards": "leaderboards",
  "/mines": "mines",
  "/create": "create",
  "/crew": "crew",
  "/discoveries": "discoveries",
  "/cosmetics": "cosmetics",
  "/admin": "admin",
  ...(import.meta.env.DEV ? { "/__ui": "ui" as const } : {}),
};

const PAGE_TITLES: Partial<Record<PageId, string>> = {
  mine: "Mine",
  crew: "Crew",
  discoveries: "Discoveries",
  explore: "Explore mines",
  trade: "Trade",
  leaderboards: "Leaderboards",
  mines: "Mine details",
  cosmetics: "Cosmetics",
  create: "Create a coin",
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
  const [switchOpen, setSwitchOpen] = useState(false);
  const [activating, setActivating] = useState(false);
  const [activateError, setActivateError] = useState("");
  const [launchOpen, setLaunchOpen] = useState(false);
  const [session, setSession] = useState<string | null>(null);
  const [loadingTokens, setLoadingTokens] = useState(true);
  const [bootstrapFailed, setBootstrapFailed] = useState(false);
  const [config, setConfig] = useState<DiggoConfig>({
    cluster: "devnet",
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
  const [switching, setSwitching] = useState(false);
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
  const [discoveries, setDiscoveries] = useState<DiscoveryRecord[]>([]);
  const [opportunity, setOpportunity] = useState<DiscoveryOpportunity | null>(null);
  const [discoveriesLoading, setDiscoveriesLoading] = useState(false);
  const [rolling, setRolling] = useState(false);
  const [claimingDiscoveryId, setClaimingDiscoveryId] = useState<string | null>(null);
  const [discoveryError, setDiscoveryError] = useState("");
  const [discoveryNotice, setDiscoveryNotice] = useState("");
  const verification = useVerificationGate(config.turnstileSiteKey || TURNSTILE_SITE_KEY);

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
  /**
   * The legal documents render in place of the home page at their own paths. They get no PageId on
   * purpose: that union is AppHeader.tsx's, and a legal notice belongs nowhere in the game nav.
   */
  const legal = useMemo(() => isLegalPath(window.location.pathname), []);

  useEffect(() => {
    const title = PAGE_TITLES[page];
    document.title = title ? title + " · Diggo.fun" : "Diggo.fun — Build and manage your memecoin mining crew";
  }, [page]);

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
    if (!session || !walletAddress || session !== walletAddress) {
      setPlayer(null);
      return;
    }
    getPlayerProfile(walletAddress).then(setPlayer).catch(() => setPlayer(null));
  }, [session, walletAddress]);

  const featured = selected ?? tokens[0] ?? null;
  const isMiningActive = player?.activationState === "ACTIVE";
  const signedIn = Boolean(session && walletAddress && session === walletAddress);

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
  }, [walletAddress, signedIn]);

  const refreshDiscoveries = useCallback(async (): Promise<void> => {
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
  }, [walletAddress, signedIn]);

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
      const result = await collectMiningReport();
      setPlayer(result.player);
      setMiningReport(result.report);
      setReportCollected(true);
      track("mining_report_collected", { idempotent: result.idempotent, network: "solana-devnet" });
      await refreshClaims();
    } catch (error) {
      setReportError(messageOf(error));
    } finally {
      setCollecting(false);
    }
  }

  async function handleUpgradeCrew(component: CrewComponentKey): Promise<void> {
    if (!connected) return;
    setCrewPending(component);
    setCrewError("");
    setCrewNotice("");
    try {
      await ensureSession();
      const result = await gated("crew_upgrade", component, () => upgradeCrew(component));
      setPlayer(result.player);
      const mint = result.player.activeMint ?? featured?.mint;
      if (mint) void loadMineInfo(mint);
      setCrewNotice(
        CREW_COMPONENT_LABELS[component] +
          " upgraded for " +
          result.spent.toLocaleString() +
          " ORE. Mining Power is now " +
          result.power.toLocaleString() +
          ".",
      );
      track("crew_upgraded", { component });
    } catch (error) {
      setCrewError(messageOf(error));
    } finally {
      setCrewPending(null);
    }
  }

  async function handleClaimReward(claim: RewardClaimView): Promise<void> {
    if (!connected) return;
    setClaimingId(claim.id);
    setClaimError("");
    try {
      await ensureSession();
      const challenge = await getRewardClaimChallenge(claim.id);
      const signature = bs58.encode(await connected.signMessage(new TextEncoder().encode(challenge.message)));
      await gated("claim_reward", claim.id, () => claimRewardRequest(claim.id, challenge.nonce, signature));
      track("reward_claimed", { mint: claim.mint, network: "solana-devnet" });
      await refreshClaims();
    } catch (error) {
      setClaimError(messageOf(error));
    } finally {
      setClaimingId(null);
    }
  }

  async function handleRequestOpportunity(): Promise<void> {
    if (!connected) return;
    setRolling(true);
    setDiscoveryError("");
    setDiscoveryNotice("");
    try {
      const result = await gated("discovery_roll", undefined, () => requestDiscoveryOpportunity());
      setOpportunity(result.opportunity);
      setDiscoveryNotice(
        result.opportunity
          ? "Your crew has an opportunity for this window."
          : (result.publicMessage ?? "No discovery opportunity is available for this account yet."),
      );
    } catch (error) {
      setDiscoveryError(messageOf(error));
    } finally {
      setRolling(false);
    }
  }

  async function handleRollDiscovery(): Promise<void> {
    if (!connected) return;
    setRolling(true);
    setDiscoveryError("");
    setDiscoveryNotice("");
    try {
      const result = await gated("discovery_roll", undefined, () =>
        rollDiscoveryRequest(player?.activeMint ?? undefined),
      );
      setDiscoveryNotice(
        result.discovery
          ? "Your crew turned up " +
              result.discovery.visualEvent +
              " (" +
              result.discovery.rarity +
              "). Claim it before it expires."
          : "Nothing this window. This opportunity is spent until the next one opens.",
      );
      await refreshDiscoveries();
      await refreshClaims();
    } catch (error) {
      setDiscoveryError(messageOf(error));
    } finally {
      setRolling(false);
    }
  }

  async function handleClaimDiscovery(discovery: DiscoveryRecord): Promise<void> {
    if (!connected) return;
    setClaimingDiscoveryId(discovery.id);
    setDiscoveryError("");
    setDiscoveryNotice("");
    try {
      await ensureSession();
      const challenge = await getDiscoveryClaimChallenge(discovery.id);
      const signature = bs58.encode(await connected.signMessage(new TextEncoder().encode(challenge.message)));
      const result = await gated("claim_discovery", discovery.id, () =>
        claimDiscoveryRequest(discovery.id, challenge.nonce, signature),
      );
      setDiscoveryNotice(
        result.status === "CLAIMED"
          ? "This discovery was already paid out."
          : "Claim accepted. The payout is queued and settles from the mine's reserve.",
      );
      await refreshDiscoveries();
      await refreshClaims();
    } catch (error) {
      setDiscoveryError(messageOf(error));
    } finally {
      setClaimingDiscoveryId(null);
    }
  }

  async function ensureSession(): Promise<void> {
    if (!connected || session === connected.address) return;
    const challenge = await getChallenge(connected.address);
    const signature = await connected.signMessage(new TextEncoder().encode(challenge.message));
    const verified = await verifyWallet(connected.address, challenge.nonce, bs58.encode(signature));
    setSession(verified.wallet);
    track("wallet_signed_in", { network: "solana-devnet" });
  }

  async function handleActivate() {
    if (!connected) return;
    setActivating(true);
    setActivateError("");
    try {
      await ensureSession();
      const challenge = await getActivationChallenge(connected.address);
      const signature = bs58.encode(await connected.signMessage(new TextEncoder().encode(challenge.message)));
      const mint = featured?.mint;
      const result = await gated("activate", mint, () =>
        activateMineRequest(connected.address, challenge.nonce, signature, mint),
      );
      setPlayer(result.player);
      if (result.mine) setMineInfo(result.mine);
      setReportCollected(false);
      setReportError("");
      setMiningReport(result.report);
      await refreshClaims();
      track("mine_activated", { streak: result.report.streak, network: "solana-devnet" });
    } catch (error) {
      setActivateError(messageOf(error));
    } finally {
      setActivating(false);
    }
  }

  async function handleSwitchMine(mint: string) {
    if (!connected) {
      setActivateError("Sign in with your wallet to switch mines.");
      return;
    }
    setSwitching(true);
    setActivateError("");
    try {
      await ensureSession();
      const result = await gated("switch_mine", mint, () => switchMineRequest(mint));
      setPlayer(result.player);
      if (result.mine) setMineInfo(result.mine);
      setSwitchOpen(false);
      track("mine_switched", { network: "solana-devnet" });
      // Best-effort on-chain sync: assigns the player's current on-chain Mining Power to this
      // mine so real block-reward accounting matches the game's "active mine" state. A failure
      // here (e.g. the player's on-chain Player account doesn't exist yet) doesn't block the
      // off-chain switch above, which is what the ORE/streak/discovery loop actually runs on.
      if (config.programId) {
        const programId = config.programId;
        const wallet = connected.wallet;
        void import("./solanaProgram")
          .then(({ address, assignPowerOnChain }) => assignPowerOnChain(address(programId), wallet, address(mint)))
          .catch(() => {});
      }
    } catch (error) {
      setActivateError(messageOf(error));
    } finally {
      setSwitching(false);
    }
  }

  async function handleClaimRewards() {
    if (!connected || !config.programId || !featured) return;
    setActivateError("");
    try {
      const { address, claimRewardsOnChain } = await import("./solanaProgram");
      await claimRewardsOnChain(address(config.programId), connected.wallet, address(featured.mint));
      track("rewards_claimed", { network: "solana-devnet" });
      await refreshFeaturedToken();
    } catch (error) {
      setActivateError(error instanceof Error ? error.message : "Nothing to claim yet");
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
    const mint = marketPage ? featured?.mint : (player?.activeMint ?? featured?.mint);
    if (mint) void loadMineInfo(mint);
  }, [page, player?.activeMint, featured?.mint, loadMineInfo, session]);

  const activeMineToken = player?.activeMint
    ? (tokens.find((token) => token.mint === player.activeMint) ?? featured ?? null)
    : (featured ?? null);

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
  const mineInfoPanel = (token: TokenSummary | null, canSwitch: boolean) =>
    token && (
      <MineInfoPanel
        mine={mineInfo}
        mineName={token.name}
        now={now}
        loading={mineInfoLoading}
        error={mineInfoError}
        canSwitch={canSwitch}
        switching={switching}
        onSwitchHere={() => void handleSwitchMine(token.mint)}
      />
    );
  const canSwitchToFeatured = Boolean(signedIn && isMiningActive && featured && player?.activeMint !== featured.mint);

  return (
    <div className={"app page-" + page}>
      <a className="skip-link" href="#content">Skip to content</a>
      <AppHeader page={page} session={session} signedIn={signedIn} onAuthenticated={setSession} />

      <main id="content" tabIndex={-1}>
        {bootstrapFailed && (
          <div className="page-shell page-alert">
            <ErrorState title="The mines are unreachable right now." onRetry={retryBootstrap}>
              Diggo could not load live mine data. Your wallet and rewards are unaffected.
            </ErrorState>
          </div>
        )}

        <Suspense fallback={<RouteFallback />}>
          {legal && <LegalRoute pathname={window.location.pathname} />}

          {!legal && page === "home" && (
            <>
              <HomeHero
                featured={featured}
                player={player}
                connected={Boolean(connected)}
                now={now}
                activating={activating}
                error={activateError}
                onActivate={() => void handleActivate()}
                onManageCrew={() => setCrewOpen(true)}
                onLaunch={openLaunch}
                onClaimRewards={() => void handleClaimRewards()}
              />
              <Ticker tokens={tokens} />
              <ExploreBoard tokens={tokens} limit={3} onLaunch={openLaunch} />
              {economy}
              <HowItWorks />
              <FinalCta onLaunch={openLaunch} />
            </>
          )}

          {page === "mine" && (
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
                onSwitchMine={() => setSwitchOpen(true)}
                onCollect={() => void handleCollectReport()}
              />
              {mineInfoPanel(activeMineToken, false)}
            </>
          )}

          {page === "crew" && (
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
                    icon={<Hammer size={26} />}
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

          {page === "discoveries" && (
            <DiscoveriesPanel
              signedIn={signedIn}
              discoveries={discoveries}
              opportunity={opportunity}
              tokens={tokens}
              loading={discoveriesLoading}
              rolling={rolling}
              claimingId={claimingDiscoveryId}
              error={discoveryError}
              notice={discoveryNotice}
              onRequestOpportunity={() => void handleRequestOpportunity()}
              onRoll={() => void handleRollDiscovery()}
              onClaim={(discovery) => void handleClaimDiscovery(discovery)}
              onOpenToken={openTokenPage}
              onTrade={openTradePage}
              onSwitchCrew={(mint) => void handleSwitchMine(mint)}
            />
          )}

          {page === "explore" && (
            <>
              <Ticker tokens={tokens} />
              <ExploreBoard tokens={tokens} onLaunch={openLaunch} />
            </>
          )}

          {page === "leaderboards" && <LeaderboardsScreen tokens={tokens} onSelectMine={openTokenPage} />}

          {page === "mines" && (featured ? (
            <>
              <SelectedMine
                token={featured}
                mineInfo={mineInfo}
                now={now}
                canSwitch={canSwitchToFeatured}
                onSwitch={() => void handleSwitchMine(featured.mint)}
              />
              {mineInfoPanel(featured, canSwitchToFeatured)}
              {config.programId && (
                <SwapPanel token={featured} programAddress={config.programId} signer={connected?.wallet ?? null} onTraded={() => void refreshFeaturedToken()} />
              )}
            </>
          ) : (
            <section className="page-shell"><EmptyState title="No mine selected">Pick a mine from the board to see its reserve, power and market.</EmptyState></section>
          ))}

          {page === "trade" && (featured && config.programId ? (
            <SwapPanel token={featured} programAddress={config.programId} signer={connected?.wallet ?? null} onTraded={() => void refreshFeaturedToken()} />
          ) : (
            <section className="page-shell">
              <EmptyState title="Nothing to trade yet">Trading opens once a mine is live on devnet.</EmptyState>
            </section>
          ))}

          {page === "create" && (
            <section className="create-coin-page page-shell">
              <div>
                <h1>START A<br /><span>NEW MINE.</span></h1>
                <p>Create a fixed-supply Solana devnet coin, allocate its mining reserve, and optionally make the first real buy into its bonding curve.</p>
              </div>
              <div className="create-coin-card">
                <span>DEVNET LAUNCH</span>
                <h2>Everything settles on-chain.</h2>
                <p>Your creator wallet signs the launch and, if selected, the initial liquidity buy in one transaction.</p>
                <button className="btn btn-primary" onClick={openLaunch}>Open launch builder <ArrowUpRight size={17} /></button>
              </div>
            </section>
          )}

          {page === "cosmetics" && <CosmeticsScreen signedIn={signedIn} />}
          {page === "admin" && <AdminScreen signedIn={signedIn} />}
          {page === "ui" && UiGallery && <UiGallery />}
        </Suspense>

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
            onSwitchMine={() => { setMiningReport(null); setSwitchOpen(true); }}
          />
        )}
        {switchOpen && (
          <SwitchMineModal
            tokens={tokens}
            activeMint={player?.activeMint ?? null}
            switching={switching}
            error={activateError}
            onSwitch={(mint) => void handleSwitchMine(mint)}
            onClose={() => setSwitchOpen(false)}
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
