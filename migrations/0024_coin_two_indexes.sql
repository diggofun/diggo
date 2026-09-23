-- The coin's two reward indexes, and the TWAP's short window.
--
-- v2's Coin carries one cumulative index per reward tranche (`bonded_index` for bonded power,
-- `starter_index` for the starter tranche, which is scaled by starter_efficiency_bps in the
-- program), plus the short-window TWAP terms the deviation gate reads. The single `reward_index`
-- column is dropped rather than left as a stale zero: nothing read it but the writer, and a mirror
-- that keeps a field the account no longer has is worse than a mirror that drops it.
--
-- Additive for every reader: a row written before this migration reads as two zero indexes, which
-- is what "no rewards distributed yet" looks like.

ALTER TABLE coins ADD COLUMN bonded_index TEXT NOT NULL DEFAULT '0';
ALTER TABLE coins ADD COLUMN starter_index TEXT NOT NULL DEFAULT '0';
ALTER TABLE coins DROP COLUMN reward_index;
