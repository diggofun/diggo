/**
 * Anti-abuse admin surface (spec 63, 65-67).
 *
 * The page only renders for a wallet the Worker accepts as an admin: both endpoints answer 401 for
 * anyone else, and a 401 turns this route into a locked notice instead of an empty dashboard.
 *
 * Two things changed with the hardening pass. Every mutation now carries a fresh wallet signature
 * over the action *and* the payload it authorises, so an admin session alone can never place a
 * restriction, flip a breaker or decide an appeal; this screen asks the Worker for the message,
 * signs it and sends both. And because the game launches with score decisions recorded rather than
 * enforced, the console says out loud which mode it is in and shows, per account, what the score
 * would have done.
 *
 * What an operator can do here is still deliberately narrow: read the anonymous anti-abuse view,
 * read the metric set and its alerts, place or lift a restriction, open or close a circuit breaker,
 * and decide appeals. Every control can only slow an account down or stop doing so - none of them
 * can move, seize or redirect value, because no endpoint exists that could.
 */
import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import {
  ApiError,
  adminSignedRequest,
  getAdminAbuseView,
  getAdminAppeals,
  getAdminMetrics,
  type AdminAbuseView,
  type AdminAppeal,
  type AdminMetrics,
} from "../api";
import { shortAddress } from "../format";
import { IconReject } from "../icons";
import { useDiggoWallet } from "../wallet";

/**
 * The sponsor console pulls in the on-chain client, so it is loaded only when an operator opens
 * the admin screen rather than on every page.
 */
const SponsorEventsPanel = lazy(() =>
  import("./SponsorEventsPanel").then((module) => ({ default: module.SponsorEventsPanel })),
);

export interface AdminScreenProps {
  signedIn: boolean;
  /**
   * The deployed program id, so the sponsor section can build its instructions. Omitted means the
   * cluster has not been configured yet, and the sponsor section says so instead of rendering a
   * button that cannot work.
   */
  programId?: string;
}

/** Mirrors the Worker's BREAKER_SCOPES; discovery_reserve is per mine. */
const BREAKER_SCOPES: { scope: string; label: string; needsMint: boolean }[] = [
  { scope: "discoveries", label: "New discoveries", needsMint: false },
  { scope: "claims", label: "All claims", needsMint: false },
  { scope: "discovery_reserve", label: "One mine's discovery reserve", needsMint: true },
];

/** Mirrors the Worker's RESTRICTION_KINDS. */
const RESTRICTION_KINDS = ["ACCOUNT_BLOCK", "CLAIM_HOLD", "DISCOVERY_BLOCK", "CHALLENGE_REQUIRED", "RATE_LIMIT"];

const APPEAL_FILTERS = ["OPEN", "ACCEPTED", "REJECTED", "ALL"] as const;

function reasonFromTemplate(scope: string): string {
  return "Operator action on " + scope + " from /admin";
}

function formatStamp(seconds: number | null): string {
  return seconds === null ? "-" : new Date(seconds * 1_000).toLocaleString();
}

/**
 * The claimed column's one decision (spec 67).
 *
 * adminAbuse answers with three things about an account's claimed value: the lamport sum the indexer
 * totalled, that sum converted to USD at the display rate, and whether the rate existed at all. The
 * conversion is zero when the oracle had no SOL/USD quote, and "0.00 USD" reads like an account that
 * claimed nothing rather than like a rate that was missing. So the USD figure is printed only when
 * the Worker says the rate was real; otherwise the exact lamport sum carries the column, in SOL, and
 * the missing rate is named beside it.
 */
export interface ClaimedValueFields {
  /** The converted figure, which is 0 whenever `usdPriceAvailable` is false. */
  claimedValueUsd: number;
  /** The exact sum as a decimal string, so no float stands between the indexer and the screen. */
  claimedValueLamports?: string;
  /** Whether the oracle supplied the SOL/USD rate the conversion used. */
  usdPriceAvailable?: boolean;
}

export interface ClaimedValueDisplay {
  /** The figure the cell prints. */
  value: string;
  /** A note beside it, naming the missing rate when only the exact figure could be shown. */
  note: string | null;
  /** The exact lamport sum and the provenance of the conversion, for the cell's tooltip. */
  title: string;
}

const LAMPORTS_PER_SOL = 1_000_000_000n;

const USD_UNAVAILABLE = "USD unavailable";

/** Said once, so the tooltip and the note beside it cannot drift apart. */
const NO_RATE_REASON = "no SOL/USD rate was reported";

/**
 * Lamports as an exact SOL string: "3000000000" becomes "3", "1" becomes "0.000000001". Anything
 * that is not a lamport count reads as null, so a caller can say the value is unknown rather than
 * print a figure it invented.
 */
export function lamportsToExactSol(lamports: string): string | null {
  const digits = lamports.trim();
  if (!/^\d+$/.test(digits)) return null;
  const total = BigInt(digits);
  const whole = (total / LAMPORTS_PER_SOL).toLocaleString("en");
  const fraction = (total % LAMPORTS_PER_SOL).toString().padStart(9, "0").replace(/0+$/, "");
  return fraction.length > 0 ? whole + "." + fraction : whole;
}

/** The exact count for a tooltip, e.g. "3,000,000,000 lamports". Null when it is not a count. */
function lamportCount(lamports: string): string | null {
  const digits = lamports.trim();
  if (!/^\d+$/.test(digits)) return null;
  return BigInt(digits).toLocaleString("en") + " lamports";
}

export function claimedValueDisplay(account: ClaimedValueFields): ClaimedValueDisplay {
  const lamports = account.claimedValueLamports ?? "";
  const exact = lamportsToExactSol(lamports);
  const count = lamportCount(lamports);
  if (account.usdPriceAvailable === true && Number.isFinite(account.claimedValueUsd)) {
    return {
      value: account.claimedValueUsd.toFixed(2) + " USD",
      note: null,
      title: (count ?? "The claimed value") + " converted at the display SOL/USD rate",
    };
  }
  if (exact === null) {
    return {
      value: USD_UNAVAILABLE,
      note: null,
      title: "No claimed value can be shown: " + NO_RATE_REASON + ", and no exact lamport sum either",
    };
  }
  return {
    value: exact + " SOL",
    note: USD_UNAVAILABLE,
    title: (count === null ? exact + " SOL" : count) + " · " + NO_RATE_REASON + ", so the exact claimed amount is shown in SOL",
  };
}

/** One claimed-value cell: the exact figure, and the name of the rate that was missing. */
export function ClaimedCell({ account }: { account: ClaimedValueFields }) {
  const claimed = claimedValueDisplay(account);
  return (
    <span title={claimed.title}>
      {claimed.value}
      {claimed.note !== null && (
        <>
          {" "}
          <em className="mono-label">{claimed.note}</em>
        </>
      )}
    </span>
  );
}

