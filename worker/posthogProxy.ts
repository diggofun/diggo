/**
 * First-party reverse proxy for PostHog (EU cloud), mounted at /ph/*.
 *
 * The browser SDK is initialised with api_host "/ph", so ingestion, remote config and the lazily
 * loaded SDK extensions (the session replay recorder and friends) are same-origin requests: the
 * site's CSP needs no third-party connect-src or script-src entry.
 *
 * Follows PostHog's Cloudflare Workers proxy guidance: /static/* and /array/* go to the asset host
 * and are edge-cached, everything else goes to the ingestion host with the client IP forwarded.
 * It is deliberately narrower than the reference worker:
 *  - only GET, HEAD, POST and OPTIONS are forwarded;
 *  - request headers are an allowlist, so the session cookie and every other cookie stay here;
 *  - request bodies are capped (replay snapshots are the largest legitimate payload);
 *  - upstream Set-Cookie is dropped, so PostHog can never set a cookie on diggo.fun through us.
 * The proxy sends nothing on its own: the SDK only exists in the page after analytics consent.
 */

export const POSTHOG_PROXY_PREFIX = "/ph";
export const POSTHOG_API_HOST = "eu.i.posthog.com";
export const POSTHOG_ASSET_HOST = "eu-assets.i.posthog.com";
/** 10 MB. posthog-js batches replay snapshots well below this; anything larger is not the SDK. */
export const POSTHOG_MAX_BODY_BYTES = 10 * 1024 * 1024;

const ALLOWED_METHODS = ["GET", "HEAD", "POST", "OPTIONS"];
const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "accept-language",
  "content-encoding",
  "content-type",
  "origin",
  "referer",
  "user-agent",
];
const DROPPED_RESPONSE_HEADERS = ["set-cookie", "alt-svc", "report-to", "nel"];

export function isPosthogProxyPath(pathname: string): boolean {
  return pathname === POSTHOG_PROXY_PREFIX || pathname.startsWith(POSTHOG_PROXY_PREFIX + "/");
}

/** Maps a /ph/... URL to the PostHog origin that serves it, keeping the query string. */
export function posthogUpstreamUrl(url: URL): string | null {
  if (!isPosthogProxyPath(url.pathname)) return null;
  const path = url.pathname.slice(POSTHOG_PROXY_PREFIX.length) || "/";
  if (path.includes("..")) return null;
  const host = path.startsWith("/static/") || path.startsWith("/array/") ? POSTHOG_ASSET_HOST : POSTHOG_API_HOST;
  return "https://" + host + path + url.search;
}

function upstreamHeaders(request: Request): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const ip = request.headers.get("cf-connecting-ip");
  if (ip) headers.set("x-forwarded-for", ip);
  return headers;
}

function cleanResponse(upstream: Response): Response {
  const headers = new Headers(upstream.headers);
  for (const name of DROPPED_RESPONSE_HEADERS) headers.delete(name);
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
}

async function readBoundedBody(request: Request): Promise<ArrayBuffer | Response> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > POSTHOG_MAX_BODY_BYTES) {
    return new Response("Payload too large", { status: 413 });
  }
  const body = await request.arrayBuffer();
  if (body.byteLength > POSTHOG_MAX_BODY_BYTES) return new Response("Payload too large", { status: 413 });
  return body;
}

interface ProxyContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** Cloudflare's edge cache for the asset host; absent in unit tests. */
function edgeCache(): Cache | null {
  const store = (globalThis as { caches?: { default?: Cache } }).caches;
  return store?.default ?? null;
}

export async function proxyPosthog(request: Request, ctx: ProxyContext): Promise<Response> {
  if (!ALLOWED_METHODS.includes(request.method)) {
    return new Response("Method not allowed", { status: 405, headers: { allow: ALLOWED_METHODS.join(", ") } });
  }
  const url = new URL(request.url);
  const target = posthogUpstreamUrl(url);
  if (!target) return new Response("Not found", { status: 404 });
  const isAsset = new URL(target).host === POSTHOG_ASSET_HOST;

  if (isAsset && request.method === "GET") {
    const cache = edgeCache();
    const cacheKey = new Request(url.toString(), { method: "GET" });
    const cached = await cache?.match(cacheKey);
    if (cached) return cached;
    const upstream = cleanResponse(await fetch(target, { method: "GET", headers: upstreamHeaders(request) }));
    if (cache && upstream.ok) ctx.waitUntil(cache.put(cacheKey, upstream.clone()));
    return upstream;
  }

  let body: ArrayBuffer | null = null;
  if (request.method === "POST") {
    const bounded = await readBoundedBody(request);
    if (bounded instanceof Response) return bounded;
    body = bounded;
  }
  const upstream = await fetch(target, {
    method: request.method,
    headers: upstreamHeaders(request),
    body,
    redirect: "manual",
  });
  return cleanResponse(upstream);
}
