/**
 * Boosts: SOL paid to push a mine up for a while (shared/boost.ts).
 *
 * POST /api/mines/boost/prepare { mint, tier }      an unsigned SOL transfer to the fee wallet
 * POST /api/mines/boost/confirm { signature, mint, tier }
 *
 * Anyone can boost any open mine: a creator for their own coin, or a community for the coin it
 * holds. The boost is recorded only when the chain shows the payment landed in the fee wallet from
 * the signed-in wallet, and each payment counts once.
 */
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Instruction,
} from "@solana/kit";
import { sessionWallet } from "./auth";
import { getChainRpc } from "./chainV2";
import type { RuntimeEnv } from "./env";
import type { GameEnv } from "./game/contracts";
import { apiError, checkRateLimit, checkWalletRateLimit, isBase58Address, json, readJson } from "./http";
import { meteoraRpcEnv, readTransaction, type MeteoraTransaction } from "./meteora/rpc";
import type { MeteoraRpcEnv } from "./meteora/types";
import { SYSTEM_PROGRAM_ID } from "./meteora/types";
import { meteoraCoinSource } from "./modes/meteora";
import { mineFee } from "./projectMines";
import { boostTier, boostWindow } from "../shared/boost";

export { activeBoosts } from "./boostState";

function rpcEnv(env: RuntimeEnv): MeteoraRpcEnv {
  const extra = env as RuntimeEnv & { DIGGO_RPC_URL?: string };
  return { ...env, DIGGO_RPC_URL: String(extra.DIGGO_RPC_URL || "") } as MeteoraRpcEnv;
}

/** SystemProgram.transfer: instruction 2, then the lamports as a little-endian u64. */
export function systemTransferInstruction(from: string, to: string, lamports: bigint): Instruction {
  const data = new Uint8Array(12);
  data[0] = 2;
  for (let index = 0; index < 8; index += 1) data[4 + index] = Number((lamports >> BigInt(index * 8)) & 0xffn);
  return {
    programAddress: address(SYSTEM_PROGRAM_ID),
    accounts: [
      { address: address(from), role: AccountRole.WRITABLE_SIGNER },
      { address: address(to), role: AccountRole.WRITABLE },
    ],
    data,
  };
}

/**
 * Whether a landed transaction paid at least `lamports` into `feeWallet` and was paid for by `payer`
 * (the fee payer is the first account and always signs).
 */
export function paidBoost(transaction: MeteoraTransaction, expected: { payer: string; feeWallet: string; lamports: bigint }): boolean {
  if (transaction.failed || transaction.accountKeys[0] !== expected.payer) return false;
  const index = transaction.accountKeys.indexOf(expected.feeWallet);
  if (index < 0) return false;
  const before = transaction.preBalances?.[index];
  const after = transaction.postBalances?.[index];
  if (before === undefined || after === undefined) return false;
  return after - before >= expected.lamports;
}

async function boostedUntil(db: D1Database, mint: string): Promise<number | null> {
  const row = await db.prepare("SELECT MAX(ends_at) AS ends_at FROM mine_boosts WHERE mint = ?1").bind(mint).first<{ ends_at: number | null }>();
  return row?.ends_at ? Number(row.ends_at) : null;
}

async function openMine(env: RuntimeEnv, mint: unknown): Promise<string | null> {
  if (!isBase58Address(mint)) return null;
  const coin = await meteoraCoinSource(env as GameEnv).getMine(mint);
  return coin && !coin.graduated ? mint : null;
}

/** POST /api/mines/boost/prepare */
export async function prepareBoost(request: Request, env: RuntimeEnv): Promise<Response> {
  const wallet = await sessionWallet(request, env);
  if (!wallet) return apiError("Sign in with your wallet first", 401);
  if (!(await checkRateLimit(request, env, "boost", 20)) || !(await checkWalletRateLimit(env, wallet, "boost", 20, 60))) {
    return apiError("Too many requests", 429);
  }
  const body = await readJson<{ mint?: unknown; tier?: unknown }>(request, 1_024).catch(() => null);
  const tier = boostTier(body?.tier);
  if (!tier) return apiError("Choose a boost");
  const mint = await openMine(env, body?.mint);
  if (!mint) return apiError("That mine is not open", 404);
  const { wallet: feeWallet } = mineFee(env);
  const chain = rpcEnv(env);
  const blockhash = await getChainRpc(meteoraRpcEnv(chain)).getLatestBlockhash({ commitment: "confirmed" }).send();
  const transaction = compileTransaction(pipe(
    createTransactionMessage({ version: "legacy" }),
    (message) => setTransactionMessageFeePayer(address(wallet), message),
    (message) => setTransactionMessageLifetimeUsingBlockhash(blockhash.value, message),
    (message) => appendTransactionMessageInstructions([systemTransferInstruction(wallet, feeWallet, tier.lamports)], message),
  ));
  return json({
    transaction: getBase64EncodedWireTransaction(transaction),
    expiresAt: Math.floor(Date.now() / 1_000) + 60,
    lamports: tier.lamports.toString(),
  }, { headers: { "cache-control": "no-store" } });
}

/** POST /api/mines/boost/confirm */
export async function confirmBoost(request: Request, env: RuntimeEnv): Promise<Response> {
  const wallet = await sessionWallet(request, env);
  if (!wallet) return apiError("Sign in with your wallet first", 401);
  if (!(await checkRateLimit(request, env, "boost-confirm", 60)) || !(await checkWalletRateLimit(env, wallet, "boost-confirm", 60, 60))) {
    return apiError("Too many requests", 429);
  }
  const body = await readJson<{ signature?: unknown; mint?: unknown; tier?: unknown }>(request, 1_024).catch(() => null);
  const signature = String(body?.signature ?? "");
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(signature)) return apiError("Missing payment transaction");
  const tier = boostTier(body?.tier);
  if (!tier || !isBase58Address(body?.mint)) return apiError("Invalid boost");
  const mint = body.mint;
  const used = await env.DB.prepare("SELECT mint, wallet, ends_at FROM mine_boosts WHERE signature = ?1").bind(signature)
    .first<{ mint: string; wallet: string; ends_at: number }>();
  if (used) {
    return used.wallet === wallet && used.mint === mint
      ? json({ mint, endsAt: Number(used.ends_at), created: false }, { headers: { "cache-control": "no-store" } })
      : apiError("That payment was already used", 409);
  }
  const transaction = await readTransaction(rpcEnv(env), signature).catch(() => null);
  if (!transaction) return apiError("The payment is not confirmed yet", 425);
  if (!paidBoost(transaction, { payer: wallet, feeWallet: mineFee(env).wallet, lamports: tier.lamports })) {
    return apiError("That transaction is not this boost's payment from your wallet", 400);
  }
  // Paid: record it even if the mine closed meanwhile, so the payment is never silently lost.
  const now = Math.floor(Date.now() / 1_000);
  const window = boostWindow(now, await boostedUntil(env.DB, mint), tier.days);
  try {
    await env.DB.prepare(
      "INSERT INTO mine_boosts (signature, mint, wallet, tier, lamports, starts_at, ends_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    ).bind(signature, mint, wallet, tier.id, tier.lamports.toString(), window.startsAt, window.endsAt, now).run();
  } catch {
    return apiError("That payment was already used", 409);
  }
  return json({ mint, endsAt: window.endsAt, created: true }, { headers: { "cache-control": "no-store" } });
}
