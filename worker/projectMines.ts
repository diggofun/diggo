/**
 * Anyone can add an existing coin as a mine.
 *
 * POST /api/mines/deposit { mint, amount }   an unsigned transaction moving `amount` whole tokens from
 *                                            the signed-in wallet into the mining vault
 * POST /api/mines/create  { signature, mint, symbol, name, sponsor?, sponsorUrl?, days }
 *
 * The mine's reserve is never taken from the request: it is what the deposit transaction, signed by
 * this same wallet, actually moved into the vault's account for this mint (depositFromTransaction).
 * So nobody can register someone else's deposit, claim more than they paid in, or use one deposit
 * twice. The creator's wallet can then change the mining period (worker/miningPeriod.ts), and an
 * admin can still close any mine.
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
import { sessionWallet } from "./auth";
import { getChainRpc } from "./chainV2";
import type { RuntimeEnv } from "./env";
import { apiError, checkRateLimit, checkWalletRateLimit, isBase58Address, json, readJson } from "./http";
import { buildAssociatedTokenAccountInstruction, decodeTokenAccountAmount, deriveAssociatedTokenAddress, meteoraRpcEnv, readAccount, readTransaction, type MeteoraTransaction } from "./meteora/rpc";
import type { MeteoraRpcEnv } from "./meteora/types";
import { buildSplTokenTransferInstruction } from "./meteora/vault";
import { inspectSponsoredMint } from "./sponsored";
import { parseSponsoredMineInput, wholeToRaw } from "../shared/sponsoredMine";

/** How many coins one wallet may add per day. Mines share players' bots, so spam has a cost to everyone. */
export const PROJECT_MINES_PER_DAY = 3;

function rpcEnv(env: RuntimeEnv): MeteoraRpcEnv {
  const extra = env as RuntimeEnv & { DIGGO_RPC_URL?: string };
  return { ...env, DIGGO_RPC_URL: String(extra.DIGGO_RPC_URL || "") } as MeteoraRpcEnv;
}

function vaultAddress(env: RuntimeEnv): string | null {
  const vault = String((env as RuntimeEnv & { MINING_VAULT_PUBLIC_KEY?: string }).MINING_VAULT_PUBLIC_KEY || "").trim();
  return isBase58Address(vault) ? vault : null;
}

/** Whether a mint can still get a mine: one mine per mint, and never a Diggo launch's own mint. */
async function mintTaken(env: RuntimeEnv, mint: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM sponsored_mines WHERE mint = ?1) + (SELECT COUNT(*) FROM meteora_pools WHERE base_mint = ?1)" +
      " + (SELECT COUNT(*) FROM game_mines WHERE mint = ?1) AS n",
  ).bind(mint).first<{ n: number }>();
  return Number(row?.n ?? 0) > 0;
}

/**
 * The raw amount a successful transaction moved from `wallet` into `vaultAccount` for `mint`, or null.
 * Both sides are read from the chain's own token balances: the vault account must grow, and accounts
 * owned by `wallet` must shrink by at least as much, which only the wallet's signature can cause.
 */
export function depositFromTransaction(
  transaction: MeteoraTransaction,
  expected: { mint: string; wallet: string; vaultAccount: string },
): bigint | null {
  if (transaction.failed) return null;
  const delta = (owner: (row: { accountIndex: number; owner: string | null }) => boolean): bigint => {
    let total = 0n;
    const amountAt = (rows: MeteoraTransaction["preTokenBalances"], index: number) =>
      BigInt(rows.find((row) => row.accountIndex === index && row.mint === expected.mint)?.amount ?? "0");
    const indexes = new Set([...transaction.preTokenBalances, ...transaction.postTokenBalances]
      .filter((row) => row.mint === expected.mint && owner(row))
      .map((row) => row.accountIndex));
    for (const index of indexes) total += amountAt(transaction.postTokenBalances, index) - amountAt(transaction.preTokenBalances, index);
    return total;
  };
  const received = delta((row) => transaction.accountKeys[row.accountIndex] === expected.vaultAccount);
  const sent = -delta((row) => row.owner === expected.wallet && transaction.accountKeys[row.accountIndex] !== expected.vaultAccount);
  if (received <= 0n || sent < received) return null;
  return received;
}

