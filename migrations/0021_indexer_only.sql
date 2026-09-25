-- 0021_indexer_only.sql
--
-- The Worker stops deciding anything and becomes an indexer of the v2 program.
--
-- Every table below that is dropped held a *decision* the operator used to make: whether a
-- discovery happened, how much it paid, which wallet was held, which mine's reserve was
-- trusted. In v2 all of that is a program account or a program event, so the worker keeps no
-- copy it could disagree with the chain about and no column an operator could set.
--
-- Devnet is wiped for v2 (design section 7), so there is no migration path for game state:
-- the drops are unconditional. Two things survive on purpose because they are not game state
-- and the product owner asked for them - `usernames` (a name registry) and the profile
-- columns of `players` (created_at, the risk advisory mirror) - and they are carried across
-- the rebuilds below.

-- ---- v4 decision and enforcement state: gone --------------------------------------------

DROP TABLE IF EXISTS circuit_breakers;
DROP TABLE IF EXISTS breaker_audit;
DROP TABLE IF EXISTS rng_commitments;
DROP TABLE IF EXISTS discovery_opportunities;
DROP TABLE IF EXISTS reward_claims;
DROP TABLE IF EXISTS mining_reports;
DROP TABLE IF EXISTS mine_reward_state;
DROP TABLE IF EXISTS launch_requests;
DROP TABLE IF EXISTS discoveries;
DROP TABLE IF EXISTS discoveries_new;
DROP TABLE IF EXISTS discoveries_v;

-- Price history. The v4 table stored a USD price derived from an off-chain oracle; v2 keeps the
-- SOL price the program's own venue implies, because that is the only price the program trusts
-- and the only one that can be recomputed from an account read.
DROP TABLE IF EXISTS token_price_samples;
CREATE TABLE IF NOT EXISTS coin_price_samples (
  mint TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  price_sol REAL NOT NULL,
  slot TEXT NOT NULL DEFAULT '0',
  PRIMARY KEY (mint, observed_at)
);
CREATE INDEX IF NOT EXISTS idx_coin_price_samples_mint ON coin_price_samples (mint, observed_at DESC);

-- Trades, rebuilt. v2 emits no trade event, so a fill is indexed from the trade instruction
-- itself: the side and the amount the trader offered, plus the venue's observed spot price at
-- that slot. The two are stored in separate columns because they are different facts.
DROP TABLE IF EXISTS trades;
CREATE TABLE IF NOT EXISTS trades (
  signature TEXT NOT NULL,
  instruction_index INTEGER NOT NULL DEFAULT 0,
  mint TEXT NOT NULL,
  coin TEXT NOT NULL,
  side TEXT NOT NULL,
  venue TEXT NOT NULL DEFAULT 'curve',
  amount_in TEXT NOT NULL DEFAULT '0',
  price_sol REAL NOT NULL DEFAULT 0,
  block_time INTEGER NOT NULL DEFAULT 0,
  slot TEXT NOT NULL DEFAULT '0',
  indexed_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (signature, instruction_index)
);
CREATE INDEX IF NOT EXISTS idx_trades_mint_time ON trades (mint, block_time DESC);

-- The v4 off-chain mining position. In v2 a MiningPosition is a PDA under
-- [b"position", coin, owner] and this table becomes a mirror of it, written only by the
-- indexer. Dropped and rebuilt rather than altered because none of its columns (assigned
-- power pushed by a keeper, an off-chain expiry) mean the same thing in v2.
DROP TABLE IF EXISTS mining_positions;

-- ---- indexed v2 state -------------------------------------------------------------------

