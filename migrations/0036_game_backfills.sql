-- Ledger of one-off game-state corrections, one row per (backfill, wallet) or (backfill, mine).
-- Backfill SQL is guarded on these markers so every correction applies at most once, and the
-- rows double as the audit record of what each wallet was credited and why.
CREATE TABLE IF NOT EXISTS game_backfills (
  id TEXT PRIMARY KEY,
  wallet TEXT,
  mint TEXT,
  ore_amount INTEGER NOT NULL DEFAULT 0,
  token_amount TEXT NOT NULL DEFAULT '0',
  detail TEXT,
  applied_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_game_backfills_wallet ON game_backfills (wallet);
