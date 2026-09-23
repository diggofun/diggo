//! state::coin.rs (phase 0a mechanical split of lib.rs).

use crate::*;



#[account]
#[derive(InitSpace)]
pub struct Mine {
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub reserve_vault: Pubkey,
    pub discovery_vault: Pubkey,
    pub market_vault: Pubkey,
    pub fee_vault: Pubkey,
    pub total_supply: u64,
    pub remaining_reserve: u64,
    pub remaining_discovery_reserve: u64,
    pub cumulative_distributed: u64,
    pub total_power: u64,
    pub reward_index: u128,
    pub current_block_reward: u64,
    pub block_interval: i64,
    pub next_block_at: i64,
    pub epoch: u64,
    pub epoch_length: i64,
    pub epoch_ends_at: i64,
    pub reduction_bps: u16,
    pub minimum_reward: u64,
    pub status: MineStatus,
    #[max_len(32)]
    pub name: String,
    #[max_len(10)]
    pub symbol: String,
    #[max_len(200)]
    pub uri: String,
    /// Total Discovery Reserve allocated at launch — the denominator of the per-call
    /// and per-epoch caps, so the spend limits stay stable as the reserve drains.
    pub discovery_reserve_total: u64,
    /// Maximum discovery payout for this mine in one discovery epoch, snapshotted at
    /// launch from ProtocolConfigV4.
    pub discovery_epoch_budget: u64,
    pub discovery_epoch_spent: u64,
    pub discovery_epoch_ends_at: i64,
    /// Scoped circuit breaker for this mine's Discovery Reserve only.
    pub discovery_paused: bool,
    pub bump: u8,
    /// Appended layout version (ACCOUNT_VERSION); see ProtocolConfigV4.version.
    pub version: u8,
    /// True while this mine's block rewards are paid out of its market's curve token
    /// inventory instead of its own Mining Reserve. Set at launch whenever the launch
    /// asked for a non-zero curve-mining share, cleared by graduate_market and by the
    /// ledger walk the moment the curve budget is spent.
    ///
    /// It is written from the market by every instruction that holds it (sync_mine_phase),
    /// and it is deliberately conservative: it is false whenever the market may not emit,
    /// including when the curve's own inventory has been bought out below the emission it
    /// still owes. A version 1 account reads it as false, which is exactly the pre-curve
    /// behaviour.
    pub curve_mining_open: bool,
    /// True once this mine's market has graduated into its locked pool.
    ///
    /// This is the mirror the walk actually decides from, and it is deliberately a fact
    /// about the mine rather than about an optional account: whether a block may be paid out
    /// of the curve's inventory or out of the Mining Reserve is a phase, and a phase that
    /// depended on whether the caller happened to hand over the market account would pay from
    /// the wrong side exactly when the account was left out. Every instruction that holds the
    /// market refreshes it (sync_mine_phase), graduate_market sets it, and a walk that is
    /// handed the market reads the market's own flag instead, so the two can never disagree
    /// in the direction that spends the reserve early.
    ///
    /// Pre-graduation is the only phase in which curve_mining_open means anything: the curve
    /// inventory pays while it has room, and once the cap is spent the mine is idle - its
    /// blocks accrue nothing at all and its Mining Reserve is untouched - until graduation.
    /// A version 2 account reads this as false, which is the safe default: a caller without
    /// the market then refuses the walk (SyncBehind) rather than paying from the reserve.
    pub graduated: bool,
    /// The instant this mine's curve phase ended: the graduation timestamp, written by
    /// graduate_market at the same moment it flips `graduated`, and zero for a mine that has
    /// not graduated.
    ///
    /// It is the second half of the phase decision, and it exists to make that decision a fact
    /// about time instead of about walk order. A block that landed before this cursor is
    /// curve-phase for good - the curve's inventory was what paid then - and a block that
    /// landed after it is reserve-phase. The walk classifies every segment against it, so a
    /// graduated mine whose cursor has not been reached yet pays nothing for those blocks
    /// rather than draining the Mining Reserve with emission the curve phase never made.
    ///
    /// In the ordinary path it records a fact rather than creating a gap: graduate_market walks
    /// the ledger to this same instant under the curve phase before it flips the flag, so the
    /// cursor is always where the walk already got to. It only does work when the flag was set
    /// on a mine the walk never reached, which is the case it exists to make harmless.
    ///
    /// A version 3 account reads it as zero, and zero means no cursor: the phase then follows
    /// `graduated` alone, exactly as it did before this field existed.
    pub curve_phase_ends_at: i64,
}


