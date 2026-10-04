import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import { getPageSeo, pageCanonical, SEO_PAGES, SITE_URL, type PageSeo } from "../shared/seo";
import { LEGAL_DOCUMENTS } from "../src/components/legal/content";
import { legalDocId } from "../src/components/legal/routes";

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

export function structuredData(seo: PageSeo): string {
  const data = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": SITE_URL + "/#organization",
        name: "Diggo.fun",
        url: SITE_URL + "/",
        logo: SITE_URL + "/assets/brand/icon-192.png",
        sameAs: ["https://x.com/Diggo_Fun"],
      },
      {
        "@type": "WebSite",
        "@id": SITE_URL + "/#website",
        name: "Diggo.fun",
        url: SITE_URL + "/",
        description: SEO_PAGES[0]!.description,
        inLanguage: "en",
        publisher: { "@id": SITE_URL + "/#organization" },
      },
      {
        "@type": "WebPage",
        "@id": pageCanonical(seo) + "#webpage",
        url: pageCanonical(seo),
        name: seo.title,
        description: seo.description,
        inLanguage: "en",
        isPartOf: { "@id": SITE_URL + "/#website" },
      },
    ],
  };
  // JSON-LD is data, but a literal closing script tag must still never reach HTML parsing.
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

function seoHead(seo: PageSeo): string {
  const title = escapeHtml(seo.title);
  const description = escapeHtml(seo.description);
  const url = escapeHtml(pageCanonical(seo));
  const image = SITE_URL + "/og-image-v4.jpg";
  const imageAlt = "The Diggo banner: the word diggo, each letter a little bot, the last one holding a pickaxe.";
  return `
    <title>${title}</title>
    <meta name="description" content="${description}" />
    <meta name="robots" content="${seo.index ? "index, follow, max-image-preview:large" : "noindex, follow"}" />
    <link rel="canonical" href="${url}" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="Diggo.fun" />
    <meta property="og:locale" content="en_US" />
    <meta property="og:title" content="${title}" />
    <meta property="og:description" content="${description}" />
    <meta property="og:url" content="${url}" />
    <meta property="og:image" content="${image}" />
    <meta property="og:image:secure_url" content="${image}" />
    <meta property="og:image:type" content="image/jpeg" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:image:alt" content="${imageAlt}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:site" content="@Diggo_Fun" />
    <meta name="twitter:creator" content="@Diggo_Fun" />
    <meta name="twitter:title" content="${title}" />
    <meta name="twitter:description" content="${description}" />
    <meta name="twitter:image" content="${image}" />
    <meta name="twitter:image:alt" content="${imageAlt}" />
    <script type="application/ld+json">${structuredData(seo)}</script>
  `;
}

function initialContent(seo: PageSeo): string {
  let content = `<h1>${escapeHtml(seo.heading)}</h1><p>${escapeHtml(seo.description)}</p>`;
  const docId = legalDocId(seo.path);
  if (docId) {
    const doc = LEGAL_DOCUMENTS[docId];
    content = `<h1>${escapeHtml(doc.title)}</h1><p>${escapeHtml(doc.summary)}</p><p>Version: ${escapeHtml(doc.updated)}</p>`;
    content += doc.sections.map((section) => `<section><h2>${escapeHtml(section.heading)}</h2>${section.paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("")}${section.bullets ? `<ul>${section.bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join("")}</ul>` : ""}</section>`).join("");
  } else if (seo.path === "/") {
    content += `<section><h2>Memecoins to earn. Coins to launch.</h2><p>Start a 24-hour shift and collect memecoins while your bots work. Upgrade with ORE to increase your mining power. Creators can launch fixed-supply coins on Solana with Meteora trading.</p></section>
      <section><h2>How to earn memecoins.</h2><p>Connect your wallet, activate a mining shift and earn while you are away. View your discoveries and claim eligible SPL memecoins to your wallet. Coins on their bonding curve pay out once they graduate.</p></section>
      <section><h2>Upgrade your mining power</h2><p>ORE and Mining Power are game progress only. They cannot be bought, sold or withdrawn. Memecoins can go to zero.</p></section>`;
  }
  const links = SEO_PAGES.filter((entry) => entry.index).map((entry) => `<a href="${entry.path}">${escapeHtml(entry.path === "/" ? "Home" : entry.heading)}</a>`).join(" · ");
  return `<div id="root"><main class="page-shell legal-page">${content}<nav aria-label="Diggo pages">${links}</nav><noscript><p>Enable JavaScript to connect a wallet, play or trade.</p></noscript></main></div>`;
}

/** Same HTML for people and crawlers; React replaces this static introduction when it starts. */
export function renderSeoPage(template: string, pathname: string): string {
  const seo = getPageSeo(pathname);
  const replaceSection = (html: string, name: string, content: string): string => {
    const pattern = new RegExp(`<!--seo-${name}:start-->[\\s\\S]*?<!--seo-${name}:end-->`);
    if (!pattern.test(html)) throw new Error(`Missing SEO ${name} markers`);
    return html.replace(pattern, () => `<!--seo-${name}:start-->${content}<!--seo-${name}:end-->`);
  };
  return replaceSection(replaceSection(template, "head", seoHead(seo)), "content", initialContent(seo));
}

export function renderSitemap(): string {
  const urls = SEO_PAGES.filter((seo) => seo.index).map((seo) => `  <url><loc>${escapeHtml(pageCanonical(seo))}</loc></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

/** Static per-route HTML keeps SEO independent of client JavaScript and Worker/DB availability. */
export function seoPages(): Plugin {
  let outputDirectory = "";
  return {
    name: "diggo-seo-pages",
    configResolved(config) {
      outputDirectory = resolve(config.root, config.build.outDir);
    },
    transformIndexHtml: {
      order: "pre",
      handler(html, context) {
        return renderSeoPage(html, context.path);
      },
    },
    async writeBundle() {
      const template = await readFile(resolve(outputDirectory, "index.html"), "utf8");
      // foo.html is served at /foo by Cloudflare Assets, preserving existing navigation paths.
      for (const pathname of [...SEO_PAGES.map((seo) => seo.path), "/portfolio"]) {
        const filename = pathname === "/" ? "index.html" : pathname.slice(1) + ".html";
        await writeFile(resolve(outputDirectory, filename), renderSeoPage(template, pathname));
      }
      await writeFile(resolve(outputDirectory, "sitemap.xml"), renderSitemap());
    },
  };
}
