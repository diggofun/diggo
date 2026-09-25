-- Keep already-migrated databases aligned with the native program's 1..=250 ORE per-credit rule.
DROP TRIGGER IF EXISTS game_referral_credit_limit;

CREATE TRIGGER game_referral_credit_limit
BEFORE INSERT ON game_referral_credits
WHEN CAST(NEW.ore_amount AS INTEGER) < 1 OR CAST(NEW.ore_amount AS INTEGER) > 250
BEGIN
  SELECT RAISE(ABORT, 'game referral credit must be between 1 and 250 ORE');
END;
