/**
 * Consent banner for non-essential storage (src/components/legal/consent.ts).
 *
 * A compact corner card: two one-click decisions, no dark patterns, and a close button for a player
 * who has read enough. "Essential only" and the close button record the same decision, because
 * dismissing a notice is not consent, and "Allow analytics" is the only route to PostHog
 * (src/analytics.ts). A withdrawal from the Cookie & Storage Notice reopens the card through
 * requestConsentBanner().
 *
 * This banner is not what makes the site work: the session cookie, the random anti-abuse device id
 * and the record of the choice itself are essential and disclosed in the Cookie & Storage Notice.
 */
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { IconClose } from "../icons";
import {
  CONSENT_OPEN_EVENT,
  readConsent,
  recordConsent,
  type ConsentDecision,
} from "./legal/consent";

export function ConsentBanner(): ReactElement | null {
  const [visible, setVisible] = useState(() => readConsent() === null);
  const [current, setCurrent] = useState<ConsentDecision | null>(() => readConsent()?.decision ?? null);

  useEffect(() => {
    const open = () => {
      const record = readConsent();
      setCurrent(record ? record.decision : null);
      setVisible(true);
    };
    window.addEventListener(CONSENT_OPEN_EVENT, open);
    return () => window.removeEventListener(CONSENT_OPEN_EVENT, open);
  }, []);

  // The card floats over the page (styles.css), so the page keeps room for it while it is up and no
  // call to action ends up underneath it.
  useEffect(() => {
    document.body.classList.toggle("has-consent", visible);
    return () => document.body.classList.remove("has-consent");
  }, [visible]);

  const decide = useCallback((decision: ConsentDecision) => {
    recordConsent(decision);
    setCurrent(decision);
    setVisible(false);
  }, []);

  if (!visible) return null;

  return (
    <aside role="region" aria-label="Cookies and storage" className="consent-banner">
      <button
        type="button"
        className="consent-dismiss"
        aria-label="Dismiss — essential storage only"
        onClick={() => decide("essential")}
      >
        <IconClose size={14} />
      </button>
      <div>
        <strong className="consent-banner-title">Cookies and storage</strong>
        <p className="consent-copy">
          A session cookie and a random device id keep Diggo working. Analytics is off unless you
          allow it. The <a href="/cookies">Cookie &amp; Storage Notice</a> has the detail.
          {current !== null && (
            <>
              {" "}
              You chose <strong>{current === "all" ? "allow analytics" : "essential only"}</strong>{" "}
              on this browser.
            </>
          )}
        </p>
      </div>
      <div className="consent-actions">
        <button type="button" className="btn btn-primary" onClick={() => decide("all")}>
          Allow analytics
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => decide("essential")}>
          Essential only
        </button>
      </div>
    </aside>
  );
}

