-- The vault signs its authority slot first; the player later supplies the fee-payer
-- signature. Persist the exact partial wire transaction so retries return identical bytes.
ALTER TABLE meteora_vault_claims ADD COLUMN prepared_transaction TEXT;
ALTER TABLE meteora_vault_claims ADD COLUMN prepared_expires_at INTEGER;
