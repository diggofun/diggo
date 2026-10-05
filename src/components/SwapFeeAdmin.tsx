/**
 * Admin: the fee wallet's wrapped-SOL account that collects the swap fee. Jupiter can only pay a
 * fee into an account that exists, so it is created once here (the admin wallet pays ~0.002 SOL rent).
 */
import { useCallback, useEffect, useState } from "react";
import { adminRequest, type PreparedClaimBatch } from "../api";
import { signPreparedClaim } from "../onchain/preparedClaim";
import { useDiggoWallet } from "../wallet";

interface FeeAccountState { account: string; ready: boolean; feeBps?: number; transaction?: string; expiresAt?: number }

export function SwapFeeAdmin() {
  const connected = useDiggoWallet();
  const [state, setState] = useState<FeeAccountState | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => adminRequest<FeeAccountState>("/api/admin/swap-fee-account").then(setState).catch(() => setState(null)), []);
  useEffect(() => { void load(); }, [load]);

  async function create(): Promise<void> {
    if (!connected) return;
    setBusy(true);
    try {
      const prepared = await adminRequest<FeeAccountState>("/api/admin/swap-fee-account", { body: {} });
      if (prepared.transaction && prepared.expiresAt) {
        const payout = { id: "fee-account", transaction: prepared.transaction, expiresAt: String(prepared.expiresAt) } as PreparedClaimBatch;
        await signPreparedClaim({ wallet: connected.wallet, payout, nowSeconds: Math.floor(Date.now() / 1_000) });
      }
      setMessage("Fee account created. Swaps now carry the fee.");
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not create the fee account.");
    } finally {
      setBusy(false);
    }
  }

  if (!state) return null;
  return (
    <div className="admin-block">
      <div className="admin-block-head"><span>SWAP FEE</span><small>{state.ready ? `Active · ${(state.feeBps ?? 0) / 100}% of each sale, paid in SOL` : "Not collecting yet"}</small></div>
      <p className="admin-empty">Fee account: <code>{state.account}</code></p>
      {!state.ready && (
        <button className="btn btn-primary" type="button" disabled={busy || !connected} onClick={() => void create()}>
          {busy ? "Signing…" : "Create fee account (≈0.002 SOL)"}
        </button>
      )}
      {message && <p className="form-message admin-notice" role="status">{message}</p>}
    </div>
  );
}
