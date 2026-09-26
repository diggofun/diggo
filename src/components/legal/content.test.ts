/**
 * The Terms carry compliance copy that nothing in the build would miss if it were deleted: the age
 * floor, the restricted-jurisdiction representations, the clause that makes circumventing them a
 * material breach, and the indemnity that follows from an untrue representation. These tests assert
 * that those clauses are still there, that the sections stay numbered in order, and that the
 * operator's placeholders are still placeholders rather than invented facts.
 */
import { describe, expect, it } from "vitest";
import {
  LEGAL_DOCUMENTS,
  RESTRICTED_JURISDICTIONS_PLACEHOLDER,
  TERMS_UPDATED,
} from "./content";

const terms = LEGAL_DOCUMENTS.terms;
const headings = terms.sections.map((section) => section.heading);
const text = terms.sections
  .flatMap((section) => [section.heading, ...section.paragraphs, ...(section.bullets ?? [])])
  .join("\n");

describe("terms of service compliance clauses", () => {
  it("numbers the sections in order from one", () => {
    headings.forEach((heading, index) => {
      expect(heading.startsWith(index + 1 + ". ")).toBe(true);
    });
    expect(headings.length).toBeGreaterThan(0);
  });

  it("requires adulthood and legal capacity", () => {
    expect(text).toContain("at least 18 years old");
    expect(text).toContain("legal capacity");
  });

  it("makes the restricted-jurisdiction representations a condition of access", () => {
    expect(headings).toContain("4. Restricted jurisdictions");
    expect(text).toContain(RESTRICTED_JURISDICTIONS_PLACEHOLDER);
    for (const sanctioned of [
      "Cuba",
      "Iran",
      "North Korea",
      "Syria",
      "Crimea",
      "Donetsk",
      "Luhansk",
    ]) {
      expect(text).toContain(sanctioned);
    }
    for (const list of [
      "OFAC Specially Designated Nationals",
      "European Union",
      "United Kingdom",
      "United Nations",
    ]) {
      expect(text).toContain(list);
    }
  });

  it("treats circumvention through a VPN or a proxy as a material breach", () => {
    expect(headings).toContain("5. No circumventing the restrictions");
    expect(text).toContain("virtual private network");
    expect(text).toContain("material breach");
  });

  it("puts the law of the user's own location on the user", () => {
    expect(text).toContain("solely responsible for finding out which laws apply to you");
    expect(text).toContain("We make no representation and give no warranty");
  });

  it("keeps the operator's right to restrict access even where it has not used it", () => {
    expect(text).toContain("at our discretion and without notice");
    expect(text).toContain("not acting on one does not waive our right to act");
  });

  it("indemnifies the operator for a representation that turns out to be untrue", () => {
    expect(headings).toContain("16. Indemnity");
    expect(text).toContain("indemnify, defend and hold harmless");
    expect(text).toContain("a representation in section 4, 5 or 6 that is untrue for you");
  });

  it("states that the service is non-custodial and promises no value", () => {
    expect(headings).toContain("13. Non-custodial service and no guaranteed value");
    expect(text).toContain("non-custodial");
    expect(text).toContain("promises value, yield, return, price, liquidity or a buyer");
  });

  it("dates the Terms separately from the documents that were not revised", () => {
    expect(terms.updated).toBe(TERMS_UPDATED);
    expect(LEGAL_DOCUMENTS.privacy.updated).toBe("26 September 2026");
  });
});

describe("session recording disclosure", () => {
  const privacy = LEGAL_DOCUMENTS.privacy;
  const recording = privacy.sections.find((section) => section.heading === "5. Session recording");
  const recordingText = recording
    ? [...recording.paragraphs, ...(recording.bullets ?? [])].join("\n")
    : "";
  const cookiesText = LEGAL_DOCUMENTS.cookies.sections
    .flatMap((section) => [...section.paragraphs, ...(section.bullets ?? [])])
    .join("\n");

  it("numbers the privacy sections in order from one", () => {
    privacy.sections.forEach((section, index) => {
      expect(section.heading.startsWith(index + 1 + ". ")).toBe(true);
    });
  });

  it("has its own section covering provider, consent, masking, identity, basis and rights", () => {
    expect(recording).toBeDefined();
    for (const clause of [
      "PostHog Inc.",
      "hosted in the European Union",
      "'Allow analytics'",
      "'Essential only'",
      "'Change your analytics choice'",
      "Every form input is masked",
      "seed phrases",
      "public address",
      "Article 6(1)(a) GDPR",
      "deleted",
    ]) {
      expect(recordingText).toContain(clause);
    }
  });

  it("is referenced from the cookie notice with the PostHog storage it uses", () => {
    expect(cookiesText).toContain("privacy#session-recording");
    expect(cookiesText).toContain("ph_<project key>_posthog");
    expect(cookiesText).toContain("sessionStorage");
  });
});
