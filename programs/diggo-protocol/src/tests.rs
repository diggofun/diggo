//! Unit tests.


use super::*;

const OFFSET: u32 = ERROR_CODE_OFFSET;

fn test_protocol() -> ProtocolConfigV4 {
    ProtocolConfigV4 {
        treasury: Pubkey::new_unique(),
        keeper: Pubkey::new_unique(),
        guardian: Pubkey::new_unique(),
        reserve_bps: DEFAULT_RESERVE_BPS,
        discovery_reserve_bps: DEFAULT_DISCOVERY_RESERVE_BPS,
        creator_fee_bps: DEFAULT_CREATOR_FEE_BPS,
        platform_fee_bps: DEFAULT_PLATFORM_FEE_BPS,
        discovery_max_bps: DEFAULT_DISCOVERY_MAX_BPS,
        discovery_epoch_budget_bps: DEFAULT_DISCOVERY_EPOCH_BUDGET_BPS,
        max_crew_power: DEFAULT_MAX_CREW_POWER,
        max_power_increase_bps: DEFAULT_MAX_POWER_INCREASE_BPS,
        discovery_payouts_paused: false,
        reward_claims_paused: false,
        bump: 0,
        version: ACCOUNT_VERSION,
    }
}

fn test_mine(remaining_reserve: u64) -> Mine {
    Mine {
        mint: Pubkey::new_unique(),
        creator: Pubkey::new_unique(),
        reserve_vault: Pubkey::default(),
        discovery_vault: Pubkey::default(),
        market_vault: Pubkey::default(),
        fee_vault: Pubkey::default(),
        total_supply: 1_000_000,
        remaining_reserve,
        remaining_discovery_reserve: 0,
        cumulative_distributed: 0,
        total_power: 1_000,
        reward_index: 0,
        current_block_reward: 100,
        block_interval: 300,
        next_block_at: 300,
        epoch: 0,
        epoch_length: 604_800,
        epoch_ends_at: 604_800,
        reduction_bps: 2_500,
        minimum_reward: 1,
        status: MineStatus::MiningActive,
        name: "Test".into(),
        symbol: "TEST".into(),
        uri: String::new(),
        discovery_reserve_total: 0,
        discovery_epoch_budget: 0,
        discovery_epoch_spent: 0,
        discovery_epoch_ends_at: 604_800,
        discovery_paused: false,
        bump: 0,
        version: ACCOUNT_VERSION,
        curve_mining_open: false,
        graduated: false,
        curve_phase_ends_at: 0,
    }
}

/// A mine with a 1_000_000 discovery allocation, a 500 bps epoch budget (50_000)
/// and the default 100 bps per-call ceiling (10_000).
fn test_mine_with_discovery() -> Mine {
    let mut mine = test_mine(1_000_000);
    mine.remaining_discovery_reserve = 1_000_000;
    mine.discovery_reserve_total = 1_000_000;
    mine.discovery_epoch_budget = 50_000;
    mine
}

fn test_market() -> LaunchMarket {
    LaunchMarket {
        mine: Pubkey::new_unique(),
        token_reserve: 950_000,
        sol_reserve: 50_000,
        virtual_sol_reserve: 10_000,
        graduation_target: 100_000,
        graduated: false,
        creator_fee_claimable: 0,
        platform_fee_claimable: 0,
        creator_fee_bps: DEFAULT_CREATOR_FEE_BPS,
        platform_fee_bps: DEFAULT_PLATFORM_FEE_BPS,
        bump: 0,
        version: ACCOUNT_VERSION,
        curve_mining_cap: 0,
        curve_mining_mined: 0,
        curve_mining_unpaid: 0,
        curve_mining_block_reward: 0,
    }
}

/// A market with the curve phase open: a token inventory, a launch-time cap and the
/// flat per-block output the launch would have derived from the runway.
fn test_curve_market(token_reserve: u64, cap: u64, block_reward: u64) -> LaunchMarket {
    let mut market = test_market();
    market.token_reserve = token_reserve;
    market.curve_mining_cap = cap;
    market.curve_mining_block_reward = block_reward;
    market
}

/// A mine whose market pays it during the curve phase.
fn test_curve_mine(curve_mining_open: bool) -> Mine {
    let mut mine = test_mine(1_000_000);
    mine.curve_mining_open = curve_mining_open;
    mine
}

fn test_pool(sol_reserve: u64, token_reserve: u64) -> LiquidityPoolV4 {
    LiquidityPoolV4 {
        mine: Pubkey::new_unique(),
        mint: Pubkey::new_unique(),
        token_vault: Pubkey::new_unique(),
        sol_vault: Pubkey::new_unique(),
        token_reserve,
        sol_reserve,
        graduated_at: 0,
        bump: 0,
    }
}

fn err_code(err: anchor_lang::error::Error) -> u32 {
    match err {
        anchor_lang::error::Error::AnchorError(inner) => inner.error_code_number,
        anchor_lang::error::Error::ProgramError(_) => 0,
    }
}

fn assert_err(result: Result<()>, expected: DiggoError) {
    assert_eq!(err_code(result.unwrap_err()), OFFSET + expected as u32);
}


/// A mine left unsynced for `epochs` whole epochs, and the timestamp that far ahead.
/// The reserve is far larger than the walk will ever distribute, so the mine stays
/// MiningActive and every segment is bounded by the epoch boundary rather than by the
/// reserve running out.
///
/// Graduated, because that is the only phase in which a walk without the market may pay
/// from the Mining Reserve: these are the reserve-ledger tests, and a non-graduated mine
/// is on its curve however much reserve it still holds.
fn test_mine_unsynced_for(epochs: i64) -> (Mine, i64) {
    let mut mine = test_mine(1_000_000_000);
    mine.graduated = true;
    let now = mine.next_block_at + epochs * mine.epoch_length;
    (mine, now)
}

fn test_position(assigned_power: u64) -> MiningPositionV4 {
    MiningPositionV4 {
        owner: Pubkey::new_unique(),
        mine: Pubkey::new_unique(),
        assigned_power,
        last_reward_index: 0,
        pending_reward: 0,
        bump: 0,
    }
}

