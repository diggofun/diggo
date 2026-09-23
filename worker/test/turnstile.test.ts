/**
 * Turnstile verification (worker/auth.ts verifyTurnstile, spec 46, 62).
 *
 * The gate exists to add friction to a wallet farm, so a token that clears it has to have been
 * solved for *this* deployment: siteverify reports the hostname the token was minted on, and any
 * attacker can mint tokens on their own site with their own site key. These tests pin that check,
 * the action check that goes with it, and the dev bypass that must stay narrow. The siteverify call
 * itself is stubbed, so nothing here touches Cloudflare.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { turnstileAllowedHostnames, verifyTurnstile } from "../auth";
import type { RuntimeEnv } from "../env";

afterEach(() => {
  vi.unstubAllGlobals();
});

function env(extra: Record<string, unknown> = {}): RuntimeEnv {
  return { TURNSTILE_SECRET: "turnstile-secret", ...extra } as unknown as RuntimeEnv;
}

/** A request as it would arrive for a hostname, which is what siteverify is compared against. */
function requestFor(hostname = "diggo.fun"): Request {
  return new Request("https://" + hostname + "/api/verify", { method: "POST", body: "{}" });
}

function siteverify(payload: unknown): void {
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(typeof payload === "string" ? payload : JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
}

describe("verifyTurnstile", () => {
  it("accepts a token solved on the host the request arrived on", async () => {
    siteverify({ success: true, hostname: "diggo.fun", action: "" });

    expect(await verifyTurnstile("token", requestFor("diggo.fun"), env())).toBe(true);
  });

  it("refuses a token solved on somebody else's host", async () => {
    // Exactly the finding: a token minted on the attacker's own page is a success for them.
    siteverify({ success: true, hostname: "attacker.example", action: "login" });

    expect(await verifyTurnstile("token", requestFor("diggo.fun"), env())).toBe(false);
  });

  it("accepts a configured hostname alongside the request's own", async () => {
    siteverify({ success: true, hostname: "staging.diggo.fun" });
    const configured = env({ TURNSTILE_ALLOWED_HOSTNAMES: "www.diggo.fun, https://staging.diggo.fun/" });

    expect(turnstileAllowedHostnames(requestFor("diggo.fun"), configured)).toEqual([
      "diggo.fun",
      "www.diggo.fun",
      "staging.diggo.fun",
    ]);
    expect(await verifyTurnstile("token", requestFor("diggo.fun"), configured)).toBe(true);

    // A host that is neither the request's own nor configured stays refused.
    siteverify({ success: true, hostname: "evil.example" });
    expect(await verifyTurnstile("token", requestFor("diggo.fun"), configured)).toBe(false);
  });

  it("refuses a successful answer that names no hostname", async () => {
    siteverify({ success: true });

    expect(await verifyTurnstile("token", requestFor("diggo.fun"), env())).toBe(false);
  });

  it("validates the action when the deployment declares one", async () => {
    siteverify({ success: true, hostname: "diggo.fun", action: "transfer" });

    // A deployment that declares actions enforces them: an action nobody declared cannot be
    // validated, so the token is refused.
    expect(
      await verifyTurnstile("token", requestFor("diggo.fun"), env({ TURNSTILE_ACTIONS: "login,transfer" })),
    ).toBe(true);
    expect(await verifyTurnstile("token", requestFor("diggo.fun"), env({ TURNSTILE_ACTIONS: "login" }))).toBe(
      false,
    );

    // A deployment that declares none accepts the token: an unset list is not a list that matches
    // nothing, and refusing every real solution over missing configuration is an outage. The
    // hostname check above is the gate that always runs, so an off-site token is still refused.
    expect(await verifyTurnstile("token", requestFor("diggo.fun"), env())).toBe(true);
    siteverify({ success: true, hostname: "attacker.example", action: "transfer" });
    expect(await verifyTurnstile("token", requestFor("diggo.fun"), env())).toBe(false);
  });

  it("fails closed on a refusal, an unreadable answer or a missing secret", async () => {
    siteverify({ success: false, hostname: "diggo.fun", "error-codes": ["invalid-input-response"] });
    expect(await verifyTurnstile("token", requestFor(), env())).toBe(false);

    siteverify("<html>not json</html>");
    expect(await verifyTurnstile("token", requestFor(), env())).toBe(false);

    siteverify({ success: true, hostname: "diggo.fun" });
    expect(await verifyTurnstile("token", requestFor(), { } as unknown as RuntimeEnv)).toBe(false);
    expect(await verifyTurnstile("", requestFor(), env())).toBe(false);
  });

  it("keeps the local dev bypass narrow", async () => {
    const push = vi.fn(
      async () =>
        new Response(JSON.stringify({ success: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", push);

    expect(await verifyTurnstile("dev-bypass", requestFor("localhost"), env())).toBe(true);
    expect(await verifyTurnstile("dev-bypass", requestFor("127.0.0.1"), env())).toBe(true);
    expect(push).not.toHaveBeenCalled();

    // A real token on a local host is verified like anywhere else, so the bypass is not a hole.
    expect(await verifyTurnstile("real-token", requestFor("localhost"), env())).toBe(false);
    expect(push).toHaveBeenCalledTimes(1);

    // And the bypass token is worthless off a local host.
    push.mockClear();
    expect(await verifyTurnstile("dev-bypass", requestFor("diggo.fun"), env())).toBe(false);
    expect(push).toHaveBeenCalledTimes(1);
  });
});
