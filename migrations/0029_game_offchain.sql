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
  created_at INTEGER NOT NULL,
  UNIQUE (referrer_wallet, referee_wallet)
);

CREATE TABLE IF NOT EXISTS game_referral_weekly_caps (
  referrer_wallet TEXT NOT NULL,
  week_index INTEGER NOT NULL,
  credited_count INTEGER NOT NULL DEFAULT 0,
  ore_amount TEXT NOT NULL DEFAULT '0',
  PRIMARY KEY (referrer_wallet, week_index)
);

-- Match the native program's per-credit ceiling before the weekly trigger records the credit.
CREATE TRIGGER IF NOT EXISTS game_referral_credit_limit
BEFORE INSERT ON game_referral_credits
WHEN CAST(NEW.ore_amount AS INTEGER) < 1 OR CAST(NEW.ore_amount AS INTEGER) > 250
BEGIN
  SELECT RAISE(ABORT, 'game referral credit must be between 1 and 250 ORE');
END;

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

-- A referral row is both the idempotency record and the transaction trigger. The unique
-- constraint means a replay cannot fire these statements twice; the aggregate checks in the
-- player update make a capped referral a complete no-op.
CREATE TRIGGER IF NOT EXISTS game_referral_credit_apply
AFTER INSERT ON game_referral_credits
BEGIN
  INSERT INTO game_referral_weekly_caps (referrer_wallet, week_index, credited_count, ore_amount)
  VALUES (NEW.referrer_wallet, NEW.week_index, 1, NEW.ore_amount)
  ON CONFLICT(referrer_wallet, week_index) DO UPDATE SET
    credited_count = game_referral_weekly_caps.credited_count + 1,
    ore_amount = CAST(game_referral_weekly_caps.ore_amount AS INTEGER) + CAST(NEW.ore_amount AS INTEGER)
  WHERE CAST(game_referral_weekly_caps.ore_amount AS INTEGER) + CAST(NEW.ore_amount AS INTEGER) <= 25 * 250
    AND game_referral_weekly_caps.credited_count < 25;

  UPDATE game_players
    SET ore_balance = CAST(ore_balance AS INTEGER) + CAST(NEW.ore_amount AS INTEGER),
      ore_earned = CAST(ore_earned AS INTEGER) + CAST(NEW.ore_amount AS INTEGER),
      version = version + 1,
      updated_at = CAST(strftime('%s', 'now') AS INTEGER)
  WHERE wallet = NEW.referrer_wallet
    AND COALESCE(CAST((SELECT credited_count FROM game_referral_weekly_caps
         WHERE referrer_wallet = NEW.referrer_wallet AND week_index = NEW.week_index)
        AS INTEGER), 0) = (SELECT COUNT(*) FROM game_referral_credits
           WHERE referrer_wallet = NEW.referrer_wallet AND week_index = NEW.week_index)
    AND COALESCE(CAST((SELECT ore_amount FROM game_referral_weekly_caps
         WHERE referrer_wallet = NEW.referrer_wallet AND week_index = NEW.week_index)
        AS INTEGER), 0) = (SELECT SUM(CAST(ore_amount AS INTEGER)) FROM game_referral_credits
           WHERE referrer_wallet = NEW.referrer_wallet AND week_index = NEW.week_index);
END;

-- Discovery dispatch is one insert: the trigger creates the claim and debits the mine, and an
-- over-reserve insert aborts the whole transaction instead of leaving a claim behind.
CREATE TRIGGER IF NOT EXISTS game_discovery_dispatch
AFTER INSERT ON game_discoveries
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM game_mines WHERE mint = NEW.mint AND CAST(remaining AS INTEGER) >= CAST(NEW.amount AS INTEGER))
    THEN RAISE(ABORT, 'game discovery reserve exhausted')
  END;
  INSERT INTO game_claims (id, wallet, mint, kind, amount, status, idempotency_key, created_at)
  VALUES (NEW.claim_id, NEW.wallet, NEW.mint, 'DISCOVERY', NEW.amount, 'PENDING', NEW.claim_id, NEW.created_at);
  UPDATE game_mines
  SET released = MIN(
        CAST(initial_reserve AS INTEGER),
        CAST(released AS INTEGER) + CAST(NEW.amount AS INTEGER)
      ),
      committed = CAST(committed AS INTEGER) + CAST(NEW.amount AS INTEGER),
      remaining = CAST(remaining AS INTEGER) - CAST(NEW.amount AS INTEGER),
      version = version + 1,
      updated_at = NEW.created_at
  WHERE mint = NEW.mint;
END;
