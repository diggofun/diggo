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
import { METEORA_TOKEN } from "../../shared/meteora/config";
import { sendAndConfirmWithFeePayer } from "../chainV2";
import {
  buildAssociatedTokenAccountInstruction,
  decodeTokenAccountAmount,
  deriveAssociatedTokenAddress,
  meteoraRpcEnv,
  readAccount,
  readFinalizedTransactionProof,
  readSignatures,
  readTransaction,
  readTransactionWire,
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
  type PreparedClaimBatch,
  type MeteoraRpcEnv,
  type PreparedMiningClaim,
  type MeteoraVaultOperation,
  type MeteoraVaultRow,
} from "./types";

export const METEORA_EVENT_AUTHORITY = "8Ks12pbrD6PXxfty1hVQiE9sc289zgU1zHkvXhrSdriF";
export const WITHDRAW_LEFTOVER_DISCRIMINATOR = Uint8Array.of(20, 198, 202, 237, 235, 243, 183, 66);
/**
 * SPL Token TransferChecked. The payout instructions list the accounts as source, mint, destination,
 * authority, which is TransferChecked's layout; the plain Transfer (3) reads only source,
 * destination, authority, so with the mint in second place it would treat the mint as the
 * destination and every payout would fail on chain.
 */
export const SPL_TRANSFER_CHECKED_INSTRUCTION = 12;
/** Every coin launched through the Diggo DBC config has this many decimals. */
export const PAYOUT_TOKEN_DECIMALS = METEORA_TOKEN.decimals;
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
  /** The mint's decimals; TransferChecked fails on chain when they do not match the mint. */
  decimals?: number;
  tokenProgram?: string;
}): Instruction {
  const decimals = params.decimals ?? PAYOUT_TOKEN_DECIMALS;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error("decimals are out of range");
  const amount = u64Le(params.amount);
  const data = new Uint8Array(amount.length + 2);
  data[0] = SPL_TRANSFER_CHECKED_INSTRUCTION;
  data.set(amount, 1);
  data[amount.length + 1] = decimals;
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

/**
 * Reads a TransferChecked payload (opcode, little-endian u64 amount, decimals) exactly as
 * buildSplTokenTransferInstruction writes it, or null for anything else.
 */
export function readTransferChecked(data: Uint8Array): { amount: bigint; decimals: number } | null {
  if (data.length !== 10 || data[0] !== SPL_TRANSFER_CHECKED_INSTRUCTION) return null;
  let amount = 0n;
  for (let index = 0; index < 8; index += 1) amount |= BigInt(data[1 + index]!) << BigInt(index * 8);
  return { amount, decimals: data[9]! };
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

/**
 * One transaction paying every accrued mint at once.
 *
 * Solana has no cap on how many SPL transfers a message may carry, and each transfer is preceded by
 * a CreateIdempotent that is a no-op when the player's ATA already exists. That is what makes a
 * single wallet signature sufficient for the whole accrued balance rather than one prompt per
 * coin. `items` are already sorted by mint, so the same inputs always compile to the same message
 * and a retry re-derives byte-identical instructions from the same blockhash.
 */
export async function buildPreparedClaimBatchTransaction(params: {
  vault: KeyPairSigner;
  player: string;
  blockhash: Parameters<typeof setTransactionMessageLifetimeUsingBlockhash>[0];
  items: { mint: string; amount: bigint }[];
}) {
  const instructions = params.items.flatMap((item) => {
    const destination = deriveAssociatedTokenAddress(item.mint, params.player);
    return [
      buildAssociatedTokenAccountInstruction({
        payer: params.player,
        owner: params.player,
        mint: item.mint,
        associatedToken: destination,
      }),
      buildSplTokenTransferInstruction({
        source: deriveAssociatedTokenAddress(item.mint, params.vault.address),
        mint: item.mint,
        destination,
        amount: item.amount,
        authority: params.vault.address,
      }),
    ];
  });
  return partiallySignTransactionWithSigners(
    [params.vault],
    compileTransaction(pipe(
      createTransactionMessage({ version: "legacy" }),
      (message) => setTransactionMessageFeePayer(address(params.player), message),
      (message) => setTransactionMessageLifetimeUsingBlockhash(params.blockhash, message),
      (message) => appendTransactionMessageInstructions(instructions, message),
    )),
  );
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
  const transfer = readTransferChecked(transferData);
  if (!transfer || transfer.decimals !== PAYOUT_TOKEN_DECIMALS || transfer.amount !== expected.amount) return false;
  const sourceOwner = transaction.preTokenBalances.find((row) => transaction.accountKeys[row.accountIndex] === expected.source)?.owner;
  const destinationOwner = transaction.postTokenBalances.find((row) => transaction.accountKeys[row.accountIndex] === expected.destination)?.owner;
  return sourceOwner === expected.vault && destinationOwner === expected.wallet &&
    tokenDelta(transaction, expected.source) === -expected.amount &&
    tokenDelta(transaction, expected.destination) === expected.amount;
}

/**
 * Confirms one player signature really moved every batched amount, vault to wallet, and nothing else.
 *
 * The single-claim check cannot be reused as-is: it hard-codes two instructions and two signatures.
 * This one takes the exact expected items, requires the instruction count and the signature count to
 * match, and then re-derives each transfer from the instruction stream rather than trusting the order
 * the Worker happened to build it in. Every amount is additionally checked against the on-chain
 * pre/post token balance deltas, so a transfer of a different size cannot pass, and a transaction
 * that carries an extra unverified transfer cannot pass either.
 */
export function verifyClaimBatchTransfer(
  transaction: MeteoraTransaction | null,
  expected: { wallet: string; vault: string; items: { mint: string; amount: bigint }[] },
): boolean {
  if (!transaction || transaction.failed) return false;
  if (expected.items.length === 0) return false;
  // The player is the fee payer and the vault is the only other signer. Anything else means the
  // transaction was authorised by a party this batch never named.
  if (transaction.signatures.length !== 2) return false;
  if (transaction.signatures[0] !== transaction.signature || !transaction.signatures[1]) return false;
  if (transaction.accountKeys[0] !== expected.wallet) return false;
  const topLevel = transaction.topLevelInstructions ?? transaction.instructions;
  if (topLevel.length !== expected.items.length * 2) return false;
  const createIdempotentData = bs58.encode(Uint8Array.of(CREATE_ASSOCIATED_TOKEN_ACCOUNT_IDEMPOTENT_INSTRUCTION));

  const remaining = new Set(expected.items.map((item) => `${item.mint}:${item.amount.toString()}`));
  for (let index = 0; index < topLevel.length; index += 2) {
    const create = topLevel[index]!;
    const transfer = topLevel[index + 1]!;
    if (create.programId !== ASSOCIATED_TOKEN_PROGRAM_ID || create.data !== createIdempotentData) return false;
    if (transfer.programId !== METEORA_TOKEN_PROGRAM_ID) return false;
    const destination = create.accounts[1]!;
    const mint = create.accounts[3]!;
    if (create.accounts[0] !== expected.wallet || create.accounts[2] !== expected.wallet) return false;
    if (create.accounts[4] !== SYSTEM_PROGRAM_ID || create.accounts[5] !== METEORA_TOKEN_PROGRAM_ID) return false;
    if (destination !== deriveAssociatedTokenAddress(mint, expected.wallet)) return false;
    if (transfer.accounts[0] !== deriveAssociatedTokenAddress(mint, expected.vault)) return false;
    if (transfer.accounts[1] !== mint || transfer.accounts[2] !== destination) return false;
    if (transfer.accounts[3] !== expected.vault) return false;
    const transferData = (() => {
      try {
        return bs58.decode(transfer.data ?? "");
      } catch {
        return new Uint8Array();
      }
    })();
    const decoded = readTransferChecked(transferData);
    if (!decoded || decoded.decimals !== PAYOUT_TOKEN_DECIMALS) return false;
    const amount = decoded.amount;
    const key = `${mint}:${amount.toString()}`;
    if (!remaining.has(key)) return false;
    remaining.delete(key);
    const source = transfer.accounts[0]!;
    if (tokenDelta(transaction, source) !== -amount) return false;
    if (tokenDelta(transaction, destination) !== amount) return false;
    const sourceOwner = transaction.preTokenBalances.find((row) => transaction.accountKeys[row.accountIndex] === source)?.owner;
    const destinationOwner = transaction.postTokenBalances.find((row) => transaction.accountKeys[row.accountIndex] === destination)?.owner;
    if (sourceOwner !== expected.vault || destinationOwner !== expected.wallet) return false;
  }
  return remaining.size === 0;
}

export async function confirmMiningClaim(env: MeteoraRpcEnv, claimId: string, signature: string): Promise<boolean> {
  const id = claimId.trim();
  if (!id) throw new Error("claimId is required");
  const operation = await env.DB.prepare(
    "SELECT id, mint, wallet, amount, day_index, status, signature, prepared_transaction FROM meteora_vault_claims WHERE id=?1",
  ).bind(id).first<{ id: string; mint: string; wallet: string; amount: string; day_index: number; status: string; signature: string | null; prepared_transaction: string | null }>();
  if (!operation) throw new Error("claim not found");
  if (operation.status === "SETTLED") return operation.signature === signature;
  if (operation.signature && operation.signature !== signature) throw new Error("signature does not match the prepared claim");
  if (operation.status !== "SENT") throw new Error("claim is not awaiting confirmation");
  if (!operation.prepared_transaction) throw new Error("claim has no prepared transaction");
  const signer = await loadMiningVaultSigner(env);
  const source = deriveAssociatedTokenAddress(operation.mint, signer.address);
  const destination = deriveAssociatedTokenAddress(operation.mint, operation.wallet);
  const proof = await readFinalizedTransactionProof(env, signature);
  if (!proof) return false;
  if (proof.wire !== operation.prepared_transaction) throw new Error("signature does not match the prepared claim");
  if (!verifyMiningClaimTransfer(proof.transaction, {
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

interface ClaimBatchRow {
  id: string;
  wallet: string;
  status: string;
  items: string;
  prepared_transaction: string | null;
  prepared_expires_at: number | null;
  prepared_last_valid_block_height: number | null;
  prepared_slot: number | null;
  signature: string | null;
  day_index: number;
  cap_reserved: number;
  replacement_id: string | null;
  error: string | null;
}

const CLAIM_BATCH_COLUMNS = "id, wallet, status, items, prepared_transaction, prepared_expires_at, " +
  "prepared_last_valid_block_height, prepared_slot, signature, day_index, cap_reserved, replacement_id, error";

function storedBlockHeight(batch: ClaimBatchRow): number {
  const height = batch.prepared_last_valid_block_height;
  const numeric = typeof height === "bigint" ? Number(height) : height;
  if (numeric === null || !Number.isSafeInteger(numeric) || numeric <= 0) {
    throw new Error("claim batch is missing its Solana last-valid block height");
  }
  return numeric;
}

function storedSlot(batch: ClaimBatchRow): number {
  const slot = batch.prepared_slot;
  const numeric = typeof slot === "bigint" ? Number(slot) : slot;
  if (numeric === null || !Number.isSafeInteger(numeric) || numeric <= 0) {
    throw new Error("claim batch is missing its Solana preparation slot");
  }
  return numeric;
}

function blockHeightNumber(value: bigint | number): number {
  const height = typeof value === "bigint" ? value : BigInt(value);
  if (height <= 0n || height > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Solana returned an unusable block height");
  }
  return Number(height);
}

function isTransactionSignature(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(value)) return false;
  try {
    return bs58.decode(value).length === 64;
  } catch {
    return false;
  }
}

async function readClaimBatch(env: MeteoraRpcEnv, id: string): Promise<ClaimBatchRow | null> {
  return env.DB.prepare(
    `SELECT ${CLAIM_BATCH_COLUMNS} FROM meteora_claim_batches WHERE id=?1`,
  ).bind(id).first<ClaimBatchRow>();
}

async function currentBlockHeight(env: MeteoraRpcEnv): Promise<number> {
  // Kit's generated RPC type does not expose this method in every installed release, although the
  // Solana JSON RPC does. Keep the cast local so a dependency type change cannot weaken runtime
  // validation: the value is still required to be a positive safe integer below.
  const rpc = getChainRpc(meteoraRpcEnv(env)) as unknown as {
    getBlockHeight(config: { commitment: "confirmed" }): { send(): Promise<bigint | number> };
  };
  return blockHeightNumber(await rpc.getBlockHeight({ commitment: "confirmed" }).send());
}

async function findPreparedTransaction(env: MeteoraRpcEnv, batch: ClaimBatchRow): Promise<"landed" | "unlanded" | "unknown"> {
  if (!batch.prepared_transaction) return "unlanded";
  let before: string | undefined;
  const startSlot = storedSlot(batch);
  // A signature lookup is the reconciliation authority. A local expiry only says the old envelope
  // is stale; it never proves that a transaction the player may have signed did not land.
  for (let page = 0; page < 20; page += 1) {
    const signatures = await readSignatures(env, batch.wallet, {
      limit: 1000,
      ...(before ? { before } : {}),
    });
    if (signatures.length === 0) return "unlanded";
    for (const info of signatures) {
      if (info.slot < BigInt(startSlot)) break;
      const wire = await readTransactionWire(env, info.signature);
      if (wire !== batch.prepared_transaction) continue;
      const transaction = await readTransaction(env, info.signature);
      if (transaction && !transaction.failed) return "landed";
      return "unlanded";
    }
    const last = signatures[signatures.length - 1]!;
    if (last.slot <= BigInt(startSlot)) return "unlanded";
    before = last.signature;
  }
  return "unknown";
}

async function releaseClaimReservation(
  env: MeteoraRpcEnv,
  batch: ClaimBatchRow,
  reason: string,
): Promise<void> {
  if (batch.cap_reserved !== 1) {
    throw new Error("expired claim batch does not own a reservation");
  }
  const items = decodeBatchItems(batch.items);
  const statements = items.map((item) => env.DB.prepare(
    "UPDATE meteora_daily_claim_caps SET reserved=CAST(CAST(reserved AS INTEGER)-CAST(?4 AS INTEGER) AS TEXT), revision=revision+1 " +
    "WHERE mint=?1 AND wallet=?2 AND day_index=?3 " +
    "AND CAST(settled AS INTEGER) <= CAST(CAST(reserved AS INTEGER)-CAST(?4 AS INTEGER) AS INTEGER) " +
    "AND EXISTS (SELECT 1 FROM meteora_claim_batches WHERE id=?5 AND status='SENT' AND cap_reserved=1)",
  ).bind(item.mint, batch.wallet, batch.day_index, item.amount.toString(), batch.id));
  statements.push(env.DB.prepare(
    "UPDATE meteora_claim_batches SET status='FAILED', cap_reserved=0, error=?2, updated_at=?3 " +
    "WHERE id=?1 AND status='SENT' AND cap_reserved=1",
  ).bind(batch.id, reason, nowSeconds()));
  const results = await env.DB.batch(statements);
  if (results.some((result) => (result.meta?.changes ?? 0) !== 1)) {
    throw new Error("expired claim batch changed concurrently; retry reconciliation");
  }
}

export interface ClaimBatchItemAmounts {
  claimIds: string[];
  mint: string;
  amount: bigint;
}

function decodeBatchItems(items: string): ClaimBatchItemAmounts[] {
  const parsed = JSON.parse(items) as { claimIds: string[]; mint: string; amount: string }[];
  return parsed.map((item) => ({
    claimIds: item.claimIds.map(String),
    mint: String(item.mint),
    amount: BigInt(item.amount),
  }));
}

/**
 * Reserves and signs every claim in one transaction, or refuses to sign any of them.
 *
 * The batch is all-or-nothing at the accounting layer: a mint the vault cannot provably pay is not
 * silently dropped, because a partial batch that the UI labelled "all" would understate what the
 * player is owed and would leave the remainder unrequested. The caller therefore passes the exact
 * item list it has already funded and verified, and this function signs that list or nothing.
 *
 * Idempotency is durable. A live SENT batch is returned byte-identical so a double-tap cannot produce
 * a second signature over a different instruction set, and an expired one is replaced rather than
 * resurrected, because its blockhash can no longer land.
 */
export async function prepareClaimBatch(params: {
  env: MeteoraRpcEnv;
  wallet: string;
  items: ClaimBatchItemAmounts[];
  batchId: string;
}): Promise<PreparedClaimBatch> {
  const { env, items } = params;
  const wallet = requireAddress(params.wallet, "wallet");
  const requestedBatchId = params.batchId.trim();
  if (!requestedBatchId) throw new Error("batchId is required");
  if (items.length === 0) throw new Error("claim-all has nothing to pay");
  const mints = new Set(items.map((item) => item.mint));
  if (mints.size !== items.length) throw new Error("claim-all items must be unique per mint");
  for (const item of items) {
    if (item.amount <= 0n || item.amount > MAX_U64) throw new Error("claim amount must be a positive u64");
    if (item.claimIds.length === 0) throw new Error("claim-all item has no claims to settle");
    requireAddress(item.mint, "mint");
  }

  let existing = await readClaimBatch(env, requestedBatchId);
  let expiredBatchId: string | null = null;
  if (existing) {
    if (existing.wallet !== wallet) throw new Error("claim batch not found");
    if (existing.status === "SETTLED") throw new Error("claim batch is already settled");
    for (let depth = 0; existing.status === "FAILED" && existing.replacement_id; depth += 1) {
      if (depth >= 20) throw new Error("claim batch replacement chain is too deep");
      const replacement = await readClaimBatch(env, existing.replacement_id);
      if (!replacement || replacement.wallet !== wallet) throw new Error("claim batch replacement is unavailable");
      if (replacement.status === "SETTLED") throw new Error("claim batch is already settled");
      existing = replacement;
    }
  }
  if (existing?.status === "SENT" && existing.prepared_transaction && existing.prepared_expires_at) {
    // The wall-clock TTL is advisory. The signed envelope remains authoritative until the chain's
    // lastValidBlockHeight has passed and wallet history proves it did not already land.
    if (await currentBlockHeight(env) <= storedBlockHeight(existing)) {
      return {
        id: existing.id,
        wallet,
        items: decodeBatchItems(existing.items),
        transaction: existing.prepared_transaction,
        expiresAt: existing.prepared_expires_at,
      };
    }
    const reconciliation = await findPreparedTransaction(env, existing);
    if (reconciliation === "unknown") {
      throw new Error("claim batch expiry could not be reconciled; refusing to release its reservation");
    }
    if (reconciliation === "landed") {
      return {
        id: existing.id,
        wallet,
        items: decodeBatchItems(existing.items),
        transaction: existing.prepared_transaction,
        expiresAt: existing.prepared_expires_at,
      };
    }
    const expired = existing;
    await releaseClaimReservation(env, expired, "Solana blockhash expired; reservation released after chain reconciliation");
    expiredBatchId = expired.id;
  } else if (existing?.status === "SENT") {
    throw new Error("claim batch preparation is still in progress");
  }

  // MINING_CLAIM_PER_CLAIM applies to the retired single-mint payout. Claim-all deliberately
  // combines all of one mint's rewards into the same transfer, so its economic limit is the same
  // configured per-mint daily cap rather than the legacy per-transaction ceiling.
  const perDay = configuredU64(env, "MINING_CLAIM_PER_DAY", items.reduce((sum, item) => sum + item.amount, 0n));
  const dayIndex = Math.floor(nowSeconds() / 86400);
  const now = nowSeconds();
  const encoded = JSON.stringify(items.map((item) => ({ claimIds: item.claimIds, mint: item.mint, amount: item.amount.toString() })));
  const attemptDigest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${requestedBatchId}:${now}:${encoded}`),
  );
  const attemptSuffix = Array.from(new Uint8Array(attemptDigest).slice(0, 12), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const batchId = expiredBatchId ? `${requestedBatchId}:attempt:${attemptSuffix}` : requestedBatchId;
  const inserted = await env.DB.prepare(
    "INSERT OR IGNORE INTO meteora_claim_batches (id, wallet, status, items, day_index, created_at, updated_at) " +
    "VALUES (?1, ?2, 'SENT', ?3, ?4, ?5, ?5)",
  ).bind(batchId, wallet, encoded, dayIndex, now).run();
  if ((inserted.meta?.changes ?? 0) !== 1) throw new Error("claim batch attempt is already being prepared");
  if (expiredBatchId) {
    const linked = await env.DB.prepare(
      "UPDATE meteora_claim_batches SET replacement_id=?2, updated_at=?3 WHERE id=?1 AND status='FAILED'",
    ).bind(expiredBatchId, batchId, now).run();
    if ((linked.meta?.changes ?? 0) !== 1) throw new Error("expired claim batch changed concurrently");
  }

  let capReserved = false;
  try {
    const signer = await loadMiningVaultSigner(env);
    // Every amount must be covered by the vault's real token account for that mint. This is the
    // funding proof: a reward reserved in game accounting but absent from the vault ATA is not
    // payable, and signing anyway would produce a transaction the network rejects.
    for (const item of items) {
      if (item.amount > perDay) throw new Error("claim batch exceeds MINING_CLAIM_PER_DAY");
      const source = deriveAssociatedTokenAddress(item.mint, signer.address);
      const sourceAccount = await readAccount(env, source);
      if (!sourceAccount) throw new Error("mining vault token account does not exist for this reward");
      const available = decodeTokenAccountAmount(sourceAccount.data);
      if (available < item.amount) throw new Error("mining vault does not hold enough of this reward to pay it");
    }
    // Reserve every per-mint daily cap in one D1 batch. A single unfunded reservation aborts the
    // whole transaction, so a batch can never split one payout into smaller rows to evade the cap.
    const reserved = await env.DB.batch([
      ...items.map((item) => env.DB.prepare(
        "INSERT INTO meteora_daily_claim_caps (mint, wallet, day_index, reserved, settled, revision)" +
        " VALUES (?1, ?2, ?3, ?4, '0', 1) ON CONFLICT(mint, wallet, day_index) DO UPDATE SET" +
        " reserved=CAST(CAST(reserved AS INTEGER)+CAST(?4 AS INTEGER) AS TEXT), revision=revision+1" +
        " WHERE CAST(CAST(reserved AS INTEGER)+CAST(?4 AS INTEGER) AS INTEGER) <= ?5",
      ).bind(item.mint, wallet, dayIndex, item.amount.toString(), perDay.toString())),
      env.DB.prepare(
        "UPDATE meteora_claim_batches SET cap_reserved=1, updated_at=?2 WHERE id=?1 AND status='SENT' AND cap_reserved=0",
      ).bind(batchId, now),
    ]);
    if (reserved.some((result) => (result.meta?.changes ?? 0) !== 1)) throw new Error("claim exceeds daily cap");
    capReserved = true;
    const blockhashResponse = await getChainRpc(meteoraRpcEnv(env)).getLatestBlockhash({ commitment: "confirmed" }).send();
    const transaction = await buildPreparedClaimBatchTransaction({
      vault: signer,
      player: wallet,
      blockhash: blockhashResponse.value,
      items: items.map((item) => ({ mint: item.mint, amount: item.amount })).sort((a, b) => a.mint.localeCompare(b.mint)),
    });
    const wire = getBase64EncodedWireTransaction(transaction);
    const expiresAt = now + MINING_CLAIM_TRANSACTION_TTL_SECONDS;
    const saved = await env.DB.prepare(
      "UPDATE meteora_claim_batches SET prepared_transaction=?2, prepared_expires_at=?3, " +
      "prepared_last_valid_block_height=?4, prepared_slot=?5, updated_at=?6 " +
      "WHERE id=?1 AND status='SENT' AND prepared_transaction IS NULL",
    ).bind(
      batchId,
      wire,
      expiresAt,
      blockHeightNumber(blockhashResponse.value.lastValidBlockHeight),
      blockHeightNumber(blockhashResponse.context.slot),
      now,
    ).run();
    if ((saved.meta?.changes ?? 0) !== 1) throw new Error("claim batch preparation is still in progress");
    return {
      id: batchId,
      wallet,
      items: [...items].sort((a, b) => a.mint.localeCompare(b.mint)),
      transaction: wire,
      expiresAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stored = await readClaimBatch(env, batchId);
    // If a transaction was persisted it is a player-visible envelope: keep its reservation and row
    // so confirm can still reconcile it. With no signed bytes, this attempt owns nothing that needs
    // reconciliation and may be terminally failed with an exactly matched cap rollback.
    if (stored?.status === "SENT" && !stored.prepared_transaction && capReserved) {
      await releaseClaimReservation(env, { ...stored, cap_reserved: 1 }, message);
    } else if (stored?.status === "SENT" && !stored.prepared_transaction) {
      await env.DB.prepare(
        "UPDATE meteora_claim_batches SET status='FAILED', error=?2, updated_at=?3 WHERE id=?1 AND status='SENT'",
      ).bind(batchId, message, nowSeconds()).run();
    } else if (stored?.status === "SENT") {
      await env.DB.prepare(
        "UPDATE meteora_claim_batches SET error=?2, updated_at=?3 WHERE id=?1 AND status='SENT'",
      ).bind(batchId, message, nowSeconds()).run();
    }
    throw error;
  }
}

/**
 * Settles every claim in a batch from one verified signature, or none of them.
 *
 * The game ledger is advanced only after the chain has been read back and the whole transfer set has
 * been proven, so a player is never marked paid for a transaction that did not move the tokens. The
 * per-claim status writes and the mine's `paid` advance are guarded by the mine version, so two
 * concurrent confirmations of the same batch cannot both apply.
 */
export async function confirmClaimBatch(
  env: MeteoraRpcEnv,
  wallet: string,
  batchId: string,
  signature: string,
): Promise<ClaimBatchItemAmounts[]> {
  const id = batchId.trim();
  if (!id) throw new Error("batchId is required");
  if (!isTransactionSignature(signature)) throw new Error("signature must be a 64-byte Solana transaction signature");
  const authenticatedWallet = requireAddress(wallet, "wallet");
  let batch = await readClaimBatch(env, id);
  // Ownership is checked immediately after the read and before secret loading, chain access, or any
  // state mutation. The same generic error for absent/foreign rows prevents batch enumeration.
  if (!batch || batch.wallet !== authenticatedWallet) throw new Error("claim batch not found");
  if (batch.status === "SETTLED") {
    if (batch.signature !== signature) throw new Error("signature does not match the settled claim batch");
    return decodeBatchItems(batch.items);
  }
  if (batch.status !== "SENT") throw new Error("claim batch is not awaiting confirmation");
  if (batch.signature && batch.signature !== signature) throw new Error("signature does not match the prepared claim batch");
  if (!batch.prepared_transaction) throw new Error("claim batch has no prepared transaction");
  const items = decodeBatchItems(batch.items);
  const proof = await readFinalizedTransactionProof(env, signature);
  if (!proof) return [];
  const { wire } = proof;
  // A valid 64-byte signature is not enough: the reported transaction must be the exact durable
  // bytes this server prepared. This prevents a player from binding an unrelated transfer to a
  // batch id and also binds confirmations to one specific attempt across replacements.
  if (wire !== batch.prepared_transaction) throw new Error("signature does not match the prepared claim transaction");
  const signer = await loadMiningVaultSigner(env);
  if (!verifyClaimBatchTransfer(proof.transaction, {
    wallet: batch.wallet,
    vault: signer.address,
    items: items.map((item) => ({ mint: item.mint, amount: item.amount })),
  })) return [];
  // Re-read after RPC latency. Another confirmation or reconciliation may have won the race.
  batch = await readClaimBatch(env, id);
  if (!batch || batch.wallet !== authenticatedWallet) throw new Error("claim batch not found");
  if (batch.status === "SETTLED") {
    if (batch.signature !== signature) throw new Error("signature does not match the settled claim batch");
    return decodeBatchItems(batch.items);
  }
  if (batch.status !== "SENT" || batch.prepared_transaction !== wire || batch.cap_reserved !== 1) {
    throw new Error("claim batch changed concurrently; retry confirmation");
  }
  const now = nowSeconds();
  const caps = new Map<string, { settled: string; reserved: string; revision: number }>();
  for (const item of items) {
    if (caps.has(item.mint)) continue;
    const cap = await env.DB.prepare(
      "SELECT settled, reserved, revision FROM meteora_daily_claim_caps WHERE mint=?1 AND wallet=?2 AND day_index=?3",
    ).bind(item.mint, batch.wallet, batch.day_index).first<{ settled: string; reserved: string; revision: number }>();
    if (!cap) throw new Error("daily claim reservation is missing");
    caps.set(item.mint, cap);
  }
  const settled = await env.DB.batch([
    env.DB.prepare(
      "UPDATE meteora_claim_batches SET status='SETTLED', signature=?2, cap_reserved=0, error=NULL, updated_at=?3 " +
      "WHERE id=?1 AND status='SENT' AND signature IS NULL AND cap_reserved=1 AND prepared_transaction=?4",
    ).bind(id, signature, now, wire),
    ...items.map((item) => {
      const cap = caps.get(item.mint)!;
      if (BigInt(cap.settled) + item.amount > BigInt(cap.reserved)) throw new Error("daily claim reservation is insufficient");
      return capSettlement(env, item.mint, batch.wallet, item.amount, batch.day_index, BigInt(cap.settled), BigInt(cap.reserved), cap.revision);
    }),
  ]);
  if (settled.some((result) => (result.meta?.changes ?? 0) !== 1)) throw new Error("claim batch settled concurrently; retry confirmation");
  for (const item of items) {
    await updateVaultBalance(env, item.mint, deriveAssociatedTokenAddress(item.mint, signer.address));
  }
  return items;
}

export { ASSOCIATED_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID };
