-- Public usernames (shared/username.ts, worker/profile.ts).
--
-- One row per wallet, holding both forms of the name: the display form exactly as the player typed
-- it, and the normalized lowercase form the UNIQUE index is built on. That index is the whole point
-- of this migration: uniqueness is settled by the database, not by a read followed by a write in the
-- Worker, so two wallets asking for the same name at the same moment resolve to one winner and one
-- constraint failure instead of two rows that differ only in case.
--
-- updated_at doubles as the change clock the cooldown in shared/username.ts reads (the cooldown is
-- applied inside the upsert's WHERE clause), and change_count keeps a cheap audit of how often one
-- wallet moved its name. Nothing here is real value: a username is display identity only.

CREATE TABLE IF NOT EXISTS usernames (
  wallet TEXT PRIMARY KEY NOT NULL,
  username TEXT NOT NULL CHECK (username <> ''),
  username_normalized TEXT NOT NULL CHECK (username_normalized <> ''),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  change_count INTEGER NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_usernames_normalized ON usernames(username_normalized);

-- Lookups are always by wallet (the primary key) or by the normalized name (the unique index);
-- no further index is needed for either the profile endpoint or the leaderboard join.
