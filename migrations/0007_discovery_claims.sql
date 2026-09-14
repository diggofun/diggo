-- Discoveries move PENDING -> ELIGIBLE (existing) -> CLAIMED once the keeper actually pays out
-- the on-chain Discovery Reserve transfer. tx_signature records proof of that payout.
CREATE TABLE IF NOT EXISTS discoveries_new (
  id TEXT PRIMARY KEY,
  wallet TEXT NOT NULL REFERENCES players(wallet),
  mint TEXT NOT NULL,
  symbol TEXT NOT NULL,
  rarity TEXT NOT NULL,
  token_amount REAL NOT NULL,
  value_usd REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ELIGIBLE', 'CLAIMED')),
  tx_signature TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
INSERT INTO discoveries_new (id, wallet, mint, symbol, rarity, token_amount, value_usd, status, created_at)
  SELECT id, wallet, mint, symbol, rarity, token_amount, value_usd, status, created_at FROM discoveries;
DROP TABLE discoveries;
ALTER TABLE discoveries_new RENAME TO discoveries;

CREATE INDEX IF NOT EXISTS idx_discoveries_wallet_created ON discoveries(wallet, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_discoveries_mint_created ON discoveries(mint, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_discoveries_created ON discoveries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_discoveries_status ON discoveries(status);
