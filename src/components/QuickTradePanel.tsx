/**
 * Buy and sell any Solana coin through Jupiter, gmgn-style: preset sizes, one tap, one signature.
 * The Worker quotes and builds the swap (with Diggo's small fee); the wallet signs it here.
 */
import { useCallback, useEffect, useState } from "react";
import { buildSwap, getSwapBalance, getSwapQuote, type PreparedClaimBatch } from "../api";
import { track } from "../analytics";
import { signPreparedClaim } from "../onchain/preparedClaim";
import { useDiggoWallet } from "../wallet";
import { withWalletSession } from "../walletSession";
import { feeLabel } from "../../shared/projectMineFee";

const BUY_PRESETS = ["0.1", "0.5", "1", "2"];
const SELL_PRESETS = [25, 50, 75, 100];
const SLIPPAGES = [100, 300, 500, 1_000];

function amountText(raw: string, decimals: number): string {
  return (Number(raw) / 10 ** decimals).toLocaleString("en-US", { maximumFractionDigits: decimals > 4 ? 4 : decimals });
}

export function QuickTradePanel({ mint, symbol }: { mint: string; symbol: string }) {
  const connected = useDiggoWallet();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [buyAmount, setBuyAmount] = useState("0.1");
  const [sellPercent, setSellPercent] = useState(100);
  const [slippage, setSlippage] = useState(300);
  const [holding, setHolding] = useState<{ balance: string; decimals: number; lamports: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const [signature, setSignature] = useState("");

  const refresh = useCallback(() => {
    if (!connected) return;
    getSwapBalance(mint).then(setHolding).catch(() => setHolding(null));
  }, [connected, mint]);
  useEffect(() => { refresh(); }, [refresh]);

  async function trade(): Promise<void> {
    if (!connected) return;
    setBusy(true);
    setFailed(false);
    setSignature("");
    try {
      let amount: string;
      if (side === "buy") amount = buyAmount.trim();
      else if (sellPercent >= 100) amount = "max";
      else {
        const current = holding ?? await withWalletSession(connected, () => getSwapBalance(mint));
        const raw = (BigInt(current.balance) * BigInt(sellPercent)) / 100n;
        if (raw <= 0n) throw new Error(`You hold no $${symbol}`);
        const scale = 10n ** BigInt(current.decimals);
        amount = (raw / scale).toString() + (current.decimals > 0 ? "." + (raw % scale).toString().padStart(current.decimals, "0") : "");
      }
      setMessage("Getting the best price…");
      const quote = await withWalletSession(connected, () => getSwapQuote(mint, amount, side, slippage), () => setMessage("Sign the message in your wallet to continue…"));
      setMessage(side === "buy"
        ? `Buying ≈ ${amountText(quote.outAmount, quote.decimals)} $${symbol}. Approve in your wallet…`
        : `Selling for ≈ ${amountText(quote.outAmount, 9)} SOL. Approve in your wallet…`);
      const built = await buildSwap(quote.quote);
      const payout = { id: "trade", transaction: built.transaction, expiresAt: String(built.expiresAt) } as PreparedClaimBatch;
      const sent = await signPreparedClaim({ wallet: connected.wallet, payout, nowSeconds: Math.floor(Date.now() / 1_000) });
      setSignature(sent.signature);
      track(side === "buy" ? "coin_bought" : "coin_sold", { mint });
      setMessage(sent.confirmed ? (side === "buy" ? `Bought $${symbol}.` : "Sold.") : "Sent. It can take a few seconds to land.");
      window.setTimeout(refresh, 1_500);
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : "The trade did not go through.");
    } finally {
      setBusy(false);
    }
  }

  const held = holding ? amountText(holding.balance, holding.decimals) : null;
  const sol = holding ? amountText(holding.lamports, 9) : null;
  return (
    <aside className="quick-trade" aria-label={`Trade $${symbol}`}>
      <div className="segmented quick-trade-side" role="radiogroup" aria-label="Side">
        <button type="button" role="radio" aria-checked={side === "buy"} className={side === "buy" ? "active is-buy" : ""} onClick={() => setSide("buy")}>Buy</button>
        <button type="button" role="radio" aria-checked={side === "sell"} className={side === "sell" ? "active is-sell" : ""} onClick={() => setSide("sell")}>Sell</button>
      </div>
      {side === "buy" ? (
        <>
          <label className="quick-trade-input">
            <span>Amount (SOL)</span>
            <input inputMode="decimal" value={buyAmount} onChange={(event) => setBuyAmount(event.target.value.replace(/[^0-9.]/g, ""))} />
          </label>
          <div className="quick-trade-presets">
            {BUY_PRESETS.map((preset) => <button key={preset} type="button" className={"chip" + (buyAmount === preset ? " is-met" : "")} onClick={() => setBuyAmount(preset)}>{preset} SOL</button>)}
          </div>
        </>
      ) : (
        <div className="quick-trade-presets">
          {SELL_PRESETS.map((preset) => <button key={preset} type="button" className={"chip" + (sellPercent === preset ? " is-met" : "")} onClick={() => setSellPercent(preset)}>{preset}%</button>)}
        </div>
      )}
      <div className="quick-trade-meta">
        <span>Slippage</span>
        <div className="quick-trade-slippage">
          {SLIPPAGES.map((bps) => <button key={bps} type="button" className={"chip" + (slippage === bps ? " is-met" : "")} onClick={() => setSlippage(bps)}>{bps / 100}%</button>)}
        </div>
      </div>
      <button className={"btn btn-lg quick-trade-go " + (side === "buy" ? "is-buy" : "is-sell")} type="button" disabled={busy || !connected} onClick={() => void trade()}>
        {!connected ? "Connect your wallet" : busy ? "Working…" : side === "buy" ? `Buy $${symbol}` : `Sell ${sellPercent}% of $${symbol}`}
      </button>
      {connected && <small className="quick-trade-balance">Wallet: {sol ?? "…"} SOL · {held ?? "…"} ${symbol}</small>}
      <small className="quick-trade-note">Routed by Jupiter across Solana markets. Includes a {feeLabel(50)} Diggo fee.</small>
      {message && <p className={"form-message" + (failed ? " admin-job-error" : "")} role="status">{message}</p>}
      {signature && <a className="quick-trade-note" href={`https://solscan.io/tx/${signature}`} target="_blank" rel="noreferrer">View on Solscan</a>}
    </aside>
  );
}