-- One row per Coin PDA, written only from a decoded account. The ledger columns are the
-- program's own numbers; nothing here is computed by the worker except the display
-- conversions, which are stored separately from the raw values so a conversion bug can never
-- be mistaken for a chain fact.
CREATE TABLE IF NOT EXISTS coins (
  coin TEXT PRIMARY KEY,
  mint TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL,
  creator TEXT NOT NULL,
  vault TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  symbol TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  image_key TEXT,
  decimals INTEGER NOT NULL DEFAULT 6,
  status TEXT NOT NULL,
  -- Raw program values. Every amount is lamports or base units, never a float.
  total_supply TEXT NOT NULL DEFAULT '0',
  reserve_remaining TEXT NOT NULL DEFAULT '0',
  discovery_remaining TEXT NOT NULL DEFAULT '0',
  outstanding_claims TEXT NOT NULL DEFAULT '0',
  cumulative_distributed TEXT NOT NULL DEFAULT '0',
  total_power TEXT NOT NULL DEFAULT '0',
  bonded_power TEXT NOT NULL DEFAULT '0',
  starter_power TEXT NOT NULL DEFAULT '0',
  reward_index TEXT NOT NULL DEFAULT '0',
  current_block_reward TEXT NOT NULL DEFAULT '0',
  block_interval INTEGER NOT NULL DEFAULT 0,
  next_block_at INTEGER NOT NULL DEFAULT 0,
  epoch_index INTEGER NOT NULL DEFAULT 0,
  epoch_length INTEGER NOT NULL DEFAULT 0,
  epoch_ends_at INTEGER NOT NULL DEFAULT 0,
  epoch_ends_slot TEXT NOT NULL DEFAULT '0',
  reduction_bps INTEGER NOT NULL DEFAULT 0,
  minimum_reward TEXT NOT NULL DEFAULT '0',
  token_reserve TEXT NOT NULL DEFAULT '0',
  sol_reserve TEXT NOT NULL DEFAULT '0',
  virtual_sol_reserve TEXT NOT NULL DEFAULT '0',
  graduation_target TEXT NOT NULL DEFAULT '0',
  creator_fee_claimable TEXT NOT NULL DEFAULT '0',
  platform_fee_claimable TEXT NOT NULL DEFAULT '0',
  creator_fee_bps INTEGER NOT NULL DEFAULT 0,
  platform_fee_bps INTEGER NOT NULL DEFAULT 0,
  curve_mining_cap TEXT NOT NULL DEFAULT '0',
  curve_mining_mined TEXT NOT NULL DEFAULT '0',
  curve_mining_unpaid TEXT NOT NULL DEFAULT '0',
  curve_mining_block_reward TEXT NOT NULL DEFAULT '0',
  curve_mining_open INTEGER NOT NULL DEFAULT 0,
  graduated INTEGER NOT NULL DEFAULT 0,
  curve_phase_ends_at INTEGER NOT NULL DEFAULT 0,
  discovery_reserve_total TEXT NOT NULL DEFAULT '0',
  discovery_epoch_budget TEXT NOT NULL DEFAULT '0',
  discovery_epoch_spent TEXT NOT NULL DEFAULT '0',
  discovery_epoch_index INTEGER NOT NULL DEFAULT 0,
  discovery_paused INTEGER NOT NULL DEFAULT 0,
  epoch_seed TEXT,
  epoch_seed_epoch INTEGER NOT NULL DEFAULT 0,
  epoch_seed_target_slot TEXT NOT NULL DEFAULT '0',
  epoch_seed_recorded_slot TEXT NOT NULL DEFAULT '0',
  version INTEGER NOT NULL DEFAULT 0,
  account_slot INTEGER NOT NULL DEFAULT 0,
  indexed_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_coins_status ON coins (status, indexed_at DESC);
CREATE INDEX IF NOT EXISTS idx_coins_creator ON coins (creator);

-- The `tokens` table is the public read model the frontend consumes (`/api/tokens`). It is
-- rebuilt from `coins` plus the indexed trade window: it carries no value-bearing field that
-- does not also exist in `coins`, and every number in it is either a raw program value or a
-- labelled display conversion.
DROP TABLE IF EXISTS tokens;
CREATE TABLE IF NOT EXISTS tokens (
  mint TEXT PRIMARY KEY,
  coin TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  symbol TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  creator TEXT NOT NULL,
  image_key TEXT,
  decimals INTEGER NOT NULL DEFAULT 6,
  status TEXT NOT NULL,
  -- Display conversions, recomputed on every sync from the raw values above.
  price_sol REAL NOT NULL DEFAULT 0,
  price_usd REAL NOT NULL DEFAULT 0,
  market_cap_usd REAL NOT NULL DEFAULT 0,
  liquidity_sol REAL NOT NULL DEFAULT 0,
  liquidity_usd REAL NOT NULL DEFAULT 0,
  reserve_remaining REAL NOT NULL DEFAULT 0,
  reserve_total REAL NOT NULL DEFAULT 0,
  discovery_reserve_remaining REAL NOT NULL DEFAULT 0,
  discovery_reserve_total REAL NOT NULL DEFAULT 0,
  reward_per_block REAL NOT NULL DEFAULT 0,
  network_power REAL NOT NULL DEFAULT 0,
  bonded_power REAL NOT NULL DEFAULT 0,
  starter_power REAL NOT NULL DEFAULT 0,
  venue TEXT NOT NULL DEFAULT 'curve',
  next_block_at INTEGER NOT NULL DEFAULT 0,
  next_epoch_at INTEGER NOT NULL DEFAULT 0,
  epoch_index INTEGER NOT NULL DEFAULT 0,
  epoch_seed_epoch INTEGER NOT NULL DEFAULT 0,
  epoch_seed_committed INTEGER NOT NULL DEFAULT 0,
  graduated INTEGER NOT NULL DEFAULT 0,
  discovery_paused INTEGER NOT NULL DEFAULT 0,
  -- Measured from this coin's own indexed trades; null-ish when it cannot be measured.
  change_24h REAL NOT NULL DEFAULT 0,
  change_24h_at INTEGER NOT NULL DEFAULT 0,
  volume_24h_usd REAL NOT NULL DEFAULT 0,
  trades_24h INTEGER NOT NULL DEFAULT 0,
  synced_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tokens_status ON tokens (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tokens_market_cap ON tokens (market_cap_usd DESC);

-- One row per LiquidityPool PDA. The pool is the post-graduation venue and the only price
-- the program itself trusts (its TWAP), so the indexer mirrors it whole.
CREATE TABLE IF NOT EXISTS pools (
  pool TEXT PRIMARY KEY,
  coin TEXT NOT NULL,
  mint TEXT NOT NULL UNIQUE,
  token_vault TEXT NOT NULL,
  sol_vault TEXT NOT NULL,
  token_reserve TEXT NOT NULL DEFAULT '0',
  sol_reserve TEXT NOT NULL DEFAULT '0',
  graduated_at INTEGER NOT NULL DEFAULT 0,
  cum_price_lamports_per_unit TEXT NOT NULL DEFAULT '0',
  last_update_slot TEXT NOT NULL DEFAULT '0',
  account_slot INTEGER NOT NULL DEFAULT 0,
  indexed_at INTEGER NOT NULL DEFAULT 0
);

-- One row per PlayerAccount PDA. The game state columns are mirrors of the program's own
-- fields; `risk_state` and `risk_score` are the off-chain advisory layer, which by design has
-- no on-chain effect (design section 5).
CREATE TABLE IF NOT EXISTS player_accounts (
  player TEXT PRIMARY KEY,
  wallet TEXT NOT NULL UNIQUE,
  created_slot TEXT NOT NULL DEFAULT '0',
  created_at INTEGER NOT NULL DEFAULT 0,
  active_until INTEGER NOT NULL DEFAULT 0,
  last_activation_at INTEGER NOT NULL DEFAULT 0,
  streak INTEGER NOT NULL DEFAULT 0,
  longest_streak INTEGER NOT NULL DEFAULT 0,
  valid_activations INTEGER NOT NULL DEFAULT 0,
  active_days INTEGER NOT NULL DEFAULT 0,
  last_active_day INTEGER NOT NULL DEFAULT 0,
  streak_freezes INTEGER NOT NULL DEFAULT 0,
  miners_level INTEGER NOT NULL DEFAULT 0,
  drills_level INTEGER NOT NULL DEFAULT 0,
  carts_level INTEGER NOT NULL DEFAULT 0,
  foreman_level INTEGER NOT NULL DEFAULT 0,
  storage_level INTEGER NOT NULL DEFAULT 0,
  ore_balance TEXT NOT NULL DEFAULT '0',
  ore_earned TEXT NOT NULL DEFAULT '0',
  ore_spent TEXT NOT NULL DEFAULT '0',
  ore_accrued_at INTEGER NOT NULL DEFAULT 0,
  active_mine TEXT NOT NULL DEFAULT '',
  day_index INTEGER NOT NULL DEFAULT 0,
  week_index INTEGER NOT NULL DEFAULT 0,
  spent_day_lamports TEXT NOT NULL DEFAULT '0',
  spent_week_lamports TEXT NOT NULL DEFAULT '0',
  roll_window INTEGER NOT NULL DEFAULT 0,
  roll_count INTEGER NOT NULL DEFAULT 0,
  last_roll_at INTEGER NOT NULL DEFAULT 0,
  bond_lamports TEXT NOT NULL DEFAULT '0',
  bond_locked_at INTEGER NOT NULL DEFAULT 0,
  unbond_available_at INTEGER NOT NULL DEFAULT 0,
  bond_source INTEGER NOT NULL DEFAULT 0,
  bond_sponsor_vault TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 0,
  account_slot INTEGER NOT NULL DEFAULT 0,
  indexed_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_player_accounts_bond ON player_accounts (bond_lamports DESC);
CREATE INDEX IF NOT EXISTS idx_player_accounts_active_until ON player_accounts (active_until DESC);

-- One row per MiningPosition PDA, written only by the indexer.
CREATE TABLE IF NOT EXISTS mining_positions_v2 (
  position TEXT PRIMARY KEY,
  coin TEXT NOT NULL,
  owner TEXT NOT NULL,
  assigned_power TEXT NOT NULL DEFAULT '0',
  last_reward_index TEXT NOT NULL DEFAULT '0',
  pending_reward TEXT NOT NULL DEFAULT '0',
  tranche INTEGER NOT NULL DEFAULT 0,
  created_slot TEXT NOT NULL DEFAULT '0',
  account_slot INTEGER NOT NULL DEFAULT 0,
  indexed_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_positions_v2_owner ON mining_positions_v2 (owner);
CREATE INDEX IF NOT EXISTS idx_positions_v2_coin ON mining_positions_v2 (coin);

-- Discovery, indexed from the program's own events and account closes. The opportunity PDA is
-- the authority on whether a roll happened; this table is a readable projection of it.
CREATE TABLE IF NOT EXISTS discovery_events (
  id TEXT PRIMARY KEY,
  opportunity TEXT NOT NULL,
  coin TEXT NOT NULL,
  wallet TEXT NOT NULL,
  window_index INTEGER NOT NULL DEFAULT 0,
  day_index INTEGER NOT NULL DEFAULT 0,
  epoch_index INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  rarity INTEGER,
  units TEXT,
  value_lamports TEXT,
  budget_lamports TEXT NOT NULL DEFAULT '0',
  signature TEXT NOT NULL,
  slot INTEGER NOT NULL DEFAULT 0,
  block_time INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_discovery_events_opportunity ON discovery_events (opportunity);
CREATE INDEX IF NOT EXISTS idx_discovery_events_wallet ON discovery_events (wallet, block_time DESC);
CREATE INDEX IF NOT EXISTS idx_discovery_events_coin ON discovery_events (coin, block_time DESC);

-- Every committed epoch seed, per (coin, epoch). This is what makes every past outcome
-- recomputable by anyone: sha256(seed || owner || window) is public, so a client can check a
-- payout without trusting the indexer. Recorded from EpochSeedCommitted, never invented.
CREATE TABLE IF NOT EXISTS epoch_seeds (
  coin TEXT NOT NULL,
  epoch_index INTEGER NOT NULL,
  seed TEXT NOT NULL,
  target_slot TEXT NOT NULL DEFAULT '0',
  recorded_slot TEXT NOT NULL DEFAULT '0',
  signature TEXT NOT NULL,
  block_time INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (coin, epoch_index)
);

-- Reward claims, indexed from RewardsClaimed. The player's own signed claim_rewards is the
-- only thing that pays; this is the receipt log the profile and leaderboards read.
CREATE TABLE IF NOT EXISTS reward_events (
  signature TEXT NOT NULL,
  event_index INTEGER NOT NULL DEFAULT 0,
  coin TEXT NOT NULL,
  wallet TEXT NOT NULL,
  amount TEXT NOT NULL DEFAULT '0',
  slot INTEGER NOT NULL DEFAULT 0,
  block_time INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (signature, event_index)
);
CREATE INDEX IF NOT EXISTS idx_reward_events_wallet ON reward_events (wallet, block_time DESC);

-- The generic event log: one row per decoded v2 event. `payload` keeps the decoded body as
-- JSON so a new read model can be built without re-reading the chain, and `name` is the
-- CONTRACTS.md event name.
CREATE TABLE IF NOT EXISTS coin_events (
  signature TEXT NOT NULL,
  event_index INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  coin TEXT,
  wallet TEXT,
  slot INTEGER NOT NULL DEFAULT 0,
  block_time INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (signature, event_index)
);
CREATE INDEX IF NOT EXISTS idx_coin_events_name ON coin_events (name, slot DESC);
CREATE INDEX IF NOT EXISTS idx_coin_events_coin ON coin_events (coin, slot DESC);

-- Sponsor accounts, mirrored. Sponsorship pays rent and fees and can never touch power,
-- rewards, discovery odds, rarity, caps or eligibility, so nothing here is read by any
-- payout path.
CREATE TABLE IF NOT EXISTS sponsor_vaults (
  vault TEXT PRIMARY KEY,
  sponsor_owner TEXT NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 0,
  total_funded TEXT NOT NULL DEFAULT '0',
  total_spent TEXT NOT NULL DEFAULT '0',
  total_withdrawn TEXT NOT NULL DEFAULT '0',
  account_slot INTEGER NOT NULL DEFAULT 0,
  indexed_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sponsor_events (
  event TEXT PRIMARY KEY,
  vault TEXT NOT NULL,
  kind INTEGER NOT NULL DEFAULT 0,
  kind_name TEXT NOT NULL DEFAULT 'UNKNOWN',
  start_at INTEGER NOT NULL DEFAULT 0,
  end_at INTEGER NOT NULL DEFAULT 0,
  budget_lamports TEXT NOT NULL DEFAULT '0',
  spent_lamports TEXT NOT NULL DEFAULT '0',
  per_coin_limit_lamports TEXT NOT NULL DEFAULT '0',
  per_wallet_limit_lamports TEXT NOT NULL DEFAULT '0',
  paused INTEGER NOT NULL DEFAULT 0,
  account_slot INTEGER NOT NULL DEFAULT 0,
  indexed_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sponsor_events_window ON sponsor_events (start_at, end_at);
CREATE TABLE IF NOT EXISTS sponsor_grants (
  grant TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  subject TEXT NOT NULL,
  spent_lamports TEXT NOT NULL DEFAULT '0',
  waived_fee_lamports TEXT NOT NULL DEFAULT '0',
  wallet_spent_lamports TEXT NOT NULL DEFAULT '0',
  created_slot TEXT NOT NULL DEFAULT '0',
  account_slot INTEGER NOT NULL DEFAULT 0,
  indexed_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sponsor_grants_event ON sponsor_grants (event);

-- The protocol-wide daily discovery budget, mirrored for display. The cap itself is enforced
-- on-chain by the GlobalBudget PDA; this row is how the UI can show headroom without an RPC.
CREATE TABLE IF NOT EXISTS global_budgets (
  day_index INTEGER PRIMARY KEY,
  cap_lamports TEXT NOT NULL DEFAULT '0',
  spent_lamports TEXT NOT NULL DEFAULT '0',
  roll_count INTEGER NOT NULL DEFAULT 0,
  settled_count INTEGER NOT NULL DEFAULT 0,
  closed INTEGER NOT NULL DEFAULT 0,
  account_slot INTEGER NOT NULL DEFAULT 0,
  indexed_at INTEGER NOT NULL DEFAULT 0
);

-- The single ProtocolConfig snapshot. Governance parameters, mirrored so the read API can
-- serve the fee split, the bond parameters and the caps without an RPC round trip.
CREATE TABLE IF NOT EXISTS protocol_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  authority TEXT NOT NULL,
  treasury TEXT NOT NULL,
  crank_pool TEXT NOT NULL,
  creator_fee_bps INTEGER NOT NULL DEFAULT 0,
  platform_fee_bps INTEGER NOT NULL DEFAULT 0,
  crank_pool_fee_bps INTEGER NOT NULL DEFAULT 0,
  bond_lamports TEXT NOT NULL DEFAULT '0',
  bond_cooldown_seconds INTEGER NOT NULL DEFAULT 0,
  starter_efficiency_bps INTEGER NOT NULL DEFAULT 0,
  starter_tranche_bps INTEGER NOT NULL DEFAULT 0,
  discovery_daily_cap_lamports TEXT NOT NULL DEFAULT '0',
  discovery_weekly_cap_lamports TEXT NOT NULL DEFAULT '0',
  discovery_global_daily_cap_lamports TEXT NOT NULL DEFAULT '0',
  discovery_epoch_budget_lamports TEXT NOT NULL DEFAULT '0',
  paused_flags INTEGER NOT NULL DEFAULT 0,
  paused_until INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL,
  account_slot INTEGER NOT NULL DEFAULT 0,
  indexed_at INTEGER NOT NULL DEFAULT 0
);

-- ---- indexer bookkeeping ----------------------------------------------------------------

-- One cursor per indexed stream, so a cron poll resumes where the last one stopped instead of
-- re-reading the whole program. `cursor` is a signature or a slot depending on `kind`.
CREATE TABLE IF NOT EXISTS indexer_cursors (
  kind TEXT PRIMARY KEY,
  cursor TEXT NOT NULL DEFAULT '',
  slot INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

-- One row per indexer pass. Purely diagnostic: a pass that failed is recorded and retried, and
-- nothing in the game depends on it.
CREATE TABLE IF NOT EXISTS indexer_runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  started_at INTEGER NOT NULL DEFAULT 0,
  finished_at INTEGER NOT NULL DEFAULT 0,
  accounts INTEGER NOT NULL DEFAULT 0,
  events INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'RUNNING',
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_indexer_runs_started ON indexer_runs (started_at DESC);

-- The optional crank bot's own log. The crank is permissionless and holds a hot key only to
-- pay transaction fees: it has no authority over any account and no instruction it sends is
-- one a stranger could not send (design section 6).
CREATE TABLE IF NOT EXISTS crank_runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  coin TEXT,
  signature TEXT,
  status TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_crank_runs_created ON crank_runs (created_at DESC);

-- Advisory risk state stays, because it is what the design keeps off-chain on purpose: it can
-- flag, rate limit HTTP surfaces and inform support, and it cannot lower a player's on-chain
-- power, freeze a position or touch ORE, crew levels, claims or reserves.
CREATE TABLE IF NOT EXISTS advisory_alerts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  subject TEXT,
  severity TEXT NOT NULL DEFAULT 'INFO',
  detail TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_advisory_alerts_created ON advisory_alerts (created_at DESC);

-- ---- rebuild `players` as a profile + advisory row --------------------------------------

-- `players` used to hold the game: crew levels, ORE, activation, streak. All of that is now
-- the on-chain PlayerAccount, mirrored in `player_accounts`. What is left here is what has no
-- on-chain form: the profile row that exists before a wallet ever activates, and the risk
-- advisory columns. The rows themselves are carried over.

-- The social and risk tables still use players as a wallet registry, but they do not need SQLite
-- to enforce that relationship: the Worker creates profile rows before writing any of their
-- child rows, and the registry is rebuilt below. D1 cannot disable foreign keys inside the
-- migration transaction, so copy these small tables into definitions without the parent
-- constraint before replacing `players`. Each table's original shape, rows and indexes survive.
DROP TABLE IF EXISTS risk_events_rebuilt;
CREATE TABLE risk_events_rebuilt (
  id TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
INSERT INTO risk_events_rebuilt (id, wallet, kind, detail, created_at)
  SELECT id, wallet, kind, detail, created_at FROM risk_events;
DROP TABLE risk_events;
ALTER TABLE risk_events_rebuilt RENAME TO risk_events;
CREATE INDEX IF NOT EXISTS idx_risk_events_wallet_created ON risk_events(wallet, created_at DESC);

DROP TABLE IF EXISTS seasonal_points_rebuilt;
CREATE TABLE seasonal_points_rebuilt (
  wallet TEXT NOT NULL,
  season_id TEXT NOT NULL,
  points INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (wallet, season_id)
);
INSERT INTO seasonal_points_rebuilt (wallet, season_id, points, updated_at)
  SELECT wallet, season_id, points, updated_at FROM seasonal_points;
DROP TABLE seasonal_points;
ALTER TABLE seasonal_points_rebuilt RENAME TO seasonal_points;
CREATE INDEX IF NOT EXISTS idx_seasonal_points_season ON seasonal_points(season_id, points DESC);

DROP TABLE IF EXISTS seasonal_point_events_rebuilt;
CREATE TABLE seasonal_point_events_rebuilt (
  id TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  season_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  points INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (wallet, season_id, kind, ref)
);
INSERT INTO seasonal_point_events_rebuilt (id, wallet, season_id, kind, ref, points, created_at)
  SELECT id, wallet, season_id, kind, ref, points, created_at FROM seasonal_point_events;
DROP TABLE seasonal_point_events;
ALTER TABLE seasonal_point_events_rebuilt RENAME TO seasonal_point_events;
CREATE INDEX IF NOT EXISTS idx_seasonal_point_events_wallet
  ON seasonal_point_events(wallet, created_at DESC);

DROP TABLE IF EXISTS player_achievements_rebuilt;
CREATE TABLE player_achievements_rebuilt (
  wallet TEXT NOT NULL,
  achievement_id TEXT NOT NULL,
  ore_granted INTEGER NOT NULL DEFAULT 0 CHECK (ore_granted >= 0),
  awarded_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (wallet, achievement_id)
);
INSERT INTO player_achievements_rebuilt (wallet, achievement_id, ore_granted, awarded_at)
  SELECT wallet, achievement_id, ore_granted, awarded_at FROM player_achievements;
DROP TABLE player_achievements;
ALTER TABLE player_achievements_rebuilt RENAME TO player_achievements;
CREATE INDEX IF NOT EXISTS idx_player_achievements_achievement
  ON player_achievements(achievement_id);

DROP TABLE IF EXISTS player_cosmetics_rebuilt;
CREATE TABLE player_cosmetics_rebuilt (
  wallet TEXT NOT NULL,
  cosmetic_id TEXT NOT NULL,
  acquired_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (wallet, cosmetic_id)
);
INSERT INTO player_cosmetics_rebuilt (wallet, cosmetic_id, acquired_at)
  SELECT wallet, cosmetic_id, acquired_at FROM player_cosmetics;
DROP TABLE player_cosmetics;
ALTER TABLE player_cosmetics_rebuilt RENAME TO player_cosmetics;

DROP TABLE IF EXISTS player_loadout_rebuilt;
CREATE TABLE player_loadout_rebuilt (
  wallet TEXT NOT NULL,
  slot TEXT NOT NULL,
  cosmetic_id TEXT NOT NULL,
  equipped_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (wallet, slot)
);
INSERT INTO player_loadout_rebuilt (wallet, slot, cosmetic_id, equipped_at)
  SELECT wallet, slot, cosmetic_id, equipped_at FROM player_loadout;
DROP TABLE player_loadout;
ALTER TABLE player_loadout_rebuilt RENAME TO player_loadout;

DROP TABLE IF EXISTS player_social_metrics_rebuilt;
CREATE TABLE player_social_metrics_rebuilt (
  wallet TEXT PRIMARY KEY,
  blocks_won INTEGER NOT NULL DEFAULT 0,
  mine_switches INTEGER NOT NULL DEFAULT 0,
  fully_mined_witnessed INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
INSERT INTO player_social_metrics_rebuilt
  (wallet, blocks_won, mine_switches, fully_mined_witnessed, updated_at)
  SELECT wallet, blocks_won, mine_switches, fully_mined_witnessed, updated_at
    FROM player_social_metrics;
DROP TABLE player_social_metrics;
ALTER TABLE player_social_metrics_rebuilt RENAME TO player_social_metrics;

DROP TABLE IF EXISTS notifications_rebuilt;
CREATE TABLE notifications_rebuilt (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  dedupe_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  read_at INTEGER
);
INSERT INTO notifications_rebuilt
  (id, wallet, kind, payload, dedupe_key, created_at, read_at)
  SELECT id, wallet, kind, payload, dedupe_key, created_at, read_at FROM notifications;
DROP TABLE notifications;
ALTER TABLE notifications_rebuilt RENAME TO notifications;
CREATE INDEX IF NOT EXISTS idx_notifications_wallet_created
  ON notifications(wallet, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_wallet_unread
  ON notifications(wallet, read_at, created_at DESC);

DROP TABLE IF EXISTS players_v2;
CREATE TABLE players_v2 (
  wallet TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL DEFAULT 0,
  risk_state TEXT NOT NULL DEFAULT 'NORMAL',
  risk_score INTEGER NOT NULL DEFAULT 0,
  indexed_at INTEGER,
  active_mint TEXT,
  last_activation_at INTEGER,
  activation_expires_at INTEGER,
  ore_balance TEXT,
  streak INTEGER,
  streak_freezes INTEGER,
  active_days INTEGER
);
INSERT INTO players_v2 (wallet, created_at, risk_state, risk_score, active_mint,
                        last_activation_at, activation_expires_at, ore_balance, streak,
                        streak_freezes, active_days)
SELECT wallet,
       COALESCE(created_at, 0),
       COALESCE(risk_state, 'NORMAL'),
       COALESCE(risk_score, 0),
       active_mint,
       last_activation_at,
       activation_expires_at,
       CAST(COALESCE(ore_balance, 0) AS TEXT),
       COALESCE(streak, 0),
       COALESCE(streak_freezes, 0),
       COALESCE(active_days, 0)
  FROM players;
DROP TABLE players;
ALTER TABLE players_v2 RENAME TO players;

-- ---- indexes the old tree left behind ---------------------------------------------------

DROP INDEX IF EXISTS idx_mining_positions_wallet;
DROP INDEX IF EXISTS idx_mining_positions_expiry;
DROP INDEX IF EXISTS idx_reward_claims_wallet;
DROP INDEX IF EXISTS idx_reward_claims_status;
DROP INDEX IF EXISTS idx_reward_claims_paid;
DROP INDEX IF EXISTS idx_discoveries_wallet_created;
DROP INDEX IF EXISTS idx_discoveries_mint_created;
DROP INDEX IF EXISTS idx_discoveries_status;
DROP INDEX IF EXISTS idx_discoveries_created;
DROP INDEX IF EXISTS idx_discoveries_event;
DROP INDEX IF EXISTS idx_discovery_opportunities_status;
DROP INDEX IF EXISTS idx_discovery_opportunities_wallet_created;
DROP INDEX IF EXISTS idx_discovery_opportunities_event;
DROP INDEX IF EXISTS idx_mining_reports_wallet;
DROP INDEX IF EXISTS idx_circuit_breakers_scope_mint;
DROP INDEX IF EXISTS idx_breaker_audit_created;
DROP INDEX IF EXISTS idx_rng_commitments_ends;
DROP INDEX IF EXISTS idx_tokens_discovery_eligible;

-- Reconciliation stays, but as an advisory comparison of the index against the chain: it can
-- raise an alert and it can no longer halt anything, because there is nothing left for the
-- worker to halt.
CREATE TABLE IF NOT EXISTS index_reconcile_runs (
  id TEXT PRIMARY KEY,
  coin TEXT,
  checked_at INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'OK',
  divergence_kind TEXT,
  index_value TEXT,
  chain_value TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_index_reconcile_checked ON index_reconcile_runs (checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_index_reconcile_coin ON index_reconcile_runs (coin, checked_at DESC);
