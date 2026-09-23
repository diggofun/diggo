-- Local-only demo mines.
--
-- This file is deliberately NOT in migrations/: production must never ship demo tokens
-- (migrations/0004_remove_demo_tokens.sql removed the ones that did). It is applied by
--   npm run seed:local
-- which runs it through `wrangler d1 execute diggo-db --local`, so it can only ever touch the
-- local .wrangler/state database.
--
-- The mines are seeded with synced_at = 0 on purpose: with no chain sync and no program id the
-- Worker treats them as OFFCHAIN mines, so D1 is the accounting source and the whole mining loop
-- (activation, streak, block rewards, ORE, discoveries) works locally without devnet.
--
-- Re-running it replaces exactly these three mints and touches nothing else.

DELETE FROM tokens WHERE mint IN (
  'FroG111111111111111111111111111111111111111',
  'DoGGo11111111111111111111111111111111111111',
  'MoLe111111111111111111111111111111111111111'
);

-- FROG: the tutorial mine. Plenty of reserve, a small block reward, discoveries enabled.
INSERT INTO tokens (
  mint, slug, name, symbol, description, creator, status, price_usd, price_sol, decimals,
  market_cap_usd, liquidity_usd, reserve_remaining, reserve_total, reward_per_block, network_power,
  next_block_at, next_epoch_at, created_at,
  discovery_reserve_remaining, discovery_reserve_total, discovery_epoch_budget,
  discovery_epoch_spent, discovery_epoch_ends_at, discovery_paused,
  mint_authority_revoked, freeze_authority_revoked, liquidity_locked, synced_at, discovery_synced_at
) VALUES (
  'FroG111111111111111111111111111111111111111', 'frog', 'Local Frog', 'FROG',
  'Local-only demo mine. Fixed supply, program-controlled reserves.',
  'Creator111111111111111111111111111111111111', 'MINING_ACTIVE',
  0.01, 0.0000667, 6, 1000000, 250000,
  945000, 1000000, 1000, 0,
  unixepoch(), unixepoch() + 604800, unixepoch(),
  4000, 5000, 1000, 0, unixepoch() + 86400, 0,
  1, 1, 1, 0, 0
);

-- DOGGO: a small, almost-mined mine, for testing FULLY_MINED and reward reductions.
INSERT INTO tokens (
  mint, slug, name, symbol, description, creator, status, price_usd, price_sol, decimals,
  market_cap_usd, liquidity_usd, reserve_remaining, reserve_total, reward_per_block, network_power,
  next_block_at, next_epoch_at, created_at,
  discovery_reserve_remaining, discovery_reserve_total, discovery_epoch_budget,
  discovery_epoch_spent, discovery_epoch_ends_at, discovery_paused,
  mint_authority_revoked, freeze_authority_revoked, liquidity_locked, synced_at, discovery_synced_at
) VALUES (
  'DoGGo11111111111111111111111111111111111111', 'doggo', 'Local Doggo', 'DOGGO',
  'Local-only demo mine with a nearly exhausted reserve.',
  'Creator111111111111111111111111111111111111', 'MINING_ACTIVE',
  0.25, 0.0016667, 6, 2500000, 40000,
  12000, 1000000, 250, 0,
  unixepoch(), unixepoch() + 604800, unixepoch(),
  900, 5000, 200, 0, unixepoch() + 86400, 0,
  1, 1, 1, 0, 0
);

-- MOLE: a cheap coin, so a discovery pays out a large unit amount (spec 27 value normalization).
INSERT INTO tokens (
  mint, slug, name, symbol, description, creator, status, price_usd, price_sol, decimals,
  market_cap_usd, liquidity_usd, reserve_remaining, reserve_total, reward_per_block, network_power,
  next_block_at, next_epoch_at, created_at,
  discovery_reserve_remaining, discovery_reserve_total, discovery_epoch_budget,
  discovery_epoch_spent, discovery_epoch_ends_at, discovery_paused,
  mint_authority_revoked, freeze_authority_revoked, liquidity_locked, synced_at, discovery_synced_at
) VALUES (
  'MoLe111111111111111111111111111111111111111', 'mole', 'Local Mole', 'MOLE',
  'Local-only demo mine with a cheap unit price.',
  'Creator111111111111111111111111111111111111', 'MINING_ACTIVE',
  0.0005, 0.0000033, 6, 500000, 30000,
  500000, 500000, 5000, 0,
  unixepoch(), unixepoch() + 604800, unixepoch(),
  5000, 5000, 1000, 0, unixepoch() + 86400, 0,
  1, 1, 1, 0, 0
);
