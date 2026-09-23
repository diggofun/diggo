//! Player and position state (design 3.1, 3.2, 8.2). WS-A owns this file.
//!
//! The two v2 layouts below are frozen by CONTRACTS.md and asserted twice in `src/tests.rs`
//! (a borsh round trip and the literal size), so nothing here may move a field. What this file
//! adds on top of the layout is behaviour: how a player's tranche and maturity are read, and
//! how a position settles its share of a coin's reward index.

use crate::*;

#[account]
#[derive(InitSpace)]
pub struct Player {
    pub owner: Pubkey,
    /// Mining Power derived off-chain from Crew progression and pushed here
    /// exclusively by `sync_crew_power`. Never purchasable with real tokens.
    pub power: u64,
    pub active_mine: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace, Default)]
pub struct MiningPositionV4 {
    pub owner: Pubkey,
    pub mine: Pubkey,
    pub assigned_power: u64,
    pub last_reward_index: u128,
    pub pending_reward: u64,
    pub bump: u8,
}

// ---- v2 (docs/ONCHAIN_V2_DESIGN.md 3.1, 3.2, 8.2) ----------------------------------------

/// One PDA per wallet under [b"player", owner]. The owner is never stored: it is the seed.
///
/// Allocated at its full size on the first `initialize_player`, so posting or withdrawing a
/// bond never reallocs it. The bond lamports themselves sit in this PDA's balance above its
/// rent-exempt minimum and therefore need no account of their own.
#[account]
#[derive(Default)]
pub struct PlayerAccount {
    /// Maturity anchors, fixed at PDA creation and never reset by a bond.
    pub created_slot: u64,
    pub created_at: i64,
    pub active_until: i64,
    pub last_activation_at: i64,
    pub streak: u16,
    pub longest_streak: u16,
    pub valid_activations: u16,
    pub active_days: u16,
    pub last_active_day: u16,
    pub streak_freezes: u8,
    /// miners, drills, carts, foreman, storage.
    pub crew_levels: [u16; CREW_COMPONENTS],
    /// ORE is non-transferable game state, never an SPL token.
    pub ore_balance: u64,
    pub ore_earned: u64,
    pub ore_spent: u64,
    pub ore_accrued_at: i64,
    pub active_mine: Pubkey,
    /// Discovery budget windows. u16 is 179 years of days.
    pub day_index: u16,
    pub week_index: u16,
    pub spent_day_lamports: u64,
    pub spent_week_lamports: u64,
    /// Last window a roll was created in: a repeat in the same window is a no-op, never a
    /// reroll, because the opportunity PDA already exists.
    pub roll_window: u16,
    pub roll_count: u16,
    pub last_roll_at: i64,
    /// Lamports locked in this PDA's balance above its rent-exempt minimum.
    pub bond_lamports: u64,
    pub bond_locked_at: i64,
    pub unbond_available_at: i64,
    /// 0 = the player's own lamports, 1 = a sponsor vault.
    pub bond_source: u8,
    /// The vault a sponsor-funded bond returns to; zero when self-funded.
    pub bond_sponsor_vault: Pubkey,
    pub bump: u8,
    pub version: u8,
}

impl PlayerAccount {
    pub const LEN: usize = 8 * 4
        + 2 * 5
        + 1
        + 2 * CREW_COMPONENTS
        + 8 * 3
        + 8
        + 32
        + 2 * 2
        + 8 * 2
        + 2 * 2
        + 8
        + 8 * 3
        + 1
        + 32
        + 2;
    pub const SIZE: usize = 8 + Self::LEN;

    /// The v2 fields above, at their safe defaults, for a PDA that has just been created.
    /// Everything the layout can express is written here exactly once; nothing in this struct
    /// is ever reset afterwards, which is what keeps `created_slot` a real maturity anchor.
    pub fn initialise(now: i64, slot: u64, bump: u8) -> Self {
        Self {
            created_slot: slot,
            created_at: now,
            ore_accrued_at: now,
            last_active_day: Self::day_index_at(now),
            crew_levels: [CREW_START_LEVEL; CREW_COMPONENTS],
            bump,
            version: ACCOUNT_VERSION,
            ..Self::default()
        }
    }

    /// True when the PDA still carries a bond that was posted before the bond was retired.
    ///
    /// The field is frozen into the layout, so it cannot be dropped, and the legacy withdrawal
    /// path still has to find the lamports it owes back. Nothing else reads it: no tranche, no
    /// power and no eligibility depends on it any more.
    pub fn has_legacy_bond(&self) -> bool {
        self.bond_lamports > 0
    }

