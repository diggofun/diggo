/**
 * "Platform fees" card for the Meteora DBC config fee claimer.
 *
 * It renders nothing unless the connected wallet is exactly the on-chain config fee claimer. For
 * that wallet it lists every partner-fee pool under the config with its fresh claimable trading and
 * creation fees, and claims one pool per wallet-signed transaction: build, check funding, simulate
 * unsigned, then ask the wallet to sign and send. Fees always go to the claimer itself.
 */
import { useCallback, useEffect, useState } from "react";
import { shortAddress } from "../format";
import { IconClaim, IconExternalLink, IconRefresh } from "../icons";
import {
  describeClaimError,
  formatSol,
  isPlatformFeeClaimer,
  planPartnerFeeClaim,
  RECOMMENDED_CLAIMER_BALANCE_LAMPORTS,
  SIGNATURE_FEE_LAMPORTS,
  solscanTransactionUrl,
  type PartnerFeePool,
} from "../meteora/platformFees";
import {
  loadPlatformFeeConfig,
  loadPlatformFeeOverview,
  preparePartnerClaim,
  sendPartnerClaim,
  simulateUnsignedClaim,
  type PlatformFeeConfig,
  type PlatformFeeOverview,
} from "../meteora/platformFeesClient";
import { useDiggoWallet } from "../wallet";

export interface PlatformFeesPanelProps {
  configAddress: string;
  officialMint: string | null;
  cluster: string;
  signedIn: boolean;
  /** Signs the wallet in (session cookie) so the RPC proxy accepts the simulation and send. */
  onSignIn?: () => Promise<void>;
}

interface ClaimReceipt {
  pool: string;
  signature: string;
  confirmed: boolean;
  claimedLamports: bigint;
}

