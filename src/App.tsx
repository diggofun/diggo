import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
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
  Database,
  Gauge,
  Hammer,
  HardHat,
  LockKeyhole,
  Pickaxe,
  Plus,
  Radio,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Users,
  X,
  Zap,
} from "lucide-react";

import type { LaunchRequest, TokenSummary } from "../shared/types";
import { getBootstrap, getChallenge, queueLaunch, uploadTokenImage, verifyWallet } from "./api";
import { track } from "./analytics";
import { TokenOrb } from "./components/TokenOrb";
import { TurnstileBox } from "./components/TurnstileBox";
import { solanaClient } from "./solana";

const TURNSTILE_SITE_KEY = "0x4AAAAAAEzwvf6nnwXvXdMc";

function compact(value: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function money(value: number): string {
  if (value < 0.01) return `$${value.toFixed(5)}`;
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
    <a className="brand" href="#top" aria-label="Diggo.fun home">
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
          <small>Phantom, Solflare, Backpack and other Wallet Standard wallets work without a paid connector.</small>
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
}: {
  onClose(): void;
  session: string | null;
  onAuthenticated(session: string): void;
}) {
  const connected = useConnectedWallet(solanaClient);
  const signMessage = useSignMessage(solanaClient);
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
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
    if (!connected) {
      setMessage("Connect your wallet before launching.");
      return;
    }
    setState("working");
    setMessage("Requesting a wallet signature…");
    try {
      const activeSession = session ?? await authenticate();
      setMessage(file ? "Uploading artwork…" : "Preparing your launch…");
      const imageUrl = file ? await uploadTokenImage(file, activeSession) : undefined;
      const launch: LaunchRequest = {
        name,
        symbol: symbol.toUpperCase(),
        description,
        creator: String(connected.account.address),
        imageUrl,
        turnstileToken,
      };
      const result = await queueLaunch(launch, activeSession);
      track("launch_submitted", { has_artwork: Boolean(file), network: "solana-devnet" });
      setMessage(`${result.message} Job ${result.id.slice(0, 8)} is queued.`);
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
        <p className="modal-intro">Every Diggo mint gets fixed supply, a program-locked 5% mining reserve, and a contract address ending in <b>diggo</b>. Diggo never holds user funds.</p>
        {state === "done" ? (
          <div className="success-panel">
            <span><Check size={28} /></span>
            <h3>We’re digging your address.</h3>
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
            <label className="file-input">
              <span>Token artwork</span>
              <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
              <i>{file ? file.name : "PNG, JPG or WEBP · max 2 MB"}</i>
            </label>
            <div className="launch-allocation">
              <span>95% user-held launch supply</span><span>5% locked mining reserve</span><span>0% platform custody</span>
            </div>
            <TurnstileBox siteKey={TURNSTILE_SITE_KEY} onToken={onTurnstileToken} />
            {message && <p className="form-message">{message}</p>}
            <button className="primary-button launch-submit" disabled={state === "working" || !turnstileToken}>
              {state === "working" ? "Digging…" : "Create launch job"} <Pickaxe size={17} />
            </button>
          </form>
        )}
      </section>
    </div>
  );
}

