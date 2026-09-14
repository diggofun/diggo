-- The four tokens seeded in 0001 were hand-written demo rows: their "mints" are not
-- valid Solana pubkeys (devnet RPC rejects them with "Invalid param: WrongSize") and
-- their prices, market caps and reserves were invented. The UI presented them next to
-- a "LIVE ON SOLANA DEVNET" badge, which was misleading. Remove them so the app shows
-- an honest empty state until real launches land on devnet.
DELETE FROM trades WHERE mint IN (
  '9xK2hM7qT4vB8nP6sR3wY5cF1aG7uJ2eL8mN4diggo',
  '4rT8mQ2vN6kY3cW9pF1sJ7aB5eH8uL2xG6zP9diggo',
  '7bV3nK9sQ2mF6wT1yR8cP4aH5eJ9uL3xG2dM8diggo',
  '2mP8xR4vT7kN1sW6cF9yB3aQ5eH8uJ2gL7zD4diggo'
);

DELETE FROM tokens WHERE mint IN (
  '9xK2hM7qT4vB8nP6sR3wY5cF1aG7uJ2eL8mN4diggo',
  '4rT8mQ2vN6kY3cW9pF1sJ7aB5eH8uL2xG6zP9diggo',
  '7bV3nK9sQ2mF6wT1yR8cP4aH5eJ9uL3xG2dM8diggo',
  '2mP8xR4vT7kN1sW6cF9yB3aQ5eH8uJ2gL7zD4diggo'
);