#[account]
#[derive(InitSpace)]
pub struct LaunchMarket {
    pub mine: Pubkey,
    pub token_reserve: u64,
    pub sol_reserve: u64,
    pub virtual_sol_reserve: u64,
    pub graduation_target: u64,
    pub graduated: bool,
    /// Trading fees accrued to the mine's creator, in lamports. Only claim_creator_fees
    /// may pay these out, and never out of sol_reserve (the LP SOL).
    pub creator_fee_claimable: u64,
    /// Trading fees accrued to the protocol treasury, in lamports.
    pub platform_fee_claimable: u64,
    /// Fee schedule snapshotted at launch, so a later config change can never
    /// retroactively alter an existing market.
    pub creator_fee_bps: u16,
    pub platform_fee_bps: u16,
    pub bump: u8,
    /// Appended layout version (ACCOUNT_VERSION); see ProtocolConfigV4.version.
    pub version: u8,
    /// The curve-mining ledger, appended after the version byte so a pre-curve market
    /// still decodes with every one of these fields at its safe default: a zero budget,
    /// which is the pre-curve behaviour of a mine that only emits after graduation.
    ///
    /// The cap is the launch-time share of this market's initial curve token inventory and
    /// is never written again. No instruction other than launch_token assigns it, and
    /// migrate_account can only ever default it to zero, so a migration cannot hand a
    /// legacy market an allowance it was not launched with. curve_mining_mined is
    /// cumulative and may never pass the cap. curve_mining_unpaid is the part of the
    /// mined total the reward index has already credited to positions but no claimer has
    /// received yet, and it is exactly what stops graduation from moving tokens that a
    /// position has already been credited with. Every debit is clamped to the room left
    /// under the cap *and* to the inventory the curve still holds (curve_mining_room), so
    /// a buy that leaves the market holding less than it owes closes the phase instead of
    /// reverting the walk; what the inventory cannot cover is never emitted and never
    /// enters either total. The last base unit of the inventory is reserved rather than
    /// emitted, so a market always has something left to graduate with.
    pub curve_mining_cap: u64,
    pub curve_mining_mined: u64,
    pub curve_mining_unpaid: u64,
    /// Flat per-block output of the curve phase: the cap spread over the launch runway,
    /// rounded up so the budget is always finishable. It is deliberately independent of
    /// the mine's own epoch reduction, which governs the Mining Reserve after graduation.
    pub curve_mining_block_reward: u64,
}


#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, PartialEq, Eq)]
pub enum MineStatus {
    Launching,
    MiningActive,
    FullyMined,
}

// ---- v2 (docs/ONCHAIN_V2_DESIGN.md 1.3(b), 3.2, 4.1, 8.2) --------------------------------

/// The one account that holds a coin: Mine and LaunchMarket merged, the four token vaults
/// replaced by one vault plus this ledger, and the metadata moved into the mint.
///
/// It is also the whole reward ledger. `reward_index` is cumulative over blocks and is split
/// into two indexes by the starter-tranche rule: a bonded position accrues against the
/// bonded index, a starter-mode position against the starter index, and the starter index can
/// never receive more than STARTER_TRANCHE_BPS of any block. Whatever a block cannot assign
/// stays in the Mining Reserve - it is never burned and never moved to the starter index.
///
/// The vault ledger invariant every instruction that touches the vault must end with is
/// `vault.amount >= curve_tokens + reserve_remaining + discovery_remaining + outstanding_claims`.
#[account]
#[derive(Default)]
pub struct Coin {
    pub creator: Pubkey,
    /// The coin's single token vault, PDA under [b"vault", mint].
    pub vault: Pubkey,
    pub total_supply: u64,
    /// Mining Reserve left to emit after graduation.
    pub reserve_remaining: u64,
    /// Discovery Reserve left to pay out.
    pub discovery_remaining: u64,
    /// Part of the index already credited to positions but not yet claimed. Without it the
    /// vault invariant of design 1.3(a) is short by exactly the mined-but-unclaimed amount.
    pub outstanding_claims: u64,
    pub cumulative_distributed: u64,
    pub total_power: u64,
    /// Power of positions accruing in the bonded index.
    pub bonded_power: u64,
    /// Power of positions accruing in the starter index, already scaled by
    /// starter_efficiency_bps.
    pub starter_power: u64,
    /// Cumulative rewards per unit of power, scaled by INDEX_SCALE, over the bonded tranche.
    pub bonded_index: u128,
    /// The same for the starter tranche, advanced by its own capped share of every block.
    ///
    /// This is the second index CONTRACTS.md's starter-tranche amendment now freezes. While the
    /// starter index was *derived* from the bonded one (reward_index * E * T / BPS^2) the
    /// tranche's share of a block was a function of the two powers alone, so the 10% cap could
    /// only hold while starter_power * E * (BPS - T) <= bonded_power * BPS^2, and a coin outside
    /// that regime had to assign nothing at all. A stored index is what lets the walk hold the
    /// cap exactly: the starter tranche is credited its proportional share, clamped to
    /// STARTER_TRANCHE_BPS of the block, and the clamp is representable because nothing derives
    /// one index from the other any more.
    pub starter_index: u128,
    pub current_block_reward: u64,
    pub block_interval: u32,
    pub next_block_at: i64,
    pub epoch_index: u32,
    pub epoch_length: u32,
    pub epoch_ends_at: i64,
    /// Slot this epoch ends at, so the epoch seed target of design 4.1 can be armed from it.
    pub epoch_ends_slot: u64,
    pub reduction_bps: u16,
    pub minimum_reward: u64,
    /// Curve inventory the pre-graduation phase may sell.
    pub token_reserve: u64,
    pub sol_reserve: u64,
    pub virtual_sol_reserve: u64,
    pub graduation_target: u64,
    pub creator_fee_claimable: u64,
    pub platform_fee_claimable: u64,
    pub creator_fee_bps: u16,
    pub platform_fee_bps: u16,
    pub curve_mining_cap: u64,
    pub curve_mining_mined: u64,
    pub curve_mining_unpaid: u64,
    pub curve_mining_block_reward: u64,
    pub curve_mining_open: u8,
    pub graduated: u8,
    pub curve_phase_ends_at: i64,
    pub discovery_reserve_total: u64,
    pub discovery_epoch_budget: u64,
    pub discovery_epoch_spent: u64,
    /// Discovery epoch cursor: which epoch the two counters above belong to.
    pub discovery_epoch_index: u32,
    pub discovery_paused: u8,
    /// TWAP accumulator over this coin's own pool, in lamports per base unit scaled by
    /// PRICE_SCALE, plus the slot it was last updated at. The only price the program trusts.
    pub twap_cum_price_lamports_per_unit: u128,
    pub twap_last_update_slot: u64,
    /// The price that has held since twap_last_update_slot, mirrored from the pool on every
    /// observation. It is what lets a reader extend the accumulator to a slot the pool has not
    /// traded at without holding the pool account, which is the whole reason the discovery path
    /// can price anything at all: its account list carries the coin and not the pool.
    pub twap_last_price: u128,
    /// The short window's anchor: the slot and the accumulator value the window is measured
    /// from, never more than TWAP_WINDOW_SLOTS behind the reader (see roll_twap_window).
    pub twap_window_slot: u64,
    pub twap_window_cum: u128,
    /// The epoch seed of design 4.1 and the slot it was taken from. Frozen contract:
    /// WS-B writes these, WS-C reads them, and they must not move.
    pub epoch_seed: [u8; 32],
    pub epoch_seed_epoch: u32,
    pub epoch_seed_target_slot: u64,
    pub epoch_seed_recorded_slot: u64,
    pub status: u8,
    pub bump: u8,
    pub version: u8,
}

