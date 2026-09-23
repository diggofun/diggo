-- Two pieces of state the accounting has to keep that were being re-derived (spec 30, 40, 53, 61, 64).
--
-- mining_positions.raw_power is the crew's nominal Mining Power at the moment the position was
-- armed, stored next to the effective power it actually brings to a block. The effective power is
-- a function of account age, the device/network cluster and the mine's own total, so it cannot be
-- compared back to a raw crewPower() reading - the reconcile guard did exactly that and re-armed a
-- damped position on every collect. Backfilled from assigned_power, which is never larger than the
-- real power, so an existing row heals on its next arm instead of every collect.
ALTER TABLE mining_positions ADD COLUMN raw_power TEXT NOT NULL DEFAULT '0';
UPDATE mining_positions SET raw_power = assigned_power;

-- reward_claims.held_at is when a claim was parked in HELD. A hold is not the player's fault, so
-- the eligibility window has to stop running while it is in place: released by
-- eligible_until = eligible_until + (now - held_at), instead of a hold that outlives the window
-- destroying the reward it was protecting (spec 53).
ALTER TABLE reward_claims ADD COLUMN held_at INTEGER;

-- mine_reward_state.released / .forfeited are the mine's own ledger counters (spec 17, 19). They
-- cannot be reconstructed from the columns that were already there: `committed` is the *block*
-- level floor of what the index allocated, while every position floors its own share, so the whole
-- tokens the positions hold do not add up to `committed` in a mine with more than one miner, and
-- the sub-token remainders only become dust when a position settles. Storing what applyBlock took
-- out of the reserve and what a forfeit handed back is what lets auditReserve() balance exactly.
-- Backfilled from the reserve balance (released - forfeited == initial - remaining), which is the
-- one thing the old columns did determine.
ALTER TABLE mine_reward_state ADD COLUMN released TEXT NOT NULL DEFAULT '0';
ALTER TABLE mine_reward_state ADD COLUMN forfeited TEXT NOT NULL DEFAULT '0';
UPDATE mine_reward_state
   SET released = MAX(0, CAST(initial_reserve AS INTEGER) - CAST(remaining_reserve AS INTEGER));