    /// The reward index this player's position accrues in: the full tranche, for everyone.
    ///
    /// Bonding is retired, so arming no longer asks what the wallet parked and no wallet is
    /// throttled for parking nothing. The name and the stored value are the frozen v2
    /// vocabulary - the coin's ledger carries one power total and one index per tranche - and a
    /// position armed before the retirement keeps the tranche it was armed with, because both
    /// totals and both indexes are keyed by it.
    pub fn tranche(&self) -> u8 {
        TRANCHE_BONDED
    }

    /// True while a position is armed on a coin. `remove_power` and `switch_mine` are the
    /// only writers that clear it, which is why it is also the answer to "does this player
    /// hold an active position" that `request_unbond` needs (3.3).
    pub fn has_active_position(&self) -> bool {
        self.active_mine != Pubkey::default()
    }

    /// True while the activation window is open. The window is half open, exactly as
    /// `isEligibleForBlock` describes it: [last_activation_at, active_until).
    pub fn is_activated(&self, now: i64) -> bool {
        self.last_activation_at <= now && now < self.active_until
    }

    /// Discovery day and week cursors, both whole windows since the epoch. u16 is 179 years
    /// of days, which is why the layout can afford them.
    pub fn day_index_at(now: i64) -> u16 {
        (now.max(0) / DISCOVERY_DAY_SECONDS) as u16
    }

    pub fn week_index_at(now: i64) -> u16 {
        (now.max(0) / DISCOVERY_WEEK_SECONDS) as u16
    }
}

/// One PDA per (coin, owner) under [b"position", coin, owner]. Owner and coin are the seeds,
/// so neither is stored, and the reward-index math is the v4 math unchanged.
#[account]
#[derive(Default)]
pub struct MiningPosition {
    pub assigned_power: u64,
    pub last_reward_index: u128,
    pub pending_reward: u64,
    /// The reward index this position accrues in: 0 bonded, 1 starter.
    pub tranche: u8,
    pub created_slot: u64,
    pub bump: u8,
    pub version: u8,
}

impl MiningPosition {
    pub const LEN: usize = 8 + 16 + 8 + 1 + 8 + 1 + 1;
    pub const SIZE: usize = 8 + Self::LEN;

    /// A freshly armed position. It starts at the index its tranche is already at, so arming
    /// can never claim rewards that accrued before it existed.
    pub fn armed(coin: &Coin, tranche: u8, power: u64, slot: u64, bump: u8) -> Self {
        Self {
            assigned_power: power,
            last_reward_index: tranche_index(coin, tranche),
            pending_reward: 0,
            tranche,
            created_slot: slot,
            bump,
            version: ACCOUNT_VERSION,
        }
    }

    /// Settles this position against the index of the tranche it accrues in, gated by the owner's
    /// activation window. Returns (credited, forfeited).
    ///
    /// The rule and the arithmetic live in math/index.rs (settle_position_gated), which is the
    /// single definition of the settle. This method exists so that no handler has to restate which
    /// index a tranche reads or how the activation window gates it. Truncation is in the protocol's
    /// favour at every step: the index is scaled by INDEX_SCALE and the position's share is
    /// floored, so the sum of every position's claim can never exceed what the index was advanced
    /// by.
    pub fn settle(&mut self, coin: &mut Coin, activated: bool) -> Result<(u64, u64)> {
        settle_position_gated(self, coin, activated)
    }

    /// Adds this position's power to the tranche total of the coin it is armed on. The starter
    /// total is deliberately a separate field from the bonded one: the two indexes are what
    /// let the ledger hold the starter tranche to STARTER_TRANCHE_BPS of a block.
    pub fn add_power_to(&self, coin: &mut Coin) -> Result<()> {
        if self.assigned_power == 0 {
            return Ok(());
        }
        if self.tranche == TRANCHE_STARTER {
            coin.starter_power = coin
                .starter_power
                .checked_add(self.assigned_power)
                .ok_or(DiggoError::MathOverflow)?;
        } else {
            coin.bonded_power = coin
                .bonded_power
                .checked_add(self.assigned_power)
                .ok_or(DiggoError::MathOverflow)?;
        }
        coin.total_power = coin
            .total_power
            .checked_add(self.assigned_power)
            .ok_or(DiggoError::MathOverflow)?;
        Ok(())
    }

    /// The exact inverse of `add_power_to`. A coin whose totals disagree with its positions
    /// would pay the wrong share to everyone still armed on it, so a mismatch is an error
    /// rather than a clamp.
    pub fn remove_power_from(&self, coin: &mut Coin) -> Result<()> {
        if self.assigned_power == 0 {
            return Ok(());
        }
        if self.tranche == TRANCHE_STARTER {
            coin.starter_power = coin
                .starter_power
                .checked_sub(self.assigned_power)
                .ok_or(DiggoError::MathOverflow)?;
        } else {
            coin.bonded_power = coin
                .bonded_power
                .checked_sub(self.assigned_power)
                .ok_or(DiggoError::MathOverflow)?;
        }
        coin.total_power = coin
            .total_power
            .checked_sub(self.assigned_power)
            .ok_or(DiggoError::MathOverflow)?;
        Ok(())
    }
}

/// A bond is either the player's own lamports or a sponsor vault's.
pub const BOND_SOURCE_SELF: u8 = 0;
pub const BOND_SOURCE_SPONSOR: u8 = 1;

/// The reward index a position accrues in.
pub const TRANCHE_BONDED: u8 = 0;
pub const TRANCHE_STARTER: u8 = 1;

// The index each tranche settles against is a Coin field, and tranche_index in math/index.rs is
// the one definition of which field that is. There is deliberately no derivation of one index
// from the other anywhere in the tree: the starter index is stored, which is what lets the walk
// hold the tranche cap exactly rather than only while an inequality on the two powers holds.
// See docs/CONTRACT_CHANGE_REQUESTS.md.

#[cfg(test)]
mod tests {
    use super::*;

    fn coin_with(bonded_index: u128, starter_index: u128, bonded: u64, starter: u64) -> Coin {
        Coin {
            bonded_index,
            starter_index,
            bonded_power: bonded,
            starter_power: starter,
            total_power: bonded + starter,
            ..Coin::default()
        }
    }

    #[test]
    fn the_layout_constants_still_match_the_frozen_table() {
        // CONTRACTS.md: PlayerAccount 216, MiningPosition 51. Pinned here as well as in
        // src/tests.rs so a field added in this file fails in this file.
        assert_eq!(PlayerAccount::SIZE, 216);
        assert_eq!(MiningPosition::SIZE, 51);
        assert_eq!(8 + borsh_len(&PlayerAccount::initialise(1, 2, 3)), PlayerAccount::SIZE);
        assert_eq!(8 + borsh_len(&MiningPosition::armed(&coin_with(0, 0, 0, 0), 0, 0, 0, 1)), MiningPosition::SIZE);
    }

    #[test]
    fn a_new_player_is_unbonded_unarmed_and_unactivated() {
        let player = PlayerAccount::initialise(1_000, 42, 7);
        assert_eq!(player.created_at, 1_000);
        assert_eq!(player.created_slot, 42);
        assert_eq!(player.ore_accrued_at, 1_000);
        assert_eq!(player.crew_levels, [CREW_START_LEVEL; CREW_COMPONENTS]);
        assert_eq!(player.ore_balance, 0);
        assert_eq!(player.bond_lamports, 0);
        assert_eq!(player.bond_source, BOND_SOURCE_SELF);
        assert_eq!(player.bump, 7);
        assert_eq!(player.version, ACCOUNT_VERSION);
        assert!(!player.has_active_position());
        assert!(!player.is_activated(1_000));
        // The full tranche with nothing parked: the deposit is retired.
        assert_eq!(player.tranche(), TRANCHE_BONDED);
    }

    #[test]
    fn the_bond_selects_neither_the_tranche_nor_the_power_any_more() {
        let mut player = PlayerAccount::initialise(0, 0, 1);
        assert_eq!(player.tranche(), TRANCHE_BONDED);
        assert!(!player.has_legacy_bond());
        // A bond posted before the retirement is still on the account - the frozen layout keeps
        // it, and the legacy withdrawal still owes it back - but it selects nothing at all.
        player.bond_lamports = BOND_LAMPORTS - 1;
        assert!(player.has_legacy_bond());
        assert_eq!(player.tranche(), TRANCHE_BONDED);
        player.bond_lamports = BOND_LAMPORTS;
        assert_eq!(player.tranche(), TRANCHE_BONDED);
        player.bond_source = BOND_SOURCE_SPONSOR;
        player.bond_sponsor_vault = Pubkey::new_unique();
        // The source only decides where the lamports go on exit; it never selected a tranche and
        // does not now.
        assert_eq!(player.tranche(), TRANCHE_BONDED);
        assert_eq!(player.bond_source, BOND_SOURCE_SPONSOR);
    }