impl Coin {
    /// The borsh body, field by field in declaration order, so a field added without its size
    /// shows up here as a comment that no longer names a field rather than as a number that
    /// still happens to add up. The account-size test pins it against a real borsh round trip,
    /// which is what makes this a contract rather than an estimate.
    pub const LEN: usize = 32 * 2 // creator, vault
        + 8 * 8 // total_supply, both reserves, claims, distributed, three power totals
        + 16 * 2 // bonded_index, starter_index
        + 8 // current_block_reward
        + 4 // block_interval
        + 8 // next_block_at
        + 4 // epoch_index
        + 4 // epoch_length
        + 8 // epoch_ends_at
        + 8 // epoch_ends_slot
        + 2 // reduction_bps
        + 8 // minimum_reward
        + 8 * 6 // token_reserve .. platform_fee_claimable
        + 2 * 2 // creator_fee_bps, platform_fee_bps
        + 8 * 4 // curve_mining_cap .. curve_mining_block_reward
        + 1 // curve_mining_open
        + 1 // graduated
        + 8 // curve_phase_ends_at
        + 8 * 3 // discovery_reserve_total, discovery_epoch_budget, discovery_epoch_spent
        + 4 // discovery_epoch_index
        + 1 // discovery_paused
        + 16 // twap_cum_price_lamports_per_unit
        + 8 // twap_last_update_slot
        + 16 // twap_last_price
        + 8 // twap_window_slot
        + 16 // twap_window_cum
        + 32 // epoch_seed
        + 4 // epoch_seed_epoch
        + 8 // epoch_seed_target_slot
        + 8 // epoch_seed_recorded_slot
        + 3; // status, bump, version
    /// Whole account space, discriminator included.
    pub const SIZE: usize = 8 + Self::LEN;
}

/// Coin lifecycle, kept as a byte so the layout stays explicit.
pub const COIN_STATUS_LAUNCHING: u8 = 0;
pub const COIN_STATUS_MINING_ACTIVE: u8 = 1;
pub const COIN_STATUS_FULLY_MINED: u8 = 2;

// ---- the ledger every vault-touching instruction ends with (design 1.3(a), 8.2) ------------
//
// One token vault holds everything a coin has not distributed yet, so the only separation
// between the curve's inventory, the two reserves and what positions have already been
// credited is this ledger. The invariant is asserted at the end of every instruction that
// touches the vault:
//
//   vault.amount >= curve_tokens + reserve_remaining + discovery_remaining + outstanding_claims
//
// outstanding_claims is what makes it complete: without it the sum is short by exactly the
// mined-but-unclaimed amount and the check is vacuous. The COIN ACCOUNT has a second invariant,
// on its own lamports, because a coin's SOL lives in the account rather than in a vault:
//
//   coin.lamports >= rent_floor + sol_reserve + creator_fee_claimable + platform_fee_claimable

