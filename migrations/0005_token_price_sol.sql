-- price_usd is derived from this at read time via an illustrative, hardcoded SOL/USD rate
-- (see worker/chain.ts) — price_sol is the only value actually read from the chain.
ALTER TABLE tokens ADD COLUMN price_sol REAL NOT NULL DEFAULT 0;
ALTER TABLE tokens ADD COLUMN decimals INTEGER NOT NULL DEFAULT 6;
ALTER TABLE tokens ADD COLUMN synced_at INTEGER NOT NULL DEFAULT 0;
