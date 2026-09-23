-- Anti-abuse data model (spec 39-67, 76): behavioural signals, the computed account risk
-- record, admin restrictions, circuit breakers, telemetry counters, the admin audit trail and
-- single-use challenge nonces.
--
-- Privacy: account_signals stores only salted hashes of IP/device/network identifiers, never a
-- raw IP or a raw client fingerprint (spec 50, 51, 67). account_signals deliberately has no
-- foreign key to players: auth failures and bootstrap attempts must be recordable for wallets
-- that do not have a player row yet.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS account_signals (
  wallet TEXT NOT NULL,
  ts INTEGER NOT NULL,
  action TEXT NOT NULL,
  ip_hash TEXT,
  network_hash TEXT,
  device_hash TEXT,
  session_id TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'rejected', 'replay', 'rate_limited', 'failed_challenge'))
);

CREATE INDEX IF NOT EXISTS idx_account_signals_wallet_ts ON account_signals(wallet, ts DESC);
CREATE INDEX IF NOT EXISTS idx_account_signals_device_ts ON account_signals(device_hash, ts DESC);
CREATE INDEX IF NOT EXISTS idx_account_signals_network_ts ON account_signals(network_hash, ts DESC);
CREATE INDEX IF NOT EXISTS idx_account_signals_action_ts ON account_signals(action, ts DESC);
CREATE INDEX IF NOT EXISTS idx_account_signals_outcome_ts ON account_signals(outcome, ts DESC);

-- Server-side Account Risk Score (spec 49, 60). flags is internal JSON: signals, weights and
-- thresholds are never exposed through the API (spec 62).
CREATE TABLE IF NOT EXISTS account_risk (
  wallet TEXT PRIMARY KEY,
  score INTEGER NOT NULL DEFAULT 0,
  level TEXT NOT NULL DEFAULT 'LOW' CHECK (level IN ('LOW', 'MEDIUM', 'HIGH')),
  reward_state TEXT NOT NULL DEFAULT 'NORMAL' CHECK (reward_state IN ('NORMAL', 'UNDER_REVIEW', 'HELD', 'BLOCKED')),
  trust INTEGER NOT NULL DEFAULT 0,
  flags TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_account_risk_level ON account_risk(level, reward_state);

-- Admin-issued restrictions (spec 53, 65). One live row per (wallet, kind): the newest decision
-- wins, and expires_at NULL means "until an admin lifts it".
CREATE TABLE IF NOT EXISTS account_restrictions (
  wallet TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('ACCOUNT_BLOCK', 'CLAIM_HOLD', 'DISCOVERY_BLOCK', 'CHALLENGE_REQUIRED', 'RATE_LIMIT')),
  reason_code TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER,
  created_by TEXT NOT NULL,
  PRIMARY KEY (wallet, kind)
);

CREATE INDEX IF NOT EXISTS idx_account_restrictions_expires ON account_restrictions(expires_at);

-- Circuit breakers (spec 65). A breaker can only halt discoveries, halt claims or halt one
-- mine's Discovery Reserve payouts; there is no control here that can move funds. mint is NULL
-- for the scope-wide row.
CREATE TABLE IF NOT EXISTS circuit_breakers (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('discoveries', 'claims', 'discovery_reserve')),
  mint TEXT,
  open INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  actor TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_circuit_breakers_scope_mint ON circuit_breakers(scope, IFNULL(mint, ''));

CREATE TABLE IF NOT EXISTS breaker_audit (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  mint TEXT,
  open INTEGER NOT NULL,
  reason TEXT,
  actor TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_breaker_audit_created ON breaker_audit(created_at DESC);

-- Telemetry counters (spec 66): one row per (name, hour, tag set).
CREATE TABLE IF NOT EXISTS metrics_counters (
  name TEXT NOT NULL,
  bucket_hour INTEGER NOT NULL,
  tags TEXT NOT NULL DEFAULT '',
  value REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (name, bucket_hour, tags)
);

CREATE INDEX IF NOT EXISTS idx_metrics_counters_bucket ON metrics_counters(bucket_hour DESC);

-- Every admin mutation, so emergency controls stay auditable (spec 65, 67).
CREATE TABLE IF NOT EXISTS admin_audit (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit(created_at DESC);

-- Single-use challenge nonces (spec 46, 47). The signed message lives in KV, but the
-- single-use guarantee has to be atomic, so consumption is a conditional UPDATE here.
CREATE TABLE IF NOT EXISTS challenge_nonces (
  nonce TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  action TEXT NOT NULL,
  resource TEXT,
  issued_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_challenge_nonces_wallet ON challenge_nonces(wallet, issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_challenge_nonces_expires ON challenge_nonces(expires_at);

