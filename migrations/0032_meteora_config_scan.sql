-- Free RPC providers commonly disable getProgramAccounts. Remember how far the
-- config-account signature scan has progressed so cron can discover new pools
-- with getSignaturesForAddress and verify each candidate with getAccountInfo.
CREATE TABLE IF NOT EXISTS meteora_config_scan (
  config TEXT PRIMARY KEY,
  signature_cursor TEXT,
  indexed_at INTEGER NOT NULL DEFAULT 0
);