    #[test]
    fn a_position_settles_its_share_and_never_double_counts() {
        let mut coin = coin_with(INDEX_SCALE * 10, INDEX_SCALE * 10, 1_000, 0);
        let mut position = MiningPosition::armed(&coin, TRANCHE_BONDED, 100, 5, 1);
        assert_eq!(position.pending_reward, 0);
        let mut coin = coin_with(INDEX_SCALE * 10 + INDEX_SCALE * 10, INDEX_SCALE * 10 + INDEX_SCALE * 10, 1_000, 0);
        assert_eq!(position.settle(&mut coin, true).unwrap().0, 1_000);
        assert_eq!(position.pending_reward, 1_000);
        // Settling again with no further index movement pays nothing.
        assert_eq!(position.settle(&mut coin, true).unwrap().0, 0);
        assert_eq!(position.pending_reward, 1_000);
    }

    #[test]
    #[test]
    fn a_starter_position_settles_its_own_index() {
        let mut coin = coin_with(INDEX_SCALE * 40_000, INDEX_SCALE * 1_000, 1_000, 500);
        let bonded = MiningPosition::armed(&coin, TRANCHE_BONDED, 100, 5, 1);
        let starter = MiningPosition::armed(&coin, TRANCHE_STARTER, 100, 5, 1);
        // Each tranche starts at its own stored index. There is no derivation left to keep in step
        // between the two, which is exactly what lets the walk hold the starter tranche cap.
        assert_eq!(bonded.last_reward_index, coin.bonded_index);
        assert_eq!(starter.last_reward_index, coin.starter_index);
        assert_ne!(coin.bonded_index, coin.starter_index);
        assert_eq!(tranche_index(&coin, TRANCHE_STARTER), coin.starter_index);
    }

    #[test]
    fn power_moves_between_the_two_totals_and_nowhere_else() {
        let mut coin = coin_with(0, 0, 0, 0);
        let bonded = MiningPosition::armed(&coin, TRANCHE_BONDED, 700, 5, 1);
        let starter = MiningPosition::armed(&coin, TRANCHE_STARTER, 175, 5, 2);
        bonded.add_power_to(&mut coin).unwrap();
        starter.add_power_to(&mut coin).unwrap();
        assert_eq!((coin.bonded_power, coin.starter_power, coin.total_power), (700, 175, 875));
        // A zero-power position is inert, which is what switch_mine leaves behind.
        let empty = MiningPosition::armed(&coin, TRANCHE_BONDED, 0, 5, 3);
        empty.add_power_to(&mut coin).unwrap();
        empty.remove_power_from(&mut coin).unwrap();
        assert_eq!((coin.bonded_power, coin.starter_power, coin.total_power), (700, 175, 875));
        bonded.remove_power_from(&mut coin).unwrap();
        starter.remove_power_from(&mut coin).unwrap();
        assert_eq!((coin.bonded_power, coin.starter_power, coin.total_power), (0, 0, 0));
        // Removing twice is an error rather than a silently wrong total.
        assert!(bonded.remove_power_from(&mut coin).is_err());
    }

    #[test]
    fn windows_and_day_cursors_come_from_the_clock() {
        let mut player = PlayerAccount::initialise(0, 0, 1);
        player.last_activation_at = 1_000;
        player.active_until = 1_000 + ACTIVATION_SECONDS;
        assert!(player.is_activated(1_000));
        assert!(player.is_activated(1_000 + ACTIVATION_SECONDS - 1));
        // The window is half open: a block landing exactly on active_until is not eligible.
        assert!(!player.is_activated(1_000 + ACTIVATION_SECONDS));
        assert!(!player.is_activated(999));
        assert_eq!(PlayerAccount::day_index_at(0), 0);
        assert_eq!(PlayerAccount::day_index_at(DISCOVERY_DAY_SECONDS), 1);
        assert_eq!(PlayerAccount::week_index_at(DISCOVERY_WEEK_SECONDS), 1);
        assert_eq!(PlayerAccount::day_index_at(-5), 0);
    }

    fn borsh_len<T: AnchorSerialize>(value: &T) -> usize {
        let mut bytes = Vec::new();
        value.serialize(&mut bytes).unwrap();
        bytes.len()
    }
}
