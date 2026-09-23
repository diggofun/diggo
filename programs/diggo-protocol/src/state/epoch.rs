//! state::epoch.rs (phase 0a mechanical split of lib.rs).

use crate::*;



/// Proof that exactly one (mine, discovery_id) discovery was paid out. Created with
/// init under seeds [b"discovery", mine, discovery_id], so a replay fails the
/// transaction instead of paying a second time (spec 47, 57).
#[account]
#[derive(InitSpace)]
pub struct DiscoveryReceipt {
    pub mine: Pubkey,
    pub discovery_id: u64,
    pub recipient: Pubkey,
    pub amount: u64,
    pub claimed_at: i64,
    pub bump: u8,
}

// ---- v2 (docs/ONCHAIN_V2_DESIGN.md 4.2, 4.3, 8.2) ----------------------------------------

/// One PDA per (coin, owner, window) under [b"opportunity", coin, owner, window_index u16 le].
///
/// It exists so a reroll is impossible by construction rather than by a guarded update, and it
/// is closed on settlement so its rent is transient and returns to whoever settles it. The
/// budget is charged when the roll is created, while the epoch seed is still unknown, and an
/// expired opportunity pays nothing and refunds no budget.
#[account]
#[derive(Default)]
pub struct DiscoveryOpportunity {
    pub coin: Pubkey,
    pub owner: Pubkey,
    pub window_index: u16,
    pub day_index: u16,
    /// The epoch whose seed settles this opportunity. Frozen: written at creation, read by
    /// settle_discovery, never rewritten.
    pub epoch_index: u32,
    /// The lamports of day and week budget charged at creation.
    pub budget_lamports: u64,
    /// Token units reserved at creation, after applying the reserve, per-call and epoch
    /// caps. Settlement is capped by this frozen exposure as well as by the lamport budget:
    /// converting a fixed lamport value again at a lower settlement price must not mint more
    /// units than the creation-time budget covered.
    pub reserved_units: u64,
    pub created_at: i64,
    pub created_slot: u64,
    pub expires_at: i64,
    /// 0 pending, 1 settled, 2 expired.
    pub status: u8,
    /// Rarity tier the seed derived at settlement; zero while pending.
    pub rarity: u8,
    pub bump: u8,
    pub version: u8,
}

impl DiscoveryOpportunity {
    pub const LEN: usize = 32 * 2 + 2 * 2 + 4 + 8 + 8 + 8 + 8 + 8 + 4;
    pub const SIZE: usize = 8 + Self::LEN;
}

pub const OPPORTUNITY_PENDING: u8 = 0;
pub const OPPORTUNITY_SETTLED: u8 = 1;
pub const OPPORTUNITY_EXPIRED: u8 = 2;

/// One PDA per day index under [b"global-budget", day_index u16 le]: the protocol-wide daily
/// discovery cap. Created by the first roll of the day and closed by a crank once the day
/// passes, so its rent is transient.
#[account]
#[derive(Default)]
pub struct GlobalBudget {
    pub day_index: u16,
    pub cap_lamports: u64,
    pub spent_lamports: u64,
    pub roll_count: u32,
    pub settled_count: u32,
    pub opened_at: i64,
    pub opened_slot: u64,
    pub closed: u8,
    pub bump: u8,
    pub version: u8,
}

impl GlobalBudget {
    pub const LEN: usize = 2 + 8 + 8 + 4 + 4 + 8 + 8 + 3;
    pub const SIZE: usize = 8 + Self::LEN;
}

impl DiscoveryOpportunity {
    pub fn is_pending(&self) -> bool {
        self.status == OPPORTUNITY_PENDING
    }

    pub fn is_expired_at(&self, now: i64) -> bool {
        now >= self.expires_at
    }