export function PlatformFeesPanel({ configAddress, officialMint, cluster, signedIn, onSignIn }: PlatformFeesPanelProps) {
  const connected = useDiggoWallet();
  const [feeConfig, setFeeConfig] = useState<PlatformFeeConfig | null>(null);
  const [overview, setOverview] = useState<PlatformFeeOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyPool, setBusyPool] = useState<string | null>(null);
  const [phase, setPhase] = useState("");
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<ClaimReceipt | null>(null);

  useEffect(() => {
    // The card is gated on isPlatformFeeClaimer below, so a stale config for a disconnected wallet
    // can never render anything; only fetch when there is a wallet to compare against.
    if (!configAddress || !connected) return;
    let current = true;
    loadPlatformFeeConfig(configAddress)
      .then((config) => { if (current) setFeeConfig(config); })
      .catch(() => { if (current) setFeeConfig(null); });
    return () => { current = false; };
  }, [configAddress, connected]);

  const walletAddress = connected?.address ?? null;
  const isClaimer = isPlatformFeeClaimer(walletAddress, feeConfig?.feeClaimer);

  const refresh = useCallback(async () => {
    if (!feeConfig || !walletAddress || !isPlatformFeeClaimer(walletAddress, feeConfig.feeClaimer)) return;
    setLoading(true);
    try {
      setOverview(await loadPlatformFeeOverview({ feeConfig, claimer: walletAddress, officialMint }));
    } catch (failure) {
      setError(describeClaimError(failure));
    } finally {
      setLoading(false);
    }
  }, [feeConfig, officialMint, walletAddress]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!connected || !feeConfig || !isClaimer) return null;

  async function claim(pool: PartnerFeePool) {
    if (!connected || busyPool) return;
    setBusyPool(pool.pool);
    setError("");
    setReceipt(null);
    try {
      if (!signedIn) {
        if (!onSignIn) throw new Error("Sign in with this wallet first, then claim again.");
        setPhase("Sign in with your wallet…");
        await onSignIn();
      }
      setPhase("Reading fresh fees…");
      const prepared = await preparePartnerClaim({ configAddress, poolAddress: pool.pool, claimer: connected.address });
      if (!prepared.funding.sufficient) {
        throw new Error(
          "This wallet holds " + formatSol(prepared.balanceLamports) + ", but the claim needs about " +
          formatSol(prepared.funding.requiredLamports) + " up front for the network fee and token-account rent. Send at least " +
          formatSol(prepared.funding.recommendedLamports) + " to " + connected.address + " and try again.",
        );
      }
      setPhase("Simulating the claim…");
      const simulation = await simulateUnsignedClaim(prepared.transaction);
      if (simulation.err) {
        const reason = typeof simulation.err === "string" ? simulation.err : JSON.stringify(simulation.err);
        throw new Error("The claim simulation failed (" + reason + "). Nothing was sent.");
      }
      setPhase("Approve the claim in your wallet…");
      const result = await sendPartnerClaim(connected.wallet, prepared);
      setReceipt({
        pool: pool.pool,
        signature: result.signature,
        confirmed: result.confirmed,
        claimedLamports: prepared.plan.claimableLamports,
      });
      setPhase("Refreshing balances…");
      await refresh();
    } catch (failure) {
      setError(describeClaimError(failure));
    } finally {
      setBusyPool(null);
      setPhase("");
    }
  }

  const balance = overview?.balanceLamports ?? null;
  const underfunded = balance !== null && balance < RECOMMENDED_CLAIMER_BALANCE_LAMPORTS;
  const cannotPay = balance !== null && balance < SIGNATURE_FEE_LAMPORTS;
  const totalLamports = (overview?.pools ?? []).reduce((sum, pool) => sum + planPartnerFeeClaim(pool).claimableLamports, 0n);

  return (
    <section className="page-shell platform-fees" aria-label="Platform fees">
      <article className="platform-fees-card">
        <header className="platform-fees-head">
          <div>
            <span className="mono-label">Fee claimer {shortAddress(connected.address)}</span>
            <h2>Platform fees</h2>
            <small>Meteora partner fees under config {shortAddress(configAddress)}. Every claim pays out to this wallet.</small>
          </div>
          <button className="btn btn-ghost" type="button" onClick={() => void refresh()} disabled={loading || busyPool !== null}>
            <IconRefresh size={15} /> {loading ? "Refreshing…" : "Refresh"}
          </button>
        </header>

        <div className="platform-fees-summary">
          <div><span>Claimable now</span><strong>{overview ? formatSol(totalLamports) : "…"}</strong></div>
          <div><span>Wallet balance</span><strong>{balance === null ? "…" : formatSol(balance)}</strong></div>
        </div>

        {underfunded && (
          <p className="form-message platform-fees-warning" role="status">
            Send about {formatSol(RECOMMENDED_CLAIMER_BALANCE_LAMPORTS)} to this wallet before claiming. It pays the network
            fee and the rent for the token accounts the claim opens (about 0.003 SOL; the wrapped-SOL rent comes back in
            the same transaction).
          </p>
        )}
        {overview?.fallback && (
          <p className="form-message">The pool list is unavailable right now, so only the official $DIGGO pool is shown.</p>
        )}

        {overview && overview.pools.length === 0 && <p className="form-message">No pools use this config yet.</p>}
        {overview && overview.pools.length > 0 && (
          <ul className="platform-fees-pools">
            {overview.pools.map((pool) => {
              const plan = planPartnerFeeClaim(pool);
              const nothing = !plan.claimTrading && !plan.claimCreation;
              const busy = busyPool === pool.pool;
              return (
                <li key={pool.pool}>
                  <div className="platform-fees-pool-id">
                    <strong>{pool.baseMint === officialMint ? "$DIGGO (official)" : shortAddress(pool.baseMint)}</strong>
                    <small>Pool {shortAddress(pool.pool)}</small>
                  </div>
                  <dl>
                    <div><dt>Trading fee</dt><dd>{formatSol(pool.tradingQuoteLamports)}{pool.tradingBaseUnits > 0n ? " + " + pool.tradingBaseUnits.toString() + " token units" : ""}</dd></div>
                    <div><dt>Creation fee</dt><dd>{pool.creationFeeClaimed ? "Already claimed" : formatSol(pool.creationFeeLamports)}</dd></div>
                  </dl>
                  <button
                    className="btn btn-primary"
                    type="button"
                    disabled={nothing || cannotPay || busyPool !== null}
                    onClick={() => void claim(pool)}
                  >
                    <IconClaim size={15} /> {busy ? phase || "Working…" : nothing ? "Nothing to claim" : "Claim " + formatSol(plan.claimableLamports)}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {error && <p className="form-message platform-fees-error" role="alert">{error}</p>}
        {receipt && (
          <p className="form-message platform-fees-success" role="status">
            {receipt.confirmed ? "Claimed" : "Submitted"} {formatSol(receipt.claimedLamports)}
            {receipt.confirmed ? "." : "; confirmation is still pending."}{" "}
            <a href={solscanTransactionUrl(receipt.signature, cluster)} target="_blank" rel="noreferrer">
              View on Solscan <IconExternalLink size={12} />
            </a>
          </p>
        )}
      </article>
    </section>
  );
}
