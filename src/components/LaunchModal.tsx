/**
 * Launch builder (spec 79). A real on-chain launch signed by the creator wallet with a fixed supply
 * and chain-specific mining allocation. Loaded lazily so the Solana launch clients only ship to
 * players who open it.
 *
 * An active LaunchRentSubsidy sponsor event can pay this launch's rent, and when one covers it the
 * subsidy is resolved on chain immediately before the creator signs. Sponsorship can pay rent and
 * fees and nothing else — it cannot touch power, rewards, discovery odds, rarity, caps or
 * eligibility.
 */
import { type FormEvent, useCallback, useEffect, useState } from "react";
import bs58 from "bs58";
import { IconClose, IconRocket } from "../icons";
import type { TokenSummary } from "../../shared/types";
import {
  getChallenge,
  getBootstrap,
  getSponsorEvents,
  registerLaunchedToken,
  registerMeteoraPool,
  uploadTokenImage,
  verifyWallet,
  type DiggoConfig,
} from "../api";
import { track } from "../analytics";
import {
  LAUNCH_DISCOVERY_RESERVE_BPS,
  LAUNCH_RESERVE_BPS,
  TURNSTILE_SITE_KEY,
} from "../constants";
import {
  DEFAULT_CREATOR_FEE_BPS,
  DEFAULT_CURVE_MINING_BPS,
  DEFAULT_CURVE_MINING_RUNWAY_DAYS,
  DEFAULT_PLATFORM_FEE_BPS,
  MAX_NAME_LEN,
  MAX_SYMBOL_LEN,
  address,
  fetchProtocolConfig,
  fetchSponsorEvent,
  findLaunchSubsidy,
  launchCoin,
  resolveSubsidy,
  type SponsorEventView,
} from "../solanaProgram";
import { useDiggoWallet } from "../wallet";
import { TurnstileBox } from "./TurnstileBox";
import { useDialog } from "./useDialog";
import { usePendingTransaction } from "../onchain";
import { launchMeteoraCoin } from "../meteora";
import { isMeteoraConfigPubkey } from "../../shared/meteora";

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
  const pendingTransaction = usePendingTransaction();
  /**
   * The sponsor event that would pay this launch's rent, if one is active right now. It is read
   * on chain, not taken from the indexer's row, because the program is the authority on whether an
   * event is spending.
   */
  const [sponsor, setSponsor] = useState<SponsorEventView | null>(null);
  const dialogRef = useDialog<HTMLElement>(onClose);
  const onTurnstileToken = useCallback((token: string) => setTurnstileToken(token), []);

  useEffect(() => {
    if (config.chainMode === "meteora" || !config.programId) return;
    let cancelled = false;
    void (async () => {
      try {
        const programAddress = address(config.programId);
        const summaries = await getSponsorEvents();
        const views = (
          await Promise.all(
            summaries.map(async (summary) => {
              const decoded = await fetchSponsorEvent(
                programAddress,
                address(summary.vault),
                summary.eventId,
              );
              return decoded
                ? {
                    eventId: summary.eventId,
                    address: address(summary.event),
                    vault: address(summary.vault),
                    decoded,
                  }
                : null;
            }),
          )
        ).filter((view): view is SponsorEventView => view !== null);
        if (!cancelled) setSponsor(findLaunchSubsidy(views, Math.floor(Date.now() / 1000)));
      } catch {
        // An unreachable indexer means "the creator pays", which is the honest default.
        if (!cancelled) setSponsor(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [config.programId]);

  const launchReady = config.chainMode === "native" || isMeteoraConfigPubkey(config.meteoraConfigPubkey);

  async function authenticate(): Promise<void> {
    if (!connected) throw new Error("Connect a wallet that supports message signing");
    const challenge = await getChallenge(connected.address);
    const signature = await connected.signMessage(new TextEncoder().encode(challenge.message));
    const referralCode = new URLSearchParams(window.location.search).get("ref");
    const verified = await verifyWallet(connected.address, challenge.nonce, bs58.encode(signature), referralCode);
    onAuthenticated(verified.wallet);
    track("wallet_signed_in", { network: config.cluster });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!launchReady) {
      setMessage("Launch availability is not confirmed for this environment.");
      return;
    }
    if (!connected) {
      setMessage("Connect a wallet that can sign transactions before launching.");
      return;
    }
    if (!pendingTransaction.canSubmit()) return;
    setState("working");
    try {
      if (session !== connected.address) await authenticate();
      setMessage(file ? "Uploading artwork…" : "Preparing your launch…");
      const imageUrl = file ? await uploadTokenImage(file) : undefined;

      if (config.chainMode === "meteora") {
        setMessage("Preparing the Meteora bonding-curve launch…");
        const launch = await launchMeteoraCoin({
          wallet: connected.wallet,
          name,
          symbol: symbol.toUpperCase(),
          metadataUri: imageUrl ?? "",
          configPubkey: config.meteoraConfigPubkey,
          initialBuySol: Math.max(0, Number(initialBuy) || 0),
        });
        track("launch_submitted", { has_artwork: Boolean(file), sponsored: false, network: config.cluster });
        const registration = await registerMeteoraPool(launch.pool);
        setMessage("Registering your launch…");
        const bootstrap = await getBootstrap();
        const token = bootstrap.tokens.find((candidate) => candidate.mint === registration.mint);
        if (!token) throw new Error("Meteora launch was verified but is not visible yet; retry in a moment");
        onLaunched(token);
        setMessage(`Live on ${config.cluster} at ${launch.mint.slice(0, 4)}…${launch.mint.slice(-4)}. Signature ${launch.signature.slice(0, 8)}…`);
        setState("done");
        return;
      }

      setMessage("Reading protocol configuration from chain…");
      const programAddress = address(config.programId);
      const protocol = await fetchProtocolConfig(programAddress);
      if (!protocol) throw new Error("Protocol is not initialized on-chain yet");

      // The subsidy is resolved immediately before signing rather than from the mount-time read:
      // an event that ended in the meantime would otherwise be promised and not paid.
      const subsidy = sponsor
        ? await resolveSubsidy(
            programAddress,
            sponsor.address,
            sponsor.vault,
            address(connected.address),
          )
        : null;

      setMessage("Waiting for your wallet signature to launch on-chain…");
      const launch = await launchCoin({
        programAddress,
        wallet: connected.wallet,
        subsidy,
        input: {
          name,
          symbol: symbol.toUpperCase(),
          uri: imageUrl ?? "",
          decimals: 6,
          totalSupplyWhole: 1_000_000_000,
          reserveBps: LAUNCH_RESERVE_BPS,
          discoveryReserveBps: LAUNCH_DISCOVERY_RESERVE_BPS,
          curveMiningBps: DEFAULT_CURVE_MINING_BPS,
          curveMiningRunwayDays: DEFAULT_CURVE_MINING_RUNWAY_DAYS,
          graduationTargetSol: 5,
          blockIntervalSeconds: 300,
          epochLengthSeconds: 604_800,
          reductionBps: 2_500,
          minimumRewardWhole: 1,
          // The fee schedule is snapshotted into the coin at launch, so the form sends the
          // protocol's current defaults rather than letting the program pick them silently.
          creatorFeeBps: protocol.creatorFeeBps || DEFAULT_CREATOR_FEE_BPS,
          platformFeeBps: protocol.platformFeeBps || DEFAULT_PLATFORM_FEE_BPS,
          initialBuySol: Math.max(0, Number(initialBuy) || 0),
        },
      });
      track("launch_submitted", {
        has_artwork: Boolean(file),
        sponsored: launch.sponsored,
        network: config.cluster,
      });

      setMessage("Registering your launch…");
      const token = await registerLaunchedToken(launch.mint, { description, imageUrl });
      onLaunched(token);
      setMessage(`Live on-chain at ${launch.mint.slice(0, 4)}…${launch.mint.slice(-4)}. Signature ${launch.signature.slice(0, 8)}…`);
      setState("done");
    } catch (error) {
      if (pendingTransaction.record(error, "Launch")) {
        setMessage("Launch submitted but confirmation is pending. Check the signature before retrying.");
        setState("idle");
      } else {
        setMessage(error instanceof Error ? error.message : "Launch failed");
        setState("idle");
      }
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
      track("launch_recovered", { network: config.cluster });
    } catch (error) {
      setRecoveryMessage(error instanceof Error ? error.message : "Could not recover this launch");
    } finally {
      setRecovering(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section ref={dialogRef} className="launch-modal" role="dialog" aria-modal="true" aria-labelledby="launch-title" onMouseDown={(event) => event.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close"><IconClose size={20} /></button>
        <div className="eyebrow">Launch on Diggo</div>
        <h2 id="launch-title">Launch a coin<br />players can mine.</h2>
        <p className="modal-intro">
          {config.chainMode === "meteora"
            ? "Create a fixed-supply coin with a wallet-signed Meteora launch. This launch configuration sets the creator trading fee to 0%. Leftover supply is held in the Diggo-signed mining vault for eligible player payouts. Mining rewards and yield are not guaranteed."
            : "Set a fixed supply and chain-specific mining allocation, then create the coin with a wallet-signed transaction. Diggo never holds user funds."}
        </p>
        {state === "done" ? (
          <div className="success-panel">
            <span>Live</span>
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
              <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
              <i>{file ? file.name : "PNG, JPG or WEBP · max 2 MB"}</i>
            </label>
            <TurnstileBox siteKey={TURNSTILE_SITE_KEY} onToken={onTurnstileToken} />
            {message && <p className="form-message">{message}</p>}
            <button className="primary-button launch-submit" disabled={!launchReady || state === "working" || !turnstileToken || !pendingTransaction.canSubmit()}>
              {!launchReady ? "Launch unavailable" : state === "working" ? "Launching on-chain…" : "Launch on-chain"} <IconRocket size={17} />
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
