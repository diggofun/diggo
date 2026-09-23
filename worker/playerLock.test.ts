/**
 * Per-wallet mutex tests (worker/playerLock.ts).
 *
 * The Durable Object base class only exists inside workerd, so it is replaced with a minimal
 * stand-in here: the point of these tests is the locking contract the Worker relies on - one
 * caller at a time per wallet, a bounded wait, a release that happens even on a thrown handler, and
 * a graceful degrade when the binding is missing or broken.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

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

import type { RuntimeEnv } from "./env";
import { PlayerLock, PlayerLockTimeoutError, withPlayerLock } from "./playerLock";

afterEach(() => {
  vi.restoreAllMocks();
});

interface FakeLockNamespace {
  readonly leases: Map<string, string>;
  readonly releases: number;
  readonly namespace: { getByName(name: string): unknown };
}

/**
 * An in-memory stand-in for the PLAYER_LOCK namespace. It reproduces the one property the client
 * depends on: a key is held until the holder releases it, and a refusal carries a retry hint.
 */
function fakeLockNamespace(options: { grant?: boolean; fail?: boolean } = {}): FakeLockNamespace {
  const leases = new Map<string, string>();
  const state = { releases: 0 };
  const namespace = {
    getByName: (_name: string) => ({
      async acquire(key: string, token: string) {
        if (options.fail) throw new Error("durable object unavailable");
        if (options.grant === false) return { granted: false, retryAfterMs: 1 };
        if (leases.has(key)) return { granted: false, retryAfterMs: 1 };
        leases.set(key, token);
        return { granted: true, retryAfterMs: 0 };
      },
      async release(key: string, token: string) {
        state.releases += 1;
        if (leases.get(key) === token) leases.delete(key);
      },
    }),
  };
  return {
    leases,
    get releases() {
      return state.releases;
    },
    namespace,
  };
}

function envWith(lock: unknown): RuntimeEnv {
  return { PLAYER_LOCK: lock } as unknown as RuntimeEnv;
}

describe("withPlayerLock", () => {
  it("runs the callback directly when the binding is absent", async () => {
    const env = {} as RuntimeEnv;
    await expect(withPlayerLock(env, "wallet-a", async () => "direct")).resolves.toBe("direct");
    await expect(
      withPlayerLock(env, "wallet-a", async () => {
        throw new Error("handler failed");
      }),
    ).rejects.toThrow("handler failed");
  });

  it("never lets two callbacks for one wallet overlap", async () => {
    const lock = fakeLockNamespace();
    const env = envWith(lock.namespace);
    const order: string[] = [];
    let active = 0;
    let peak = 0;
    const task = (label: string) => async () => {
      active += 1;
      peak = Math.max(peak, active);
      order.push(label + ":start");
      await new Promise((resolve) => setTimeout(resolve, 15));
      order.push(label + ":end");
      active -= 1;
    };

    await Promise.all([withPlayerLock(env, "wallet-a", task("first")), withPlayerLock(env, "wallet-a", task("second"))]);

    expect(peak).toBe(1);
    expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
    expect(lock.leases.size).toBe(0);
  });

  it("does not serialize different wallets", async () => {
    const env = envWith(fakeLockNamespace().namespace);
    let started = 0;
    let releaseBoth = () => {};
    const both = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const task = async () => {
      started += 1;
      if (started === 2) releaseBoth();
      await Promise.race([both, new Promise((resolve) => setTimeout(resolve, 500))]);
    };

    await Promise.all([withPlayerLock(env, "wallet-a", task), withPlayerLock(env, "wallet-b", task)]);

    expect(started).toBe(2);
  });

  it("gives up with a typed error when the wait budget runs out", async () => {
    const env = envWith(fakeLockNamespace({ grant: false }).namespace);
    const handler = vi.fn(async () => "applied");

    await expect(withPlayerLock(env, "wallet-a", handler, { timeoutMs: 40 })).rejects.toBeInstanceOf(
      PlayerLockTimeoutError,
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it("releases the lease when the callback throws", async () => {
    const lock = fakeLockNamespace();
    const env = envWith(lock.namespace);

    await expect(
      withPlayerLock(env, "wallet-a", async () => {
        throw new Error("roll failed");
      }),
    ).rejects.toThrow("roll failed");

    expect(lock.releases).toBe(1);
    expect(lock.leases.size).toBe(0);
    await expect(withPlayerLock(env, "wallet-a", async () => "retried")).resolves.toBe("retried");
  });

  it("fails open, loudly, when the Durable Object call itself fails", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const onUnavailable = vi.fn();
    const env = envWith(fakeLockNamespace({ fail: true }).namespace);

    await expect(
      withPlayerLock(env, "wallet-a", async () => "still applied", { onUnavailable }),
    ).resolves.toBe("still applied");

    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalled();
  });
});

describe("PlayerLock", () => {
  interface StorageCall {
    readonly op: "put" | "delete";
    readonly key: string;
  }

  function harness() {
    const calls: StorageCall[] = [];
    const ctx = {
      storage: {
        async put(key: string) {
          calls.push({ op: "put", key });
        },
        async delete(key: string) {
          calls.push({ op: "delete", key });
          return true;
        },
      },
      waitUntil: (promise: Promise<unknown>) => promise.catch(() => undefined),
    };
    const lock = new PlayerLock(ctx as never, {} as RuntimeEnv);
    return { lock, calls };
  }

  it("grants one holder per key and refuses the next one", async () => {
    const { lock } = harness();

    await expect(lock.acquire("wallet-a", "token-1", 5_000)).resolves.toMatchObject({ granted: true });
    await expect(lock.acquire("wallet-a", "token-2", 5_000)).resolves.toMatchObject({ granted: false });
    await lock.release("wallet-a", "token-1");
    await expect(lock.acquire("wallet-a", "token-2", 5_000)).resolves.toMatchObject({ granted: true });
  });

  it("ignores a release from a token that no longer holds the lease", async () => {
    const { lock } = harness();

    await lock.acquire("wallet-a", "token-1", 0);
    // token-1's lease expired on arrival, so token-2 may take it.
    await expect(lock.acquire("wallet-a", "token-2", 5_000)).resolves.toMatchObject({ granted: true });
    // A late release from token-1 must not free token-2's lease.
    await lock.release("wallet-a", "token-1");
    await expect(lock.acquire("wallet-a", "token-3", 5_000)).resolves.toMatchObject({ granted: false });
  });

  it("mirrors the lease into storage and clears it on release", async () => {
    const { lock, calls } = harness();

    await lock.acquire("wallet-a", "token-1", 5_000);
    await lock.release("wallet-a", "token-1");

    expect(calls.map((call) => call.op)).toEqual(["put", "delete"]);
    expect(calls[0].key).toBe("wallet-a");
  });
});
