/**
 * Per-wallet serialization for the mutations that must not interleave: daily activation,
 * mine switching, Crew upgrades, reward claims and the discovery roll/claim pair.
 *
 * Every one of those flows already guards itself with a conditional UPDATE ("only transition
 * ELIGIBLE -> CLAIMED") or a single-use nonce, so the lock is not what makes them correct - it is
 * what keeps two concurrent request bodies of the *same wallet* from racing on the read-decide-
 * write steps around those conditional writes (activation window arithmetic, reward settlement,
 * discovery reserve accounting). D1 has no cross-statement transaction that spans those reads, so
 * the serialization point has to live in front of the handler.
 *
 * The Durable Object below is that point. It is a lease-based mutex keyed on the wallet address:
 * a holder takes a lease for `ttlMs`, renewals are unnecessary because holders release in a
 * `finally`, and a holder that dies (isolate eviction, timeout, client disconnect) simply leaves a
 * lease that expires. Nothing can deadlock permanently.
 *
 * Degraded modes, both deliberate:
 *  - No PLAYER_LOCK binding (tests, a local run without the binding): `withPlayerLock` executes the
 *    callback directly. The gameplay invariants do not depend on the lock, so this stays correct,
 *    it is just less serialized.
 *  - The Durable Object call itself fails: the lock is skipped and the callback still runs, again
 *    because failing closed here would take the whole game loop down with it. The failure is
 *    logged loudly as `player_lock.unavailable` so it shows up in Workers Logs.
 */
import { DurableObject } from "cloudflare:workers";
import { optionalBinding, type RuntimeEnv } from "./env";

/** Default wait budget for acquiring the lease. Long enough to cover a queued peer request. */
export const PLAYER_LOCK_TIMEOUT_MS = 5_000;
/** Default lease length. Comfortably longer than any handler that uses the lock. */
export const PLAYER_LOCK_TTL_MS = 15_000;
/** Poll backoff while waiting for a held lease: fast at first, then coarse. */
const POLL_MIN_MS = 10;
const POLL_MAX_MS = 250;
/** Dead leases older than their ttl are only pruned once the table is this big. */
const LEASE_SWEEP_THRESHOLD = 512;

export interface PlayerLockOptions {
  /** Total time to wait for the lease before giving up. */
  timeoutMs?: number;
  /** Lease length handed to the Durable Object. */
  ttlMs?: number;
  /** Called when the lock could not be used at all (missing binding, DO error). */
  onUnavailable?: (reason: string) => void;
}

/** Thrown when a peer held the lease for the whole wait budget. */
export class PlayerLockTimeoutError extends Error {
  readonly wallet: string;
  readonly waitedMs: number;

  constructor(wallet: string, waitedMs: number) {
    super("Another request for this wallet is still in progress");
    this.name = "PlayerLockTimeoutError";
    this.wallet = wallet;
    this.waitedMs = waitedMs;
  }
}

interface LockStub {
  acquire(key: string, token: string, ttlMs: number): Promise<{ granted: boolean; retryAfterMs: number }>;
  release(key: string, token: string): Promise<void>;
}

interface LockNamespace {
  getByName(name: string): LockStub;
}

