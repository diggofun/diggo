/**
 * Design review gallery, served at /__ui by the Vite dev server only (App drops the route and this
 * chunk from production builds). It renders the game screens against fixed sample data so the
 * ACTIVE, PAUSED and first-run states, every crew tier and the mining report can be reviewed
 * without a signed-in wallet. Nothing here talks to the Worker.
 */
import { useState } from "react";
import type { MineInfo, MiningReport, PlayerProfile, TokenSummary } from "../../shared/types";
import type { DiscoveryRecord } from "../../shared/types";
import { DIGGO_CONFIG } from "../../shared/economics";
import { discoveryVisualEvent } from "../../shared/discoveryVisual";
import { CrewScreen } from "../components/CrewScreen";
import { DashboardPanel } from "../components/DashboardPanel";
import { DiscoveriesPanel } from "../components/DiscoveriesPanel";
import { ExploreBoard, SelectedMine } from "../components/HomeSections";
import { DiscoveryArt, GameArt, MineScene } from "../components/MineScene";
import { MineInfoPanel } from "../components/MineInfoPanel";
import { MiningReportModal } from "../components/MiningReportModal";
import { PLAY_SUMMARY, PlayerOnboarding } from "../components/PlayerOnboarding";
import { SponsorEventsPanel } from "../components/SponsorEventsPanel";

const NOW = Math.floor(Date.now() / 1_000);

/**
 * The v2 program id, for the panels that need one to derive PDAs. The gallery never reads the
 * chain — both panels are rendered with a null wallet, so they show their unconnected state and
 * make no request at all.
 */
const GALLERY_PROGRAM_ID = "H3Y8GgTnvwv5U1bajfzj386YSPC48vvwjFroXYyHZFj5";

const SAMPLE_MINE: TokenSummary = {
  mint: "Samp1eMint11111111111111111111111111111111",
  slug: "sample-doggo",
  name: "Sample Doggo",
  symbol: "DOGGO",
  description: "Gallery sample",
  creator: "Samp1eCreator1111111111111111111111111111",
  imageUrl: null,
  status: "ACTIVE" as TokenSummary["status"],
  priceSol: 0.000001,
  priceUsd: 0.25,
  change24h: 4.2,
  volume24hUsd: 48_200,
  trades24h: 132,
  curveMining: { open: true, onCurve: true, cap: 1_000_000, mined: 160_000, remaining: 840_000, progress: 0.16, blockReward: 250, unpaid: 1_240 },
  sellCapacity: { sol: 41.5, tokens: 176_500 },
  marketCapUsd: 250_000,
  // On the curve the API's remainingReserve / reserveTotal are that curve's own cap and room, not
  // the Mining Reserve: 160K of a 1M cap emitted leaves 840K of budget.
  reserveRemaining: 840_000,
  reserveTotal: 1_000_000,
  rewardPerBlock: 250,
  networkPower: 12_400,
  nextBlockAt: NOW + 184,
  nextEpochAt: NOW + 86_400 * 3,
  createdAt: NOW - 86_400 * 9,
  decimals: 6,
};

function samplePlayer(overrides: Partial<PlayerProfile>): PlayerProfile {
  return {
    wallet: "Samp1eWa11et111111111111111111111111111111",
    createdAt: NOW - 86_400 * 30,
    crewLevels: { miners: 6, drills: 4, carts: 3, foreman: 2, storage: 3 },
    power: 1_840,
    oreBalance: 3_420,
    oreCapacity: 5_000,
    streak: 12,
    streakFreezes: 1,
    activationState: "ACTIVE",
    lastActivationAt: NOW - 3_600 * 5,
    activationExpiresAt: NOW + 3_600 * 19,
    activeMint: SAMPLE_MINE.mint,
    accountAgeSeconds: 86_400 * 30,
    maturityBps: 10_000,
    discoveryEligible: true,
    riskState: "NORMAL",
    longestStreak: 21,
    xp: 5_400,
    oreOverflow: 0,
    activatedAt: NOW - 3_600 * 5,
    streakGraceUntil: NOW + 3_600 * 30,
    ...overrides,
  };
}

