import { sessionWallet } from "../auth";
import { apiError, checkRateLimit, checkWalletRateLimit, isBase58Address, json, readJson } from "../http";
import { verifyAndIndexMeteoraPool } from "./indexer";
import type { MeteoraRpcEnv } from "./types";

/** Registers a launch without trusting the client-reported pool: on-chain state must prove it. */
export async function registerMeteoraPool(request: Request, env: MeteoraRpcEnv): Promise<Response> {
  const wallet = await sessionWallet(request, env);
  if (!wallet) return apiError("Wallet session required", 401);
  if (!(await checkRateLimit(request, env, "meteora-register", 12))
    || !(await checkWalletRateLimit(env, wallet, "meteora-register", 12, 60))) {
    return apiError("Too many requests", 429);
  }
  const body = await readJson<{ pool?: string; mint?: string }>(request, 4_096);
  const pool = body.pool ?? body.mint;
  if (!isBase58Address(pool)) return apiError("Invalid pool address");
  let record;
  try {
    record = await verifyAndIndexMeteoraPool(env, pool);
  } catch (error) {
    return apiError(error instanceof Error ? error.message : "Meteora pool verification failed", 404);
  }
  if (record.creator !== wallet) return apiError("Only the pool's creator may register it", 403);
  return json({ pool: record.pool, mint: record.baseMint, config: record.config });
}
