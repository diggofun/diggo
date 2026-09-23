-- Reconciliation (spec 57, 66, 78): the ledger the reserve-divergence cron writes, the amount a
-- confirmed user-signed claim actually paid, and the database-level replay guard on payout
-- signatures.
--
-- Why these three belong together: a mining reward leaves the program's Mining Reserve only
-- through the player's own claim_rewards transaction (docs/SECURITY.md invariant 7), so the
-- backend's job is to *record* that transaction honestly. The UNIQUE index below makes "one
-- signature can back exactly one reward" a storage guarantee rather than a convention, and
-- reconciliation_runs is what catches the case where D1's picture and the chain's have drifted
-- apart (a payout that was never recorded, or a reserve that moved without one).

PRAGMA foreign_keys = ON;

-- The token amount a confirmed claim actually moved, as measured from the transaction's own token
-- balances (never from a client's claim about it), in RAW base units exactly as the chain reports
-- them. reward_claims.amount is the settled whole-token figure, so the two are compared through
-- the mint's decimals rather than directly. NULL for a claim whose payout was never confirmed,
-- which is also exactly what tx_signature IS NULL means.
ALTER TABLE reward_claims ADD COLUMN paid_amount TEXT;

-- One payout signature backs exactly one reward claim. Partial, because every un-paid claim
-- legitimately has no signature; the guard is that no two rows can carry the same one, so
-- replaying a real claim_rewards signature against a second reward is rejected by storage even
-- if every application-level check were bypassed.
CREATE UNIQUE INDEX IF NOT EXISTS idx_reward_claims_tx_signature
  ON reward_claims(tx_signature) WHERE tx_signature IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_reward_claims_paid ON reward_claims(mint, claimed_at) WHERE tx_signature IS NOT NULL;

-- One row per mine checked by the reconciliation cron. Every numeric field is TEXT to match the
-- rest of the token accounting (u64 amounts do not fit an IEEE double), and the on-chain value is
-- stored beside the D1 value rather than only their difference, so an operator can see which side
-- moved without re-deriving anything.
--
-- Units: every reserve/balance/tolerance column is in RAW base units. The D1 whole-token figures
-- (mine_reward_state.remaining_reserve, reward_claims.amount) are converted through the mint's
-- decimals before they are written here, so a row never mixes two units.
CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id TEXT PRIMARY KEY,
  mint TEXT NOT NULL,
  -- 'ONCHAIN_INDEXED' or 'OFFCHAIN': which side this mine's D1 accounting claims to be.
  authority TEXT NOT NULL DEFAULT 'OFFCHAIN',
  checked_at INTEGER NOT NULL,
  -- The program's own Mine account.
  onchain_remaining_reserve TEXT NOT NULL DEFAULT '0',
  onchain_cumulative_distributed TEXT NOT NULL DEFAULT '0',
  onchain_initial_reserve TEXT NOT NULL DEFAULT '0',
  -- The SPL token account the program controls for that mine.
  reserve_vault_balance TEXT NOT NULL DEFAULT '0',
  discovery_vault_balance TEXT NOT NULL DEFAULT '0',
  -- The D1 side.
  d1_remaining_reserve TEXT NOT NULL DEFAULT '0',
  d1_initial_reserve TEXT NOT NULL DEFAULT '0',
  d1_paid_claims TEXT NOT NULL DEFAULT '0',
  d1_claim_count INTEGER NOT NULL DEFAULT 0,
  -- Derived comparisons, so a divergence is readable from the row alone.
  reserve_drift TEXT NOT NULL DEFAULT '0',
  paid_claims_drift TEXT NOT NULL DEFAULT '0',
  initial_reserve_drift TEXT NOT NULL DEFAULT '0',
  unclaimed_in_vault TEXT NOT NULL DEFAULT '0',
  tolerance TEXT NOT NULL DEFAULT '0',
  -- 'OK' | 'DIVERGED' | 'UNREADABLE'
  status TEXT NOT NULL CHECK (status IN ('OK', 'DIVERGED', 'UNREADABLE')),
  -- Which comparisons failed: a comma-separated list of stable kind names.
  divergence_kinds TEXT NOT NULL DEFAULT '',
  breaker_opened INTEGER NOT NULL DEFAULT 0,
  detail TEXT
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_runs_checked ON reconciliation_runs(checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_reconciliation_runs_mint ON reconciliation_runs(mint, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_reconciliation_runs_status ON reconciliation_runs(status, checked_at DESC);