const SAMPLE_REPORT: MiningReport = {
  activeSeconds: 3_600 * 23 + 60 * 12,
  oreGained: 1_284,
  streak: 13,
  streakFreezes: 1,
  usedFreeze: false,
  mineMint: SAMPLE_MINE.mint,
  oreOverflow: 64,
  blockRewards: [
    { mint: SAMPLE_MINE.mint, symbol: "DOGGO", amount: 182.5, claimId: "sample-claim", status: "ELIGIBLE", authority: "OFFCHAIN" } as NonNullable<MiningReport["blockRewards"]>[number],
  ],
  discovery: {
    id: "sample-discovery",
    eventId: "sample-event",
    window: "sample-window",
    mint: SAMPLE_MINE.mint,
    symbol: "DOGGO",
    rarity: "epic",
    visualEvent: discoveryVisualEvent("epic"),
    tokenAmount: 40,
    valueUsd: 10,
    priceUsd: 0.25,
    eligibilityScore: 72,
    status: "ELIGIBLE",
    claimable: true,
    claimedAt: null,
    txSignature: null,
    createdAt: NOW - 600,
  },
};

const noop = () => undefined;

const SAMPLE_MINE_INFO: MineInfo = {
  mint: SAMPLE_MINE.mint,
  symbol: SAMPLE_MINE.symbol,
  status: "MINING_ACTIVE",
  blockReward: 250,
  totalMiningPower: 12_400,
  remainingReserve: 840_000,
  reserveTotal: 1_000_000,
  estimatedShare: 0.148,
  estimatedRewardPerBlock: 37,
  estimateLabel: "Estimate only — your share moves with every crew that joins.",
  reductionSchedule: [250, 214, 183, 157, 134, 115, 98],
  fullyMinedProgress: 0.16,
  curveMining: SAMPLE_MINE.curveMining,
  emissionSource: "CURVE",
  curveMiningDaysRemaining: 12.4,
  nextBlockAt: NOW + 184,
  epoch: 3,
  epochEndsAt: NOW + 86_400 * 3,
  playerPower: 1_840,
  accounting: { source: "ONCHAIN_INDEXED", authoritative: true, label: "On-chain program accounts for every block." },
};

/**
 * The same mine after graduation, when blocks come out of the Mining Reserve instead of the curve.
 * Kept beside the curve-phase sample so both emission sources are reviewable on one page.
 */
const SAMPLE_RESERVE_MINE_INFO: MineInfo = {
  ...SAMPLE_MINE_INFO,
  emissionSource: "RESERVE",
  estimateLabel: "Estimate based on current conditions.",
  // Graduated, so these are the Mining Reserve's own numbers again.
  remainingReserve: 42_000,
  reserveTotal: 50_000,
  curveMining: {
    ...SAMPLE_MINE.curveMining,
    open: false,
    onCurve: false,
    mined: SAMPLE_MINE.curveMining.cap,
    remaining: 0,
    progress: 1,
    unpaid: 0,
  },
  curveMiningDaysRemaining: null,
};

/** The same market once it graduated: reserve emissions, pool liquidity, and no measurable 24h change. */
const SAMPLE_RESERVE_TOKEN: TokenSummary = {
  ...SAMPLE_MINE,
  mint: "Samp1eReserveMint11111111111111111111111111",
  slug: "sample-doggo-graduated",
  name: "Sample Doggo (graduated)",
  symbol: "DOGGO2",
  change24h: null,
  curveMining: SAMPLE_RESERVE_MINE_INFO.curveMining,
  sellCapacity: { sol: 0, tokens: null },
  reserveRemaining: 640_000,
  reserveTotal: 900_000,
};

/**
 * A mine whose curve cap is spent but which has not graduated: nothing pays a block, and the spare
 * reserve does not stand in for the cap. Worth reviewing, because it is the state where a curve
 * figure could easily be read as still emitting.
 */
