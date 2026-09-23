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
    /// Cumulative rewards per unit of power, scaled by INDEX_SCALE, over the bonded index.
    pub reward_index: u128,
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
    pub const LEN: usize = 32 * 2
        + 8 * 8
        + 16
        + 8
        + 4
        + 8
        + 4
        + 4
        + 8
        + 8
        + 2
        + 8
        + 8 * 6
        + 2 * 2
        + 8 * 4
        + 1
        + 1
        + 8
        + 8 * 3
        + 4
        + 1
        + 16
        + 8
        + 32
        + 4
        + 8
        + 8
        + 3;
    /// Whole account space, discriminator included.
    pub const SIZE: usize = 8 + Self::LEN;
}

/// Coin lifecycle, kept as a byte so the layout stays explicit.
pub const COIN_STATUS_LAUNCHING: u8 = 0;
pub const COIN_STATUS_MINING_ACTIVE: u8 = 1;
pub const COIN_STATUS_FULLY_MINED: u8 = 2;
