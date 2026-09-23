/**
 * Design review gallery, served at /__ui by the Vite dev server only (App drops the route and this
 * chunk from production builds). It renders the game screens against fixed sample data so the
 * ACTIVE, PAUSED and first-run states, every crew tier and the mining report can be reviewed
 * without a signed-in wallet. Nothing here talks to the Worker.
 */
import { useState } from "react";
import type { MineInfo, MiningReport, PlayerProfile, TokenSummary } from "../../shared/types";
import { DIGGO_CONFIG } from "../../shared/economics";
import { discoveryVisualEvent } from "../../shared/discoveryVisual";
import { CrewScreen } from "../components/CrewScreen";
import { DashboardPanel } from "../components/DashboardPanel";
import { DiscoveryArt, GameArt, MineScene } from "../components/MineScene";
import { MineInfoPanel } from "../components/MineInfoPanel";
import { MiningReportModal } from "../components/MiningReportModal";
import { SoundToggle } from "../components/SoundToggle";
import { playSound } from "../sound";

const NOW = Math.floor(Date.now() / 1_000);

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
  marketCapUsd: 250_000,
  reserveRemaining: 42_000,
  reserveTotal: 50_000,
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
  remainingReserve: 42_000,
  reserveTotal: 50_000,
  estimatedShare: 0.148,
  estimatedRewardPerBlock: 37,
  estimateLabel: "Estimate only — your share moves with every crew that joins.",
  reductionSchedule: [250, 214, 183, 157, 134, 115, 98],
  fullyMinedProgress: 0.16,
  nextBlockAt: NOW + 184,
  epoch: 3,
  epochEndsAt: NOW + 86_400 * 3,
  playerPower: 1_840,
  accounting: { source: "ONCHAIN_INDEXED", authoritative: true, label: "On-chain program accounts for every block." },
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

/** Every file public/assets/game is expected to hold, with its intrinsic size. */
const ART_FILES: readonly { name: string; width: number; height: number }[] = [
  { name: "logo", width: 1024, height: 476 },
  { name: "logo-icon", width: 512, height: 512 },
  { name: "mine-bg", width: 1672, height: 941 },
  { name: "miner", width: 768, height: 768 },
  { name: "drill", width: 768, height: 768 },
  { name: "cart", width: 768, height: 768 },
  { name: "foreman", width: 768, height: 768 },
  { name: "storage", width: 768, height: 768 },
  { name: "discovery-stone", width: 512, height: 512 },
  { name: "discovery-meme-vein", width: 512, height: 512 },
  { name: "discovery-crystal-vein", width: 512, height: 512 },
  { name: "discovery-ancient-geode", width: 512, height: 512 },
  { name: "discovery-golden-block", width: 512, height: 512 },
  { name: "discovery-degen-core", width: 512, height: 512 },
  { name: "og-image", width: 1200, height: 630 },
];

const RARITIES = ["common", "uncommon", "rare", "epic", "legendary", "mythic"] as const;

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
    onSwitchMine: noop,
    onCollect: () => setReportOpen(true),
  };

  return (
    <div className="ui-gallery">
      <section className="page-shell ui-gallery-intro">
        <span className="mono-label">DEV ONLY // UI GALLERY</span>
        <p>
          Sample data, no Worker calls. Filter with
          ?section=active|paused|first|tiers|crew|loadouts|art|sound|mineinfo and open the report
          with ?report.
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
          <h2>Generated art</h2>
          <p className="ui-gallery-note">
            Files that exist render; files that do not are replaced by the drawn fallback, with no
            broken image and no layout shift.
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
                  fallback={<span className="ui-gallery-art-missing">no file — SVG fallback</span>}
                />
                <figcaption>{file.name}</figcaption>
              </figure>
            ))}
          </div>
          <h2>Discovery art by rarity</h2>
          <div>
            {RARITIES.map((rarity) => (
              <figure className="ui-gallery-figure ui-gallery-art" key={rarity}>
                <DiscoveryArt rarity={rarity} className="ui-gallery-art-img" />
                <figcaption>{rarity}</figcaption>
              </figure>
            ))}
          </div>
        </section>
      )}
      {show("sound") && (
        <section className="page-shell ui-gallery-tiers">
          <h2>Sound</h2>
          <div className="ui-gallery-sound">
            <SoundToggle />
            {(["activate", "collect", "upgrade"] as const).map((effect) => (
              <button className="btn btn-ghost btn-sm" key={effect} onClick={() => playSound(effect)}>
                {effect}
              </button>
            ))}
            {RARITIES.map((rarity) => (
              <button className="btn btn-ghost btn-sm" key={rarity} onClick={() => playSound("discovery", { rarity })}>
                {rarity}
              </button>
            ))}
          </div>
          <p className="ui-gallery-note">
            Muted by default, and the toggle remembers the choice. Every cue is synthesised with
            WebAudio — there are no audio files.
          </p>
        </section>
      )}
      {show("mineinfo") && (
        <MineInfoPanel
          mine={SAMPLE_MINE_INFO}
          mineName={SAMPLE_MINE.name}
          now={NOW}
          loading={false}
          error=""
          canSwitch
          switching={false}
          onSwitchHere={noop}
        />
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
          onSwitchMine={noop}
          onClose={() => setReportOpen(false)}
        />
      )}
    </div>
  );
}
