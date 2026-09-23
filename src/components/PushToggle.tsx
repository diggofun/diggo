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
 */
import { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { Bell, BellOff } from "lucide-react";
import { disablePush, enablePush, pushState, watchSubscriptionRotations, type PushState } from "../push";

type Status = PushState | "checking";

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

export function PushToggle(): ReactElement | null {
  const [status, setStatus] = useState<Status>("checking");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void pushState()
      .then((next) => {
        if (active) setStatus(next);
      })
      .catch(() => {
        if (active) setStatus("off");
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

  const toggle = useCallback(async () => {
    setError("");
    setPending(true);
    try {
      const next = on ? await disablePush() : await enablePush();
      setStatus(next);
      if (next === "blocked") {
        setError("Your browser is blocking notifications for this site. Allow them in your browser settings, then try again.");
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not change alert settings.");
    } finally {
      setPending(false);
    }
  }, [on]);

  // Nothing to offer when the browser cannot deliver a push at all.
  if (status === "checking" || status === "unsupported") return null;

  return (
    <section id="alerts" className="page-shell push-toggle" style={SECTION_STYLE} aria-labelledby="push-toggle-title">
      <div>
        <h2 id="push-toggle-title" style={{ margin: "0 0 var(--space-2)", fontSize: "var(--text-lg)" }}>
          Alerts on this device
        </h2>
        <p style={COPY_STYLE}>
          {on
            ? "On for this browser: a short alert when a mining window is about to close or a discovery is waiting. Turn it off at any time."
            : "Off by default. Turning this on lets Diggo send one short alert when your mining window is closing or a discovery is waiting. Your wallet, rewards and ORE are not affected either way."}
        </p>
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
        disabled={pending}
        onClick={() => void toggle()}
      >
        {on ? <BellOff size={16} /> : <Bell size={16} />}
        {pending ? "Working..." : on ? "Turn alerts off" : "Turn alerts on"}
      </button>
    </section>
  );
}
