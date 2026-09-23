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
import { metricsDatasetBinding, type RuntimeEnv } from "./env";
import { getSolUsd } from "./oracle";

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
  alertDelivered: "risk.alert_delivered",
  alertSuppressed: "risk.alert_suppressed",
  errorReported: "risk.error_reported",
  /** A score-derived decision the enforcement mode did not act on (worker/risk.ts shadow mode). */
  shadowWouldBlock: "risk.shadow_would_block",
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
  // The same counter also goes to Analytics Engine, where it is queryable as SQL without
  // touching D1. Best effort in both directions: D1 stays the source of truth, AE is for
  // dashboards and alerting queries.
  writeMetricPoint(env, name, value, tags);
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
  /** Discoveries settled in the cluster window, and the value they moved out of a reserve. */
  discoveriesInWindow: number;
  /**
   * The exact lamport figure behind `reserveDrainedInWindowUsd`. The program caps discovery value
   * in lamports, so this is the number that is true without a price.
   */
  reserveDrainedInWindowLamports: string;
  reserveDrainedInWindowUsd: number;
  /** False when no SOL/USD rate was available, in which case every USD figure here is zero. */
  usdPriceAvailable: boolean;
}

function asNumber(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * What counts as a discovery in the index.
 *
 * v2 indexes the roll, not the discovery: every `create_discovery_roll` writes a PENDING row and
 * only `settle_discovery` turns one into a discovery. `rarity` is the program's **0-based tier
 * index** into ProtocolConfig's table, so tier 0 is a real tier - the cheapest one - and must never
 * be read as "no discovery": a roll the seed gives no outcome to settles at tier 0 with no units,
 * exactly like one the coin's own eligibility floors downgrade away. The payout is the only thing
 * that separates a discovery from an empty roll, which is what a v4 `discoveries` row meant too:
 * it was only ever written for a real find.
 *
 * One fragment rather than a copy per caller: cosmetics, achievements, admin triage, risk signals
 * and these metrics all ask the same question and have to answer it the same way.
 */
export const REALIZED_DISCOVERY_PREDICATE = " status = 'SETTLED' AND CAST(units AS INTEGER) > 0";

/**
 * The SOL/USD rate for the display-only USD columns, and whether it was available at all.
 *
 * The spec-66 metric set is specified in USD, but the program caps discovery value in lamports
 * against its own reserves and consults no external price anywhere in a payout path, so the rate
 * is a display conversion and nothing else. An unavailable rate is reported as unavailable rather
 * than as a zero that looks like a measurement: the caller can then read the lamport figure, which
 * needs no rate to be true.
 */
export async function displayUsdRate(env: RuntimeEnv): Promise<{ solUsd: number; available: boolean }> {
  try {
    const quote = await getSolUsd(env);
    return { solUsd: quote.available ? quote.priceUsd : 0, available: quote.available && quote.priceUsd > 0 };
  } catch {
    return { solUsd: 0, available: false };
  }
}

/** Lamports as USD at a display rate: the same conversion `v2CapUsd` applies to a lamport cap. */
export function lamportsToUsd(lamports: number, solUsd: number): number {
  return (lamports / 1_000_000_000) * solUsd;
}

/**
 * One window of discovery economics, in the units the program itself uses.
 *
 * The window is measured from `block_time` - the settle event's own time - because that is when the
 * value actually left the reserve. A roll's `created_at` is when the player committed, which can be
 * a whole opportunity window earlier and, for a roll that is never settled, forever before anything
 * was paid.
 */
const DISCOVERY_AGGREGATE_SQL =
  "SELECT COUNT(*) AS n, COALESCE(SUM(CAST(value_lamports AS INTEGER)), 0) AS total, " +
  "COUNT(DISTINCT wallet) AS wallets FROM discovery_events WHERE block_time >= ?1 AND" +
  REALIZED_DISCOVERY_PREDICATE;

/**
 * Collects the spec-66 metric set: hourly rates from the signal log, discovery economics from
 * the indexed discovery events, cluster sizes from the hashed fingerprints, and drain velocity
 * from the value that actually left a Discovery Reserve in the window.
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
  const [aggregates, rate] = await Promise.all([
    env.DB.batch<DiscoveryAggregateRow | ShareRow>([
      env.DB.prepare(DISCOVERY_AGGREGATE_SQL).bind(hourStart),
      env.DB.prepare(DISCOVERY_AGGREGATE_SQL).bind(clusterStart),
      env.DB.prepare(
        "SELECT MAX(c) AS peak, COALESCE(SUM(c), 0) AS total FROM (SELECT COUNT(*) AS c FROM account_signals " +
          "WHERE action = 'activate' AND outcome = 'ok' AND ts >= ?1 GROUP BY ts / ?2)",
      ).bind(hourStart, config.synchronyBucketSeconds),
    ]),
    displayUsdRate(env),
  ]);
  const [discoveryHour, discoveryWindow, synchrony] = aggregates;

  const hour = discoveryHour.results?.[0] as DiscoveryAggregateRow | undefined;
  const window = discoveryWindow.results?.[0] as DiscoveryAggregateRow | undefined;
  const synchronyRow = synchrony.results?.[0] as ShareRow | undefined;
  const activeAccounts = asNumber(perHourRows[3]?.results?.[0]?.n);
  // The lamport sums are exact; each USD figure is that sum converted once, at one rate.
  const drainedLamports = asNumber(window?.total);
  const hourLamports = asNumber(hour?.total);
  const reserveDrainedInWindowUsd = lamportsToUsd(drainedLamports, rate.solUsd);
  const discoveryValuePerHourUsd = lamportsToUsd(hourLamports, rate.solUsd);
  const budgetUsd =
    DIGGO_CONFIG.discovery.globalDailyCapUsd * (config.clusterWindowSeconds / DIGGO_CONFIG.time.secondsPerDay);
  const discoveriesPerHour = asNumber(hour?.n);

  const snapshot: AlertMetricSnapshot = {
    activationsPerHour: asNumber(perHourRows[0]?.results?.[0]?.n),
    newAccountsPerHour: asNumber(perHourRows[1]?.results?.[0]?.n),
    claimsPerHour: asNumber(perHourRows[2]?.results?.[0]?.n),
    discoveriesPerHour,
    avgDiscoveryValueUsd: discoveriesPerHour > 0 ? discoveryValuePerHourUsd / discoveriesPerHour : 0,
    discoveryValuePerAccountUsd: activeAccounts > 0 ? discoveryValuePerHourUsd / activeAccounts : 0,
    walletsPerDeviceCluster: asNumber(perHourRows[7]?.results?.[0]?.n),
    walletsPerNetworkCluster: asNumber(perHourRows[8]?.results?.[0]?.n),
    failedChallengesPerHour: asNumber(perHourRows[4]?.results?.[0]?.n),
    replayAttemptsPerHour: asNumber(perHourRows[5]?.results?.[0]?.n),
    rateLimitHitsPerHour: asNumber(perHourRows[6]?.results?.[0]?.n),
    synchronizedActivityShare:
      asNumber(synchronyRow?.total) > 0 ? asNumber(synchronyRow?.peak) / asNumber(synchronyRow?.total) : 0,
    reserveDrainVelocityUsdPerHour: discoveryValuePerHourUsd,
    reserveDrainedFraction: budgetUsd > 0 ? Math.min(1, reserveDrainedInWindowUsd / budgetUsd) : 0,
  };
  return {
    snapshot,
    alerts: evaluateAlerts(snapshot, config, now),
    window: { from: clusterStart, to: now, clusterSeconds: config.clusterWindowSeconds },
    discoveriesInWindow: asNumber(window?.n),
    reserveDrainedInWindowLamports: String(drainedLamports),
    reserveDrainedInWindowUsd,
    usdPriceAvailable: rate.available,
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
  // Same alerts, pushed to the operator webhook. Deduped per alert name so a sustained
  // condition does not produce one message per cron tick, and never allowed to throw.
  await deliverAlerts(env, alerts);
}

export { emptyMetricSnapshot };

// --- Analytics Engine ---------------------------------------------------------------------

/**
 * Writes one counter sample to the Analytics Engine dataset (wrangler.jsonc `DIGGO_METRICS`).
 * No-op when the binding is absent (tests, local development), so callers never branch on it.
 *
 * Layout: `index1` is the metric name (the sampling key), `blob1` the name, `blob2` the canonical
 * tag string, `blob3` the hour bucket (as text, so it groups directly in SQL) and `double1` the
 * value. Tags are deliberately canonicalised the same way as in D1, so a query over either store
 * collapses onto the same series.
 */
export function writeMetricPoint(
  env: RuntimeEnv,
  name: string,
  value: number,
  tags: Record<string, string> = {},
): void {
  const dataset = metricsDatasetBinding(env);
  if (!dataset) return;
  try {
    dataset.writeDataPoint({
      indexes: [name],
      doubles: [value],
      blobs: [name, canonicalTags(tags), String(hourBucket())],
    });
  } catch (error) {
    console.error(JSON.stringify({ event: "risk.metric_point_failed", name, error: String(error) }));
  }
}

// --- Alert delivery -----------------------------------------------------------------------

/** Default suppression window for a repeated alert name. */
export const ALERT_DEDUPE_DEFAULT_SECONDS = 1_800;
/** A zero window disables dedupe; anything above a day is pointless for a five-minute cron. */
export const ALERT_DEDUPE_MAX_SECONDS = 86_400;
/** Upper bound on webhook messages one cron tick may send, so a metric storm is not a spam storm. */
export const ALERT_DELIVERY_MAX_PER_CALL = 5;

/** Parses ALERT_DEDUPE_SECONDS, clamped into range and falling back to the default. */
export function alertDedupeSeconds(env: RuntimeEnv): number {
  const raw = env.ALERT_DEDUPE_SECONDS;
  // An unset or blank value means "use the default"; only an explicit "0" turns dedupe off.
  if (raw === undefined || raw.trim() === "") return ALERT_DEDUPE_DEFAULT_SECONDS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return ALERT_DEDUPE_DEFAULT_SECONDS;
  return Math.min(ALERT_DEDUPE_MAX_SECONDS, Math.max(0, Math.floor(parsed)));
}

/** One KV key per alert rule name; the value is the delivery timestamp (unix seconds). */
export function alertDedupeKey(name: string): string {
  return "alert:dedupe:" + name;
}

/**
 * Discord and Slack compatible payload: Discord reads `content`, Slack reads `text`, and the
 * structured `alerts` array is there for anything that wants to parse instead of display.
 */
export function alertWebhookPayload(
  alerts: readonly RiskAlert[],
  environment: string,
): Record<string, unknown> {
  const lines = alerts.map(
    (alert) =>
      "[" +
      alert.severity.toUpperCase() +
      "] " +
      alert.name +
      " " +
      alert.metric +
      "=" +
      formatMetricValue(alert.metricValue) +
      " (threshold " +
      formatMetricValue(alert.threshold) +
      ")",
  );
  const text = "diggo.fun " + environment + " alert\n" + lines.join("\n");
  return {
    content: text,
    text,
    environment,
    alerts: alerts.map((alert) => ({
      name: alert.name,
      metric: alert.metric,
      severity: alert.severity,
      value: alert.metricValue,
      threshold: alert.threshold,
      observedAt: alert.observedAt,
    })),
  };
}

function formatMetricValue(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  return Math.abs(value) >= 1_000 ? value.toFixed(0) : String(Math.round(value * 1_000) / 1_000);
}

export interface AlertDeliveryOptions {
  now?: number;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  maxMessages?: number;
}

export interface AlertDeliveryResult {
  configured: boolean;
  delivered: string[];
  suppressed: string[];
  failed: string[];
}

/**
 * Pushes fired alerts to ALERT_WEBHOOK_URL, one message per alert rule, suppressing a name that
 * was already delivered inside the dedupe window.
 *
 * The dedupe key is only written after a webhook actually accepted the message: a failed delivery
 * must be retried on the next tick rather than swallowed for half an hour. Never throws - an alert
 * channel being down must not break the cron, and every failure is logged and counted instead.
 */
export async function deliverAlerts(
  env: RuntimeEnv,
  alerts: readonly RiskAlert[],
  options: AlertDeliveryOptions = {},
): Promise<AlertDeliveryResult> {
  const result: AlertDeliveryResult = { configured: false, delivered: [], suppressed: [], failed: [] };
  const webhook = env.ALERT_WEBHOOK_URL;
  if (alerts.length === 0 || !webhook) return result;
  result.configured = true;

  const dedupeSeconds = alertDedupeSeconds(env);
  const now = options.now ?? Math.floor(Date.now() / 1_000);
  const send = options.fetchImpl ?? fetch;
  const maxMessages = options.maxMessages ?? ALERT_DELIVERY_MAX_PER_CALL;
  const environment = env.ENVIRONMENT ?? "production";

  for (const alert of alerts) {
    const key = alertDedupeKey(alert.name);
    if (dedupeSeconds > 0) {
      try {
        const seen = await env.TOKEN_CACHE.get(key);
        if (seen !== null) {
          result.suppressed.push(alert.name);
          await metric(env, METRIC.alertSuppressed, 1, { name: alert.name, severity: alert.severity });
          continue;
        }
      } catch (failure) {
        // An unreadable dedupe key means we cannot prove we already sent this; deliver it.
        console.error(JSON.stringify({ event: "risk.alert_dedupe_read_failed", error: String(failure) }));
      }
    }
    if (result.delivered.length >= maxMessages) break;
    try {
      const response = await send(webhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(alertWebhookPayload([alert], environment)),
      });
      if (!response.ok) throw new Error("webhook responded " + response.status);
      result.delivered.push(alert.name);
      await metric(env, METRIC.alertDelivered, 1, { name: alert.name, severity: alert.severity });
      if (dedupeSeconds > 0) {
        try {
          await env.TOKEN_CACHE.put(key, String(now), { expirationTtl: dedupeSeconds });
        } catch (failure) {
          console.error(JSON.stringify({ event: "risk.alert_dedupe_write_failed", error: String(failure) }));
        }
      }
    } catch (failure) {
      result.failed.push(alert.name);
      console.error(
        JSON.stringify({ event: "risk.alert_delivery_failed", name: alert.name, error: String(failure) }),
      );
    }
  }
  return result;
}

