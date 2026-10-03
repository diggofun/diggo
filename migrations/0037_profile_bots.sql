-- Profile bots (shared/profileBot.ts, worker/profile.ts).
--
-- The avatar a player picks in settings: one shape, one colour and at most one accessory. It sits
-- beside the username as public display identity, so it is keyed by wallet and read by the profile
-- endpoint and the leaderboard join. Values are validated by the Worker against the shared lists;
-- the CHECKs only keep an empty value out.

CREATE TABLE IF NOT EXISTS profile_bots (
  wallet TEXT PRIMARY KEY NOT NULL,
  shape TEXT NOT NULL CHECK (shape <> ''),
  color TEXT NOT NULL CHECK (color <> ''),
  accessory TEXT NOT NULL DEFAULT 'none' CHECK (accessory <> ''),
  updated_at INTEGER NOT NULL
);
