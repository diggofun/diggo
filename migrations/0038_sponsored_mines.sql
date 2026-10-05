-- Sponsored mines (worker/sponsored.ts, shared/sponsoredMine.ts).
--
-- A project deposits tokens of an existing classic SPL mint into the mining vault, and an admin
-- registers that deposit as a mine. Bots dig it like a launch, but it pays out immediately: there
-- is no bonding curve to graduate from. The reserve is what the vault held for this mine when it
-- was registered and is released linearly over mining_seconds. CLOSED stops new mining; rewards
-- already earned stay payable.

CREATE TABLE IF NOT EXISTS sponsored_mines (
  mint TEXT PRIMARY KEY NOT NULL,
  symbol TEXT NOT NULL CHECK (symbol <> ''),
  name TEXT NOT NULL CHECK (name <> ''),
  decimals INTEGER NOT NULL CHECK (decimals >= 0 AND decimals <= 18),
  reserve TEXT NOT NULL CHECK (reserve <> '' AND reserve <> '0'),
  sponsor TEXT NOT NULL CHECK (sponsor <> ''),
  sponsor_url TEXT,
  mining_starts_at INTEGER NOT NULL,
  mining_seconds INTEGER NOT NULL CHECK (mining_seconds > 0),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CLOSED')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS sponsored_mines_status ON sponsored_mines (status, mining_starts_at);
