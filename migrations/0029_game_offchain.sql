-- Temporary Meteora-mode game authority. Every table is additive and prefixed game_*.
-- Token amounts are 9-decimal SPL base units stored as TEXT so D1 never rounds them to a JS number.

CREATE TABLE IF NOT EXISTS game_players (
  wallet TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  ore_balance TEXT NOT NULL DEFAULT '0',
  ore_earned TEXT NOT NULL DEFAULT '0',
  streak INTEGER NOT NULL DEFAULT 0,
  longest_streak INTEGER NOT NULL DEFAULT 0,
  streak_freezes INTEGER NOT NULL DEFAULT 0,
  active_until INTEGER NOT NULL DEFAULT 0,
  last_activation_at INTEGER NOT NULL DEFAULT 0,
  activated_at INTEGER NOT NULL DEFAULT 0,
  last_ore_at INTEGER NOT NULL DEFAULT 0,
  active_mine TEXT,
  active_mining_power TEXT NOT NULL DEFAULT '0',
  active_days INTEGER NOT NULL DEFAULT 0,
  valid_activations INTEGER NOT NULL DEFAULT 0,
  miners_level INTEGER NOT NULL DEFAULT 1,
  drills_level INTEGER NOT NULL DEFAULT 1,
  carts_level INTEGER NOT NULL DEFAULT 1,
  foreman_level INTEGER NOT NULL DEFAULT 1,
  storage_level INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS game_mines (
  mint TEXT PRIMARY KEY,
  mining_starts_at INTEGER NOT NULL,
  initial_reserve TEXT NOT NULL,
  released TEXT NOT NULL DEFAULT '0',
  remaining TEXT NOT NULL,
  committed TEXT NOT NULL DEFAULT '0',
  paid TEXT NOT NULL DEFAULT '0',
  total_eligible_power INTEGER NOT NULL DEFAULT 0,
  last_discovery_id TEXT,
  graduated INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  CHECK (initial_reserve = '200000000000000000'),
  CHECK (CAST(released AS INTEGER) >= 0),
  CHECK (CAST(remaining AS INTEGER) >= 0),
  CHECK (CAST(committed AS INTEGER) >= 0 AND CAST(committed AS INTEGER) <= CAST(released AS INTEGER)),
  CHECK (CAST(paid AS INTEGER) >= 0 AND CAST(paid AS INTEGER) <= CAST(committed AS INTEGER)),
  CHECK (CAST(remaining AS INTEGER) = CAST(initial_reserve AS INTEGER) - CAST(committed AS INTEGER))
);

CREATE TABLE IF NOT EXISTS game_balances (
  wallet TEXT NOT NULL,
  mint TEXT NOT NULL,
  claimable TEXT NOT NULL DEFAULT '0',
  last_settled_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (wallet, mint)
);
CREATE INDEX IF NOT EXISTS idx_game_balances_mint ON game_balances (mint, wallet);

CREATE TABLE IF NOT EXISTS game_claims (
  id TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  mint TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('MINING', 'DISCOVERY')),
  amount TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'PAID')),
  idempotency_key TEXT NOT NULL UNIQUE,
  signature TEXT,
  created_at INTEGER NOT NULL,
  paid_at INTEGER,
  failure TEXT
);
CREATE INDEX IF NOT EXISTS idx_game_claims_pending ON game_claims (status, created_at);
CREATE INDEX IF NOT EXISTS idx_game_claims_wallet ON game_claims (wallet, created_at DESC);

CREATE TABLE IF NOT EXISTS game_referral_credits (
  id TEXT PRIMARY KEY,
  referrer_wallet TEXT NOT NULL,
  referee_wallet TEXT NOT NULL,
  week_index INTEGER NOT NULL,
  ore_amount TEXT NOT NULL,
  applied_to_player INTEGER NOT NULL DEFAULT 0 CHECK (applied_to_player IN (0, 1)),
  created_at INTEGER NOT NULL,
  UNIQUE (referrer_wallet, referee_wallet),
  CHECK (CAST(ore_amount AS INTEGER) BETWEEN 1 AND 250)
);

CREATE TABLE IF NOT EXISTS game_referral_weekly_caps (
  referrer_wallet TEXT NOT NULL,
  week_index INTEGER NOT NULL,
  credited_count INTEGER NOT NULL DEFAULT 0,
  ore_amount TEXT NOT NULL DEFAULT '0',
  last_credit_id TEXT,
  PRIMARY KEY (referrer_wallet, week_index)
);

CREATE TABLE IF NOT EXISTS game_discoveries (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL UNIQUE,
  wallet TEXT NOT NULL,
  mint TEXT NOT NULL,
  epoch_index INTEGER NOT NULL,
  amount TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (wallet, epoch_index)
);
