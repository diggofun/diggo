/**
 * Anti-abuse admin surface (spec 65-67).
 *
 * The page only renders for a wallet the Worker accepts as an admin: both endpoints answer 401 for
 * anyone else, and a 401 turns this route into a locked notice instead of an empty dashboard.
 *
 * What an operator can do here is deliberately narrow: read the anonymous anti-abuse view, read the
 * metric set and its alerts, place or lift a restriction, and open or close a circuit breaker. Every
 * control on this screen can only slow an account down or halt a queue — none of them can move,
 * seize or redirect value, because no endpoint exists that could.
 */
import { useCallback, useEffect, useState } from "react";
import { AlertOctagon, Ban, Lock, OctagonAlert, RefreshCw, ShieldAlert, Zap } from "lucide-react";
import { ApiError, getAdminAbuse, getAdminMetrics, setBreaker, setRestriction, type AdminAbuseView, type AdminMetrics } from "../api";
import { shortAddress } from "../format";

export interface AdminScreenProps {
  signedIn: boolean;
}

/** Mirrors the Worker's BREAKER_SCOPES; discovery_reserve is per mine. */
const BREAKER_SCOPES: { scope: string; label: string; needsMint: boolean }[] = [
  { scope: "discoveries", label: "New discoveries", needsMint: false },
  { scope: "claims", label: "All claims", needsMint: false },
  { scope: "discovery_reserve", label: "One mine's discovery reserve", needsMint: true },
];

/** Mirrors the Worker's RESTRICTION_KINDS. */
const RESTRICTION_KINDS = ["ACCOUNT_BLOCK", "CLAIM_HOLD", "DISCOVERY_BLOCK", "CHALLENGE_REQUIRED", "RATE_LIMIT"];

function reasonFromTemplate(scope: string): string {
  return "Operator action on " + scope + " from /admin";
}

export function AdminScreen({ signedIn }: AdminScreenProps) {
  const [abuse, setAbuse] = useState<AdminAbuseView | null>(null);
  const [metrics, setMetrics] = useState<AdminMetrics | null>(null);
  const [denied, setDenied] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [breakReason, setBreakReason] = useState("");
  const [reserveMint, setReserveMint] = useState("");
  const [restrictionWallet, setRestrictionWallet] = useState("");
  const [restrictionKind, setRestrictionKind] = useState(RESTRICTION_KINDS[0]);
  const [restrictionHours, setRestrictionHours] = useState("24");

  const load = useCallback(async () => {
    if (!signedIn) {
      setDenied(true);
      return;
    }
    setLoading(true);
    try {
      const [abuseResult, metricsResult] = await Promise.all([getAdminAbuse({ limit: 50 }), getAdminMetrics()]);
      setAbuse(abuseResult);
      setMetrics(metricsResult);
      setDenied(false);
      setError("");
    } catch (failure) {
      if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500) {
        setDenied(true);
      } else {
        setError("The admin surface is unavailable right now.");
      }
    } finally {
      setLoading(false);
    }
  }, [signedIn]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleBreaker(scope: string, mint: string | null, open: boolean): Promise<void> {
    const reason = breakReason.trim().length > 0 ? breakReason.trim() : reasonFromTemplate(scope);
    try {
      const result = await setBreaker({
        scope,
        open,
        reason,
        ...(scope === "discovery_reserve" && mint ? { mint } : {}),
      });
      setMetrics((current) => (current ? { ...current, breakers: result.breakers } : current));
      setNotice(scope + " is now " + (open ? "open (halted)" : "closed (running)") + ".");
      setError("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not change that breaker.");
    }
  }

  async function applyRestriction(wallet: string, kind: string, hours: number): Promise<void> {
    try {
      await setRestriction({
        wallet,
        kind,
        reasonCode: "admin_manual",
        expiresInSec: hours > 0 ? Math.round(hours * 3_600) : undefined,
      });
      setNotice("Restriction " + kind + " placed on " + shortAddress(wallet) + ".");
      setError("");
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not place that restriction.");
    }
  }

  async function liftRestriction(wallet: string, kind: string): Promise<void> {
    try {
      await setRestriction({ wallet, kind, lift: true });
      setNotice("Restriction " + kind + " lifted from " + shortAddress(wallet) + ".");
      setError("");
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not lift that restriction.");
    }
  }

  if (denied) {
    return (
      <section className="admin-screen page-shell">
        <div className="admin-locked">
          <Lock size={22} />
          <h2>Admin access required</h2>
          <p>
            This surface is only reachable by a signed-in wallet listed in the Worker's admin
            configuration. Nothing is loaded for anyone else.
          </p>
        </div>
      </section>
    );
  }

  const breakers = metrics?.breakers ?? [];
  const alerts = metrics?.alerts ?? [];
  const accounts = abuse?.accounts ?? [];
  const metricEntries = metrics ? Object.entries(metrics.metrics) : [];

  return (
    <section className="admin-screen page-shell" id="admin">
      <div className="section-heading">
        <div>
          <div className="eyebrow">
            <ShieldAlert size={14} /> Anti-abuse
          </div>
          <h2>
            OPERATOR
            <br />
            CONSOLE.
          </h2>
        </div>
        <button className="outline-button" disabled={loading} onClick={() => void load()}>
          Refresh <RefreshCw size={13} />
        </button>
      </div>

      <p className="admin-rule">
        Every control here can only slow an account down or halt a queue. No endpoint in this surface
        can move, seize, refund or withdraw funds, and no raw IP, device or session identifier is ever
        returned.
      </p>
      {notice && <p className="form-message admin-notice">{notice}</p>}
      {error && <p className="form-message">{error}</p>}

      <div className="admin-block">
        <div className="admin-block-head">
          <span>
            <Zap size={13} /> CIRCUIT BREAKERS
          </span>
          <small>a reason is required for every change</small>
        </div>
        <input
          className="admin-input"
          placeholder="Reason for this breaker change"
          value={breakReason}
          onChange={(event) => setBreakReason(event.target.value)}
        />
        <div className="admin-breakers">
          {BREAKER_SCOPES.map((entry) => {
            const state = breakers.find((breaker) => breaker.scope === entry.scope) ?? null;
            const open = state?.open ?? false;
            return (
              <article key={entry.scope} className={open ? "is-open" : ""}>
                <div>
                  <strong>{entry.label}</strong>
                  <small>{state ? (open ? "HALTED" : "running") : "no breaker set"}</small>
                </div>
                {entry.needsMint && (
                  <input
                    className="admin-input"
                    placeholder="Mine mint"
                    value={reserveMint}
                    onChange={(event) => setReserveMint(event.target.value)}
                  />
                )}
                <button
                  className={open ? "outline-button" : "danger-button"}
                  onClick={() =>
                    void toggleBreaker(entry.scope, entry.needsMint ? reserveMint : null, !open)
                  }
                >
                  {open ? "Close breaker" : "Open breaker"}
                </button>
                {state?.reason && <p>Last reason: {state.reason}</p>}
              </article>
            );
          })}
        </div>
      </div>

      <div className="admin-block">
        <div className="admin-block-head">
          <span>
            <OctagonAlert size={13} /> METRICS AND ALERTS
          </span>
          <small>{alerts.length} alert(s) firing</small>
        </div>
        {alerts.length > 0 && (
          <ul className="admin-alerts">
            {alerts.map((alert) => (
              <li className={"alert-" + alert.severity} key={alert.name}>
                <strong>{alert.name}</strong>
                <span>
                  {alert.metric} {alert.value.toFixed(2)} ≥ {alert.threshold}
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="admin-metrics">
          {metricEntries.map(([name, value]) => (
            <div key={name}>
              <span>{name}</span>
              <strong>{typeof value === "number" ? value.toFixed(2) : String(value)}</strong>
            </div>
          ))}
          {metricEntries.length === 0 && <p className="admin-empty">No metric snapshot yet.</p>}
        </div>
      </div>

      <div className="admin-block">
        <div className="admin-block-head">
          <span>
            <Ban size={13} /> RESTRICTIONS
          </span>
          <small>restrictions only ever slow an account down</small>
        </div>
        <div className="admin-restriction-form">
          <input
            className="admin-input"
            placeholder="Wallet"
            value={restrictionWallet}
            onChange={(event) => setRestrictionWallet(event.target.value)}
          />
          <select value={restrictionKind} onChange={(event) => setRestrictionKind(event.target.value)}>
            {RESTRICTION_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
          <input
            className="admin-input"
            value={restrictionHours}
            onChange={(event) => setRestrictionHours(event.target.value)}
            placeholder="Hours (0 = no expiry)"
          />
          <button
            className="danger-button"
            disabled={restrictionWallet.trim().length < 32}
            onClick={() => void applyRestriction(restrictionWallet.trim(), restrictionKind, Number(restrictionHours) || 0)}
          >
            Place restriction
          </button>
        </div>
      </div>

      <div className="admin-block">
        <div className="admin-block-head">
          <span>
            <AlertOctagon size={13} /> ANTI-ABUSE ACCOUNTS
          </span>
          <small>{accounts.length} account(s)</small>
        </div>
        <div className="admin-table">
          <div className="admin-row admin-head-row">
            <span>Wallet</span>
            <span>Risk</span>
            <span>Crew</span>
            <span>Discoveries</span>
            <span>Claimed</span>
            <span>Trust</span>
            <span>Linked</span>
            <span>Flags / restrictions</span>
          </div>
          {accounts.map((account) => (
            <div className="admin-row" key={account.wallet}>
              <span title={account.wallet}>{shortAddress(account.wallet)}</span>
              <span>
                {account.riskLevel} / {account.rewardState}
              </span>
              <span>
                tier {account.crewTier} ({account.crewLevel})
              </span>
              <span>{account.discoveries}</span>
              <span>{account.claimedValueUsd.toFixed(2)} USD</span>
              <span>{account.trust.toFixed(0)}</span>
              <span>{account.relatedAccounts}</span>
              <span className="admin-flags">
                {account.flags.map((flag) => (
                  <em key={flag}>{flag}</em>
                ))}
                {account.restrictions.map((restriction) => (
                  <button
                    key={restriction.kind}
                    className="ledger-token"
                    onClick={() => void liftRestriction(account.wallet, restriction.kind)}
                    title="Lift this restriction"
                  >
                    {restriction.kind} ×
                  </button>
                ))}
                {account.flags.length === 0 && account.restrictions.length === 0 && <small>none</small>}
              </span>
            </div>
          ))}
          {accounts.length === 0 && <p className="admin-empty">No accounts matched.</p>}
        </div>
      </div>

      {metrics && metrics.audit.length > 0 && (
        <div className="admin-block">
          <div className="admin-block-head">
            <span>AUDIT TRAIL</span>
            <small>every mutation is recorded</small>
          </div>
          <ul className="admin-audit">
            {metrics.audit.map((entry) => (
              <li key={entry.id}>
                <span>{new Date(entry.created_at * 1_000).toLocaleString()}</span>
                <strong>{entry.action}</strong>
                <em>{entry.target ?? "-"}</em>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
