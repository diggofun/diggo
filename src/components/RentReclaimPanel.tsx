/**
 * Reclaim SOL: the panel that closes a wallet empty token accounts and pays the platform its 1%.
 *
 * The panel shows exactly what it is about to sign for - how many accounts, how much comes back,
 * what the platform takes and what the wallet keeps - and it refuses to offer the action when the
 * treasury address is unknown, because a reclaim without a fee destination is not the reclaim the
 * player agreed to. All of the arithmetic and every safety rule lives in src/onchain/rentReclaim.ts;
 * this file only presents it.
 *
 * Only empty accounts are reclaimable. The first button creates a review preview; signing starts
 * only from the separate confirmation button below it.
 */
import { address } from "@solana/kit";
import { useCallback, useEffect, useMemo, useState } from "react";
import { solAmount, shortAddress } from "../format";
import { fetchProtocolConfig, type DiggoWallet } from "../solanaProgram";
import {
  PLATFORM_FEE_BPS,
  planReclaim,
  reclaimRent,
  resolvePendingReclaim,
  hasPendingReclaim,
  scanTokenAccounts,
  type ReclaimPlan,
  type ReclaimResult,
  type ReclaimScan,
} from "../onchain/rentReclaim";

export interface RentReclaimPanelProps {
  /** The program id from /api/config, used to read the treasury out of ProtocolConfig. */
  programAddress: string;
  /** The connected signer. Every close below is signed by it, and the rent returns to it. */
  signer: DiggoWallet | null;
}