export default function App() {
  const [tokens, setTokens] = useState<TokenSummary[]>([]);
  const [selected, setSelected] = useState<TokenSummary | null>(null);
  const [now, setNow] = useState(Date.now());
  const [mining, setMining] = useState(false);
  const [launchOpen, setLaunchOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [session, setSession] = useState<string | null>(null);

  useEffect(() => {
    getBootstrap().then((result) => {
      setTokens(result);
      setSelected(result[0]);
    });
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const featured = selected ?? tokens[0];
  const reservePercent = featured ? (featured.reserveRemaining / featured.reserveTotal) * 100 : 0;
  const estimatedReward = featured ? (4_000 / featured.networkPower) * featured.rewardPerBlock : 0;
  const sortedTokens = useMemo(() => [...tokens].sort((a, b) => b.change24h - a.change24h), [tokens]);

  function copyMint() {
    if (!featured) return;
    navigator.clipboard.writeText(featured.mint).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_400);
    });
  }

  if (!featured) return <div className="loading-screen"><Pickaxe /> DIGGING UP THE DATA…</div>;

  return (
    <main id="top">
      <header className="site-header">
        <BrandMark />
        <nav aria-label="Main navigation">
          <a href="#mines">Mines</a><a href="#how">How it works</a><a href="#protocol">Protocol</a>
        </nav>
        <div className="header-actions">
          <button className="launch-button" onClick={() => setLaunchOpen(true)}><Plus size={16} /> Launch coin</button>
          <WalletControl session={session} onAuthenticated={setSession} />
        </div>
      </header>

      <section className="hero page-shell">
        <div className="hero-copy">
          <div className="eyebrow"><span className="live-dot" /> Live on Solana devnet</div>
          <h1>MEME COINS<br />WORTH <span>DIGGING.</span></h1>
          <p>Launch a fixed-supply coin. Lock a finite reserve. Let the community mine every block with pure, provable power.</p>
          <div className="hero-actions">
            <button className="primary-button" onClick={() => document.getElementById("mines")?.scrollIntoView({ behavior: "smooth" })}>Explore mines <Pickaxe size={18} /></button>
            <button className="text-button" onClick={() => setLaunchOpen(true)}>Launch yours <ArrowUpRight size={17} /></button>
          </div>
          <div className="trust-row">
            <span><ShieldCheck size={15} /> Mint revoked</span>
            <span><LockKeyhole size={15} /> Reserve locked</span>
            <span><Coins size={15} /> Funds stay in your wallet</span>
          </div>
        </div>

        <div className={`mine-console ${mining ? "is-mining" : ""}`}>
          <div className="console-top">
            <div className="featured-token"><TokenOrb symbol={featured.symbol} imageUrl={featured.imageUrl} large /><div><span>NOW MINING</span><h2>{featured.name}</h2></div></div>
            <span className="active-pill"><i /> ACTIVE</span>
          </div>
          <div className="mine-scene" aria-hidden="true">
            <div className="grid-lines" />
            <div className="ore ore-one" /><div className="ore ore-two" /><div className="ore ore-three" />
            <div className="pickaxe-wrap"><Pickaxe size={82} strokeWidth={1.25} /></div>
            <div className="impact"><span /><span /><span /></div>
            <div className="depth-label">LAYER 0{Math.max(1, Math.round((100 - reservePercent) / 15))}</div>
          </div>
          <div className="block-stats">
            <div><span>NEXT BLOCK</span><strong>{countdown(featured.nextBlockAt, now)}</strong></div>
            <div><span>BLOCK REWARD</span><strong>{compact(featured.rewardPerBlock)} <small>${featured.symbol}</small></strong></div>
            <div><span>YOUR EST.</span><strong>{estimatedReward.toFixed(2)} <small>${featured.symbol}</small></strong></div>
          </div>
          <button className="mine-button" onClick={() => setMining((value) => !value)}>
            {mining ? <><Radio size={18} /> Mining in progress…</> : <><Pickaxe size={18} /> Start mining</>}
          </button>
        </div>
      </section>

      <div className="ticker-wrap">
        <div className="ticker">
          {[...tokens, ...tokens].map((token, index) => (
            <span key={`${token.symbol}-${index}`}><b>${token.symbol}</b> {money(token.priceUsd)} <i className={token.change24h >= 0 ? "up" : "down"}>{token.change24h >= 0 ? "+" : ""}{token.change24h}%</i></span>
          ))}
        </div>
      </div>

      <section className="discover page-shell" id="mines">
        <div className="section-heading">
          <div><div className="eyebrow"><TrendingUp size={14} /> Discovery board</div><h2>FIND YOUR<br />NEXT MINE.</h2></div>
          <div className="filter-tabs"><button className="active">Trending</button><button>New</button><button>Near reduction</button><button>Almost mined</button></div>
        </div>
        <div className="token-grid">
          {sortedTokens.map((token) => <TokenCard key={token.mint} token={token} onSelect={(next) => { setSelected(next); window.scrollTo({ top: 0, behavior: "smooth" }); }} />)}
        </div>
        <button className="outline-button">View all active mines <ChevronRight size={16} /></button>
      </section>

      <section className="selected-mine page-shell">
        <div className="selected-heading">
          <div><span className="mono-label">SELECTED MINE // ${featured.symbol}</span><h2>{featured.name}</h2></div>
          <button className="mint-address" onClick={copyMint}>{shortAddress(featured.mint)} {copied ? <Check size={14} /> : <Copy size={14} />}</button>
        </div>
        <div className="selected-grid">
          <div className="reserve-panel">
            <div className="reserve-number"><span>UNMINED SUPPLY</span><strong>{reservePercent.toFixed(1)}%</strong><small>{compact(featured.reserveRemaining)} ${featured.symbol} remain</small></div>
            <div className="shaft"><i style={{ height: `${reservePercent}%` }}><Pickaxe size={28} /></i></div>
          </div>
          <div className="metric-panel"><Gauge /><span>Network power</span><strong>{compact(featured.networkPower)}</strong><small>across 12,842 miners</small></div>
          <div className="metric-panel"><Clock3 /><span>Next reduction</span><strong>{countdown(featured.nextEpochAt, now)}</strong><small>{compact(featured.rewardPerBlock)} → {compact(featured.rewardPerBlock * 0.75)} per block</small></div>
          <div className="metric-panel"><Users /><span>Custody</span><strong>NON-CUSTODIAL</strong><small>only the LP is program-controlled</small></div>
        </div>
      </section>

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

      <section className="protocol page-shell" id="protocol">
          <div className="protocol-copy"><div className="eyebrow"><Database size={14} /> Built in the open</div><h2>THE BACKEND<br />CAN’T TOUCH<br />YOUR ORE.</h2><p>Funds remain in user wallets. Only program-controlled liquidity and the mining reserve leave a wallet, under immutable Solana rules.</p><a href="/ARCHITECTURE.md" target="_blank" rel="noreferrer">Read the architecture <ArrowUpRight size={16} /></a></div>
        <div className="stack-map">
          <span className="map-label">DIGGO EDGE STACK</span>
          <div className="stack-node main-node"><Zap /> Cloudflare Worker<small>API + static assets</small></div>
          <div className="stack-node"><Database /> D1<small>index + history</small></div>
          <div className="stack-node"><Radio /> Durable Objects<small>live markets</small></div>
          <div className="stack-node"><Coins /> KV + Supabase Storage<small>cache + media</small></div>
          <div className="stack-node"><ShieldCheck /> Turnstile + WAF<small>launch protection</small></div>
          <div className="stack-footer"><span>Helius</span><i /> <span>Queues</span><i /> <span>Workflows</span><i /> <span>Solana</span></div>
        </div>
      </section>

      <section className="final-cta">
        <div className="page-shell"><span className="huge-pick"><Pickaxe /></span><div><span>THE NEXT MEME IS UNDERGROUND.</span><h2>START DIGGING.</h2></div><button className="primary-button invert" onClick={() => setLaunchOpen(true)}>Launch your coin <ArrowUpRight size={18} /></button></div>
      </section>

      <footer className="site-footer page-shell"><BrandMark /><p>Finite supply. Infinite memes.</p><div><a href="#protocol">Docs</a><a href="#mines">Mines</a><a href="#top">X / Twitter</a></div><small>© 2026 Diggo.fun · Devnet MVP</small></footer>
      {launchOpen && <CreateModal onClose={() => setLaunchOpen(false)} session={session} onAuthenticated={setSession} />}
    </main>
  );
}
