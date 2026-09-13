PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tokens (
  mint TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  description TEXT NOT NULL,
  creator TEXT NOT NULL,
  image_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('LAUNCHING', 'MINING_ACTIVE', 'FULLY_MINED')),
  price_usd REAL NOT NULL DEFAULT 0,
  change_24h REAL NOT NULL DEFAULT 0,
  market_cap_usd REAL NOT NULL DEFAULT 0,
  reserve_remaining REAL NOT NULL,
  reserve_total REAL NOT NULL,
  reward_per_block REAL NOT NULL,
  network_power REAL NOT NULL DEFAULT 0,
  next_block_at INTEGER NOT NULL,
  next_epoch_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_tokens_status_created ON tokens(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tokens_market_cap ON tokens(market_cap_usd DESC);

CREATE TABLE IF NOT EXISTS launch_requests (
  id TEXT PRIMARY KEY,
  creator TEXT NOT NULL,
  name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  description TEXT NOT NULL,
  image_key TEXT,
  vanity_suffix TEXT NOT NULL DEFAULT 'diggo',
  status TEXT NOT NULL DEFAULT 'QUEUED',
  mint TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS chain_events (
  signature TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  mint TEXT NOT NULL,
  payload TEXT NOT NULL,
  block_time INTEGER,
  processed_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS trades (
  signature TEXT PRIMARY KEY,
  mint TEXT NOT NULL REFERENCES tokens(mint),
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  price_usd REAL NOT NULL,
  amount REAL NOT NULL,
  block_time INTEGER NOT NULL
);

INSERT OR IGNORE INTO tokens VALUES
('9xK2hM7qT4vB8nP6sR3wY5cF1aG7uJ2eL8mN4diggo','dogwifdrill','Dog Wif Drill','DRILL','He showed up with a hard hat and a plan.','D1gCr8torVaU1t111111111111111111111111111','tokens/drill.svg','MINING_ACTIVE',0.00284,18.4,2840000,31200000,50000000,7500,2000000,1799942700,1800122400,1799931000),
('4rT8mQ2vN6kY3cW9pF1sJ7aB5eH8uL2xG6zP9diggo','stone','Stone Coin','STONE','Heavy bags. Honest blocks. Zero mint authority.','St0neCr8torVaU1t111111111111111111111111','tokens/stone.svg','MINING_ACTIVE',0.0142,-4.8,14200000,42800000,50000000,9200,3450000,1799942760,1800108000,1799924000),
('7bV3nK9sQ2mF6wT1yR8cP4aH5eJ9uL3xG2dM8diggo','mole','Mole Money','MOLE','Underground since genesis.','Mo1eCr8torVaU1t1111111111111111111111111','tokens/mole.svg','LAUNCHING',0.00071,42.1,710000,50000000,50000000,10000,870000,1799942820,1800194400,1799938000),
('2mP8xR4vT7kN1sW6cF9yB3aQ5eH8uJ2gL7zD4diggo','golden','Golden Byte','BYTE','Internet gold with a finite vein.','ByteCr8torVaU1t11111111111111111111111111','tokens/byte.svg','MINING_ACTIVE',0.0063,9.7,6300000,19800000,50000000,5625,4890000,1799942880,1800021600,1799917000);
