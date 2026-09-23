/**
 * The Worker runtime environment: the generated Env bindings from wrangler.jsonc plus the
 * secrets configured out of band (wrangler secret put, see docs/CUSTODY.md). Every domain
 * module takes a RuntimeEnv so the binding types stay declared in exactly one place.
 */

export interface SecretBindings {
  TURNSTILE_SECRET?: string;
  HELIUS_WEBHOOK_AUTH?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  /** Devnet RPC URL, e.g. a Helius endpoint. Falls back to the public devnet RPC when unset. */
  DIGGO_RPC_URL?: string;
  /** Keeper's base58-encoded 64-byte secret key, JSON-array-stringified (see docs/CUSTODY.md). */
  DIGGO_KEEPER_SECRET_KEY?: string;
  /**
   * Server-only RNG secret for Discovery rolls (wrangler secret put DISCOVERY_SECRET).
   * Every roll is HMAC-derived from it, so it must never be exposed to a client and must never
   * be absent in production: without it the discovery subsystem fails closed and rolls nothing
   * rather than falling back to a predictable seed (spec 55, 56).
   */
  DISCOVERY_SECRET?: string;
  /** Optional tuning overrides for the discovery window/chance; see worker/discovery.ts. */
  DISCOVERY_WINDOW_SECONDS?: string;
  DISCOVERY_ROLL_CHANCE_BPS?: string;
  /**
   * Commit-reveal RNG epoch length in seconds (worker/discovery.ts). Bounded by RNG_EPOCH_BOUNDS
   * and defaulting to a day, so a rehearsal on devnet can roll its commitments over in minutes
   * while a production deployment stays on the daily schedule from spec 55.
   */
  DISCOVERY_EPOCH_SECONDS?: string;
  /**
   * Comma-separated list of admin wallet addresses (see worker/admin.ts). An admin session
   * still has to be a real signed wallet session; this list only says which wallets may use it.
   */
  ADMIN_WALLETS?: string;
  /** Server-side salt for hashing IP/device/network fingerprints (worker/signals.ts). */
  DIGGO_DEVICE_SALT?: string;

  /**
   * Web push credentials (worker/push.ts, RFC 8291 + RFC 8292). All three are optional: without
   * them the push channel reports itself as unavailable and the notification bell stays empty
   * rather than silently dropping alerts. Generate the pair once with `npx web-push
   * generate-vapid-keys` and keep the same pair across deployments — rotating it invalidates every
   * existing browser subscription. VAPID_SUBJECT is a mailto: or https: URL the push service can
   * contact about this application.
   */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  /**
   * Optional Telegram delivery channel for the same notifications (worker/push.ts). The bot token
   * is the only required part; the username is what a player is shown when linking, and the
   * webhook secret authenticates Telegram's own calls back into /webhooks/telegram, which fails
   * closed when it is unset or wrong.
   */
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_BOT_USERNAME?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;

}

/**
 * The price oracle's own configuration (worker/oracle.ts). Every entry is optional and every
 * entry has a working default: the URLs and the Pyth SOL/USD feed id are the public endpoints and
 * the published feed, so an unconfigured deployment still reads a real price. The API keys are
 * the only entries that need `wrangler secret put` — a free Jupiter or Pyth plan raises the rate
 * limit, and without one the oracle simply leans on the other sources.
 */
export interface OracleBindings {
  /** Jupiter price endpoint; defaults to the current public v3 lite endpoint. */
  JUPITER_PRICE_URL?: string;
  /** Older Jupiter price endpoint, still consulted as a second source when it answers. */
  JUPITER_PRICE_V2_URL?: string;
  JUPITER_API_KEY?: string;
  /** Pyth Hermes base URL; defaults to the public hermes.pyth.network. */
  PYTH_HERMES_URL?: string;
  PYTH_API_KEY?: string;
  /** Pyth price feed id for SOL/USD; defaults to the published mainnet feed id. */
  PYTH_SOL_USD_FEED_ID?: string;
  /**
   * How many independent external sources a price has to agree on before it is treated as
   * externally corroborated. Raises ORACLE_LIMITS.minimumExternalSources; 0 (the default) lets a
   * single source stand, which is what devnet runs on.
   */
  ORACLE_MIN_EXTERNAL_SOURCES?: string;
  /**
   * Pins SOL/USD to a fixed number instead of reading an oracle. For local work and rehearsals
   * only: a pinned rate is a display convenience, never a settlement input.
   */
  ORACLE_SOL_USD_OVERRIDE?: string;
}

/**
 * Operations secrets (worker/telemetry.ts). All three are optional on purpose: the Worker must
 * run, and keep logging alerts and metrics locally, whether or not an operator has wired up an
 * alerting webhook or Sentry.
 */
export interface OperationsBindings {
  /**
   * Discord/Slack-compatible incoming-webhook URL that fired alerts are pushed to. Unset means
   * alerts stay in the structured log and in the D1 counters only.
   */
  ALERT_WEBHOOK_URL?: string;
  /**
   * Seconds an identical alert name stays suppressed after a successful delivery, so one
   * sustained condition produces one message per window instead of one per five-minute cron tick.
   */
  ALERT_DEDUPE_SECONDS?: string;
  /**
   * Sentry DSN (https://<public-key>@<host>/<project-id>). When set, unhandled errors in the
   * fetch, scheduled and queue handlers are reported as a plain Sentry envelope over fetch - no
   * SDK, so the Worker bundle stays small and the reporting path has no extra dependencies.
   */
  SENTRY_DSN?: string;
  /** Release tag sent with Sentry events; falls back to the deployed Worker name. */
  SENTRY_RELEASE?: string;
}

export type RuntimeEnv = Env & SecretBindings & OperationsBindings & OracleBindings;

/**
 * Bindings that exist in the deployed Worker but are optional at runtime, so tests and local
 * development exercise the same code paths without them (see wrangler.jsonc).
 *
 * They are read through the accessors below rather than as direct `env.X` properties: the
 * generated `Env` type is regenerated by `npm run types`, and an accessor keeps this module
 * compiling whether or not that file has been regenerated yet, while still narrowing to
 * `undefined` when the binding is genuinely absent.
 */
export interface RateLimiterBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface MetricsDatasetBinding {
  writeDataPoint(event: {
    indexes?: (string | null)[];
    doubles?: number[];
    blobs?: (string | null)[];
  }): void;
}

/** Reads one optional binding without assuming the generated Env declares it. */
export function optionalBinding<T>(env: RuntimeEnv, name: string): T | undefined {
  const value = (env as unknown as Record<string, unknown>)[name];
  return value === undefined || value === null ? undefined : (value as T);
}

/**
 * The Rate Limiting binding (wrangler.jsonc `ratelimits`). Present in production and staging;
 * absent in tests, where the KV counters in worker/http.ts remain the only limiter.
 */
export function rateLimiterBinding(env: RuntimeEnv): RateLimiterBinding | undefined {
  const binding = optionalBinding<RateLimiterBinding>(env, "RATE_LIMITER");
  return binding && typeof binding.limit === "function" ? binding : undefined;
}

/**
 * The Analytics Engine dataset (wrangler.jsonc `analytics_engine_datasets`). Present in
 * production and staging; absent in tests, where telemetry still writes its D1 counters.
 */
export function metricsDatasetBinding(env: RuntimeEnv): MetricsDatasetBinding | undefined {
  const binding = optionalBinding<MetricsDatasetBinding>(env, "DIGGO_METRICS");
  return binding && typeof binding.writeDataPoint === "function" ? binding : undefined;
}
