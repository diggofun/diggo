-- The received side of a trade, and where it was read from.
--
-- v2 emits no trade event, so a fill is read from the instruction that caused it, which says what
-- the trader offered and nothing about what they received. The received amount is recoverable from
-- the transaction's own balance deltas - the wallet's token balance for the mint moved one way and
-- its lamports the other - and that is what these two columns hold.
--
-- fill_source records which path produced the number, because the two are not equivalent and a
-- reader has to be able to tell them apart:
--   'meta'       the transaction's balance table, which is the fill itself;
--   'instruction' no balance table was available, so only the input is known and amount_out is 0;
--   'event'      a v2 trade event, if the contract ever declares one. Nothing writes this yet.
--
-- Additive: the existing rows keep amount_out 0 and fill_source 'instruction', which is exactly
-- what they meant before this migration.

ALTER TABLE trades ADD COLUMN amount_out TEXT NOT NULL DEFAULT '0';
ALTER TABLE trades ADD COLUMN fill_source TEXT NOT NULL DEFAULT 'instruction';