/** POST /api/mines/deposit */
export async function prepareProjectMineDeposit(request: Request, env: RuntimeEnv): Promise<Response> {
  const wallet = await sessionWallet(request, env);
  if (!wallet) return apiError("Sign in with your wallet first", 401);
  if (!(await checkRateLimit(request, env, "mine-deposit", 20)) || !(await checkWalletRateLimit(env, wallet, "mine-deposit", 20, 60))) {
    return apiError("Too many requests", 429);
  }
  let body: { mint?: unknown; amount?: unknown };
  try {
    body = await readJson<{ mint?: unknown; amount?: unknown }>(request, 1_024);
  } catch {
    return apiError("Invalid request");
  }
  const mint = String(body.mint ?? "").trim();
  if (!isBase58Address(mint)) return apiError("Enter the coin's mint address");
  const whole = String(body.amount ?? "").replace(/[,_ ]/g, "");
  if (!/^[1-9][0-9]{0,17}$/.test(whole)) return apiError("Enter a whole number of tokens");
  const vault = vaultAddress(env);
  if (!vault) return apiError("Adding coins is not available right now", 503);
  if (await mintTaken(env, mint)) return apiError("This coin already has a mine", 409);
  const chain = rpcEnv(env);
  let decimals: number;
  try {
    ({ decimals } = await inspectSponsoredMint(chain, mint, vault));
  } catch (error) {
    return apiError(error instanceof Error ? error.message : "That coin could not be read", 400);
  }
  const amount = wholeToRaw(whole, decimals);
  const source = deriveAssociatedTokenAddress(mint, wallet);
  const sourceAccount = await readAccount(chain, source);
  const balance = sourceAccount ? decodeTokenAccountAmount(sourceAccount.data) : 0n;
  if (balance < amount) return apiError("Your wallet does not hold that many tokens of this coin", 400);
  const destination = deriveAssociatedTokenAddress(mint, vault);
  const blockhash = await getChainRpc(meteoraRpcEnv(chain)).getLatestBlockhash({ commitment: "confirmed" }).send();
  // The player pays the fee and, the first time, the vault's token account rent. Nothing is signed
  // here: the only signature this transaction needs is the depositor's own.
  const transaction = compileTransaction(pipe(
    createTransactionMessage({ version: "legacy" }),
    (message) => setTransactionMessageFeePayer(address(wallet), message),
    (message) => setTransactionMessageLifetimeUsingBlockhash(blockhash.value, message),
    (message) => appendTransactionMessageInstructions([
      buildAssociatedTokenAccountInstruction({ payer: wallet, owner: vault, mint, associatedToken: destination }),
      buildSplTokenTransferInstruction({ source, mint, destination, amount, authority: wallet, decimals }),
    ], message),
  ));
  return json({
    transaction: getBase64EncodedWireTransaction(transaction),
    expiresAt: Math.floor(Date.now() / 1_000) + 60,
    amount: amount.toString(),
    decimals,
  }, { headers: { "cache-control": "no-store" } });
}

/** POST /api/mines/create */
export async function createProjectMine(request: Request, env: RuntimeEnv): Promise<Response> {
  const wallet = await sessionWallet(request, env);
  if (!wallet) return apiError("Sign in with your wallet first", 401);
  if (!(await checkRateLimit(request, env, "mine-create", 30)) || !(await checkWalletRateLimit(env, wallet, "mine-create", 30, 60))) {
    return apiError("Too many requests", 429);
  }
  let body: Record<string, unknown>;
  try {
    body = await readJson<Record<string, unknown>>(request, 4_096);
  } catch {
    return apiError("Invalid request");
  }
  const signature = String(body.signature ?? "").trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(signature)) return apiError("Missing deposit transaction");
  // The reserve comes from the deposit; "1" only satisfies the shared parser's reserve rule.
  const parsed = parseSponsoredMineInput({ ...body, reserve: "1", sponsorWallet: wallet, sponsor: String(body.sponsor ?? "").trim() || wallet.slice(0, 4) + "…" + wallet.slice(-4) });
  if (!parsed.ok) return apiError(parsed.error);
  const input = parsed.value;

  const existing = await env.DB.prepare("SELECT mint, created_by FROM sponsored_mines WHERE deposit_signature = ?1")
    .bind(signature)
    .first<{ mint: string; created_by: string }>();
  // Retrying after a lost response returns the mine this deposit already created.
  if (existing) {
    return existing.created_by === wallet
      ? json({ mint: existing.mint, created: false }, { headers: { "cache-control": "no-store" } })
      : apiError("That deposit was already used", 409);
  }
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM sponsored_mines WHERE created_by = ?1 AND created_at > ?2")
    .bind(wallet, Math.floor(Date.now() / 1_000) - 86_400)
    .first<{ n: number }>();
  if (Number(recent?.n ?? 0) >= PROJECT_MINES_PER_DAY) return apiError(`You can add ${PROJECT_MINES_PER_DAY} coins a day`, 429);
  if (await mintTaken(env, input.mint)) return apiError("This coin already has a mine", 409);

  const vault = vaultAddress(env);
  if (!vault) return apiError("Adding coins is not available right now", 503);
  const chain = rpcEnv(env);
  let decimals: number;
  try {
    ({ decimals } = await inspectSponsoredMint(chain, input.mint, vault));
  } catch (error) {
    return apiError(error instanceof Error ? error.message : "That coin could not be read", 400);
  }
  const transaction = await readTransaction(chain, signature).catch(() => null);
  // Not visible yet is normal right after sending; the client retries.
  if (!transaction) return apiError("The deposit is not confirmed yet", 425);
  const reserve = depositFromTransaction(transaction, { mint: input.mint, wallet, vaultAccount: deriveAssociatedTokenAddress(input.mint, vault) });
  if (reserve === null) return apiError("That transaction is not a deposit of this coin from your wallet into the mining vault", 400);

  const now = Math.floor(Date.now() / 1_000);
  try {
    await env.DB.prepare(
      "INSERT INTO sponsored_mines (mint, symbol, name, decimals, reserve, sponsor, sponsor_url, mining_starts_at, mining_seconds, status, created_by, created_at, updated_at, sponsor_wallet, deposit_signature)" +
        " VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'ACTIVE', ?10, ?8, ?8, ?10, ?11)",
    ).bind(input.mint, input.symbol, input.name, decimals, reserve.toString(), input.sponsor, input.sponsorUrl, now, input.days * 86_400, wallet, signature).run();
  } catch {
    return apiError("This coin already has a mine", 409);
  }
  return json({ mint: input.mint, created: true, reserve: reserve.toString(), decimals, endsAt: now + input.days * 86_400 }, { headers: { "cache-control": "no-store" } });
}