impl Coin {
    /// The rent-exempt floor of a Coin account: what the SOL ledger above is measured from.
    pub fn rent_floor() -> Result<u64> {
        Ok(Rent::get()?.minimum_balance(Self::SIZE))
    }

    /// Everything the single vault still owes, which is exactly what it must hold.
    pub fn ledger_total(&self) -> Result<u64> {
        self.token_reserve
            .checked_add(self.reserve_remaining)
            .and_then(|value| value.checked_add(self.discovery_remaining))
            .and_then(|value| value.checked_add(self.outstanding_claims))
            .ok_or_else(|| error!(DiggoError::LedgerInvariantViolated))
    }

    /// The vault ledger invariant. A vault holding more than the ledger owes is fine - the
    /// surplus is inventory nobody can reach - but holding less means a debit happened without
    /// its ledger entry, which is the one bug this check exists to catch.
    pub fn assert_vault_ledger(&self, vault_amount: u64) -> Result<()> {
        require!(
            vault_amount >= self.ledger_total()?,
            DiggoError::LedgerInvariantViolated
        );
        Ok(())
    }

    /// The lamport ledger of the coin account itself.
    pub fn assert_lamport_ledger(&self, lamports: u64, rent_floor: u64) -> Result<()> {
        let expected = rent_floor
            .checked_add(self.sol_reserve)
            .and_then(|value| value.checked_add(self.creator_fee_claimable))
            .and_then(|value| value.checked_add(self.platform_fee_claimable))
            .ok_or(DiggoError::LedgerInvariantViolated)?;
        require!(lamports >= expected, DiggoError::LedgerInvariantViolated);
        Ok(())
    }

    /// The room left under the immutable curve-mining cap, bounded by the inventory that can
    /// actually pay it. A buy takes tokens out of the curve, so a market can be left holding
    /// less than its cap still allows; the last base unit of the inventory is reserved so a
    /// market always has something left to graduate with.
    pub fn curve_mining_room(&self) -> u64 {
        if self.graduated != 0 {
            return 0;
        }
        self.curve_mining_cap
            .saturating_sub(self.curve_mining_mined)
            .min(self.token_reserve.saturating_sub(1))
    }

    /// True while the pre-graduation phase may still emit: not graduated, a non-zero cap, and
    /// room left under it.
    pub fn curve_mining_is_open(&self) -> bool {
        self.graduated == 0 && self.curve_mining_cap > 0 && self.curve_mining_room() > 0
    }

    /// True while this coin still owes blocks that landed before its graduation cursor. Those
    /// blocks were curve-phase for good, so they may never be paid out of the Mining Reserve,
    /// and a coin that still owes one is not settled however empty its reserve looks.
    pub fn curve_phase_pending(&self) -> bool {
        self.graduated != 0
            && self.curve_phase_ends_at > 0
            && self.next_block_at < self.curve_phase_ends_at
    }

    /// The launch split of one total supply: the Mining Reserve, the Discovery Reserve and the
    /// curve's inventory, in that order. Both reserves round down, so the curve gets the
    /// remainder and the three always add up to the whole supply.
    pub fn split_supply(
        total_supply: u64,
        reserve_bps: u16,
        discovery_reserve_bps: u16,
    ) -> Result<(u64, u64, u64)> {
        require!(
            reserve_bps > 0 && reserve_bps <= BPS as u16,
            DiggoError::InvalidReserveSplit
        );
        let reserve = mul_bps(total_supply, reserve_bps)?;
        let discovery = mul_bps(total_supply, discovery_reserve_bps)?;
        let curve = total_supply
            .checked_sub(reserve)
            .and_then(|value| value.checked_sub(discovery))
            .ok_or(DiggoError::InvalidReserveSplit)?;
        require!(curve > 0 && reserve > 0, DiggoError::InvalidReserveSplit);
        Ok((reserve, discovery, curve))
    }

    /// Credits one block reward out of the Mining Reserve and books it as an outstanding claim.
    ///
    /// The vault does not move: the reward stays in the vault until a claimer takes it, and
    /// outstanding_claims is what records that it is already theirs. This is why the vault
    /// invariant is stated with outstanding_claims in it.
    pub fn emit_from_reserve(&mut self, amount: u64) -> Result<()> {
        require!(amount > 0, DiggoError::InvalidAmount);
        self.reserve_remaining = self
            .reserve_remaining
            .checked_sub(amount)
            .ok_or(DiggoError::InsufficientReserve)?;
        self.outstanding_claims = self
            .outstanding_claims
            .checked_add(amount)
            .ok_or(DiggoError::AccrualOverflow)?;
        self.cumulative_distributed = self
            .cumulative_distributed
            .checked_add(amount)
            .ok_or(DiggoError::AccrualOverflow)?;
        Ok(())
    }

