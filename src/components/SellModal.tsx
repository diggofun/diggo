/**
 * Sell a mined coin for SOL. The Worker gets a Jupiter quote (with Diggo's small platform fee) and
 * builds the swap; the wallet signs it here and sends it.
 */
import { useState } from "react";
import { createPortal } from "react-dom";
import { buildSwap, getSwapQuote, type PreparedClaimBatch, type SwapQuoteView } from "../api";
import { track } from "../analytics";
import { IconClose } from "../icons";
import { signPreparedClaim } from "../onchain/preparedClaim";
import { useDiggoWallet } from "../wallet";
import { withWalletSession } from "../walletSession";
import { feeLabel } from "../../shared/projectMineFee";
import { useDialog } from "./useDialog";

function sol(lamports: string): string {
  return (Number(lamports) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 6 });
}

export function SellModal({ mint, symbol, onClose }: { mint: string; symbol: string; onClose(): void }) {
  const dialogRef = useDialog<HTMLElement>(onClose);
  const connected = useDiggoWallet();
  const [amount, setAmount] = useState("max");
  const [quote, setQuote] = useState<SwapQuoteView | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const [signature, setSignature] = useState("");

  async function getQuote(): Promise<void> {
    setBusy(true);
    setFailed(false);
    setMessage("");
    try {
      setQuote(await withWalletSession(connected, () => getSwapQuote(mint, amount.trim() || "max")));
    } catch (error) {
      setQuote(null);
      setFailed(true);
      setMessage(error instanceof Error ? error.message : "No quote right now.");
    } finally {
      setBusy(false);
    }
  }

  async function sell(): Promise<void> {
    if (!connected || !quote) return;
    setBusy(true);
    setFailed(false);
    try {
      setMessage("Preparing the swap…");
      const built = await withWalletSession(connected, () => buildSwap(quote.quote));
      setMessage("Approve the swap in your wallet…");
      const payout = { id: "swap", transaction: built.transaction, expiresAt: String(built.expiresAt) } as PreparedClaimBatch;
      const sent = await signPreparedClaim({ wallet: connected.wallet, payout, nowSeconds: Math.floor(Date.now() / 1_000) });
      setSignature(sent.signature);
      track("coin_sold", { mint });
      setMessage(sent.confirmed ? `Sold. ≈ ${sol(quote.outAmount)} SOL is in your wallet.` : "Sent. It can take a few seconds to show in your wallet.");
      setQuote(null);
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : "The swap did not go through. Get a fresh quote.");
      setQuote(null);
    } finally {
      setBusy(false);
    }
  }

  const held = quote?.balance ? Number(quote.balance) / 10 ** quote.decimals : null;
  return createPortal(
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section ref={dialogRef} className="launch-modal sell-modal" role="dialog" aria-modal="true" aria-labelledby="sell-title" onMouseDown={(event) => event.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close"><IconClose size={20} /></button>
        <h2 id="sell-title">Sell ${symbol}</h2>
        <p className="modal-intro">Swap the coins your bots mined for SOL, at the best price Jupiter finds across Solana markets.</p>
        <div className="sell-row">
          <label>
            <span className="sr-only">Amount of ${symbol}</span>
            <input value={amount === "max" ? "" : amount} placeholder="All of it" inputMode="decimal" onChange={(event) => { setAmount(event.target.value.replace(/[^0-9.]/g, "")); setQuote(null); }} />
          </label>
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => { setAmount("max"); setQuote(null); }}>Max</button>
          <button className="btn btn-primary btn-sm" type="button" disabled={busy || !connected} onClick={() => void getQuote()}>{busy && !quote ? "Quoting…" : "Get price"}</button>
        </div>
        {quote && (
          <div className="sell-quote">
            <div><span>You sell</span><strong>{(Number(quote.inAmount) / 10 ** quote.decimals).toLocaleString("en-US", { maximumFractionDigits: 4 })} ${symbol}</strong></div>
            <div><span>You get about</span><strong>{sol(quote.outAmount)} SOL</strong></div>
            <small>
              {quote.feeBps > 0 ? `Includes a ${feeLabel(quote.feeBps)} Diggo fee. ` : ""}
              {quote.priceImpactPct > 0.01 ? `Price impact ${(quote.priceImpactPct * 100).toFixed(2)}%. ` : ""}
              Up to 3% slippage.{held !== null ? ` You hold ${held.toLocaleString("en-US", { maximumFractionDigits: 4 })}.` : ""}
            </small>
            <button className="btn btn-primary btn-lg" type="button" disabled={busy} onClick={() => void sell()}>{busy ? "Working…" : "Sell for SOL"}</button>
          </div>
        )}
        {!connected && <p className="form-hint">Connect your wallet to sell.</p>}
        {message && <p className={"form-message" + (failed ? " admin-job-error" : "")} role="status">{message}</p>}
        {signature && <a className="form-hint" href={`https://solscan.io/tx/${signature}`} target="_blank" rel="noreferrer">View on Solscan</a>}
      </section>
    </div>,
    document.body,
  );
}
