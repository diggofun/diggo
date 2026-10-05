-- Boosts (worker/boosts.ts, shared/boost.ts): SOL paid to push a mine up for a while.
--
-- One row per payment, keyed by its transaction so a payment is used once. A mine is boosted while
-- any of its rows has ends_at in the future; buying again extends from the current end.

CREATE TABLE IF NOT EXISTS mine_boosts (
  signature TEXT PRIMARY KEY NOT NULL,
  mint TEXT NOT NULL,
  wallet TEXT NOT NULL,
  tier TEXT NOT NULL,
  lamports TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL CHECK (ends_at > starts_at),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS mine_boosts_mint ON mine_boosts (mint, ends_at);