    /// True when a recorded seed may settle this opportunity.
    ///
    /// Three conditions, all of them about the seed being a fact that did not exist while the
    /// roll was being created (design 4.1 step 2):
    ///
    /// - a seed has actually been recorded (seed_recorded_slot > 0), so a missed reveal
    ///   delays the payout instead of paying it from nothing;
    /// - the seed's epoch covers this opportunity's epoch, so a seed can never settle an
    ///   opportunity from a later epoch than it belongs to;
    /// - the roll was created strictly before the seed was recorded. This is what makes the
    ///   commit meaningful: without it a wallet could read the published seed and only create
    ///   the rolls whose outcome it likes. The budget is charged at creation either way, so
    ///   the residual is bounded by the caps rather than free, and this check makes the
    ///   stronger case impossible outright.
    pub fn is_covered_by(&self, seed_epoch: u32, seed_recorded_slot: u64) -> bool {
        seed_recorded_slot > 0
            && seed_epoch >= self.epoch_index
            && self.created_slot < seed_recorded_slot
    }
}

impl GlobalBudget {
    /// What is left of the protocol-wide day.
    pub fn remaining(&self) -> u64 {
        self.cap_lamports.saturating_sub(self.spent_lamports)
    }

    /// True while this account is the open budget of the given day index.
    pub fn is_open_for(&self, day_index: u16) -> bool {
        self.closed == 0 && self.day_index == day_index
    }

    /// True when this account is already the immutable budget for `day_index`.
    ///
    /// An existing account is never relabelled or reset. Its day is part of the PDA identity,
    /// and treating a different stored day as a fresh budget would hand the protocol a new cap
    /// for every caller whose PlayerAccount had not been rolled yet.
    pub fn is_identity_for(&self, day_index: u16) -> bool {
        self.day_index == day_index && self.closed == 0 && self.version == ACCOUNT_VERSION
    }

    /// A freshly opened day. The cap is taken from the protocol at open time, so a later
    /// governance change applies to the next day rather than retroactively to this one.
    pub fn open(day_index: u16, cap_lamports: u64, now: i64, slot: u64) -> Self {
        Self {
            day_index,
            cap_lamports,
            spent_lamports: 0,
            roll_count: 0,
            settled_count: 0,
            opened_at: now,
            opened_slot: slot,
            closed: 0,
            bump: 0,
            version: ACCOUNT_VERSION,
        }
    }

    /// Charges one roll against the day. The charge happens at roll creation, while the
    /// outcome is still unknown, which is what makes an expired opportunity cost its creator
    /// the budget it reserved.
    pub fn charge(&mut self, amount: u64) -> Result<()> {
        let spent = self
            .spent_lamports
            .checked_add(amount)
            .ok_or(DiggoError::MathOverflow)?;
        require!(spent <= self.cap_lamports, DiggoError::GlobalCapExceeded);
        self.spent_lamports = spent;
        self.roll_count = self
            .roll_count
            .checked_add(1)
            .ok_or(DiggoError::MathOverflow)?;
        Ok(())
    }

    pub fn note_settled(&mut self) -> Result<()> {
        self.settled_count = self
            .settled_count
            .checked_add(1)
            .ok_or(DiggoError::MathOverflow)?;
        Ok(())
    }
}

/// How a reveal resolves, decided from slots alone so it can be unit-tested without a
/// sysvar. The caller performs the matching SlotHashes lookup.
///
/// The three branches are the whole of the deterministic miss handling of design 4.1. Both
/// constants they are cut from are SLOT_HASHES_WINDOW, so the target is inside the sysvar
/// while the crank is less than a window late, the oldest surviving hash covers the single
/// slot of lateness at exactly a window, and past epoch_seed_max_lateness_slots the seed
/// re-arms instead of being taken from a slot whose hash was already public while the
/// epoch's rolls were being created.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SeedRevealPlan {
    /// Take the hash recorded at exactly the target slot.
    Target,
    /// The target aged out of the sysvar: take the oldest hash it still carries, and record
    /// the slot that hash belongs to so the fallback is visible and recomputable.
    Oldest,
    /// Too late to commit a seed for this target: re-arm at this slot instead.
    Rearm(u64),
}

pub fn plan_seed_reveal(
    target_slot: u64,
    current_slot: u64,
    max_lateness_slots: u64,
    delay_slots: u64,
) -> Result<SeedRevealPlan> {
    require!(target_slot > 0, DiggoError::EpochNotRolled);
    require!(target_slot <= current_slot, DiggoError::SeedTargetInFuture);
    let lateness = current_slot - target_slot;
    if lateness < SLOT_HASHES_WINDOW {
        return Ok(SeedRevealPlan::Target);
    }
    if lateness <= max_lateness_slots {
        return Ok(SeedRevealPlan::Oldest);
    }
    let delay = delay_slots.max(1);
    Ok(SeedRevealPlan::Rearm(
        current_slot
            .checked_add(delay)
            .ok_or(DiggoError::MathOverflow)?,
    ))
}

