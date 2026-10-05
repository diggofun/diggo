-- Mine links (diggo.fun/m/<mint>): a player who opens one has their crew dig that mine.
--
-- One row per wallet. The game assigns the preferred mine whenever it is still open and has reserve
-- left; otherwise it falls back to the usual random pick. Deleting the row clears the preference.

CREATE TABLE IF NOT EXISTS game_mine_preferences (
  wallet TEXT PRIMARY KEY NOT NULL,
  mint TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
