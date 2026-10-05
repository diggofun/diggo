/**
 * "Add your coin": anyone can turn tokens of a coin that already exists into a mine.
 *
 * 1. The Worker prepares a transfer of the chosen amount from this wallet into the mining vault.
 * 2. The wallet signs and sends it; the player pays only the network fee.
 * 3. The Worker reads the confirmed transfer and opens the mine with exactly that reserve.
 * A sent deposit is remembered in this browser, so a closed tab can still finish step 3.
 */
import { type FormEvent, useState } from "react";
import { createPortal } from "react-dom";
import bs58 from "bs58";
import { ApiError, createProjectMine, getChallenge, prepareMineDeposit, verifyWallet, type PreparedClaimBatch, type ProjectMineDetails } from "../api";
import { MINING_PERIOD_PRESETS } from "../../shared/miningSchedule";
import { IconClose } from "../icons";
import { signPreparedClaim } from "../onchain/preparedClaim";
import { useDiggoWallet } from "../wallet";
import { useDialog } from "./useDialog";

const PENDING_KEY = "diggo:pending-mine";

function readPending(): ProjectMineDetails | null {
  try {
    const value = JSON.parse(localStorage.getItem(PENDING_KEY) ?? "null") as ProjectMineDetails | null;
    return value && typeof value.signature === "string" ? value : null;
  } catch {
    return null;
  }
}

function writePending(value: ProjectMineDetails | null): void {
  try {
    if (value) localStorage.setItem(PENDING_KEY, JSON.stringify(value));
    else localStorage.removeItem(PENDING_KEY);
  } catch {
    // Private mode: the deposit still finishes in this session.
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function AddCoinModal({ onClose, onAdded }: { onClose(): void; onAdded(): void }) {
  const dialogRef = useDialog<HTMLElement>(onClose);
  const connected = useDiggoWallet();
  const [pending, setPending] = useState<ProjectMineDetails | null>(readPending);
  const [form, setForm] = useState({ mint: "", symbol: "", name: "", amount: "", days: 30, sponsor: "", sponsorUrl: "" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => setForm((current) => ({ ...current, [key]: event.target.value }));

  async function signIn(): Promise<void> {
    if (!connected) throw new Error("Connect your wallet first");
    const challenge = await getChallenge(connected.address);
    const signature = await connected.signMessage(new TextEncoder().encode(challenge.message));
    await verifyWallet(connected.address, challenge.nonce, bs58.encode(signature), null);
  }

  /** Runs a request, signing in once if the session is missing. */
  async function withSession<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
      setMessage("Sign the message in your wallet to continue…");
      await signIn();
      return action();
    }
  }

  async function finish(details: ProjectMineDetails): Promise<void> {
    setMessage("Waiting for the deposit to confirm…");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await withSession(() => createProjectMine(details));
        writePending(null);
        setPending(null);
        setFailed(false);
        setMessage(`$${details.symbol.toUpperCase()} is now a mine. Bots start digging it right away.`);
        onAdded();
        return;
      } catch (error) {
        if (error instanceof ApiError && error.status === 425) {
          await wait(3_000);
          continue;
        }
        throw error;
      }
    }
    throw new Error("The deposit is taking long to confirm. Open this window again later to finish.");
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!connected) {
      setFailed(true);
      setMessage("Connect your wallet first.");
      return;
    }
    setBusy(true);
    setFailed(false);
    try {
      setMessage("Preparing the deposit…");
      const mint = form.mint.trim();
      const prepared = await withSession(() => prepareMineDeposit(mint, form.amount.trim()));
      setMessage("Approve the deposit in your wallet…");
      const payout = { id: "deposit", transaction: prepared.transaction, expiresAt: String(prepared.expiresAt) } as PreparedClaimBatch;
      const sent = await signPreparedClaim({ wallet: connected.wallet, payout, nowSeconds: Math.floor(Date.now() / 1_000) });
      const details: ProjectMineDetails = {
        signature: sent.signature,
        mint,
        symbol: form.symbol.trim(),
        name: form.name.trim(),
        days: Number(form.days),
        ...(form.sponsor.trim() ? { sponsor: form.sponsor.trim() } : {}),
        ...(form.sponsorUrl.trim() ? { sponsorUrl: form.sponsorUrl.trim() } : {}),
      };
      // Remember it before anything else can fail: the tokens are already on their way.
      writePending(details);
      setPending(details);
      await finish(details);
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : "Could not add this coin.");
    } finally {
      setBusy(false);
    }
  }

  async function resume(): Promise<void> {
    if (!pending) return;
    setBusy(true);
    setFailed(false);
    try {
      await finish(pending);
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : "Could not finish adding this coin.");
    } finally {
      setBusy(false);
    }
  }

  // Portalled to <body>: the button lives inside a page section whose stacking context would
  // otherwise paint the page over the dialog.
  return createPortal(
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section ref={dialogRef} className="launch-modal" role="dialog" aria-modal="true" aria-labelledby="add-coin-title" onMouseDown={(event) => event.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close"><IconClose size={20} /></button>
        <h2 id="add-coin-title">Add your coin</h2>
        <p className="modal-intro">
          Put tokens of a coin you already hold into a mine. Diggo bots dig it and players get paid out in your coin,
          which brings your coin new holders. The tokens you deposit are what gets mined; you can't take them back.
        </p>
        {pending ? (
          <div className="add-coin-pending">
            <p>Your deposit of <strong>${pending.symbol.toUpperCase()}</strong> was sent. Finish opening the mine:</p>
            <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void resume()}>{busy ? "Working…" : "Finish adding"}</button>
          </div>
        ) : (
          <form onSubmit={(event) => void submit(event)}>
            <label>Coin mint address<input required value={form.mint} onChange={set("mint")} placeholder="e.g. DezX…B263" autoComplete="off" /></label>
            <div className="form-grid">
              <label>Ticker<input required maxLength={12} value={form.symbol} onChange={(event) => setForm((current) => ({ ...current, symbol: event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") }))} placeholder="BONK" /></label>
              <label>Name<input required maxLength={40} value={form.name} onChange={set("name")} placeholder="Bonk" /></label>
            </div>
            <div className="form-grid">
              <label>Tokens to put in the mine<input required inputMode="numeric" value={form.amount} onChange={(event) => setForm((current) => ({ ...current, amount: event.target.value.replace(/[^0-9]/g, "") }))} placeholder="1000000" /></label>
              <label>Mining period
                <select value={form.days} onChange={(event) => setForm((current) => ({ ...current, days: Number(event.target.value) }))}>
                  {MINING_PERIOD_PRESETS.map((preset) => <option key={preset.days} value={preset.days}>{preset.label}</option>)}
                </select>
              </label>
            </div>
            <div className="form-grid">
              <label>Created by<input maxLength={40} value={form.sponsor} onChange={set("sponsor")} placeholder="Your project (optional)" /></label>
              <label>Link<input value={form.sponsorUrl} onChange={set("sponsorUrl")} placeholder="https://x.com/… (optional)" /></label>
            </div>
            <p className="form-hint">Classic SPL tokens only (pump.fun coins work). One mine per coin. You pay only the network fee.</p>
            <button className="btn btn-primary btn-lg" type="submit" disabled={busy || !connected}>{busy ? "Working…" : connected ? "Deposit and create mine" : "Connect your wallet first"}</button>
          </form>
        )}
        {message && <p className={"form-message" + (failed ? " admin-job-error" : "")} role="status">{message}</p>}
      </section>
    </div>,
    document.body,
  );
}
