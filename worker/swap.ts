/**
 * Sell mined coins for SOL through Jupiter, with a platform fee.
 *
 * POST /api/swap/quote { mint, amount }   amount: whole tokens, or "max" for the wallet's balance
 * POST /api/swap/build { quote }          the swap transaction for the signed-in wallet to sign
 * GET  /api/admin/swap-fee-account        whether the fee wallet's wrapped-SOL account exists
 * POST /api/admin/swap-fee-account        an unsigned transaction creating it (admin pays the rent)
 *
 * The fee (SWAP_FEE_BPS, 0.5% by default) is taken in SOL into the fee wallet's wrapped-SOL token
 * account. Jupiter needs that account to exist; until it does, swaps run without a fee rather than
 * fail. The Worker talks to Jupiter so the browser needs no new origins, and it refuses to build a
 * swap whose quote does not carry the platform fee it asked for.
 */
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { adminActor } from "./admin";
import { sessionWallet } from "./auth";
import { getChainRpc } from "./chainV2";
import type { RuntimeEnv } from "./env";
import { apiError, checkRateLimit, checkWalletRateLimit, isBase58Address, json, readJson } from "./http";
import { buildAssociatedTokenAccountInstruction, decodeTokenAccountAmount, decodeTokenMint, deriveAssociatedTokenAddress, meteoraRpcEnv, readAccount } from "./meteora/rpc";
import type { MeteoraRpcEnv } from "./meteora/types";
import { mineFee } from "./projectMines";
import { METEORA_WRAPPED_SOL_MINT } from "../shared/meteora/config";

export const SWAP_FEE_BPS = 50;
const DEFAULT_JUPITER_URL = "https://lite-api.jup.ag/swap/v1";

type SwapEnv = RuntimeEnv & { DIGGO_RPC_URL?: string; SWAP_FEE_BPS?: string; JUPITER_API_URL?: string };

function rpcEnv(env: RuntimeEnv): MeteoraRpcEnv {
  return { ...env, DIGGO_RPC_URL: String((env as SwapEnv).DIGGO_RPC_URL || "") } as MeteoraRpcEnv;
}

export function swapFeeBps(env: RuntimeEnv): number {
  const raw = String((env as SwapEnv).SWAP_FEE_BPS ?? "").trim();
  const parsed = raw === "" ? SWAP_FEE_BPS : Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 200 ? parsed : SWAP_FEE_BPS;
}

function jupiterUrl(env: RuntimeEnv): string {
  const configured = String((env as SwapEnv).JUPITER_API_URL ?? "").trim().replace(/\/+$/, "");
  return /^https:\/\//.test(configured) ? configured : DEFAULT_JUPITER_URL;
}

/** The fee wallet's wrapped-SOL account, where Jupiter pays the SOL fee. */
export function swapFeeAccount(env: RuntimeEnv): string {
  return deriveAssociatedTokenAddress(METEORA_WRAPPED_SOL_MINT, mineFee(env).wallet);
}

async function feeAccountReady(env: RuntimeEnv): Promise<boolean> {
  return Boolean(await readAccount(rpcEnv(env), swapFeeAccount(env)).catch(() => null));
}

/** The fee the quote actually carries, as Jupiter reports it. */
export function quoteFeeBps(quote: unknown): number {
  const fee = (quote as { platformFee?: { feeBps?: unknown } | null } | null)?.platformFee;
  return typeof fee?.feeBps === "number" ? fee.feeBps : 0;
}

/** POST /api/swap/quote */
export async function swapQuote(request: Request, env: RuntimeEnv): Promise<Response> {
  const wallet = await sessionWallet(request, env);
  if (!wallet) return apiError("Sign in with your wallet first", 401);
  if (!(await checkRateLimit(request, env, "swap", 60)) || !(await checkWalletRateLimit(env, wallet, "swap", 60, 60))) return apiError("Too many requests", 429);
  const body = await readJson<{ mint?: unknown; amount?: unknown }>(request, 1_024).catch(() => null);
  const mint = body?.mint;
  if (!isBase58Address(mint) || mint === METEORA_WRAPPED_SOL_MINT) return apiError("Choose a coin to sell");
  const chain = rpcEnv(env);
  const [mintAccount, holding] = await Promise.all([readAccount(chain, mint), readAccount(chain, deriveAssociatedTokenAddress(mint, wallet))]);
  if (!mintAccount) return apiError("That coin does not exist", 404);
  const decimals = decodeTokenMint(mintAccount.data).decimals;
  const balance = holding ? decodeTokenAccountAmount(holding.data) : 0n;
  let amount: bigint;
  if (body?.amount === "max") amount = balance;
  else {
    const whole = String(body?.amount ?? "").trim();
    if (!/^\d{1,18}(\.\d{1,18})?$/.test(whole)) return apiError("Enter an amount");
    const [units, fraction = ""] = whole.split(".");
    amount = BigInt(units!) * 10n ** BigInt(decimals) + BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0");
  }
  if (amount <= 0n) return apiError("You have none of this coin to sell", 400);
  if (amount > balance) return apiError("That is more than your wallet holds", 400);
  const feeBps = (await feeAccountReady(env)) ? swapFeeBps(env) : 0;
  const params = new URLSearchParams({
    inputMint: mint,
    outputMint: METEORA_WRAPPED_SOL_MINT,
    amount: amount.toString(),
    slippageBps: "300",
    swapMode: "ExactIn",
    ...(feeBps > 0 ? { platformFeeBps: String(feeBps) } : {}),
  });
  const response = await fetch(`${jupiterUrl(env)}/quote?${params}`, { headers: { accept: "application/json" } }).catch(() => null);
  if (!response?.ok) return apiError("No route to sell this coin right now", 502);
  const quote = await response.json().catch(() => null) as { outAmount?: string; priceImpactPct?: string } | null;
  if (!quote?.outAmount) return apiError("No route to sell this coin right now", 502);
  return json({
    quote,
    inAmount: amount.toString(),
    decimals,
    balance: balance.toString(),
    outLamports: quote.outAmount,
    priceImpactPct: Number(quote.priceImpactPct ?? 0),
    feeBps,
  }, { headers: { "cache-control": "no-store" } });
}

/** POST /api/swap/build */
export async function swapBuild(request: Request, env: RuntimeEnv): Promise<Response> {
  const wallet = await sessionWallet(request, env);
  if (!wallet) return apiError("Sign in with your wallet first", 401);
  if (!(await checkRateLimit(request, env, "swap-build", 30)) || !(await checkWalletRateLimit(env, wallet, "swap-build", 30, 60))) return apiError("Too many requests", 429);
  const body = await readJson<{ quote?: Record<string, unknown> }>(request, 64_000).catch(() => null);
  const quote = body?.quote;
  if (!quote || quote.outputMint !== METEORA_WRAPPED_SOL_MINT) return apiError("Get a fresh quote first");
  const feeBps = quoteFeeBps(quote);
  const ready = await feeAccountReady(env);
  // A quote that dropped the fee we asked for is refused rather than built.
  if (ready && feeBps !== swapFeeBps(env)) return apiError("Get a fresh quote first");
  const response = await fetch(`${jupiterUrl(env)}/swap`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: wallet,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
      ...(ready && feeBps > 0 ? { feeAccount: swapFeeAccount(env) } : {}),
    }),
  }).catch(() => null);
  if (!response?.ok) return apiError("The swap could not be prepared; get a fresh quote", 502);
  const built = await response.json().catch(() => null) as { swapTransaction?: string } | null;
  if (!built?.swapTransaction) return apiError("The swap could not be prepared; get a fresh quote", 502);
  return json({ transaction: built.swapTransaction, expiresAt: Math.floor(Date.now() / 1_000) + 60 }, { headers: { "cache-control": "no-store" } });
}

/** GET and POST /api/admin/swap-fee-account */
export async function adminSwapFeeAccount(request: Request, env: RuntimeEnv): Promise<Response> {
  const actor = await adminActor(env, request);
  if (!actor) return apiError("Admin session required", 401);
  const account = swapFeeAccount(env);
  const ready = await feeAccountReady(env);
  if (request.method === "GET" || ready) return json({ account, ready, feeBps: swapFeeBps(env) }, { headers: { "cache-control": "no-store" } });
  const chain = rpcEnv(env);
  const blockhash = await getChainRpc(meteoraRpcEnv(chain)).getLatestBlockhash({ commitment: "confirmed" }).send();
  const transaction = compileTransaction(pipe(
    createTransactionMessage({ version: "legacy" }),
    (message) => setTransactionMessageFeePayer(address(actor), message),
    (message) => setTransactionMessageLifetimeUsingBlockhash(blockhash.value, message),
    (message) => appendTransactionMessageInstructions([
      buildAssociatedTokenAccountInstruction({ payer: actor, owner: mineFee(env).wallet, mint: METEORA_WRAPPED_SOL_MINT, associatedToken: account }),
    ], message),
  ));
  return json({ account, ready: false, transaction: getBase64EncodedWireTransaction(transaction), expiresAt: Math.floor(Date.now() / 1_000) + 60 }, { headers: { "cache-control": "no-store" } });
}
