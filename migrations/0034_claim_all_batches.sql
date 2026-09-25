-- One signed transaction can carry many idempotent ATA creations and SPL transfers, so a whole
-- accrued balance is settled in a single player signature. The batch row is the durable envelope:
-- it owns the exact partial wire transaction the vault signed, so a retry hands back identical
-- bytes instead of a second signature over a different set of transfers.
CREATE TABLE IF NOT EXISTS meteora_claim_batches (
  id TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('SENT', 'SETTLED', 'FAILED')),
  -- The claim ids this batch pays, in transfer order. JSON keeps the on-chain order that the
  -- confirmation check re-derives from the transaction itself.
  items TEXT NOT NULL,
  prepared_transaction TEXT,
  prepared_expires_at INTEGER,
  -- The actual Solana last-valid block height from the prepared message. A local wall-clock
  -- expiry is never sufficient authority to release a reservation or rebuild a payout.
  prepared_last_valid_block_height INTEGER,
  -- Slot at which the durable reconciliation search starts. A replacement is never made until
  -- address history has been walked back before this point.
  prepared_slot INTEGER,
  -- Whether this row owns a daily-cap reservation. Reservation and this flag change in one D1 batch.
  cap_reserved INTEGER NOT NULL DEFAULT 0 CHECK (cap_reserved IN (0, 1)),
  -- Stable successor pointer: expired rows are audited, never deleted, and retries follow this row.
  replacement_id TEXT,
  signature TEXT,
  error TEXT,
  day_index INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_meteora_claim_batches_wallet
  ON meteora_claim_batches (wallet, status, created_at DESC);

-- A batch that is SENT but past its blockhash must not shadow the next attempt.
CREATE INDEX IF NOT EXISTS idx_meteora_claim_batches_live
  ON meteora_claim_batches (wallet, prepared_expires_at, prepared_last_valid_block_height);
