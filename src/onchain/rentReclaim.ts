/**
 * Rent reclaim: closing the token accounts a wallet no longer needs, and paying the platform its
 * share of the lamports that come back.
 *
 * Every token account on Solana holds rent-exempt lamports. When its balance reaches zero it is
 * dead weight, and closing it returns those lamports to its owner. This module finds the accounts
 * that can be closed, packs as many close instructions into one legacy transaction as will fit,
 * and builds the transfer that pays the protocol 1% of what comes back in the same transaction.
 *
 * Three invariants are enforced here rather than left to the caller:
 *
 *   1. An account with a non-zero balance is never closed. Closing one is how a wallet loses
 *      tokens, and this module does not offer a dust-burn exception.
 *   2. An account carrying a withheld Token-2022 transfer fee is never closed, because that fee is
 *      value the account still owes someone else. Nor is a frozen account, nor one whose close
 *      authority is somebody other than the wallet.
 *   3. The fee is computed from the lamports the batch actually returns, per transaction, with
 *      integer flooring. Nothing here can pay out more than was reclaimed.
 *
 */
import { type Address, AccountRole, type Instruction, address } from "@solana/kit";
import {
  SYSTEM_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
} from "../../shared/program";
import {
  describeTransactionError,
  rpc,
  signSendConfirm,
  type DiggoWallet,
  type SubmissionStatus,
  awaitConfirmation,
} from "./tx";

/** The platform share of every reclaimed lamport, in basis points. One percent. */
export const PLATFORM_FEE_BPS = 100;
/**
 * The most close instructions one transaction will carry.
 *
 * The limit that actually binds is bytes: a close is 131 bytes of instruction plus a 32-byte key
 * the first time it appears, so a legacy transaction carries five closes alongside the fee
 * transfer, or six when there is no fee to pay. This is a guard above that - a batch can never
 * become unbounded even if the byte estimate were wrong - rather than a target to fill.
 */
export const MAX_CLOSES_PER_TX = 20;
/**
 * The legacy transaction size limit the runtime enforces. A transaction is rejected above it, so
 * the packer stops short rather than sending a batch that cannot land.
 */
export const LEGACY_TX_SIZE_LIMIT = 1_232;
export const LAMPORTS_PER_SOL = 1_000_000_000;

/** SPL Token and Token-2022 instruction indices, which are identical for these two. */
const TOKEN_INSTRUCTION = { burn: 8, closeAccount: 9 } as const;

/** One token account, as the chain states it. */
export interface TokenAccountSnapshot {
  account: Address;
  mint: Address;
  /** The wallet that owns the account, which is also the only address it may be closed to. */
  owner: Address;
  /** SPL Token or Token-2022: the program that owns the account and must process its close. */
  program: Address;
  /** The rent this account holds, in lamports. This is what comes back. */
  lamports: bigint;
  /** The token balance, in base units. A non-zero balance blocks the close. */
  amount: bigint;
  decimals: number;
  state: string;
  /** True for a wrapped-SOL account, whose balance is spendable SOL. */
  isNative: boolean;
  /** Token-2022 transfer fees the account still withholds for a recipient. */
  withheldFees: bigint;
  /** Set when somebody other than the owner may close the account. */
  closeAuthority: Address | null;
}

/** Why one account was left alone. Shown in the panel, so the reason is a sentence. */
export interface ReclaimSkip {
  account: Address;
  mint: Address;
  reason: string;
}

/** One transaction worth of work: the accounts it closes, and what it pays out. */
export interface ReclaimBatch {
  accounts: TokenAccountSnapshot[];
  /** Rent returned by this batch, in lamports. */
  lamports: bigint;
  /** The platform share of this batch, floored, and what its own transaction transfers. */
  platformFeeLamports: bigint;
  userReceivesLamports: bigint;
}

export interface ReclaimPlan {
  batches: ReclaimBatch[];
  accounts: number;
  totalLamports: bigint;
  platformFeeLamports: bigint;
  userReceivesLamports: bigint;
  skipped: ReclaimSkip[];
  platformFeeBps: number;
}

/** What happened to one batch. A failure is reported here rather than aborting the whole run. */
export interface ReclaimBatchResult {
  index: number;
  accounts: Address[];
  lamports: bigint;
  platformFeeLamports: bigint;
  userReceivesLamports: bigint;
  signature: string | null;
  status: SubmissionStatus;
  error: string | null;
}

export interface ReclaimResult {
  plan: ReclaimPlan;
  results: ReclaimBatchResult[];
  /** Totals over the batches that landed, which is what the player actually received. */
  reclaimedLamports: bigint;
  platformFeeLamports: bigint;
  userReceivesLamports: bigint;
  failures: number;
}

/** Whether any submitted batch still needs a status check before another reclaim can be signed. */
export function hasPendingReclaim(result: ReclaimResult | null | undefined): boolean {
  return result?.results.some((entry) => entry.status === "pending" || entry.status === "submitted") ?? false;
}

// --- what can be closed --------------------------------------------------------------------

/** The platform share of an amount, floored. Integer maths, so it can never round up. */
export function platformFeeOf(lamports: bigint, bps = PLATFORM_FEE_BPS): bigint {
  if (lamports <= 0n) return 0n;
  return (lamports * BigInt(bps)) / 10_000n;
}

/**
 * Why this account cannot be closed, or null when it can.
 *
 * The order of the checks matters for the message the panel shows: a balance is reported before a
 * close authority, because a player who sees "still holds a balance" knows what to do about it.
 */
export function skipReason(
  account: TokenAccountSnapshot,
): string | null {
  if (account.lamports <= 0n) return "The account holds no rent to return.";
  if (account.withheldFees > 0n) return "The account withholds Token-2022 transfer fees.";
  if (account.state.toLowerCase() === "frozen") return "The account is frozen.";
  if (account.isNative && account.amount > 0n) return "The account holds wrapped SOL.";
  if (account.amount > 0n) return "The account still holds a balance.";
  // A close authority that is not the owner means somebody else has to sign the close, so a
  // batch containing this account would fail for a reason the player cannot fix from here.
  if (account.closeAuthority !== null && String(account.closeAuthority) !== String(account.owner)) {
    return "Another wallet is the close authority.";
  }
  return null;
}

/** The accounts that can be closed, in the order they were read. */
export function selectReclaimable(
  accounts: readonly TokenAccountSnapshot[],
): TokenAccountSnapshot[] {
  return accounts.filter((account) => skipReason(account) === null);
}

// --- instructions --------------------------------------------------------------------------

