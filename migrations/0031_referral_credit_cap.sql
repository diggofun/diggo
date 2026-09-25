-- The 1..=250 ORE rule is now a table CHECK in 0029. Remove the legacy trigger shape because
-- Wrangler's remote migration splitter cannot ingest semicolons inside trigger bodies.
DROP TRIGGER IF EXISTS game_referral_credit_limit;