    /// Credits one block reward out of the curve's own inventory, clamped to the room left
    /// under the cap, and returns what was actually emitted.
    ///
    /// The clamp is what keeps the ledger walk from deadlocking: a market whose inventory
    /// cannot cover the emission it still owes emits what is there and closes the phase, rather
    /// than reverting a segment it can never get past. What the inventory cannot cover is never
    /// emitted, never booked as mined and never owed to a position.
    pub fn emit_from_curve(&mut self, wanted: u64) -> Result<u64> {
        let emitted = wanted.min(self.curve_mining_room());
        if emitted == 0 {
            return Ok(0);
        }
        self.token_reserve = self
            .token_reserve
            .checked_sub(emitted)
            .ok_or(DiggoError::InsufficientLiquidity)?;
        self.curve_mining_mined = self
            .curve_mining_mined
            .checked_add(emitted)
            .ok_or(DiggoError::AccrualOverflow)?;
        self.curve_mining_unpaid = self
            .curve_mining_unpaid
            .checked_add(emitted)
            .ok_or(DiggoError::AccrualOverflow)?;
        self.outstanding_claims = self
            .outstanding_claims
            .checked_add(emitted)
            .ok_or(DiggoError::AccrualOverflow)?;
        self.cumulative_distributed = self
            .cumulative_distributed
            .checked_add(emitted)
            .ok_or(DiggoError::AccrualOverflow)?;
        Ok(emitted)
    }

    /// Books a claim payout against the outstanding claims. The caller moves the tokens; this
    /// only moves the ledger, and it can never book more than the index has credited.
    pub fn pay_claim(&mut self, amount: u64) -> Result<()> {
        require!(amount > 0, DiggoError::NothingToClaim);
        self.outstanding_claims = self
            .outstanding_claims
            .checked_sub(amount)
            .ok_or(DiggoError::NothingToClaim)?;
        self.curve_mining_unpaid = self.curve_mining_unpaid.saturating_sub(amount);
        Ok(())
    }

    /// Books a discovery payout against the Discovery Reserve. Only a settled discovery may
    /// reach this, and the reserve is debited only by what is actually paid out.
    pub fn pay_discovery(&mut self, amount: u64) -> Result<()> {
        require!(amount > 0, DiggoError::InvalidAmount);
        self.discovery_remaining = self
            .discovery_remaining
            .checked_sub(amount)
            .ok_or(DiggoError::InsufficientDiscoveryReserve)?;
        self.discovery_epoch_spent = self
            .discovery_epoch_spent
            .checked_add(amount)
            .ok_or(DiggoError::AccrualOverflow)?;
        Ok(())
    }

    /// Rolls the coin into a new epoch: the index, the end of the epoch in seconds and in
    /// slots, the per-epoch discovery budget and the next epoch's seed target (design 4.1).
    ///
    /// Arming the target here is the commit half of the epoch seed: the target slot is roughly
    /// one epoch away, so nobody can know its hash while this epoch's rolls are being locked.
    pub fn roll_epoch(&mut self, now: i64, slot: u64, seed_delay_slots: u64) -> Result<()> {
        let epoch_length = self.epoch_length as i64;
        require!(epoch_length > 0, DiggoError::InvalidSchedule);
        self.epoch_index = self
            .epoch_index
            .checked_add(1)
            .ok_or(DiggoError::AccrualOverflow)?;
        self.epoch_ends_at = now
            .checked_add(epoch_length)
            .ok_or(DiggoError::MathOverflow)?;
        let slots = (epoch_length as u64)
            .checked_mul(SLOTS_PER_SECOND)
            .ok_or(DiggoError::MathOverflow)?;
        self.epoch_ends_slot = slot.checked_add(slots).ok_or(DiggoError::MathOverflow)?;
        // A new epoch starts with its whole discovery budget.
        self.discovery_epoch_index = self.epoch_index;
        self.discovery_epoch_spent = 0;
        self.arm_epoch_seed_target(seed_delay_slots);
        Ok(())
    }

    /// Sets the future slot this epoch's seed will be read from. It is always ahead of the slot
    /// the coin is armed at now, which is the property the whole scheme rests on.
    pub fn arm_epoch_seed_target(&mut self, seed_delay_slots: u64) {
        self.epoch_seed_target_slot = self.epoch_ends_slot.saturating_add(seed_delay_slots);
    }

    /// The accumulator as of a slot: the mirrored cumulative price-slot product, extended past
    /// the pool's last observation at the price that has held since it.
    ///
    /// This is what lets a reader that does not hold the pool account price a slot at all. The
    /// extension is exact because a swap is the only thing that moves the price and the mirror
    /// records the price of the stretch it just accumulated.
    pub fn cum_price_at(&self, now_slot: u64) -> Result<u128> {
        require!(
            self.twap_last_update_slot > 0 && self.twap_last_price > 0,
            DiggoError::TwapUnavailable
        );
        accumulate_price(
            self.twap_cum_price_lamports_per_unit,
            self.twap_last_price,
            now_slot.saturating_sub(self.twap_last_update_slot),
        )
    }

