/**
 * Reserve reconciliation (spec 57, 66, 78): the cron that compares what the backend's accounting
 * believes about a mine with what the Solana program and its token accounts actually say.
 *
 * Why this job exists: D1 is a cache and an index, and Solana is the authority for settlement
 * (docs/ARCHITECTURE.md). Every number here comes from a real account read - nothing is estimated
 * or inferred - because the whole point is to detect the case where the two views have drifted
 * apart. A drift is one of two things: real tokens left the program's Mining Reserve without the
 * player's claim being recorded, or the reserve moved without a valid mining/discovery claim behind
 * it. Both violate "reserves leave only through valid mining or discovery claims", and both are
 * treated the same way: record the run, raise telemetry, and halt that one mine's payouts. A mining
 * divergence opens a mint-scoped 'claims' breaker; a Discovery Vault divergence also opens the
 * mint-scoped 'discovery_reserve' breaker, because the discovery payout path is the one that would
 * keep draining that vault (spec 65, 78).
 *
 * What this module deliberately does not do: it never signs, never transfers, never invents a
 * balance and never repairs one. Its only mutations are the audit row and, on a hard divergence,
 * one narrow circuit breaker - which is exactly the power worker/breakers.ts grants (a breaker can
 * halt, and cannot move funds).
 */
import { address, type Address, type Rpc, type SolanaRpcApi } from "@solana/kit";
import { decodeMine, deriveMineAddresses, type DecodedMine } from "../shared/program";
import { breakerId, setBreaker, type BreakerScope } from "./breakers";
import { getChainRpc } from "./chain";
import type { RuntimeEnv } from "./env";
import { metric } from "./telemetry";

/** Relative tolerance for every reserve comparison, in basis points (25 bps = 0.25%). */
export const RECONCILE_TOLERANCE_BPS = 25;
/**
 * Absolute tolerance floor, in raw base units. It exists because the D1 accounting is stored as a
 * rounded whole-token number and because the two sides of a comparison are always read a moment
 * apart - a claim confirming between the Mine read and the vault read is a real transient. A
 * drained reserve is orders of magnitude larger than this floor.
 */
export const RECONCILE_MIN_TOLERANCE_RAW = 1_000n;
/** How many mines one run checks, so a single cron stays inside the Worker's subrequest budget. */
export const RECONCILE_MINES_PER_RUN = 12;
/** Cap on how much divergence detail a report carries back to its caller. */
export const RECONCILE_REPORT_LIMIT = 20;
/** The actor recorded on a breaker this job opens, so a manual hold stays distinguishable. */
export const RECONCILE_ACTOR = "reconcile-cron";

const CLAIMS_SCOPE: BreakerScope = "claims";
/** The breaker the discovery payout path consults, so a short Discovery Vault stops paying out. */
const DISCOVERY_RESERVE_SCOPE: BreakerScope = "discovery_reserve";

/**
 * Everything one mine's on-chain state contributes to a comparison, in raw base units. The reader
 * is an interface so the whole job can run against a crafted chain instead of a live RPC.
 */
export interface MineChainSnapshot {
  mint: string;
  mineAddress: string;
  reserveVault: string;
  discoveryVault: string;
  /** Mine.remaining_reserve: reserve the program still owes out through the reward index. */
  remainingReserve: bigint;
  /** Mine.cumulative_distributed: reserve already credited to positions since launch. */
  cumulativeDistributed: bigint;
  discoveryReserveTotal: bigint;
  remainingDiscoveryReserve: bigint;
  /** The SPL token account the program holds the mining reserve in. */
  reserveVaultBalance: bigint;
  discoveryVaultBalance: bigint;
}

