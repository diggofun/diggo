/**
 * Reserve-reconciliation regression tests (spec 57, 66, 78).
 *
 * These run the real migrations against an in-memory SQLite database and drive the job with a
 * crafted chain reader, so every comparison - and the consequence attached to each one - is
 * exercised without touching an RPC.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { breakerId } from "../breakers";
import {
  DIVERGENCE_KINDS,
  RECONCILE_ACTOR,
  compareMine,
  reconcileTolerance,
  reconcileReserves,
  wholeTokensToRaw,
  type MineChainReader,
  type MineChainSnapshot,
} from "../reconcile";
import { createTestHarness, type TestHarness } from "./d1-sqlite";

/** Six decimals, the default a mine's tokens row carries, so 1 whole token is 1e6 raw units. */
const DECIMALS = 6;
const RAW_PER_TOKEN = 10n ** BigInt(DECIMALS);
const MINT_A = "4rT8mQ2vN6kY3cW9pF1sJ7aB5eH8uL2xG6zP9diggo";
const MINT_B = "9xK2hM7qT4vB8nP6sR3wY5cF1aG7uJ2eL8mN4diggo";
const START = 1_800_000_000;

function raw(tokens: number): bigint {
  return BigInt(tokens) * RAW_PER_TOKEN;
}

let h: TestHarness;

beforeEach(() => {
  h = createTestHarness();
});

afterEach(() => {
  h.d1.close();
});

/** A mine's indexed D1 state, in whole tokens exactly as the accounting stores it. */
function seedMineState(options: {
  mint: string;
  remainingTokens: number;
  initialTokens: number;
  authority?: "OFFCHAIN" | "ONCHAIN_INDEXED";
  decimals?: number;
  updatedAt?: number;
}): void {
  h.db
    .prepare(
      "INSERT INTO tokens (mint, slug, name, symbol, description, creator, status, reserve_remaining," +
        " reserve_total, reward_per_block, next_block_at, next_epoch_at, decimals)" +
        " VALUES (?1, ?2, ?3, 'TEST', '', 'creator', 'MINING_ACTIVE', ?4, ?5, 1000, 0, 0, ?6)",
    )
    .run(
      options.mint,
      "slug-" + options.mint,
      options.mint,
      options.remainingTokens,
      options.initialTokens,
      options.decimals ?? DECIMALS,
    );
  h.db
    .prepare(
      "INSERT INTO mine_reward_state (mint, remaining_reserve, initial_reserve, authority, updated_at)" +
        " VALUES (?1, ?2, ?3, ?4, ?5)",
    )
    .run(
      options.mint,
      String(options.remainingTokens),
      String(options.initialTokens),
      options.authority ?? "ONCHAIN_INDEXED",
      options.updatedAt ?? START,
    );
}

/** One paid reward claim: the record the reconciliation compares against the chain. */
function seedPaidClaim(options: {
  id: string;
  mint: string;
  amountTokens: number;
  paidAmountRaw: bigint | null;
  signature?: string;
}): void {
  h.db
    .prepare(
      "INSERT INTO reward_claims (id, wallet, mint, amount, status, created_at, eligible_until," +
        " claimed_at, tx_signature, paid_amount)" +
        " VALUES (?1, 'wallet1', ?2, ?3, 'CLAIMED', ?4, ?5, ?4, ?6, ?7)",
    )
    .run(
      options.id,
      options.mint,
      String(options.amountTokens),
      START,
      START + 86_400,
      options.signature ?? "sig-" + options.id,
      options.paidAmountRaw === null ? null : options.paidAmountRaw.toString(),
    );
}