// --- Error tracking -----------------------------------------------------------------------

export interface SentryTarget {
  /** Full envelope endpoint, derived from the DSN. */
  endpoint: string;
  publicKey: string;
  projectId: string;
}

/** Splits `https://<public-key>@<host>/<project-id>` into its parts; null when unusable. */
export function parseSentryDsn(dsn: string | undefined): SentryTarget | null {
  if (!dsn) return null;
  try {
    const url = new URL(dsn);
    const publicKey = url.username;
    const projectId = url.pathname.replace(/^\/+/, "").split("/")[0] ?? "";
    if (!publicKey || !projectId) return null;
    return { endpoint: url.protocol + "//" + url.host + "/api/" + projectId + "/envelope/", publicKey, projectId };
  } catch {
    return null;
  }
}

export interface ErrorReportOptions {
  fetchImpl?: typeof fetch;
  now?: number;
  release?: string;
}

/** Normalises anything thrown into Sentry exception fields. */
function describeError(error: unknown): { type: string; value: string; stack: string | null } {
  if (error instanceof Error) {
    return { type: error.name || "Error", value: error.message || "(no message)", stack: error.stack ?? null };
  }
  return { type: "NonError", value: typeof error === "string" ? error : JSON.stringify(error) ?? "unknown", stack: null };
}

