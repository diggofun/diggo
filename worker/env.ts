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
   * Comma-separated list of admin wallet addresses (see worker/admin.ts). An admin session
   * still has to be a real signed wallet session; this list only says which wallets may use it.
   */
  ADMIN_WALLETS?: string;
  /** Server-side salt for hashing IP/device/network fingerprints (worker/signals.ts). */
  DIGGO_DEVICE_SALT?: string;

}

export type RuntimeEnv = Env & SecretBindings;
