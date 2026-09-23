-- Referral identity and qualification are off-chain records. ORE remains authoritative in the
-- on-chain PlayerAccount; reward_ore below is a pending entitlement, never a balance mutation.
ALTER TABLE trades ADD COLUMN trader_wallet TEXT;

CREATE TABLE IF NOT EXISTS referral_profiles (
  wallet TEXT PRIMARY KEY,
  current_code TEXT NOT NULL,
  last_changed_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0
);

-- Codes are retained after a rename so old links keep attributing to the same wallet.
CREATE TABLE IF NOT EXISTS referral_codes (
  code TEXT PRIMARY KEY COLLATE NOCASE,
  wallet TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_referral_codes_wallet ON referral_codes(wallet);

CREATE TABLE IF NOT EXISTS referral_attributions (
  id TEXT PRIMARY KEY,
  referred_wallet TEXT NOT NULL UNIQUE,
  referrer_wallet TEXT NOT NULL,
  code TEXT NOT NULL,
  status TEXT NOT NULL,
  qualified_at INTEGER,
  rewarded_at INTEGER,
  reward_ore TEXT NOT NULL DEFAULT '0',
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_referral_attributions_referrer ON referral_attributions(referrer_wallet, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_referral_attributions_status ON referral_attributions(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS referral_reward_events (
  id TEXT PRIMARY KEY,
  attribution_id TEXT NOT NULL UNIQUE,
  referrer_wallet TEXT NOT NULL,
  ore_amount TEXT NOT NULL,
  cosmetic_id TEXT NOT NULL,
  status TEXT NOT NULL,
  signature TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS referral_weekly_caps (
  referrer_wallet TEXT NOT NULL,
  week_index INTEGER NOT NULL,
  rewarded_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (referrer_wallet, week_index)
);

-- Every transaction account is indexed as a participant. A trade is excluded when the referrer
-- and referee both appear in the same transaction, including multi-hop wash arrangements.
CREATE TABLE IF NOT EXISTS trade_participants (
  signature TEXT NOT NULL,
  wallet TEXT NOT NULL,
  PRIMARY KEY (signature, wallet)
);
CREATE INDEX IF NOT EXISTS idx_trade_participants_wallet ON trade_participants(wallet, signature);
