/**
 * Telemetry (spec 66): named counters in D1 plus an alert-ready evaluation of the metric set
 * the anti-abuse spec asks for. Everything here is best effort - telemetry must never break a
 * player request - and every alert is logged as structured JSON so an external integration can
 * pick it up without a code change.
 */
import { DIGGO_CONFIG } from "../shared/config";
import {
  type AlertMetricSnapshot,
  RISK_OPS,
  type RiskAlert,
  type RiskOpsConfig,
  emptyMetricSnapshot,
  evaluateAlerts,
} from "../shared/riskOps";
import type { RuntimeEnv } from "./env";

/** Canonical counter names. Callers pass these rather than raw strings. */
export const METRIC = {
  rateLimitHit: "risk.rate_limit_hit",
  failedChallenge: "risk.failed_challenge",
  replayAttempt: "risk.replay_attempt",
  discoveryRolled: "risk.discovery_rolled",
  discoveryClaimed: "risk.discovery_claimed",
  challengeCleared: "risk.challenge_cleared",
  breakerOpened: "risk.breaker_opened",
  breakerClosed: "risk.breaker_closed",
  alert: "risk.alert",
  riskRefresh: "risk.account_refreshed",
} as const;

export type MetricName = (typeof METRIC)[keyof typeof METRIC];

/** Canonical tag string so identical tag sets collapse onto one counter row. */
export function canonicalTags(tags: Record<string, string> = {}): string {
  return Object.keys(tags)
    .sort()
    .map((key) => key + "=" + tags[key])
    .join(",");
}

/** Hour bucket (unix seconds) a counter increment belongs to. */
export function hourBucket(now = Math.floor(Date.now() / 1_000)): number {
  return now - (now % DIGGO_CONFIG.time.secondsPerHour);
}

/** Increments one counter for the current hour. Never throws. */
export async function metric(
  env: RuntimeEnv,
  name: string,
  value = 1,
  tags: Record<string, string> = {},
): Promise<void> {
  try {
    await env.DB.prepare(
      "INSERT INTO metrics_counters (name, bucket_hour, tags, value) VALUES (?1, ?2, ?3, ?4) " +
        "ON CONFLICT(name, bucket_hour, tags) DO UPDATE SET value = value + excluded.value",
    )
      .bind(name, hourBucket(), canonicalTags(tags), value)
      .run();
  } catch (error) {
    console.error(JSON.stringify({ event: "risk.metric_write_failed", name, error: String(error) }));
  }
}

export interface CounterRow {
  name: string;
  bucket_hour: number;
  tags: string;
  value: number;
}

export async function readCounters(env: RuntimeEnv, windowHours = 24): Promise<CounterRow[]> {
  const from = hourBucket() - (windowHours - 1) * DIGGO_CONFIG.time.secondsPerHour;
  const result = await env.DB.prepare(
    "SELECT name, bucket_hour, tags, SUM(value) AS value FROM metrics_counters WHERE bucket_hour >= ?1 " +
      "GROUP BY name, bucket_hour, tags ORDER BY bucket_hour DESC, name",
  )
    .bind(from)
    .all<CounterRow>();
  return result.results;
}

interface CountRow {
  n: number | null;
}

interface DiscoveryAggregateRow {
  n: number | null;
  total: number | null;
  wallets: number | null;
}

interface ShareRow {
  peak: number | null;
  total: number | null;
}

export interface MetricReport {
  snapshot: AlertMetricSnapshot;
  alerts: RiskAlert[];
  window: { from: number; to: number; clusterSeconds: number };
  /** Discoveries created in the cluster window, and the USD value they moved out of a reserve. */
  discoveriesInWindow: number;
  reserveDrainedInWindowUsd: number;
}