function snapshot(mint: string, overrides: Partial<MineChainSnapshot> = {}): MineChainSnapshot {
  const remainingReserve = overrides.remainingReserve ?? raw(1_000);
  const cumulativeDistributed = overrides.cumulativeDistributed ?? 0n;
  return {
    mint,
    mineAddress: "mine-" + mint,
    reserveVault: "vault-" + mint,
    discoveryVault: "discovery-" + mint,
    remainingReserve,
    cumulativeDistributed,
    discoveryReserveTotal: raw(100),
    remainingDiscoveryReserve: raw(100),
    reserveVaultBalance: overrides.reserveVaultBalance ?? remainingReserve + cumulativeDistributed,
    discoveryVaultBalance: overrides.discoveryVaultBalance ?? raw(100),
    ...overrides,
  };
}

function readerOf(snapshots: Record<string, MineChainSnapshot | Error>): MineChainReader {
  return {
    async readMine(mint: string): Promise<MineChainSnapshot> {
      const value = snapshots[mint];
      if (value === undefined) throw new Error("no chain snapshot for " + mint);
      if (value instanceof Error) throw value;
      return value;
    },
  };
}

function breakerRow(mint: string): { open: number; actor: string | null; reason: string | null } | null {
  const row = h.db
    .prepare("SELECT open, actor, reason FROM circuit_breakers WHERE id = ?1")
    .get(breakerId("claims", mint)) as { open: number; actor: string | null; reason: string | null } | undefined;
  return row ?? null;
}

/** The breaker the discovery payout path consults for one mine. */
function discoveryBreakerRow(
  mint: string,
): { open: number; actor: string | null; reason: string | null } | null {
  const row = h.db
    .prepare("SELECT open, actor, reason FROM circuit_breakers WHERE id = ?1")
    .get(breakerId("discovery_reserve", mint)) as
    | { open: number; actor: string | null; reason: string | null }
    | undefined;
  return row ?? null;
}

function runs(mint?: string): Record<string, unknown>[] {
  return mint === undefined
    ? (h.db.prepare("SELECT * FROM reconciliation_runs ORDER BY checked_at ASC").all() as Record<string, unknown>[])
    : (h.db
        .prepare("SELECT * FROM reconciliation_runs WHERE mint = ?1 ORDER BY checked_at ASC")
        .all(mint) as Record<string, unknown>[]);
}

describe("whole-token to raw conversion and tolerance", () => {
  it("converts the D1 whole-token figures through the mint's decimals", () => {
    expect(wholeTokensToRaw(1_000, 6)).toBe(1_000_000_000n);
    expect(wholeTokensToRaw(12.5, 6)).toBe(12_500_000n);
    expect(wholeTokensToRaw(7, 0)).toBe(7n);
    expect(wholeTokensToRaw(Number.NaN, 6)).toBe(0n);
  });

  it("scales with the reserve and never falls below the absolute floor", () => {
    expect(reconcileTolerance(raw(1_000))).toBe((raw(1_000) * 25n) / 10_000n);
    expect(reconcileTolerance(0n)).toBe(1_000n);
  });
});

