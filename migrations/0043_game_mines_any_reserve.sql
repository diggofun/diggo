-- game_mines accepted only the default launch reserve (CHECK initial_reserve = 2e17), but sponsored
-- and user-added mines carry their own reserve (worker/game/service.ts passes coinReserve(coin)).
-- With the CHECK in place their ledger row could never be created, so their crews could not accrue.
-- SQLite cannot drop a CHECK in place: rebuild the table without it and keep every other invariant.

CREATE TABLE game_mines_new (
  mint TEXT PRIMARY KEY,
  mining_starts_at INTEGER NOT NULL,
  initial_reserve TEXT NOT NULL,
  released TEXT NOT NULL DEFAULT '0',
  remaining TEXT NOT NULL,
  committed TEXT NOT NULL DEFAULT '0',
  paid TEXT NOT NULL DEFAULT '0',
  total_eligible_power INTEGER NOT NULL DEFAULT 0,
  last_discovery_id TEXT,
  graduated INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  CHECK (CAST(initial_reserve AS INTEGER) > 0),
  CHECK (CAST(released AS INTEGER) >= 0),
  CHECK (CAST(remaining AS INTEGER) >= 0),
  CHECK (CAST(committed AS INTEGER) >= 0 AND CAST(committed AS INTEGER) <= CAST(released AS INTEGER)),
  CHECK (CAST(paid AS INTEGER) >= 0 AND CAST(paid AS INTEGER) <= CAST(committed AS INTEGER)),
  CHECK (CAST(remaining AS INTEGER) = CAST(initial_reserve AS INTEGER) - CAST(committed AS INTEGER))
);

INSERT INTO game_mines_new (mint, mining_starts_at, initial_reserve, released, remaining, committed, paid, total_eligible_power, last_discovery_id, graduated, version, updated_at)
SELECT mint, mining_starts_at, initial_reserve, released, remaining, committed, paid, total_eligible_power, last_discovery_id, graduated, version, updated_at FROM game_mines;

DROP TABLE game_mines;
ALTER TABLE game_mines_new RENAME TO game_mines;
