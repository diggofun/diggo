import {
  AccountRole,
  address,
  createKeyPairSignerFromBytes,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import bs58 from "bs58";
import { sendAndConfirmWithFeePayer } from "../chainV2";
import {
  buildAssociatedTokenAccountInstruction,
  decodeTokenAccountAmount,
  deriveAssociatedTokenAddress,
  meteoraRpcEnv,
  readAccount,
} from "./rpc";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  METEORA_DBC_PROGRAM_ID,
  METEORA_POOL_AUTHORITY,
  METEORA_TOKEN_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  type MeteoraClaimParams,
  type MeteoraRpcEnv,
  type MeteoraVaultOperation,
  type MeteoraVaultRow,
} from "./types";

export const METEORA_EVENT_AUTHORITY = "8Ks12pbrD6PXxfty1hVQiE9sc289zgU1zHkvXhrSdriF";
export const WITHDRAW_LEFTOVER_DISCRIMINATOR = Uint8Array.of(20, 198, 202, 237, 235, 243, 183, 66);
export const SPL_TRANSFER_INSTRUCTION = 3;

const MAX_U64 = (1n << 64n) - 1n;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function optionalEnv(env: MeteoraRpcEnv, name: string): string | undefined {
  const value = (env as unknown as Record<string, unknown>)[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function configuredU64(env: MeteoraRpcEnv, name: string, fallback: bigint): bigint {
  const raw = optionalEnv(env, name);
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an unsigned integer`);
  const value = BigInt(raw);
  if (value <= 0n || value > MAX_U64) throw new Error(`${name} is out of range`);
  return value;
}

export function validateClaimCaps(amount: bigint, perClaim: bigint, perDay: bigint): void {
  if (amount > perClaim) throw new Error("claim exceeds MINING_CLAIM_PER_CLAIM");
  if (amount > perDay) throw new Error("claim exceeds MINING_CLAIM_PER_DAY");
}

function requireAddress(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return bs58.encode(bs58.decode(normalized));
}

function u64Le(value: bigint): Uint8Array {
  if (value <= 0n || value > MAX_U64) throw new Error("amount is out of range");
  const bytes = new Uint8Array(8);
  let remaining = value;
  for (let index = 0; index < 8; index += 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
}

export function buildWithdrawLeftoverInstruction(params: {
  config: string;
  pool: string;
  baseVault: string;
  baseMint: string;
  receiver: string;
  receiverTokenAccount: string;
  tokenProgram?: string;
}): Instruction {
  const tokenProgram = params.tokenProgram ?? METEORA_TOKEN_PROGRAM_ID;
  return {
    programAddress: address(METEORA_DBC_PROGRAM_ID),
    accounts: [
      { address: address(METEORA_POOL_AUTHORITY), role: AccountRole.READONLY },
      { address: address(params.config), role: AccountRole.READONLY },
      { address: address(params.pool), role: AccountRole.WRITABLE },
      { address: address(params.receiverTokenAccount), role: AccountRole.WRITABLE },
      { address: address(params.baseVault), role: AccountRole.WRITABLE },
      { address: address(params.baseMint), role: AccountRole.READONLY },
      { address: address(params.receiver), role: AccountRole.READONLY },
      { address: address(tokenProgram), role: AccountRole.READONLY },
      { address: address(METEORA_EVENT_AUTHORITY), role: AccountRole.READONLY },
      { address: address(METEORA_DBC_PROGRAM_ID), role: AccountRole.READONLY },
    ],
    data: WITHDRAW_LEFTOVER_DISCRIMINATOR,
  };
}

export function buildSplTokenTransferInstruction(params: {
  source: string;
  mint: string;
  destination: string;
  amount: bigint;
  authority: string;
  tokenProgram?: string;
}): Instruction {
  const amount = u64Le(params.amount);
  const data = new Uint8Array(amount.length + 1);
  data[0] = SPL_TRANSFER_INSTRUCTION;
  data.set(amount, 1);
  return {
    programAddress: address(params.tokenProgram ?? METEORA_TOKEN_PROGRAM_ID),
    accounts: [
      { address: address(params.source), role: AccountRole.WRITABLE },
      { address: address(params.mint), role: AccountRole.READONLY },
      { address: address(params.destination), role: AccountRole.WRITABLE },
      { address: address(params.authority), role: AccountRole.READONLY_SIGNER },
    ],
    data,
  };
}

export async function loadMiningVaultSigner(env: MeteoraRpcEnv): Promise<KeyPairSigner> {
  const raw = optionalEnv(env, "MINING_VAULT_SECRET");
  if (!raw) throw new Error("MINING_VAULT_SECRET is required");
  const bytes = raw.startsWith("[")
    ? Uint8Array.from(JSON.parse(raw) as number[])
    : bs58.decode(raw);
  if (bytes.length !== 64) throw new Error("MINING_VAULT_SECRET must decode to 64 bytes");
  const signer = await createKeyPairSignerFromBytes(bytes);
  const expected = optionalEnv(env, "MINING_VAULT_PUBLIC_KEY");
  if (expected && signer.address !== requireAddress(expected, "MINING_VAULT_PUBLIC_KEY")) {
    throw new Error("MINING_VAULT_SECRET does not match MINING_VAULT_PUBLIC_KEY");
  }
  return signer;
}

async function existingOperation(env: MeteoraRpcEnv, id: string): Promise<MeteoraVaultOperation | null> {
  return env.DB.prepare(
    "SELECT id, kind, pool, mint, status, signature, amount, error FROM meteora_vault_operations WHERE id=?1",
  ).bind(id).first<MeteoraVaultOperation>();
}

async function recordAttempt(
  env: MeteoraRpcEnv,
  id: string,
  kind: string,
  mint: string | null,
  wallet: string | null,
  amount: bigint,
): Promise<boolean> {
  const now = nowSeconds();
  const operation = await env.DB.prepare(
    "INSERT INTO meteora_vault_operations (id, kind, pool, mint, status, amount, created_at, updated_at)" +
    " VALUES (?1, ?2, NULL, ?3, 'PENDING', ?4, ?5, ?5)" +
    " ON CONFLICT(id) DO NOTHING RETURNING id",
  ).bind(id, kind, mint, amount.toString(), now).first<{ id: string }>();
  if (!operation) return false;
  await env.DB.prepare(
    "INSERT INTO meteora_vault_claims (id, idempotency_key, mint, wallet, amount, status, day_index, created_at, updated_at)" +
    " VALUES (?1, ?1, ?2, ?3, ?4, 'PENDING', ?5, ?6, ?6)",
  ).bind(id, mint, wallet, amount.toString(), Math.floor(now / 86400), now).run();
  return true;
}

async function reserveDailyCap(
  env: MeteoraRpcEnv,
  mint: string,
  wallet: string,
  amount: bigint,
  dayIndex: number,
  cap: bigint,
): Promise<boolean> {
  await env.DB.prepare(
    "INSERT INTO meteora_daily_claim_caps (mint, wallet, day_index, reserved, settled, revision)" +
    " VALUES (?1, ?2, ?3, '0', '0', 0) ON CONFLICT(mint, wallet, day_index) DO NOTHING",
  ).bind(mint, wallet, dayIndex).run();
  const before = await env.DB.prepare(
    "SELECT reserved, revision FROM meteora_daily_claim_caps WHERE mint=?1 AND wallet=?2 AND day_index=?3",
  ).bind(mint, wallet, dayIndex).first<{ reserved: string; revision: number }>();
  if (!before) throw new Error("daily claim cap row was not created");
  const reserved = BigInt(before.reserved);
  if (reserved + amount > cap) return false;
  const result = await env.DB.prepare(
    "UPDATE meteora_daily_claim_caps SET reserved=?4, revision=revision+1" +
    " WHERE mint=?1 AND wallet=?2 AND day_index=?3 AND revision=?5 AND reserved=?6",
  ).bind(mint, wallet, dayIndex, (reserved + amount).toString(), before.revision, before.reserved).run();
  const changes = result.meta?.changes ?? 0;
  return changes === 1;
}

async function updateClaimStatus(
  env: MeteoraRpcEnv,
  id: string,
  status: "PENDING" | "SENT" | "SETTLED" | "FAILED",
  signature: string | null,
  error: string | null,
): Promise<void> {
  const now = nowSeconds();
  await env.DB.prepare(
    "UPDATE meteora_vault_claims SET status=?2, signature=?3, error=?4, updated_at=?5 WHERE id=?1",
  ).bind(id, status, signature, error, now).run();
  await env.DB.prepare(
    "UPDATE meteora_vault_operations SET status=?2, signature=?3, error=?4, updated_at=?5 WHERE id=?1",
  ).bind(id, status, signature, error, now).run();
}

async function ensureTokenAccount(params: {
  env: MeteoraRpcEnv;
  payer: string;
  owner: string;
  mint: string;
  account: string;
}): Promise<Instruction | null> {
  const existing = await readAccount(params.env, params.account);
  return existing ? null : buildAssociatedTokenAccountInstruction({
    payer: params.payer,
    owner: params.owner,
    mint: params.mint,
    associatedToken: params.account,
  });
}

async function updateVaultBalance(env: MeteoraRpcEnv, mint: string, account: string): Promise<bigint> {
  const tokenAccount = await readAccount(env, account);
  if (!tokenAccount) return 0n;
  const amount = decodeTokenAccountAmount(tokenAccount.data);
  await env.DB.prepare(
    "INSERT INTO meteora_vault_balances (mint, token_account, amount, updated_at) VALUES (?1, ?2, ?3, ?4)" +
    " ON CONFLICT(mint) DO UPDATE SET token_account=excluded.token_account, amount=excluded.amount, updated_at=excluded.updated_at",
  ).bind(mint, account, amount.toString(), nowSeconds()).run();
  return amount;
}

async function withdrawPoolLeftover(
  env: MeteoraRpcEnv,
  signer: KeyPairSigner,
  pool: MeteoraVaultRow,
): Promise<{ signature: string | null; status: string }> {
  const id = `leftover:${pool.pool}`;
  const existing = await existingOperation(env, id);
  if (existing?.status === "SETTLED") {
    await env.DB.prepare("UPDATE meteora_pools SET is_leftover_withdrawn=1, indexed_at=?2 WHERE pool=?1").bind(pool.pool, nowSeconds()).run();
    return { signature: existing.signature, status: existing.status };
  }
  if (existing?.status === "PENDING" || existing?.status === "SENT") {
    return { signature: existing.signature, status: existing.status };
  }
  if (!existing) {
    await env.DB.prepare(
      "INSERT INTO meteora_vault_operations (id, kind, pool, mint, status, created_at, updated_at)" +
      " VALUES (?1, 'WITHDRAW_LEFTOVER', ?2, ?3, 'PENDING', ?4, ?4) ON CONFLICT(id) DO NOTHING",
    ).bind(id, pool.pool, pool.baseMint, nowSeconds()).run();
  }
  const receiver = signer.address;
  const receiverTokenAccount = deriveAssociatedTokenAddress(pool.baseMint, receiver);
  try {
    const createAccount = await ensureTokenAccount({ env, payer: receiver, owner: receiver, mint: pool.baseMint, account: receiverTokenAccount });
    const instructions = [buildWithdrawLeftoverInstruction({
      config: pool.config,
      pool: pool.pool,
      baseVault: pool.baseVault,
      baseMint: pool.baseMint,
      receiver,
      receiverTokenAccount,
    })];
    if (createAccount) instructions.unshift(createAccount);
    await env.DB.prepare("UPDATE meteora_vault_operations SET status='SENT', updated_at=?2 WHERE id=?1").bind(id, nowSeconds()).run();
    const signature = await sendAndConfirmWithFeePayer(meteoraRpcEnv(env), signer, instructions);
    await env.DB.prepare("UPDATE meteora_vault_operations SET status='SETTLED', signature=?2, error=NULL, updated_at=?3 WHERE id=?1").bind(id, signature, nowSeconds()).run();
    await env.DB.prepare("UPDATE meteora_pools SET is_leftover_withdrawn=1, indexed_at=?2 WHERE pool=?1").bind(pool.pool, nowSeconds()).run();
    await updateVaultBalance(env, pool.baseMint, receiverTokenAccount);
    return { signature, status: "SETTLED" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await env.DB.prepare("UPDATE meteora_vault_operations SET status='FAILED', error=?2, updated_at=?3 WHERE id=?1").bind(id, message, nowSeconds()).run();
    return { signature: null, status: "FAILED" };
  }
}

export async function runVaultSweep(env: MeteoraRpcEnv): Promise<{ checked: number; withdrawn: number; failed: number; balances: number }> {
  const signer = await loadMiningVaultSigner(env);
  const rawLimit = optionalEnv(env, "MINING_VAULT_SWEEP_LIMIT");
  const limit = rawLimit && /^\d+$/.test(rawLimit) ? Math.min(50, Math.max(1, Number(rawLimit))) : 50;
  const rows = await env.DB.prepare(
    "SELECT pool, base_mint, config, creator, base_vault, is_migrated, is_leftover_withdrawn FROM meteora_pools" +
    " WHERE is_graduated=1 AND is_leftover_withdrawn=0 ORDER BY indexed_at ASC LIMIT ?1",
  ).bind(limit).all<MeteoraVaultRow>();
  let withdrawn = 0;
  let failed = 0;
  for (const pool of rows.results ?? []) {
    const result = await withdrawPoolLeftover(env, signer, pool);
    if (result.status === "SETTLED") withdrawn += 1;
    if (result.status === "FAILED") failed += 1;
  }
  return { checked: (rows.results ?? []).length, withdrawn, failed, balances: withdrawn };
}

export async function payMiningClaim(params: MeteoraClaimParams): Promise<MeteoraVaultOperation> {
  const { env, amount } = params;
  if (amount <= 0n || amount > MAX_U64) throw new Error("claim amount must be a positive u64");
  const mint = requireAddress(params.mint, "mint");
  const wallet = requireAddress(params.wallet, "wallet");
  const idempotencyKey = params.idempotencyKey.trim();
  if (!idempotencyKey) throw new Error("idempotencyKey is required");
  const existing = await existingOperation(env, idempotencyKey);
  if (existing) return existing;

  const perClaim = configuredU64(env, "MINING_CLAIM_PER_CLAIM", amount);
  const perDay = configuredU64(env, "MINING_CLAIM_PER_DAY", perClaim);
  validateClaimCaps(amount, perClaim, perDay);

  const dayIndex = Math.floor(nowSeconds() / 86400);
  if (!(await recordAttempt(env, idempotencyKey, "MINING_CLAIM", mint, wallet, amount))) {
    const concurrent = await existingOperation(env, idempotencyKey);
    if (!concurrent) throw new Error("claim is already being processed");
    return concurrent;
  }
  if (!(await reserveDailyCap(env, mint, wallet, amount, dayIndex, perDay))) {
    await updateClaimStatus(env, idempotencyKey, "FAILED", null, "claim exceeds daily cap or idempotency key is being processed");
    throw new Error("claim exceeds daily cap or idempotency key is being processed");
  }
  try {
    const signer = await loadMiningVaultSigner(env);
    const source = deriveAssociatedTokenAddress(mint, signer.address);
    const destination = deriveAssociatedTokenAddress(mint, wallet);
    const createAccount = await ensureTokenAccount({ env, payer: signer.address, owner: wallet, mint, account: destination });
    const instructions = [buildSplTokenTransferInstruction({ source, mint, destination, amount, authority: signer.address })];
    if (createAccount) instructions.unshift(createAccount);
    await updateClaimStatus(env, idempotencyKey, "SENT", null, null);
    const signature = await sendAndConfirmWithFeePayer(meteoraRpcEnv(env), signer, instructions);
    await updateClaimStatus(env, idempotencyKey, "SETTLED", signature, null);
    await updateVaultBalance(env, mint, source);
    return { id: idempotencyKey, kind: "MINING_CLAIM", pool: null, mint, status: "SETTLED", signature, amount: amount.toString(), error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateClaimStatus(env, idempotencyKey, "FAILED", null, message);
    throw error;
  }
}

export { ASSOCIATED_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID };
