-- A token status for the state the mining ledger calls idle: a market whose curve-mining budget is
-- spent while it is still on its bonding curve.
--
-- It has to be its own status. The indexing loop's re-read set is "status != 'FULLY_MINED' OR
-- venue != 'pool'" (worker/indexing.ts) and a spent curve budget used to be written as FULLY_MINED
-- (worker/chain.ts). A mine in that state is not finished - nothing is left to pay out of the curve,
-- but its Mining Reserve has not been touched and graduation is what turns it back on - so calling
-- it FULLY_MINED both stopped the sync pass that is the only thing that ever notices a graduation,
-- and told every client to stop showing a mine that still has a whole reserve waiting for it.
--
-- tokens.status carries a CHECK constraint from 0001, and SQLite cannot widen one in place, so this
-- is a rebuild. Three details make it safe on D1:
--
--   * The rows are stashed in an unconstrained scratch table first, and copied back into the
--     rebuilt tokens table *after* it exists. trades.mint references tokens(mint), so what has to
--     happen is that the child rows still find their parent by the time the migration commits:
--     copying into tokens itself is what satisfies that constraint, and copying into a table that is
--     merely renamed later does not (SQLite resolves the foreign key by name at commit and would
--     report the child rows as orphaned).
--   * PRAGMA defer_foreign_keys, never PRAGMA foreign_keys = OFF: D1 runs each migration inside a
--     transaction, where the latter is a no-op, and it is the documented way to rebuild a table
--     something points at. Exactly one table does (trades.mint), and every mint it references is
--     copied across below.
--   * The copy is column-explicit on both sides. A bare SELECT * would silently mis-map if a later
--     ALTER TABLE appended a column in a different order than this file assumes.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE tokens_status_rebuild AS
SELECT
  mint, slug, name, symbol, description, creator, image_key, status, price_usd, change_24h,
  market_cap_usd, reserve_remaining, reserve_total, reward_per_block, network_power, next_block_at,
  next_epoch_at, created_at, price_sol, decimals, synced_at, discovery_reserve_remaining,
  discovery_reserve_total, discovery_epoch_budget, discovery_epoch_spent, discovery_epoch_ends_at,
  discovery_paused, liquidity_usd, mint_authority_revoked, freeze_authority_revoked,
  liquidity_locked, discovery_synced_at, venue, curve_mining_open, curve_mining_cap,
  curve_mining_mined, curve_mining_unpaid, curve_mining_block_reward, curve_mining_synced_at,
  curve_sell_capacity_sol, curve_sell_capacity_tokens, change_24h_at, volume_24h_usd, trades_24h
FROM tokens;

DROP TABLE tokens;

CREATE TABLE tokens (
  mint TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  description TEXT NOT NULL,
  creator TEXT NOT NULL,
  image_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('LAUNCHING', 'MINING_ACTIVE', 'FULLY_MINED', 'CURVE_CAP_REACHED')),
  price_usd REAL NOT NULL DEFAULT 0,
  change_24h REAL NOT NULL DEFAULT 0,
  market_cap_usd REAL NOT NULL DEFAULT 0,
  reserve_remaining REAL NOT NULL,
  reserve_total REAL NOT NULL,
  reward_per_block REAL NOT NULL,
  network_power REAL NOT NULL DEFAULT 0,
  next_block_at INTEGER NOT NULL,
  next_epoch_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  price_sol REAL NOT NULL DEFAULT 0,
  decimals INTEGER NOT NULL DEFAULT 6,
  synced_at INTEGER NOT NULL DEFAULT 0,
  discovery_reserve_remaining REAL NOT NULL DEFAULT 0,
  discovery_reserve_total REAL NOT NULL DEFAULT 0,
  discovery_epoch_budget REAL NOT NULL DEFAULT 0,
  discovery_epoch_spent REAL NOT NULL DEFAULT 0,
  discovery_epoch_ends_at INTEGER NOT NULL DEFAULT 0,
  discovery_paused INTEGER NOT NULL DEFAULT 0,
  liquidity_usd REAL NOT NULL DEFAULT 0,
  mint_authority_revoked INTEGER NOT NULL DEFAULT 0,
  freeze_authority_revoked INTEGER NOT NULL DEFAULT 0,
  liquidity_locked INTEGER NOT NULL DEFAULT 1,
  discovery_synced_at INTEGER NOT NULL DEFAULT 0,
  venue TEXT NOT NULL DEFAULT 'curve',
  curve_mining_open INTEGER NOT NULL DEFAULT 0,
  curve_mining_cap REAL NOT NULL DEFAULT 0,
  curve_mining_mined REAL NOT NULL DEFAULT 0,
  curve_mining_unpaid REAL NOT NULL DEFAULT 0,
  curve_mining_block_reward REAL NOT NULL DEFAULT 0,
  curve_mining_synced_at INTEGER NOT NULL DEFAULT 0,
  curve_sell_capacity_sol REAL NOT NULL DEFAULT 0,
  curve_sell_capacity_tokens REAL,
  change_24h_at INTEGER NOT NULL DEFAULT 0,
  volume_24h_usd REAL NOT NULL DEFAULT 0,
  trades_24h INTEGER NOT NULL DEFAULT 0
);

INSERT INTO tokens (
  mint, slug, name, symbol, description, creator, image_key, status, price_usd, change_24h,
  market_cap_usd, reserve_remaining, reserve_total, reward_per_block, network_power, next_block_at,
  next_epoch_at, created_at, price_sol, decimals, synced_at, discovery_reserve_remaining,
  discovery_reserve_total, discovery_epoch_budget, discovery_epoch_spent, discovery_epoch_ends_at,
  discovery_paused, liquidity_usd, mint_authority_revoked, freeze_authority_revoked,
  liquidity_locked, discovery_synced_at, venue, curve_mining_open, curve_mining_cap,
  curve_mining_mined, curve_mining_unpaid, curve_mining_block_reward, curve_mining_synced_at,
  curve_sell_capacity_sol, curve_sell_capacity_tokens, change_24h_at, volume_24h_usd, trades_24h
)
SELECT
  mint, slug, name, symbol, description, creator, image_key, status, price_usd, change_24h,
  market_cap_usd, reserve_remaining, reserve_total, reward_per_block, network_power, next_block_at,
  next_epoch_at, created_at, price_sol, decimals, synced_at, discovery_reserve_remaining,
  discovery_reserve_total, discovery_epoch_budget, discovery_epoch_spent, discovery_epoch_ends_at,
  discovery_paused, liquidity_usd, mint_authority_revoked, freeze_authority_revoked,
  liquidity_locked, discovery_synced_at, venue, curve_mining_open, curve_mining_cap,
  curve_mining_mined, curve_mining_unpaid, curve_mining_block_reward, curve_mining_synced_at,
  curve_sell_capacity_sol, curve_sell_capacity_tokens, change_24h_at, volume_24h_usd, trades_24h
FROM tokens_status_rebuild;

DROP TABLE tokens_status_rebuild;

-- The three indexes the rebuilt table has to carry: both from 0001, and the discovery-eligibility
-- index from 0009, which scans status as its leading column.
CREATE INDEX IF NOT EXISTS idx_tokens_status_created ON tokens(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tokens_market_cap ON tokens(market_cap_usd DESC);
CREATE INDEX IF NOT EXISTS idx_tokens_discovery_eligible
  ON tokens(status, discovery_paused, discovery_reserve_remaining);

