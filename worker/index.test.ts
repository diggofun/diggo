/**
 * Router wiring tests (worker/index.ts): the sensitive per-wallet routes must go through the
 * PLAYER_LOCK mutex, and a request whose session already holds nothing must still reach its
 * handler when the lock is unavailable.
 *
 * The domain modules are mocked here on purpose - they have their own suites. What is asserted is
 * only the wiring: which handler the router calls, and whether it called it inside the lock.
 */
import { describe, expect, it, vi } from "vitest";
import { json } from "./http";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    readonly ctx: unknown;
    readonly env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const withPlayerLock = vi.fn(async (_env: unknown, _wallet: string, fn: () => Promise<Response>) => fn());
const sessionWallet = vi.fn(async () => "wallet-a" as string | null);

vi.mock("./playerLock", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./playerLock")>()),
  withPlayerLock: (env: unknown, wallet: string, fn: () => Promise<Response>) =>
    withPlayerLock(env, wallet, fn),
  PlayerLockTimeoutError: class PlayerLockTimeoutError extends Error {},
}));

vi.mock("./auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth")>()),
  sessionWallet: () => sessionWallet(),
}));

const handlers: Record<string, ReturnType<typeof vi.fn>> = {};
for (const name of ["activateMine", "switchMine", "claimReward", "rollDiscoveryRequest", "claimDiscovery"]) {
  handlers[name] = vi.fn(async () => json({ handler: name }));
}
handlers.crewUpgrade = vi.fn(async () => json({ handler: "crewUpgrade" }));

vi.mock("./mining", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mining")>()),
  activateMine: handlers.activateMine,
  switchMine: handlers.switchMine,
  claimReward: handlers.claimReward,
}));

vi.mock("./crew", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./crew")>()),
  crewUpgrade: handlers.crewUpgrade,
}));

vi.mock("./discovery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./discovery")>()),
  rollDiscoveryRequest: handlers.rollDiscoveryRequest,
  claimDiscovery: handlers.claimDiscovery,
}));

const worker = (await import("./index")).default;
const env = { ASSETS: { fetch: async () => new Response("asset") } } as never;
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as never;

function post(path: string, session: string | null = "session-1"): Request {
  return new Request("https://diggo.fun" + path, {
    method: "POST",
    headers: session ? { cookie: "diggo_session=" + session } : {},
  });
}

describe("sensitive per-wallet routes", () => {
  const routes: [string, string][] = [
    ["/api/mine/activate", "activateMine"],
    ["/api/mine/switch", "switchMine"],
    ["/api/crew/upgrade", "crewUpgrade"],
    ["/api/rewards/claim", "claimReward"],
    ["/api/discovery/roll", "rollDiscoveryRequest"],
    ["/api/discovery/claim", "claimDiscovery"],
  ];

  for (const [path, handler] of routes) {
    it("runs " + path + " behind the player lock", async () => {
      withPlayerLock.mockClear();
      handlers[handler].mockClear();
      sessionWallet.mockResolvedValue("wallet-a");

      const response = await worker.fetch(post(path), env, ctx);

      expect(await response.json()).toEqual({ handler });
      expect(handlers[handler]).toHaveBeenCalledTimes(1);
      expect(withPlayerLock).toHaveBeenCalledTimes(1);
      expect(withPlayerLock.mock.calls[0][1]).toBe("wallet-a");
    });
  }

  it("passes the request straight through when no wallet session is presented", async () => {
    withPlayerLock.mockClear();
    handlers.activateMine.mockClear();
    sessionWallet.mockResolvedValue(null);

    await worker.fetch(post("/api/mine/activate", null), env, ctx);

    expect(handlers.activateMine).toHaveBeenCalledTimes(1);
    expect(withPlayerLock).not.toHaveBeenCalled();
  });

  it("leaves read-only routes unlocked", async () => {
    withPlayerLock.mockClear();

    await worker.fetch(post("/api/discovery/opportunity"), env, ctx);

    expect(withPlayerLock).not.toHaveBeenCalled();
  });
});