/** Resolves the PLAYER_LOCK Durable Object namespace, or undefined when it is not bound. */
export function playerLockNamespace(env: RuntimeEnv): LockNamespace | undefined {
  const namespace = optionalBinding<LockNamespace>(env, "PLAYER_LOCK");
  return namespace && typeof namespace.getByName === "function" ? namespace : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `fn` while holding the per-wallet lease. The callback runs in the requesting isolate; the
 * Durable Object only arbitrates, because a closure cannot cross the DO boundary.
 */
export async function withPlayerLock<T>(
  env: RuntimeEnv,
  wallet: string,
  fn: () => Promise<T>,
  options: PlayerLockOptions = {},
): Promise<T> {
  const namespace = playerLockNamespace(env);
  if (!namespace) return fn();

  const timeoutMs = options.timeoutMs ?? PLAYER_LOCK_TIMEOUT_MS;
  const ttlMs = options.ttlMs ?? PLAYER_LOCK_TTL_MS;
  const token = crypto.randomUUID();
  const stub = namespace.getByName(wallet);
  const startedAt = Date.now();

  try {
    let delay = POLL_MIN_MS;
    for (;;) {
      const attempt = await stub.acquire(wallet, token, ttlMs);
      if (attempt.granted) break;
      const waited = Date.now() - startedAt;
      if (waited + delay >= timeoutMs) throw new PlayerLockTimeoutError(wallet, waited);
      await sleep(Math.max(delay, Math.min(attempt.retryAfterMs, POLL_MAX_MS)));
      delay = Math.min(delay * 2, POLL_MAX_MS);
    }
  } catch (error) {
    if (error instanceof PlayerLockTimeoutError) throw error;
    // The lock is defense in depth, never the correctness mechanism: a broken binding must not
    // stop players from activating or claiming. Fail open, loudly.
    options.onUnavailable?.("durable object error");
    console.error(
      JSON.stringify({ event: "player_lock.unavailable", wallet, error: String(error) }),
    );
    return fn();
  }

  try {
    return await fn();
  } finally {
    try {
      await stub.release(wallet, token);
    } catch (error) {
      // The lease expires on its own; a failed release costs one TTL of extra waiting, at worst.
      console.error(JSON.stringify({ event: "player_lock.release_failed", wallet, error: String(error) }));
    }
  }
}

interface LeaseRecord {
  token: string;
  expiresAt: number;
}

/**
 * The mutex itself: one Durable Object per wallet, so every acquire/release pair for a wallet is
 * arbitrated by a single-threaded instance.
 *
 * The lease lives in instance memory. That is what makes the acquire a real compare-and-set: a
 * Durable Object runs one event loop, so the read-modify-write below cannot interleave with a
 * concurrent acquire, whereas a storage-backed lock would have to await between the read and the
 * write. The lease is mirrored into storage only for post-mortem visibility; an evicted instance
 * wakes up with an empty table, which reads as "no holder" and is the safe direction (a dead
 * holder can never wedge a wallet).
 */
export class PlayerLock extends DurableObject<RuntimeEnv> {
  private readonly leases = new Map<string, LeaseRecord>();

  async acquire(key: string, token: string, ttlMs: number): Promise<{ granted: boolean; retryAfterMs: number }> {
    const now = Date.now();
    const current = this.leases.get(key);
    if (current && current.expiresAt > now && current.token !== token) {
      return { granted: false, retryAfterMs: Math.min(current.expiresAt - now, POLL_MAX_MS) };
    }
    const record: LeaseRecord = { token, expiresAt: now + ttlMs };
    // Opportunistic pruning: a lease whose holder died is dropped here instead of waiting for a
    // sweeper, and once the table is large every other expired lease goes with it.
    if (this.leases.size >= LEASE_SWEEP_THRESHOLD) this.sweep(now);
    this.leases.set(key, record);
    this.mirror(key, record);
    return { granted: true, retryAfterMs: 0 };
  }

  async release(key: string, token: string): Promise<void> {
    const current = this.leases.get(key);
    // Only the holder may release: a stale release must never free a lease taken after it.
    if (!current || current.token !== token) return;
    this.leases.delete(key);
    this.mirror(key, null);
  }

  /** Best-effort storage mirror; never awaited by the acquire path. */
  private mirror(key: string, record: LeaseRecord | null): void {
    const write = record === null ? this.ctx.storage.delete(key) : this.ctx.storage.put(key, record);
    this.ctx.waitUntil(write.catch(() => undefined));
  }

  private sweep(now: number): void {
    for (const [key, record] of this.leases) {
      if (record.expiresAt > now) continue;
      this.leases.delete(key);
      this.mirror(key, null);
    }
  }
}
