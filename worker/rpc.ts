/**
 * Solana JSON-RPC proxy. The frontend @solana/kit client points at /api/rpc instead of the
 * upstream URL, so the Helius API key never reaches the browser. Only the allowlisted read/send
 * methods below are forwarded.
 */
import { DEFAULT_DEVNET_RPC } from "./chain";
import type { RuntimeEnv } from "./env";
import { apiError, checkRateLimit } from "./http";

const RPC_METHOD_ALLOWLIST = new Set([
  "getAccountInfo",
  "getMultipleAccounts",
  "getBalance",
  "getLatestBlockhash",
  "getSignatureStatuses",
  "getTokenAccountBalance",
  "getMinimumBalanceForRentExemption",
  "sendTransaction",
  "simulateTransaction",
  "getSlot",
  "getVersion",
]);

/**
 * Proxies JSON-RPC calls to the configured Solana RPC (a Helius devnet endpoint, when
 * DIGGO_RPC_URL is set as a secret) so the API key never reaches the browser. The frontend's
 * @solana/kit RPC client is pointed at this relative path instead of the upstream URL directly.
 * Restricted to a read/send allowlist — no admin or account-mutating RPC methods.
 */
export async function proxyRpc(request: Request, env: RuntimeEnv): Promise<Response> {
  if (!(await checkRateLimit(request, env, "rpc", 240))) return apiError("Too many requests", 429);
  const raw = await request.text();
  if (raw.length > 65_536) return apiError("Payload too large", 413);
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return apiError("Invalid JSON-RPC payload");
  }
  const calls = Array.isArray(payload) ? payload : [payload];
  for (const call of calls) {
    const method = (call as { method?: unknown })?.method;
    if (typeof method !== "string" || !RPC_METHOD_ALLOWLIST.has(method)) {
      return apiError(`RPC method not allowed: ${String(method)}`, 403);
    }
  }
  const upstream = await fetch(env.DIGGO_RPC_URL || DEFAULT_DEVNET_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw,
  });
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
