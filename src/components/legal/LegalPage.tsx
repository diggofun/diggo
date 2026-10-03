/**
 * The legal pages: /terms, /privacy, /risk and /cookies.
 *
 * Deliberately plain and readable without JavaScript-dependent decoration, because a legal notice
 * that is hard to read is worse than useless. Every page carries the document
 * title, the revision date, the section list and the two controls that belong next to the text
 * rather than behind a settings dialog: change your analytics choice, and reset this browser's
 * device id (src/device.ts, the anti-abuse identifier described in the Privacy Policy).
 *
 * The copy itself lives in content.ts; this module only renders it.
 */
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { resetDeviceId } from "../../device";
import {
  hasAnalyticsConsent,
  readConsent,
  requestConsentBanner,
  subscribeConsent,
  type ConsentDecision,
} from "./consent";
import { LEGAL_DOCUMENTS, type LegalSection } from "./content";
import { LEGAL_ROUTES, legalDocId } from "./routes";

/** A stable anchor for a section, from its heading without the number: "5. Session recording" -> "session-recording". */
function sectionAnchor(heading: string): string {
  return heading
    .replace(/^\d+\.\s*/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function Section({ section }: { section: LegalSection }): ReactElement {
  const anchor = sectionAnchor(section.heading);
  return (
    <section aria-labelledby={anchor}>
      <h2 id={anchor} className="legal-section-heading">
        {section.heading}
      </h2>
      {section.paragraphs.map((paragraph, paragraphIndex) => (
        <p key={paragraphIndex}>
          {paragraph}
        </p>
      ))}
      {section.bullets !== undefined && section.bullets.length > 0 && (
        <ul className="legal-list">
          {section.bullets.map((bullet, bulletIndex) => (
            <li key={bulletIndex}>{bullet}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function LegalRoute({ pathname }: { pathname: string }): ReactElement {
  const docId = legalDocId(pathname);
  const doc = docId === null ? null : LEGAL_DOCUMENTS[docId];
  const [decision, setDecision] = useState<ConsentDecision | null>(() => readConsent()?.decision ?? null);
  const [deviceIdReset, setDeviceIdReset] = useState(false);

  useEffect(() => {
    const previous = window.document.title;
    window.document.title = doc === null ? "Diggo.fun" : doc.title + " | Diggo.fun";
    return () => {
      window.document.title = previous;
    };
  }, [doc]);

  // Subscribing rather than reading once: a choice made in the banner updates this page live.
  useEffect(() => subscribeConsent((record) => setDecision(record ? record.decision : null)), []);

  const resetIdentifier = useCallback(() => {
    resetDeviceId();
    setDeviceIdReset(true);
  }, []);

  if (doc === null) {
    return (
      <div className="legal-page">
        <h1 className="legal-title">Not found</h1>
        <p>
          There is no document at this address. <a href="/">Back to Diggo.fun</a>.
        </p>
      </div>
    );
  }

  return (
    <article className="legal-page" data-legal-document={doc.id}>
      <h1 className="legal-title">{doc.title}</h1>
      <p className="legal-summary">{doc.summary}</p>
      <p className="legal-meta">Version: {doc.updated}</p>

      <nav className="legal-nav" aria-label="Legal documents">
        {LEGAL_ROUTES.map((route) => (
          <a
            key={route.id}
            href={route.path}
            aria-current={route.id === doc.id ? "page" : undefined}
          >
            {route.short}
          </a>
        ))}
      </nav>

      <nav className="legal-toc" aria-label="Contents">
        <h2 className="legal-toc-title">Contents</h2>
        <ol className="legal-list legal-toc-list">
          {doc.sections.map((section) => (
            <li key={section.heading}>
              <a href={"#" + sectionAnchor(section.heading)}>{section.heading.replace(/^\d+\.\s*/, "")}</a>
            </li>
          ))}
        </ol>
      </nav>

      {doc.sections.map((section) => (
        <Section key={section.heading} section={section} />
      ))}

      <div className="legal-choices">
        <h2>Your choices</h2>
        <p>
          Analytics is currently{" "}
          <strong>{hasAnalyticsConsent() ? "allowed" : "off (essential storage only)"}</strong>.
          Essential storage stays on because the game cannot run without it: the session cookie and
          the anti-abuse device id are described above.
        </p>
        <div className="legal-actions">
          <button type="button" className="btn btn-primary" onClick={requestConsentBanner}>
            Change your analytics choice
          </button>
          <button type="button" className="btn btn-ghost" onClick={resetIdentifier}>
            Reset this browser's device id
          </button>
        </div>
        <p className="legal-choices-note">
          {decision === null
            ? "You have not made a choice in this browser yet."
            : "Last choice recorded in this browser: " + (decision === "all" ? "allow analytics" : "essential only") + "."}
          {deviceIdReset && " A new device id has been created for this browser."}
        </p>
      </div>
    </article>
  );
}

export default LegalRoute;