export function RentReclaimPanel({ programAddress, signer }: RentReclaimPanelProps) {
  const [scan, setScan] = useState<ReclaimScan | null>(null);
  const [treasury, setTreasury] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [result, setResult] = useState<ReclaimResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!signer || !programAddress) {
      setScan(null);
      setTreasury(null);
      return;
    }
    setError("");
    setPreview(false);
    try {
      const config = await fetchProtocolConfig(address(programAddress));
      setTreasury(config ? String(config.treasury) : null);
    } catch {
      setTreasury(null);
    }
    try {
      setScan(await scanTokenAccounts(address(signer.address)));
    } catch (failure) {
      setScan(null);
      setError(failure instanceof Error ? failure.message : "The token accounts could not be read.");
    }
  }, [programAddress, signer]);

  useEffect(() => {
    setResult(null);
    void load();
  }, [load]);

  const plan: ReclaimPlan | null = useMemo(() => {
    if (!scan || !scan.complete || !signer || !treasury) return null;
    return planReclaim(scan.accounts, {
      owner: address(signer.address),
      treasury: address(treasury),
    });
  }, [scan, signer, treasury]);

  const reclaim = async () => {
    if (!signer || !plan || !treasury) return;
    if (hasPendingReclaim(result)) return;
    setBusy(true);
    setError("");
    try {
      const freshScan = await scanTokenAccounts(address(signer.address));
      if (!freshScan.complete) throw new Error("The token-account scan was incomplete. Try again.");
      const freshPlan = planReclaim(freshScan.accounts, {
        owner: address(signer.address),
        treasury: address(treasury),
      });
      const planned = plan.batches.flatMap((batch) => batch.accounts.map((entry) => String(entry.account)));
      const current = freshPlan.batches.flatMap((batch) => batch.accounts.map((entry) => String(entry.account)));
      if (planned.join(",") !== current.join(",") || plan.totalLamports !== freshPlan.totalLamports) {
        throw new Error("The reclaimable accounts changed. Review a fresh preview before signing.");
      }
      const outcome = await reclaimRent({
        wallet: signer,
        treasury: address(treasury),
        scan: freshScan,
      });
      setResult(outcome);
      setPreview(false);
      if (hasPendingReclaim(outcome)) {
        setError("A reclaim transaction was submitted but is still pending. Check its status before signing again.");
      } else {
        await load();
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The reclaim transaction failed.");
    } finally {
      setBusy(false);
    }
  };

  const resolvePending = async () => {
    if (!result || !hasPendingReclaim(result)) return;
    setBusy(true);
    setError("");
    try {
      const resolved = await resolvePendingReclaim(result);
      setResult(resolved);
      if (hasPendingReclaim(resolved)) {
        setError("The transaction is still pending. Do not retry the same reclaim; check the signature again.");
      } else {
        await load();
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The pending reclaim could not be checked.");
    } finally {
      setBusy(false);
    }
  };

  const ready = signer !== null && programAddress !== "";

  return (
    <section className="card rent-reclaim-panel" id="rent-reclaim" aria-labelledby="rent-reclaim-title">
      <div className="claim-block-head">
        <h2 className="mono-label" id="rent-reclaim-title">
          Reclaim SOL
        </h2>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => void load()}
          disabled={busy || !ready}
        >
          Rescan
        </button>
      </div>

      <p>
        Empty token accounts keep holding their rent. Closing them returns it, and the platform
        takes {PLATFORM_FEE_BPS / 100}% of what comes back, in the same transaction.
      </p>

      {!ready && <p className="form-message">Connect a wallet to see what it can reclaim.</p>}
      {error && (
        <p className="form-message">
          Warning: {error}
        </p>
      )}
      {ready && !treasury && (
        <p className="form-message">
          The treasury address could not be read from ProtocolConfig, so the platform fee has
          nowhere to go. Reclaim is unavailable until that read succeeds.
        </p>
      )}
      {scan && !scan.complete && (
        <p className="form-message">
          One of the token programs did not answer, so a complete reclaim preview is unavailable.
        </p>
      )}

      <div className="mining-kpis">
        <div className="stat">
          <span>Accounts found</span>
          <strong>{plan ? plan.accounts : "—"}</strong>
          <small>{plan && plan.skipped.length > 0 ? plan.skipped.length + " left alone" : "ready to close"}</small>
        </div>
        <div className="stat">
          <span>Reclaimable</span>
          <strong>{plan ? solAmount(Number(plan.totalLamports) / 1_000_000_000) + " SOL" : "—"}</strong>
          <small>rent held by those accounts</small>
        </div>
        <div className="stat">
          <span>Platform fee</span>
          <strong>
            {plan ? solAmount(Number(plan.platformFeeLamports) / 1_000_000_000) + " SOL" : "—"}
          </strong>
          <small>{PLATFORM_FEE_BPS / 100}% of what is reclaimed</small>
        </div>
        <div className="stat">
          <span>You receive</span>
          <strong>
            {plan ? solAmount(Number(plan.userReceivesLamports) / 1_000_000_000) + " SOL" : "—"}
          </strong>
            <small>{plan ? plan.batches.length + " transaction(s)" : "nothing to sign"}</small>
            <small>after platform fee, before network fee</small>
        </div>
      </div>

      {plan && !preview && (
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setPreview(true)}
          disabled={busy || plan.batches.length === 0}
        >
          Preview reclaim
        </button>
      )}

      {preview && plan && (
        <div className="rent-reclaim-preview">
          <h3 className="mono-label">Review before signing</h3>
          <p>
            This closes {plan.accounts} empty SPL account(s) across {plan.batches.length} transaction(s).
            The wallet receives {solAmount(Number(plan.userReceivesLamports) / 1_000_000_000)} SOL after platform fee, before network fee, and
            the platform receives {solAmount(Number(plan.platformFeeLamports) / 1_000_000_000)} SOL
            ({PLATFORM_FEE_BPS / 100}%), in the same signed transactions.
          </p>
          <ul>
            {plan.batches.flatMap((batch) => batch.accounts).map((account) => (
              <li key={String(account.account)}>
                {shortAddress(String(account.account))} · {shortAddress(String(account.mint))}
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void reclaim()}
            disabled={busy || hasPendingReclaim(result)}
          >
            {busy ? "Reclaiming…" : hasPendingReclaim(result) ? "Resolve pending transaction first" : `Confirm and sign ${plan.batches.length} transaction(s)`}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPreview(false)} disabled={busy}>
            Cancel
          </button>
        </div>
      )}

      {result && (
        <div className="leaderboard-table">
          <div className="leaderboard-row leaderboard-head">
            <span>Transaction</span>
            <span>Accounts</span>
            <span>Returned</span>
            <span>Outcome</span>
          </div>
          {result.results.map((entry) => (
            <div className="leaderboard-row" key={"reclaim-" + entry.index}>
              <span>{entry.signature ? shortAddress(entry.signature) : "not submitted"}</span>
              <strong>{entry.accounts.length}</strong>
              <span>{entry.status === "confirmed" ? solAmount(Number(entry.lamports) / 1_000_000_000) + " SOL" : "—"}</span>
              <em className={entry.status === "confirmed" ? "is-up" : "is-down"}>{entry.status === "confirmed" ? "confirmed" : entry.status === "pending" || entry.status === "submitted" ? "pending — check before retry" : entry.error ?? "rejected"}</em>
            </div>
          ))}
          <div className="leaderboard-empty">
            {solAmount(Number(result.userReceivesLamports) / 1_000_000_000)} SOL returned to your
            wallet across {result.results.filter((entry) => entry.status === "confirmed").length} of {result.results.length}
            transactions. Amounts are after platform fee, before network fee.
          </div>
          {hasPendingReclaim(result) && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void resolvePending()} disabled={busy}>
              {busy ? "Checking…" : "Check pending transaction"}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
