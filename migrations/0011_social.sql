-- Social layer (spec 34 cosmetics, spec 68 leaderboards/seasons, spec 75 notifications).
--
-- Catalog tables (achievements, cosmetics) are seeded at runtime from the canonical constants in
-- shared/social.ts, so there is exactly one source of truth for the catalog. The remaining tables
-- hold per-wallet state. Notification dedupe relies on notifications.dedupe_key being UNIQUE.
PRAGMA foreign_keys = ON;

-- Seasons: a season is a time box for gameplay-progression points, never a token leaderboard.
CREATE TABLE IF NOT EXISTS seasons (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Seasonal points per wallet, stored as a monotone high-water mark so repeated sweeps cannot
-- double count. Points are derived from gameplay only (activations, upgrades, streak milestones,
-- achievements, discoveries) - never from token amounts, holdings or trade volume.
CREATE TABLE IF NOT EXISTS seasonal_points (
  wallet TEXT NOT NULL REFERENCES players(wallet),
  season_id TEXT NOT NULL,
  points INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (wallet, season_id)
);

CREATE INDEX IF NOT EXISTS idx_seasonal_points_season ON seasonal_points(season_id, points DESC);

-- Explicit gameplay point events, for idempotent awarding from future event hooks.
CREATE TABLE IF NOT EXISTS seasonal_point_events (
  id TEXT PRIMARY KEY,
  wallet TEXT NOT NULL REFERENCES players(wallet),
  season_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  points INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (wallet, season_id, kind, ref)
);

CREATE INDEX IF NOT EXISTS idx_seasonal_point_events_wallet ON seasonal_point_events(wallet, created_at DESC);

-- Achievement catalog (mirrors shared/social.ts ACHIEVEMENT_CATALOG; no foreign keys between the
-- catalogs and wallet state so a catalog addition can never break existing rows).
CREATE TABLE IF NOT EXISTS achievements (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  metric TEXT NOT NULL,
  threshold INTEGER NOT NULL,
  ore INTEGER NOT NULL DEFAULT 0 CHECK (ore >= 0),
  badge_id TEXT,
  title_id TEXT,
  seeded_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS player_achievements (
  wallet TEXT NOT NULL REFERENCES players(wallet),
  achievement_id TEXT NOT NULL,
  ore_granted INTEGER NOT NULL DEFAULT 0 CHECK (ore_granted >= 0),
  awarded_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (wallet, achievement_id)
);

CREATE INDEX IF NOT EXISTS idx_player_achievements_achievement ON player_achievements(achievement_id);

-- Cosmetic catalog (mirrors shared/social.ts COSMETIC_CATALOG).
CREATE TABLE IF NOT EXISTS cosmetics (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('earned', 'purchasable')),
  status TEXT NOT NULL CHECK (status IN ('available', 'coming_soon')),
  unlock_kind TEXT CHECK (unlock_kind IN ('streak', 'achievement', 'tier', 'season_points')),
  unlock_ref TEXT,
  seeded_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS player_cosmetics (
  wallet TEXT NOT NULL REFERENCES players(wallet),
  cosmetic_id TEXT NOT NULL,
  acquired_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (wallet, cosmetic_id)
);

-- One equipped cosmetic per slot; a slot is empty when there is no row.
CREATE TABLE IF NOT EXISTS player_loadout (
  wallet TEXT NOT NULL REFERENCES players(wallet),
  slot TEXT NOT NULL,
  cosmetic_id TEXT NOT NULL,
  equipped_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (wallet, slot)
);

-- Counters that feed achievement metrics and that mining/indexing workstreams can increment.
-- Absent rows read as zero, so nothing here blocks another module.
CREATE TABLE IF NOT EXISTS player_social_metrics (
  wallet TEXT PRIMARY KEY REFERENCES players(wallet),
  blocks_won INTEGER NOT NULL DEFAULT 0,
  mine_switches INTEGER NOT NULL DEFAULT 0,
  fully_mined_witnessed INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Notifications (spec 75). dedupe_key is UNIQUE: a repeated sweep inserts nothing.
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet TEXT NOT NULL REFERENCES players(wallet),
  kind TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  dedupe_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  read_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_notifications_wallet_created ON notifications(wallet, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_wallet_unread ON notifications(wallet, read_at, created_at DESC);

-- Default season. The runtime falls back to DEFAULT_SEASON_ID when no row covers now.
INSERT OR IGNORE INTO seasons (id, name, starts_at, ends_at)
VALUES ('s1-genesis', 'Season 1 - Genesis Dig', unixepoch(), unixepoch() + 7776000);