/** @solana/kit bit-flags account roles: bit 0 writable, bit 1 signer. */
const w = (value: Address) => ({ address: value, role: AccountRole.WRITABLE }) as const;
const ws = (value: Address) => ({ address: value, role: AccountRole.WRITABLE_SIGNER }) as const;

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function u64(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * SPL Token burn, which Token-2022 keeps at the same index and layout. It is built here rather
 * than pulled from a token SDK because the account order and the index are the whole contract and
 * a wrong one either fails or, worse, burns the wrong thing.
 */
export function buildBurnInstruction(params: {
  account: Address;
  mint: Address;
  owner: Address;
  program: Address;
  amount: bigint;
}): Instruction {
  return {
    programAddress: params.program,
    accounts: [w(params.account), w(params.mint), ws(params.owner)],
    data: concat([Uint8Array.of(TOKEN_INSTRUCTION.burn), u64(params.amount)]),
  };
}

/**
 * SPL Token close_account: the rent goes to `destination`, which the token program requires to be
 * the account owner (or its close authority). The wallet passes itself, so the lamports come back
 * to the wallet and nowhere else.
 */
export function buildCloseAccountInstruction(params: {
  account: Address;
  destination: Address;
  owner: Address;
  program: Address;
}): Instruction {
  return {
    programAddress: params.program,
    accounts: [w(params.account), w(params.destination), ws(params.owner)],
    data: Uint8Array.of(TOKEN_INSTRUCTION.closeAccount),
  };
}

/** The System Program transfer that pays the platform its share, in the same transaction. */
export function buildTreasuryTransferInstruction(params: {
  from: Address;
  to: Address;
  lamports: bigint;
}): Instruction {
  return {
    programAddress: SYSTEM_PROGRAM_ADDRESS,
    accounts: [ws(params.from), w(params.to)],
    data: concat([u32(2), u64(params.lamports)]),
  };
}

/** How many bytes one compiled instruction adds, including its own account list. */
function instructionSize(instruction: Instruction): number {
  return 1 + 32 + 1 + (instruction.accounts?.length ?? 0) * 32 + (instruction.data?.length ?? 0);
}

/**
 * The serialized size of a legacy transaction carrying these instructions.
 *
 * It is an estimate in one direction only: account keys are deduplicated exactly as the runtime
 * deduplicates them, and every field is counted at its real width, so the answer is never below
 * what the runtime will compute. A batch that passes this check fits, which is the property the
 * packer needs.
 */
export function estimateTransactionSize(
  instructions: readonly Instruction[],
  feePayer: Address,
): number {
  const keys = new Set<string>([String(feePayer)]);
  for (const instruction of instructions) {
    keys.add(String(instruction.programAddress));
    for (const account of instruction.accounts ?? []) keys.add(String(account.address));
  }
  let size = 1 + 64; // one signature, and the count that precedes it
  size += 3; // message header
  size += 1 + keys.size * 32; // account keys, with a one-byte length
  size += 32; // recent blockhash
  size += 1; // instruction count
  for (const instruction of instructions) size += instructionSize(instruction);
  return size;
}

// --- planning ------------------------------------------------------------------------------

export interface ReclaimPlanOptions {
  /** The wallet the accounts belong to: the fee payer, the close destination and the fee source. */
  owner: Address;
  /** The protocol treasury the 1% goes to, from the ProtocolConfig decoder. */
  treasury: Address;
  platformFeeBps?: number;
  maxPerTx?: number;
  sizeLimit?: number;
}

/** One closable account. */
interface Closable {
  account: TokenAccountSnapshot;
}

function batchOf(entries: readonly Closable[], owner: Address, treasury: Address, bps: number): ReclaimBatch {
  const accounts = entries.map((entry) => entry.account);
  let lamports = 0n;
  for (const entry of entries) {
    lamports += entry.account.lamports;
  }
  const platformFeeLamports = platformFeeOf(lamports, bps);
  void owner;
  void treasury;
  return {
    accounts,
    lamports,
    platformFeeLamports,
    userReceivesLamports: lamports - platformFeeLamports,
  };
}

/** The instructions one batch becomes: its closes, then the platform transfer. */
export function buildBatchInstructions(
  batch: ReclaimBatch,
  params: { owner: Address; treasury: Address },
): Instruction[] {
  const instructions: Instruction[] = [];
  for (const account of batch.accounts) {
    instructions.push(
      buildCloseAccountInstruction({
        account: account.account,
        destination: params.owner,
        owner: params.owner,
        program: account.program,
      }),
    );
  }
  if (batch.platformFeeLamports > 0n) {
    instructions.push(
      buildTreasuryTransferInstruction({
        from: params.owner,
        to: params.treasury,
        lamports: batch.platformFeeLamports,
      }),
    );
  }
  return instructions;
}

/** Whether these accounts still fit in one legacy transaction, fee included. */
function fitsInTransaction(
  entries: readonly Closable[],
  options: { owner: Address; treasury: Address; bps: number; maxPerTx: number; sizeLimit: number },
): boolean {
  if (entries.length > options.maxPerTx) return false;
  const batch = batchOf(entries, options.owner, options.treasury, options.bps);
  const instructions = buildBatchInstructions(batch, { owner: options.owner, treasury: options.treasury });
  return estimateTransactionSize(instructions, options.owner) <= options.sizeLimit;
}

/**
 * The whole plan: which accounts get closed, how they are split across transactions, and exactly
 * what the platform and the wallet each receive.
 *
 * The fee is computed per batch and floored per batch, so the total is the sum of what the
 * transactions will actually transfer rather than a percentage recomputed over a total that no
 * single transaction ever sees.
 */
export function planReclaim(
  accounts: readonly TokenAccountSnapshot[],
  options: ReclaimPlanOptions,
): ReclaimPlan {
  const bps = options.platformFeeBps ?? PLATFORM_FEE_BPS;
  const packing = {
    owner: options.owner,
    treasury: options.treasury,
    bps,
    maxPerTx: options.maxPerTx ?? MAX_CLOSES_PER_TX,
    sizeLimit: options.sizeLimit ?? LEGACY_TX_SIZE_LIMIT,
  };

  const skipped: ReclaimSkip[] = [];
  const closable: Closable[] = [];
  for (const account of accounts) {
    const reason = skipReason(account);
    if (reason !== null) {
      skipped.push({ account: account.account, mint: account.mint, reason });
      continue;
    }
    closable.push({ account });
  }

  const batches: ReclaimBatch[] = [];
  let current: Closable[] = [];
  const flush = () => {
    if (current.length === 0) return;
    batches.push(batchOf(current, options.owner, options.treasury, bps));
    current = [];
  };
  for (const candidate of closable) {
    if (current.length > 0 && !fitsInTransaction([...current, candidate], packing)) flush();
    current.push(candidate);
  }
  flush();

  let totalLamports = 0n;
  let platformFeeLamports = 0n;
  for (const batch of batches) {
    totalLamports += batch.lamports;
    platformFeeLamports += batch.platformFeeLamports;
  }
  return {
    batches,
    accounts: closable.length,
    totalLamports,
    platformFeeLamports,
    userReceivesLamports: totalLamports - platformFeeLamports,
    skipped,
    platformFeeBps: bps,
  };
}

// --- reading the wallet --------------------------------------------------------------------

interface ParsedTokenAccountInfo {
  mint?: string;
  owner?: string;
  state?: string;
  isNative?: boolean | number;
  delegate?: string | null;
  closeAuthority?: string | null;
  tokenAmount?: { amount?: string; decimals?: number };
  extensions?: readonly { extension?: string; state?: Record<string, unknown> }[];
}

/**
 * The Token-2022 transfer fee an account still withholds for a recipient, in base units.
 *
 * A withheld fee is value the account owes somebody else, so an account carrying one is never
 * closed. The field is read by name rather than by extension position because the extension list
 * is open-ended and a positional read would eventually pick up an unrelated number.
 */
export function withheldFeesOf(info: ParsedTokenAccountInfo): bigint {
  let withheld = 0n;
  for (const extension of info.extensions ?? []) {
    const state = extension?.state;
    if (!state || typeof state !== "object") continue;
    const value = (state as { withheldAmount?: unknown }).withheldAmount;
    if (typeof value === "string" && /^[0-9]+$/.test(value)) withheld += BigInt(value);
  }
  return withheld;
}

export interface ReclaimScan {
  owner: Address;
  accounts: TokenAccountSnapshot[];
  /**
   * False when one of the two token programs could not be read. The scan still reports what it
   * did see, and the caller can say so, because a partial list presented as a complete one would
   * understate what is reclaimable.
   */
  complete: boolean;
}

/**
 * The wallet token accounts across both token programs, as the chain states them.
 *
 * jsonParsed is requested so the mint, the owner, the state, the balance and any withheld fee come
 * back already named. The panel decides what to do with them; this function only reports facts.
 */
export async function scanTokenAccounts(owner: Address): Promise<ReclaimScan> {
  const client = rpc as unknown as {
    getTokenAccountsByOwner(
      owner: Address,
      filter: { programId: Address },
      config: { encoding: "jsonParsed" },
    ): { send(): Promise<unknown> };
  };
  const programs = [TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS];
  const settled = await Promise.allSettled(
    programs.map((programId) =>
      client.getTokenAccountsByOwner(owner, { programId }, { encoding: "jsonParsed" }).send(),
    ),
  );
  const accounts: TokenAccountSnapshot[] = [];
  let complete = true;
  settled.forEach((outcome, index) => {
    if (outcome.status !== "fulfilled") {
      complete = false;
      return;
    }
    const value =
      (outcome.value as { value?: readonly { pubkey: string; account: { lamports?: number; data?: unknown } }[] })
        .value ?? [];
    for (const entry of value) {
      const info = (entry.account?.data as { parsed?: { info?: ParsedTokenAccountInfo } })?.parsed?.info;
      if (!info?.mint) continue;
      let amount: bigint;
      try {
        amount = BigInt(info.tokenAmount?.amount ?? "0");
      } catch {
        amount = 0n;
      }
      accounts.push({
        account: address(entry.pubkey),
        mint: address(info.mint),
        owner,
        program: programs[index]!,
        lamports: BigInt(entry.account?.lamports ?? 0),
        amount,
        decimals: info.tokenAmount?.decimals ?? 0,
        state: info.state ?? "initialized",
        isNative: info.isNative === true || typeof info.isNative === "number",
        withheldFees: withheldFeesOf(info),
        closeAuthority:
          typeof info.closeAuthority === "string" && info.closeAuthority.length > 0
            ? address(info.closeAuthority)
            : null,
      });
    }
  });
  return { owner, accounts, complete };
}

// --- signing -------------------------------------------------------------------------------

export interface ReclaimProgress {
  done: number;
  total: number;
  result: ReclaimBatchResult;
}

/**
 * Closes the wallet reclaimable accounts, one transaction per batch, and reports each outcome.
 *
 * The batches are submitted in order and a failure does not stop the rest: a batch that the chain
 * rejects (an account that moved between the scan and the signature, most often) costs only the
 * accounts in that batch, and the player can scan again and reclaim what is left. The returned
 * totals cover the batches that landed, so the number the panel shows is money that actually
 * arrived rather than money that was attempted.
 */
export async function reclaimRent(params: {
  wallet: DiggoWallet;
  treasury: Address;
  /** A scan already in hand, so the panel can show what it is about to sign for. */
  scan?: ReclaimScan;
  plan?: ReclaimPlan;
  onProgress?: (progress: ReclaimProgress) => void;
}): Promise<ReclaimResult> {
  const owner = params.wallet.address;
  const scan = params.scan ?? (await scanTokenAccounts(owner));
  if (!scan.complete) throw new Error("The token-account scan is incomplete; nothing was signed.");
  // A caller may pass a preview plan, but the scan is the source of truth at signing time.
  const plan = params.scan
    ? planReclaim(scan.accounts, { owner, treasury: params.treasury })
    : params.plan ?? planReclaim(scan.accounts, { owner, treasury: params.treasury });

  const results: ReclaimBatchResult[] = [];
  let reclaimedLamports = 0n;
  let platformFeeLamports = 0n;
  let failures = 0;
  for (let index = 0; index < plan.batches.length; index += 1) {
    const batch = plan.batches[index]!;
    const accounts = batch.accounts.map((account) => account.account);
    let signature: string | null = null;
    let status: SubmissionStatus = "rejected";
    let error: string | null;
    try {
      const submission = await signSendConfirm(
        params.wallet,
        buildBatchInstructions(batch, { owner, treasury: params.treasury }),
        { returnResult: true },
      );
      // Keep the executor tolerant of older test doubles and downstream wrappers that return the
      // legacy signature string. Real callers of the structured overload always return a result.
      const normalized = typeof submission === "string"
        ? { signature: submission, status: "confirmed" as const, confirmed: true }
        : submission;
      signature = normalized.signature;
      status = normalized.status;
      error = normalized.error ?? null;
      if (normalized.status === "confirmed") {
        reclaimedLamports += batch.lamports;
        platformFeeLamports += batch.platformFeeLamports;
      }
    } catch (failure) {
      error = describeTransactionError(failure);
    }
    if (status === "rejected") failures += 1;
    const result: ReclaimBatchResult = {
      index,
      accounts,
      lamports: batch.lamports,
      platformFeeLamports: status === "confirmed" ? batch.platformFeeLamports : 0n,
      userReceivesLamports: status === "confirmed" ? batch.userReceivesLamports : 0n,
      signature,
      status,
      error,
    };
    results.push(result);
    params.onProgress?.({ done: index + 1, total: plan.batches.length, result });
  }

  return {
    plan,
    results,
    reclaimedLamports,
    platformFeeLamports,
    userReceivesLamports: reclaimedLamports - platformFeeLamports,
    failures,
  };
}

/**
 * Re-checks batches whose signature was preserved after a confirmation timeout.
 *
 * This is deliberately separate from `reclaimRent`: a pending transaction is resolved by
 * reading its signature, never by submitting the same close instructions again.
 */
export async function resolvePendingReclaim(result: ReclaimResult): Promise<ReclaimResult> {
  const results = await Promise.all(result.results.map(async (entry) => {
    if (entry.status !== "pending" && entry.status !== "submitted") return entry;
    if (!entry.signature) return { ...entry, status: "rejected" as const, error: "Missing transaction signature." };
    try {
      const confirmed = await awaitConfirmation(entry.signature);
      return {
        ...entry,
        status: confirmed ? "confirmed" as const : "pending" as const,
        error: confirmed ? null : "Confirmation is still pending.",
      };
    } catch (failure) {
      return { ...entry, status: "rejected" as const, error: describeTransactionError(failure) };
    }
  }));
  let reclaimedLamports = 0n;
  let platformFeeLamports = 0n;
  let failures = 0;
  for (const entry of results) {
    if (entry.status === "confirmed") {
      const batch = result.plan.batches[entry.index];
      if (!batch) continue;
      reclaimedLamports += batch.lamports;
      platformFeeLamports += batch.platformFeeLamports;
      entry.userReceivesLamports = batch.userReceivesLamports;
      entry.platformFeeLamports = batch.platformFeeLamports;
    }
    if (entry.status === "rejected") failures += 1;
  }
  return {
    ...result,
    results,
    reclaimedLamports,
    platformFeeLamports,
    userReceivesLamports: reclaimedLamports - platformFeeLamports,
    failures,
  };
}