export function AdminScreen({ signedIn, programId }: AdminScreenProps) {
  const connected = useDiggoWallet();
  const [abuse, setAbuse] = useState<AdminAbuseView | null>(null);
  const [metrics, setMetrics] = useState<AdminMetrics | null>(null);
  const [appeals, setAppeals] = useState<AdminAppeal[]>([]);
  const [appealFilter, setAppealFilter] = useState<(typeof APPEAL_FILTERS)[number]>("OPEN");
  const [liftSelection, setLiftSelection] = useState<Record<string, string[]>>({});
  const [resolutionNote, setResolutionNote] = useState("");
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
      const [abuseResult, metricsResult, appealsResult] = await Promise.all([
        getAdminAbuseView(50),
        getAdminMetrics(),
        getAdminAppeals(appealFilter),
      ]);
      setAbuse(abuseResult);
      setMetrics(metricsResult);
      setAppeals(appealsResult.appeals);
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
  }, [signedIn, appealFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Signs one admin mutation (spec 65). The Worker issues a two minute message bound to this
   * action and this exact payload; the signature is single use, so every change asks again.
   */
  const adminMutation = useCallback(
    async <T,>(path: string, action: string, payload: Record<string, unknown>): Promise<T> => {
      if (!connected) throw new Error("Connect the admin wallet to sign this change");
      return adminSignedRequest<T>(path, action, payload, (message) => connected.signMessage(message));
    },
    [connected],
  );

  async function toggleBreaker(scope: string, mint: string | null, open: boolean): Promise<void> {
    const reason = breakReason.trim().length > 0 ? breakReason.trim() : reasonFromTemplate(scope);
    const payload: Record<string, unknown> = {
      scope,
      open,
      reason,
      ...(scope === "discovery_reserve" && mint ? { mint } : {}),
    };
    try {
      const result = await adminMutation<{ breakers: AdminMetrics["breakers"] }>(
        "/api/admin/breakers",
        open ? "breaker.open" : "breaker.close",
        payload,
      );
      setMetrics((current) => (current ? { ...current, breakers: result.breakers } : current));
      setNotice(scope + " is now " + (open ? "open (halted)" : "closed (running)") + ".");
      setError("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not change that breaker.");
    }
  }

  async function applyRestriction(wallet: string, kind: string, hours: number): Promise<void> {
    try {
      await adminMutation("/api/admin/restrictions", "restriction.set", {
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
      await adminMutation("/api/admin/restrictions", "restriction.lift", { wallet, kind, lift: true });
      setNotice("Restriction " + kind + " lifted from " + shortAddress(wallet) + ".");
      setError("");
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not lift that restriction.");
    }
  }

  /**
   * Decides one appeal. Accepting can lift restrictions the operator ticked explicitly - and that
   * is the limit of what it can do: no funds, no rewards, no state of its own (spec 65).
   */
  async function decideAppeal(appeal: AdminAppeal, resolution: "accepted" | "rejected"): Promise<void> {
    const liftKinds = resolution === "accepted" ? liftSelection[appeal.id] ?? [] : [];
    try {
      const result = await adminMutation<{ lifted: string[] }>("/api/admin/appeals", "appeal.resolve", {
        id: appeal.id,
        resolution,
        note: resolutionNote.trim(),
        liftKinds,
      });
      setNotice(
        "Appeal from " +
          shortAddress(appeal.wallet) +
          " " +
          resolution +
          (result.lifted.length > 0 ? " (lifted " + result.lifted.join(", ") + ")" : "") +
          ".",
      );
      setError("");
      setResolutionNote("");
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not decide that appeal.");
    }
  }

  function toggleLift(appealId: string, kind: string): void {
    setLiftSelection((current) => {
      const selected = current[appealId] ?? [];
      return {
        ...current,
        [appealId]: selected.includes(kind) ? selected.filter((entry) => entry !== kind) : [...selected, kind],
      };
    });
  }

  if (denied) {
    return (
      <section className="admin-screen page-shell">
        <div className="admin-locked">
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
  const shadowMode = abuse?.enforcement.mode !== "enforce";

  return (
    <section className="admin-screen page-shell" id="admin">
      <div className="section-heading">
        <div>
          <div className="eyebrow">
            Anti-abuse
          </div>
          <h2>
            OPERATOR
            <br />
            CONSOLE.
          </h2>
        </div>
        <button className="btn btn-ghost" disabled={loading} onClick={() => void load()}>
          Refresh
        </button>
      </div>

      <p className="admin-rule">
        Every control here can only slow an account down or halt a queue. No endpoint in this surface
        can move, seize, refund or withdraw funds, and no raw IP, device or session identifier is ever
        returned. Every change also has to be signed by the admin wallet, for that change only.
      </p>

      {abuse && (
        <p className={shadowMode ? "badge badge-paused" : "badge badge-active"}>
          <i />
          {shadowMode ? "shadow mode" : "enforce mode"}
          <span className="mono-label">
            {shadowMode
              ? "score decisions are recorded, not enforced"
              : "score decisions are applied to players"}
          </span>
          {abuse.enforcement.shadowedAccounts > 0 && (
            <span className="mono-label">{abuse.enforcement.shadowedAccounts} account(s) shadowed below</span>
          )}
        </p>
      )}

      {notice && <p className="form-message admin-notice">{notice}</p>}
      {error && (
        <div className="error-state">
          <div>
            <strong>That change did not go through</strong>
            <p>{error}</p>
          </div>
        </div>
      )}

      <div className="admin-block">
        <div className="admin-block-head">
          <span>
            APPEALS
          </span>
          <small>{appeals.length} appeal(s) in this view</small>
        </div>
        <div className="admin-restriction-form">
          <select
            value={appealFilter}
            onChange={(event) => setAppealFilter(event.target.value as (typeof APPEAL_FILTERS)[number])}
          >
            {APPEAL_FILTERS.map((filter) => (
              <option key={filter} value={filter}>
                {filter}
              </option>
            ))}
          </select>
          <input
            className="admin-input"
            placeholder="Resolution note (stored on the appeal)"
            value={resolutionNote}
            onChange={(event) => setResolutionNote(event.target.value)}
          />
        </div>
        {/* Reuses the existing admin card grid: the appeals queue is styled by the same rules. */}
        <div className="admin-breakers">
          {appeals.map((appeal) => {
            const restrictions =
              accounts.find((account) => account.wallet === appeal.wallet)?.restrictions ?? [];
            const selected = liftSelection[appeal.id] ?? [];
            return (
              <article key={appeal.id} className={appeal.status === "OPEN" ? "is-open" : ""}>
                <div>
                  <strong title={appeal.wallet}>{shortAddress(appeal.wallet)}</strong>
                  <span className={appeal.status === "OPEN" ? "badge badge-paused" : "badge badge-idle"}>
                    {appeal.status}
                  </span>
                </div>
                <small className="mono-label">
                  filed {formatStamp(appeal.createdAt)} in state {appeal.stateAtSubmission}
                  {appeal.resolvedAt !== null && " · decided " + formatStamp(appeal.resolvedAt)}
                  {appeal.resolvedBy !== null && " by " + shortAddress(appeal.resolvedBy)}
                </small>
                <p>{appeal.message}</p>
                {appeal.resolutionNote && <p className="mono-label">note: {appeal.resolutionNote}</p>}
                {appeal.status === "OPEN" && (
                  <div className="admin-flags">
                    {restrictions.length > 0 ? (
                      <div className="admin-flags">
                        <small className="mono-label">lift on accept:</small>
                        {restrictions.map((restriction) => (
                          <button
                            key={restriction.kind}
                            className={
                              "btn btn-sm " + (selected.includes(restriction.kind) ? "btn-dark" : "btn-ghost")
                            }
                            onClick={() => toggleLift(appeal.id, restriction.kind)}
                          >
                            {restriction.kind}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <small className="mono-label">no live restriction to lift</small>
                    )}
                    <div className="admin-flags">
                      <button className="btn btn-primary btn-sm" onClick={() => void decideAppeal(appeal, "accepted")}>
                        Accept
                      </button>
                      <button className="btn btn-ghost btn-sm" onClick={() => void decideAppeal(appeal, "rejected")}>
                        Reject <IconReject size={13} />
                      </button>
                    </div>
                  </div>
                )}
              </article>
            );
          })}
          {appeals.length === 0 && <p className="admin-empty">No appeals in this view.</p>}
        </div>
      </div>

      <div className="admin-block">
        <div className="admin-block-head">
          <span>
            CIRCUIT BREAKERS
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
                  className={open ? "btn btn-ghost" : "btn btn-primary"}
                  onClick={() => void toggleBreaker(entry.scope, entry.needsMint ? reserveMint : null, !open)}
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
            METRICS AND ALERTS
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
            RESTRICTIONS
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
            className="btn btn-primary"
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
            ANTI-ABUSE ACCOUNTS
          </span>
          <small>{accounts.length} account(s)</small>
        </div>
        <div className="admin-table">
          <div className="admin-row admin-head-row">
            <span>Wallet</span>
            <span>Risk</span>
            <span>Crew</span>
            <span>Discoveries</span>
            <span title="Exact claimed value: USD at the display rate while the oracle answers, otherwise the exact amount in SOL">
              Claimed
            </span>
            <span>Trust</span>
            <span>Linked</span>
            <span>Flags / restrictions</span>
          </div>
          {accounts.map((account) => (
            <div className="admin-row" key={account.wallet}>
              <span title={account.wallet}>{shortAddress(account.wallet)}</span>
              <span>
                {account.riskLevel} / {account.rewardState}
                {account.shadowed && (
                  <>
                    {" "}
                    <em className="mono-label" title="What the score asked for while shadowing">
                      {account.computedState}
                    </em>
                  </>
                )}
              </span>
              <span>
                tier {account.crewTier} ({account.crewLevel})
              </span>
              <span>{account.discoveries}</span>
              <ClaimedCell account={account} />
              <span>{account.trust.toFixed(0)}</span>
              <span>{account.relatedAccounts}</span>
              <span className="admin-flags">
                {account.flags.map((flag) => (
                  <em key={flag}>{flag}</em>
                ))}
                {account.restrictions.map((restriction) => (
                  <button
                    key={restriction.kind}
                    className="btn btn-ghost btn-sm"
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
            <small>every mutation is recorded, with the signature that authorised it</small>
          </div>
          <ul className="admin-audit">
            {metrics.audit.map((entry) => (
              <li key={entry.id}>
                <span>{formatStamp(entry.created_at)}</span>
                <strong>{entry.action}</strong>
                <em>{entry.target ?? "-"}</em>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/*
        Sponsorship is the one admin surface that is not governance: the vault belongs to the
        operator's own wallet, holds lamports, and has no program authority. It lives on this
        screen because it is an operator tool, and it is separated from the abuse tooling above
        because a sponsor event cannot touch a player's power, rewards or discovery odds.
      */}
      <div className="admin-block">
        <div className="admin-block-head">
          <span>SPONSORSHIP</span>
          <small>rent and fee subsidies, paid from your own vault</small>
        </div>
        {programId ? (
          <Suspense fallback={<p className="admin-empty">Loading the sponsor console…</p>}>
            <SponsorEventsPanel programAddress={programId} wallet={connected?.wallet ?? null} />
          </Suspense>
        ) : (
          <p className="admin-empty">This cluster has no program id configured yet.</p>
        )}
      </div>
    </section>
  );
}
