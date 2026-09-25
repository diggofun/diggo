-- Remove the two disposable devnet Meteora pools before switching diggo.fun to mainnet.
-- Review and run this only against a backup of the target D1 database. It is not a migration.

DELETE FROM meteora_daily_claim_caps
WHERE mint IN (
  'CQuR9Hi8N5AgebN4tUWUDWJyPwgBCXqzbr3ibCmrKBD8',
  'Cy7LSDxcnjgqY96p8GKYZNZNvpoqE6fU44RR5hcsJNrm'
);

DELETE FROM meteora_vault_claims
WHERE mint IN (
  'CQuR9Hi8N5AgebN4tUWUDWJyPwgBCXqzbr3ibCmrKBD8',
  'Cy7LSDxcnjgqY96p8GKYZNZNvpoqE6fU44RR5hcsJNrm'
);

DELETE FROM meteora_vault_operations
WHERE pool IN (
  '8zNuum1zEAbjWGWQ2KSwmAnZj3r654VvWkP7fX3N5VXT',
  '3jxQk6eoio7WeZNXZ3cmNQVApePrLCCA3JuMFqU3Ciu5'
)
OR mint IN (
  'CQuR9Hi8N5AgebN4tUWUDWJyPwgBCXqzbr3ibCmrKBD8',
  'Cy7LSDxcnjgqY96p8GKYZNZNvpoqE6fU44RR5hcsJNrm'
);

DELETE FROM meteora_vault_balances
WHERE mint IN (
  'CQuR9Hi8N5AgebN4tUWUDWJyPwgBCXqzbr3ibCmrKBD8',
  'Cy7LSDxcnjgqY96p8GKYZNZNvpoqE6fU44RR5hcsJNrm'
);

DELETE FROM meteora_swaps
WHERE pool IN (
  '8zNuum1zEAbjWGWQ2KSwmAnZj3r654VvWkP7fX3N5VXT',
  '3jxQk6eoio7WeZNXZ3cmNQVApePrLCCA3JuMFqU3Ciu5'
)
OR mint IN (
  'CQuR9Hi8N5AgebN4tUWUDWJyPwgBCXqzbr3ibCmrKBD8',
  'Cy7LSDxcnjgqY96p8GKYZNZNvpoqE6fU44RR5hcsJNrm'
)
OR config = '5Dtu9MNLM1k4asZgYos2Dm7CU75zkY4QqQSMkt8GGRar';

DELETE FROM game_claims
WHERE mint IN (
  'CQuR9Hi8N5AgebN4tUWUDWJyPwgBCXqzbr3ibCmrKBD8',
  'Cy7LSDxcnjgqY96p8GKYZNZNvpoqE6fU44RR5hcsJNrm'
);

DELETE FROM game_balances
WHERE mint IN (
  'CQuR9Hi8N5AgebN4tUWUDWJyPwgBCXqzbr3ibCmrKBD8',
  'Cy7LSDxcnjgqY96p8GKYZNZNvpoqE6fU44RR5hcsJNrm'
);

DELETE FROM game_discoveries
WHERE mint IN (
  'CQuR9Hi8N5AgebN4tUWUDWJyPwgBCXqzbr3ibCmrKBD8',
  'Cy7LSDxcnjgqY96p8GKYZNZNvpoqE6fU44RR5hcsJNrm'
);

DELETE FROM game_mines
WHERE mint IN (
  'CQuR9Hi8N5AgebN4tUWUDWJyPwgBCXqzbr3ibCmrKBD8',
  'Cy7LSDxcnjgqY96p8GKYZNZNvpoqE6fU44RR5hcsJNrm'
);

-- game_players and referral tables are wallet-wide. Keep those rows, but clear the two
-- devnet mines from any player's active selection.
UPDATE game_players
SET active_mine = NULL,
    active_mining_power = '0',
    updated_at = CAST(strftime('%s', 'now') AS INTEGER)
WHERE active_mine IN (
  'CQuR9Hi8N5AgebN4tUWUDWJyPwgBCXqzbr3ibCmrKBD8',
  'Cy7LSDxcnjgqY96p8GKYZNZNvpoqE6fU44RR5hcsJNrm'
);

DELETE FROM watchlist
WHERE mint IN (
  'CQuR9Hi8N5AgebN4tUWUDWJyPwgBCXqzbr3ibCmrKBD8',
  'Cy7LSDxcnjgqY96p8GKYZNZNvpoqE6fU44RR5hcsJNrm'
);

DELETE FROM coin_price_samples
WHERE mint IN (
  'CQuR9Hi8N5AgebN4tUWUDWJyPwgBCXqzbr3ibCmrKBD8',
  'Cy7LSDxcnjgqY96p8GKYZNZNvpoqE6fU44RR5hcsJNrm'
);

-- Referral identities remain wallet-wide, but these rows describe only the deleted devnet fills.
DELETE FROM trade_participants
WHERE signature IN (
  SELECT signature
  FROM trades
  WHERE mint IN (
    'CQuR9Hi8N5AgebN4tUWUDWJyPwgBCXqzbr3ibCmrKBD8',
    'Cy7LSDxcnjgqY96p8GKYZNZNvpoqE6fU44RR5hcsJNrm'
  )
);

DELETE FROM trades
WHERE mint IN (
  'CQuR9Hi8N5AgebN4tUWUDWJyPwgBCXqzbr3ibCmrKBD8',
  'Cy7LSDxcnjgqY96p8GKYZNZNvpoqE6fU44RR5hcsJNrm'
);

DELETE FROM tokens
WHERE mint IN (
  'CQuR9Hi8N5AgebN4tUWUDWJyPwgBCXqzbr3ibCmrKBD8',
  'Cy7LSDxcnjgqY96p8GKYZNZNvpoqE6fU44RR5hcsJNrm'
);

DELETE FROM meteora_pools
WHERE pool IN (
  '8zNuum1zEAbjWGWQ2KSwmAnZj3r654VvWkP7fX3N5VXT',
  '3jxQk6eoio7WeZNXZ3cmNQVApePrLCCA3JuMFqU3Ciu5'
)
OR base_mint IN (
  'CQuR9Hi8N5AgebN4tUWUDWJyPwgBCXqzbr3ibCmrKBD8',
  'Cy7LSDxcnjgqY96p8GKYZNZNvpoqE6fU44RR5hcsJNrm'
)
OR config = '5Dtu9MNLM1k4asZgYos2Dm7CU75zkY4QqQSMkt8GGRar';

DELETE FROM meteora_config_scan
WHERE config = '5Dtu9MNLM1k4asZgYos2Dm7CU75zkY4QqQSMkt8GGRar';