/// Every program source file except `lib.rs` (which is only the `#[program]` shell and the
/// module declarations), concatenated in a stable order, so a source-pinning test does not
/// depend on which module the item it pins happens to live in. Every line is indented by
/// four spaces so the item-boundary patterns below are the ones the pre-split helpers used.
fn program_source() -> String {
    fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, out);
                } else if path.extension().map(|ext| ext == "rs").unwrap_or(false) {
                    out.push(path);
                }
            }
        }
    }
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    walk(&root, &mut files);
    files.retain(|path| path.file_name().map(|name| name != "lib.rs").unwrap_or(true));
    files.sort();
    files
        .iter()
        .map(|path| {
            std::fs::read_to_string(path)
                .unwrap()
                .lines()
                .map(|line| format!("    {line}\n"))
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The source of one instruction handler: its signature up to whichever comes first,
/// the next handler or the next doc comment (which belongs to that handler, so it must
/// not be attributed to this one). Used below to pin the fact that the trading paths
/// never consult a circuit breaker and that only the pool's own swaps move its LP.
fn instruction_source(name: &str) -> String {
    let src = program_source();
    let start = src
        .find(&format!("pub fn {name}("))
        .expect("instruction handler exists");
    let rest = &src[start..];
    let next_fn = rest[1..].find("\n    pub fn ");
    let next_doc = rest[1..].find("\n    ///");
    let end = match (next_fn, next_doc) {
        (Some(a), Some(b)) => a.min(b) + 1,
        (Some(offset), None) | (None, Some(offset)) => offset + 1,
        (None, None) => rest.len(),
    };
    rest[..end].to_string()
}

/// The source of one Accounts struct, up to the next one.
fn accounts_struct_source(name: &str) -> String {
    let src = program_source();
    let start = src
        .find(&format!("pub struct {name}<'info> {{"))
        .expect("accounts struct exists");
    let rest = &src[start..];
    let end = rest[1..]
        .find("\n    pub struct ")
        .map(|offset| offset + 1)
        .unwrap_or(rest.len());
    rest[..end].to_string()
}

/// A private function's source, up to the next one. Same idea as instruction_source, for
/// the ledger helpers that are not instructions.
fn function_source(name: &str) -> String {
    let src = program_source();
    let start = src.find(&format!("fn {name}(")).expect("function exists");
    let rest = &src[start..];
    let end = rest[1..]
        .find("\n    fn ")
        .map(|offset| offset + 1)
        .unwrap_or(rest.len());
    rest[..end].to_string()
}


#[test]
fn reserve_and_discovery_split_never_exceed_supply() {
    let total_supply = 1_000_000_000u64;
    let reserve = mul_bps(total_supply, DEFAULT_RESERVE_BPS).unwrap();
    let discovery = mul_bps(total_supply, DEFAULT_DISCOVERY_RESERVE_BPS).unwrap();
    assert_eq!(reserve, 50_000_000);
    assert_eq!(discovery, 5_000_000);
    assert!(reserve + discovery < total_supply);
    assert!(mul_bps(u64::MAX, 10_000).is_ok());
}

#[test]
fn reward_reduction_never_drops_below_minimum() {
    assert_eq!(reduced_reward(10_000, 2_500, 1).unwrap(), 7_500);
    assert_eq!(reduced_reward(1, 2_500, 1).unwrap(), 1);
}

#[test]
fn buy_quote_has_slippage_and_cannot_empty_vault() {
    let small = quote_buy(950_000_000, 0, 10_000_000_000, 1_000_000_000).unwrap();
    let large = quote_buy(950_000_000, 0, 10_000_000_000, 2_000_000_000).unwrap();
    assert!(large > small);
    assert!(large < small * 2);
    assert!(large < 950_000_000);
}

#[test]
fn sell_quote_never_exceeds_real_sol_reserve() {
    let out = quote_sell(500_000_000, 50_000_000_000, 10_000_000_000, u64::MAX).unwrap();
    assert!(out <= 50_000_000_000);
}

#[test]
fn mine_never_accounts_more_than_the_reserve() {
    let mut mine = test_mine(250);
    // The reserve only ever pays after graduation, so this is the phase the reserve
    // ledger's own tests are about.
    mine.graduated = true;
    sync_mine(&mut mine, None, 1_500).unwrap();
    assert_eq!(mine.cumulative_distributed, 250);
    assert_eq!(mine.remaining_reserve, 0);
    assert!(mine.status == MineStatus::FullyMined);
}

/// A mine left unsynced for 200 epochs is not a dead mine. Repeated bounded calls walk
/// it to exactly the ledger one unbounded pass produces, whichever per-call budget is
/// used, and every call that reports Behind has strictly advanced the cursors.
#[test]
fn mine_sync_is_resumable_and_matches_a_single_pass() {
    let (_, now) = test_mine_unsynced_for(200);
    let (mut reference, _) = test_mine_unsynced_for(200);
    assert_eq!(
        sync_mine_with_budget(&mut reference, None, now, usize::MAX).unwrap(),
        SyncProgress::CaughtUp
    );

    let (mut production, _) = test_mine_unsynced_for(200);
    let mut calls = 0usize;
    let mut previous = (
        production.next_block_at,
        production.epoch,
        production.reward_index,
        production.cumulative_distributed,
    );
    let production_calls = loop {
        calls += 1;
        assert!(calls <= 16, "200 epochs must converge in a handful of calls");
        if sync_mine(&mut production, None, now).unwrap() == SyncProgress::CaughtUp {
            break calls;
        }
        let current = (
            production.next_block_at,
            production.epoch,
            production.reward_index,
            production.cumulative_distributed,
        );
        assert!(current.0 > previous.0, "next_block_at must strictly advance");
        assert!(
            current.1 >= previous.1,
            "the epoch cursor must never go backwards"
        );
        assert!(
            current.2 >= previous.2,
            "the reward index must never go backwards"
        );
        assert!(
            current.3 >= previous.3,
            "distributed rewards must never go backwards"
        );
        previous = current;
    };
    assert!(
        production_calls > 1,
        "a 200-epoch gap cannot fit into one call"
    );

    for budget in [1usize, 7, MAX_SYNC_SEGMENTS, usize::MAX] {
        let (mut mine, _) = test_mine_unsynced_for(200);
        loop {
            if sync_mine_with_budget(&mut mine, None, now, budget).unwrap() == SyncProgress::CaughtUp
            {
                break;
            }
        }
        assert_eq!(mine.next_block_at, reference.next_block_at);
        assert_eq!(mine.epoch, reference.epoch);
        assert_eq!(mine.epoch_ends_at, reference.epoch_ends_at);
        assert_eq!(mine.current_block_reward, reference.current_block_reward);
        assert_eq!(mine.reward_index, reference.reward_index);
        assert_eq!(mine.remaining_reserve, reference.remaining_reserve);
        assert_eq!(
            mine.cumulative_distributed,
            reference.cumulative_distributed
        );
        assert!(mine.status == reference.status);
        assert!(mine.status == MineStatus::MiningActive);
    }
}

/// The walk stops on an exhausted reserve however many calls it took, and never hands
/// out a token more than the reserve held.
#[test]
fn a_resumable_walk_never_distributes_more_than_the_reserve() {
    let (mut mine, now) = test_mine_unsynced_for(200);
    mine.remaining_reserve = 250;
    let mut calls = 0usize;
    loop {
        calls += 1;
        assert!(calls <= 8, "an exhausted reserve must end the walk");
        if sync_mine(&mut mine, None, now).unwrap() == SyncProgress::CaughtUp {
            break;
        }
    }
    assert_eq!(mine.cumulative_distributed, 250);
    assert_eq!(mine.remaining_reserve, 0);
    assert!(mine.status == MineStatus::FullyMined);
    assert!(sync_mine_to_now(&mut mine, None, now).is_ok());
}

/// No position may settle against a half-walked index. While the mine is behind,
/// sync_mine_to_now refuses with SyncBehind, and the index it refused to settle against
/// is strictly behind the truth, so a settling caller that skipped the gate would
/// credit only part of what the position earned and forfeit the rest behind
/// last_reward_index. Finishing the walk opens the gate.
#[test]
fn a_partially_synced_mine_can_never_settle_a_position() {
    let (mut mine, now) = test_mine_unsynced_for(200);
    assert_err(sync_mine_to_now(&mut mine, None, now), DiggoError::SyncBehind);
    assert!(!sync_is_complete(&mine, None, now));

    let mut position = test_position(1_000);
    let partial_index = mine.reward_index;
    settle_position(&mut position, &mine).unwrap();
    let partial_credit = position.pending_reward;

    let (mut reference, _) = test_mine_unsynced_for(200);
    sync_mine_with_budget(&mut reference, None, now, usize::MAX).unwrap();
    assert!(partial_index < reference.reward_index);
    let mut settled = test_position(1_000);
    settle_position(&mut settled, &reference).unwrap();
    assert!(partial_credit > 0 && partial_credit < settled.pending_reward);

    // The walk is a deterministic continuation of the persisted cursors, so finishing
    // it — by anyone, through the permissionless advance_mine — opens the gate.
    loop {
        if sync_mine(&mut mine, None, now).unwrap() == SyncProgress::CaughtUp {
            break;
        }
    }
    assert!(sync_is_complete(&mine, None, now));
    assert_eq!(mine.reward_index, reference.reward_index);
    assert!(sync_mine_to_now(&mut mine, None, now).is_ok());
}



/// The worker treats a SyncBehind refusal as the retryable answer - the program's own verdict
/// on whether a mine's ledger is caught up - so it matches that error by code. The variant's
/// index is pinned here so inserting an error above it has to be a deliberate edit on both
/// sides (shared/program.ts SYNC_BEHIND_ERROR_CODE).
#[test]
fn sync_behind_is_the_error_code_the_worker_matches() {
    assert_eq!(DiggoError::SyncBehind as u32, 44);
    assert_eq!(OFFSET + DiggoError::SyncBehind as u32, 6_044);
}

/// The walk cannot spin: a schedule that cannot advance a cursor is refused instead of
/// looping until the compute budget aborts the transaction.
#[test]
fn a_mine_with_an_unusable_schedule_fails_instead_of_spinning() {
    let (mut mine, now) = test_mine_unsynced_for(200);
    mine.epoch_length = 0;
    assert_err(
        sync_mine(&mut mine, None, now).map(|_| ()),
        DiggoError::InvalidSchedule,
    );
    let (mut mine, now) = test_mine_unsynced_for(200);
    mine.block_interval = 0;
    assert_err(
        sync_mine(&mut mine, None, now).map(|_| ()),
        DiggoError::InvalidSchedule,
    );
}


/// Spec 19, 23, 35: neither the admin (upgrade authority) nor the guardian can ever
/// withdraw a Mining or Discovery Reserve. The ledger that every reserve debit goes
/// through has no arm that permits it.
#[test]
fn admin_and_guardian_can_never_debit_either_reserve() {
    let mut mine = test_mine(1_000);
    mine.remaining_discovery_reserve = 500;

    for amount in [1u64, 500, 1_000, u64::MAX] {
        assert_err(
            apply_reserve_debit(&mut mine, ReserveDebit::AdminWithdraw, amount),
            DiggoError::ReserveWithdrawForbidden,
        );
    }

    assert_eq!(mine.remaining_reserve, 1_000);
    assert_eq!(mine.remaining_discovery_reserve, 500);
    assert_eq!(mine.cumulative_distributed, 0);
}

/// The two legitimate claim paths, and only those two, may shrink a reserve, and each
/// one can only touch its own reserve.
#[test]
fn only_a_matching_claim_source_may_debit_a_reserve() {
    let mut mine = test_mine(1_000);
    mine.remaining_discovery_reserve = 500;

    assert_err(
        apply_reserve_debit(&mut mine, ReserveDebit::DiscoveryClaim, 501),
        DiggoError::InsufficientDiscoveryReserve,
    );
    assert_err(
        apply_reserve_debit(&mut mine, ReserveDebit::MiningClaim, 1_001),
        DiggoError::InsufficientReserve,
    );
    assert_eq!(mine.remaining_reserve, 1_000);
    assert_eq!(mine.remaining_discovery_reserve, 500);

    apply_reserve_debit(&mut mine, ReserveDebit::MiningClaim, 1_000).unwrap();
    assert_eq!(mine.remaining_reserve, 0);
    assert_eq!(mine.cumulative_distributed, 1_000);
    assert_eq!(mine.remaining_discovery_reserve, 500);

    apply_reserve_debit(&mut mine, ReserveDebit::DiscoveryClaim, 500).unwrap();
    assert_eq!(mine.remaining_discovery_reserve, 0);
    assert_eq!(mine.cumulative_distributed, 1_000);
}

/// Spec 35, 37: a creator can claim their own trading fee and nothing else — never
/// LP SOL, never the other fee bucket, never a program reserve.
#[test]
fn creator_fee_claim_can_never_take_lp_sol() {
    const RENT: u64 = 1_000;
    let mut market = test_market();
    market.sol_reserve = 50_000;
    market.creator_fee_claimable = 300;
    market.platform_fee_claimable = 200;
    // the lamport invariant the buy/sell paths maintain
    let lamports =
        RENT + market.sol_reserve + market.creator_fee_claimable + market.platform_fee_claimable;

    assert_eq!(
        withdrawable_fee(&market, lamports, RENT, FeeBucket::Creator).unwrap(),
        market.creator_fee_claimable
    );
    assert_eq!(
        withdrawable_fee(&market, lamports, RENT, FeeBucket::Platform).unwrap(),
        market.platform_fee_claimable
    );

    // a market holding only LP SOL cannot pay the claimable fee out of it
    assert_err(
        withdrawable_fee(&market, RENT + market.sol_reserve, RENT, FeeBucket::Creator).map(|_| ()),
        DiggoError::InsufficientLiquidity,
    );

    // an empty bucket has nothing to claim, whatever the market holds
    let empty = test_market();
    assert_err(
        withdrawable_fee(
            &empty,
            RENT + empty.sol_reserve + 500,
            RENT,
            FeeBucket::Creator,
        )
        .map(|_| ()),
        DiggoError::NothingToClaim,
    );
}

/// Spec 47, 57: a discovery id can only ever be paid once. The receipt PDA is seeded
/// by (mine, discovery_id), so a replay collides with the existing account.
#[test]
fn discovery_receipt_seeds_make_replays_impossible() {
    use std::collections::HashSet;
    let mine = Pubkey::new_unique();
    let other_mine = Pubkey::new_unique();
    let mut issued: HashSet<Vec<u8>> = HashSet::new();

    assert!(issued.insert(discovery_receipt_seeds(&mine, 7)));
    assert!(!issued.insert(discovery_receipt_seeds(&mine, 7)));
    assert!(issued.insert(discovery_receipt_seeds(&mine, 8)));
    assert!(issued.insert(discovery_receipt_seeds(&other_mine, 7)));

    let seeds = discovery_receipt_seeds(&mine, 7);
    let prefix = DISCOVERY_RECEIPT_SEED.len();
    assert_eq!(seeds.len(), prefix + 32 + 8);
    assert_eq!(&seeds[..prefix], DISCOVERY_RECEIPT_SEED);
    assert_eq!(&seeds[prefix..prefix + 32], mine.as_ref());
    assert_eq!(&seeds[prefix + 32..], &7u64.to_le_bytes());
}

/// Spec 65: both scoped breakers stop discovery payouts, and neither of them can be
/// bypassed by a keeper call.
#[test]
fn discovery_payout_is_blocked_by_either_pause_flag() {
    let mine = test_mine_with_discovery();
    let mut protocol = test_protocol();
    assert!(approve_discovery_payout(&protocol, &mine, 1_000, 0).is_ok());

    protocol.discovery_payouts_paused = true;
    assert_err(
        approve_discovery_payout(&protocol, &mine, 1_000, 0).map(|_| ()),
        DiggoError::DiscoveryPayoutsPaused,
    );
    protocol.discovery_payouts_paused = false;

    let mut paused_mine = test_mine_with_discovery();
    paused_mine.discovery_paused = true;
    assert_err(
        approve_discovery_payout(&protocol, &paused_mine, 1_000, 0).map(|_| ()),
        DiggoError::MineDiscoveryPaused,
    );
}

/// Spec 45, 65: per-call ceiling, per-mine per-epoch budget, epoch rollover and
/// reserve sufficiency all bind on-chain, not just in the backend.
#[test]
fn discovery_per_call_cap_epoch_budget_and_reserve_are_enforced() {
    let protocol = test_protocol();
    let mine = test_mine_with_discovery();
    let max_per_call = mul_bps(mine.discovery_reserve_total, protocol.discovery_max_bps).unwrap();
    assert_eq!(max_per_call, 10_000);
    assert_eq!(mine.discovery_epoch_budget, 50_000);

    assert!(approve_discovery_payout(&protocol, &mine, max_per_call, 0).is_ok());
    assert_err(
        approve_discovery_payout(&protocol, &mine, max_per_call + 1, 0).map(|_| ()),
        DiggoError::DiscoveryAmountTooLarge,
    );
    assert_err(
        approve_discovery_payout(&protocol, &mine, 0, 0).map(|_| ()),
        DiggoError::InvalidAmount,
    );

    let mut spent = test_mine_with_discovery();
    spent.discovery_epoch_spent = mine.discovery_epoch_budget;
    assert_err(
        approve_discovery_payout(&protocol, &spent, 1, 0).map(|_| ()),
        DiggoError::DiscoveryEpochBudgetExceeded,
    );

    // the next epoch resets the counter
    let rolled =
        approve_discovery_payout(&protocol, &spent, 1_000, spent.discovery_epoch_ends_at).unwrap();
    assert_eq!(rolled.epoch_spent, 1_000);
    assert!(rolled.epoch_ends_at > spent.discovery_epoch_ends_at);
    assert_eq!(rolled.epoch_budget, spent.discovery_epoch_budget);

    let mut drained = test_mine_with_discovery();
    drained.remaining_discovery_reserve = 999;
    assert_err(
        approve_discovery_payout(&protocol, &drained, 1_000, 0).map(|_| ()),
        DiggoError::InsufficientDiscoveryReserve,
    );
}

/// Spec 65: emergency controls must be scoped. Trading must keep working while
/// discoveries and claims are paused.
#[test]
fn trading_quotes_are_independent_of_circuit_breakers() {
    let market = test_market();
    let mut protocol = test_protocol();
    let mine = test_mine_with_discovery();

    let buy = quote_buy(
        market.token_reserve,
        market.sol_reserve,
        market.virtual_sol_reserve,
        1_000_000,
    )
    .unwrap();
    let sell = quote_sell(
        market.token_reserve,
        market.sol_reserve,
        market.virtual_sol_reserve,
        1_000_000,
    )
    .unwrap();
    let fees = net_after_fees(1_000_000, market.creator_fee_bps, market.platform_fee_bps).unwrap();

    protocol.discovery_payouts_paused = true;
    protocol.reward_claims_paused = true;
    assert_eq!(
        buy,
        quote_buy(
            market.token_reserve,
            market.sol_reserve,
            market.virtual_sol_reserve,
            1_000_000
        )
        .unwrap()
    );
    assert_eq!(
        sell,
        quote_sell(
            market.token_reserve,
            market.sol_reserve,
            market.virtual_sol_reserve,
            1_000_000
        )
        .unwrap()
    );
    assert_eq!(
        fees,
        net_after_fees(1_000_000, market.creator_fee_bps, market.platform_fee_bps).unwrap()
    );
    // the discovery gate is the only thing the flags change
    assert_err(
        approve_discovery_payout(&protocol, &mine, 1_000, 0).map(|_| ()),
        DiggoError::DiscoveryPayoutsPaused,
    );
}



/// Spec 35, 37: both fees are explicit, capped, floored, and conserve lamports.
#[test]
fn fee_math_is_capped_and_conserves_lamports() {
    let (net, creator, platform) = net_after_fees(10_000, 100, 100).unwrap();
    assert_eq!((net, creator, platform), (9_800, 100, 100));
    assert_eq!(net + creator + platform, 10_000);
    assert_eq!(net_after_fees(10_000, 0, 0).unwrap(), (10_000, 0, 0));

    assert_err(
        net_after_fees(10_000, MAX_TRADING_FEE_BPS + 1, 0).map(|_| ()),
        DiggoError::FeeTooHigh,
    );
    assert_err(
        net_after_fees(10_000, 0, MAX_TRADING_FEE_BPS + 1).map(|_| ()),
        DiggoError::FeeTooHigh,
    );

    // rounding never mints or burns a lamport
    let (net, creator, platform) = net_after_fees(3, 100, 100).unwrap();
    assert_eq!(net + creator + platform, 3);

    // accrual only ever adds to the two buckets
    let mut market = test_market();
    accrue_fees(&mut market, creator, platform).unwrap();
    assert_eq!(market.creator_fee_claimable, creator);
    assert_eq!(market.platform_fee_claimable, platform);
    assert_eq!(market.sol_reserve, test_market().sol_reserve);
}

/// Spec 12: the keeper can never push unbounded Crew Power.
#[test]
fn keeper_power_is_bounded_by_config_and_per_call_increase() {
    let protocol = test_protocol();
    assert_eq!(protocol.max_crew_power, DEFAULT_MAX_CREW_POWER);
    assert!(protocol.max_crew_power < MAX_CREW_POWER_HARD_CAP);
    assert!(MAX_CREW_POWER_HARD_CAP < 10_000_000);

    // an ordinary sync, inside both bounds
    assert!(validate_power_update(
        &protocol,
        STARTER_POWER,
        STARTER_POWER + MIN_POWER_STEP
    )
    .is_ok());

    // above the configured ceiling
    assert_err(
        validate_power_update(&protocol, STARTER_POWER, protocol.max_crew_power + 1),
        DiggoError::PowerOutOfRange,
    );

    // a single jump beyond the per-call increase bound
    let allowed = 10_000 + mul_bps(10_000, protocol.max_power_increase_bps).unwrap() + MIN_POWER_STEP;
    assert!(validate_power_update(&protocol, 10_000, allowed).is_ok());
    assert_err(
        validate_power_update(&protocol, 10_000, allowed + 1),
        DiggoError::PowerIncreaseTooLarge,
    );

    // decreases stay possible, so abuse handling can still reduce power
    assert!(validate_power_update(&protocol, 10_000, 0).is_ok());

    // even a maximally permissive config cannot exceed the protocol hard cap
    let mut loose = test_protocol();
    loose.max_crew_power = MAX_CREW_POWER_HARD_CAP;
    assert_err(
        validate_power_update(&loose, 0, MAX_CREW_POWER_HARD_CAP + 1),
        DiggoError::PowerOutOfRange,
    );
}

// --- post-graduation liquidity pool (spec 35, 36) -----------------------------------

/// Spec 36: the pool is a real constant-product market. Across any sequence of swaps
/// the invariant k = x*y may only grow, so the locked liquidity can be traded against
/// but never diluted away.
#[test]
fn pool_swaps_never_reduce_the_invariant() {
    let mut pool = test_pool(30_000_000_000, 700_000_000);
    let mut k = pool_invariant(&pool).unwrap();
    assert!(k > 0);

    for step in 0..8u64 {
        let sol_in = 100_000_000 * (step + 1);
        let (net, _, _) =
            net_after_fees(sol_in, DEFAULT_CREATOR_FEE_BPS, DEFAULT_PLATFORM_FEE_BPS).unwrap();
        let tokens_out = pool_quote_buy(pool.token_reserve, pool.sol_reserve, net).unwrap();
        assert!(tokens_out > 0 && tokens_out < pool.token_reserve);

        apply_pool_swap(&mut pool, PoolDebit::Swap, net, 0, 0, tokens_out).unwrap();
        let after = pool_invariant(&pool).unwrap();
        assert!(after >= k, "buy step {step} reduced the pool invariant");
        k = after;

        let tokens_in = tokens_out / 2;
        let gross = pool_quote_sell(pool.token_reserve, pool.sol_reserve, tokens_in).unwrap();
        assert!(gross > 0 && gross < pool.sol_reserve);

        apply_pool_swap(&mut pool, PoolDebit::Swap, 0, tokens_in, gross, 0).unwrap();
        let after = pool_invariant(&pool).unwrap();
        assert!(after >= k, "sell step {step} reduced the pool invariant");
        k = after;
    }

    // the pool still holds a real, non-empty market on both sides
    assert!(pool.sol_reserve > 0 && pool.token_reserve > 0);
}

/// Neither side of the pool can be emptied by a single trade, whatever the size.
#[test]
fn pool_quotes_never_drain_a_side() {
    let tokens = 1_000_000_000_000_000u64;
    let sol = 1_000_000_000_000u64;

    let out = pool_quote_buy(tokens, sol, u64::MAX).unwrap();
    assert!(out > 0 && out < tokens);

    let gross = pool_quote_sell(tokens, sol, u64::MAX).unwrap();
    assert!(gross > 0 && gross <= sol);

    assert_err(
        pool_quote_buy(tokens, sol, 0).map(|_| ()),
        DiggoError::InvalidAmount,
    );
    assert_err(
        pool_quote_sell(tokens, sol, 0).map(|_| ()),
        DiggoError::InvalidAmount,
    );
    assert_err(
        pool_quote_buy(0, sol, 1).map(|_| ()),
        DiggoError::InsufficientLiquidity,
    );
    assert_err(
        pool_quote_buy(tokens, 0, 1).map(|_| ()),
        DiggoError::InsufficientLiquidity,
    );
    assert_err(
        pool_quote_sell(0, sol, 1).map(|_| ()),
        DiggoError::InsufficientLiquidity,
    );
    assert_err(
        pool_quote_sell(tokens, 0, 1).map(|_| ()),
        DiggoError::InsufficientLiquidity,
    );
}



// --- graduation ----------------------------------------------------------------------

/// Spec 36: graduation moves exactly the market's curve reserves into the pool, and
/// nothing else — not the fee buckets, not rent. Both assets are conserved.
#[test]
fn graduation_moves_exactly_the_reserve_amounts() {
    let mut market = test_market();
    market.sol_reserve = 120_000;
    market.token_reserve = 830_000;
    market.creator_fee_claimable = 700;
    market.platform_fee_claimable = 300;

    let plan = plan_graduation(&market).unwrap();
    assert_eq!(plan.sol, 120_000);
    assert_eq!(plan.tokens, 830_000);

    let mut pool = test_pool(0, 0);
    let tokens_before = market.token_reserve;
    let sol_before = market.sol_reserve;
    apply_graduation(&mut market, &mut pool, plan).unwrap();

    assert_eq!(pool.sol_reserve, sol_before);
    assert_eq!(pool.token_reserve, tokens_before);
    assert_eq!(market.sol_reserve, 0);
    assert_eq!(market.token_reserve, 0);
    assert!(market.graduated);
    // the fee buckets are untouched by graduation
    assert_eq!(market.creator_fee_claimable, 700);
    assert_eq!(market.platform_fee_claimable, 300);
    // and the invariant of the pool is exactly the market's old k
    assert_eq!(
        pool_invariant(&pool).unwrap(),
        (sol_before as u128) * (tokens_before as u128)
    );
}

/// Graduation requires a genuinely funded market, happens once, and cannot be replayed
/// onto a pool that already holds liquidity.
#[test]
fn graduation_is_gated_and_single_shot() {
    let mut market = test_market();
    market.graduation_target = 100_000;
    market.sol_reserve = 99_999;
    assert_err(
        plan_graduation(&market).map(|_| ()),
        DiggoError::GraduationTargetNotMet,
    );

    market.sol_reserve = market.graduation_target;
    assert!(plan_graduation(&market).is_ok());

    market.graduated = true;
    assert_err(
        plan_graduation(&market).map(|_| ()),
        DiggoError::MarketAlreadyGraduated,
    );

    // a funded market with no tokens left has nothing to lock
    let mut empty = test_market();
    empty.sol_reserve = empty.graduation_target;
    empty.token_reserve = 0;
    assert_err(plan_graduation(&empty).map(|_| ()), DiggoError::InvalidMarket);

    // a pool that already holds liquidity cannot be graduated into again
    let mut funded = test_market();
    funded.sol_reserve = funded.graduation_target;
    let plan = plan_graduation(&funded).unwrap();
    let mut pool = test_pool(1, 1);
    assert_err(
        apply_graduation(&mut funded, &mut pool, plan).map(|_| ()),
        DiggoError::InvalidPool,
    );
    assert!(!funded.graduated);
}


// --- account versioning and migration -------------------------------------------------

/// The exact bytes a legacy account holds: the payload as it was written before the
/// version field existed, inside the space the old layout reserved for it. `dropped` is
/// how many trailing bytes the older layout did not carry — the version byte itself on a
/// pre-version layout, or the fields a later upgrade appended after it.
fn legacy_account_bytes<T: AnchorSerialize>(
    discriminator: &[u8],
    value: &T,
    total_len: usize,
    dropped: usize,
) -> Vec<u8> {
    let mut payload = borsh::to_vec(value).unwrap();
    payload.truncate(payload.len() - dropped);
    assert!(8 + payload.len() <= total_len, "legacy layout is too small");
    let mut data = vec![0u8; total_len];
    data[..8].copy_from_slice(discriminator);
    data[8..8 + payload.len()].copy_from_slice(&payload);
    data
}

/// The size of a market account as it was before the curve-mining ledger existed.
const MARKET_V1_SPACE: usize = 8 + LaunchMarket::INIT_SPACE - MARKET_CURVE_APPENDED_BYTES;

/// The exact bytes a market held before the curve-mining ledger was appended: its
/// payload with the fields that sit after the version byte removed, which is what the
/// version byte was for.
fn legacy_market_bytes(market: &LaunchMarket, total_len: usize) -> Vec<u8> {
    let mut payload = borsh::to_vec(market).unwrap();
    payload.truncate(payload.len() - MARKET_CURVE_APPENDED_BYTES);
    assert!(8 + payload.len() <= total_len, "legacy layout is too small");
    let mut data = vec![0u8; total_len];
    data[..8].copy_from_slice(LaunchMarket::DISCRIMINATOR);
    data[8..8 + payload.len()].copy_from_slice(&payload);
    data
}








/// The version byte is the last field of every migratable account, which is what makes
/// the append-only migration possible in the first place.
#[test]
fn the_version_byte_marks_where_a_legacy_layout_ended() {
    // ProtocolConfigV4 has had nothing appended since the version byte, so it still ends
    // with it. Mine and LaunchMarket have: the curve-phase flag and the curve-mining
    // ledger go after the version byte, which is what lets a pre-curve account still
    // decode instead of a byte of its own payload being read as a new field.
    let protocol = borsh::to_vec(&test_protocol()).unwrap();
    assert_eq!(*protocol.last().unwrap(), ACCOUNT_VERSION);

    let mine = borsh::to_vec(&test_mine(0)).unwrap();
    assert_eq!(
        mine[mine.len() - 1 - MINE_PHASE_APPENDED_BYTES],
        ACCOUNT_VERSION
    );

    let market = borsh::to_vec(&test_market()).unwrap();
    assert_eq!(
        market[market.len() - 1 - MARKET_CURVE_APPENDED_BYTES],
        ACCOUNT_VERSION
    );
    // mine, token_reserve, sol_reserve, virtual_sol_reserve, graduation_target,
    // graduated, both fee buckets, both fee bps, bump and version: 71 bytes on their
    // own, plus the four appended curve fields.
    assert_eq!(
        LaunchMarket::INIT_SPACE,
        32 + 8 + 8 + 8 + 8 + 1 + 8 + 8 + 2 + 2 + 1 + 1 + MARKET_CURVE_APPENDED_BYTES
    );

    // A mine written before the phase fields existed decodes, and reads all of them at
    // their safe default: no curve budget, no graduation, and no cursor - which refuses
    // rather than paying a curve-phase block out of the reserve.
    let mut curve_mine = test_mine(0);
    curve_mine.curve_mining_open = true;
    let mut legacy = Mine::DISCRIMINATOR.to_vec();
    let mut payload = borsh::to_vec(&curve_mine).unwrap();
    // The flags and the cursor are all appended after the version byte.
    payload.truncate(payload.len() - MINE_PHASE_APPENDED_BYTES);
    legacy.extend_from_slice(&payload);
    legacy.resize(legacy.len() + MINE_PHASE_APPENDED_BYTES, 0);
    let decoded = Mine::try_deserialize(&mut &legacy[..]).unwrap();
    assert_eq!(decoded.version, ACCOUNT_VERSION);
    assert!(!decoded.curve_mining_open);
    assert!(!decoded.graduated);
    assert_eq!(
        decoded.curve_phase_ends_at, 0,
        "no cursor: the phase follows graduated alone, as it did before the field existed"
    );

    // And a market written before the curve-mining ledger existed reads as a market with
    // no curve budget at all, never as one with an allowance it was not launched with.
    let mut curve_market = test_curve_market(950_000, 47_500, 100);
    curve_market.curve_mining_mined = 1_000;
    let mut legacy_market = LaunchMarket::DISCRIMINATOR.to_vec();
    let mut market_payload = borsh::to_vec(&curve_market).unwrap();
    market_payload.truncate(market_payload.len() - MARKET_CURVE_APPENDED_BYTES);
    legacy_market.extend_from_slice(&market_payload);
    // What the account itself looks like: allocated at the v1 size, so reading the fields
    // that were appended after the version byte runs into zeroed bytes.
    legacy_market.resize(legacy_market.len() + MARKET_CURVE_APPENDED_BYTES, 0);
    let decoded_market = LaunchMarket::try_deserialize(&mut &legacy_market[..]).unwrap();
    assert!(!decoded_market.graduated);
    assert_eq!(decoded_market.token_reserve, 950_000);
    assert_eq!(decoded_market.curve_mining_cap, 0);
    assert_eq!(decoded_market.curve_mining_mined, 0);
    assert_eq!(decoded_market.curve_mining_block_reward, 0);
}

// --- curve-phase mining (the pre-graduation emission source) ------------------------------


/// The curve's spot price as an exact fraction of lamports of effective SOL per base unit
/// of token, so a comparison needs no rounding.
fn curve_spot(market: &LaunchMarket) -> (u128, u128) {
    (
        (market.sol_reserve + market.virtual_sol_reserve) as u128,
        market.token_reserve as u128,
    )
}

fn spot_price_rose(after: &LaunchMarket, before: &LaunchMarket) -> bool {
    let (an, ad) = curve_spot(after);
    let (bn, bd) = curve_spot(before);
    an * bd > bn * ad
}

/// The economic core of the product decision: pre-graduation mining is paid out of the
/// curve's own token inventory, so a mined token moves the token side exactly where a
/// bought one moves it, and brings no SOL with it.
#[test]
fn a_mining_debit_moves_the_token_side_exactly_like_a_buy() {
    let before = test_curve_market(1_000_000, 250_000, 100);
    let mined_tokens = 250_000u64;
    let mut mined = before.clone();
    apply_curve_mining_debit(&mut mined, CurveDebit::MiningEmission, mined_tokens).unwrap();

    // A buyer who took the same token amount off the curve leaves exactly this token side
    // behind; the difference between the two is only what the buyer paid.
    let mut bought = before.clone();
    bought.token_reserve -= mined_tokens;
    bought.sol_reserve += 60_000;
    assert_eq!(
        mined.token_reserve, bought.token_reserve,
        "the token side must move exactly as a buy's does"
    );
    assert_eq!(mined.sol_reserve, before.sol_reserve);
    assert_eq!(mined.virtual_sol_reserve, before.virtual_sol_reserve);
    assert!(spot_price_rose(&mined, &before));

    // And the whole of a buy quote's change comes from that token side: the same SOL buys
    // exactly token_reserve_after / token_reserve_before of what it bought before.
    let net_sol = 60_000u64;
    let quote_before = quote_buy(
        before.token_reserve,
        before.sol_reserve,
        before.virtual_sol_reserve,
        net_sol,
    )
    .unwrap();
    let quote_after = quote_buy(
        mined.token_reserve,
        mined.sol_reserve,
        mined.virtual_sol_reserve,
        net_sol,
    )
    .unwrap();
    assert_eq!(quote_before, 500_000);
    assert_eq!(quote_after, 375_000);
    assert_eq!(
        quote_after,
        quote_before * (before.token_reserve - mined_tokens) / before.token_reserve
    );
}

/// The hard cap: cumulative curve emission can never pass what the launch asked for,
/// however many blocks it is split over, and the debit can never take more than the curve
/// holds.
#[test]
fn curve_mining_can_never_pass_the_cap_however_many_blocks_it_takes() {
    let mut market = test_curve_market(1_000_000, 1_000, 7);
    let mut total = 0u64;
    while curve_mining_is_open(&market) {
        let amount = curve_mining_room(&market).min(7);
        apply_curve_mining_debit(&mut market, CurveDebit::MiningEmission, amount).unwrap();
        total += amount;
        assert!(market.curve_mining_mined <= market.curve_mining_cap);
    }
    assert_eq!(total, 1_000, "an uneven rate must still land on the cap exactly");
    assert_eq!(market.curve_mining_mined, 1_000);
    assert_eq!(market.token_reserve, 999_000);
    assert_eq!(market.curve_mining_unpaid, 1_000);

    // The next base unit is refused and the refusal changes nothing.
    assert_err(
        apply_curve_mining_debit(&mut market, CurveDebit::MiningEmission, 1),
        DiggoError::CurveMiningCapExceeded,
    );
    assert_eq!(market.token_reserve, 999_000);
    assert_eq!(market.curve_mining_mined, 1_000);

    // Under its own cap the debit is still bounded by the inventory it draws from.
    let mut thin = test_curve_market(10, 1_000, 7);
    assert_err(
        apply_curve_mining_debit(&mut thin, CurveDebit::MiningEmission, 11),
        DiggoError::InsufficientLiquidity,
    );
    assert_eq!(thin.token_reserve, 10);
}



/// Mined tokens bring no SOL, so the curve's sell capacity is the real SOL reserve and
/// mining cannot raise it.
#[test]
fn mining_never_adds_sell_capacity() {
    let before = test_curve_market(1_000_000, 50_000, 100);
    let mut after = before.clone();
    apply_curve_mining_debit(&mut after, CurveDebit::MiningEmission, 50_000).unwrap();
    assert_eq!(after.sol_reserve, before.sol_reserve);
    // Selling the whole curve back is worth exactly what it was worth before the debit:
    // the real SOL is the ceiling and mining did not move it.
    assert_eq!(
        quote_sell(
            after.token_reserve,
            after.sol_reserve,
            after.virtual_sol_reserve,
            after.token_reserve
        )
        .unwrap(),
        quote_sell(
            before.token_reserve,
            before.sol_reserve,
            before.virtual_sol_reserve,
            before.token_reserve
        )
        .unwrap()
    );
    for tokens_in in [1u64, 1_000, 500_000, u64::MAX / 2, u64::MAX] {
        let quoted = quote_sell(
            after.token_reserve,
            after.sol_reserve,
            after.virtual_sol_reserve,
            tokens_in,
        )
        .unwrap();
        assert!(
            quoted <= after.sol_reserve,
            "a sell can never outrun the real SOL reserve"
        );
    }
}

/// Conservation across the whole curve phase: what is left in the curve plus what mining
/// took out plus what buyers took out, net of what sellers put back, is the inventory the
/// launch created.
#[test]
fn curve_mining_conserves_the_curve_inventory_through_trades_and_graduation() {
    let initial = 950_000u64;
    let mut market = test_curve_market(initial, 47_500, 100);
    market.sol_reserve = market.graduation_target;
    let mut bought_out = 0u64;
    let mut sold_back = 0u64;
    for tokens in [1_000u64, 2_500, 4_000, 3_000] {
        market.token_reserve -= tokens;
        bought_out += tokens;
    }
    for tokens in [800u64, 1_200] {
        market.token_reserve += tokens;
        sold_back += tokens;
    }
    apply_curve_mining_debit(&mut market, CurveDebit::MiningEmission, 20_000).unwrap();
    assert_eq!(
        market.token_reserve + market.curve_mining_mined + bought_out - sold_back,
        initial,
        "tokens in the curve + mined out + sold == the launch inventory"
    );

    // Graduation moves exactly the inventory the curve still holds, and leaves the mined
    // but unclaimed tokens in the vault for the positions the index already credited.
    let plan = plan_graduation(&market).unwrap();
    assert_eq!(plan.tokens, market.token_reserve);
    assert_eq!(market.curve_mining_unpaid, 20_000);
    let mut pool = test_pool(0, 0);
    apply_graduation(&mut market, &mut pool, plan).unwrap();
    assert!(market.graduated);
    assert_eq!(market.token_reserve, 0);
    assert_eq!(pool.token_reserve, plan.tokens, "the pool gets the post-mining curve");
    assert_eq!(
        market.curve_mining_unpaid, 20_000,
        "graduation never moves tokens a position has already been credited with"
    );
    assert_eq!(
        pool.token_reserve + market.curve_mining_unpaid + bought_out - sold_back,
        initial,
        "the pool holds the curve and the vault holds the mined but unclaimed"
    );
    assert_eq!(market.curve_mining_cap, 47_500, "the cap survives graduation");
}

/// The curve only ever gives up what the reward index can actually pay, and everything it
/// gives up stays claimable. The index divides each segment's budget by the mine's power
/// and truncates, and the integer index carries those remainders forward: the debit
/// follows the index exactly, so a remainder that is owed to nobody never leaves the curve
/// inventory - where at graduation it is moved into the pool rather than left stranded in
/// the market vault, reading as claimable for the rest of the market's life.
#[test]
fn the_curve_debits_exactly_what_the_index_owes() {
    // A power that does not divide the budget, so the very first block leaves a remainder:
    // seven base units split eleven ways is six owed and one owed to nobody.
    let mut mine = test_curve_mine(true);
    mine.total_power = 11;
    let mut market = test_curve_market(1_000_000, 1_000, 7);
    let tokens_before = market.token_reserve;
    let one_block = mine.next_block_at;
    sync_mine_with_budget(&mut mine, Some(&mut market), one_block, usize::MAX).unwrap();

    assert_eq!(market.curve_mining_mined, 6);
    assert_eq!(market.token_reserve, tokens_before - 6);
    assert_eq!(market.curve_mining_unpaid, 6);
    assert_eq!(
        index_owed(mine.reward_index, mine.total_power).unwrap(),
        6,
        "the index owes exactly what was debited"
    );
    // And the whole position - every base unit the index can pay it - is a claim on the
    // unpaid total, never more.
    let mut position = test_position(11);
    settle_position(&mut position, &mine).unwrap();
    assert_eq!(position.pending_reward, market.curve_mining_unpaid);

    // Spent to the end of the cap: every base unit that left the curve is still claimable
    // out of the unpaid total, and the curve's inventory is conserved.
    let mut spent = test_curve_mine(true);
    spent.total_power = 11;
    let mut market = test_curve_market(1_000_000, 1_000, 7);
    let now = spent.next_block_at + 300 * spent.epoch_length;
    sync_mine_with_budget(&mut spent, Some(&mut market), now, usize::MAX).unwrap();
    assert!(!curve_mining_is_open(&market));
    assert!(market.curve_mining_mined <= market.curve_mining_cap);
    let inventory = market.token_reserve;
    let unpaid = market.curve_mining_unpaid;
    assert_eq!(inventory + market.curve_mining_mined, tokens_before);
    assert_eq!(unpaid, market.curve_mining_mined);
    let mut whole = test_position(11);
    settle_position(&mut whole, &spent).unwrap();
    assert!(
        whole.pending_reward <= unpaid,
        "the vault must hold at least everything the index has credited"
    );

    // Graduation: the pool takes the curve's inventory - the unowed remainder included -
    // and the vault keeps exactly what positions can still claim.
    market.sol_reserve = market.graduation_target;
    let plan = plan_graduation(&market).unwrap();
    let mut pool = test_pool(0, 0);
    apply_graduation(&mut market, &mut pool, plan).unwrap();
    assert_eq!(pool.token_reserve, inventory);
    assert_eq!(market.curve_mining_unpaid, unpaid);
    assert_eq!(
        pool.token_reserve + market.curve_mining_unpaid,
        tokens_before,
        "nothing is stranded in the market vault after graduation"
    );
}

/// The walk pays the curve phase out of the curve at the launch-time rate, never out of
/// the Mining Reserve, and stops without marking the mine finished once the budget is
/// spent.
#[test]
fn the_walk_emits_from_the_curve_until_the_cap_is_spent() {
    let mut mine = test_curve_mine(true);
    let reserve_before = mine.remaining_reserve;
    let mut market = test_curve_market(1_000_000, 1_000, 7);
    let now = mine.next_block_at + 40 * mine.epoch_length;

    assert_eq!(
        sync_mine_with_budget(&mut mine, Some(&mut market), now, usize::MAX).unwrap(),
        SyncProgress::CaughtUp
    );
    assert_eq!(market.curve_mining_mined, 1_000, "an uneven rate lands on the cap");
    assert_eq!(market.token_reserve, 999_000);
    assert_eq!(market.curve_mining_unpaid, 1_000);
    assert_eq!(
        mine.remaining_reserve, reserve_before,
        "pre-graduation emission never touches the Mining Reserve"
    );
    assert!(
        mine.status != MineStatus::FullyMined,
        "a spent cap is idle, not finished"
    );
    assert!(!mine.curve_mining_open, "the phase flag follows the market");
    assert!(spot_price_rose(
        &market,
        &test_curve_market(1_000_000, 1_000, 7)
    ));

    // A later walk has nothing left to pay and leaves both sides exactly where they are.
    let mined = market.curve_mining_mined;
    let tokens = market.token_reserve;
    let later = now + 20 * mine.epoch_length;
    assert_eq!(
        sync_mine_with_budget(&mut mine, Some(&mut market), later, usize::MAX).unwrap(),
        SyncProgress::CaughtUp
    );
    assert_eq!(market.curve_mining_mined, mined);
    assert_eq!(market.token_reserve, tokens);
    assert_eq!(mine.remaining_reserve, reserve_before);

    // Graduation hands the mine back its own reserve and the schedule resumes.
    market.graduated = true;
    mine.curve_mining_open = false;
    let reserve = mine.remaining_reserve;
    let after_graduation = later + 10 * mine.epoch_length;
    sync_mine_with_budget(&mut mine, Some(&mut market), after_graduation, usize::MAX).unwrap();
    assert!(mine.remaining_reserve < reserve, "the reserve pays after graduation");
    assert!(mine.reward_index > 0);
}

/// The regression this pins: a large buy takes tokens out of the curve's inventory, so a
/// market can be left holding less than the emission it still owes. A walk whose segment
/// owed more than that inventory used to revert with InsufficientLiquidity inside
/// apply_curve_mining_debit - and a revert there is permanent, because the walk can never
/// get past the segment it cannot pay: advance_mine, every claim, every assignment and
/// graduation itself fail forever behind it.
///
/// Now the segment is clamped to what the curve actually holds, so the walk always
/// completes. What the inventory cannot cover is never emitted and never booked as
/// claimable: it is not in curve_mining_mined, because nothing left the curve, and not in
/// curve_mining_unpaid either, because a position can claim that total and there would be
/// nothing behind it. The phase closes - idle, not finished - and graduation still moves
/// exactly what is there.
#[test]
fn a_walk_whose_curve_inventory_cannot_cover_its_cap_emits_what_is_there_and_closes() {
    // The big buy: five base units left on the curve, a thousand still allowed under the
    // cap, and a flat rate of seven per block that the inventory cannot cover.
    let mut mine = test_curve_mine(true);
    let reserve_before = mine.remaining_reserve;
    let mut market = test_curve_market(5, 1_000, 7);
    let inventory_before = market.token_reserve;
    let now = mine.next_block_at + 10 * mine.epoch_length;

    assert_eq!(
        sync_mine_with_budget(&mut mine, Some(&mut market), now, usize::MAX).unwrap(),
        SyncProgress::CaughtUp,
        "the walk completes instead of reverting on an inventory it cannot cover"
    );

    // Everything the curve could give up was emitted, and nothing else was: four of the five
    // base units, because the last one is reserved so the market still has something to
    // graduate with.
    assert_eq!(market.curve_mining_mined, 4);
    assert_eq!(market.token_reserve, 1);
    assert_eq!(market.curve_mining_unpaid, 4);
    assert!(
        market.curve_mining_mined <= market.curve_mining_cap,
        "the cap is still the hard bound"
    );
    assert_eq!(
        market.token_reserve + market.curve_mining_mined,
        inventory_before,
        "conservation: what left the curve is exactly what was debited"
    );
    assert_eq!(
        market.curve_mining_mined, market.curve_mining_unpaid,
        "everything debited is claimable, and the shortfall is booked nowhere"
    );

    // The index credits only what was actually debited, so the market vault holds at least
    // everything a position can claim out of it.
    assert!(
        index_owed(mine.reward_index, mine.total_power).unwrap() <= market.curve_mining_unpaid,
        "the index may never credit more than the curve paid"
    );
    let mut position = test_position(mine.total_power);
    settle_position(&mut position, &mine).unwrap();
    assert!(position.pending_reward <= market.curve_mining_unpaid);

    // Closed, not finished: the phase flag follows the market, the Mining Reserve is
    // untouched, and the mine stays MiningActive so graduation turns the reserve back on.
    assert!(!curve_mining_is_open(&market));
    assert!(!mine.curve_mining_open, "the mirror follows the market");
    assert!(mine.status == MineStatus::MiningActive);
    assert_eq!(mine.remaining_reserve, reserve_before);

    // A later walk has nothing to pay and changes nothing, and the idle stretch was consumed
    // rather than left pending for the Mining Reserve to pay after graduation.
    let later = now + 10 * mine.epoch_length;
    assert_eq!(
        sync_mine_with_budget(&mut mine, Some(&mut market), later, usize::MAX).unwrap(),
        SyncProgress::CaughtUp
    );
    assert_eq!(market.token_reserve, 1);
    assert_eq!(market.curve_mining_mined, 4);
    assert_eq!(mine.remaining_reserve, reserve_before);
    assert!(mine.next_block_at > later);

    // Graduation still works, and the vault keeps exactly what positions can still claim.
    market.sol_reserve = market.graduation_target;
    let plan = plan_graduation(&market).unwrap();
    let mut pool = test_pool(0, 0);
    apply_graduation(&mut market, &mut pool, plan).unwrap();
    assert_eq!(pool.token_reserve, 1, "the reserved base unit seeds the pool");
    assert_eq!(market.curve_mining_unpaid, 4);
    assert_eq!(
        pool.token_reserve + market.curve_mining_unpaid,
        inventory_before,
        "nothing is stranded in the market vault after graduation"
    );
}

/// The clamp the walk above relies on, stated on its own: the room a curve segment may emit
/// into is never more than the curve actually holds, so apply_curve_mining_debit can never
/// be refused for liquidity however a buy moved the token reserve.
#[test]
fn the_curve_room_is_never_more_than_the_curve_holds() {
    for (tokens, cap, mined) in [
        (0u64, 1_000u64, 0u64),
        (5, 1_000, 0),
        (1, 1_000, 0),
        (1_000, 1_000, 999),
        (1_000_000, 1_000, 1_000),
    ] {
        let mut market = test_curve_market(tokens, cap, 7);
        market.curve_mining_mined = mined;
        let room = curve_mining_room(&market);
        assert!(
            room <= market.token_reserve.saturating_sub(1),
            "never the last base unit of the inventory"
        );
        assert!(room <= cap.saturating_sub(mined), "never more than the cap");
        if room > 0 {
            apply_curve_mining_debit(&mut market, CurveDebit::MiningEmission, room).unwrap();
            assert!(market.token_reserve > 0, "the curve is never emptied");
        }
    }

    // An inventory with nothing to spare closes the phase rather than leaving it open with
    // nothing to emit into; two base units is the smallest that is still open, because the
    // last one is reserved for graduation.
    assert!(!curve_mining_is_open(&test_curve_market(0, 1_000, 7)));
    assert!(!curve_mining_is_open(&test_curve_market(1, 1_000, 7)));
    assert!(curve_mining_is_open(&test_curve_market(2, 1_000, 7)));
}

/// A curve-phase mine cannot be walked without its market, because the walk would have to
/// guess which side pays. The answer is the retryable one, not a wrong-source payout.
#[test]
fn a_walk_without_the_market_refuses_an_open_curve_phase() {
    let (mut mine, now) = test_mine_unsynced_for(2);
    mine.graduated = false;
    mine.curve_mining_open = true;
    assert_err(sync_mine_to_now(&mut mine, None, now), DiggoError::SyncBehind);
    assert_err(
        sync_mine(&mut mine, None, now).map(|_| ()),
        DiggoError::SyncBehind,
    );
    assert_eq!(mine.reward_index, 0, "a refused walk changes nothing");
    assert_eq!(mine.remaining_reserve, 1_000_000_000, "and moves nothing");

    // Once the mine has graduated the reserve is the honest source, exactly as before -
    // and it is graduation, not the absence of a curve budget, that says so.
    let (mut closed, now) = test_mine_unsynced_for(2);
    closed.curve_mining_open = false;
    assert!(sync_mine_to_now(&mut closed, None, now).is_ok());
    assert!(closed.reward_index > 0);
}

/// The regression this pins: a spent curve cap pre-graduation used to look exactly like a
/// graduated market - both clear the curve-phase flag - so a walk without the market fell
/// through to the Mining Reserve and paid curve-phase blocks out of it. Which side pays is
/// a phase fact only the market can report, and a spent cap is idle: its blocks accrue
/// nothing and its reserve stays where it is.
#[test]
fn a_spent_cap_stays_idle_and_never_falls_through_to_the_reserve() {
    // Without the market there is no honest answer to give, and none is asked for any more:
    // every instruction that settles a position takes the market as a required account. So
    // the refusal is the retryable one, whatever the curve's cap state is - reading a spent
    // cap as a settled ledger is exactly the conclusion a market-less walk may not draw.
    let (mut idle, now) = test_mine_unsynced_for(2);
    idle.graduated = false;
    idle.curve_mining_open = false;
    let reserve_before = idle.remaining_reserve;
    assert_err(
        sync_mine(&mut idle, None, now).map(|_| ()),
        DiggoError::SyncBehind,
    );
    assert_eq!(idle.reward_index, 0, "an idle mine credits nothing");
    assert_eq!(
        idle.remaining_reserve, reserve_before,
        "a spent curve cap must never be paid out of the Mining Reserve"
    );
    assert!(
        idle.status == MineStatus::MiningActive,
        "idle is not finished: graduation turns the reserve back on"
    );

    // With the market it is the same answer, and the market is the authority even when the
    // mine's own mirrored flag is stale.
    let mut market = test_curve_market(1_000_000, 1_000, 7);
    market.curve_mining_mined = market.curve_mining_cap;
    let (mut idle, now) = test_mine_unsynced_for(2);
    idle.graduated = false;
    idle.curve_mining_open = true;
    let reserve_before = idle.remaining_reserve;
    let tokens_before = market.token_reserve;
    assert_eq!(
        sync_mine(&mut idle, Some(&mut market), now).unwrap(),
        SyncProgress::CaughtUp
    );
    assert_eq!(idle.reward_index, 0);
    assert_eq!(idle.remaining_reserve, reserve_before);
    assert_eq!(market.token_reserve, tokens_before);
    assert_eq!(market.curve_mining_mined, market.curve_mining_cap);
    assert_eq!(market.curve_mining_unpaid, 0);
    assert!(!idle.curve_mining_open, "the mirror follows the market");
    assert!(!idle.graduated);

    // The cursor still moves - the idle stretch is consumed, not left pending - so those
    // blocks can never be paid out of the reserve the moment the market graduates.
    assert!(idle.next_block_at > now);

    // Graduation is what switches the mine onto its reserve, market or no market.
    let mut graduated = market;
    graduated.graduated = true;
    let (mut mine, now) = test_mine_unsynced_for(2);
    mine.graduated = false; // stale: the market is the authority here
    mine.curve_mining_open = false;
    let reserve_before = mine.remaining_reserve;
    sync_mine(&mut mine, Some(&mut graduated), now).unwrap();
    assert!(mine.remaining_reserve < reserve_before, "the reserve pays");
    assert!(mine.graduated && mine.reward_index > 0);
}

/// The regression this pins: graduate_market used to flip the market's and the mine's
/// graduated flags without walking the ledger, and the walk derives its emission source from
/// the phase at walk time. Every block that had landed since the mine's cursor was therefore
/// paid out of the Mining Reserve the next time anybody walked it - at the reserve's own far
/// larger rate, with curve_mining_mined still reading zero and the curve's cap unspent -
/// while the curve inventory then seeded the pool in full.
///
/// Now the instruction walks the mine to now under the curve phase first, so the stretch
/// that landed before graduation is paid by the side that was open when it landed.
#[test]
fn graduation_walks_the_curve_phase_before_it_ends_it() {
    let initial = 1_000_000u64;
    let mut mine = test_curve_mine(true);
    let mut market = test_curve_market(initial, 100_000, 7);
    market.sol_reserve = market.graduation_target;
    let reserve_before = mine.remaining_reserve;
    // One whole epoch of blocks plus the block the cursor starts on.
    let now = mine.next_block_at + 2_016 * mine.block_interval;

    sync_mine_for_graduation(&mut mine, &mut market, now).unwrap();

    let blocks = 2_017u64;
    assert_eq!(market.curve_mining_mined, blocks * 7);
    assert_eq!(market.curve_mining_unpaid, blocks * 7);
    assert_eq!(market.token_reserve, initial - blocks * 7);
    assert!(mine.reward_index > 0);
    assert!(
        mine.next_block_at > now,
        "the walk reached the present before the phase ended"
    );
    assert_eq!(
        mine.remaining_reserve, reserve_before,
        "pre-graduation blocks are never paid out of the Mining Reserve"
    );
    assert!(mine.curve_mining_open, "the cap still has room");
    assert!(!market.graduated);
    assert!(!mine.graduated);
    assert_eq!(mine.curve_phase_ends_at, 0, "the phase has not ended yet");

    // The flip graduate_market performs, and the plan it moves: exactly the post-mining
    // curve inventory, with the mined but unclaimed tokens left in the vault.
    let plan = plan_graduation(&market).unwrap();
    assert_eq!(plan.tokens, market.token_reserve);
    assert_eq!(plan.sol, market.graduation_target);
    let mut pool = test_pool(0, 0);
    apply_graduation(&mut market, &mut pool, plan).unwrap();
    assert_eq!(pool.token_reserve, initial - blocks * 7);
    assert_eq!(
        pool.token_reserve + market.curve_mining_unpaid,
        initial,
        "the pool and the vault together still hold the launch inventory"
    );
}

/// Graduation is bounded like every other walk: a mine further behind than one call can cover
/// is refused with SyncBehind - retryable, with nothing about the phase moved - and after
/// advance_mine catches it up the same call succeeds and lands on exactly the ledger a single
/// unbounded pass would have produced.
#[test]
fn graduation_behind_a_bounded_walk_is_retryable_and_lands_where_a_full_walk_lands() {
    let mut mine = test_curve_mine(true);
    let mut market = test_curve_market(10_000_000, 10_000_000, 7);
    market.sol_reserve = market.graduation_target;
    let reserve_before = mine.remaining_reserve;
    let start_cursor = mine.next_block_at;
    // Far past what MAX_SYNC_SEGMENTS segments can cover: one segment per epoch boundary.
    let now = mine.next_block_at + 200 * mine.epoch_length;

    assert_err(
        sync_mine_for_graduation(&mut mine, &mut market, now),
        DiggoError::SyncBehind,
    );
    assert!(!market.graduated, "a refused graduation graduates nothing");
    assert!(!mine.graduated);
    assert_eq!(mine.curve_phase_ends_at, 0, "and records no cursor");
    assert!(
        mine.next_block_at > start_cursor,
        "the refused walk still commits the progress it made"
    );
    assert_eq!(mine.remaining_reserve, reserve_before);

    // advance_mine is permissionless and walks MAX_SYNC_SEGMENTS at a time.
    let mut calls = 0;
    while sync_mine(&mut mine, Some(&mut market), now).unwrap() == SyncProgress::Behind {
        calls += 1;
        assert!(calls < 16, "every call makes progress, so the walk terminates");
    }
    assert!(calls > 0, "a mine this far behind needs more than one call");
    sync_mine_for_graduation(&mut mine, &mut market, now).unwrap();

    // The same mine walked in one unbounded pass: identical ledger, identical market.
    let mut straight_mine = test_curve_mine(true);
    let mut straight_market = test_curve_market(10_000_000, 10_000_000, 7);
    straight_market.sol_reserve = straight_market.graduation_target;
    assert_eq!(
        sync_mine_with_budget(&mut straight_mine, Some(&mut straight_market), now, usize::MAX)
            .unwrap(),
        SyncProgress::CaughtUp
    );

    assert_eq!(mine.next_block_at, straight_mine.next_block_at);
    assert_eq!(mine.epoch, straight_mine.epoch);
    assert_eq!(mine.epoch_ends_at, straight_mine.epoch_ends_at);
    assert_eq!(mine.current_block_reward, straight_mine.current_block_reward);
    assert_eq!(mine.reward_index, straight_mine.reward_index);
    assert_eq!(mine.remaining_reserve, straight_mine.remaining_reserve);
    assert_eq!(
        mine.cumulative_distributed,
        straight_mine.cumulative_distributed
    );
    assert!(mine.status == straight_mine.status);
    assert_eq!(market.curve_mining_mined, straight_market.curve_mining_mined);
    assert_eq!(market.curve_mining_unpaid, straight_market.curve_mining_unpaid);
    assert_eq!(market.token_reserve, straight_market.token_reserve);

    // And the whole 200-epoch stretch was the curve's: the reserve is exactly where it was.
    assert_eq!(market.curve_mining_mined, 403_201 * 7);
    assert_eq!(mine.remaining_reserve, reserve_before);
    assert_eq!(straight_mine.remaining_reserve, reserve_before);
}

/// Conservation through the phase change itself, with the curve's budget spent well before
/// graduation: the blocks after the cap pay nothing and leave the reserve alone, the pool
/// takes exactly the post-mining curve inventory, and the vault keeps exactly what the reward
/// index has credited to positions.
#[test]
fn graduation_conserves_the_curve_inventory_and_leaves_the_reserve_alone() {
    let initial = 1_000_000u64;
    let mut mine = test_curve_mine(true);
    let mut market = test_curve_market(initial, 1_000, 7);
    market.sol_reserve = market.graduation_target;
    let reserve_before = mine.remaining_reserve;
    let now = mine.next_block_at + 40 * mine.epoch_length;

    sync_mine_for_graduation(&mut mine, &mut market, now).unwrap();
    assert_eq!(market.curve_mining_mined, 1_000, "the cap is the hard bound");
    assert_eq!(market.curve_mining_unpaid, 1_000);
    assert_eq!(market.token_reserve, initial - 1_000);
    assert!(!mine.curve_mining_open, "the cap is spent");
    assert_eq!(
        mine.remaining_reserve, reserve_before,
        "the idle stretch after the cap pays nothing at all, from either side"
    );

    let plan = plan_graduation(&market).unwrap();
    assert_eq!(plan.tokens, initial - 1_000);
    let mut pool = test_pool(0, 0);
    apply_graduation(&mut market, &mut pool, plan).unwrap();
    assert_eq!(
        pool.token_reserve + market.curve_mining_unpaid,
        initial,
        "the pool holds the curve and the vault holds the mined but unclaimed"
    );

    // The phase is over: the same walk now pays out of the reserve, the curve's ledger is
    // frozen where graduation left it, and the cursor has already been passed.
    mine.graduated = true;
    mine.curve_mining_open = false;
    mine.curve_phase_ends_at = now;
    assert!(!curve_phase_pending(&mine));
    let later = now + 10 * mine.epoch_length;
    sync_mine(&mut mine, Some(&mut market), later).unwrap();
    assert!(
        mine.remaining_reserve < reserve_before,
        "the reserve pays after graduation"
    );
    assert_eq!(
        market.curve_mining_mined, 1_000,
        "the curve's ledger is frozen at graduation"
    );
    assert_eq!(market.token_reserve, 0, "and the curve holds nothing");
    assert!(mine.status == MineStatus::MiningActive);
}

/// The cursor is the second half of the phase decision, and it is what makes that decision a
/// fact about time rather than about walk order. A mine whose graduated flag was set without
/// the walk - the shape the regression above used to have - still classifies every block that
/// landed before the cursor as curve-phase, so those blocks pay nothing instead of draining
/// the reserve; only the blocks after it are the reserve's.
#[test]
fn a_graduation_cursor_keeps_pre_graduation_blocks_off_the_reserve() {
    // The market has graduated and its inventory has moved into the pool, so the curve can
    // pay nothing more: its cap is frozen and its vault holds only what is already credited.
    let mut market = test_curve_market(999_000, 1_000, 7);
    market.graduated = true;
    market.curve_mining_mined = 1_000;

    let mut mine = test_curve_mine(false);
    mine.graduated = true;
    let cursor = mine.next_block_at + 10 * mine.block_interval;
    mine.curve_phase_ends_at = cursor;
    let reserve_before = mine.remaining_reserve;
    assert!(curve_phase_pending(&mine));

    // Ten blocks that landed before graduation, walked afterwards: they are consumed and pay
    // nothing, from either side.
    let ten_blocks = cursor - mine.block_interval;
    assert_eq!(
        sync_mine(&mut mine, Some(&mut market), ten_blocks).unwrap(),
        SyncProgress::CaughtUp
    );
    assert_eq!(mine.next_block_at, cursor);
    assert!(!curve_phase_pending(&mine));
    assert_eq!(mine.reward_index, 0, "a pre-graduation block pays nothing");
    assert_eq!(mine.remaining_reserve, reserve_before, "and never the reserve");
    assert_eq!(market.token_reserve, 999_000);
    assert_eq!(market.curve_mining_mined, 1_000);

    // Everything after the cursor is the reserve's, exactly as it was before the cursor
    // existed.
    let four_blocks = cursor + 3 * mine.block_interval;
    assert_eq!(
        sync_mine(&mut mine, Some(&mut market), four_blocks).unwrap(),
        SyncProgress::CaughtUp
    );
    assert_eq!(mine.remaining_reserve, reserve_before - 4 * 100);
    assert_eq!(index_owed(mine.reward_index, mine.total_power).unwrap(), 400);

    // A mine with no cursor - one that never graduated, or an account written before the
    // cursor existed - reads the phase from graduated alone, exactly as it did before.
    let mut cursorless = test_curve_mine(false);
    cursorless.graduated = true;
    assert_eq!(cursorless.curve_phase_ends_at, 0);
    assert!(!curve_phase_pending(&cursorless));
}



/// The curve phase's rate is the cap spread over the launch runway, so a 5% budget is weeks
/// of rewards rather than the hours the reserve schedule would pay it out in.
#[test]
fn the_curve_runway_spreads_the_cap_over_the_launch_days() {
    let cap = mul_bps(950_000, DEFAULT_CURVE_MINING_BPS).unwrap();
    assert_eq!(cap, 47_500);
    let blocks = curve_mining_runway_blocks(300, DEFAULT_CURVE_MINING_RUNWAY_DAYS).unwrap();
    assert_eq!(blocks, 8_640, "30 days of 300-second blocks");
    let rate = curve_mining_rate(cap, 300, DEFAULT_CURVE_MINING_RUNWAY_DAYS).unwrap();
    assert_eq!(rate, 6, "47_500 over 8_640 blocks rounds up");
    assert!(rate * blocks >= cap, "the budget is always finishable");
    assert!((rate - 1) * blocks < cap, "and rounding up is the only overshoot");

    // The mine's own reserve schedule is far too large for a 5% budget: at 100 per block it
    // would be spent in 475 blocks, about forty hours.
    assert_eq!(cap / 100, 475);

    // A runway shorter than one block still gets one block, and a cap of one base unit still
    // spreads over one per block.
    assert_eq!(curve_mining_runway_blocks(86_400, 1).unwrap(), 1);
    assert_eq!(curve_mining_rate(1, 300, 30).unwrap(), 1);
    assert_eq!(curve_mining_rate(0, 300, 30).unwrap(), 0);
}


/// Spec 36: the pool's own layout is fixed and every account it references is a field,
/// so there is nothing for an upgrade to add to it silently.
#[test]
fn pool_layout_is_fixed_size_and_self_describing() {

    assert_eq!(
        LiquidityPoolV4::INIT_SPACE,
        32 * 4 + 8 + 8 + 8 + 1,
        "mine, mint, token_vault, sol_vault, both reserves, graduated_at, bump"
    );
    assert_eq!(PoolSolVault::INIT_SPACE, 32 + 1);
    assert_eq!(POOL_SEED, b"pool");
    assert_eq!(POOL_VAULT_SEED, b"pool-vault");
    assert_eq!(POOL_SOL_SEED, b"pool-sol");
}

// --- v2 spine: frozen layouts and frozen error blocks ---------------------------------------

/// Borsh body length of one account struct, which is exactly what an account's data holds
/// after its 8-byte discriminator.
fn borsh_body_len<T: AnchorSerialize>(value: &T) -> usize {
    let mut buf = Vec::new();
    value.serialize(&mut buf).unwrap();
    buf.len()
}

/// Every v2 account's declared SIZE must equal 8 + its borsh length, so a field added, moved
/// or resized without a deliberate contract change fails here rather than silently changing
/// the rent and the layout every workstream is building against.
#[test]
fn v2_account_sizes_match_their_frozen_layouts() {
    assert_eq!(8 + borsh_body_len(&Coin::default()), Coin::SIZE);
    assert_eq!(8 + borsh_body_len(&PlayerAccount::default()), PlayerAccount::SIZE);
    assert_eq!(8 + borsh_body_len(&MiningPosition::default()), MiningPosition::SIZE);
    assert_eq!(8 + borsh_body_len(&LiquidityPool::default()), LiquidityPool::SIZE);
    assert_eq!(
        8 + borsh_body_len(&DiscoveryOpportunity::default()),
        DiscoveryOpportunity::SIZE
    );
    assert_eq!(8 + borsh_body_len(&GlobalBudget::default()), GlobalBudget::SIZE);
    assert_eq!(8 + borsh_body_len(&SponsorVault::default()), SponsorVault::SIZE);
    assert_eq!(8 + borsh_body_len(&SponsorEvent::default()), SponsorEvent::SIZE);
    assert_eq!(8 + borsh_body_len(&SponsorGrant::default()), SponsorGrant::SIZE);
    assert_eq!(8 + borsh_body_len(&ProtocolConfig::default()), ProtocolConfig::SIZE);
    assert_eq!(8 + borsh_body_len(&CurveTable::default()), CurveTable::SIZE);
    // RarityTier is a field type, not an account, so it carries no discriminator.
    assert_eq!(borsh_body_len(&RarityTier::default()), RarityTier::LEN);
}

/// The same sizes written out as literals: these are the numbers in CONTRACTS.md, and this
/// is the test that makes them a contract rather than a comment.
#[test]
fn v2_account_sizes_are_the_documented_numbers() {
    assert_eq!(Coin::SIZE, 464);
    assert_eq!(PlayerAccount::SIZE, 216);
    assert_eq!(MiningPosition::SIZE, 51);
    assert_eq!(LiquidityPool::SIZE, 185);
    assert_eq!(DiscoveryOpportunity::SIZE, 124);
    assert_eq!(GlobalBudget::SIZE, 53);
    assert_eq!(SponsorVault::SIZE, 70);
    assert_eq!(SponsorEvent::SIZE, 92);
    assert_eq!(SponsorGrant::SIZE, 42);
    assert_eq!(ProtocolConfig::SIZE, 434);
    assert_eq!(CurveTable::SIZE, 2410);
    // Rust alignment padding only ever makes the in-memory struct larger than its borsh
    // body, which is the direction that cannot truncate an account.
    assert!(std::mem::size_of::<Coin>() >= Coin::LEN);
    assert!(std::mem::size_of::<PlayerAccount>() >= PlayerAccount::LEN);
    assert!(std::mem::size_of::<ProtocolConfig>() >= ProtocolConfig::LEN);
}

/// The v2 error variants are appended after the v4 ones in the order design section 8.2
/// reserves them, so a workstream can name a variant from the first commit and the numeric
/// codes stay stable for every client that already matches on them.
#[test]
fn v2_error_codes_are_appended_in_the_designed_order() {
    let v2 = [
        DiggoError::NotImplemented,
        DiggoError::InvalidPauseWindow,
        DiggoError::NotTimelocked,
        DiggoError::ConfigOutOfBounds,
        DiggoError::InvalidRarityTable,
        DiggoError::InvalidCurveTable,
        DiggoError::NotActivated,
        DiggoError::AccrualOverflow,
        DiggoError::CrewAtMaxLevel,
        DiggoError::InsufficientOre,
        DiggoError::StorageCapacityExceeded,
        DiggoError::ReactivationTooSoon,
        DiggoError::BondAlreadyPosted,
        DiggoError::NoBondPosted,
        DiggoError::PositionStillActive,
        DiggoError::BondCooldownActive,
        DiggoError::SponsorBondNotWithdrawable,
        DiggoError::VaultBelowRentExempt,
        DiggoError::LedgerInvariantViolated,
        DiggoError::MetadataTooLong,
        DiggoError::InvalidMintLayout,
        DiggoError::CurveExhausted,
        DiggoError::PoolNotInitialised,
        DiggoError::TwapUnavailable,
        DiggoError::FeeSplitOverflow,
        DiggoError::CrankTipExceedsAccrual,
        DiggoError::NotCoinCreator,
        DiggoError::EventNotActive,
        DiggoError::EventBudgetExhausted,
        DiggoError::PerCoinLimitExceeded,
        DiggoError::PerWalletLimitExceeded,
        DiggoError::EventAlreadyClosed,
        DiggoError::UnspentWithdrawalOnly,
        DiggoError::InvalidEventKind,
        DiggoError::EpochNotRolled,
        DiggoError::SeedTargetInFuture,
        DiggoError::SeedTargetNotInSysvar,
        DiggoError::SeedAlreadyCommitted,
        DiggoError::SeedNotCommitted,
        DiggoError::CoinNotAdvanced,
        DiggoError::RollAlreadyExists,
        DiggoError::NotDiscoveryEligible,
        DiggoError::OpportunityExpired,
        DiggoError::OpportunityAlreadySettled,
        DiggoError::DailyCapExceeded,
        DiggoError::WeeklyCapExceeded,
        DiggoError::GlobalCapExceeded,
        DiggoError::EpochBudgetExhausted,
        DiggoError::UnclaimedRewards,
        DiggoError::BondRetired,
    ];
    assert_eq!(v2.len(), 50);
    for pair in v2.windows(2) {
        assert_eq!(u32::from(pair[1]), u32::from(pair[0]) + 1);
    }
    // The v4 enum holds 48 variants, so the v2 block starts at 6000 + 48.
    assert_eq!(u32::from(v2[0]), ERROR_CODE_OFFSET + 48);
    // BondRetired is appended last, so every code a client already matches on keeps its number.
    assert_eq!(u32::from(*v2.last().unwrap()), ERROR_CODE_OFFSET + 97);
    assert_eq!(u32::from(DiggoError::BondRetired), ERROR_CODE_OFFSET + 97);
}

/// The v2 seed prefixes are the ones design section 8.2 freezes. Changing one is a contract
/// amendment, not a worker decision, so it fails here first.
#[test]
fn v2_seed_prefixes_are_the_frozen_ones() {
    assert_eq!(PROTOCOL_SEED, b"protocol");
    assert_eq!(TREASURY_SEED, b"treasury");
    assert_eq!(CRANK_POOL_SEED, b"crank-pool");
    assert_eq!(CURVE_TABLE_SEED, b"curve-table");
    assert_eq!(COIN_SEED, b"coin");
    assert_eq!(VAULT_SEED, b"vault");
    assert_eq!(PLAYER_SEED, b"player");
    assert_eq!(POSITION_SEED, b"position");
    assert_eq!(OPPORTUNITY_SEED, b"opportunity");
    assert_eq!(GLOBAL_BUDGET_SEED, b"global-budget");
    assert_eq!(SPONSOR_VAULT_SEED, b"sponsor-vault");
    assert_eq!(SPONSOR_EVENT_SEED, b"sponsor-event");
    assert_eq!(SPONSOR_GRANT_SEED, b"sponsor-grant");
    assert_eq!(MINT_SEED, b"mint");
    assert_eq!(POOL_SEED, b"pool");
    assert_eq!(POOL_VAULT_SEED, b"pool-vault");
    assert_eq!(POOL_SOL_SEED, b"pool-sol");
    let coin = Pubkey::new_unique();
    let owner = Pubkey::new_unique();
    let seeds = opportunity_seeds(&coin, &owner, 7);
    assert_eq!(seeds.len(), OPPORTUNITY_SEED.len() + 32 + 32 + 2);
    assert_eq!(&seeds[OPPORTUNITY_SEED.len() + 64..], &7u16.to_le_bytes());
    let day = global_budget_seeds(3);
    assert_eq!(&day[GLOBAL_BUDGET_SEED.len()..], &3u16.to_le_bytes());
}

/// The STARTER_TRANCHE_CAP amendment and the retired bond: the starter tranche is a tenth of a
/// block whatever the bonded power is, the unassigned remainder stays in the reserve rather than
/// being burned or handed to the starter index, and the bond constants keep their frozen values
/// even though no new bond may be posted.
#[test]
fn starter_tranche_cap_and_defaults_are_the_amended_ones() {
    assert_eq!(STARTER_TRANCHE_BPS, 1_000);
    assert_eq!(STARTER_EFFICIENCY_BPS, 2_500);
    // Retired, and still exactly the numbers the frozen layouts and the parity vectors carry.
    assert_eq!(BOND_LAMPORTS, 70_000_000);
    assert_eq!(BOND_COOLDOWN_SECONDS, 604_800);
    assert_eq!(EPOCH_SEED_DELAY_SLOTS, 32);
    assert_eq!(EPOCH_SEED_MAX_LATENESS_SLOTS, SLOT_HASHES_WINDOW);
    assert_eq!(MAX_PAUSE_SECONDS, 72 * 3_600);
    assert_eq!(MINT_V2_SIZE, 438);
    // The mint size is derived from the metadata caps rather than quoted, so a cap change that the
    // layout cannot hold is a failing test here instead of a mint that cannot be initialised.
    assert_eq!(
        MINT_V2_SIZE,
        MINT_BASE_SIZE
            + MINT_ACCOUNT_TYPE_SIZE
            + MINT_METADATA_POINTER_SIZE
            + MINT_TLV_HEADER_SIZE
            + 32
            + 32
            + (4 + MAX_NAME_LEN)
            + (4 + MAX_SYMBOL_LEN)
            + (4 + MAX_URI_LEN)
            + 4
    );
    assert_eq!(MIN_CURVE_MINING_BLOCKS, 48);
}
