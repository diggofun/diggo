-- 0015: Web Push subscriptions, delivery bookkeeping and the optional Telegram link.
--
-- Four new tables and no change to any existing one, so this migration is additive in the
-- strictest sense: it cannot rewrite a row another workstream owns.
--
-- 1. push_subscriptions is the opt-in registry. Notifications are opt-in and default off, so a
--    row exists only after the player turned the device toggle on. The endpoint is UNIQUE because
--    it identifies the *device*, not the wallet: a browser that later signs a second wallet
--    re-points the same row instead of creating a second one, and a browser that re-subscribes
--    updates its keys in place instead of accumulating rows that would each receive the same push.
-- 2. push_deliveries is the at-most-once ledger. A (notification, channel, target) row is claimed
--    with INSERT OR IGNORE *before* the network call, so a cron sweep, a page load and a retried
--    request can never deliver one alert twice. It is the push-side twin of the UNIQUE dedupe_key
--    index notifications already relies on.
-- 3. telegram_links / telegram_link_codes are the optional second channel. A one-time code is
--    minted for a signed-in wallet, and the bot binds a chat only after the player sends that code
--    back. Codes are stored hashed, single-use and short-lived, so a code that leaks from a log or
--    a screenshot cannot be replayed after it is used or after it expires.

-- --- 1. opt-in device registry ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet TEXT NOT NULL,
  -- The push service URL for this browser. UNIQUE: one row per device, whoever is signed in.
  endpoint TEXT NOT NULL UNIQUE,
  -- The device public key (P-256, uncompressed) and auth secret, both base64url. They are used
  -- once per delivery to encrypt the payload for that device and are useless without it.
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  -- Truncated User-Agent, kept only so a player can recognise their own devices in support.
  user_agent TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_success_at INTEGER,
  -- Consecutive failed deliveries. A subscription that keeps failing is disabled rather than
  -- retried forever; the row stays so an operator can see why a device went quiet.
  failure_count INTEGER NOT NULL DEFAULT 0,
  disabled_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_wallet
  ON push_subscriptions(wallet, disabled_at, last_seen_at DESC);

-- --- 2. at-most-once delivery ledger ------------------------------------------------------

CREATE TABLE IF NOT EXISTS push_deliveries (
  notification_id INTEGER NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('webpush', 'telegram')),
  -- The endpoint URL (webpush) or the chat id (telegram): stable for the life of the target, so
  -- re-subscribing with the same endpoint still cannot produce a second copy of one alert.
  target TEXT NOT NULL,
  -- HTTP status of the attempt, or 0 while the claim is in flight.
  status INTEGER NOT NULL DEFAULT 0,
  delivered_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (notification_id, channel, target)
);

CREATE INDEX IF NOT EXISTS idx_push_deliveries_target
  ON push_deliveries(channel, target, delivered_at DESC);

-- --- 3. optional Telegram channel ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS telegram_links (
  wallet TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_delivery_at INTEGER
);

-- One row per minted code. code_hash is SHA-256 of the code the player sends to the bot; the
-- plaintext code is only ever returned to the wallet that asked for it, and consumed_at makes it
-- single-use.
CREATE TABLE IF NOT EXISTS telegram_link_codes (
  code_hash TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_telegram_link_codes_wallet
  ON telegram_link_codes(wallet, expires_at DESC);
