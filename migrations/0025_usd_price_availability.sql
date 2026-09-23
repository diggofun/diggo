-- USD columns are display conversions only. Keep their availability explicit so a zero caused by
-- an unavailable SOL/USD observation is never rendered or interpreted as a real USD valuation.
ALTER TABLE tokens ADD COLUMN usd_price_available INTEGER NOT NULL DEFAULT 0;

UPDATE tokens
SET volume_24h_usd = 0
WHERE usd_price_available = 0;
