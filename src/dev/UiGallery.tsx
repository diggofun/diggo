/**
 * Design review gallery, served at /__ui by the Vite dev server only (App drops the route and this
 * chunk from production builds). It renders the game screens against fixed sample data so the
 * ACTIVE, PAUSED and first-run states, every crew tier and the mining report can be reviewed
 * without a signed-in wallet. Nothing here talks to the Worker.
 */
import { useState } from "react";
import type { MiningReport, PlayerProfile, TokenSummary } from "../../shared/types";
import { DIGGO_CONFIG } from "../../shared/economics";
import { discoveryVisualEvent } from "../../shared/discoveryVisual";
import { CrewScreen } from "../components/CrewScreen";
import { DashboardPanel } from "../components/DashboardPanel";
import { MineScene } from "../components/MineScene";
import { MiningReportModal } from "../components/MiningReportModal";

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
        <p>Sample data, no Worker calls. Filter with ?section=active|paused|first|tiers|crew and open the report with ?report.</p>
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