    /// The coin's short-window time-weighted price, in lamports per base unit scaled by
    /// PRICE_SCALE, over at most TWAP_WINDOW_SLOTS slots.
    ///
    /// This is the divisor the discovery payout is normalised by, and it is deliberately not the
    /// lifetime average. A lifetime accumulator cannot be moved by a sandwich, but it is dragged
    /// by the pool's whole history, so on a young pool it is not a price anyone traded at, and it
    /// says nothing about the price the discovery is paid at. The window is anchored by
    /// roll_twap_window and the slots since the last observation are priced at the last observed
    /// price, so every slot inside it is a slot the program watched.
    pub fn twap_price(&self, now_slot: u64) -> Result<u128> {
        let anchor = if self.twap_window_slot > 0 {
            self.twap_window_slot
        } else {
            self.twap_last_update_slot
        };
        let slots = now_slot.saturating_sub(anchor);
        let cum_now = self.cum_price_at(now_slot)?;
        let cum_anchor = if self.twap_window_cum > 0 {
            self.twap_window_cum
        } else {
            0
        };
        let delta = cum_now
            .checked_sub(cum_anchor)
            .ok_or_else(|| error!(DiggoError::TwapUnavailable))?;
        twap_average(delta, slots)
    }

    /// Undoes an emission the index credited to a position that was not eligible to earn it.
    ///
    /// The walk credits every armed position's share of a block into outstanding_claims as the
    /// index advances, whether or not the owner's activation window was open - the walk cannot
    /// see per-position windows and must not have to. A settle that finds the window closed
    /// therefore puts that share back where the block paid it from, the curve's inventory before
    /// graduation and the Mining Reserve after it, and takes it out of both counters that
    /// recorded it. Nothing moves in the vault: the tokens never left, which is exactly why the
    /// vault ledger invariant holds before and after.
    ///
    /// A coin that graduated between the emission and the forfeit returns the share to the
    /// Mining Reserve, which owns every post-graduation block. That is the safe direction: the
    /// tokens stay inside the coin and are re-emitted to positions that are eligible for them.
    pub fn forfeit_emission(&mut self, amount: u64) -> Result<()> {
        if amount == 0 {
            return Ok(());
        }
        self.outstanding_claims = self
            .outstanding_claims
            .checked_sub(amount)
            .ok_or(DiggoError::LedgerInvariantViolated)?;
        self.cumulative_distributed = self
            .cumulative_distributed
            .checked_sub(amount)
            .ok_or(DiggoError::LedgerInvariantViolated)?;
        if self.graduated == 0 {
            self.token_reserve = self
                .token_reserve
                .checked_add(amount)
                .ok_or(DiggoError::MathOverflow)?;
            self.curve_mining_mined = self.curve_mining_mined.saturating_sub(amount);
            self.curve_mining_unpaid = self.curve_mining_unpaid.saturating_sub(amount);
        } else {
            self.reserve_remaining = self
                .reserve_remaining
                .checked_add(amount)
                .ok_or(DiggoError::MathOverflow)?;
        }
        Ok(())
    }
}

/// Accumulates the pool's price over the slots since the last observation and mirrors it onto
/// the coin. Call it BEFORE applying a swap: the price it accumulates is the one that held
/// during those slots, and a swap is the only thing that moves it.
///
/// It also rolls the short window forward, and it has to do that before the mirror moves: the
/// anchor is priced from the accumulator as it stood at the previous observation, which is the
/// last slot whose cumulative price the coin can prove.
pub fn observe_pool_price(coin: &mut Coin, pool: &mut LiquidityPool, slot: u64) -> Result<()> {
    let elapsed = slot.saturating_sub(pool.last_update_slot);
    if elapsed == 0 {
        return Ok(());
    }
    let price = price_lamports_per_unit(pool.sol_reserve, pool.token_reserve)?;
    roll_twap_window(coin, slot)?;
    pool.cum_price_lamports_per_unit =
        accumulate_price(pool.cum_price_lamports_per_unit, price, elapsed)?;
    pool.last_update_slot = slot;
    coin.twap_cum_price_lamports_per_unit = pool.cum_price_lamports_per_unit;
    coin.twap_last_update_slot = slot;
    coin.twap_last_price = price;
    Ok(())
}

/// Moves the short window's anchor forward so that it never covers more than TWAP_WINDOW_SLOTS
/// slots, or, when the pool has not been observed for longer than that, to the newest slot whose
/// cumulative price the coin can prove exactly.
///
/// The anchor can only ever be placed at or after the pool's last observation, because that is
/// the oldest slot the mirrored accumulator prices exactly. A window shorter than
/// TWAP_WINDOW_SLOTS is therefore the honest answer for a pool that has not traded for longer: it
/// covers every slot the program actually watched, and the deviation guard covers the rest.
pub fn roll_twap_window(coin: &mut Coin, now_slot: u64) -> Result<()> {
    if coin.twap_last_update_slot == 0 {
        return Ok(());
    }
    let target = now_slot.saturating_sub(TWAP_WINDOW_SLOTS);
    if coin.twap_window_slot >= target {
        return Ok(());
    }
    let anchor = target.max(coin.twap_last_update_slot);
    coin.twap_window_cum = coin.cum_price_at(anchor)?;
    coin.twap_window_slot = anchor;
    Ok(())
}

