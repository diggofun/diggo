//! Protocol constants (phase 0a mechanical split of lib.rs).

use crate::*;



pub const BPS: u128 = 10_000;

pub const INDEX_SCALE: u128 = 1_000_000_000_000;

pub const DEFAULT_RESERVE_BPS: u16 = 500;

pub const DEFAULT_DISCOVERY_RESERVE_BPS: u16 = 50;

pub const DEFAULT_REDUCTION_BPS: u16 = 2_500;

pub const DEFAULT_BLOCK_INTERVAL: i64 = 300;

pub const DEFAULT_EPOCH_LENGTH: i64 = 604_800;

pub const MAX_NAME_LEN: usize = 16;

pub const MAX_SYMBOL_LEN: usize = 8;

pub const MAX_URI_LEN: usize = 96;

/// Per-call budget of the mining ledger walk, in segments. One segment is at most one run
/// of blocks plus at most one epoch rollover, so this is a hard compute bound per call.
/// A mine that is further behind than the budget allows is not stuck: every call persists
/// its progress in the mine's own cursors and the next call resumes from there.
pub const MAX_SYNC_SEGMENTS: usize = 64;

pub const STARTER_POWER: u64 = 100;


/// Default bound on the Crew Power the keeper may push for one player. The off-chain
/// curve tops out in the low thousands (see shared/crew.ts), so this sits above it and
/// only ever constrains a compromised keeper key — it is not an economic parameter.
pub const DEFAULT_MAX_CREW_POWER: u64 = 50_000;

/// Absolute ceiling for the guardian-configurable max_crew_power. Replaces the old,
/// effectively unbounded MAX_KEEPER_POWER = 10_000_000.
pub const MAX_CREW_POWER_HARD_CAP: u64 = 200_000;

/// Per-call power increase ceiling, in bps of the previous value (10_000 = at most
/// double), plus the always-allowed MIN_POWER_STEP.
pub const DEFAULT_MAX_POWER_INCREASE_BPS: u16 = 10_000;

pub const MAX_POWER_INCREASE_BPS: u16 = 10_000;

/// Always-allowed absolute step inside validate_power_update, so legitimate Crew
/// progression converges in a handful of keeper syncs instead of stalling.
pub const MIN_POWER_STEP: u64 = 1_000;


/// Hard cap on any single trading fee (creator or platform), in bps.
pub const MAX_TRADING_FEE_BPS: u16 = 100;

pub const DEFAULT_CREATOR_FEE_BPS: u16 = 50;

pub const DEFAULT_PLATFORM_FEE_BPS: u16 = 50;


/// Per-call discovery payout ceiling, in bps of a mine's total Discovery Reserve.
pub const DEFAULT_DISCOVERY_MAX_BPS: u16 = 100;

pub const MAX_DISCOVERY_MAX_BPS: u16 = 1_000;

/// Per-mine per-epoch discovery budget, in bps of the total Discovery Reserve.
pub const DEFAULT_DISCOVERY_EPOCH_BUDGET_BPS: u16 = 500;

pub const MAX_DISCOVERY_EPOCH_BUDGET_BPS: u16 = 2_000;


/// Share of a market's initial curve token inventory that pre-graduation mining may emit,
/// in bps of that inventory (500 = the launch default of 5%).
pub const DEFAULT_CURVE_MINING_BPS: u16 = 500;

/// Hard ceiling on the share a launch may ask for (10% of the curve's token inventory).
/// A launch may ask for 0, which switches curve-phase mining off and leaves the old
/// behaviour of a mine that only starts emitting once it has graduated.
pub const MAX_CURVE_MINING_BPS: u16 = 1_000;

/// Default runway, in whole days, over which the curve-mining budget is spread.
pub const DEFAULT_CURVE_MINING_RUNWAY_DAYS: u16 = 30;

pub const MAX_CURVE_MINING_RUNWAY_DAYS: u16 = 3_650;

/// Fewest blocks a curve-mining budget may be spread over.
///
/// The flat rate is `cap / runway_blocks`, so a launch whose runway spans a single block
/// emits the whole cap at block one - a budget, not a schedule. Launch validation therefore
/// refuses a curve share whose runway holds fewer than this many blocks, which is also what
/// bounds the curve phase's price impact per block: a 5% cap over 48 blocks is still 48
/// separate emissions, and the number only grows with the runway.
pub const MIN_CURVE_MINING_BLOCKS: u64 = 48;

/// Bytes the curve-mining ledger appends to LaunchMarket after the layout version byte.
/// Migration reads a pre-curve account by leaving these unread, which is why the version
/// byte stays exactly where it was and every later field goes after it.
pub const MARKET_CURVE_APPENDED_BYTES: usize = 8 * 4;


/// Bytes the phase fields append to Mine after the layout version byte: the `curve_mining_open`
/// and `graduated` flags, and the 8-byte graduation cursor that says which stretch of the
/// ledger is still curve-phase. Both flags are mirrored from the mine's market by every
/// instruction that holds it, and both are what lets a caller without the market account decide
/// which side of the ledger may pay. A pre-curve account reads both as false, and the cursor as
/// zero - which is exactly the pre-cursor behaviour of deciding from `graduated` alone.
pub const MINE_PHASE_APPENDED_BYTES: usize = 2 + 8;


/// Layout version stamped into every migratable account. Accounts written before the
/// trailing version byte existed read as 0 and are upgraded in place by migrate_account.
/// Version 2 appends the curve-mining ledger to LaunchMarket and the curve-phase flag to
/// Mine; a version 1 account still decodes, with every field added since read as its
/// safe default (no curve budget, no curve phase), so a migration can never hand a
/// legacy market a curve-mining allowance it was not launched with.
///
/// Version 3 appends the `graduated` mirror to Mine, after the curve-phase flag: before
/// graduation only the curve's inventory may pay a block, after it only the Mining Reserve
/// may. It is a fact about the mine, kept in step with the market by every instruction that
/// holds it. A version 2 account reads it as false, which is the safe default - a caller
/// without the market then refuses the walk rather than paying from the wrong side.
///
/// Version 4 appends the graduation cursor to Mine, after the `graduated` mirror. It is the
/// moment the curve phase ended, and it is what makes the phase a fact about time rather than
/// about walk order: a block that landed before the cursor is curve-phase for good, whatever
/// the walk's timing, so an un-walked stretch can never be paid out of the Mining Reserve. A
/// version 3 account reads it as zero, which means "no cursor" - the phase then follows
/// `graduated` alone, exactly as it did before this field existed.
pub const ACCOUNT_VERSION: u8 = 5;


/// Account kinds accepted by migrate_account.
pub const ACCOUNT_KIND_PROTOCOL: u8 = 0;

pub const ACCOUNT_KIND_MINE: u8 = 1;

pub const ACCOUNT_KIND_MARKET: u8 = 2;


/// Byte offset of ProtocolConfigV4.guardian in the raw account data: the 8-byte
/// discriminator, then treasury, then keeper. The protocol account is the one account
/// whose own layout gates every other instruction — while it is still awaiting migration
/// it cannot be loaded as a typed Account<ProtocolConfigV4>, so migrate_account reads this
/// single field out of the raw bytes instead of trusting a deserialized struct. The
/// protocol_guardian_offset_matches_the_layout test pins it against the real layout.
pub const PROTOCOL_GUARDIAN_OFFSET: usize = 8 + 32 + 32;

// ---- v2 constants (docs/ONCHAIN_V2_DESIGN.md 8.2) ----------------------------------------
//
// The metadata caps above are now the Token-2022 limits (16 / 8 / 96) and ACCOUNT_VERSION is
// 5: v2 is a fresh program id with a wiped devnet and no migration path, so no v2 account ever
// decodes a v4 layout.

