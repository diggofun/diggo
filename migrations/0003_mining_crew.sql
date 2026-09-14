PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS players (
  wallet TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  miners_level INTEGER NOT NULL DEFAULT 1,
  drills_level INTEGER NOT NULL DEFAULT 1,
  carts_level INTEGER NOT NULL DEFAULT 1,
  foreman_level INTEGER NOT NULL DEFAULT 1,
  storage_level INTEGER NOT NULL DEFAULT 1,
  ore_balance INTEGER NOT NULL DEFAULT 0,
  streak INTEGER NOT NULL DEFAULT 0,
  streak_freezes INTEGER NOT NULL DEFAULT 0,
  active_days INTEGER NOT NULL DEFAULT 0,
  active_mint TEXT,
  last_activation_at INTEGER,
  activation_expires_at INTEGER,
  ore_collected_at INTEGER,
  power_synced_onchain INTEGER NOT NULL DEFAULT 0,
  risk_state TEXT NOT NULL DEFAULT 'NORMAL' CHECK (risk_state IN ('NORMAL', 'UNDER_REVIEW', 'HELD', 'BLOCKED')),
  risk_score INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS discoveries (
  id TEXT PRIMARY KEY,
  wallet TEXT NOT NULL REFERENCES players(wallet),
  mint TEXT NOT NULL,
  symbol TEXT NOT NULL,
  rarity TEXT NOT NULL,
  token_amount REAL NOT NULL,
  value_usd REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ELIGIBLE')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_discoveries_wallet_created ON discoveries(wallet, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_discoveries_mint_created ON discoveries(mint, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_discoveries_created ON discoveries(created_at DESC);

CREATE TABLE IF NOT EXISTS risk_events (
  id TEXT PRIMARY KEY,
  wallet TEXT NOT NULL REFERENCES players(wallet),
  kind TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_risk_events_wallet_created ON risk_events(wallet, created_at DESC);