#[cfg(test)]
mod epoch_state_tests {
    use super::*;

    fn assert_global_budget_identity_is_immutable() {
        let mut budget = GlobalBudget::open(7, 100, 1_000, 500);
        assert!(budget.is_identity_for(7));
        assert!(!budget.is_identity_for(8));
        budget.day_index = 8;
        assert!(!budget.is_identity_for(7));
    }

    #[test]
    fn a_target_inside_the_window_takes_its_own_hash() {
        assert_eq!(
            plan_seed_reveal(1_000, 1_000, 512, 32).unwrap(),
            SeedRevealPlan::Target
        );
        assert_eq!(
            plan_seed_reveal(1_000, 1_511, 512, 32).unwrap(),
            SeedRevealPlan::Target
        );
    }

    #[test]
    fn an_aged_out_target_falls_back_to_the_oldest_hash() {
        // Exactly one window late is the single slot the fallback covers, because the window
        // and the lateness bound are the same constant.
        assert_eq!(
            plan_seed_reveal(1_000, 1_512, 512, 32).unwrap(),
            SeedRevealPlan::Oldest
        );
    }

    #[test]
    fn a_crank_past_the_lateness_bound_re_arms() {
        assert_eq!(
            plan_seed_reveal(1_000, 1_513, 512, 32).unwrap(),
            SeedRevealPlan::Rearm(1_545)
        );
        // A wider bound widens the fallback and nothing else.
        assert_eq!(
            plan_seed_reveal(1_000, 2_000, 2_048, 32).unwrap(),
            SeedRevealPlan::Oldest
        );
    }

    #[test]
    fn a_future_or_unarmed_target_is_refused() {
        assert!(plan_seed_reveal(1_000, 999, 512, 32).is_err());
        assert!(plan_seed_reveal(0, 999, 512, 32).is_err());
    }

    fn opportunity(epoch_index: u32, created_slot: u64) -> DiscoveryOpportunity {
        DiscoveryOpportunity {
            epoch_index,
            created_slot,
            status: OPPORTUNITY_PENDING,
            expires_at: 1_000,
            ..Default::default()
        }
    }

    #[test]
    fn a_roll_is_only_settleable_by_a_seed_recorded_after_it() {
        let roll = opportunity(4, 500);
        // Recorded after the roll, covering its epoch.
        assert!(roll.is_covered_by(4, 600));
        assert!(roll.is_covered_by(9, 600));
        // No seed at all.
        assert!(!roll.is_covered_by(4, 0));
        // A seed from an earlier epoch than the roll.
        assert!(!roll.is_covered_by(3, 600));
        // A seed that was already public when the roll was created: the case the commit
        // exists to prevent, because the outcome would be known before the roll is made.
        assert!(!roll.is_covered_by(4, 500));
        assert!(!roll.is_covered_by(4, 499));
    }

    #[test]
    fn an_expired_opportunity_is_not_pending_work() {
        let roll = opportunity(1, 10);
        assert!(roll.is_pending());
        assert!(!roll.is_expired_at(999));
        assert!(roll.is_expired_at(1_000));
        assert!(roll.is_expired_at(1_001));
    }

    #[test]
    fn the_global_day_charges_at_creation_and_refuses_past_its_cap() {
        let mut budget = GlobalBudget::open(7, 100, 1_000, 500);
        assert_global_budget_identity_is_immutable();
        assert!(budget.is_open_for(7));
        assert!(!budget.is_open_for(8));
        assert_eq!(budget.remaining(), 100);
        budget.charge(60).unwrap();
        budget.charge(40).unwrap();
        assert_eq!(budget.remaining(), 0);
        assert_eq!(budget.roll_count, 2);
        assert!(budget.charge(1).is_err());
        budget.note_settled().unwrap();
        assert_eq!(budget.settled_count, 1);
        budget.closed = 1;
        assert!(!budget.is_open_for(7));
    }
}