function asNumber(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Collects the spec-66 metric set: hourly rates from the signal log, discovery economics from
 * the discoveries table, cluster sizes from the hashed fingerprints, and drain velocity from
 * the value that actually left a Discovery Reserve in the window.
 */
export async function collectMetrics(
  env: RuntimeEnv,
  now = Math.floor(Date.now() / 1_000),
  config: RiskOpsConfig = RISK_OPS,
): Promise<MetricReport> {
  const hourStart = now - DIGGO_CONFIG.time.secondsPerHour;
  const clusterStart = now - config.clusterWindowSeconds;
  const perHourRows = await env.DB.batch<CountRow>([
    // Activations are counted from the players row, which is the authoritative gameplay write,
    // so the metric stays correct even if a caller forgets to log its own signal.
    env.DB.prepare("SELECT COUNT(*) AS n FROM players WHERE last_activation_at >= ?1").bind(hourStart),
    env.DB.prepare("SELECT COUNT(*) AS n FROM players WHERE created_at >= ?1").bind(hourStart),
    env.DB.prepare(
      "SELECT COUNT(*) AS n FROM account_signals WHERE action IN ('claim_reward', 'claim_discovery') " +
        "AND outcome = 'ok' AND ts >= ?1",
    ).bind(hourStart),
    env.DB.prepare("SELECT COUNT(*) AS n FROM players WHERE last_activation_at >= ?1").bind(hourStart),
    env.DB.prepare("SELECT COUNT(*) AS n FROM account_signals WHERE outcome = 'failed_challenge' AND ts >= ?1").bind(
      hourStart,
    ),
    env.DB.prepare("SELECT COUNT(*) AS n FROM account_signals WHERE outcome = 'replay' AND ts >= ?1").bind(hourStart),
    env.DB.prepare("SELECT COUNT(*) AS n FROM account_signals WHERE outcome = 'rate_limited' AND ts >= ?1").bind(
      hourStart,
    ),
    env.DB.prepare(
      "SELECT MAX(c) AS n FROM (SELECT COUNT(DISTINCT wallet) AS c FROM account_signals " +
        "WHERE device_hash IS NOT NULL AND ts >= ?1 GROUP BY device_hash)",
    ).bind(clusterStart),
    env.DB.prepare(
      "SELECT MAX(c) AS n FROM (SELECT COUNT(DISTINCT wallet) AS c FROM account_signals " +
        "WHERE network_hash IS NOT NULL AND ts >= ?1 GROUP BY network_hash)",
    ).bind(clusterStart),
  ]);
  const [discoveryHour, discoveryWindow, synchrony] = await env.DB.batch<DiscoveryAggregateRow | ShareRow>([
    env.DB.prepare(
      "SELECT COUNT(*) AS n, COALESCE(SUM(value_usd), 0) AS total, COUNT(DISTINCT wallet) AS wallets " +
        "FROM discoveries WHERE created_at >= ?1",
    ).bind(hourStart),
    env.DB.prepare(
      "SELECT COUNT(*) AS n, COALESCE(SUM(value_usd), 0) AS total, COUNT(DISTINCT wallet) AS wallets " +
        "FROM discoveries WHERE created_at >= ?1",
    ).bind(clusterStart),
    env.DB.prepare(
      "SELECT MAX(c) AS peak, COALESCE(SUM(c), 0) AS total FROM (SELECT COUNT(*) AS c FROM account_signals " +
        "WHERE action = 'activate' AND outcome = 'ok' AND ts >= ?1 GROUP BY ts / ?2)",
    ).bind(hourStart, config.synchronyBucketSeconds),
  ]);

  const hour = discoveryHour.results?.[0] as DiscoveryAggregateRow | undefined;
  const window = discoveryWindow.results?.[0] as DiscoveryAggregateRow | undefined;
  const synchronyRow = synchrony.results?.[0] as ShareRow | undefined;
  const activeAccounts = asNumber(perHourRows[3]?.results?.[0]?.n);
  const reserveDrainedInWindowUsd = asNumber(window?.total);
  const budgetUsd =
    DIGGO_CONFIG.discovery.globalDailyCapUsd * (config.clusterWindowSeconds / DIGGO_CONFIG.time.secondsPerDay);
  const discoveriesPerHour = asNumber(hour?.n);

  const snapshot: AlertMetricSnapshot = {
    activationsPerHour: asNumber(perHourRows[0]?.results?.[0]?.n),
    newAccountsPerHour: asNumber(perHourRows[1]?.results?.[0]?.n),
    claimsPerHour: asNumber(perHourRows[2]?.results?.[0]?.n),
    discoveriesPerHour,
    avgDiscoveryValueUsd: discoveriesPerHour > 0 ? asNumber(hour?.total) / discoveriesPerHour : 0,
    discoveryValuePerAccountUsd: activeAccounts > 0 ? asNumber(hour?.total) / activeAccounts : 0,
    walletsPerDeviceCluster: asNumber(perHourRows[7]?.results?.[0]?.n),
    walletsPerNetworkCluster: asNumber(perHourRows[8]?.results?.[0]?.n),
    failedChallengesPerHour: asNumber(perHourRows[4]?.results?.[0]?.n),
    replayAttemptsPerHour: asNumber(perHourRows[5]?.results?.[0]?.n),
    rateLimitHitsPerHour: asNumber(perHourRows[6]?.results?.[0]?.n),
    synchronizedActivityShare:
      asNumber(synchronyRow?.total) > 0 ? asNumber(synchronyRow?.peak) / asNumber(synchronyRow?.total) : 0,
    reserveDrainVelocityUsdPerHour: asNumber(hour?.total),
    reserveDrainedFraction: budgetUsd > 0 ? Math.min(1, reserveDrainedInWindowUsd / budgetUsd) : 0,
  };
  return {
    snapshot,
    alerts: evaluateAlerts(snapshot, config, now),
    window: { from: clusterStart, to: now, clusterSeconds: config.clusterWindowSeconds },
    discoveriesInWindow: asNumber(window?.n),
    reserveDrainedInWindowUsd,
  };
}

/** Snapshot only, for callers that do not need the window detail. */
export async function metricSnapshot(
  env: RuntimeEnv,
  now = Math.floor(Date.now() / 1_000),
  config: RiskOpsConfig = RISK_OPS,
): Promise<AlertMetricSnapshot> {
  return (await collectMetrics(env, now, config)).snapshot;
}

/** Logs each alert as one structured JSON line and bumps its counter. */
export async function logAlerts(env: RuntimeEnv, alerts: readonly RiskAlert[]): Promise<void> {
  for (const alert of alerts) {
    console.log(
      JSON.stringify({
        event: "risk.alert",
        name: alert.name,
        metric: alert.metric,
        severity: alert.severity,
        value: alert.value,
        threshold: alert.threshold,
        observedAt: alert.observedAt,
      }),
    );
    await metric(env, METRIC.alert, 1, { severity: alert.severity, name: alert.name });
  }
}

export { emptyMetricSnapshot };
