-- Off-chain mining accounting: per-mine cumulative reward index, per-wallet mining positions,
-- materialized reward claims and the collected Mining Reports (spec 17, 29, 53, 57, 76, 78).
--
-- Solana stays the authority for a real token balance; these tables are the indexed view of the
-- same accounting. For a mine whose on-chain program is authoritative the numbers here are the
-- indexed/estimated view (mine_reward_state.authority = 'ONCHAIN_INDEXED'); otherwise they are
-- the accounting source for the Mining Report ('OFFCHAIN').
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS mine_reward_state (
  mint TEXT PRIMARY KEY,
  -- Cumulative reward per unit of eligible power, scaled by DIGGO_CONFIG.economy.rewardIndexScale.
  reward_index TEXT NOT NULL DEFAULT '0',
  -- Unix seconds of the last credited block; 0 means "no block credited yet".
  last_block INTEGER NOT NULL DEFAULT 0,
  remaining_reserve TEXT NOT NULL DEFAULT '0',
  initial_reserve TEXT NOT NULL DEFAULT '0',
  epoch INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'MINING_ACTIVE' CHECK (status IN ('MINING_ACTIVE', 'FULLY_MINED', 'PAUSED')),
  total_eligible_power TEXT NOT NULL DEFAULT '0',
  reward_per_block TEXT NOT NULL DEFAULT '0',
  committed TEXT NOT NULL DEFAULT '0',
  dust_scaled TEXT NOT NULL DEFAULT '0',
  block_interval INTEGER NOT NULL DEFAULT 300,
  epoch_length INTEGER NOT NULL DEFAULT 604800,
  epoch_ends_at INTEGER NOT NULL DEFAULT 0,
  authority TEXT NOT NULL DEFAULT 'OFFCHAIN' CHECK (authority IN ('OFFCHAIN', 'ONCHAIN_INDEXED')),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS mining_positions (
  wallet TEXT NOT NULL,
  mint TEXT NOT NULL,
  assigned_power TEXT NOT NULL DEFAULT '0',
  last_reward_index TEXT NOT NULL DEFAULT '0',
  pending_reward TEXT NOT NULL DEFAULT '0',
  paused INTEGER NOT NULL DEFAULT 0,
  activated_at INTEGER,
  active_until INTEGER,
  -- Monotonic per-position counter: the settlement sequence a materialized claim was built from.
  claim_seq INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (wallet, mint)
);

CREATE INDEX IF NOT EXISTS idx_mining_positions_expiry ON mining_positions(mint, active_until);
CREATE INDEX IF NOT EXISTS idx_mining_positions_wallet ON mining_positions(wallet, updated_at DESC);

CREATE TABLE IF NOT EXISTS reward_claims (
  id TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  mint TEXT NOT NULL,
  amount TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ELIGIBLE' CHECK (status IN ('PENDING', 'ELIGIBLE', 'CLAIMED', 'EXPIRED', 'HELD')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  eligible_until INTEGER NOT NULL,
  claimed_at INTEGER,
  -- The single-use challenge nonce that consumed this claim; UNIQUE is the database-level
  -- replay guard behind the conditional UPDATE in worker/mining.ts.
  claim_nonce TEXT,
  settlement_seq INTEGER NOT NULL DEFAULT 0,
  authority TEXT NOT NULL DEFAULT 'OFFCHAIN' CHECK (authority IN ('OFFCHAIN', 'ONCHAIN_INDEXED')),
  tx_signature TEXT,
  UNIQUE (wallet, mint, settlement_seq),
  UNIQUE (claim_nonce)
);

CREATE INDEX IF NOT EXISTS idx_reward_claims_wallet ON reward_claims(wallet, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reward_claims_status ON reward_claims(status, eligible_until);

-- One row per collected Mining Report; the primary key makes "COLLECT" idempotent.
CREATE TABLE IF NOT EXISTS mining_reports (
  id TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  mint TEXT,
  active_seconds INTEGER NOT NULL DEFAULT 0,
  ore_gained INTEGER NOT NULL DEFAULT 0,
  ore_overflow INTEGER NOT NULL DEFAULT 0,
  streak INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_mining_reports_wallet ON mining_reports(wallet, created_at DESC);

-- Streak bookkeeping the spec's data model asks for (spec 76): longest streak, grace deadline,
-- account progression granted by streak milestones, and the ORE overflow that did not fit storage.
ALTER TABLE players ADD COLUMN activated_at INTEGER;
ALTER TABLE players ADD COLUMN streak_grace_until INTEGER;
ALTER TABLE players ADD COLUMN longest_streak INTEGER NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN xp INTEGER NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN badges TEXT NOT NULL DEFAULT '[]';
ALTER TABLE players ADD COLUMN titles TEXT NOT NULL DEFAULT '[]';
ALTER TABLE players ADD COLUMN ore_overflow INTEGER NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN last_report_at INTEGER;