export interface MineChainReader {
  readMine(mint: string): Promise<MineChainSnapshot>;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function vaultBalance(rpc: Rpc<SolanaRpcApi>, account: Address): Promise<bigint> {
  const { value } = await rpc.getTokenAccountBalance(account, { commitment: "confirmed" }).send();
  return BigInt(value.amount);
}

/**
 * The production reader: the program's own Mine account plus the two token accounts it controls,
 * all fetched through the existing chain helper so one place still owns the RPC URL.
 */
export function createChainMineReader(env: RuntimeEnv): MineChainReader {
  return {
    async readMine(mint: string): Promise<MineChainSnapshot> {
      if (!env.DIGGO_PROGRAM_ID) throw new Error("DIGGO_PROGRAM_ID is not configured");
      const rpc = getChainRpc(env);
      const programAddress = address(env.DIGGO_PROGRAM_ID);
      const mintAddress = address(mint);
      const addrs = await deriveMineAddresses(programAddress, mintAddress);
      const info = await rpc
        .getAccountInfo(addrs.mine, { commitment: "confirmed", encoding: "base64" })
        .send();
      if (!info.value) throw new Error("Mine account not found on-chain: " + mint);
      const mine: DecodedMine = decodeMine(base64ToBytes(info.value.data[0]));
      const [reserveVaultBalance, discoveryVaultBalance] = await Promise.all([
        vaultBalance(rpc, addrs.reserveVault),
        vaultBalance(rpc, addrs.discoveryVault),
      ]);
      return {
        mint,
        mineAddress: addrs.mine,
        reserveVault: addrs.reserveVault,
        discoveryVault: addrs.discoveryVault,
        remainingReserve: mine.remainingReserve,
        cumulativeDistributed: mine.cumulativeDistributed,
        discoveryReserveTotal: mine.discoveryReserveTotal,
        remainingDiscoveryReserve: mine.remainingDiscoveryReserve,
        reserveVaultBalance,
        discoveryVaultBalance,
      };
    },
  };
}

/** Stable names for the comparisons a run makes, so telemetry and rows stay greppable. */
export const DIVERGENCE_KINDS = {
  vaultShortfall: "vault_shortfall",
  vaultExcess: "vault_excess",
  discoveryVaultShortfall: "discovery_vault_shortfall",
  discoveryVaultExcess: "discovery_vault_excess",
  unrecordedPayout: "unrecorded_payout",
  phantomPayout: "phantom_payout",
  indexedReserveDrift: "indexed_reserve_drift",
  unindexedReserveDrift: "unindexed_reserve_drift",
  launchSizeDrift: "launch_size_drift",
} as const;

/**
 * The kinds that mean real value moved while the ledger disagreed, so claims for that mine must
 * stop. The remaining kinds are recorded and counted but halt nothing: an off-chain-indexed mine
 * legitimately disagrees with the program until it is synced, and the launch-size check is
 * informational.
 */
export const HARD_DIVERGENCE_KINDS: readonly string[] = [
  DIVERGENCE_KINDS.vaultShortfall,
  DIVERGENCE_KINDS.vaultExcess,
  DIVERGENCE_KINDS.discoveryVaultShortfall,
  DIVERGENCE_KINDS.discoveryVaultExcess,
  DIVERGENCE_KINDS.unrecordedPayout,
  DIVERGENCE_KINDS.phantomPayout,
  DIVERGENCE_KINDS.indexedReserveDrift,
];

/**
 * The hard kinds that are about the Discovery Vault. They halt claims like any other hard kind, and
 * additionally halt discovery payouts for that mint: the 'claims' breaker stops the mining claim
 * path, which is not the path that pays a discovery out of this vault.
 */
const DISCOVERY_DIVERGENCE_KINDS: readonly string[] = [
  DIVERGENCE_KINDS.discoveryVaultShortfall,
  DIVERGENCE_KINDS.discoveryVaultExcess,
];

export function reconcileTolerance(reference: bigint): bigint {
  const relative = (reference * BigInt(RECONCILE_TOLERANCE_BPS)) / 10_000n;
  return relative > RECONCILE_MIN_TOLERANCE_RAW ? relative : RECONCILE_MIN_TOLERANCE_RAW;
}

function absBig(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/**
 * A whole-token D1 figure as raw base units. The conversion is explicit rather than assumed: the
 * off-chain accounting stores whole tokens (mine_reward_state.remaining_reserve, the settled
 * reward_claims.amount) while every on-chain number is raw, so the two sides only become comparable
 * through the mint's decimals.
 */
export function wholeTokensToRaw(whole: number, decimals: number): bigint {
  if (!Number.isFinite(whole)) return 0n;
  const scale = 10 ** Math.max(0, Math.min(18, Math.floor(decimals)));
  return BigInt(Math.round(whole * scale));
}

interface MineRow {
  mint: string;
  remaining_reserve: string;
  initial_reserve: string;
  authority: string;
  decimals: number | null;
  last_checked_at: number | null;
}

interface PaidClaimRow {
  amount: string;
  paid_amount: string | null;
}

export interface ReconciliationDivergence {
  mint: string;
  status: "DIVERGED" | "UNREADABLE";
  kinds: string[];
  detail: string;
}

export interface ReconciliationReport {
  checked: number;
  ok: number;
  diverged: number;
  unreadable: number;
  breakersOpened: number;
  breakersClosed: number;
  divergences: ReconciliationDivergence[];
}

export interface ReconcileOptions {
  /** Injected chain reader; defaults to createChainMineReader(env). */
  reader?: MineChainReader;
  now?: number;
  limit?: number;
}

/** What one mine's comparison came to, before it is written down. */
export interface MineCheck {
  row: MineRow;
  authority: string;
  onchainRemaining: bigint;
  onchainCumulative: bigint;
  onchainInitial: bigint;
  reserveVaultBalance: bigint;
  discoveryVaultBalance: bigint;
  d1Remaining: bigint;
  d1Initial: bigint;
  d1Paid: bigint;
  d1ClaimCount: number;
  reserveDrift: bigint;
  paidClaimsDrift: bigint;
  initialReserveDrift: bigint;
  unclaimedInVault: bigint;
  tolerance: bigint;
  kinds: string[];
  status: "OK" | "DIVERGED";
}

/**
 * The D1 side of one mine: its indexed state, the mine's decimals, and every claim that was
 * actually paid for it.
 */
async function readD1Side(
  env: RuntimeEnv,
  row: MineRow,
): Promise<{ remaining: bigint; initial: bigint; paid: bigint; claimCount: number }> {
  const decimals = Number(row.decimals ?? 6);
  const claims = await env.DB.prepare(
    "SELECT amount, paid_amount FROM reward_claims WHERE mint = ?1 AND tx_signature IS NOT NULL",
  )
    .bind(row.mint)
    .all<PaidClaimRow>();
  let paid = 0n;
  for (const claim of claims.results) {
    // paid_amount is the raw figure measured from the confirmed transaction itself, so it is
    // preferred wherever it exists; amount is the settled whole-token figure, converted for rows
    // that predate the confirmation endpoint.
    paid += claim.paid_amount === null || claim.paid_amount === ""
      ? wholeTokensToRaw(Number(claim.amount), decimals)
      : BigInt(claim.paid_amount);
  }
  return {
    remaining: wholeTokensToRaw(Number(row.remaining_reserve), decimals),
    initial: wholeTokensToRaw(Number(row.initial_reserve), decimals),
    paid,
    claimCount: claims.results.length,
  };
}

/**
 * Compares one mine. Pure arithmetic over the two sides, so every rule that decides whether a
 * reserve has diverged lives in one place and can be tested without storage.
 *
 * The paid-claims expectation is the interesting one. The program debits Mine.remaining_reserve
 * when a block is credited (see sync_mine in programs/diggo-protocol) and leaves the tokens in the
 * vault until the player claims, so the vault holds "remaining_reserve + everything credited but
 * not yet claimed", and therefore
 *
 *   expected_paid = cumulative_distributed - (vault_balance - remaining_reserve)
 *
 * which is exactly "credited, minus what is still sitting there unclaimed". Integer-division dust
 * cancels out of that identity - the full credited amount leaves remaining_reserve, whether or not
 * every last unit could be allocated to a position - so a gap against the D1 total is a real gap
 * rather than an artefact of rounding.
 */
export function compareMine(input: {
  row: MineRow;
  chain: MineChainSnapshot;
  d1: { remaining: bigint; initial: bigint; paid: bigint; claimCount: number };
}): MineCheck {
  const { row, chain, d1 } = input;
  const onchainRemaining = chain.remainingReserve;
  const onchainCumulative = chain.cumulativeDistributed;
  const onchainInitial = onchainRemaining + onchainCumulative;
  const tolerance = reconcileTolerance(onchainInitial);
  const kinds: string[] = [];

  const unclaimedRaw = chain.reserveVaultBalance - onchainRemaining;
  const unclaimedInVault = unclaimedRaw > 0n ? unclaimedRaw : 0n;
  const cappedUnclaimed = unclaimedInVault < onchainCumulative ? unclaimedInVault : onchainCumulative;
  const expectedPaid = onchainCumulative - cappedUnclaimed;

  const reserveDrift = d1.remaining - onchainRemaining;
  const paidClaimsDrift = d1.paid - expectedPaid;
  const initialReserveDrift = d1.initial - onchainInitial;

  // The vault is the only place the mine's reserve can be, so it has to cover what the program
  // still owes and can never exceed everything the program ever had.
  if (chain.reserveVaultBalance < onchainRemaining) kinds.push(DIVERGENCE_KINDS.vaultShortfall);
  if (chain.reserveVaultBalance > onchainInitial) kinds.push(DIVERGENCE_KINDS.vaultExcess);
  if (chain.discoveryVaultBalance < chain.remainingDiscoveryReserve) {
    kinds.push(DIVERGENCE_KINDS.discoveryVaultShortfall);
  }
  if (chain.discoveryVaultBalance > chain.discoveryReserveTotal) {
    kinds.push(DIVERGENCE_KINDS.discoveryVaultExcess);
  }
  // Fewer recorded payouts than tokens that left the reserve: a player was paid and the ledger
  // never heard about it.
  if (paidClaimsDrift < -tolerance) kinds.push(DIVERGENCE_KINDS.unrecordedPayout);
  // More recorded payouts than the chain shows leaving: a payout was recorded that did not happen,
  // or one that did happen was recorded twice.
  if (paidClaimsDrift > tolerance) kinds.push(DIVERGENCE_KINDS.phantomPayout);

  if (absBig(reserveDrift) > tolerance) {
    if (row.authority === "ONCHAIN_INDEXED") {
      // The D1 accounting claims to mirror the program, so disagreeing with it is a real fault.
      kinds.push(DIVERGENCE_KINDS.indexedReserveDrift);
    } else {
      // Expected until the mine is synced from chain: here the off-chain index is the accounting
      // source, so the two sides are different views rather than a contradiction. Recorded anyway,
      // because a gap that keeps growing is the signal that the mine needs syncing.
      kinds.push(DIVERGENCE_KINDS.unindexedReserveDrift);
    }
  }
  if (absBig(initialReserveDrift) > tolerance) kinds.push(DIVERGENCE_KINDS.launchSizeDrift);

  return {
    row,
    authority: row.authority,
    onchainRemaining,
    onchainCumulative,
    onchainInitial,
    reserveVaultBalance: chain.reserveVaultBalance,
    discoveryVaultBalance: chain.discoveryVaultBalance,
    d1Remaining: d1.remaining,
    d1Initial: d1.initial,
    d1Paid: d1.paid,
    d1ClaimCount: d1.claimCount,
    reserveDrift,
    paidClaimsDrift,
    initialReserveDrift,
    unclaimedInVault,
    tolerance,
    kinds,
    status: kinds.length > 0 ? "DIVERGED" : "OK",
  };
}

function describeCheck(check: MineCheck): string {
  return [
    "d1_remaining=" + check.d1Remaining.toString(),
    "chain_remaining=" + check.onchainRemaining.toString(),
    "vault=" + check.reserveVaultBalance.toString(),
    "expected_paid=" + (check.d1Paid - check.paidClaimsDrift).toString(),
    "d1_paid=" + check.d1Paid.toString(),
    "tolerance=" + check.tolerance.toString(),
  ].join(" ");
}

/** The mines to check, least recently reconciled first, so every mine is visited in turn. */
async function loadMineRows(env: RuntimeEnv, limit: number): Promise<MineRow[]> {
  const result = await env.DB.prepare(
    "SELECT m.mint AS mint, m.remaining_reserve AS remaining_reserve, " +
      "m.initial_reserve AS initial_reserve, m.authority AS authority, t.decimals AS decimals, " +
      "(SELECT MAX(r.checked_at) FROM reconciliation_runs r WHERE r.mint = m.mint) AS last_checked_at " +
      "FROM mine_reward_state m LEFT JOIN tokens t ON t.mint = m.mint " +
      "ORDER BY COALESCE((SELECT MAX(r.checked_at) FROM reconciliation_runs r WHERE r.mint = m.mint), 0) ASC, " +
      "m.updated_at DESC LIMIT ?1",
  )
    .bind(limit)
    .all<MineRow>();
  return result.results;
}

async function recordRun(env: RuntimeEnv, check: MineCheck, breakerOpened: boolean, now: number): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO reconciliation_runs (id, mint, authority, checked_at, onchain_remaining_reserve, " +
      "onchain_cumulative_distributed, onchain_initial_reserve, reserve_vault_balance, " +
      "discovery_vault_balance, d1_remaining_reserve, d1_initial_reserve, d1_paid_claims, d1_claim_count, " +
      "reserve_drift, paid_claims_drift, initial_reserve_drift, unclaimed_in_vault, tolerance, status, " +
      "divergence_kinds, breaker_opened, detail) " +
      "VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22)",
  )
    .bind(
      crypto.randomUUID(),
      check.row.mint,
      check.authority,
      now,
      check.onchainRemaining.toString(),
      check.onchainCumulative.toString(),
      check.onchainInitial.toString(),
      check.reserveVaultBalance.toString(),
      check.discoveryVaultBalance.toString(),
      check.d1Remaining.toString(),
      check.d1Initial.toString(),
      check.d1Paid.toString(),
      check.d1ClaimCount,
      check.reserveDrift.toString(),
      check.paidClaimsDrift.toString(),
      check.initialReserveDrift.toString(),
      check.unclaimedInVault.toString(),
      check.tolerance.toString(),
      check.status,
      check.kinds.join(","),
      breakerOpened ? 1 : 0,
      describeCheck(check),
    )
    .run();
}

/**
 * Records a mine the chain could not be read for. This is deliberately not a divergence: an RPC
 * hiccup or a momentarily unreadable account must never open a breaker, because a breaker opened on
 * a failed read is a halt with no evidence behind it.
 */
async function recordUnreadable(env: RuntimeEnv, row: MineRow, now: number, detail: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO reconciliation_runs (id, mint, authority, checked_at, d1_remaining_reserve, " +
      "d1_initial_reserve, status, divergence_kinds, breaker_opened, detail) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'UNREADABLE', '', 0, ?7)",
  )
    .bind(
      crypto.randomUUID(),
      row.mint,
      row.authority,
      now,
      row.remaining_reserve,
      row.initial_reserve,
      detail.slice(0, 500),
    )
    .run();
}

/**
 * Opens one mint-scoped breaker. Only a closed row is opened, so a divergence detected by the cron
 * never overwrites a decision an operator already made.
 */
async function openMineBreaker(
  env: RuntimeEnv,
  scope: BreakerScope,
  mint: string,
  kinds: readonly string[],
): Promise<boolean> {
  const id = breakerId(scope, mint);
  const existing = await env.DB.prepare("SELECT open, actor FROM circuit_breakers WHERE id = ?1")
    .bind(id)
    .first<{ open: number; actor: string | null }>();
  if (existing && existing.open === 1) {
    await metric(env, "reconcile.breaker_already_open", 1, { mint, scope });
    return false;
  }
  await setBreaker(env, {
    scope,
    mint,
    open: true,
    reason: "reserve_divergence:" + kinds.join("+"),
    actor: RECONCILE_ACTOR,
  });
  return true;
}

/** Closes only a breaker this job opened, so a manual hold is never lifted by a cron. */
async function closeMineBreakerIfOurs(env: RuntimeEnv, scope: BreakerScope, mint: string): Promise<boolean> {
  const id = breakerId(scope, mint);
  const existing = await env.DB.prepare("SELECT open, actor FROM circuit_breakers WHERE id = ?1")
    .bind(id)
    .first<{ open: number; actor: string | null }>();
  if (!existing || existing.open !== 1 || existing.actor !== RECONCILE_ACTOR) return false;
  await setBreaker(env, {
    scope,
    mint,
    open: false,
    reason: "reserve_reconciled",
    actor: RECONCILE_ACTOR,
  });
  return true;
}

/**
 * One reconciliation pass: read each mine's on-chain state and the D1 view of it, compare them, and
 * leave behind both an audit row and - only for a hard divergence - a mint-scoped claims halt.
 *
 * Never throws for a single mine: one unreadable mine must not stop the pass, and the report says
 * which mines ended up where.
 */
export async function reconcileReserves(
  env: RuntimeEnv,
  options: ReconcileOptions = {},
): Promise<ReconciliationReport> {
  const now = options.now ?? Math.floor(Date.now() / 1_000);
  const limit = Math.max(1, Math.min(options.limit ?? RECONCILE_MINES_PER_RUN, 200));
  const reader = options.reader ?? createChainMineReader(env);
  const rows = await loadMineRows(env, limit);
  const report: ReconciliationReport = {
    checked: 0,
    ok: 0,
    diverged: 0,
    unreadable: 0,
    breakersOpened: 0,
    breakersClosed: 0,
    divergences: [],
  };

  for (const row of rows) {
    report.checked += 1;
    let chain: MineChainSnapshot;
    try {
      chain = await reader.readMine(row.mint);
    } catch (error) {
      report.unreadable += 1;
      const detail = String(error);
      if (report.divergences.length < RECONCILE_REPORT_LIMIT) {
        report.divergences.push({ mint: row.mint, status: "UNREADABLE", kinds: [], detail });
      }
      await metric(env, "reconcile.unreadable", 1, { mint: row.mint });
      console.error(JSON.stringify({ event: "reconcile.unreadable", mint: row.mint, error: detail }));
      await recordUnreadable(env, row, now, detail);
      continue;
    }

    const d1 = await readD1Side(env, row);
    const check = compareMine({ row, chain, d1 });

    if (check.status === "OK") {
      report.ok += 1;
      for (const scope of [CLAIMS_SCOPE, DISCOVERY_RESERVE_SCOPE]) {
        if (await closeMineBreakerIfOurs(env, scope, row.mint)) report.breakersClosed += 1;
      }
      await recordRun(env, check, false, now);
      continue;
    }

    report.diverged += 1;
    const hard = check.kinds.filter((kind) => HARD_DIVERGENCE_KINDS.includes(kind));
    const discoveryHard = hard.filter((kind) => DISCOVERY_DIVERGENCE_KINDS.includes(kind));
    let breakersOpened = 0;
    if (hard.length > 0) {
      if (await openMineBreaker(env, CLAIMS_SCOPE, row.mint, hard)) {
        breakersOpened += 1;
        report.breakersOpened += 1;
      }
    }
    // A short or over-full Discovery Vault is a discovery payout problem, so it halts the discovery
    // payout path for that mine as well as claims (spec 57, 65, 78).
    if (discoveryHard.length > 0) {
      if (await openMineBreaker(env, DISCOVERY_RESERVE_SCOPE, row.mint, discoveryHard)) {
        breakersOpened += 1;
        report.breakersOpened += 1;
      }
    }
    if (report.divergences.length < RECONCILE_REPORT_LIMIT) {
      report.divergences.push({
        mint: row.mint,
        status: "DIVERGED",
        kinds: check.kinds,
        detail: describeCheck(check),
      });
    }
    for (const kind of check.kinds) {
      await metric(env, "reconcile.divergence", 1, {
        mint: row.mint,
        kind,
        hard: hard.includes(kind) ? "true" : "false",
      });
    }
    console.error(
      JSON.stringify({
        event: "reconcile.divergence",
        mint: row.mint,
        kinds: check.kinds,
        hard,
        breakersOpened,
        detail: describeCheck(check),
      }),
    );
    await recordRun(env, check, breakersOpened > 0, now);
  }

  await metric(env, "reconcile.runs", report.checked, {});
  return report;
}
