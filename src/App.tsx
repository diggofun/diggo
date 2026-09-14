import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import type { TransactionSigner } from "@solana/kit";
import {
  useConnect,
  useConnectedWallet,
  useDisconnect,
  useSignMessage,
  useWallets,
} from "@solana/kit-plugin-wallet/react";
import bs58 from "bs58";
import {
  ArrowDownRight,
  ArrowUpRight,
  Check,
  ChevronRight,
  Clock3,
  Coins,
  Copy,
  Flame,
  Gauge,
  Gem,
  Hammer,
  HardHat,
  Home,
  LayoutDashboard,
  LockKeyhole,
  Pickaxe,
  Plus,
  Radio,
  Search,
  ShieldCheck,
  Sparkles,
  Trophy,
  TrendingUp,
  Users,
  X,
  Zap,
} from "lucide-react";

import type { Leaderboards, MarketTrade, MiningReport, PlayerProfile, TokenSummary } from "../shared/types";
import { GAMEPLAY_DEFAULTS, crewTier, upgradeOreCost, type CrewComponent } from "../shared/economics";
import {
  activateMine as activateMineRequest,
  getActivationChallenge,
  getBootstrap,
  getChallenge,
  getLeaderboards,
  getPlayerProfile,
  getToken,
  recordTrade,
  registerLaunchedToken,
  switchMine as switchMineRequest,
  upgradeCrew,
  uploadTokenImage,
  verifyWallet,
  type DiggoConfig,
} from "./api";
import { track } from "./analytics";
import { TokenOrb } from "./components/TokenOrb";
import { TurnstileBox } from "./components/TurnstileBox";
import { solanaClient } from "./solana";
import {
  address,
  assignPowerOnChain,
  bondingCurveSpotPriceLamports,
  buyOnChain,
  claimRewardsOnChain,
  fetchMineAndMarket,
  fetchProtocolConfig,
  fetchSolBalance,
  fetchTokenBalance,
  launchCoinOnChain,
  quoteBuy,
  quoteSell,
  sellOnChain,
} from "./solanaProgram";
import type { DecodedLaunchMarket, DecodedMine } from "../shared/program";

const CREW_COMPONENT_LABELS: Record<CrewComponent, string> = {
  miners: "Miners",
  drills: "Drills",
  carts: "Carts",
  foreman: "Foreman",
  storage: "Storage",
};

const TURNSTILE_SITE_KEY = "0x4AAAAAAEzwvf6nnwXvXdMc";

function compact(value: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function money(value: number): string {
  if (value <= 0) return "$0.00";
  if (value < 0.000001) return `$${value.toExponential(2)}`;
  if (value < 0.01) return `$${value.toFixed(8)}`;
  return `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function shortAddress(value: string): string {
  return `${value.slice(0, 4)}…${value.slice(-5)}`;
}

function countdown(target: number, now: number): string {
  const delta = Math.max(0, target * 1000 - now);
  const seconds = Math.floor(delta / 1_000);
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const secs = seconds % 60;
  if (days) return `${days}d ${hours}h ${minutes}m`;
  return [hours, minutes, secs].map((part) => String(part).padStart(2, "0")).join(":");
}

function BrandMark() {
  return (
    <a className="brand" href="/" aria-label="Diggo.fun home">
      <span className="brand-mark"><Pickaxe size={19} strokeWidth={2.8} /></span>
      <span>DIGGO<span className="brand-dot">.FUN</span></span>
    </a>
  );
}

function WalletControl({
  session,
  onAuthenticated,
}: {
  session: string | null;
  onAuthenticated(session: string): void;
}) {
  const wallets = useWallets(solanaClient);
  const connected = useConnectedWallet(solanaClient);
  const connect = useConnect(solanaClient);
  const disconnect = useDisconnect(solanaClient);
  const signMessage = useSignMessage(solanaClient);
  const [open, setOpen] = useState(false);
  const [signingIn, setSigningIn] = useState(false);

  async function signIn(): Promise<void> {
    if (!connected) return;
    setSigningIn(true);
    try {
      const wallet = String(connected.account.address);
      const challenge = await getChallenge(wallet);
      const signature = await signMessage.dispatchAsync(new TextEncoder().encode(challenge.message));
      const verified = await verifyWallet(wallet, challenge.nonce, bs58.encode(signature));
      onAuthenticated(verified.session);
      track("wallet_signed_in", { network: "solana-devnet" });
    } catch {
      track("wallet_sign_in_failed", { network: "solana-devnet" });
    } finally {
      setSigningIn(false);
    }
  }

  if (connected) {
    return (
      <div className="wallet-control signed-wallet">
        <button className="wallet-button" disabled={signingIn} onClick={() => void signIn()} title="Sign in with wallet">
          {signingIn ? "Signing…" : session ? shortAddress(String(connected.account.address)) : "Sign in"}
        </button>
        <button className="wallet-disconnect" onClick={() => disconnect.dispatch()} title="Disconnect wallet">×</button>
      </div>
    );
  }

  return (
    <div className="wallet-control">
      <button className="wallet-button" onClick={() => setOpen((value) => !value)}>Connect wallet</button>
      {open && (
        <div className="wallet-menu">
          <strong>Choose a Wallet Standard wallet</strong>
          {wallets.length ? wallets.map((wallet) => (
            <button key={wallet.name} disabled={connect.isRunning} onClick={() => { connect.dispatch(wallet); setOpen(false); track("wallet_connected", { network: "solana-devnet" }); }}>
              {wallet.icon && <img src={wallet.icon} alt="" />} {wallet.name}
            </button>
          )) : <p>No compatible browser wallet found.</p>}
        </div>
      )}
    </div>
  );
}

function TokenCard({ token, onSelect }: { token: TokenSummary; onSelect(token: TokenSummary): void }) {
  const reservePercent = Math.round((token.reserveRemaining / token.reserveTotal) * 100);
  return (
    <article className="token-card" onClick={() => onSelect(token)}>
      <div className="token-card-head">
        <TokenOrb symbol={token.symbol} imageUrl={token.imageUrl} />
        <div className="token-title">
          <h3>{token.name}</h3>
          <span>${token.symbol}</span>
        </div>
        <span className={`change ${token.change24h >= 0 ? "positive" : "negative"}`}>
          {token.change24h >= 0 ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}
          {Math.abs(token.change24h)}%
        </span>
      </div>
      <div className="card-price">
        <strong>{money(token.priceUsd)}</strong>
        <span>{compact(token.marketCapUsd)} mcap</span>
      </div>
      <div className="mini-chart" aria-hidden="true">
        <svg viewBox="0 0 280 72" preserveAspectRatio="none">
          <path className="chart-fill" d="M0,66 C28,58 34,31 62,42 C90,53 105,18 133,29 C161,41 168,12 196,24 C225,37 245,11 280,6 L280,72 L0,72Z" />
          <path className="chart-line" d="M0,66 C28,58 34,31 62,42 C90,53 105,18 133,29 C161,41 168,12 196,24 C225,37 245,11 280,6" />
        </svg>
      </div>
      <div className="reserve-row">
        <span><Pickaxe size={13} /> unmined reserve</span>
        <strong>{reservePercent}%</strong>
      </div>
      <div className="progress"><i style={{ width: `${reservePercent}%` }} /></div>
      <div className="card-foot">
        <span><Gauge size={13} /> {compact(token.networkPower)} power</span>
        <button type="button">Mine <ChevronRight size={14} /></button>
      </div>
    </article>
  );
}

function CreateModal({
  onClose,
  session,
  onAuthenticated,
  config,
  onLaunched,
}: {
  onClose(): void;
  session: string | null;
  onAuthenticated(session: string): void;
  config: DiggoConfig;
  onLaunched(token: TokenSummary): void;
}) {
  const connected = useConnectedWallet(solanaClient);
  const signMessage = useSignMessage(solanaClient);
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [initialBuy, setInitialBuy] = useState("0");
  const [file, setFile] = useState<File | null>(null);
  const [turnstileToken, setTurnstileToken] = useState("");
  const [state, setState] = useState<"idle" | "working" | "done">("idle");
  const [message, setMessage] = useState("");
  const onTurnstileToken = useCallback((token: string) => setTurnstileToken(token), []);

  async function authenticate(): Promise<string> {
    const wallet = connected ? String(connected.account.address) : undefined;
    if (!wallet) throw new Error("Connect a wallet that supports message signing");
    const challenge = await getChallenge(wallet);
    const signature = await signMessage.dispatchAsync(new TextEncoder().encode(challenge.message));
    const verified = await verifyWallet(wallet, challenge.nonce, bs58.encode(signature));
    onAuthenticated(verified.session);
    track("wallet_signed_in", { network: "solana-devnet" });
    return verified.session;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!connected?.signer) {
      setMessage("Connect a wallet that can sign transactions before launching.");
      return;
    }
    setState("working");
    try {
      const activeSession = session ?? await authenticate();
      setMessage(file ? "Uploading artwork…" : "Preparing your launch…");
      const imageUrl = file ? await uploadTokenImage(file, activeSession) : undefined;

      setMessage("Reading protocol configuration from chain…");
      const programAddress = address(config.programId);
      const protocol = await fetchProtocolConfig(programAddress);
      if (!protocol) throw new Error("Protocol is not initialized on-chain yet");

      setMessage("Waiting for your wallet signature to launch on-chain…");
      const launch = await launchCoinOnChain(
        programAddress,
        connected.signer,
        protocol.treasury,
        protocol.reserveBps,
        protocol.discoveryReserveBps,
        {
          name,
          symbol: symbol.toUpperCase(),
          decimals: 6,
          totalSupplyWhole: 1_000_000_000,
          virtualSolReserveSol: 20,
          graduationTargetSol: 5,
          blockIntervalSeconds: 300,
          epochLengthSeconds: 604_800,
          reductionBps: 2_500,
          initialBlockRewardWhole: 10_000,
          minimumRewardWhole: 1,
          initialBuySol: Math.max(0, Number(initialBuy) || 0),
        },
      );
      track("launch_submitted", { has_artwork: Boolean(file), network: "solana-devnet" });

      setMessage("Registering your launch…");
      const token = await registerLaunchedToken(launch.mint, { description, imageUrl }, activeSession);
      onLaunched(token);
      setMessage(`Live on-chain at ${launch.mint.slice(0, 4)}…${launch.mint.slice(-4)}. Signature ${launch.signature.slice(0, 8)}…`);
      setState("done");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Launch failed");
      setState("idle");
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="launch-modal" role="dialog" aria-modal="true" aria-labelledby="launch-title" onMouseDown={(event) => event.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close"><X size={20} /></button>
        <div className="eyebrow"><Sparkles size={14} /> Launch on Diggo</div>
        <h2 id="launch-title">Put your meme<br />on the map.</h2>
        <p className="modal-intro">Every Diggo mint gets fixed supply and a program-locked 5% mining reserve plus 0.5% discovery reserve. This creates a real on-chain transaction from your wallet — Diggo never holds user funds.</p>
        {state === "done" ? (
          <div className="success-panel">
            <span><Check size={28} /></span>
            <h3>Your coin is live.</h3>
            <p>{message}</p>
            <button className="primary-button" onClick={onClose}>Back to the mines</button>
          </div>
        ) : (
          <form onSubmit={submit}>
            <div className="form-grid">
              <label>Name<input required maxLength={32} value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Deep Dog" /></label>
              <label>Ticker<input required maxLength={10} value={symbol} onChange={(event) => setSymbol(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} placeholder="DIG" /></label>
            </div>
            <label>Description<textarea required maxLength={280} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What is this coin digging for?" /></label>
            <label>Initial creator buy (SOL)<input type="number" min="0" step="0.001" value={initialBuy} onChange={(event) => setInitialBuy(event.target.value)} placeholder="0.00" /><i>Optional. Executes atomically with launch and becomes real bonding-curve liquidity.</i></label>
            <label className="file-input">
              <span>Token artwork</span>
              <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
              <i>{file ? file.name : "PNG, JPG or WEBP · max 2 MB"}</i>
            </label>
            <div className="launch-allocation">
              <span>94.5% user-held launch supply</span><span>5% locked mining reserve</span><span>0.5% locked discovery reserve</span><span>0% platform custody</span>
            </div>
            <TurnstileBox siteKey={TURNSTILE_SITE_KEY} onToken={onTurnstileToken} />
            {message && <p className="form-message">{message}</p>}
            <button className="primary-button launch-submit" disabled={state === "working" || !turnstileToken}>
              {state === "working" ? "Launching on-chain…" : "Launch on-chain"} <Pickaxe size={17} />
            </button>
          </form>
        )}
      </section>
    </div>
  );
}

function CrewPanel({
  player,
  session,
  onClose,
  onUpdate,
}: {
  player: PlayerProfile;
  session: string;
  onClose(): void;
  onUpdate(player: PlayerProfile): void;
}) {
  const [pending, setPending] = useState<CrewComponent | null>(null);
  const [error, setError] = useState("");
  const tier = crewTier(player.crewLevels);

  async function upgrade(component: CrewComponent) {
    setPending(component);
    setError("");
    try {
      const result = await upgradeCrew(component, session);
      onUpdate(result.player);
      track("crew_upgraded", { component });
    } catch (upgradeError) {
      setError(upgradeError instanceof Error ? upgradeError.message : "Upgrade failed");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="crew-modal" role="dialog" aria-modal="true" aria-labelledby="crew-title" onMouseDown={(event) => event.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close"><X size={20} /></button>
        <div className="eyebrow"><HardHat size={14} /> {tier.name}</div>
        <h2 id="crew-title">Manage your<br />Mining Crew.</h2>
        <div className="crew-stats">
          <div><span>MINING POWER</span><strong>{player.power.toLocaleString()}</strong></div>
          <div><span>ORE</span><strong>{Math.floor(player.oreBalance).toLocaleString()} <small>/ {player.oreCapacity.toLocaleString()}</small></strong></div>
          <div><span>MATURITY</span><strong>{(player.maturityBps / 100).toFixed(0)}%</strong></div>
        </div>
        <div className="crew-list">
          {(Object.keys(CREW_COMPONENT_LABELS) as CrewComponent[]).map((component) => {
            const level = player.crewLevels[component];
            const cost = level < 100 ? upgradeOreCost(component, level) : null;
            const affordable = cost !== null && player.oreBalance >= cost;
            return (
              <div className="crew-row" key={component}>
                <div className="crew-row-label"><Hammer size={15} /> {CREW_COMPONENT_LABELS[component]}<span>LV. {level}</span></div>
                <button
                  disabled={!cost || !affordable || pending === component}
                  onClick={() => void upgrade(component)}
                >
                  {pending === component ? "Upgrading…" : cost ? <>Upgrade <Gem size={13} /> {cost.toLocaleString()}</> : "Max level"}
                </button>
              </div>
            );
          })}
        </div>
        {error && <p className="form-message">{error}</p>}
        <p className="crew-note">Crew upgrades only ever cost ORE — mined by keeping your crew active. ORE cannot be bought, sold, or transferred.</p>
      </section>
    </div>
  );
}

function MiningReportModal({
  report,
  activeSymbol,
  onClose,
  onManageCrew,
}: {
  report: MiningReport;
  activeSymbol: string | null;
  onClose(): void;
  onManageCrew(): void;
}) {
  const hours = Math.floor(report.activeSeconds / 3_600);
  const minutes = Math.floor((report.activeSeconds % 3_600) / 60);
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="report-modal" role="dialog" aria-modal="true" aria-labelledby="report-title" onMouseDown={(event) => event.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close"><X size={20} /></button>
        <div className="eyebrow"><Radio size={14} /> Welcome back</div>
        <h2 id="report-title">Your crew worked<br />{hours}h {minutes}m.</h2>
        <div className="report-grid">
          <div><span>ORE MINED</span><strong>+{report.oreGained.toLocaleString()}</strong></div>
          <div><span>STREAK</span><strong><Flame size={16} /> {report.streak} {report.streak === 1 ? "day" : "days"}</strong></div>
        </div>
        {report.usedFreeze && <p className="form-message">A Streak Freeze protected your streak while you were away.</p>}
        {report.discovery ? (
          <div className="discovery-banner">
            <span className={`rarity-tag rarity-${report.discovery.rarity}`}>{report.discovery.rarity.toUpperCase()} DISCOVERY</span>
            <strong>+{report.discovery.tokenAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })} {report.discovery.symbol}</strong>
            <small>Your crew stumbled on this {activeSymbol ? `while mining $${activeSymbol}` : "coin"}.</small>
          </div>
        ) : (
          <p className="report-nodiscovery">No discovery this time — keep your crew active and eligible for a shot at one.</p>
        )}
        <div className="report-actions">
          <button className="outline-button" onClick={onManageCrew}>Manage crew <Hammer size={15} /></button>
          <button className="primary-button" onClick={onClose}>Collect <Check size={16} /></button>
        </div>
      </section>
    </div>
  );
}

function formatTokenAmount(raw: bigint, decimals: number): string {
  const whole = Number(raw) / 10 ** decimals;
  return whole.toLocaleString(undefined, { maximumFractionDigits: whole < 1 ? 6 : 2 });
}

function DashboardOverview({ tokens, player }: { tokens: TokenSummary[]; player: PlayerProfile | null }) {
  const totalLiquidity = tokens.reduce((sum, token) => sum + token.priceSol * Math.max(0, token.reserveTotal - token.reserveRemaining), 0);
  const totalPower = tokens.reduce((sum, token) => sum + token.networkPower, 0);
  const activeMines = tokens.filter((token) => token.status === "MINING_ACTIVE").length;
  return (
    <section className="dashboard-overview page-shell" id="dashboard">
      <div className="dashboard-title">
        <div><span className="mono-label">DIGGO COMMAND CENTER</span><h2>Market overview</h2></div>
        <span className="devnet-chip"><i /> SOLANA DEVNET</span>
      </div>
      <div className="dashboard-kpis">
        <article><span>Coins launched</span><strong>{tokens.length}</strong><small>verified on-chain mints</small></article>
        <article><span>Active mines</span><strong>{activeMines}</strong><small>graduated bonding curves</small></article>
        <article><span>Curve liquidity</span><strong>{totalLiquidity.toFixed(3)} SOL</strong><small>estimated from live reserves</small></article>
        <article><span>Network power</span><strong>{compact(totalPower)}</strong><small>{player ? `${compact(player.power)} belongs to your crew` : "connect to see your share"}</small></article>
      </div>
    </section>
  );
}

function MiningDashboard({
  token,
  player,
  now,
  isMiningActive,
  estimatedReward,
  onManageCrew,
  onClaim,
  canClaim,
}: {
  token: TokenSummary;
  player: PlayerProfile | null;
  now: number;
  isMiningActive: boolean;
  estimatedReward: number;
  onManageCrew(): void;
  onClaim(): void;
  canClaim: boolean;
}) {
  const orePercent = player ? Math.min(100, (player.oreBalance / Math.max(1, player.oreCapacity)) * 100) : 0;
  const powerShare = player && token.networkPower > 0 ? (player.power / token.networkPower) * 100 : 0;
  const tier = player ? crewTier(player.crewLevels) : null;
  const projectedRewardPerBlock = player ? estimatedReward : token.rewardPerBlock;
  const rewardProjection = Array.from({ length: 24 }, (_, index) => projectedRewardPerBlock * (index + 1));
  const projectionMax = Math.max(1, rewardProjection.at(-1) ?? 1);
  const projectionPoints = rewardProjection.map((value, index) => {
    const x = 4 + (index / Math.max(1, rewardProjection.length - 1)) * 292;
    const y = 94 - (value / projectionMax) * 78;
    return `${x},${y}`;
  }).join(" ");
  const projectionArea = `4,94 ${projectionPoints} 296,94`;
  return (
    <section className="mining-dashboard page-shell">
      <div className="mining-dashboard-heading">
        <div><span className="eyebrow"><Pickaxe size={14} /> Mining dashboard</span><h2>YOUR MINING<br /><span>DESK.</span></h2></div>
        <div className={`mining-status ${isMiningActive ? "active" : ""}`}><i /> {isMiningActive ? "Mining live" : player ? "Crew paused" : "Wallet not connected"}</div>
      </div>

      <div className="mining-kpis">
        <article><span>ACTIVE MINE</span><strong>${token.symbol}</strong><small>{token.name}</small></article>
        <article><span>YOUR POWER</span><strong>{player ? compact(player.power) : "—"}</strong><small>{player ? `${powerShare.toFixed(3)}% of network` : "connect a wallet to see it"}</small></article>
        <article><span>NEXT BLOCK SHARE</span><strong>{player ? estimatedReward.toFixed(2) : "—"}</strong><small>${token.symbol} estimated</small></article>
        <article><span>NEXT BLOCK</span><strong>{token.networkPower > 0 ? countdown(token.nextBlockAt, now) : "Waiting"}</strong><small>{compact(token.rewardPerBlock)} ${token.symbol} total reward</small></article>
      </div>

      {player ? (
        <div className="mining-dashboard-grid">
          <div className="ore-storage-panel">
            <div><span>ORE STORAGE</span><strong>{Math.floor(player.oreBalance).toLocaleString()} <small>/ {player.oreCapacity.toLocaleString()}</small></strong></div>
            <div className="ore-meter" aria-label={`${orePercent.toFixed(0)}% ORE storage full`}><i style={{ width: `${orePercent}%` }} /></div>
            <small>{orePercent.toFixed(0)}% capacity · ORE upgrades your crew only</small>
          </div>
          <div className="crew-overview-panel">
            <div className="crew-overview-head"><div><span>YOUR CREW</span><strong>{tier?.name}</strong></div><button className="outline-button" onClick={onManageCrew}>Manage crew <Hammer size={14} /></button></div>
            <div className="crew-levels">
              {(Object.keys(CREW_COMPONENT_LABELS) as CrewComponent[]).map((component) => <span key={component}><i>{CREW_COMPONENT_LABELS[component].slice(0, 1)}</i>{CREW_COMPONENT_LABELS[component]} <b>LV. {player.crewLevels[component]}</b></span>)}
            </div>
          </div>
          <div className="mining-session-panel">
            <span>SESSION</span>
            <strong>{isMiningActive ? "Active" : "Inactive"}</strong>
            <small>{isMiningActive ? `resets in ${countdown(Math.floor(player.activationExpiresAt ?? 0), now)}` : "activate your crew to earn block rewards"}</small>
            <div className="mining-actions">
              <button className="primary-button" onClick={onManageCrew}>Upgrade gear <Hammer size={15} /></button>
              {canClaim && <button className="claim-rewards-button" onClick={onClaim}><Coins size={13} /> Claim on-chain</button>}
            </div>
          </div>
        </div>
      ) : (
        <div className="mining-connect-panel"><Pickaxe size={26} /><div><strong>Connect your wallet to unlock your mining dashboard.</strong><p>Your crew level, ORE storage, reward share and claimable balance will appear here.</p></div></div>
      )}

        <div className="mining-charts">
          <article className="reward-projection-chart">
            <div className="mining-chart-heading"><div><span>{player ? "YOUR REWARD PROJECTION" : "MINE REWARD SCHEDULE"}</span><strong>{rewardProjection.at(-1)?.toFixed(2)} ${token.symbol}</strong></div><small>NEXT 24 BLOCKS</small></div>
            <svg viewBox="0 0 300 100" role="img" aria-label={`Estimated cumulative ${token.symbol} reward over the next 24 blocks`}>
              <path className="projection-grid" d="M4 18H296M4 56H296M4 94H296" />
              <polygon className="projection-area" points={projectionArea} />
              <polyline className="projection-line" points={projectionPoints} />
            </svg>
            <p>{player ? "Estimate based on your current power share. It changes if network power changes." : "Total mine emissions at the current per-block reward."}</p>
          </article>
          <article className="power-share-chart">
            <div className="mining-chart-heading"><div><span>{player ? "NETWORK POWER SHARE" : "NETWORK POWER"}</span><strong>{player ? `${powerShare.toFixed(3)}%` : compact(token.networkPower)}</strong></div><small>LIVE SNAPSHOT</small></div>
            <div className="power-ring-wrap">
              <svg viewBox="0 0 120 120" role="img" aria-label={player ? `${powerShare.toFixed(3)} percent of the mining network power` : "Network mining power"}>
                <circle className="power-ring-track" cx="60" cy="60" r="47" />
                <circle className="power-ring-value" cx="60" cy="60" r="47" pathLength="100" strokeDasharray={`${player ? Math.max(0.8, Math.min(100, powerShare)) : 100} 100`} />
              </svg>
              <div><strong>{compact(player?.power ?? token.networkPower)}</strong><span>{player ? "YOUR POWER" : "NETWORK POWER"}</span></div>
            </div>
            <p>{player ? `${compact(token.networkPower)} total network power on $${token.symbol}.` : "Connect a wallet to see your exact power share."}</p>
          </article>
        </div>
    </section>
  );
}

function LeaderboardPanel({ tokens }: { tokens: TokenSummary[] }) {
  const [data, setData] = useState<Leaderboards>({ miners: [], streaks: [], mines: tokens });
  const [tab, setTab] = useState<"miners" | "streaks" | "mines">("miners");
  useEffect(() => {
    getLeaderboards().then(setData).catch(() => setData((current) => ({ ...current, mines: tokens })));
  }, [tokens]);
  return (
    <section className="leaderboards page-shell" id="leaderboards">
      <div className="section-heading">
        <div><div className="eyebrow"><Trophy size={14} /> Leaderboards</div><h2>TOP OF<br />THE SHAFT.</h2></div>
        <div className="filter-tabs">
          <button className={tab === "miners" ? "active" : ""} onClick={() => setTab("miners")}>Miners</button>
          <button className={tab === "streaks" ? "active" : ""} onClick={() => setTab("streaks")}>Streaks</button>
          <button className={tab === "mines" ? "active" : ""} onClick={() => setTab("mines")}>Mines</button>
        </div>
      </div>
      <div className="leaderboard-table">
        <div className="leaderboard-row leaderboard-head"><span>#</span><span>{tab === "mines" ? "Mine" : "Wallet"}</span><span>{tab === "miners" ? "Power" : tab === "streaks" ? "Streak" : "Network power"}</span><span>{tab === "mines" ? "Status" : "Active days"}</span></div>
        {tab === "mines" ? data.mines.map((mine, index) => (
          <div className="leaderboard-row" key={mine.mint}><b>{index + 1}</b><span className="leaderboard-name"><TokenOrb symbol={mine.symbol} imageUrl={mine.imageUrl} /> ${mine.symbol}</span><strong>{compact(mine.networkPower)}</strong><em>{mine.status.replace("_", " ")}</em></div>
        )) : data[tab].map((entry) => (
          <div className="leaderboard-row" key={`${tab}-${entry.wallet}`}><b>{entry.rank}</b><span>{shortAddress(entry.wallet)}</span><strong>{tab === "miners" ? compact(entry.power) : `${entry.streak} days`}</strong><em>{entry.activeDays} days</em></div>
        ))}
        {(tab === "mines" ? data.mines : data[tab]).length === 0 && <div className="leaderboard-empty">No verified activity yet. The first on-chain miner takes the top spot.</div>}
      </div>
    </section>
  );
}

function DiggoSwapPanel({
  token,
  programAddress,
  signer,
  onTraded,
}: {
  token: TokenSummary;
  programAddress: string;
  signer: TransactionSigner | null;
  onTraded(): void;
}) {
  const walletAddress = signer?.address ?? null;
  const chartContainerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Area"> | null>(null);
  const [tradeCount, setTradeCount] = useState(0);
  const [recentTrades, setRecentTrades] = useState<MarketTrade[]>([]);
  const [lastSignature, setLastSignature] = useState("");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [solBalance, setSolBalance] = useState<bigint | null>(null);
  const [tokenBalance, setTokenBalance] = useState<bigint | null>(null);
  const [chainState, setChainState] = useState<{ mine: DecodedMine; market: DecodedLaunchMarket } | null>(null);

  // chart setup — created once per mount, data re-seeded whenever the mint changes
  useEffect(() => {
    if (!chartContainerRef.current) return;
    const chart = createChart(chartContainerRef.current, {
      height: 260,
      layout: { background: { color: "transparent" }, textColor: "#79796e", fontFamily: "monospace", fontSize: 10 },
      grid: { vertLines: { visible: false }, horzLines: { color: "rgba(23,24,19,.08)" } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: true },
      crosshair: { horzLine: { visible: false }, vertLine: { visible: false } },
    });
    const series = chart.addAreaSeries({
      lineColor: "#7657ff",
      topColor: "rgba(118,87,255,.28)",
      bottomColor: "rgba(118,87,255,.02)",
      lineWidth: 2,
      priceFormat: { type: "price", precision: 9, minMove: 0.000000001 },
    });
    chartRef.current = chart;
    seriesRef.current = series;
    const resize = () => chart.applyOptions({ width: chartContainerRef.current?.clientWidth ?? 0 });
    resize();
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // live trades over WebSocket, seeded from the snapshot the Worker/Durable Object already has
  useEffect(() => {
    setTradeCount(0);
    setRecentTrades([]);
    setChainState(null);
    const protocol = "wss:";
    const host = window.location.host;
    const proto = window.location.protocol === "https:" ? protocol : "ws:";
    const ws = new WebSocket(`${proto}//${host}/api/tokens/${token.mint}/live`);
    ws.onmessage = (event) => {
      const payload = JSON.parse(event.data) as
        | { type: "snapshot"; snapshot: { recentTrades: MarketTrade[] } }
        | { type: "trade"; trade: MarketTrade };
      const series = seriesRef.current;
      if (!series) return;
      if (payload.type === "snapshot") {
        const points = payload.snapshot.recentTrades
          .filter((t) => t.priceSol > 0)
          .slice()
          .reverse()
          .map((t) => ({ time: t.timestamp as UTCTimestamp, value: t.priceSol }));
        if (points.length > 0) {
          series.setData(points);
          chartRef.current?.timeScale().fitContent();
        }
        setTradeCount(points.length);
        setRecentTrades(payload.snapshot.recentTrades.slice(0, 12));
      } else if (payload.type === "trade" && payload.trade.priceSol > 0) {
        series.update({ time: payload.trade.timestamp as UTCTimestamp, value: payload.trade.priceSol });
        setTradeCount((count) => count + 1);
        setRecentTrades((current) => [payload.trade, ...current.filter((trade) => trade.signature !== payload.trade.signature)].slice(0, 12));
      }
    };
    return () => ws.close();
  }, [token.mint]);

  const refreshChainState = useCallback(async () => {
    try {
      const result = await fetchMineAndMarket(address(programAddress), address(token.mint));
      setChainState(result);
    } catch {
      setChainState(null);
    }
  }, [programAddress, token.mint]);

  useEffect(() => {
    void refreshChainState();
  }, [refreshChainState]);

  useEffect(() => {
    if (!walletAddress) {
      setSolBalance(null);
      setTokenBalance(null);
      return;
    }
    const owner = address(walletAddress);
    fetchSolBalance(owner).then(setSolBalance).catch(() => setSolBalance(null));
    fetchTokenBalance(owner, address(token.mint)).then(setTokenBalance).catch(() => setTokenBalance(null));
  }, [walletAddress, token.mint, tradeCount]);

  const decimals = token.decimals;
  const parsedAmount = Number(amount);
  const quoteOut = useMemo(() => {
    if (!chainState || !Number.isFinite(parsedAmount) || parsedAmount <= 0) return null;
    if (side === "buy") {
      const lamportsIn = BigInt(Math.round(parsedAmount * 1_000_000_000));
      return quoteBuy(chainState.market, lamportsIn);
    }
    const rawIn = BigInt(Math.round(parsedAmount * 10 ** decimals));
    return quoteSell(chainState.market, rawIn);
  }, [chainState, parsedAmount, side, decimals]);

  async function submitTrade(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (!signer) {
      setError("Connect a wallet that can sign transactions first.");
      return;
    }
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      setError("Enter an amount.");
      return;
    }
    setBusy(true);
    try {
      const programAddr = address(programAddress);
      const mint = address(token.mint);
      let result: { signature: string };
      let recordedAmount: number;
      if (side === "buy") {
        const minOut = quoteOut !== null ? (quoteOut * 98n) / 100n : 0n;
        result = await buyOnChain(programAddr, signer, mint, parsedAmount, minOut);
        recordedAmount = quoteOut !== null ? Number(quoteOut) / 10 ** decimals : 0;
      } else {
        const rawIn = BigInt(Math.round(parsedAmount * 10 ** decimals));
        const minOutLamports = quoteOut !== null ? (quoteOut * 98n) / 100n : 0n;
        result = await sellOnChain(programAddr, signer, mint, rawIn, minOutLamports);
        recordedAmount = parsedAmount;
      }
      await recordTrade(token.mint, { signature: result.signature, side, amount: recordedAmount });
      setLastSignature(result.signature);
      track(side === "buy" ? "swap_buy" : "swap_sell", { network: "solana-devnet" });
      setAmount("");
      await refreshChainState();
      onTraded();
    } catch (tradeError) {
      setError(tradeError instanceof Error ? tradeError.message : "Trade failed");
    } finally {
      setBusy(false);
    }
  }

  const spotPriceSol = chainState ? bondingCurveSpotPriceLamports(chainState.market, decimals) / 1_000_000_000 : token.priceSol;

  return (
    <section className="swap-terminal page-shell" id="swap">
      <div className="section-heading">
        <div><div className="eyebrow"><TrendingUp size={14} /> DiggoSwap</div><h2>TRADE<br />${token.symbol}.</h2></div>
        <div className="swap-price-tag">
          <span>SPOT PRICE</span>
          <strong>{spotPriceSol < 0.000001 ? spotPriceSol.toExponential(3) : spotPriceSol.toFixed(9)} SOL</strong>
        </div>
      </div>
      <div className="swap-grid">
        <div className="swap-chart-panel">
          <div ref={chartContainerRef} className="swap-chart" />
          {tradeCount < 2 && (
            <div className="swap-chart-empty">
              <Radio size={16} /> Not enough trade history yet — every real buy/sell plots here live.
            </div>
          )}
          <div className="trade-tape">
            <div className="trade-tape-head"><span>Side</span><span>Price (SOL)</span><span>Amount</span><span>Txn</span></div>
            {recentTrades.map((trade) => (
              <div className="trade-tape-row" key={trade.signature}>
                <b className={trade.side}>{trade.side}</b>
                <span>{trade.priceSol.toExponential(4)}</span>
                <span>{compact(trade.amount)}</span>
                <a href={`https://explorer.solana.com/tx/${trade.signature}?cluster=devnet`} target="_blank" rel="noreferrer">{trade.signature.slice(0, 5)}…</a>
              </div>
            ))}
          </div>
        </div>
        <form className="swap-form" onSubmit={submitTrade}>
          <div className="swap-tabs">
            <button type="button" className={side === "buy" ? "active" : ""} onClick={() => setSide("buy")}>Buy</button>
            <button type="button" className={side === "sell" ? "active" : ""} onClick={() => setSide("sell")}>Sell</button>
          </div>
          <label>
            {side === "buy" ? "Pay (SOL)" : `Sell ($${token.symbol})`}
            <input
              type="number"
              min="0"
              step="any"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          </label>
          <div className="swap-quote">
            <span>YOU RECEIVE (EST., 2% SLIPPAGE FLOOR)</span>
            <strong>
              {quoteOut !== null
                ? side === "buy"
                  ? `${formatTokenAmount(quoteOut, decimals)} $${token.symbol}`
                  : `${(Number(quoteOut) / 1_000_000_000).toFixed(6)} SOL`
                : "—"}
            </strong>
          </div>
          {walletAddress && (
            <div className="swap-balances">
              <span>{solBalance !== null ? (Number(solBalance) / 1_000_000_000).toFixed(4) : "…"} SOL</span>
              <span>{tokenBalance !== null ? formatTokenAmount(tokenBalance, decimals) : "…"} ${token.symbol}</span>
            </div>
          )}
          {error && <p className="form-message">{error}</p>}
          {lastSignature && <a className="tx-success" href={`https://explorer.solana.com/tx/${lastSignature}?cluster=devnet`} target="_blank" rel="noreferrer"><Check size={13} /> Confirmed on devnet · View transaction</a>}
          <button className="primary-button swap-submit" disabled={busy || !signer}>
            {busy ? "Confirming…" : signer ? (side === "buy" ? "Buy on-chain" : "Sell on-chain") : "Connect wallet"} <Zap size={16} />
          </button>
          <p className="swap-note">
            Real SOL moves through the mine's own bonding curve — this is the same liquidity a
            graduation threshold is measured against. Nothing here is simulated.
          </p>
        </form>
      </div>
    </section>
  );
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
  const [copied, setCopied] = useState(false);
  const [session, setSession] = useState<string | null>(null);
  const [loadingTokens, setLoadingTokens] = useState(true);
  const [config, setConfig] = useState<DiggoConfig>({
    cluster: "devnet",
    turnstileSiteKey: "",
    programId: "",
    vanitySuffix: "diggo",
  });
  const connected = useConnectedWallet(solanaClient);
  const signMessage = useSignMessage(solanaClient);
  const page = useMemo(() => {
    const routes: Record<string, string> = {
      "/": "home",
      "/mine": "mine",
      "/explore": "explore",
      "/trade": "trade",
      "/leaderboards": "leaderboards",
      "/mines": "mines",
      "/create": "create",
    };
    return routes[window.location.pathname] ?? "home";
  }, []);

  useEffect(() => {
    getBootstrap()
      .then((result) => {
        setTokens(result.tokens);
        const requestedMint = new URLSearchParams(window.location.search).get("mint");
        setSelected(result.tokens.find((token) => token.mint === requestedMint) ?? result.tokens[0] ?? null);
        setConfig(result.config);
      })
      .finally(() => setLoadingTokens(false));
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!session || !connected) {
      setPlayer(null);
      return;
    }
    const wallet = String(connected.account.address);
    getPlayerProfile(wallet, session).then(setPlayer).catch(() => setPlayer(null));
  }, [session, connected]);

  const featured = selected ?? tokens[0];
  const reservePercent = featured ? (featured.reserveRemaining / featured.reserveTotal) * 100 : 0;
  const estimatedReward = featured && featured.networkPower > 0
    ? ((player?.power ?? 0) / featured.networkPower) * featured.rewardPerBlock
    : 0;
  const sortedTokens = useMemo(() => [...tokens].sort((a, b) => b.change24h - a.change24h), [tokens]);
  const isMiningActive = player?.activationState === "ACTIVE";

  function copyMint() {
    if (!featured) return;
    navigator.clipboard.writeText(featured.mint).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_400);
    });
  }

  async function ensureSession(wallet: string): Promise<string> {
    if (session) return session;
    const challenge = await getChallenge(wallet);
    const signature = await signMessage.dispatchAsync(new TextEncoder().encode(challenge.message));
    const verified = await verifyWallet(wallet, challenge.nonce, bs58.encode(signature));
    setSession(verified.session);
    track("wallet_signed_in", { network: "solana-devnet" });
    return verified.session;
  }

  async function handleActivate() {
    if (!connected || !featured) return;
    setActivating(true);
    setActivateError("");
    try {
      const wallet = String(connected.account.address);
      await ensureSession(wallet);
      const challenge = await getActivationChallenge(wallet);
      const signature = await signMessage.dispatchAsync(new TextEncoder().encode(challenge.message));
      const result = await activateMineRequest(wallet, challenge.nonce, bs58.encode(signature), featured.mint);
      setPlayer(result.player);
      setMiningReport(result.report);
      track("mine_activated", { streak: result.report.streak, network: "solana-devnet" });
    } catch (error) {
      setActivateError(error instanceof Error ? error.message : "Activation failed");
    } finally {
      setActivating(false);
    }
  }

  async function handleSwitchMine(mint: string) {
    if (!session) {
      setActivateError("Sign in with your wallet to switch mines.");
      return;
    }
    try {
      const updated = await switchMineRequest(mint, session);
      setPlayer(updated);
      track("mine_switched", { network: "solana-devnet" });
      // Best-effort on-chain sync: assigns the player's current on-chain Mining Power to this
      // mine so real block-reward accounting matches the game's "active mine" state. A failure
      // here (e.g. the player's on-chain Player account doesn't exist yet) doesn't block the
      // off-chain switch above, which is what the ORE/streak/discovery loop actually runs on.
      if (config.programId && connected?.signer) {
        assignPowerOnChain(address(config.programId), connected.signer, address(mint)).catch(() => {});
      }
    } catch (error) {
      setActivateError(error instanceof Error ? error.message : "Switch failed");
    }
  }

  async function handleClaimRewards() {
    if (!connected?.signer || !config.programId || !featured) return;
    setActivateError("");
    try {
      await claimRewardsOnChain(address(config.programId), connected.signer, address(featured.mint));
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

  if (loadingTokens) return <div className="loading-screen"><Pickaxe /> DIGGING UP THE DATA…</div>;

  return (
    <main id="top" className={`app page-${page}`}>
      <header className="site-header">
        <BrandMark />
        <nav aria-label="Main navigation">
          <a className={page === "home" ? "active" : ""} href="/"><Home size={13} /> Home</a>
          <a className={page === "mine" ? "active" : ""} href="/mine"><Pickaxe size={13} /> Mine</a>
          <a className={page === "explore" ? "active" : ""} href="/explore"><Search size={13} /> Explore</a>
          <a className={page === "trade" ? "active" : ""} href="/trade"><TrendingUp size={13} /> Trade $DIGGO</a>
          <a className={page === "leaderboards" ? "active" : ""} href="/leaderboards"><Trophy size={13} /> Leaderboards</a>
          <a className={page === "mines" ? "active" : ""} href="/mines"><LayoutDashboard size={13} /> Mines</a>
        </nav>
        <div className="header-actions">
          <a className="launch-button" href="/create"><Plus size={16} /> Create a new coin</a>
          <WalletControl session={session} onAuthenticated={setSession} />
        </div>
      </header>

      {page === "create" && (
        <section className="create-coin-page page-shell">
          <div>
            <span className="eyebrow"><Plus size={14} /> Create a new coin</span>
            <h1>START A<br /><span>NEW MINE.</span></h1>
            <p>Create a fixed-supply Solana devnet coin, allocate its mining reserve, and optionally make the first real buy into its bonding curve.</p>
          </div>
          <div className="create-coin-card">
            <span>DEVNET LAUNCH</span>
            <h2>Everything settles on-chain.</h2>
            <p>Your creator wallet signs the launch and, if selected, the initial liquidity buy in one transaction.</p>
            <button className="primary-button" onClick={() => setLaunchOpen(true)}>Open launch builder <ArrowUpRight size={17} /></button>
          </div>
        </section>
      )}

      <section className="hero page-shell" id="home">
        <div className="hero-copy">
          <div className="eyebrow">
            <span className={`live-dot ${featured ? "" : "idle-dot"}`} />
            {featured ? "Live on Solana devnet" : "Solana devnet · no mines launched yet"}
          </div>
          <h1>MEME COINS<br />WORTH <span>DIGGING.</span></h1>
          <p>Launch a fixed-supply coin. Lock a finite reserve. Let the community mine every block with pure, provable power.</p>
          <div className="hero-actions">
            <a className="primary-button" href="/explore">Explore mines <Pickaxe size={18} /></a>
            <a className="text-button" href="/create">Launch yours <ArrowUpRight size={17} /></a>
          </div>
          <div className="trust-row">
            <span><ShieldCheck size={15} /> Mint revoked</span>
            <span><LockKeyhole size={15} /> Reserve locked</span>
            <span><Coins size={15} /> Funds stay in your wallet</span>
          </div>
        </div>

        {!featured ? (
          <div className="mine-console console-empty">
            <div className="console-top">
              <div className="featured-token">
                <span className="token-orb token-orb-large orb-empty"><Pickaxe size={20} /></span>
                <div><span>NO ACTIVE MINE</span><h2>Nothing launched yet</h2></div>
              </div>
              <span className="active-pill idle"><i /> EMPTY</span>
            </div>
            <div className="empty-body">
              <p>
                No token has been launched on this protocol yet, so there is nothing to mine.
                Block rewards, network power and prices will appear here once a real coin is
                launched on devnet.
              </p>
              <button className="primary-button" onClick={() => setLaunchOpen(true)}>
                Launch the first coin <Plus size={17} />
              </button>
            </div>
          </div>
        ) : (
        <div className={`mine-console ${isMiningActive ? "is-mining" : ""}`} id="mine">
          <div className="console-top">
            <div className="featured-token"><TokenOrb symbol={featured.symbol} imageUrl={featured.imageUrl} large /><div><span>{isMiningActive ? "NOW MINING" : "SELECTED MINE"}</span><h2>{featured.name}</h2></div></div>
            <span className={`active-pill ${isMiningActive ? "" : "idle"}`}><i /> {isMiningActive ? "CREW ACTIVE" : player ? "CREW PAUSED" : "NOT ACTIVATED"}</span>
          </div>
          <div className="mine-scene" aria-hidden="true">
            <div className="grid-lines" />
            <div className="ore ore-one" /><div className="ore ore-two" /><div className="ore ore-three" />
            <div className="pickaxe-wrap"><Pickaxe size={82} strokeWidth={1.25} /></div>
            <div className="impact"><span /><span /><span /></div>
            <div className="depth-label">LAYER 0{Math.max(1, Math.round((100 - reservePercent) / 15))}</div>
          </div>
          <div className="block-stats">
            <div><span>NEXT BLOCK</span><strong>{featured.networkPower > 0 ? countdown(featured.nextBlockAt, now) : "AWAITING MINERS"}</strong></div>
            <div><span>BLOCK REWARD</span><strong>{compact(featured.rewardPerBlock)} <small>${featured.symbol}</small></strong></div>
            <div><span>YOUR EST.</span><strong>{estimatedReward.toFixed(2)} <small>${featured.symbol}</small></strong></div>
          </div>
          {player && (
            <div className="crew-strip">
              <span><Flame size={13} /> {player.streak} day streak</span>
              <span><Gem size={13} /> {Math.floor(player.oreBalance).toLocaleString()} ORE</span>
              <span><Gauge size={13} /> {player.power.toLocaleString()} power</span>
              {isMiningActive && (
                <span><Clock3 size={13} /> resets in {countdown(Math.floor((player.activationExpiresAt ?? 0)), now)}</span>
              )}
              {connected?.signer && (
                <button type="button" className="claim-rewards-button" onClick={() => void handleClaimRewards()}>
                  <Coins size={12} /> Claim on-chain rewards
                </button>
              )}
            </div>
          )}
          {activateError && <p className="form-message console-error">{activateError}</p>}
          {!connected ? (
            <button className="mine-button" type="button">
              <Pickaxe size={18} /> Connect wallet to mine
            </button>
          ) : isMiningActive ? (
            <button className="mine-button" onClick={() => setCrewOpen(true)}>
              <Hammer size={18} /> Manage crew
            </button>
          ) : (
            <button className="mine-button" disabled={activating} onClick={() => void handleActivate()}>
              {activating ? <><Radio size={18} /> Activating…</> : <><Pickaxe size={18} /> Activate mine ({GAMEPLAY_DEFAULTS.activationSeconds / 3_600}h)</>}
            </button>
          )}
        </div>
        )}
      </section>

      {page === "mine" && featured && (
        <MiningDashboard
          token={featured}
          player={player}
          now={now}
          isMiningActive={isMiningActive}
          estimatedReward={estimatedReward}
          onManageCrew={() => setCrewOpen(true)}
          onClaim={() => void handleClaimRewards()}
          canClaim={Boolean(connected?.signer)}
        />
      )}

      <DashboardOverview tokens={tokens} player={player} />

      {tokens.length > 0 && (
        <div className="ticker-wrap">
          <div className="ticker">
            {[...tokens, ...tokens].map((token, index) => (
              <span key={`${token.symbol}-${index}`}><b>${token.symbol}</b> {money(token.priceUsd)} <i className={token.change24h >= 0 ? "up" : "down"}>{token.change24h >= 0 ? "+" : ""}{token.change24h}%</i></span>
            ))}
          </div>
        </div>
      )}

      <section className="discover page-shell" id="explore">
        <div className="section-heading">
          <div><div className="eyebrow"><TrendingUp size={14} /> Discovery board</div><h2>FIND YOUR<br />NEXT MINE.</h2></div>
          <div className="filter-tabs"><button className="active">Trending</button><button>New</button><button>Near reduction</button><button>Almost mined</button></div>
        </div>
        {sortedTokens.length ? (
          <>
            <div className="token-grid">
              {sortedTokens.map((token) => <TokenCard key={token.mint} token={token} onSelect={(next) => { window.location.assign(`/mines?mint=${encodeURIComponent(next.mint)}`); }} />)}
            </div>
            <button className="outline-button">View all active mines <ChevronRight size={16} /></button>
          </>
        ) : (
          <div className="board-empty">
            <Pickaxe size={34} />
            <h3>No mines to discover yet</h3>
            <p>Every coin launched through the protocol shows up here with its live price, unmined reserve and network power — straight from the chain, never seeded.</p>
            <button className="primary-button" onClick={() => setLaunchOpen(true)}>Launch a coin <Plus size={17} /></button>
          </div>
        )}
      </section>

      <LeaderboardPanel tokens={tokens} />

      {featured && (
      <section className="selected-mine page-shell" id="mines">
        <div className="selected-heading">
          <div><span className="mono-label">SELECTED MINE // ${featured.symbol}</span><h2>{featured.name}</h2></div>
          <div className="selected-heading-actions">
            {isMiningActive && player?.activeMint !== featured.mint && (
              <button className="outline-button switch-mine-button" onClick={() => void handleSwitchMine(featured.mint)}>
                Switch crew here <Pickaxe size={14} />
              </button>
            )}
            <button className="mint-address" onClick={copyMint}>{shortAddress(featured.mint)} {copied ? <Check size={14} /> : <Copy size={14} />}</button>
          </div>
        </div>
        <div className="selected-grid">
          <div className="reserve-panel">
            <div className="reserve-number"><span>UNMINED SUPPLY</span><strong>{reservePercent.toFixed(1)}%</strong><small>{compact(featured.reserveRemaining)} ${featured.symbol} remain</small></div>
            <div className="shaft"><i style={{ height: `${reservePercent}%` }}><Pickaxe size={28} /></i></div>
          </div>
          <div className="metric-panel"><Gauge /><span>Network power</span><strong>{compact(featured.networkPower)}</strong><small>total crew power on this mine</small></div>
          <div className="metric-panel"><Clock3 /><span>Next reduction</span><strong>{countdown(featured.nextEpochAt, now)}</strong><small>{compact(featured.rewardPerBlock)} → {compact(featured.rewardPerBlock * 0.75)} per block</small></div>
          <div className="metric-panel"><Users /><span>Custody</span><strong>NON-CUSTODIAL</strong><small>only the LP is program-controlled</small></div>
        </div>
      </section>
      )}

      {featured && config.programId && (
        <DiggoSwapPanel
          token={featured}
          programAddress={config.programId}
          signer={connected?.signer ?? null}
          onTraded={() => void refreshFeaturedToken()}
        />
      )}

      <section className="how-section" id="how">
        <div className="page-shell">
          <div className="section-heading light"><div><div className="eyebrow"><HardHat size={14} /> The core loop</div><h2>LAUNCH. DIG.<br />LEVEL UP.</h2></div><p>No inflation. No magic yield. Just a finite, transparent reserve distributed by mining power.</p></div>
          <div className="steps">
            <article><b>01</b><span className="step-icon"><Plus /></span><h3>Launch a coin</h3><p>Fixed supply, revoked authorities, 5% program-locked mining reserve.</p></article>
            <article><b>02</b><span className="step-icon"><Pickaxe /></span><h3>Assign power</h3><p>Pick one active mine. Every block pays your proportional share.</p></article>
            <article><b>03</b><span className="step-icon"><Hammer /></span><h3>Upgrade gear</h3><p>Program rules settle upgrades on-chain. Your wallet stays in control.</p></article>
          </div>
        </div>
      </section>

      <section className="final-cta">
        <div className="page-shell"><span className="huge-pick"><Pickaxe /></span><div><span>THE NEXT MEME IS UNDERGROUND.</span><h2>START DIGGING.</h2></div><button className="primary-button invert" onClick={() => setLaunchOpen(true)}>Launch your coin <ArrowUpRight size={18} /></button></div>
      </section>

      <footer className="site-footer page-shell"><BrandMark /><p>Finite supply. Infinite memes.</p><div><a href="/mines">Mines</a><a href="/">X / Twitter</a></div><small>© 2026 Diggo.fun · Devnet MVP</small></footer>
      {launchOpen && (
        <CreateModal
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
          activeSymbol={featured.symbol}
          onClose={() => setMiningReport(null)}
          onManageCrew={() => { setMiningReport(null); setCrewOpen(true); }}
        />
      )}
      {crewOpen && player && session && (
        <CrewPanel player={player} session={session} onClose={() => setCrewOpen(false)} onUpdate={setPlayer} />
      )}
    </main>
  );
}
