/**
 * Launch builder (spec 79). A real on-chain launch signed by the creator wallet: fixed supply,
 * program-locked mining and discovery reserves, optional atomic creator buy. Loaded lazily so the
 * Solana program client only ships to players who open it.
 */
import { type FormEvent, useCallback, useState } from "react";
import bs58 from "bs58";
import { Check, Pickaxe, Sparkles, X } from "lucide-react";
import type { TokenSummary } from "../../shared/types";
import { getChallenge, registerLaunchedToken, uploadTokenImage, verifyWallet, type DiggoConfig } from "../api";
import { track } from "../analytics";
import { TURNSTILE_SITE_KEY } from "../constants";
import { address, fetchProtocolConfig, launchCoinOnChain } from "../solanaProgram";
import { useDiggoWallet } from "../wallet";
import { TurnstileBox } from "./TurnstileBox";
import { useDialog } from "./useDialog";

export function LaunchModal({
  onClose,
  session,
  onAuthenticated,
  config,
  onLaunched,
}: {
  onClose(): void;
  session: string | null;
  onAuthenticated(wallet: string): void;
  config: DiggoConfig;
  onLaunched(token: TokenSummary): void;
}) {
  const connected = useDiggoWallet();
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [initialBuy, setInitialBuy] = useState("0");
  const [file, setFile] = useState<File | null>(null);
  const [turnstileToken, setTurnstileToken] = useState("");
  const [state, setState] = useState<"idle" | "working" | "done">("idle");
  const [message, setMessage] = useState("");
  const [recoveryMint, setRecoveryMint] = useState("");
  const [recoveryMessage, setRecoveryMessage] = useState("");
  const [recovering, setRecovering] = useState(false);
  const dialogRef = useDialog<HTMLElement>(onClose);
  const onTurnstileToken = useCallback((token: string) => setTurnstileToken(token), []);

  async function authenticate(): Promise<void> {
    if (!connected) throw new Error("Connect a wallet that supports message signing");
    const challenge = await getChallenge(connected.address);
    const signature = await connected.signMessage(new TextEncoder().encode(challenge.message));
    const verified = await verifyWallet(connected.address, challenge.nonce, bs58.encode(signature));
    onAuthenticated(verified.wallet);
    track("wallet_signed_in", { network: "solana-devnet" });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!connected) {
      setMessage("Connect a wallet that can sign transactions before launching.");
      return;
    }
    setState("working");
    try {
      if (session !== connected.address) await authenticate();
      setMessage(file ? "Uploading artwork…" : "Preparing your launch…");
      const imageUrl = file ? await uploadTokenImage(file) : undefined;

      setMessage("Reading protocol configuration from chain…");
      const programAddress = address(config.programId);
      const protocol = await fetchProtocolConfig(programAddress);
      if (!protocol) throw new Error("Protocol is not initialized on-chain yet");

      setMessage("Waiting for your wallet signature to launch on-chain…");
      const launch = await launchCoinOnChain(
        programAddress,
        connected.wallet,
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
      const token = await registerLaunchedToken(launch.mint, { description, imageUrl });
      onLaunched(token);
      setMessage(`Live on-chain at ${launch.mint.slice(0, 4)}…${launch.mint.slice(-4)}. Signature ${launch.signature.slice(0, 8)}…`);
      setState("done");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Launch failed");
      setState("idle");
    }
  }

  async function recoverLaunch(event: FormEvent) {
    event.preventDefault();
    if (!connected) {
      setRecoveryMessage("Connect the creator wallet before recovering this launch.");
      return;
    }
    setRecovering(true);
    setRecoveryMessage("");
    try {
      if (session !== connected.address) await authenticate();
      const token = await registerLaunchedToken(recoveryMint.trim(), {});
      onLaunched(token);
      setRecoveryMessage(`${token.symbol} is now indexed and live in Diggo.`);
      track("launch_recovered", { network: "solana-devnet" });
    } catch (error) {
      setRecoveryMessage(error instanceof Error ? error.message : "Could not recover this launch");
    } finally {
      setRecovering(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section ref={dialogRef} className="launch-modal" role="dialog" aria-modal="true" aria-labelledby="launch-title" onMouseDown={(event) => event.stopPropagation()}>
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
          <>
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
          <details className="recover-launch">
            <summary>Already signed a launch but it did not appear?</summary>
            <p>Paste its mint address. Diggo verifies that the connected wallet is the on-chain creator before indexing it.</p>
            <form onSubmit={recoverLaunch}>
              <input required value={recoveryMint} onChange={(event) => setRecoveryMint(event.target.value)} placeholder="Solana mint address" />
              <button className="outline-button" disabled={recovering}>{recovering ? "Verifying…" : "Recover on-chain launch"}</button>
            </form>
            {recoveryMessage && <p className="form-message">{recoveryMessage}</p>}
          </details>
          </>
        )}
      </section>
    </div>
  );
}
