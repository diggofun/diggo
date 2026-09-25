-- Keep chart window reads scoped to one pool and recent indexed block times.
CREATE INDEX IF NOT EXISTS idx_meteora_swaps_pool_block_time
  ON meteora_swaps(pool, block_time DESC);
