/**
 * Share cards for referral links.
 *
 * GET /r/:code serves the app's own index.html with the link-preview tags pointed at this player's
 * card, so a referral link posted on X, Discord or WhatsApp unfurls as "<name> is digging memecoins"
 * with their bot and their haul. People who click get the normal app, which still reads the code
 * from the path. GET /api/share/:code.png renders that card.
 *
 * Both answers are cached for a few minutes at the edge: a popular link costs one render, not one
 * per crawler.
 */
import type { RuntimeEnv } from "../env";
import { CARD_WIDTH, cardSvg, previewText } from "./card";
import { shareStats, walletForShareCode } from "./stats";
import { mineCardSvg, minePreviewText } from "./mineCard";
import { mineShareStats } from "./mineStats";

const CARD_CACHE_SECONDS = 600;
const FALLBACK_CARD = "/og-image-v4.jpg";

let wordmarkUri: Promise<string> | null = null;

/** The Diggo wordmark as a data: URI, read once per isolate from the static assets. */
function wordmark(env: RuntimeEnv, origin: string): Promise<string> {
  wordmarkUri ??= env.ASSETS.fetch(new Request(origin + "/assets/brand/diggo-wordmark-640.png"))
    .then(async (response) => {
      if (!response.ok) throw new Error("wordmark " + response.status);
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return "data:image/png;base64," + btoa(binary);
    })
    .catch((error: unknown) => {
      wordmarkUri = null;
      throw error;
    });
  return wordmarkUri;
}

async function cached(request: Request, ctx: ExecutionContext, build: () => Promise<Response>): Promise<Response> {
  const cache = (caches as unknown as { default: Cache }).default;
  const key = new Request(new URL(request.url).toString(), { method: "GET" });
  const hit = await cache.match(key);
  if (hit) return hit;
  const response = await build();
  if (response.ok) ctx.waitUntil(cache.put(key, response.clone()));
  return response;
}

/** GET /api/share/:code.png */
export async function shareCardPng(request: Request, env: RuntimeEnv, ctx: ExecutionContext, rawCode: string): Promise<Response> {
  const origin = new URL(request.url).origin;
  const owner = await walletForShareCode(env, rawCode);
  if (!owner) return Response.redirect(origin + FALLBACK_CARD, 302);
  return cached(request, ctx, async () => {
    const [stats, mark] = await Promise.all([shareStats(env, owner.wallet), wordmark(env, origin)]);
    const { svgToPng } = await import("./render");
    const png = await svgToPng(cardSvg(stats, mark), CARD_WIDTH);
    return new Response(new Uint8Array(png), {
      headers: {
        "content-type": "image/png",
        "cache-control": `public, max-age=${CARD_CACHE_SECONDS}`,
      },
    });
  });
}

/** Swaps the content of one <meta> tag (by property or name). */
class MetaContent {
  constructor(private readonly value: string) {}
  element(element: Element): void {
    element.setAttribute("content", this.value);
  }
}

class TitleText {
  constructor(private readonly value: string) {}
  element(element: Element): void {
    element.setInnerContent(this.value);
  }
}

/** GET /r/:code - the app, with this player's preview tags. */
/** Preview tags need absolute https URLs; local development keeps its own origin. */
function publicOrigin(url: URL): string {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" ? url.origin : "https://" + url.host;
}

export async function shareLandingPage(request: Request, env: RuntimeEnv, ctx: ExecutionContext, rawCode: string): Promise<Response> {
  const url = new URL(request.url);
  const origin = publicOrigin(url);
  const page = await env.ASSETS.fetch(new Request(url.origin + "/", { headers: request.headers }));
  const owner = await walletForShareCode(env, rawCode).catch(() => null);
  if (!owner || !page.ok) return page;
  return cached(request, ctx, async () => {
    const stats = await shareStats(env, owner.wallet);
    const { title, description } = previewText(stats);
    // The hour in the image URL lets X and Discord fetch a fresh card at most hourly.
    const image = `${origin}/api/share/${encodeURIComponent(owner.code)}.png?h=${Math.floor(Date.now() / 3_600_000)}`;
    const link = `${origin}/r/${encodeURIComponent(owner.code)}`;
    const alt = `${title}: their bot and what it dug.`;
    const rewritten = new HTMLRewriter()
      .on("title", new TitleText(title))
      .on('meta[property="og:title"], meta[name="twitter:title"]', new MetaContent(title))
      .on('meta[property="og:description"], meta[name="twitter:description"], meta[name="description"]', new MetaContent(description))
      .on('meta[property="og:image"], meta[property="og:image:secure_url"], meta[name="twitter:image"]', new MetaContent(image))
      .on('meta[property="og:image:type"]', new MetaContent("image/png"))
      .on('meta[property="og:image:alt"], meta[name="twitter:image:alt"]', new MetaContent(alt))
      .on('meta[property="og:url"]', new MetaContent(link))
      .transform(page);
    const headers = new Headers(rewritten.headers);
    headers.set("cache-control", "public, max-age=300");
    return new Response(rewritten.body, { status: 200, headers });
  });
}

/** GET /api/share/mine/:mint.png */
export async function mineCardPng(request: Request, env: RuntimeEnv, ctx: ExecutionContext, mint: string): Promise<Response> {
  const origin = new URL(request.url).origin;
  return cached(request, ctx, async () => {
    const stats = await mineShareStats(env, mint).catch(() => null);
    if (!stats) return Response.redirect(origin + FALLBACK_CARD, 302);
    const mark = await wordmark(env, origin);
    const { svgToPng } = await import("./render");
    const png = await svgToPng(mineCardSvg(stats, mark), CARD_WIDTH);
    return new Response(new Uint8Array(png), {
      headers: { "content-type": "image/png", "cache-control": `public, max-age=${CARD_CACHE_SECONDS}` },
    });
  });
}

/**
 * GET /m/:mint - the app, with this mine's preview tags. The client reads the mint from the path,
 * remembers it, and sends the player's crew to that mine once they are signed in.
 */
export async function mineLandingPage(request: Request, env: RuntimeEnv, ctx: ExecutionContext, mint: string): Promise<Response> {
  const url = new URL(request.url);
  const origin = publicOrigin(url);
  const page = await env.ASSETS.fetch(new Request(url.origin + "/", { headers: request.headers }));
  if (!page.ok) return page;
  const stats = await mineShareStats(env, mint).catch(() => null);
  if (!stats) return page;
  return cached(request, ctx, async () => {
    const { title, description } = minePreviewText(stats);
    const image = `${origin}/api/share/mine/${encodeURIComponent(stats.mint)}.png?h=${Math.floor(Date.now() / 3_600_000)}`;
    const link = `${origin}/m/${encodeURIComponent(stats.mint)}`;
    const rewritten = new HTMLRewriter()
      .on("title", new TitleText(title))
      .on('meta[property="og:title"], meta[name="twitter:title"]', new MetaContent(title))
      .on('meta[property="og:description"], meta[name="twitter:description"], meta[name="description"]', new MetaContent(description))
      .on('meta[property="og:image"], meta[property="og:image:secure_url"], meta[name="twitter:image"]', new MetaContent(image))
      .on('meta[property="og:image:type"]', new MetaContent("image/png"))
      .on('meta[property="og:image:alt"], meta[name="twitter:image:alt"]', new MetaContent(`Bots mining $${stats.symbol} on Diggo.fun`))
      .on('meta[property="og:url"]', new MetaContent(link))
      .transform(page);
    const headers = new Headers(rewritten.headers);
    headers.set("cache-control", "public, max-age=300");
    return new Response(rewritten.body, { status: 200, headers });
  });
}