const SAMPLE_SPENT_MINE_INFO: MineInfo = {
  ...SAMPLE_MINE_INFO,
  status: "FULLY_MINED",
  remainingReserve: 0,
  fullyMinedProgress: 1,
  curveMining: {
    ...SAMPLE_MINE.curveMining,
    open: false,
    mined: SAMPLE_MINE.curveMining.cap,
    remaining: 0,
    progress: 1,
    unpaid: 0,
  },
  curveMiningDaysRemaining: null,
};

/** Equipped maps that exercise every cosmetic slot the mine scene reads. */
const LOADOUTS: readonly { name: string; equipped: Record<string, string> }[] = [
  { name: "Defaults", equipped: {} },
  { name: "Steel + rail cart", equipped: { outfit: "outfit_steel", cart: "cart_rail", pickaxe: "pickaxe_iron" } },
  { name: "Gilded + hauler", equipped: { outfit: "outfit_gilded", cart: "cart_hauler", pickaxe: "pickaxe_diamond" } },
  { name: "Legendary + Sunset", equipped: { outfit: "outfit_legendary", cart: "cart_hover", mine_theme: "theme_sunset", pickaxe: "pickaxe_plasma" } },
  { name: "Arcane shaft", equipped: { outfit: "outfit_neon", mine_theme: "theme_arcane" } },
  { name: "Deep core", equipped: { mine_theme: "theme_deepcore", cart: "cart_hauler" } },
];

/** The square sprites and finds public/assets/game is expected to hold, with their intrinsic size. */
const ART_FILES: readonly { name: string; width: number; height: number }[] = [
  { name: "miner", width: 768, height: 768 },
  { name: "foreman", width: 768, height: 768 },
  { name: "drill", width: 768, height: 768 },
  { name: "cart", width: 768, height: 768 },
  { name: "storage", width: 768, height: 768 },
  { name: "discovery-stone", width: 512, height: 512 },
  { name: "discovery-meme-vein", width: 512, height: 512 },
  { name: "discovery-crystal-vein", width: 512, height: 512 },
  { name: "discovery-ancient-geode", width: 512, height: 512 },
  { name: "discovery-golden-block", width: 512, height: 512 },
  { name: "discovery-degen-core", width: 512, height: 512 },
];

/** Art with a shape of its own: a square thumbnail would hide what it actually looks like. */
const WIDE_ART_FILES: readonly { name: string; width: number; height: number; className: string }[] = [
  { name: "mine-bg", width: 1920, height: 1080, className: "ui-gallery-wide-art" },
  { name: "og-image", width: 1200, height: 630, className: "ui-gallery-wide-art is-social" },
];

/** The raster brand marks available for the gallery. */
const BRAND_FILES: readonly { src: string; alt: string; className?: string }[] = [
  { src: "/assets/brand/apple-touch-icon.png", alt: "Diggo mark" },
  { src: "/assets/brand/icon-192.png", alt: "Diggo mark at 192 pixels" },
  { src: "/assets/brand/icon-512.png", alt: "Diggo mark at 512 pixels", className: "is-mark" },
];

const RARITIES = ["common", "uncommon", "rare", "epic", "legendary", "mythic"] as const;

/** One sample find per rarity, so the discovery card art is reviewed at the size it ships at. */
const SAMPLE_DISCOVERIES: DiscoveryRecord[] = RARITIES.map((rarity, index) => ({
  id: "sample-" + rarity,
  eventId: "sample-event-" + rarity,
  window: "sample-window",
  mint: SAMPLE_MINE.mint,
  symbol: SAMPLE_MINE.symbol,
  rarity,
  visualEvent: discoveryVisualEvent(rarity),
  tokenAmount: 12 + index * 8,
  valueUsd: 3 + index * 2.5,
  priceUsd: 0.25,
  eligibilityScore: 60 + index * 6,
  status: index === 0 ? "PENDING" : "ELIGIBLE",
  claimable: index > 0,
  claimedAt: null,
  txSignature: null,
  createdAt: NOW - 600 * (index + 1),
}));

