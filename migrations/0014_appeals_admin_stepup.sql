-- 0014: appeals, admin step-up nonces, and the shadow-enforcement bookkeeping.
--
-- Three changes, all additive to what an operator can see or undo:
--
-- 1. account_signals.outcome gains 'shadow_would_block' (spec 63). The gate records the refusals
--    it would have made while shadow mode is on, so a launch can be reviewed on evidence instead
--    of guesses. SQLite cannot widen a CHECK constraint in place, so the table is rebuilt with
--    the new constraint and every row is carried over unchanged.
-- 2. account_risk.computed_state holds the state the score alone asked for. reward_state stays
--    the state that is actually in force, which is what gameplay and the public risk view read;
--    the two differ exactly while enforcement is shadowed.
-- 3. appeals and admin_stepup_nonces. An appeal is a request for human review - it can never
--    lift a restriction or move value by itself - and every mutating admin call has to carry a
--    fresh, single-use signature bound to the action and the payload it authorises (spec 65, 67).

-- --- 1. shadow decisions are a recorded outcome -------------------------------------------

DROP TABLE IF EXISTS account_signals_migrated;

CREATE TABLE account_signals_migrated (
  wallet TEXT NOT NULL,
  ts INTEGER NOT NULL,
  action TEXT NOT NULL,
  ip_hash TEXT,
  network_hash TEXT,
  device_hash TEXT,
  session_id TEXT,
  outcome TEXT NOT NULL CHECK (
    outcome IN ('ok', 'rejected', 'replay', 'rate_limited', 'failed_challenge', 'shadow_would_block')
  )
);

INSERT INTO account_signals_migrated (wallet, ts, action, ip_hash, network_hash, device_hash, session_id, outcome)
  SELECT wallet, ts, action, ip_hash, network_hash, device_hash, session_id, outcome FROM account_signals;

DROP TABLE account_signals;

ALTER TABLE account_signals_migrated RENAME TO account_signals;

CREATE INDEX IF NOT EXISTS idx_account_signals_wallet_ts ON account_signals(wallet, ts DESC);
CREATE INDEX IF NOT EXISTS idx_account_signals_device_ts ON account_signals(device_hash, ts DESC);
CREATE INDEX IF NOT EXISTS idx_account_signals_network_ts ON account_signals(network_hash, ts DESC);
CREATE INDEX IF NOT EXISTS idx_account_signals_action_ts ON account_signals(action, ts DESC);
CREATE INDEX IF NOT EXISTS idx_account_signals_outcome_ts ON account_signals(outcome, ts DESC);

-- --- 2. the computed state beside the enforced state --------------------------------------

ALTER TABLE account_risk ADD COLUMN computed_state TEXT NOT NULL DEFAULT 'NORMAL';

CREATE INDEX IF NOT EXISTS idx_account_risk_computed_state ON account_risk(computed_state);

-- --- 3a. player appeals -------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS appeals (
  id TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'ACCEPTED', 'REJECTED')),
  -- The reward state the player was actually in when they filed, so a reviewer sees the appeal
  -- in the context it was written in even after the account moves on.
  state_at_submission TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  resolved_at INTEGER,
  resolved_by TEXT,
  resolution_note TEXT
);

CREATE INDEX IF NOT EXISTS idx_appeals_wallet_created ON appeals(wallet, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_appeals_status_created ON appeals(status, created_at DESC);

-- --- 3b. admin step-up nonces -------------------------------------------------------------

-- One row per signed intent: wallet + action + the hash of the exact payload it authorises.
-- consumed_at makes the signature single-use, so a captured request cannot be replayed.
CREATE TABLE IF NOT EXISTS admin_stepup_nonces (
  nonce TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  action TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_admin_stepup_nonces_wallet ON admin_stepup_nonces(wallet, expires_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_stepup_nonces_expires ON admin_stepup_nonces(expires_at);