/// Flat, refundable anti-bot bond, identical for every wallet. It buys no power, no ORE, no
/// rarity and no cap: it only makes a farm park real capital behind a cooldown.
pub const BOND_LAMPORTS: u64 = 70_000_000;
/// Cooldown between request_unbond and withdraw_bond: seven days.
pub const BOND_COOLDOWN_SECONDS: i64 = 604_800;
/// Mining efficiency of an unbonded (starter-mode) player, in bps of the same power.
pub const STARTER_EFFICIENCY_BPS: u16 = 2_500;
/// Share of one block's reward the starter tranche may ever receive, in bps, whatever the
/// bonded power is. A bonded player therefore always keeps at least 90% of a block, and the
/// remainder a starter-only coin cannot assign stays in the Mining Reserve: it is never
/// burned and never re-allocated to the starter index.
pub const STARTER_TRANCHE_BPS: u16 = 1_000;
/// Slots between an epoch's end and the SlotHashes entry its seed is taken from.
pub const EPOCH_SEED_DELAY_SLOTS: u64 = 32;
/// How late a reveal may be before the seed re-arms instead of being committed.
pub const EPOCH_SEED_MAX_LATENESS_SLOTS: u64 = 512;
/// How many slot hashes the SlotHashes sysvar keeps: the window a reveal must land in.
pub const SLOT_HASHES_WINDOW: u64 = 512;
/// Share of a coin's accrued fees a single crank_tip may pay out, in bps.
pub const CRANK_TIP_BPS: u16 = 200;
/// Longest a pause flag may be set for without the timelocked governance path.
pub const MAX_PAUSE_SECONDS: i64 = 259_200;
/// Most rarity tiers ProtocolConfig can hold.
pub const MAX_RARITY_TIERS: usize = 8;
/// Crew components: miners, drills, carts, foreman, storage.
pub const CREW_COMPONENTS: usize = 5;
/// Highest crew level any component may reach; the curve tables have one entry per level.
pub const MAX_CREW_LEVEL: u16 = 100;
/// Power-table entries, one per crew level.
pub const CURVE_TABLE_POWER_LEN: usize = 100;
/// Discovery caps, in lamports of SOL and never in USD (design 4.3). The dollar figures the
/// UI shows are converted at display time by the off-chain oracle.
pub const DEFAULT_DISCOVERY_DAILY_CAP_LAMPORTS: u64 = 1_000_000_000;
pub const DEFAULT_DISCOVERY_WEEKLY_CAP_LAMPORTS: u64 = 4_000_000_000;
pub const DEFAULT_DISCOVERY_GLOBAL_DAILY_CAP_LAMPORTS: u64 = 50_000_000_000;
pub const DEFAULT_DISCOVERY_EPOCH_BUDGET_LAMPORTS: u64 = 2_000_000_000;
/// Default per-wallet sponsor limit for a bond or account subsidy: one bond.
pub const DEFAULT_SPONSOR_PER_WALLET_LIMIT_LAMPORTS: u64 = BOND_LAMPORTS;
/// Default crank-pool share of a trade's fee. The tip a crank may take is bounded by
/// CRANK_TIP_BPS of the coin's accrued fees, and it can only ever be paid out of accrual.
pub const DEFAULT_CRANK_POOL_FEE_BPS: u16 = 0;
/// Length of one discovery day and one discovery week, in seconds.
pub const DISCOVERY_DAY_SECONDS: i64 = 86_400;
pub const DISCOVERY_WEEK_SECONDS: i64 = 604_800;
/// Seconds a pending DiscoveryOpportunity may stay unsettleable before expire_opportunity
/// may close it: one epoch plus a settle window, so an honest settle is never griefed.
pub const OPPORTUNITY_EXPIRY_SECONDS: i64 = 1_209_600;
/// Maturity ramp of a PlayerAccount, in days from its creation slot, and the bps of power
/// and ORE it unlocks. Day 1 20%, day 3 40%, day 7 70%, then 100% (design section 5).
pub const MATURITY_RAMP: [(u64, u16); 3] = [(1, 2_000), (3, 4_000), (7, 7_000)];
/// A player may re-activate at most once every this many seconds.
pub const MIN_REACTIVATION_SECONDS: i64 = 86_400;
/// Activation window granted by activate, and the grace the UI derives from it.
pub const ACTIVATION_SECONDS: i64 = 86_400;
pub const ACTIVATION_GRACE_SECONDS: i64 = 3_600;

// ---- Token-2022 mint layout (design 1.3(c)) ----------------------------------------------

pub const MINT_BASE_SIZE: usize = 82;
pub const MINT_ACCOUNT_TYPE_SIZE: usize = 1;
pub const MINT_METADATA_POINTER_SIZE: usize = 68;
pub const MINT_TOKEN_METADATA_SIZE: usize = 208;
/// The whole hand-written Token-2022 mint launch_token creates: 359 bytes.
pub const MINT_V2_SIZE: usize = MINT_BASE_SIZE
    + MINT_ACCOUNT_TYPE_SIZE
    + MINT_METADATA_POINTER_SIZE
    + MINT_TOKEN_METADATA_SIZE;
/// An SPL token account, for the coin's single vault.
pub const TOKEN_ACCOUNT_SIZE: usize = 165;
