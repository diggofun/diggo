/**
 * Per-device opt-in for mining alerts (worker/push.ts, src/push.ts).
 *
 * Off by default and silent about it: with no subscription there is no permission prompt, no
 * service worker registration and no server row. The switch is only rendered when the browser can
 * actually deliver a push, and the copy tells the player exactly what turning it on does - a short
 * alert when a mining window is closing or a discovery is waiting, nothing about their account.
 *
 * Turning it off is the same click: src/push.ts deletes the server row, then drops the browser
 * subscription, so nothing is left receiving alerts.
 *
 * One switch, two presentations. "section" is the standalone block on the page; "inline" is the
 * compact row the notification bell renders inside its dropdown, so the opt-in sits next to the
 * alerts it controls. Both read and write the same state through src/push.ts, and both stay silent
 * about the wallet, the rewards and the ORE balance.
 */
import { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { track } from "../analytics";
import { alertsAvailable, disablePush, enablePush, pushState, watchSubscriptionRotations, type PushState } from "../push";

type Status = PushState | "checking";

export interface PushToggleProps {
  /**
   * "section" renders the standalone page block, "inline" the compact row inside the bell dropdown.
   */
  variant?: "section" | "inline";
}

const SECTION_STYLE: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-4)",
  paddingTop: "var(--space-5)",
  paddingBottom: "var(--space-5)",
  borderTop: "1px solid var(--line)",
};

const COPY_STYLE: CSSProperties = {
  margin: 0,
  maxWidth: "62ch",
  color: "var(--muted)",
  fontSize: "var(--text-sm)",
  lineHeight: 1.6,
};

const ERROR_STYLE: CSSProperties = {
  margin: "var(--space-2) 0 0",
  color: "var(--danger)",
  fontSize: "var(--text-sm)",
  fontWeight: 700,
};

/**
 * Pinned to the bottom of the bell dropdown so the opt-in stays reachable under a long list.
 *
 * The row wraps instead of pushing the panel wider: the switch drops onto its own line when the
 * copy and the button no longer fit side by side, which is what a narrow panel and a long note
 * ("Your browser is blocking notifications for this site.") ask for.
 */
const INLINE_ROW_STYLE: CSSProperties = {
  position: "sticky",
  bottom: 0,
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-3)",
  minWidth: 0,
  padding: "var(--space-4)",
  background: "var(--paper)",
  borderTop: "1px solid var(--ink)",
};

const INLINE_TEXT_STYLE: CSSProperties = {
  display: "grid",
  gap: "2px",
  flex: "1 1 180px",
  minWidth: 0,
};

const INLINE_TITLE_STYLE: CSSProperties = {
  font: "900 10px monospace",
  textTransform: "uppercase",
  letterSpacing: ".08em",
};

const INLINE_NOTE_STYLE: CSSProperties = {
  color: "var(--muted)",
  font: "700 9px monospace",
  lineHeight: 1.5,
  overflowWrap: "anywhere",
};

const INLINE_ERROR_STYLE: CSSProperties = {
  color: "var(--danger)",
  font: "700 9px monospace",
  overflowWrap: "anywhere",
};

export function PushToggle({ variant = "section" }: PushToggleProps): ReactElement | null {
  const [status, setStatus] = useState<Status>("checking");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  // null until known: a failed probe leaves the switch usable and lets the click report the reason.
  const [serverConfigured, setServerConfigured] = useState<boolean | null>(null);
  const inline = variant === "inline";

  useEffect(() => {
    let active = true;
    void pushState()
      .then((next) => {
        if (active) setStatus(next);
      })
      .catch(() => {
        if (active) setStatus("off");
      });
    void alertsAvailable()
      .then((key) => {
        if (active) setServerConfigured(key.enabled);
      })
      .catch(() => {
        if (active) setServerConfigured(null);
      });
    return () => {
      active = false;
    };
  }, []);

  // A rotated endpoint means the old subscription is dead; re-reading the state keeps the switch
  // honest, and the next interaction re-registers this device.
  useEffect(
    () =>
      watchSubscriptionRotations(() => {
        void pushState()
          .then(setStatus)
          .catch(() => undefined);
      }),
    [],
  );

  const on = status === "on";
  // A device that is already subscribed can always be switched off, even if the server has since
  // lost its VAPID keys - otherwise the player would be stuck with alerts they cannot stop.
  const blocked = status === "unsupported" || status === "blocked";

  const toggle = useCallback(async () => {
    setError("");
    setPending(true);
    try {
      const next = on ? await disablePush() : await enablePush();
      setStatus(next);
      if (!on && next === "on") track("alerts_enabled");
      if (on && next !== "on") track("alerts_disabled");
      if (next === "blocked") {
        setError("Your browser is blocking notifications for this site. Allow them in your browser settings, then try again.");
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not change alert settings.");
    } finally {
      setPending(false);
    }
  }, [on]);

  if (status === "checking") return null;

  /**
   * A server with no push configuration has nothing to offer here. The block is hidden outright
   * rather than rendered as a dead switch with a developer-facing explanation on it.
   */
  if (serverConfigured === false && !on) return null;

  function statusNote(compact: boolean): string {
    if (status === "unsupported") {
      return compact ? "This browser cannot show push alerts." : "This browser cannot show push alerts.";
    }
    if (status === "blocked") return "Your browser is blocking notifications for this site.";
    if (compact) {
      return on ? "On for this browser." : "Off. One alert when a window closes or a discovery lands.";
    }
    return on
      ? "On for this browser: a short alert when a mining window is about to close or a discovery is waiting."
      : "One short alert when your mining window is closing or a discovery is waiting.";
  }

  if (inline) {
    return (
      <div className="notifications-push" style={INLINE_ROW_STYLE}>
        <div style={INLINE_TEXT_STYLE}>
          <strong style={INLINE_TITLE_STYLE}>Push alerts</strong>
          <span style={INLINE_NOTE_STYLE}>{statusNote(true)}</span>
          {error.length > 0 && (
            <span role="alert" style={INLINE_ERROR_STYLE}>
              {error}
            </span>
          )}
        </div>
        <button
          type="button"
          className={on ? "btn btn-ghost" : "btn btn-primary"}
          aria-pressed={on}
          disabled={pending || blocked}
          onClick={() => void toggle()}
        >
          {pending ? "Working..." : on ? "Off" : "On"}
        </button>
      </div>
    );
  }

  // Nothing to offer as a page section when the browser cannot deliver a push at all.
  if (status === "unsupported") return null;

  return (
    <section id="alerts" className="page-shell push-toggle" style={SECTION_STYLE} aria-labelledby="push-toggle-title">
      <div>
        <h2 id="push-toggle-title" style={{ margin: "0 0 var(--space-2)", fontSize: "var(--text-lg)" }}>
          Alerts on this device
        </h2>
        <p style={COPY_STYLE}>{statusNote(false)}</p>
        {error.length > 0 && (
          <p role="alert" style={ERROR_STYLE}>
            {error}
          </p>
        )}
      </div>
      <button
        type="button"
        className={on ? "btn btn-ghost" : "btn btn-primary"}
        aria-pressed={on}
        disabled={pending || blocked}
        onClick={() => void toggle()}
      >
        {pending ? "Working..." : on ? "Turn alerts off" : "Turn alerts on"}
      </button>
    </section>
  );
}
