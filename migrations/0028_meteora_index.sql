-- Meteora DBC is an alternate launch venue. These tables intentionally do not
-- masquerade as native v2 coins or tokens: the two indexers have different
-- settlement and graduation semantics.

CREATE TABLE IF NOT EXISTS meteora_pools (
  pool TEXT PRIMARY KEY,
  config TEXT NOT NULL,
  creator TEXT NOT NULL,
  base_mint TEXT NOT NULL,
  base_vault TEXT NOT NULL,
  quote_mint TEXT NOT NULL,
  name TEXT,
  symbol TEXT,
  uri TEXT,
  decimals INTEGER NOT NULL DEFAULT 9,
  activation_point TEXT NOT NULL DEFAULT '0',
  base_reserve TEXT NOT NULL DEFAULT '0',
  quote_reserve TEXT NOT NULL DEFAULT '0',
  migration_quote_threshold TEXT NOT NULL DEFAULT '0',
  is_graduated INTEGER NOT NULL DEFAULT 0,
  is_migrated INTEGER NOT NULL DEFAULT 0,
  is_leftover_withdrawn INTEGER NOT NULL DEFAULT 0,
  signature_cursor TEXT,
  indexed_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_meteora_pools_mint ON meteora_pools(base_mint);
CREATE INDEX IF NOT EXISTS idx_meteora_pools_migrated ON meteora_pools(is_graduated, is_migrated, is_leftover_withdrawn);

CREATE TABLE IF NOT EXISTS meteora_swaps (
  id TEXT PRIMARY KEY,
  signature TEXT NOT NULL,
  event_index INTEGER NOT NULL,
  pool TEXT NOT NULL,
  config TEXT NOT NULL,
  mint TEXT NOT NULL,
  trader_wallet TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  amount_in TEXT NOT NULL,
  amount_out TEXT NOT NULL,
  sol_amount_lamports TEXT NOT NULL,
  quote_reserve TEXT NOT NULL,
  migration_threshold TEXT NOT NULL,
  slot TEXT NOT NULL,
  block_time INTEGER,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_meteora_swaps_signature_event
  ON meteora_swaps(signature, event_index);
CREATE INDEX IF NOT EXISTS idx_meteora_swaps_pool ON meteora_swaps(pool, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_meteora_swaps_wallet ON meteora_swaps(trader_wallet, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_meteora_swaps_volume ON meteora_swaps(trader_wallet, sol_amount_lamports);

CREATE TABLE IF NOT EXISTS meteora_vault_balances (
  mint TEXT PRIMARY KEY,
  token_account TEXT NOT NULL,
  amount TEXT NOT NULL DEFAULT '0',
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS meteora_vault_operations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  pool TEXT,
  mint TEXT,
  status TEXT NOT NULL,
  signature TEXT,
  amount TEXT,
  error TEXT,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_meteora_vault_ops_idempotency
  ON meteora_vault_operations(id);
CREATE INDEX IF NOT EXISTS idx_meteora_vault_ops_pending
  ON meteora_vault_operations(status, updated_at);

CREATE TABLE IF NOT EXISTS meteora_vault_claims (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  mint TEXT NOT NULL,
  wallet TEXT NOT NULL,
  amount TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'SENT', 'SETTLED', 'FAILED')),
  signature TEXT,
  day_index INTEGER NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_meteora_vault_claims_day
  ON meteora_vault_claims(mint, wallet, day_index, status);
CREATE INDEX IF NOT EXISTS idx_meteora_vault_claims_wallet
  ON meteora_vault_claims(wallet, created_at DESC);

CREATE TABLE IF NOT EXISTS meteora_daily_claim_caps (
  mint TEXT NOT NULL,
  wallet TEXT NOT NULL,
  day_index INTEGER NOT NULL,
  reserved TEXT NOT NULL DEFAULT '0',
  settled TEXT NOT NULL DEFAULT '0',
  revision INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (mint, wallet, day_index)
);
