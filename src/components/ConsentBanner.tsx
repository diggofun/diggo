/**
 * Consent banner for non-essential storage (src/components/legal/consent.ts).
 *
 * Two decisions, no dark patterns: "Essential only" is as prominent as "Allow analytics", both
 * are one click, and neither is hidden behind a settings dialog. Analytics does not start until
 * "Allow analytics" is chosen (src/analytics.ts) and stops again on the next load after a
 * withdrawal, which the legal pages can trigger through requestConsentBanner().
 *
 * This banner is not what makes the site work: the session cookie, the random anti-abuse device id
 * and the record of the choice itself are essential and disclosed in the Cookie & Storage Notice.
 */
import { useCallback, useEffect, useState, type ReactElement } from "react";
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

  const decide = useCallback((decision: ConsentDecision) => {
    recordConsent(decision);
    setCurrent(decision);
    setVisible(false);
  }, []);

  if (!visible) return null;

  return (
    <div role="region" aria-label="Cookies and storage" className="consent-banner">
      <div>
        <strong className="consent-banner-title">Cookies and storage</strong>
        <p className="consent-copy">
          Diggo needs a session cookie, a random device id for anti-abuse, and remembers your
          settings. Analytics is off unless you allow it: nothing is sent to PostHog before that.
          Details are in the <a href="/cookies">Cookie &amp; Storage Notice</a>,{" "}
          <a href="/privacy">Privacy Policy</a> and <a href="/terms">Terms of Service</a>.
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
    </div>
  );
}
