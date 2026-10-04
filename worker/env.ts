/**
 * The Worker runtime environment: the generated bindings from wrangler.jsonc plus the secrets
 * configured out of band (`wrangler secret put`).
 *
 * The v2 surface is deliberately smaller than the v4 one. Gone are the keeper's signing key
 * and the server-side RNG secret: the worker no longer holds a key the program trusts for
 * anything, and it no longer rolls any dice. What is left is an RPC endpoint, a webhook secret,
 * the notification credentials and - optionally - a crank hot key that pays transaction fees
 * and nothing else.
 */

export interface SecretBindings {
  TURNSTILE_SECRET?: string;
  HELIUS_WEBHOOK_AUTH?: string;
  /** Secret required for the operator-only manual indexer refresh endpoints. */
  INDEXER_ADMIN_SECRET?: string;
  /** Cluster-matched RPC URL. Mainnet deployments should set this to a keyed provider secret. */
  DIGGO_RPC_URL?: string;
  /** Comma-separated fallback RPC endpoints, tried after DIGGO_RPC_URL. */
  DIGGO_RPC_URLS?: string;
  /**
   * The optional crank bot's fee payer, base58-encoded 64-byte secret key, JSON-array
   * stringified (see docs/CUSTODY.md).
   *
   * This key has **no authority of any kind**. Every instruction the crank sends -
   * `advance_mine`, `commit_epoch_seed`, `settle_discovery`, `graduate_market`, `sweep_fees`,
   * `crank_tip` - is permissionless, so a stranger could send it with their own wallet. The key
   * exists to pay the network fee, and a leaked one costs its holder the fees it was already
   * paying. Unset means the crank is off and the protocol still works: every user-signed
   * instruction opportunistically advances the coin it touches.
   */
  DIGGO_CRANK_SECRET_KEY?: string;
  /**
   * Comma-separated list of admin wallet addresses (see worker/admin.ts). An admin session still
   * has to be a real signed wallet session; this list only says which wallets may use it, and the
   * admin surface can no longer move funds, halt a mine or touch a reserve.
   */
  ADMIN_WALLETS?: string;
  /** Server-side salt for hashing IP/device/network fingerprints (worker/signals.ts). */
  DIGGO_DEVICE_SALT?: string;

  /**
   * Web push credentials (worker/push.ts, RFC 8291 + RFC 8292). All three are optional: without
   * them the push channel reports itself as unavailable and the notification bell stays empty
   * rather than silently dropping alerts.
   */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  /** Optional Telegram delivery channel for the same notifications (worker/push.ts). */
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_BOT_USERNAME?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
}

/**
 * The price oracle's configuration (worker/oracle.ts). In v2 the oracle is display-only: the
 * program prices its own discovery caps from its own pool TWAP and consults no external source,
 * so nothing here is a settlement input.
 */
export interface OracleBindings {
  JUPITER_PRICE_URL?: string;
  JUPITER_PRICE_V2_URL?: string;
  JUPITER_API_KEY?: string;
  PYTH_HERMES_URL?: string;
  PYTH_API_KEY?: string;
  PYTH_SOL_USD_FEED_ID?: string;
  ORACLE_MIN_EXTERNAL_SOURCES?: string;
  /**
   * Pins SOL/USD to a fixed number instead of reading an oracle. For local work and rehearsals
   * only: a pinned rate is a display convenience, never a settlement input.
   */
  ORACLE_SOL_USD_OVERRIDE?: string;
}

/** Operations secrets (worker/telemetry.ts). All optional on purpose. */
export interface OperationsBindings {
  ALERT_WEBHOOK_URL?: string;
  ALERT_DEDUPE_SECONDS?: string;
  SENTRY_DSN?: string;
  SENTRY_RELEASE?: string;
}

