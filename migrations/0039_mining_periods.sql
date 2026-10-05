-- Mining periods (shared/miningSchedule.ts, worker/miningPeriod.ts).
--
-- A coin's creator, or a sponsored mine's sponsor, chooses how long the mine takes to release its
-- reserve and can change it later. One row per mine holds the latest change: what had been released
-- at that moment (anchor_released, raw units) and when the rest is fully out (ends_at). A mine with
-- no row keeps its original period.

CREATE TABLE IF NOT EXISTS mine_schedules (
  mint TEXT PRIMARY KEY NOT NULL,
  anchor_at INTEGER NOT NULL,
  anchor_released TEXT NOT NULL CHECK (anchor_released <> ''),
  ends_at INTEGER NOT NULL CHECK (ends_at > anchor_at),
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- The sponsor's wallet: it may change its own mine's period. Optional; admins always can.
ALTER TABLE sponsored_mines ADD COLUMN sponsor_wallet TEXT;
