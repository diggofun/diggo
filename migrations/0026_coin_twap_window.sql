-- The short-window TWAP terms are part of the Coin account contract and are needed to explain
-- any price the program uses for discovery. Keep them in the indexer mirror instead of reducing
-- the account to its long-window accumulator and forcing a live RPC read for every audit.

ALTER TABLE coins ADD COLUMN twap_cum_price_lamports_per_unit TEXT NOT NULL DEFAULT '0';
ALTER TABLE coins ADD COLUMN twap_last_update_slot TEXT NOT NULL DEFAULT '0';
ALTER TABLE coins ADD COLUMN twap_last_price TEXT NOT NULL DEFAULT '0';
ALTER TABLE coins ADD COLUMN twap_window_slot TEXT NOT NULL DEFAULT '0';
ALTER TABLE coins ADD COLUMN twap_window_cum TEXT NOT NULL DEFAULT '0';
