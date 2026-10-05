/**
 * Boost a mine: pay SOL to list it first with a badge and send it more crews for a while
 * (shared/boost.ts). Anyone can boost any open mine, not only its creator.
 */
import { useState } from "react";
import { createPortal } from "react-dom";
import { confirmBoost, prepareBoost, type PreparedClaimBatch } from "../api";
import { track } from "../analytics";
import { BOOST_TIERS, BOOST_WEIGHT, solLabel, type BoostTier } from "../../shared/boost";
import { IconClose } from "../icons";
import { signPreparedClaim } from "../onchain/preparedClaim";
import { useDiggoWallet } from "../wallet";
import { untilConfirmed, withWalletSession } from "../walletSession";
import { useDialog } from "./useDialog";

export function BoostModal({ mint, symbol, onClose, onBoosted }: { mint: string; symbol: string; onClose(): void; onBoosted?(): void }) {
  const dialogRef = useDialog<HTMLElement>(onClose);
  const connected = useDiggoWallet();
  const [tier, setTier] = useState<BoostTier>(BOOST_TIERS[1]!);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const [done, setDone] = useState(false);

  async function pay(): Promise<void> {
    if (!connected) {
      setFailed(true);
      setMessage("Connect your wallet first.");
      return;
    }
    setBusy(true);
    setFailed(false);
    try {
      setMessage("Preparing the payment…");
      const prepared = await withWalletSession(connected, () => prepareBoost(mint, tier.id), () => setMessage("Sign the message in your wallet to continue…"));
      setMessage("Approve the payment in your wallet…");
      const payout = { id: "boost", transaction: prepared.transaction, expiresAt: String(prepared.expiresAt) } as PreparedClaimBatch;
      const sent = await signPreparedClaim({ wallet: connected.wallet, payout, nowSeconds: Math.floor(Date.now() / 1_000) });
      setMessage("Waiting for the payment to confirm…");
      const result = await untilConfirmed(() => withWalletSession(connected, () => confirmBoost(sent.signature, mint, tier.id)));
      track("mine_boosted", { mint, tier: tier.id });
      setDone(true);
      setMessage(`$${symbol} is boosted until ${new Date(result.endsAt * 1000).toLocaleString()}.`);
      onBoosted?.();
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : "The boost did not go through.");
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section ref={dialogRef} className="launch-modal boost-modal" role="dialog" aria-modal="true" aria-labelledby="boost-title" onMouseDown={(event) => event.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close"><IconClose size={20} /></button>
        <h2 id="boost-title">Boost ${symbol}</h2>
        <p className="modal-intro">
          A boosted mine is listed first with a Boosted badge and is {BOOST_WEIGHT}× as likely to get new crews. Boosting again adds time on top.
        </p>
        {!done && (
          <>
            <div className="boost-tiers" role="radiogroup" aria-label="Boost length">
              {BOOST_TIERS.map((option) => (
                <button key={option.id} type="button" role="radio" aria-checked={tier.id === option.id} className={"boost-tier" + (tier.id === option.id ? " active" : "")} onClick={() => setTier(option)}>
                  <strong>{option.label}</strong>
                  <span>{solLabel(option.lamports)}</span>
                </button>
              ))}
            </div>
            <button className="btn btn-primary btn-lg" type="button" disabled={busy || !connected} onClick={() => void pay()}>
              {busy ? "Working…" : connected ? `Boost for ${solLabel(tier.lamports)}` : "Connect your wallet first"}
            </button>
            <p className="form-hint">Paid in SOL to Diggo, plus the network fee. Boosts are not refundable.</p>
          </>
        )}
        {message && <p className={"form-message" + (failed ? " admin-job-error" : "")} role="status">{message}</p>}
      </section>
    </div>,
    document.body,
  );
}
