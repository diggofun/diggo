-- Anyone can add an existing coin as a mine (worker/projectMines.ts).
--
-- The mine's reserve is exactly what one deposit transaction moved from the creator's wallet into
-- the mining vault. Recording that transaction makes it single use: one deposit, one mine.

ALTER TABLE sponsored_mines ADD COLUMN deposit_signature TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS sponsored_mines_deposit ON sponsored_mines (deposit_signature) WHERE deposit_signature IS NOT NULL;
CREATE INDEX IF NOT EXISTS sponsored_mines_creator ON sponsored_mines (created_by, created_at);