/// The exact time-weighted price of the coin's own pool over the whole life of the pool, with
/// the slots since its last swap priced at the current spot.
///
/// Kept for callers that hold the pool and want the lifetime reading, which is the pool's own
/// view of what it has traded at. The discovery payout does not use it: see Coin::twap_price for
/// why a lifetime average is the wrong divisor for a payout settled now.
pub fn pool_twap_price(pool: &LiquidityPool, created_slot: u64, now_slot: u64) -> Result<u128> {
    let slots = now_slot.saturating_sub(created_slot);
    let live_price = price_lamports_per_unit(pool.sol_reserve, pool.token_reserve)?;
    let stale = now_slot.saturating_sub(pool.last_update_slot);
    let cum = accumulate_price(pool.cum_price_lamports_per_unit, live_price, stale)?;
    twap_average(cum, slots)
}

#[cfg(test)]
mod v2_tests {
    use super::*;

    fn launched_coin() -> Coin {
        Coin {
            total_supply: 1_000_000_000,
            token_reserve: 700_000_000,
            reserve_remaining: 250_000_000,
            discovery_remaining: 50_000_000,
            discovery_epoch_budget: 2_000_000_000,
            curve_mining_cap: 35_000_000,
            block_interval: 300,
            epoch_length: 604_800,
            next_block_at: 1_000,
            ..Coin::default()
        }
    }

    #[test]
    fn the_supply_split_always_adds_up_to_the_whole_supply() {
        let (reserve, discovery, curve) = Coin::split_supply(1_000_000_000, 2_500, 500).unwrap();
        assert_eq!(reserve, 250_000_000);
        assert_eq!(discovery, 50_000_000);
        assert_eq!(curve, 700_000_000);
        assert_eq!(reserve + discovery + curve, 1_000_000_000);

        // Rounding down on both reserves hands the remainder to the curve, so no base unit is
        // ever created or lost by the split.
        let (reserve, discovery, curve) = Coin::split_supply(1_001, 333, 333).unwrap();
        assert_eq!(reserve + discovery + curve, 1_001);

        assert!(Coin::split_supply(1_000, 0, 0).is_err());
        assert!(Coin::split_supply(1_000, BPS as u16 + 1, 0).is_err());
        // A split that leaves nothing on the curve has no market at all.
        assert!(Coin::split_supply(1_000, BPS as u16, 0).is_err());
    }

    #[test]
    fn the_vault_ledger_is_conserved_by_every_emission_and_claim() {
        let mut coin = launched_coin();
        let mut vault = coin.ledger_total().unwrap();
        coin.assert_vault_ledger(vault).unwrap();

        // A reserve emission credits a claim without moving a token.
        coin.emit_from_reserve(1_000).unwrap();
        assert_eq!(coin.ledger_total().unwrap(), vault);
        coin.assert_vault_ledger(vault).unwrap();

        // The claim is what moves the token out.
        coin.pay_claim(1_000).unwrap();
        vault -= 1_000;
        assert_eq!(coin.ledger_total().unwrap(), vault);
        assert_eq!(coin.outstanding_claims, 0);

        // A curve-phase emission debits the curve's inventory and credits a claim, so the
        // ledger total is unchanged and graduation has nothing left to move for it.
        let curve_before = coin.token_reserve;
        let emitted = coin.emit_from_curve(2_000).unwrap();
        assert_eq!(emitted, 2_000);
        assert_eq!(coin.token_reserve, curve_before - 2_000);
        assert_eq!(coin.outstanding_claims, 2_000);
        assert_eq!(coin.ledger_total().unwrap(), vault);

        // A discovery payout is the only thing that shrinks the Discovery Reserve.
        coin.pay_discovery(500).unwrap();
        vault -= 500;
        assert_eq!(coin.ledger_total().unwrap(), vault);
        coin.assert_vault_ledger(vault).unwrap();

        // A vault short of the ledger is the bug the invariant exists to catch.
        assert!(coin.assert_vault_ledger(vault - 1).is_err());
    }

    #[test]
    fn no_reserve_is_ever_debited_beyond_what_it_holds() {
        let mut coin = launched_coin();
        assert!(coin.emit_from_reserve(coin.reserve_remaining + 1).is_err());
        assert!(coin.pay_discovery(coin.discovery_remaining + 1).is_err());
        assert!(coin.pay_claim(1).is_err(), "nothing has been credited yet");
        assert_eq!(coin.reserve_remaining, 250_000_000);
        assert_eq!(coin.discovery_remaining, 50_000_000);
        assert_eq!(coin.outstanding_claims, 0);
    }