export function UiGallery() {
  const [now] = useState(() => Date.now());
  const [reportOpen, setReportOpen] = useState(() => new URLSearchParams(window.location.search).has("report"));
  const [collected, setCollected] = useState(false);
  const section = new URLSearchParams(window.location.search).get("section");
  const show = (name: string) => !section || section === name;
  const dashboardProps = {
    mine: SAMPLE_MINE,
    mineInfo: null,
    now,
    connected: true,
    activating: false,
    collecting: false,
    error: "",
    onActivate: noop,
    onManageCrew: noop,
    onCollect: () => setReportOpen(true),
  };

  return (
    <div className="ui-gallery">
      <section className="page-shell ui-gallery-intro">
        <span className="mono-label">DEV ONLY // UI GALLERY</span>
        <p>
          Sample data, no Worker calls. Filter with
          ?section=active|paused|first|tiers|crew|loadouts|discoveries|art|market|mineinfo|v2 and
          open the report with ?report.
        </p>
        <button className="btn btn-ghost btn-sm" onClick={() => { setCollected(false); setReportOpen(true); }}>Open mining report</button>
      </section>
      {show("active") && <DashboardPanel {...dashboardProps} player={samplePlayer({})} />}
      {show("paused") && (
        <DashboardPanel
          {...dashboardProps}
          player={samplePlayer({ activationState: "PAUSED", activationExpiresAt: NOW - 600, streakGraceUntil: NOW + 3_600 * 7 })}
        />
      )}
      {show("first") && (
        <DashboardPanel
          {...dashboardProps}
          player={samplePlayer({ activationState: "NEVER_ACTIVATED", streak: 0, streakFreezes: 0, streakGraceUntil: null, crewLevels: { miners: 1, drills: 1, carts: 1, foreman: 1, storage: 1 }, power: 100 })}
        />
      )}
      {/*
        The v2 surfaces, in their disconnected state. That is the first thing a new visitor sees,
        so it is the state worth reviewing: the two ways to play and what each costs.
      */}
      {show("v2") && (
        <>
          <section className="page-shell ui-gallery-tiers">
            <h2>Player onboarding — not connected</h2>
            <p className="onboarding-fine">
              {PLAY_SUMMARY}
            </p>
            <PlayerOnboarding programAddress={GALLERY_PROGRAM_ID} wallet={null} onChanged={noop} />
          </section>
          <section className="page-shell ui-gallery-tiers">
            <h2>Sponsor console — no vault yet</h2>
            <SponsorEventsPanel programAddress={GALLERY_PROGRAM_ID} wallet={null} />
          </section>
        </>
      )}
      {show("tiers") && (
        <section className="page-shell ui-gallery-tiers">
          <h2>Crew tiers</h2>
          <div>
            {DIGGO_CONFIG.crew.tiers.map((tier) => (
              <MineScene key={tier.tier} tier={tier.tier} active label={tier.name} />
            ))}
          </div>
        </section>
      )}
      {show("crew") && (
        <CrewScreen player={samplePlayer({})} pending={null} error="" notice="" onUpgrade={noop} />
      )}
      {show("discoveries") && (
        <DiscoveriesPanel
          signedIn
          discoveries={SAMPLE_DISCOVERIES}
          opportunity={null}
          tokens={[SAMPLE_MINE]}
          loading={false}
          rolling={false}
          error=""
          notice=""
          onRequestOpportunity={noop}
          onRoll={noop}
          onOpenToken={noop}
          onTrade={noop}
        />
      )}
      {show("loadouts") && (
        <section className="page-shell ui-gallery-tiers">
          <h2>Equipped cosmetics in the mine</h2>
          <p className="ui-gallery-note">
            The real MineScene with each loadout equipped. Colours only — no cosmetic changes Mining
            Power, ORE or discovery odds.
          </p>
          <div>
            {LOADOUTS.map((loadout) => (
              <figure className="ui-gallery-figure" key={loadout.name}>
                <MineScene tier={4} active cosmetics={loadout.equipped} label={loadout.name} />
                <figcaption>{loadout.name}</figcaption>
              </figure>
            ))}
          </div>
        </section>
      )}
      {show("art") && (
        <section className="page-shell ui-gallery-tiers">
          <h2>Brand</h2>
          <p className="ui-gallery-note">
            The available raster brand marks, from public/assets/brand, shown at the sizes they
            ship.
          </p>
          <div className="ui-gallery-brand">
            {BRAND_FILES.map((file) => (
              <img key={file.src} className={file.className} src={file.src} alt={file.alt} />
            ))}
          </div>
          <h2>Scene and social art</h2>
          <p className="ui-gallery-note">
            Reviewed at their own ratio: the mine cross-section the crew stands on, and the social
            card that ships with the copy composited into its empty left half.
          </p>
          <div>
            {WIDE_ART_FILES.map((file) => (
              <figure className="ui-gallery-figure ui-gallery-art ui-gallery-wide" key={file.name}>
                <GameArt
                  name={file.name}
                  alt={file.name + " art"}
                  width={file.width}
                  height={file.height}
                  className={file.className}
                  eager
                  fallback={<span className="ui-gallery-art-missing">no file</span>}
                />
                <figcaption>{file.name}</figcaption>
              </figure>
            ))}
          </div>
          <h2>Sprites and discovery art</h2>
          <p className="ui-gallery-note">
            Files that exist render; files that do not are replaced by the drawn fallback, with no
            broken image and no layout shift. Every tile here loads eagerly, because the gallery is
            captured whole: a sprite whose load or decode is still deferred is an empty box in a
            full-page screenshot even though the file itself is served fine.
          </p>
          <div>
            {ART_FILES.map((file) => (
              <figure className="ui-gallery-figure ui-gallery-art" key={file.name}>
                <GameArt
                  name={file.name}
                  alt={file.name + " art"}
                  width={file.width}
                  height={file.height}
                  className="ui-gallery-art-img"
                  eager
                  fallback={<span className="ui-gallery-art-missing">no file</span>}
                />
                <figcaption>{file.name}</figcaption>
              </figure>
            ))}
          </div>
          <h2>Discovery art by rarity</h2>
          <div>
            {RARITIES.map((rarity) => (
              <figure className="ui-gallery-figure ui-gallery-art" key={rarity}>
                <DiscoveryArt rarity={rarity} className="ui-gallery-art-img" eager />
                <figcaption>{rarity}</figcaption>
              </figure>
            ))}
          </div>
        </section>
      )}
      {show("market") && (
        <>
          <SelectedMine token={SAMPLE_MINE} mineInfo={SAMPLE_MINE_INFO} now={NOW} />
          <ExploreBoard tokens={[SAMPLE_MINE, SAMPLE_RESERVE_TOKEN]} onLaunch={noop} />
        </>
      )}
      {show("mineinfo") && (
        <>
          <MineInfoPanel
            mine={SAMPLE_MINE_INFO}
            mineName={SAMPLE_MINE.name}
            now={NOW}
            loading={false}
            error=""
          />
          <MineInfoPanel
            mine={SAMPLE_RESERVE_MINE_INFO}
            mineName={SAMPLE_MINE.name}
            now={NOW}
            loading={false}
            error=""
          />
          <MineInfoPanel
            mine={SAMPLE_SPENT_MINE_INFO}
            mineName={SAMPLE_MINE.name}
            now={NOW}
            loading={false}
            error=""
          />
        </>
      )}
      {reportOpen && (
        <MiningReportModal
          report={SAMPLE_REPORT}
          mineSymbol="DOGGO"
          collecting={false}
          collected={collected}
          error=""
          onCollect={() => setCollected(true)}
          onManageCrew={noop}
          onClose={() => setReportOpen(false)}
        />
      )}
    </div>
  );
}