/** Indexer tuning. Every entry has a working default, so an unconfigured deployment indexes. */
export interface IndexerBindings {
  /** Signatures read per cron pass, per page. Bounded so one pass cannot run past its budget. */
  INDEXER_SIGNATURE_LIMIT?: string;
  /** How many pages of signatures one cron pass may walk. */
  INDEXER_MAX_PAGES?: string;
  /** Coin accounts re-read per pass. */
  INDEXER_COIN_LIMIT?: string;
  /** "0" turns the optional crank bot off without removing its key. */
  CRANK_ENABLED?: string;
}

/** Temporary Meteora bridge settings. The secret key itself is never declared here. */
export interface MeteoraBindings {
  CHAIN_MODE?: string;
  SOLANA_CLUSTER?: string;
  METEORA_DBC_CONFIG?: string;
  /**
   * The platform official coin's mint ($DIGGO), served by GET /api/config as `officialMint`.
   *
   * Not a secret: a mint address is public. It is read through the optional-binding accessor and
   * validated as a base58 pubkey before it ever reaches a client, so the empty value it ships with
   * means "not launched" rather than "empty market" (shared/officialMint.ts).
   */
  DIGGO_OFFICIAL_MINT?: string;
  MINING_VAULT_PUBLIC_KEY?: string;
  MINING_CLAIM_PER_CLAIM?: string;
  MINING_CLAIM_PER_DAY?: string;
  MINING_VAULT_SWEEP_LIMIT?: string;
  /** Secret name only; never place the vault key in wrangler.jsonc. */
  MINING_VAULT_SECRET?: string;
}

type RuntimeEnvBindingOverrides = "CHAIN_MODE" | "DIGGO_RPC_URL" | "DIGGO_RPC_URLS";

export type RuntimeEnv = Omit<Env, RuntimeEnvBindingOverrides> &
  SecretBindings &
  OperationsBindings &
  OracleBindings &
  IndexerBindings &
  MeteoraBindings;

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

/** The Rate Limiting binding (wrangler.jsonc `ratelimits`). */
export function rateLimiterBinding(env: RuntimeEnv): RateLimiterBinding | undefined {
  const binding = optionalBinding<RateLimiterBinding>(env, "RATE_LIMITER");
  return binding && typeof binding.limit === "function" ? binding : undefined;
}

/** The Analytics Engine dataset (wrangler.jsonc `analytics_engine_datasets`). */
export function metricsDatasetBinding(env: RuntimeEnv): MetricsDatasetBinding | undefined {
  const binding = optionalBinding<MetricsDatasetBinding>(env, "DIGGO_METRICS");
  return binding && typeof binding.writeDataPoint === "function" ? binding : undefined;
}

/** Reads a positive integer override, falling back to `fallback` for anything unusable. */
function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** Signatures per RPC page. Helius caps this at 1,000. */
export const signatureLimit = (env: RuntimeEnv): number =>
  boundedInt(env.INDEXER_SIGNATURE_LIMIT, 500, 1, 1_000);

/** Pages of signatures per pass, so a backlog is worked off over several passes. */
export const maxSignaturePages = (env: RuntimeEnv): number =>
  boundedInt(env.INDEXER_MAX_PAGES, 3, 1, 20);

/** Coin accounts re-read per pass. */
export const coinLimit = (env: RuntimeEnv): number =>
  boundedInt(env.INDEXER_COIN_LIMIT, 1_000, 1, 2_000);

/**
 * Whether the optional crank bot should run. Off unless a key is present and nothing explicitly
 * disabled it, because an unconfigured deployment must not try to spend SOL it does not have.
 */
export function crankEnabled(env: RuntimeEnv): boolean {
  // Read through the optional-binding accessor rather than as `env.CRANK_ENABLED`: the generated
  // `Env` type narrows a var to the literal in wrangler.jsonc, so comparing it to another value is
  // a type error the moment someone changes the var. This reads whatever is actually configured.
  const flag = optionalBinding<string>(env, "CRANK_ENABLED");
  if (flag === "0" || flag === "false") return false;
  return typeof env.DIGGO_CRANK_SECRET_KEY === "string" && env.DIGGO_CRANK_SECRET_KEY.length > 0;
}
