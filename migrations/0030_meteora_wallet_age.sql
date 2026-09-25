CREATE TABLE IF NOT EXISTS meteora_wallet_age (
  wallet TEXT PRIMARY KEY,
  oldest_signature TEXT,
  created_at INTEGER NOT NULL,
  checked_at INTEGER NOT NULL
);
