import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getPageSeo, normalizePagePath, pageCanonical, SEO_PAGES } from "../shared/seo";
import { escapeHtml, renderSeoPage, renderSitemap, structuredData } from "./seo";

const template = readFileSync(new URL("../index.html", import.meta.url), "utf8");

describe("static SEO pages", () => {
  it.each(SEO_PAGES.map((seo) => [seo.path, seo] as const))("serves route-specific metadata and content at %s without JavaScript", (path, seo) => {
    const html = renderSeoPage(template, path);
    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(html).toContain(`<title>${escapeHtml(seo.title)}</title>`);
    expect(html).toContain(`<link rel="canonical" href="${pageCanonical(seo)}"`);
    expect(html).toContain(`<meta property="og:url" content="${pageCanonical(seo)}"`);
    expect(html).toContain(`<meta name="twitter:title" content="${escapeHtml(seo.title)}"`);
    expect(html).toContain(`<h1>${escapeHtml(seo.heading)}</h1>`);
    expect(html).toContain(seo.index ? "index, follow, max-image-preview:large" : "noindex, follow");
    expect(html).toContain('src="/src/main.tsx"');
    const json = html.match(/<script type="application\/ld\+json">(.*?)<\/script>/)?.[1];
    const data = JSON.parse(json!);
    expect(data["@graph"].find((entity: { "@type": string }) => entity["@type"] === "WebPage").url).toBe(pageCanonical(seo));
  });

  it("lists only indexable canonical pages in the sitemap", () => {
    const locations = [...renderSitemap().matchAll(/<loc>(.*?)<\/loc>/g)].map((match) => match[1]);
    expect(locations).toEqual(SEO_PAGES.filter((seo) => seo.index).map(pageCanonical));
    expect(new Set(locations).size).toBe(locations.length);
    expect(locations).not.toContain("https://diggo.fun/admin");
    expect(locations).not.toContain("https://diggo.fun/profile");
    expect(readFileSync(new URL("../public/robots.txt", import.meta.url), "utf8")).toContain("Sitemap: https://diggo.fun/sitemap.xml");
  });

  it("canonicalizes trailing slashes and the portfolio alias", () => {
    expect(normalizePagePath("/mine/")).toBe("/mine");
    expect(getPageSeo("/explore/")).toEqual(getPageSeo("/explore"));
    const seo = getPageSeo("/portfolio");
    expect(seo.index).toBe(false);
    expect(pageCanonical(seo)).toBe("https://diggo.fun/profile");
    expect(getPageSeo("/unknown").index).toBe(false);
  });

  it("includes legal document text, not just an empty app shell", () => {
    expect(renderSeoPage(template, "/privacy")).toContain("<section><h2>");
    expect(renderSeoPage(template, "/terms")).toContain("Eligibility and legal capacity");
  });

  it("escapes HTML attributes and closing script tags in JSON-LD", () => {
    expect(escapeHtml('<img src="x"> &')).toBe("&lt;img src=&quot;x&quot;&gt; &amp;");
    const seo = { ...SEO_PAGES[0]!, title: "</script><script>alert(1)</script>" };
    const json = structuredData(seo);
    expect(json).not.toContain("</script>");
    expect(JSON.parse(json)["@graph"][2].name).toBe(seo.title);
  });

  it("fails the build if the HTML template loses its SEO markers", () => {
    expect(() => renderSeoPage("<html></html>", "/")).toThrow("Missing SEO head markers");
  });
});
