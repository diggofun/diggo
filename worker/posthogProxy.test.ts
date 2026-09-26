/**
 * The first-party PostHog proxy: /ph/* goes to the EU cloud, assets to the EU asset host, and no
 * cookie or credential crosses in either direction.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { POSTHOG_MAX_BODY_BYTES, isPosthogProxyPath, posthogUpstreamUrl, proxyPosthog } from "./posthogProxy";

const ctx = { waitUntil: vi.fn() };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function stubUpstream(response: () => Response) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response());
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("posthog proxy routing", () => {
  it("only claims /ph and /ph/*", () => {
    expect(isPosthogProxyPath("/ph")).toBe(true);
    expect(isPosthogProxyPath("/ph/e/")).toBe(true);
    expect(isPosthogProxyPath("/phone")).toBe(false);
    expect(isPosthogProxyPath("/api/ph/e")).toBe(false);
  });

  it("maps ingestion to eu.i.posthog.com and assets to eu-assets.i.posthog.com", () => {
    expect(posthogUpstreamUrl(new URL("https://diggo.fun/ph/i/v0/e/?ip=0&ver=1"))).toBe("https://eu.i.posthog.com/i/v0/e/?ip=0&ver=1");
    expect(posthogUpstreamUrl(new URL("https://diggo.fun/ph/decide/?v=4"))).toBe("https://eu.i.posthog.com/decide/?v=4");
    expect(posthogUpstreamUrl(new URL("https://diggo.fun/ph/static/recorder.js?v=1"))).toBe("https://eu-assets.i.posthog.com/static/recorder.js?v=1");
    expect(posthogUpstreamUrl(new URL("https://diggo.fun/ph/array/phc_x/config.js"))).toBe("https://eu-assets.i.posthog.com/array/phc_x/config.js");
    expect(posthogUpstreamUrl(new URL("https://diggo.fun/api/config"))).toBeNull();
  });
});

describe("posthog proxy forwarding", () => {
  it("forwards an event batch without cookies and strips Set-Cookie from the answer", async () => {
    const fetchMock = stubUpstream(() => new Response('{"status":1}', {
      status: 200,
      headers: { "content-type": "application/json", "set-cookie": "tracker=1" },
    }));
    const request = new Request("https://diggo.fun/ph/e/?compression=gzip-js", {
      method: "POST",
      headers: {
        cookie: "diggo_session=secret",
        authorization: "Bearer nope",
        "content-type": "text/plain",
        "cf-connecting-ip": "203.0.113.7",
        "user-agent": "vitest",
      },
      body: "payload",
    });

    const response = await proxyPosthog(request, ctx);

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    const [target, init] = fetchMock.mock.calls[0]!;
    expect(target).toBe("https://eu.i.posthog.com/e/?compression=gzip-js");
    const headers = new Headers(init?.headers);
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-forwarded-for")).toBe("203.0.113.7");
    expect(headers.get("content-type")).toBe("text/plain");
    expect(init?.method).toBe("POST");
  });

  it("serves SDK assets from the asset host", async () => {
    const fetchMock = stubUpstream(() => new Response("js", { status: 200 }));
    const response = await proxyPosthog(new Request("https://diggo.fun/ph/static/array.js"), ctx);

    expect(response.status).toBe(200);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://eu-assets.i.posthog.com/static/array.js");
  });

  it("refuses other methods and oversized bodies without calling PostHog", async () => {
    const fetchMock = stubUpstream(() => new Response("never"));
    const put = await proxyPosthog(new Request("https://diggo.fun/ph/e/", { method: "PUT", body: "x" }), ctx);
    const big = await proxyPosthog(new Request("https://diggo.fun/ph/e/", {
      method: "POST",
      headers: { "content-length": String(POSTHOG_MAX_BODY_BYTES + 1) },
      body: "x",
    }), ctx);

    expect(put.status).toBe(405);
    expect(big.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
