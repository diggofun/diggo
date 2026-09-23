-- W-ORACLE: manipulation-resistant discovery valuation (spec 25-27) and verifiable RNG (spec 55).
--
-- Two additions:
--
--   * rng_commitments - one commit-reveal record per discovery RNG epoch. The commitment,
--     sha256(seed), is published BEFORE the epoch it governs; the seed itself is only readable
--     after that epoch has ended. Both checks are enforced here, not in an endpoint: seed stays
--     NULL until the guarded reveal UPDATE, and the commitment is UNIQUE so a seed cannot be
--     swapped for a second one behind an already published commitment. Any player can therefore
--     recompute every roll of an epoch and compare it with the discovery they were handed.
--
--   * oracle_price_cache / oracle_sol_usd - the external price observations that
--     worker/oracle.ts combines with the internal trade samples in token_price_samples. These rows
--     are what let the roll path value a token without a blocking third-party HTTP call, and what
--     keeps a single manipulated source from deciding a real-value payout: getRobustPrice() takes
--     the weighted median across sources and refuses to return a price when they disagree beyond
--     the deviation gate or when the freshest observation is too old.

-- 1. Commit-reveal RNG epochs -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rng_commitments (
  epoch INTEGER PRIMARY KEY,
  algorithm TEXT NOT NULL DEFAULT 'hmac-sha256-commit-reveal-v1',
  epoch_seconds INTEGER NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  -- sha256(seed), hex. Published before the epoch, never changed afterwards.
  commitment TEXT NOT NULL UNIQUE,
  -- NULL until the epoch has ended and the reveal has run. Never select this column for a
  -- response without checking ends_at against the current time (see commitmentView).
  seed TEXT,
  revealed_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_rng_commitments_ends ON rng_commitments(ends_at);

-- 2. External price observations ----------------------------------------------------------------
-- One row per (mint, source): the latest observation that source gave us, with both the source's
-- own timestamp (observed_at) and our fetch time (fetched_at) so staleness and cache TTL are
-- separate questions. A failed fetch leaves the previous row alone rather than deleting it, so a
-- transient Jupiter outage degrades to the last known price while the staleness gate still refuses
-- anything older than maxStalenessSeconds.
CREATE TABLE IF NOT EXISTS oracle_price_cache (
  mint TEXT NOT NULL,
  source TEXT NOT NULL,
  price_usd REAL NOT NULL,
  observed_at INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL,
  weight_usd REAL NOT NULL DEFAULT 0,
  reliability REAL NOT NULL DEFAULT 1,
  PRIMARY KEY (mint, source)
);

CREATE INDEX IF NOT EXISTS idx_oracle_price_cache_fetched ON oracle_price_cache(fetched_at);

-- SOL/USD from the same sources, kept separately because every mint's USD value depends on it.
CREATE TABLE IF NOT EXISTS oracle_sol_usd (
  source TEXT PRIMARY KEY,
  price_usd REAL NOT NULL,
  observed_at INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL,
  reliability REAL NOT NULL DEFAULT 1
);