describe("mine comparison", () => {
  const row = {
    mint: MINT_A,
    remaining_reserve: "900",
    initial_reserve: "1000",
    authority: "ONCHAIN_INDEXED",
    decimals: DECIMALS,
    last_checked_at: null,
  };

  it("accepts a mine whose vault, program accounting and ledger all agree", () => {
    const check = compareMine({
      row,
      chain: snapshot(MINT_A, {
        remainingReserve: raw(900),
        cumulativeDistributed: raw(100),
        reserveVaultBalance: raw(1_000),
      }),
      d1: { remaining: raw(900), initial: raw(1_000), paid: 0n, claimCount: 0 },
    });
    expect(check.status).toBe("OK");
    expect(check.kinds).toEqual([]);
    expect(check.paidClaimsDrift).toBe(0n);
    // Everything credited so far is still in the vault, so nothing has actually been paid out.
    expect(check.unclaimedInVault).toBe(raw(100));
  });

  it("reports a payout the ledger never recorded", () => {
    const check = compareMine({
      row,
      chain: snapshot(MINT_A, {
        remainingReserve: raw(900),
        cumulativeDistributed: raw(100),
        reserveVaultBalance: raw(950),
      }),
      d1: { remaining: raw(900), initial: raw(1_000), paid: 0n, claimCount: 0 },
    });
    expect(check.kinds).toEqual([DIVERGENCE_KINDS.unrecordedPayout]);
    expect(check.paidClaimsDrift).toBe(-raw(50));
  });

  it("reports a payout the chain never made", () => {
    const check = compareMine({
      row,
      chain: snapshot(MINT_A, {
        remainingReserve: raw(900),
        cumulativeDistributed: raw(100),
        reserveVaultBalance: raw(1_000),
      }),
      d1: { remaining: raw(900), initial: raw(1_000), paid: raw(50), claimCount: 1 },
    });
    expect(check.kinds).toEqual([DIVERGENCE_KINDS.phantomPayout]);
  });

  it("reports a vault that cannot cover what the program still owes", () => {
    const check = compareMine({
      row,
      chain: snapshot(MINT_A, {
        remainingReserve: raw(900),
        cumulativeDistributed: raw(100),
        reserveVaultBalance: raw(500),
      }),
      d1: { remaining: raw(900), initial: raw(1_000), paid: raw(100), claimCount: 1 },
    });
    expect(check.kinds).toContain(DIVERGENCE_KINDS.vaultShortfall);
  });

  it("reports a vault holding more than the program ever put there", () => {
    const check = compareMine({
      row,
      chain: snapshot(MINT_A, {
        remainingReserve: raw(900),
        cumulativeDistributed: raw(100),
        reserveVaultBalance: raw(2_000),
      }),
      d1: { remaining: raw(900), initial: raw(1_000), paid: raw(100), claimCount: 1 },
    });
    expect(check.kinds).toContain(DIVERGENCE_KINDS.vaultExcess);
  });

  it("reports the discovery reserve as well as the mining reserve", () => {
    const check = compareMine({
      row,
      chain: snapshot(MINT_A, { discoveryVaultBalance: raw(10) }),
      d1: { remaining: raw(1_000), initial: raw(1_000), paid: 0n, claimCount: 0 },
    });
    expect(check.kinds).toContain(DIVERGENCE_KINDS.discoveryVaultShortfall);
  });

  it("treats an off-chain-indexed mine's reserve gap as a recorded difference, not a fault", () => {
    const check = compareMine({
      row: { ...row, authority: "OFFCHAIN" },
      chain: snapshot(MINT_A, { remainingReserve: raw(1_000) }),
      d1: { remaining: raw(500), initial: raw(1_000), paid: 0n, claimCount: 0 },
    });
    expect(check.kinds).toContain(DIVERGENCE_KINDS.unindexedReserveDrift);
    expect(check.kinds).not.toContain(DIVERGENCE_KINDS.indexedReserveDrift);
  });
});

describe("reconciliation pass", () => {
  it("records an agreeing mine and opens nothing", async () => {
    seedMineState({ mint: MINT_A, remainingTokens: 1_000, initialTokens: 1_000 });

    const report = await reconcileReserves(h.env, {
      reader: readerOf({ [MINT_A]: snapshot(MINT_A) }),
      now: START,
    });

    expect(report).toMatchObject({ checked: 1, ok: 1, diverged: 0, unreadable: 0, breakersOpened: 0 });
    expect(report.divergences).toEqual([]);
    const rows = runs(MINT_A);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("OK");
    expect(rows[0].onchain_remaining_reserve).toBe(raw(1_000).toString());
    expect(rows[0].d1_remaining_reserve).toBe(raw(1_000).toString());
    expect(rows[0].breaker_opened).toBe(0);
    expect(breakerRow(MINT_A)).toBeNull();
  });

  it("opens the mint-scoped claims breaker when a reserve has diverged", async () => {
    seedMineState({ mint: MINT_A, remainingTokens: 900, initialTokens: 1_000 });

    const report = await reconcileReserves(h.env, {
      reader: readerOf({ [MINT_A]: snapshot(MINT_A, { remainingReserve: raw(1_000) }) }),
      now: START,
    });

    expect(report).toMatchObject({ diverged: 1, breakersOpened: 1 });
    expect(report.divergences[0]).toMatchObject({ mint: MINT_A, status: "DIVERGED" });
    const breaker = breakerRow(MINT_A);
    expect(breaker?.open).toBe(1);
    expect(breaker?.actor).toBe(RECONCILE_ACTOR);
    expect(breaker?.reason).toContain(DIVERGENCE_KINDS.indexedReserveDrift);

    const rows = runs(MINT_A);
    expect(rows[0].status).toBe("DIVERGED");
    expect(rows[0].divergence_kinds).toBe(DIVERGENCE_KINDS.indexedReserveDrift);
    expect(rows[0].breaker_opened).toBe(1);
    // The breaker is auditable: opening it is appended, like every other breaker change.
    const audit = h.db.prepare("SELECT scope, mint, open, actor FROM breaker_audit").all() as {
      scope: string;
      mint: string;
      open: number;
      actor: string;
    }[];
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ scope: "claims", mint: MINT_A, open: 1, actor: RECONCILE_ACTOR });
    // And it is counted, so an operator watching telemetry sees it without reading the table.
    const counter = h.db
      .prepare("SELECT SUM(value) AS value FROM metrics_counters WHERE name = 'reconcile.divergence'")
      .get() as { value: number };
    expect(Number(counter.value)).toBe(1);
  });

  it("catches a real payout that was never recorded in the ledger", async () => {
    seedMineState({ mint: MINT_A, remainingTokens: 900, initialTokens: 1_000 });

    const report = await reconcileReserves(h.env, {
      reader: readerOf({
        [MINT_A]: snapshot(MINT_A, {
          remainingReserve: raw(900),
          cumulativeDistributed: raw(100),
          reserveVaultBalance: raw(950),
        }),
      }),
      now: START,
    });

    expect(report.divergences[0].kinds).toContain(DIVERGENCE_KINDS.unrecordedPayout);
    expect(breakerRow(MINT_A)?.open).toBe(1);
  });

  it("accepts a recorded payout the chain agrees with", async () => {
    seedMineState({ mint: MINT_A, remainingTokens: 900, initialTokens: 1_000 });
    seedPaidClaim({ id: "claim:paid", mint: MINT_A, amountTokens: 50, paidAmountRaw: raw(50) });

    const report = await reconcileReserves(h.env, {
      reader: readerOf({
        [MINT_A]: snapshot(MINT_A, {
          remainingReserve: raw(900),
          cumulativeDistributed: raw(100),
          reserveVaultBalance: raw(950),
        }),
      }),
      now: START,
    });

    expect(report).toMatchObject({ ok: 1, diverged: 0, breakersOpened: 0 });
    expect(runs(MINT_A)[0].d1_paid_claims).toBe(raw(50).toString());
    expect(runs(MINT_A)[0].d1_claim_count).toBe(1);
  });

  it("falls back to the settled whole-token amount for a claim with no measured payout", async () => {
    seedMineState({ mint: MINT_A, remainingTokens: 900, initialTokens: 1_000 });
    // A claim the confirmation endpoint never saw: only the settled figure exists.
    seedPaidClaim({ id: "claim:legacy", mint: MINT_A, amountTokens: 50, paidAmountRaw: null });

    const report = await reconcileReserves(h.env, {
      reader: readerOf({
        [MINT_A]: snapshot(MINT_A, {
          remainingReserve: raw(900),
          cumulativeDistributed: raw(100),
          reserveVaultBalance: raw(950),
        }),
      }),
      now: START,
    });

    expect(report.ok).toBe(1);
    expect(runs(MINT_A)[0].d1_paid_claims).toBe(raw(50).toString());
  });

  it("records an unreadable mine without halting anything", async () => {
    seedMineState({ mint: MINT_A, remainingTokens: 1_000, initialTokens: 1_000 });

    const report = await reconcileReserves(h.env, {
      reader: readerOf({ [MINT_A]: new Error("rpc unavailable") }),
      now: START,
    });

    expect(report).toMatchObject({ checked: 1, ok: 0, diverged: 0, unreadable: 1, breakersOpened: 0 });
    expect(report.divergences[0]).toMatchObject({ mint: MINT_A, status: "UNREADABLE" });
    const rows = runs(MINT_A);
    expect(rows[0].status).toBe("UNREADABLE");
    expect(String(rows[0].detail)).toContain("rpc unavailable");
    // An unreadable mine must never become a halt: there is no evidence behind it.
    expect(breakerRow(MINT_A)).toBeNull();
  });

  it("keeps going after one mine cannot be read", async () => {
    seedMineState({ mint: MINT_A, remainingTokens: 1_000, initialTokens: 1_000 });
    seedMineState({ mint: MINT_B, remainingTokens: 1_000, initialTokens: 1_000 });

    const report = await reconcileReserves(h.env, {
      reader: readerOf({ [MINT_A]: new Error("rpc unavailable"), [MINT_B]: snapshot(MINT_B) }),
      now: START,
    });

    expect(report).toMatchObject({ checked: 2, ok: 1, unreadable: 1 });
  });

  it("closes the breaker a previous run opened, and only that one", async () => {
    seedMineState({ mint: MINT_A, remainingTokens: 1_000, initialTokens: 1_000 });
    seedMineState({ mint: MINT_B, remainingTokens: 1_000, initialTokens: 1_000 });
    h.db
      .prepare(
        "INSERT INTO circuit_breakers (id, scope, mint, open, reason, actor, updated_at)" +
          " VALUES (?1, 'claims', ?2, 1, 'reserve_divergence', ?3, ?4)",
      )
      .run(breakerId("claims", MINT_A), MINT_A, RECONCILE_ACTOR, START - 60);
    // A hold an operator placed by hand must survive the cron.
    h.db
      .prepare(
        "INSERT INTO circuit_breakers (id, scope, mint, open, reason, actor, updated_at)" +
          " VALUES (?1, 'claims', ?2, 1, 'manual review', 'ops', ?3)",
      )
      .run(breakerId("claims", MINT_B), MINT_B, START - 60);

    const report = await reconcileReserves(h.env, {
      reader: readerOf({ [MINT_A]: snapshot(MINT_A), [MINT_B]: snapshot(MINT_B) }),
      now: START,
    });

    expect(report).toMatchObject({ ok: 2, breakersClosed: 1 });
    expect(breakerRow(MINT_A)?.open).toBe(0);
    expect(breakerRow(MINT_B)?.open).toBe(1);
    expect(breakerRow(MINT_B)?.actor).toBe("ops");
  });

  it("does not open the same breaker twice for a mine that stays diverged", async () => {
    seedMineState({ mint: MINT_A, remainingTokens: 900, initialTokens: 1_000 });
    const chain = readerOf({ [MINT_A]: snapshot(MINT_A, { remainingReserve: raw(1_000) }) });

    const first = await reconcileReserves(h.env, { reader: chain, now: START });
    const second = await reconcileReserves(h.env, { reader: chain, now: START + 60 });

    expect(first.breakersOpened).toBe(1);
    expect(second.breakersOpened).toBe(0);
    expect(breakerRow(MINT_A)?.open).toBe(1);
    const audit = h.db.prepare("SELECT COUNT(*) AS n FROM breaker_audit").get() as { n: number };
    expect(Number(audit.n)).toBe(1);
  });

  it("halts the discovery payout path of a mine whose Discovery Vault diverged", async () => {
    seedMineState({ mint: MINT_A, remainingTokens: 1_000, initialTokens: 1_000 });

    const report = await reconcileReserves(h.env, {
      reader: readerOf({ [MINT_A]: snapshot(MINT_A, { discoveryVaultBalance: raw(50) }) }),
      now: START,
    });

    expect(report.divergences[0]).toMatchObject({ mint: MINT_A, status: "DIVERGED" });
    expect(report.divergences[0].kinds).toEqual([DIVERGENCE_KINDS.discoveryVaultShortfall]);
    // The claims breaker stops the mining claim path, which is not what pays a discovery out of the
    // Discovery Vault, so the mint-scoped discovery_reserve breaker has to be opened as well.
    expect(report.breakersOpened).toBe(2);
    expect(breakerRow(MINT_A)?.open).toBe(1);
    expect(discoveryBreakerRow(MINT_A)?.open).toBe(1);
    expect(discoveryBreakerRow(MINT_A)?.actor).toBe(RECONCILE_ACTOR);
    expect(String(discoveryBreakerRow(MINT_A)?.reason)).toContain(
      DIVERGENCE_KINDS.discoveryVaultShortfall,
    );
  });

  it("leaves the discovery breaker alone for a divergence that is not about that vault", async () => {
    seedMineState({ mint: MINT_A, remainingTokens: 900, initialTokens: 1_000 });

    const report = await reconcileReserves(h.env, {
      reader: readerOf({ [MINT_A]: snapshot(MINT_A, { remainingReserve: raw(1_000) }) }),
      now: START,
    });

    expect(report.divergences[0].kinds).not.toContain(DIVERGENCE_KINDS.discoveryVaultShortfall);
    expect(breakerRow(MINT_A)?.open).toBe(1);
    expect(discoveryBreakerRow(MINT_A)).toBeNull();
  });

  it("closes the discovery breaker once the vault reconciles again", async () => {
    seedMineState({ mint: MINT_A, remainingTokens: 1_000, initialTokens: 1_000 });
    await reconcileReserves(h.env, {
      reader: readerOf({ [MINT_A]: snapshot(MINT_A, { discoveryVaultBalance: raw(50) }) }),
      now: START,
    });
    expect(discoveryBreakerRow(MINT_A)?.open).toBe(1);

    const healed = await reconcileReserves(h.env, {
      reader: readerOf({ [MINT_A]: snapshot(MINT_A) }),
      now: START + 60,
    });

    // Both breakers this job opened are closed again: claims and discovery_reserve.
    expect(healed).toMatchObject({ ok: 1, diverged: 0, breakersClosed: 2 });
    expect(breakerRow(MINT_A)?.open).toBe(0);
    expect(discoveryBreakerRow(MINT_A)?.open).toBe(0);
  });

  it("checks the least recently reconciled mines first, and only as many as it is allowed to", async () => {
    seedMineState({ mint: MINT_A, remainingTokens: 1_000, initialTokens: 1_000, updatedAt: START + 100 });
    seedMineState({ mint: MINT_B, remainingTokens: 1_000, initialTokens: 1_000, updatedAt: START });
    h.db
      .prepare(
        "INSERT INTO reconciliation_runs (id, mint, authority, checked_at, status)" +
          " VALUES ('run-a', ?1, 'ONCHAIN_INDEXED', ?2, 'OK')",
      )
      .run(MINT_A, START);

    const report = await reconcileReserves(h.env, {
      reader: readerOf({ [MINT_A]: snapshot(MINT_A), [MINT_B]: snapshot(MINT_B) }),
      now: START + 200,
      limit: 1,
    });

    expect(report.checked).toBe(1);
    expect(report.divergences).toEqual([]);
    // MINT_A was already checked, so this run had to spend its single slot on MINT_B.
    expect(runs(MINT_B)).toHaveLength(1);
    expect(runs(MINT_A)).toHaveLength(1);
  });

  it("checks nothing when no mine has indexed state yet", async () => {
    const report = await reconcileReserves(h.env, { reader: readerOf({}), now: START });
    expect(report).toMatchObject({ checked: 0, ok: 0, diverged: 0, unreadable: 0 });
  });
});
