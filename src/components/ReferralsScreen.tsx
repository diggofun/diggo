import { useCallback, useEffect, useState } from "react";
import { track } from "../analytics";
import { checkReferralCode, getReferrals, saveReferralCode, type ReferralPanel, type ReferralView } from "../api";
import { shortAddress } from "../format";
import { IconCopy, IconUserGroup } from "../icons";
import { referralLink } from "../referralLink";

function solFromLamports(value: string): number {
  try { return Number(BigInt(value)) / 1_000_000_000; } catch { return 0; }
}

function sol(value: number): string { return `${value.toFixed(2)} SOL`; }
function date(value: number | null): string { return value ? new Date(value * 1_000).toLocaleDateString() : "—"; }

function statusLabel(status: ReferralView["status"]): string {
  return status === "REWARDED" ? "Qualified · credited" : status.charAt(0) + status.slice(1).toLowerCase();
}

function ReferralRow({ row, threshold }: { row: ReferralView; threshold: number }) {
  const volume = solFromLamports(row.volumeLamports);
  const progress = Math.min(100, threshold > 0 ? (volume / threshold) * 100 : 0);
  return (
    <div className="referral-row">
      <span className="referral-player"><strong>{row.username ?? shortAddress(row.referredWallet)}</strong><small>{shortAddress(row.referredWallet)}</small></span>
      <span>{date(row.joinedAt)}</span>
      <span className="referral-volume"><span>{sol(volume)} / {sol(threshold)}</span><span className="progress"><i style={{ width: `${progress}%` }} /></span></span>
      <span className={`referral-status ${row.status.toLowerCase()}`}>{statusLabel(row.status)}</span>
      <span>{row.oreCredited > 0 ? `${row.oreCredited} ORE credited` : "Pending"}</span>
    </div>
  );
}

export function ReferralsScreen({ signedIn }: { signedIn: boolean }) {
  const [panel, setPanel] = useState<ReferralPanel | null>(null);
  const [page, setPage] = useState(1);
  const [code, setCode] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!signedIn) return;
    try {
      const result = await getReferrals(page);
      setPanel(result);
      setCode(result.code);
      setError("");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Referrals are unavailable."); }
  }, [page, signedIn]);
  useEffect(() => { void load(); }, [load]);

  if (!signedIn) {
    return <section className="page-shell referrals-page"><div className="empty-state"><IconUserGroup size={28} /><h2>Sign in to use referrals</h2><p>Connect and sign in with your wallet to manage your referral link.</p></div></section>;
  }

  async function copyLink(): Promise<void> {
    if (!panel) return;
    try {
      await navigator.clipboard.writeText(referralLink(code));
      setMessage("Referral link copied.");
      track("referral_link_copied");
    }
    catch { setMessage("Copy is unavailable in this browser."); }
  }

  async function checkCode(): Promise<void> {
    setChecking(true); setMessage("");
    try {
      const result = await checkReferralCode(code);
      setMessage(result.available ? "Code is available." : result.message ?? "That code is not available.");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Could not check code."); }
    finally { setChecking(false); }
  }

  async function saveCode(): Promise<void> {
    setSaving(true); setMessage("");
    try {
      await saveReferralCode(code);
      track("referral_link_customized");
      setMessage("Referral code saved. The previous link keeps working for players who already joined.");
      await load();
    }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Could not save code."); }
    finally { setSaving(false); }
  }

  const threshold = panel ? solFromLamports(panel.thresholdLamports) : 0;
  const cooldown = panel?.cooldownSeconds ?? 0;
  const shareLink = referralLink(code);
  return (
    <section className="page-shell referrals-page" aria-labelledby="referrals-title">
      <div className="section-heading">
        <div><div className="eyebrow"><IconUserGroup size={14} /> Referrals</div><h1 id="referrals-title">GROW THE<br />DIGGO CREW.</h1><p className="section-intro">Share your link. A referral qualifies after {sol(threshold)} of buys and sells, excluding trades between you and the referred wallet.</p></div>
      </div>
      {error && <p className="form-message referral-error">{error}</p>}
      {message && <p className="form-message referral-message">{message}</p>}
      {panel ? <>
        <div className="card referral-link-card">
          <label htmlFor="referral-code">Your custom link</label>
          <div className="referral-link-row"><code>diggo.fun/r/</code><input id="referral-code" value={code} onChange={(event) => setCode(event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 20))} /><button type="button" className="btn btn-ghost" onClick={() => void copyLink()} aria-label="Copy referral link" title="Copy referral link"><IconCopy size={16} /> <span>Copy link</span></button></div>
          <a className="referral-link-preview" href={shareLink} target="_blank" rel="noreferrer">{shareLink}</a>
          <div className="referral-code-actions"><button type="button" className="btn btn-ghost btn-sm" onClick={() => void checkCode()} disabled={checking || !code}>{checking ? "Checking…" : "Check availability"}</button><button type="button" className="btn btn-sm" onClick={() => void saveCode()} disabled={saving || !code || cooldown > 0}>{saving ? "Saving…" : cooldown > 0 ? `Available in ${Math.ceil(cooldown / 86_400)}d` : "Save code"}</button><small>3–20 characters · lowercase letters, numbers, - and _ · changes every 7 days</small></div>
        </div>
        <div className="referral-totals"><Stat label="Invited" value={panel.totals.invited} /><Stat label="Pending" value={panel.totals.pending} /><Stat label="Qualified" value={panel.totals.qualified} /><Stat label="ORE earned" value={`${panel.totals.oreEarned}`} /><Stat label="Skin" value={panel.totals.skinUnlocked ? "Unlocked" : "Locked"} /></div>
        <div className="card referral-table-card"><div className="referral-table-head"><div><h2 className="mono-label">Referred players</h2><p>Rewards are reserved after qualification and paid to your wallet.</p></div><span className="mono-label">{panel.weeklyCap} rewards / week cap</span></div>
          {panel.referrals.length > 0 ? <div className="referral-table"><div className="referral-row referral-table-labels"><span>Player</span><span>Joined</span><span>Volume progress</span><span>Status</span><span>ORE credited</span></div>{panel.referrals.map((row) => <ReferralRow key={row.id} row={row} threshold={threshold} />)}</div> : <div className="empty-state referral-empty"><p>No referred players yet. Share your link to start your crew.</p></div>}
          {panel.pages > 1 && <div className="referral-pagination"><button type="button" className="btn btn-ghost btn-sm" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={panel.page === 1}>Previous</button><span>{panel.page} / {panel.pages}</span><button type="button" className="btn btn-ghost btn-sm" onClick={() => setPage((value) => Math.min(panel.pages, value + 1))} disabled={panel.page === panel.pages}>Next</button></div>}
        </div>
      </> : <div className="empty-state"><p>Loading your referral dashboard…</p></div>}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) { return <div className="referral-total"><span>{label}</span><strong>{value}</strong></div>; }