/** Sentry event context has to survive JSON.stringify; anything that cannot becomes a marker. */
function serializableContext(context: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(context)) as Record<string, unknown>;
  } catch {
    return { unserializableContext: true };
  }
}

/**
 * Reports one unhandled error to Sentry as a plain envelope POST - no SDK, no dependencies, so the
 * reporting path cannot itself pull the Worker bundle or the request path down.
 *
 * Returns true when Sentry accepted the envelope. No-op returning false when SENTRY_DSN is unset
 * (tests, local development, any deployment that has not opted in).
 */
export async function reportError(
  env: RuntimeEnv,
  error: unknown,
  context: Record<string, unknown> = {},
  options: ErrorReportOptions = {},
): Promise<boolean> {
  const target = parseSentryDsn(env.SENTRY_DSN);
  if (!target) return false;
  const now = options.now ?? Math.floor(Date.now() / 1_000);
  const eventId = crypto.randomUUID().replaceAll("-", "");
  const described = describeError(error);
  const extra = serializableContext(context);
  const event = {
    event_id: eventId,
    timestamp: now,
    level: "error",
    platform: "javascript",
    logger: "diggo.worker",
    environment: env.ENVIRONMENT ?? "production",
    release: options.release ?? env.SENTRY_RELEASE ?? env.ENVIRONMENT ?? "production",
    message: { formatted: described.type + ": " + described.value },
    // No stacktrace frames: a Worker stack is a formatted string, not V8 CallSite objects, so
    // the stack travels in `extra.stack` where it stays readable instead of being mangled.
    exception: { values: [{ type: described.type, value: described.value }] },
    extra: described.stack ? { ...extra, stack: described.stack } : extra,
  };
  const envelope =
    [
      JSON.stringify({ event_id: eventId, dsn: env.SENTRY_DSN, sent_at: new Date(now * 1_000).toISOString() }),
      JSON.stringify({ type: "event", content_type: "application/json" }),
      JSON.stringify(event),
    ].join("\n") + "\n";
  try {
    const response = await (options.fetchImpl ?? fetch)(target.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-sentry-envelope",
        "x-sentry-auth":
          "Sentry sentry_version=7, sentry_client=diggo-worker/1.0, sentry_key=" + target.publicKey,
      },
      body: envelope,
    });
    if (!response.ok) {
      console.error(JSON.stringify({ event: "error_report.rejected", status: response.status, eventId }));
      return false;
    }
    await metric(env, METRIC.errorReported, 1, {});
    return true;
  } catch (failure) {
    console.error(JSON.stringify({ event: "error_report.failed", error: String(failure), eventId }));
    return false;
  }
}
