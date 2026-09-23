-- 0022_watchlist_portfolio.sql
--
-- Two off-chain surfaces the profile and the coin list need, and nothing else.
--
-- A watchlist is a set of mints one wallet asked to see again. It is deliberately not game
-- state: no instruction reads it, no payout path consults it, and losing the whole table would
-- cost a player a list of bookmarks. The portfolio has no table at all - it is a projection of
-- the v2 index (coins, tokens, player_accounts, mining_positions_v2, discovery_events,
-- reward_events, trades), so there is nothing here for the Worker to disagree with the chain
-- about, which is the property migration 0021 established.

CREATE TABLE IF NOT EXISTS watchlist (
  wallet TEXT NOT NULL,
  mint TEXT NOT NULL,
  added_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (wallet, mint)
);

-- The list is always read one wallet at a time, newest first.
CREATE INDEX IF NOT EXISTS idx_watchlist_wallet ON watchlist (wallet, added_at DESC);

-- The reverse direction: which wallets follow one coin, for a future "N watchers" count. It is
-- an index rather than a column so the count is one scan and never a full table read.
CREATE INDEX IF NOT EXISTS idx_watchlist_mint ON watchlist (mint);
