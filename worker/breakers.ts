/**
 * Circuit breakers (spec 65): the only emergency controls this backend has, and they are
 * deliberately narrow. A breaker can halt new discoveries, halt claims, or halt one mine's
 * Discovery Reserve payouts. It can never move, seize or redirect funds, and it can never stop
 * trading or the launch market - that is enforced by what this module does not contain: there
 * is no transfer, withdrawal or signing code here at all.
 *
 * Every open/close is appended to breaker_audit (and, when an admin does it, to admin_audit)
 * so the control stays bounded and auditable.
 */
import type { RuntimeEnv } from "./env";
import { METRIC, metric } from "./telemetry";

export type BreakerScope = "discoveries" | "claims" | "discovery_reserve";

export const BREAKER_SCOPES: readonly BreakerScope[] = ["discoveries", "claims", "discovery_reserve"];

export interface BreakerState {
  scope: BreakerScope;
  mint: string | null;
  open: boolean;
  reason: string | null;
  actor: string | null;
  updatedAt: number;
}

export interface BreakerAuditRow {
  id: string;
  scope: string;
  mint: string | null;
  open: number;
  reason: string | null;
  actor: string | null;
  created_at: number;
}

interface BreakerRow {
  scope: BreakerScope;
  mint: string | null;
  open: number;
  reason: string | null;
  actor: string | null;
  updated_at: number;
}

/** Deterministic row id: one row per (scope, mint), where a null mint is the scope-wide row. */
export function breakerId(scope: BreakerScope, mint?: string | null): string {
  return scope + ":" + (mint && mint.length > 0 ? mint : "*");
}

function toState(row: BreakerRow): BreakerState {
  return {
    scope: row.scope,
    mint: row.mint,
    open: row.open === 1,
    reason: row.reason,
    actor: row.actor,
    updatedAt: row.updated_at,
  };
}

/**
 * Which rows have to be consulted for a scope. A discovery-reserve check is deliberately
 * conservative: a halt on new discoveries or on claims also stops reserve payouts, because a
 * payout is exactly what those halts exist to prevent.
 */
function relevantIds(scope: BreakerScope, mint?: string | null): string[] {
  const ids: string[] = [];
  if (mint && mint.length > 0) ids.push(breakerId(scope, mint));
  ids.push(breakerId(scope, null));
  if (scope === "discovery_reserve") {
    ids.push(breakerId("discoveries", null), breakerId("claims", null));
  }
  return ids;
}

/** True when the scope is halted. Read-only and cheap enough to call on the reward path. */
export async function isBreakerOpen(env: RuntimeEnv, scope: BreakerScope, mint?: string): Promise<boolean> {
  const ids = relevantIds(scope, mint);
  try {
    const results = await env.DB.batch<{ open: number }>(
      ids.map((id) => env.DB.prepare("SELECT open FROM circuit_breakers WHERE id = ?1").bind(id)),
    );
    return results.some((result) => (result.results?.[0]?.open ?? 0) === 1);
  } catch (error) {
    // Fail open on a read error: a breaker is an emergency control, and refusing every reward
    // because D1 hiccuped would be worse than the anomaly it guards against.
    console.error(
      JSON.stringify({ event: "risk.breaker_read_failed", scope, mint: mint ?? null, error: String(error) }),
    );
    return false;
  }
}

export async function breakerStates(env: RuntimeEnv): Promise<BreakerState[]> {
  const result = await env.DB.prepare(
    "SELECT scope, mint, open, reason, actor, updated_at FROM circuit_breakers ORDER BY scope, mint",
  ).all<BreakerRow>();
  return result.results.map(toState);
}

export async function breakerAudit(env: RuntimeEnv, limit = 50): Promise<BreakerAuditRow[]> {
  const result = await env.DB.prepare(
    "SELECT id, scope, mint, open, reason, actor, created_at FROM breaker_audit ORDER BY created_at DESC LIMIT ?1",
  )
    .bind(limit)
    .all<BreakerAuditRow>();
  return result.results;
}

export interface SetBreakerInput {
  scope: BreakerScope;
  mint?: string | null;
  open: boolean;
  reason: string;
  actor: string;
}

/**
 * Opens or closes one breaker and writes both the state row and its audit entry.
 * This is the only mutation this module exposes; it cannot touch funds, trading or a market.
 */
export async function setBreaker(env: RuntimeEnv, input: SetBreakerInput): Promise<BreakerState> {
  const now = Math.floor(Date.now() / 1_000);
  const mint = input.mint && input.mint.length > 0 ? input.mint : null;
  const id = breakerId(input.scope, mint);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO circuit_breakers (id, scope, mint, open, reason, actor, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) " +
        "ON CONFLICT(id) DO UPDATE SET open = excluded.open, reason = excluded.reason, " +
        "actor = excluded.actor, updated_at = excluded.updated_at",
    ).bind(id, input.scope, mint, input.open ? 1 : 0, input.reason, input.actor, now),
    env.DB.prepare(
      "INSERT INTO breaker_audit (id, scope, mint, open, reason, actor, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    ).bind(crypto.randomUUID(), input.scope, mint, input.open ? 1 : 0, input.reason, input.actor, now),
  ]);
  console.log(
    JSON.stringify({
      event: input.open ? "risk.breaker_opened" : "risk.breaker_closed",
      scope: input.scope,
      mint,
      reason: input.reason,
      actor: input.actor,
    }),
  );
  await metric(env, input.open ? METRIC.breakerOpened : METRIC.breakerClosed, 1, { scope: input.scope });
  return { scope: input.scope, mint, open: input.open, reason: input.reason, actor: input.actor, updatedAt: now };
}

/**
 * Opens a row that is currently closed. Used by the cron anomaly check, which must not fight an
 * admin decision: only a closed row is opened, and always with actor "risk-cron" so a manual
 * hold stays distinguishable.
 */
export async function autoOpenBreaker(
  env: RuntimeEnv,
  scope: BreakerScope,
  reason: string,
  mint?: string | null,
): Promise<boolean> {
  const id = breakerId(scope, mint);
  const existing = await env.DB.prepare("SELECT open FROM circuit_breakers WHERE id = ?1")
    .bind(id)
    .first<{ open: number }>();
  if (existing && existing.open === 1) return false;
  await setBreaker(env, { scope, mint: mint ?? null, open: true, reason, actor: "risk-cron" });
  return true;
}

/** Closes a breaker only if the cron opened it, so a manual hold is never lifted by a cron. */
export async function autoCloseBreaker(env: RuntimeEnv, scope: BreakerScope, reason: string): Promise<boolean> {
  const id = breakerId(scope, null);
  const existing = await env.DB.prepare("SELECT open, actor FROM circuit_breakers WHERE id = ?1")
    .bind(id)
    .first<{ open: number; actor: string | null }>();
  if (!existing || existing.open !== 1 || existing.actor !== "risk-cron") return false;
  await setBreaker(env, { scope, mint: null, open: false, reason, actor: "risk-cron" });
  return true;
}

