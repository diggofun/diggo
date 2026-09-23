-- W-DISCOVERY: security-critical discovery state (spec 22-28, 44-45, 54-56, 70).
--
-- Discoveries hand out real memecoin value, so they are the most protected subsystem in the
-- game. This migration adds:
--   * discovery_opportunities - one single-use, server-authored roll opportunity per
--     (wallet, time window). UNIQUE(wallet, window_index) is the anti-reroll guard: a
--     window can be rolled exactly once, so an attacker cannot spam requests for a better
--     outcome and cannot pick the best of several parallel attempts.
--   * discoveries (rebuilt)   - PENDING -> ELIGIBLE -> CLAIMED plus HELD/REJECTED, linked to
--     the opportunity that produced it, carrying the valued price and eligibility score used
--     at grant time. UNIQUE(event_id) makes "one grant per window" a database guarantee.
--   * token_price_samples     - the observations robustPrice() needs. A token with too few
--     samples, or samples that disagree too much, cannot be valued and therefore cannot pay.
--   * tokens.*               - indexed Discovery Reserve, liquidity and mint-authority state,
--     mirrored from the on-chain Mine/mint accounts by worker/chain.ts so the reserve check
--     before granting is a cheap indexed read instead of an RPC call in the roll path.

PRAGMA foreign_keys = ON;

-- 1. Single-use roll opportunities ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS discovery_opportunities (
  id TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  event_id TEXT NOT NULL,
  window_index INTEGER NOT NULL,
  window TEXT NOT NULL,
  nonce TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'ELIGIBLE', 'CONSUMED', 'EXPIRED', 'REJECTED')),
  consumed_at INTEGER,
  expires_at INTEGER NOT NULL,
  discovery_id TEXT,
  mint TEXT,
  rarity TEXT,
  reason TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (wallet, window_index)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_discovery_opportunities_event
  ON discovery_opportunities(event_id);
CREATE INDEX IF NOT EXISTS idx_discovery_opportunities_wallet_created
  ON discovery_opportunities(wallet, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_discovery_opportunities_status
  ON discovery_opportunities(status, expires_at);

-- 2. Rebuilt discoveries table ---------------------------------------------------------------
-- The CHECK constraint created in 0003/0007 only allows PENDING/ELIGIBLE/CLAIMED, so HELD and
-- REJECTED (spec 53) need the table rebuilt rather than patched.
CREATE TABLE IF NOT EXISTS discoveries_v2 (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  wallet TEXT NOT NULL REFERENCES players(wallet),
  window TEXT NOT NULL,
  window_index INTEGER NOT NULL,
  mint TEXT NOT NULL,
  symbol TEXT NOT NULL,
  rarity TEXT NOT NULL,
  visual_event TEXT NOT NULL,
  token_amount REAL NOT NULL,
  value_usd REAL NOT NULL,
  price_usd REAL NOT NULL DEFAULT 0,
  eligibility_score INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'ELIGIBLE', 'CLAIMED', 'HELD', 'REJECTED')),
  claimed_at INTEGER,
  tx_signature TEXT,
  failure_reason TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO discoveries_v2 (
  id, event_id, wallet, window, window_index, mint, symbol, rarity, visual_event,
  token_amount, value_usd, price_usd, eligibility_score, status, tx_signature, created_at)
  SELECT
    id,
    'legacy:' || id,
    wallet,
    'legacy',
    0,
    mint,
    symbol,
    rarity,
    CASE rarity
      WHEN 'uncommon' THEN 'Meme Vein'
      WHEN 'rare' THEN 'Crystal Vein'
      WHEN 'epic' THEN 'Ancient Geode'
      WHEN 'legendary' THEN 'Golden Block'
      WHEN 'mythic' THEN 'Degen Core'
      ELSE 'Stone'
    END,
    token_amount,
    value_usd,
    0,
    0,
    status,
    tx_signature,
    created_at
  FROM discoveries;

DROP TABLE discoveries;
ALTER TABLE discoveries_v2 RENAME TO discoveries;

-- One discovery per opportunity, enforced by the database instead of by a read-then-write race.
CREATE UNIQUE INDEX IF NOT EXISTS idx_discoveries_event ON discoveries(event_id);
CREATE INDEX IF NOT EXISTS idx_discoveries_wallet_created ON discoveries(wallet, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_discoveries_mint_created ON discoveries(mint, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_discoveries_created ON discoveries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_discoveries_status ON discoveries(status, created_at DESC);

-- 3. Price observations for robustPrice() -----------------------------------------------------
CREATE TABLE IF NOT EXISTS token_price_samples (
  id TEXT PRIMARY KEY,
  mint TEXT NOT NULL,
  price_usd REAL NOT NULL,
  volume_usd REAL NOT NULL DEFAULT 0,
  observed_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_token_price_samples_mint_time
  ON token_price_samples(mint, observed_at DESC);

-- 4. Indexed Discovery Reserve / token health -------------------------------------------------
-- Mirrored from chain by worker/chain.ts. Kept NOT NULL with honest defaults so a token that has
-- never been synced has discovery_reserve_remaining = 0 and can never pay a discovery.
ALTER TABLE tokens ADD COLUMN discovery_reserve_remaining REAL NOT NULL DEFAULT 0;
ALTER TABLE tokens ADD COLUMN discovery_reserve_total REAL NOT NULL DEFAULT 0;
ALTER TABLE tokens ADD COLUMN discovery_epoch_budget REAL NOT NULL DEFAULT 0;
ALTER TABLE tokens ADD COLUMN discovery_epoch_spent REAL NOT NULL DEFAULT 0;
ALTER TABLE tokens ADD COLUMN discovery_epoch_ends_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tokens ADD COLUMN discovery_paused INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tokens ADD COLUMN liquidity_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE tokens ADD COLUMN mint_authority_revoked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tokens ADD COLUMN freeze_authority_revoked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tokens ADD COLUMN liquidity_locked INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tokens ADD COLUMN discovery_synced_at INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_tokens_discovery_eligible
  ON tokens(status, discovery_paused, discovery_reserve_remaining);
