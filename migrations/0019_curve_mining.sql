-- Curve-phase mining, the sell capacity that goes with it, and honest 24h metrics.
--
-- Every column below is a cache of something the program or the indexer has already decided:
-- worker/chain.ts writes them from a fresh account read, and nothing in the Worker invents a
-- value. A token last synced before this migration reads zeros, which is the honest answer
-- for a deployment that has not synced since - not a claim about the chain.

-- 1. Which venue backs the price: the bonding curve, or the graduated constant-product pool.
ALTER TABLE tokens ADD COLUMN venue TEXT NOT NULL DEFAULT 'curve';

-- 2. The curve-mining ledger, mirrored from LaunchMarket. The cap is immutable after launch
--    and may never be exceeded; 'unpaid' is what the reward index has credited to positions
--    but no claimer has taken yet.
ALTER TABLE tokens ADD COLUMN curve_mining_open INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tokens ADD COLUMN curve_mining_cap REAL NOT NULL DEFAULT 0;
ALTER TABLE tokens ADD COLUMN curve_mining_mined REAL NOT NULL DEFAULT 0;
ALTER TABLE tokens ADD COLUMN curve_mining_unpaid REAL NOT NULL DEFAULT 0;
ALTER TABLE tokens ADD COLUMN curve_mining_block_reward REAL NOT NULL DEFAULT 0;
ALTER TABLE tokens ADD COLUMN curve_mining_synced_at INTEGER NOT NULL DEFAULT 0;

-- 3. Read-only sell capacity: the real SOL a seller can get out of the curve, and the token
--    amount that would take all of it. NULL means no finite token amount can reach it, which
--    is what a curve with no virtual SOL reserve reports.
ALTER TABLE tokens ADD COLUMN curve_sell_capacity_sol REAL NOT NULL DEFAULT 0;
ALTER TABLE tokens ADD COLUMN curve_sell_capacity_tokens REAL;

-- 4. Honest 24h metrics. change_24h is only meaningful when change_24h_at > 0: that column
--    records the observed_at of the price sample the percentage was measured against, so
--    change_24h_at = 0 means "unknown" and the API returns null for the percentage rather
--    than the column default of 0. A token whose change was never measured must render as
--    unknown, never as "+0%".
ALTER TABLE tokens ADD COLUMN change_24h_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tokens ADD COLUMN volume_24h_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE tokens ADD COLUMN trades_24h INTEGER NOT NULL DEFAULT 0;

-- 5. Which side a mine's block rewards come out of. 'CURVE' while the market is still on the
--    curve (the curve-phase cap pays) and 'RESERVE' after graduation (the Mining Reserve
--    pays). It is re-derived from chain on every load, so the stored value is only ever the
--    answer the last reconciliation reached; a row written before this migration is a
--    reserve-phase mine, which is what every mine was.
ALTER TABLE mine_reward_state ADD COLUMN emission_source TEXT NOT NULL DEFAULT 'RESERVE';