    #[test]
    fn the_curve_phase_emits_what_is_there_and_never_past_its_cap() {
        let mut coin = launched_coin();
        // The cap is a share of the curve's inventory, and the inventory can be bought out from
        // under it: what is missing is simply never emitted.
        coin.token_reserve = 10;
        let room = coin.curve_mining_room();
        assert_eq!(room, 9, "the last base unit stays for graduation");
        let emitted = coin.emit_from_curve(1_000_000).unwrap();
        assert_eq!(emitted, 9);
        assert_eq!(coin.curve_mining_mined, 9);
        assert_eq!(coin.curve_mining_unpaid, 9);
        assert_eq!(coin.token_reserve, 1);
        assert_eq!(coin.emit_from_curve(1).unwrap(), 0, "the cap is spent");
        assert!(!coin.curve_mining_is_open());

        // A spent cap is idle, not finished: it is not the Mining Reserve's turn until
        // graduation turns it on.
        assert_eq!(coin.reserve_remaining, 250_000_000);
        assert!(!coin.curve_phase_pending());
    }

    #[test]
    fn rolling_an_epoch_arms_a_seed_target_in_the_future() {
        let mut coin = launched_coin();
        coin.epoch_index = 1;
        coin.epoch_ends_at = 1_000_000;
        coin.epoch_ends_slot = 500_000;
        coin.discovery_epoch_spent = 123;
        coin.arm_epoch_seed_target(32);
        assert_eq!(coin.epoch_seed_target_slot, 500_032);

        coin.roll_epoch(2_000_000, 900_000, 32).unwrap();
        assert_eq!(coin.epoch_index, 2);
        assert_eq!(coin.epoch_ends_at, 2_604_800);
        assert_eq!(coin.epoch_ends_slot, 900_000 + 604_800 * 2);
        assert_eq!(coin.epoch_seed_target_slot, 900_000 + 604_800 * 2 + 32);
        assert!(
            coin.epoch_seed_target_slot > 900_000,
            "the target is always ahead of the slot the roll happened at"
        );
        // A new epoch starts with its whole discovery budget.
        assert_eq!(coin.discovery_epoch_index, 2);
        assert_eq!(coin.discovery_epoch_spent, 0);
    }

    #[test]
    #[test]
    fn the_short_window_prices_the_slots_the_pool_actually_held() {
        let mut coin = launched_coin();
        coin.graduated = 1;
        coin.twap_last_update_slot = 1_000;
        coin.twap_window_slot = 1_000;
        coin.twap_window_cum = 0;
        let mut pool = LiquidityPool {
            sol_reserve: 85_000_000_000,
            token_reserve: 700_000_000,
            last_update_slot: 1_000,
            ..LiquidityPool::default()
        };

        // A swap ten slots later accumulates the price that held for those ten slots.
        observe_pool_price(&mut coin, &mut pool, 1_010).unwrap();
        let expected = 85_000_000_000 * PRICE_SCALE / 700_000_000;
        assert_eq!(pool.cum_price_lamports_per_unit, expected * 10);
        assert_eq!(coin.twap_cum_price_lamports_per_unit, expected * 10);
        assert_eq!(
            coin.twap_last_price, expected,
            "the mirror records the price it just accumulated"
        );

        // The window is the observed stretch: the accumulator since its anchor over its slots, and
        // it agrees with the pool's own exact reading when the pool has not moved since.
        assert_eq!(coin.twap_price(1_010).unwrap(), expected);
        assert_eq!(pool_twap_price(&pool, 1_000, 1_010).unwrap(), expected);

        // A rise after the last swap is priced into the window at the new spot only from the slot it
        // happened at, so ten slots at the old price and ten at the new one average to one and a
        // half times the old one: a manipulation has to survive the window to move the reading.
        pool.sol_reserve *= 2;
        let doubled = 2 * expected;
        coin.twap_last_price = doubled;
        assert_eq!(coin.twap_price(1_020).unwrap(), (expected * 10 + doubled * 10) / 20);

        // A pool with no life yet has no price rather than a division by zero, and neither has a
        // coin whose pool never traded.
        assert!(pool_twap_price(&pool, 1_010, 1_010).is_err());
        assert!(launched_coin().twap_price(1_000).is_err());
    }

    #[test]
    fn the_lamport_ledger_accounts_for_the_curve_sol_and_both_fee_buckets() {
        let mut coin = launched_coin();
        coin.sol_reserve = 12_345;
        coin.creator_fee_claimable = 100;
        coin.platform_fee_claimable = 200;
        const RENT: u64 = 3_729_600;
        coin.assert_lamport_ledger(RENT + 12_345 + 100 + 200, RENT)
            .unwrap();
        // A coin account holding less than its own ledger says is a bug, not a rounding error.
        assert!(coin
            .assert_lamport_ledger(RENT + 12_345 + 100 + 199, RENT)
            .is_err());
    }
}
