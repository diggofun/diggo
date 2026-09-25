import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  partiallySignTransactionWithSigners,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
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
  readTransaction,
  type MeteoraTransaction,
} from "./rpc";
import { getChainRpc } from "../chainV2";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  METEORA_DBC_PROGRAM_ID,
  METEORA_POOL_AUTHORITY,
  METEORA_TOKEN_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  type MeteoraClaimParams,
  type MeteoraRpcEnv,
  type PreparedMiningClaim,
  type MeteoraVaultOperation,
  type MeteoraVaultRow,
} from "./types";

export const METEORA_EVENT_AUTHORITY = "8Ks12pbrD6PXxfty1hVQiE9sc289zgU1zHkvXhrSdriF";
export const WITHDRAW_LEFTOVER_DISCRIMINATOR = Uint8Array.of(20, 198, 202, 237, 235, 243, 183, 66);
export const SPL_TRANSFER_INSTRUCTION = 3;
export const CREATE_ASSOCIATED_TOKEN_ACCOUNT_IDEMPOTENT_INSTRUCTION = 1;

const MAX_U64 = (1n << 64n) - 1n;
const MINING_CLAIM_TRANSACTION_TTL_SECONDS = 90;

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

export async function buildPreparedMiningClaimTransaction(params: {
  vault: KeyPairSigner;
  player: string;
  blockhash: Parameters<typeof setTransactionMessageLifetimeUsingBlockhash>[0];
  source: string;
  mint: string;
  destination: string;
  amount: bigint;
}) {
  return partiallySignTransactionWithSigners(
    [params.vault],
    compileTransaction(pipe(
      createTransactionMessage({ version: "legacy" }),
      (message) => setTransactionMessageFeePayer(address(params.player), message),
      (message) => setTransactionMessageLifetimeUsingBlockhash(params.blockhash, message),
      (message) => appendTransactionMessageInstructions(
        [
          // This is always included. CreateIdempotent succeeds when the player's ATA already exists,
          // and the player pays the rent and the transaction fee when it needs to be created.
          buildAssociatedTokenAccountInstruction({
            payer: params.player,
            owner: params.player,
            mint: params.mint,
            associatedToken: params.destination,
          }),
          buildSplTokenTransferInstruction({
            source: params.source,
            mint: params.mint,
            destination: params.destination,
            amount: params.amount,
            authority: params.vault.address,
          }),
        ],
        message,
      ),
    )),
  );
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

function capSettlement(
  env: MeteoraRpcEnv,
  mint: string,
  wallet: string,
  amount: bigint,
  dayIndex: number,
  settled: bigint,
  reserved: bigint,
  revision: number,
) {
  return env.DB.prepare(
    "UPDATE meteora_daily_claim_caps SET settled=?4, revision=revision+1 " +
    "WHERE mint=?1 AND wallet=?2 AND day_index=?3 AND settled=?5 AND reserved=?6 AND revision=?7",
  ).bind(mint, wallet, dayIndex, (settled + amount).toString(), settled.toString(), reserved.toString(), revision);
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

export async function prepareMiningClaim(params: MeteoraClaimParams): Promise<PreparedMiningClaim> {
  const { env, amount } = params;
  if (amount <= 0n || amount > MAX_U64) throw new Error("claim amount must be a positive u64");
  const mint = requireAddress(params.mint, "mint");
  const wallet = requireAddress(params.wallet, "wallet");
  const idempotencyKey = params.idempotencyKey.trim();
  if (!idempotencyKey) throw new Error("idempotencyKey is required");
  const existing = await env.DB.prepare(
    "SELECT id, mint, wallet, amount, status, prepared_transaction, prepared_expires_at FROM meteora_vault_claims WHERE id=?1",
  ).bind(idempotencyKey).first<{
    id: string;
    mint: string;
    wallet: string;
    amount: string;
    status: string;
    prepared_transaction: string | null;
    prepared_expires_at: number | null;
  }>();
  if (existing?.status === "SETTLED") throw new Error("claim is already settled");
  if (existing?.status === "FAILED") throw new Error("claim preparation failed; retry this claim after resolving the error");
  if (existing?.prepared_transaction) {
    if (existing.mint !== mint || existing.wallet !== wallet || BigInt(existing.amount) !== amount) {
      throw new Error("claim idempotency key does not match the prepared payout");
    }
    if (!existing.prepared_expires_at || existing.prepared_expires_at <= nowSeconds()) {
      throw new Error("prepared claim transaction has expired; create a new claim to retry");
    }
    const signer = await loadMiningVaultSigner(env);
    return {
      id: existing.id,
      mint: existing.mint,
      wallet: existing.wallet,
      amount: existing.amount,
      source: deriveAssociatedTokenAddress(existing.mint, signer.address),
      destination: deriveAssociatedTokenAddress(existing.mint, existing.wallet),
      transaction: existing.prepared_transaction,
      expiresAt: existing.prepared_expires_at,
    };
  }
  const perClaim = configuredU64(env, "MINING_CLAIM_PER_CLAIM", amount);
  const perDay = configuredU64(env, "MINING_CLAIM_PER_DAY", perClaim);
  validateClaimCaps(amount, perClaim, perDay);
  const dayIndex = Math.floor(nowSeconds() / 86400);
  if (!existing) {
    if (!(await recordAttempt(env, idempotencyKey, "MINING_CLAIM", mint, wallet, amount))) {
      throw new Error("claim is already being processed");
    }
    if (!(await reserveDailyCap(env, mint, wallet, amount, dayIndex, perDay))) {
      await updateClaimStatus(env, idempotencyKey, "FAILED", null, "claim exceeds daily cap or idempotency key is being processed");
      throw new Error("claim exceeds daily cap or idempotency key is being processed");
    }
  }
  try {
    const signer = await loadMiningVaultSigner(env);
    const source = deriveAssociatedTokenAddress(mint, signer.address);
    const destination = deriveAssociatedTokenAddress(mint, wallet);
    const [sourceAccount, blockhash] = await Promise.all([
      readAccount(env, source),
      getChainRpc(meteoraRpcEnv(env)).getLatestBlockhash({ commitment: "confirmed" }).send(),
    ]);
    if (!sourceAccount) throw new Error("mining vault token account does not exist");
    const transaction = await buildPreparedMiningClaimTransaction({
      vault: signer,
      player: wallet,
      blockhash: blockhash.value,
      source,
      mint,
      destination,
      amount,
    });
    const wireTransaction = getBase64EncodedWireTransaction(transaction);
    const now = nowSeconds();
    const expiresAt = now + MINING_CLAIM_TRANSACTION_TTL_SECONDS;
    const saved = await env.DB.batch([
      env.DB.prepare(
        "UPDATE meteora_vault_claims SET status='SENT', prepared_transaction=?2, prepared_expires_at=?3, error=NULL, updated_at=?4 " +
        "WHERE id=?1 AND status='PENDING' AND prepared_transaction IS NULL",
      ).bind(idempotencyKey, wireTransaction, expiresAt, now),
      env.DB.prepare(
        "UPDATE meteora_vault_operations SET status='SENT', error=NULL, updated_at=?2 " +
        "WHERE id=?1 AND status='PENDING'",
      ).bind(idempotencyKey, now),
    ]);
    if ((saved[0]?.meta.changes ?? 0) !== 1) {
      const concurrent = await env.DB.prepare(
        "SELECT mint, wallet, amount, prepared_transaction, prepared_expires_at FROM meteora_vault_claims WHERE id=?1 AND status='SENT'",
      ).bind(idempotencyKey).first<{
        mint: string;
        wallet: string;
        amount: string;
        prepared_transaction: string | null;
        prepared_expires_at: number | null;
      }>();
      if (!concurrent?.prepared_transaction) throw new Error("claim preparation is still in progress");
      if (!concurrent.prepared_expires_at || concurrent.prepared_expires_at <= now) {
        throw new Error("prepared claim transaction has expired; create a new claim to retry");
      }
      return {
        id: idempotencyKey,
        mint: concurrent.mint,
        wallet: concurrent.wallet,
        amount: concurrent.amount,
        source,
        destination,
        transaction: concurrent.prepared_transaction,
        expiresAt: concurrent.prepared_expires_at,
      };
    }
    return {
      id: idempotencyKey,
      mint,
      wallet,
      amount: amount.toString(),
      source,
      destination,
      transaction: wireTransaction,
      expiresAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateClaimStatus(env, idempotencyKey, "FAILED", null, message);
    throw error;
  }
}

function tokenDelta(transaction: MeteoraTransaction, account: string): bigint | null {
  const before = transaction.preTokenBalances.find((row) => transaction.accountKeys[row.accountIndex] === account)?.amount;
  const after = transaction.postTokenBalances.find((row) => transaction.accountKeys[row.accountIndex] === account)?.amount;
  return before === undefined || after === undefined ? null : BigInt(after) - BigInt(before);
}

export function verifyMiningClaimTransfer(
  transaction: MeteoraTransaction | null,
  expected: { mint: string; wallet: string; vault: string; source: string; destination: string; amount: bigint },
): boolean {
  if (!transaction || transaction.failed) return false;
  if (transaction.signatures.length !== 2 || transaction.signatures[0] !== transaction.signature || !transaction.signatures[1]) return false;
  if (transaction.accountKeys[0] !== expected.wallet) return false;
  if (!transaction.accountKeys.includes(expected.vault)) return false;
  if (!transaction.accountKeys.includes(expected.source) || !transaction.accountKeys.includes(expected.destination)) return false;
  const topLevel = transaction.topLevelInstructions ?? transaction.instructions;
  if (topLevel.length !== 2) return false;
  const createsPlayerAta = topLevel.filter((instruction) =>
    instruction.programId === ASSOCIATED_TOKEN_PROGRAM_ID &&
    instruction.data === bs58.encode(Uint8Array.of(CREATE_ASSOCIATED_TOKEN_ACCOUNT_IDEMPOTENT_INSTRUCTION)) &&
    instruction.accounts[0] === expected.wallet &&
    instruction.accounts[1] === expected.destination &&
    instruction.accounts[2] === expected.wallet &&
    instruction.accounts[3] === expected.mint &&
    instruction.accounts[4] === SYSTEM_PROGRAM_ID &&
    instruction.accounts[5] === METEORA_TOKEN_PROGRAM_ID);
  if (createsPlayerAta.length !== 1) return false;
  const transfers = topLevel.filter((instruction) =>
    instruction.programId === METEORA_TOKEN_PROGRAM_ID &&
    instruction.accounts[0] === expected.source &&
    instruction.accounts[1] === expected.mint &&
    instruction.accounts[2] === expected.destination &&
    instruction.accounts[3] === expected.vault);
  const transferData = (() => {
    try {
      return bs58.decode(transfers[0]?.data ?? "");
    } catch {
      return new Uint8Array();
    }
  })();
  if (transferData.length !== 9 || transferData[0] !== SPL_TRANSFER_INSTRUCTION) return false;
  let transferAmount = 0n;
  for (let index = 1; index < transferData.length; index += 1) transferAmount |= BigInt(transferData[index]) << BigInt((8 - index) * 8);
  if (transferAmount !== expected.amount) return false;
  const sourceOwner = transaction.preTokenBalances.find((row) => transaction.accountKeys[row.accountIndex] === expected.source)?.owner;
  const destinationOwner = transaction.postTokenBalances.find((row) => transaction.accountKeys[row.accountIndex] === expected.destination)?.owner;
  return sourceOwner === expected.vault && destinationOwner === expected.wallet &&
    tokenDelta(transaction, expected.source) === -expected.amount &&
    tokenDelta(transaction, expected.destination) === expected.amount;
}

export async function confirmMiningClaim(env: MeteoraRpcEnv, claimId: string, signature: string): Promise<boolean> {
  const id = claimId.trim();
  if (!id) throw new Error("claimId is required");
  const operation = await env.DB.prepare(
    "SELECT id, mint, wallet, amount, day_index, status, signature FROM meteora_vault_claims WHERE id=?1",
  ).bind(id).first<{ id: string; mint: string; wallet: string; amount: string; day_index: number; status: string; signature: string | null }>();
  if (!operation) throw new Error("claim not found");
  if (operation.status === "SETTLED") return operation.signature === signature;
  if (operation.signature && operation.signature !== signature) throw new Error("signature does not match the prepared claim");
  if (operation.status !== "SENT") throw new Error("claim is not awaiting confirmation");
  const signer = await loadMiningVaultSigner(env);
  const source = deriveAssociatedTokenAddress(operation.mint, signer.address);
  const destination = deriveAssociatedTokenAddress(operation.mint, operation.wallet);
  const transaction = await readTransaction(env, signature);
  if (!verifyMiningClaimTransfer(transaction, {
    mint: operation.mint,
    wallet: operation.wallet,
    vault: signer.address,
    source,
    destination,
    amount: BigInt(operation.amount),
  })) return false;
  const cap = await env.DB.prepare(
    "SELECT settled, reserved, revision FROM meteora_daily_claim_caps WHERE mint=?1 AND wallet=?2 AND day_index=?3",
  ).bind(operation.mint, operation.wallet, operation.day_index)
    .first<{ settled: string; reserved: string; revision: number }>();
  if (!cap || BigInt(cap.settled) + BigInt(operation.amount) > BigInt(cap.reserved)) {
    throw new Error("daily claim reservation is missing or insufficient");
  }
  const now = nowSeconds();
  const settled = await env.DB.batch([
    env.DB.prepare(
      "UPDATE meteora_vault_claims SET status='SETTLED', signature=?2, error=NULL, updated_at=?3 " +
      "WHERE id=?1 AND status='SENT' AND signature IS NULL",
    ).bind(id, signature, now),
    env.DB.prepare("UPDATE meteora_vault_operations SET status='SETTLED', signature=?2, error=NULL, updated_at=?3 WHERE id=?1").bind(id, signature, now),
    capSettlement(env, operation.mint, operation.wallet, BigInt(operation.amount), operation.day_index, BigInt(cap.settled), BigInt(cap.reserved), cap.revision),
  ]);
  if ((settled[0]?.meta.changes ?? 0) !== 1 || (settled[2]?.meta.changes ?? 0) !== 1) {
    throw new Error("claim settlement changed concurrently; retry confirmation");
  }
  await updateVaultBalance(env, operation.mint, source);
  return true;
}

export { ASSOCIATED_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID };
