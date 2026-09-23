//! Full-flow integration tests for on-chain v2 (WS-G).
//!
//! Each test drives the real program through LiteSVM in the order a user would: launch, trade,
//! graduate, create a player, bond, mine, claim, discover, crank. Assertions are written against
//! CONTRACTS.md and docs/ONCHAIN_V2_DESIGN.md and are deliberately **properties**, not numbers a
//! workstream picked: monotonicity, the starter tranche cap, the vault ledger invariant, the
//! three-term conservation, the cooldown, and the caps. Where a number is contract - the bond, the
//! cooldown, the tranche bps, the caps - it is asserted exactly.
//!
//! A flow that meets the frozen skeleton's NotImplemented stops there and reports PENDING with the
//! name of the instruction that is still missing, so this file is a checklist of what is left
//! rather than a wall of red. Everything else is a real failure.

mod common;

use common::*;
use anchor_lang::AccountSerialize;
use diggo_protocol::{
    ACTIVATION_SECONDS, BOND_COOLDOWN_SECONDS, BOND_LAMPORTS, BPS, PlayerAccount,
    STARTER_EFFICIENCY_BPS,
};
use solana_keypair::Keypair;
use solana_signer::Signer;

/// The six numbers a flow needs from the frozen error table.
const SLIPPAGE_EXCEEDED: u32 = 6011;
const INSUFFICIENT_LIQUIDITY: u32 = 6012;
const GRADUATION_TARGET_NOT_MET: u32 = 6036;
const NO_BOND_POSTED: u32 = 6061;
const POSITION_STILL_ACTIVE: u32 = 6062;
const BOND_COOLDOWN_ACTIVE: u32 = 6063;
const SPONSOR_BOND_NOT_WITHDRAWABLE: u32 = 6064;
const UNSPENT_WITHDRAWAL_ONLY: u32 = 6080;
const SEED_TARGET_IN_FUTURE: u32 = 6083;
const SEED_NOT_COMMITTED: u32 = 6086;
const ROLL_ALREADY_EXISTS: u32 = 6088;
const NOT_DISCOVERY_ELIGIBLE: u32 = 6089;
const DAILY_CAP_EXCEEDED: u32 = 6092;
const GLOBAL_CAP_EXCEEDED: u32 = 6094;
/// DiggoError::BondRetired, retained for retired bond sponsorship events.
const BOND_RETIRED: u32 = 6097;
const REFERRAL_AMOUNT_OUT_OF_RANGE: u32 = 6098;
const REFERRAL_WEEKLY_CAP_EXCEEDED: u32 = 6099;
const REFERRAL_REFEREE_MISMATCH: u32 = 6100;
const STORAGE_CAPACITY_EXCEEDED: u32 = 6058;
const REFERRAL_WEEK_SECONDS: i64 = 604_800;
const REFERRAL_MAX_AMOUNT: u64 = 250;

/// Initializes the protocol and launches one coin from a fresh creator, returning both.
fn launched(flow: &mut Flow, nonce: u8) -> Result<(Keypair, solana_address::Address), Vec<&'static str>> {
    initialize_protocol(flow)?;
    let creator = flow.env.wallet(5 * LAMPORTS_PER_SOL);
    let creator_address = creator.pubkey();
    let accounts = LaunchAccounts::new(creator_address, nonce);
    let args = default_launch_args(nonce);
    let ix = launch_token_ix(&accounts, &args);
    try_step!(flow, "launch_token", ix, &[&creator]);
    Ok((creator, accounts.mint))
}

/// Creates a player and activates it. Nothing is posted and nothing is paid beyond the rent of
/// the PDA and the transaction fee: the bond is retired, so there is no third arm to choose.
fn player(
    flow: &mut Flow,
    lamports: u64,
) -> Result<(Keypair, solana_address::Address), Vec<&'static str>> {
    let owner = flow.env.wallet(lamports);
    let address = owner.pubkey();
    let ix = initialize_player_ix(address, None);
    try_step!(flow, "initialize_player", ix, &[&owner]);
    let ix = activate_ix(address);
    try_step!(flow, "activate", ix, &[&owner]);
    Ok((owner, address))
}

/// Creates the referrer's player account without activating it. Referral settlement is valid for
/// an initialized player, and avoiding activation keeps the capacity tests free of mining accrual.
fn referral_referrer(flow: &mut Flow) -> Result<(Keypair, solana_address::Address), Vec<&'static str>> {
    let referrer = flow.env.wallet(5 * LAMPORTS_PER_SOL);
    let address = referrer.pubkey();
    let ix = initialize_player_ix(address, None);
    try_step!(flow, "initialize_player", ix, &[&referrer]);
    Ok((referrer, address))
}

/// Builds a wallet that satisfies the on-chain discovery milestone gate using only public
/// instructions: ten activations across distinct days, enough active time to accrue ORE, and ten
/// crew upgrades. The resulting player has at least five active days, five valid activations,
/// total crew level 15, and is old enough for the discovery maturity floor.
fn discovery_eligible_player(
    flow: &mut Flow,
) -> Result<(Keypair, solana_address::Address), Vec<&'static str>> {
    let owner = flow.env.wallet(5 * LAMPORTS_PER_SOL);
    let address = owner.pubkey();
    let ix = initialize_player_ix(address, None);
    try_step!(flow, "initialize eligible player", ix, &[&owner]);
    let ix = activate_ix(address);
    try_step!(flow, "activate eligible player", ix, &[&owner]);

    // Mine for a full activation window, then re-activate on the next calendar day. The
    // component order below is the cheapest public path from total level 5 to level 15 at the
    // maturity this fixture reaches; collecting first keeps every purchase publicly funded.
    let upgrades: &[&[u8]] = &[&[0, 2], &[4], &[2], &[4], &[0], &[0], &[4], &[4], &[0]];
    for components in upgrades {
        flow.env.advance(DAY + 120);
        let ix = activate_ix(address);
        try_step!(flow, "activate eligible player (next day)", ix, &[&owner]);
        flow.env.advance(DAY + 120);
        let ix = collect_ore_ix(address);
        try_step!(flow, "collect eligible player ORE", ix, &[&owner]);
        for &component in *components {
            let ix = upgrade_crew_ix(address, component);
            try_step!(flow, "upgrade eligible player crew", ix, &[&owner]);
        }
    }
    assert_eq!(flow.env.player(&address).valid_activations, 10);
    assert_eq!(flow.env.player(&address).active_days, 9);
    assert_eq!(
        flow.env.player(&address).crew_levels.iter().map(|level| *level as u32).sum::<u32>(),
        15,
    );
    Ok((owner, address))
}

// ---- launch -------------------------------------------------------------------------------

#[test]
fn launch_paid_by_the_creator_splits_the_supply_and_charges_its_rent() {
    let mut flow = Flow::new("launch_paid_by_the_creator_splits_the_supply_and_charges_its_rent");
    setup!(flow => initialize_protocol(&mut flow));

    let creator = flow.env.wallet(5 * LAMPORTS_PER_SOL);
    let creator_address = creator.pubkey();
    let before = flow.env.lamports(&creator_address);
    let accounts = LaunchAccounts::new(creator_address, 1);
    let args = default_launch_args(1);
    let ix = launch_token_ix(&accounts, &args);
    step!(&mut flow, "launch_token", ix, &[&creator]);

    let coin = flow.env.coin(&accounts.mint);
    assert_eq!(coin.creator, to_anchor(creator_address), "the creator is recorded");
    assert_eq!(coin.vault, to_anchor(accounts.vault), "the one vault is recorded");
    assert_eq!(coin.total_supply, args.total_supply);
    assert_eq!(coin.status, 0, "a fresh coin is Launching");
    assert_eq!(coin.bonded_power, 0);
    assert_eq!(coin.starter_power, 0);
    assert_eq!(coin.outstanding_claims, 0);
    assert_eq!(coin.cumulative_distributed, 0);

    // The launch split: the Mining Reserve, the Discovery Reserve and the curve's inventory are
    // the whole supply, and the vault holds it. Nothing is minted anywhere else.
    let reserve = args.total_supply * args.reserve_bps as u64 / BPS as u64;
    let discovery = args.total_supply * args.discovery_reserve_bps as u64 / BPS as u64;
    assert_eq!(coin.reserve_remaining, reserve, "Mining Reserve");
    assert_eq!(coin.discovery_remaining, discovery, "Discovery Reserve");
    assert_eq!(
        coin.token_reserve + coin.reserve_remaining + coin.discovery_remaining,
        args.total_supply,
        "the split is the whole supply"
    );
    assert_eq!(
        flow.env.token_amount(&accounts.vault),
        args.total_supply,
        "the vault holds the supply"
    );
    flow.env.assert_vault_invariant(&accounts.mint);

    // The mint is the hand-written Token-2022 mint, owned by the token program. It is *funded* for
    // the maximal layout - MINT_V2_SIZE is the cap the creator pays rent on - but it *settles* at
    // exactly what its own metadata needs, which is mint_settled_size and is smaller whenever the
    // name, symbol and uri are shorter than the caps. The program enforces that equality itself
    // (launch_token: data_len() == settled_size), so this asserts the same thing it does.
    let mint_account = flow.env.account(&accounts.mint).expect("the mint exists");
    let settled = diggo_protocol::instructions::launch::mint_settled_size(
        &args.name,
        &args.symbol,
        &args.uri,
    );
    assert_eq!(
        mint_account.data.len(),
        settled,
        "the mint settles at its own metadata's size"
    );
    assert!(
        settled <= diggo_protocol::MINT_V2_SIZE,
        "and a settlement is never larger than the funded layout: {settled} > {}",
        diggo_protocol::MINT_V2_SIZE
    );
    assert_eq!(mint_account.owner, token_program());

    // The creator paid the three accounts the design prices: the mint, the Coin and the vault.
    let spent = before - flow.env.lamports(&creator_address);
    let expected = ((diggo_protocol::MINT_V2_SIZE + 128) as u64) * 6_960
        + ((diggo_protocol::Coin::SIZE + 128) as u64) * 6_960
        + ((165 + 128) as u64) * 6_960;
    assert_eq!(spent, expected, "a paid launch costs exactly the three rents");
    flow.env.assert_conservation(&accounts.mint);
    flow.note(format!("a paid launch costs {spent} lamports of rent"));
    flow.finish();
}

#[test]
fn a_sponsor_event_can_pay_the_launch_rent() {
    let mut flow = Flow::new("a_sponsor_event_can_pay_the_launch_rent");
    setup!(flow => initialize_protocol(&mut flow));

    let sponsor = flow.env.wallet(5 * LAMPORTS_PER_SOL);
    let sponsor_address = sponsor.pubkey();
    let ix = init_sponsor_vault_ix(sponsor_address);
    step!(&mut flow, "init_sponsor_vault", ix, &[&sponsor]);
    let ix = fund_sponsor_vault_ix(sponsor_address, 100_000_000);
    step!(&mut flow, "fund_sponsor_vault", ix, &[&sponsor]);

    let now = flow.env.now;
    let ix = create_sponsor_event_ix(
        sponsor_address,
        0,
        0, // LaunchRentSubsidy
        now - 60,
        now + 30 * DAY,
        50_000_000,
        20_000_000,
        0,
    );
    step!(&mut flow, "create_sponsor_event", ix, &[&sponsor]);
    let vault = sponsor_vault_pda(&sponsor_address);
    let event = sponsor_event_pda(&vault, 0);

    let creator = flow.env.wallet(5 * LAMPORTS_PER_SOL);
    let creator_address = creator.pubkey();
    let before = flow.env.lamports(&creator_address);
    let accounts = LaunchAccounts::new(creator_address, 2);
    let grant = sponsor_grant_pda(&event, &coin_pda(&accounts.mint));
    let accounts = accounts.with_sponsor(vault, event, grant);
    let args = default_launch_args(2);
    let ix = launch_token_ix(&accounts, &args);
    step!(&mut flow, "launch_token (sponsored)", ix, &[&creator]);

    // The caller-created grant PDA is funded by the real signer, then reimbursed inside the same
    // instruction because the data-bearing sponsor vault cannot be a System Program payer.
    let spent = before - flow.env.lamports(&creator_address);
    assert!(
        spent < 2_000_000,
        "the sponsor should have covered the rent, creator spent {spent}"
    );
    let sponsor_vault = flow.env.sponsor_vault(&sponsor_address);
    assert!(sponsor_vault.total_spent > 0, "the vault booked the subsidy");
    assert_eq!(
        sponsor_vault.total_funded, 100_000_000,
        "funding is recorded"
    );
    let grant = flow.env.sponsor_grant(&event, &accounts.coin);
    assert_eq!(
        grant.spent_lamports, sponsor_vault.total_spent,
        "the per-coin grant records the vault's charge"
    );
    flow.env.assert_vault_invariant(&accounts.mint);
    flow.note("a sponsor event paid the launch rent, and only the rent");
    flow.finish();
}

// ---- trading ------------------------------------------------------------------------------

#[test]
fn curve_buys_and_sells_conserve_lamports_and_respect_slippage() {
    let mut flow = Flow::new("curve_buys_and_sells_conserve_lamports_and_respect_slippage");
    let (_creator, mint) = setup!(flow => launched(&mut flow, 3));
    let coin_before = flow.env.coin(&mint);
    let vault_before = flow.env.token_amount(&vault_pda(&mint));

    let trader = flow.env.wallet(5 * LAMPORTS_PER_SOL);
    let trader_address = trader.pubkey();
    let tokens = flow.env.create_token_account(&trader_address, &mint);
    let sol_in = 1_000_000_000;
    let ix = buy_ix(trader_address, mint, tokens, sol_in, 0);
    step!(&mut flow, "buy", ix, &[&trader]);

    let bought = flow.env.token_amount(&tokens);
    assert!(bought > 0, "a buy delivers tokens");
    assert_eq!(
        flow.env.token_amount(&vault_pda(&mint)),
        vault_before - bought,
        "tokens come out of the one vault"
    );
    let coin = flow.env.coin(&mint);
    assert_eq!(
        coin.sol_reserve,
        coin_before.sol_reserve + sol_in
            - (coin.creator_fee_claimable - coin_before.creator_fee_claimable)
            - (coin.platform_fee_claimable - coin_before.platform_fee_claimable),
        "the curve keeps the trade net of the two fees"
    );
    // The fee split is 50/50 bps, so the two buckets differ by at most one lamport of rounding.
    let creator_fee = coin.creator_fee_claimable - coin_before.creator_fee_claimable;
    let platform_fee = coin.platform_fee_claimable - coin_before.platform_fee_claimable;
    assert!(
        creator_fee.abs_diff(platform_fee) <= 1,
        "the 50/50 split: {creator_fee} against {platform_fee}"
    );
    assert_eq!(
        creator_fee + platform_fee,
        sol_in * 100 / 10_000,
        "100 bps of the trade is fees"
    );
    flow.env.assert_vault_invariant(&mint);

    // Slippage: asking for more than the quote is refused rather than filled.
    let ix = buy_ix(trader_address, mint, tokens, sol_in, u64::MAX);
    guard!(&mut flow, "buy (impossible min_out)", ix, &[&trader], SLIPPAGE_EXCEEDED);

    // A sell returns tokens and SOL, and cannot take more SOL than the curve holds.
    let held = flow.env.token_amount(&tokens);
    let ix = sell_ix(trader_address, mint, tokens, held / 2, 0);
    step!(&mut flow, "sell", ix, &[&trader]);
    assert!(
        flow.env.token_amount(&tokens) < held,
        "a sell takes tokens back"
    );
    flow.env.assert_vault_invariant(&mint);

    // Selling more than the wallet holds is refused, whichever layer detects the overflow first.
    let ix = sell_ix(trader_address, mint, tokens, u64::MAX, 0);
    let result = flow.env.send(&[ix], &[&trader]);
    assert!(result.is_err(), "selling more than held must fail");
    flow.note("the curve conserved lamports, split its fees 50/50 and refused bad slippage");
    flow.finish();
}

#[test]
fn graduation_locks_the_pool_and_the_pool_can_never_be_drained() {
    let mut flow = Flow::new("graduation_locks_the_pool_and_the_pool_can_never_be_drained");
    let (_creator, mint) = setup!(flow => launched(&mut flow, 4));

    // Below the target, graduation is refused: it is condition-driven, not operator-driven.
    let cranker = flow.env.wallet(LAMPORTS_PER_SOL);
    let cranker_address = cranker.pubkey();
    let ix = graduate_market_ix(cranker_address, mint);
    guard!(
        &mut flow,
        "graduate_market (target not met)",
        ix,
        &[&cranker],
        GRADUATION_TARGET_NOT_MET
    );

    // Buy the market past its graduation target.
    let trader = flow.env.wallet(300 * LAMPORTS_PER_SOL);
    let trader_address = trader.pubkey();
    let tokens = flow.env.create_token_account(&trader_address, &mint);
    let target = flow.env.coin(&mint).graduation_target;
    let ix = buy_ix(trader_address, mint, tokens, target * 2, 0);
    step!(&mut flow, "buy (to the graduation target)", ix, &[&trader]);

    let coin_before = flow.env.coin(&mint);
    let ix = graduate_market_ix(cranker_address, mint);
    step!(&mut flow, "graduate_market", ix, &[&cranker]);

    let pool = flow.env.pool(&mint);
    assert_eq!(pool.coin, to_anchor(coin_pda(&mint)));
    assert_eq!(pool.mint, to_anchor(mint));
    assert_eq!(
        pool.token_reserve, coin_before.token_reserve,
        "graduation moves exactly the curve's token inventory"
    );
    assert_eq!(
        pool.sol_reserve, coin_before.sol_reserve,
        "and exactly its SOL"
    );
    assert_eq!(
        flow.env.token_amount(&pool_vault_pda(&mint)),
        pool.token_reserve
    );
    // The pool's SOL vault holds its rent floor plus the reserve, and nothing else can spend it.
    let floor = flow.env.svm.minimum_balance_for_rent_exemption(0);
    assert_eq!(
        flow.env.lamports(&pool_sol_pda(&mint)),
        floor + pool.sol_reserve,
        "the SOL vault holds the reserve"
    );
    assert_eq!(
        flow.env.coin(&mint).graduated, 1,
        "the coin is marked graduated"
    );
    assert!(flow.env.coin(&mint).curve_phase_ends_at > 0);

    // A pool swap moves the price and may only grow the invariant, never shrink it.
    let k_before = pool.sol_reserve as u128 * pool.token_reserve as u128;
    let ix = pool_buy_ix(trader_address, mint, tokens, 5 * LAMPORTS_PER_SOL, 0);
    step!(&mut flow, "pool_buy", ix, &[&trader]);
    let pool = flow.env.pool(&mint);
    let k_after = pool.sol_reserve as u128 * pool.token_reserve as u128;
    assert!(k_after >= k_before, "k = x*y may only grow: {k_after} < {k_before}");

    let ix = pool_sell_ix(trader_address, mint, tokens, flow.env.token_amount(&tokens) / 2, 0);
    step!(&mut flow, "pool_sell", ix, &[&trader]);
    let pool = flow.env.pool(&mint);
    assert!(pool.sol_reserve > 0 && pool.token_reserve > 0, "neither side drains");

    // A swap that would empty a side is refused.
    let ix = pool_sell_ix(trader_address, mint, tokens, u64::MAX, u64::MAX);
    if flow
        .expect_err("pool_sell (drain)", ix, &[&trader], SLIPPAGE_EXCEEDED)
        .is_none()
    {
        let ix = pool_sell_ix(trader_address, mint, tokens, u64::MAX, u64::MAX);
        let result = flow.env.send(&[ix], &[&trader]);
        assert!(result.is_err(), "a draining swap must fail");
    }
    flow.note("graduation moved exactly the curve reserves into a pool nobody can drain");
    flow.finish();
}

// ---- the player, the legacy bond and the cooldown ------------------------------------------

/// Plants a bond that was posted before the bond was retired.
///
/// The callable bond-posting path no longer exists, so the legacy account data is written directly
/// and the lamports are moved into the PDA's own balance the way a real bond used to be. This is
/// the only way to reach the legacy withdrawal, and reaching it is what proves a bond posted
/// before the retirement is not stranded.
fn plant_legacy_bond(flow: &mut Flow, owner: &solana_address::Address, amount: u64) {
    let pda = player_pda(owner);
    let mut account = flow.env.account(&pda).expect("the player exists");
    let mut player: PlayerAccount = flow.env.decode(&pda).expect("PlayerAccount");
    player.bond_lamports = amount;
    player.bond_locked_at = flow.env.now;
    let mut data = vec![0u8; PlayerAccount::SIZE];
    let mut cursor = std::io::Cursor::new(&mut data[..]);
    player
        .try_serialize(&mut cursor)
        .expect("serialize the player");
    account.data = data;
    account.lamports += amount;
    flow.env
        .svm
        .set_account(pda, account)
        .expect("write the legacy bond");
}

#[test]
fn a_bond_posted_before_the_retirement_is_not_stranded() {
    let mut flow = Flow::new("a_bond_posted_before_the_retirement_is_not_stranded");
    let (_creator, mint) = setup!(flow => launched(&mut flow, 5));
    let (owner, owner_address) = setup!(flow => player(&mut flow, 5 * LAMPORTS_PER_SOL));

    let account = flow
        .env
        .account(&player_pda(&owner_address))
        .expect("the player exists");
    assert_eq!(account.data.len(), 216, "PlayerAccount::SIZE");
    assert_eq!(
        flow.env.player(&owner_address).bond_lamports,
        0,
        "a fresh player posts nothing"
    );

    // Mining needs no bond at all: the position is armed in the full tranche.
    let ix = assign_power_ix(owner_address, mint);
    step!(&mut flow, "assign_power (no bond)", ix, &[&owner]);
    let position = flow.env.position(&mint, &owner_address);
    assert_eq!(position.tranche, 0, "the full tranche with nothing parked");
    let coin = flow.env.coin(&mint);
    assert_eq!(coin.starter_power, 0, "nothing accrues in the starter tranche");
    assert_eq!(coin.bonded_power, position.assigned_power);
    let ix = remove_power_ix(owner_address, mint);
    step!(&mut flow, "remove_power", ix, &[&owner]);

    // A player who never posted one has nothing to withdraw, and the guard is the legacy one.
    let ix = request_unbond_ix(owner_address);
    guard!(
        &mut flow,
        "request_unbond (nothing posted)",
        ix,
        &[&owner],
        NO_BOND_POSTED
    );

    // The legacy arm: the same account, carrying a bond the old program would have written.
    // Everything below this line is the old path, unchanged.
    let floor = flow.env.svm.minimum_balance_for_rent_exemption(216);
    plant_legacy_bond(&mut flow, &owner_address, BOND_LAMPORTS);
    assert_eq!(
        flow.env.player(&owner_address).bond_lamports,
        BOND_LAMPORTS,
        "the frozen field still carries the bond"
    );
    assert_eq!(
        flow.env.lamports(&player_pda(&owner_address)),
        floor + BOND_LAMPORTS,
        "and the lamports are really in the PDA"
    );

    // request_unbond still requires no active position.
    let ix = assign_power_ix(owner_address, mint);
    step!(&mut flow, "assign_power (legacy bond)", ix, &[&owner]);
    let ix = request_unbond_ix(owner_address);
    guard!(
        &mut flow,
        "request_unbond (position active)",
        ix,
        &[&owner],
        POSITION_STILL_ACTIVE
    );

    let ix = remove_power_ix(owner_address, mint);
    step!(&mut flow, "remove_power (legacy bond)", ix, &[&owner]);
    let ix = request_unbond_ix(owner_address);
    step!(&mut flow, "request_unbond", ix, &[&owner]);
    let requested = flow.env.player(&owner_address);
    assert_eq!(
        requested.unbond_available_at,
        flow.env.now + BOND_COOLDOWN_SECONDS,
        "seven days of cooldown"
    );

    // Calling it again must never move the cooldown earlier - that is the cycle a farm would use.
    flow.env.advance(DAY);
    let ix = request_unbond_ix(owner_address);
    let result = flow.env.send(&[ix], &[&owner]);
    if result.is_ok() {
        let again = flow.env.player(&owner_address);
        assert!(
            again.unbond_available_at >= requested.unbond_available_at,
            "request_unbond cannot be cycled to reset the cooldown"
        );
    }

    // Before the cooldown, the withdrawal is refused.
    let ix = withdraw_bond_ix(owner_address, None);
    guard!(
        &mut flow,
        "withdraw_bond (too early)",
        ix,
        &[&owner],
        BOND_COOLDOWN_ACTIVE
    );

    flow.env.advance(BOND_COOLDOWN_SECONDS);
    let before = flow.env.lamports(&owner_address);
    let ix = withdraw_bond_ix(owner_address, None);
    step!(&mut flow, "withdraw_bond", ix, &[&owner]);
    assert_eq!(
        flow.env.player(&owner_address).bond_lamports,
        0,
        "no partial withdrawal"
    );
    assert_eq!(
        flow.env.lamports(&owner_address),
        before + BOND_LAMPORTS,
        "the whole bond comes back"
    );
    assert_eq!(
        flow.env.lamports(&player_pda(&owner_address)),
        floor,
        "and the account is left rent-exempt"
    );
    flow.note("a bond posted before the retirement still comes back");
    flow.finish();
}

#[test]
fn every_wallet_arms_the_full_tranche_at_full_power() {
    let mut flow = Flow::new("every_wallet_arms_the_full_tranche_at_full_power");
    let (_creator, mint) = setup!(flow => launched(&mut flow, 6));

    // Two players created at the same moment, so maturity cannot explain a difference. Neither
    // posts anything, because there is nothing left to post.
    let (first_owner, first) = setup!(flow => player(&mut flow, 5 * LAMPORTS_PER_SOL));
    let (second_owner, second) = setup!(flow => player(&mut flow, 5 * LAMPORTS_PER_SOL));

    let ix = assign_power_ix(first, mint);
    step!(&mut flow, "assign_power (first)", ix, &[&first_owner]);
    let ix = assign_power_ix(second, mint);
    step!(&mut flow, "assign_power (second)", ix, &[&second_owner]);

    let first_position = flow.env.position(&mint, &first);
    let second_position = flow.env.position(&mint, &second);
    assert_eq!(first_position.tranche, 0, "the full tranche");
    assert_eq!(second_position.tranche, 0, "the full tranche");
    assert_eq!(
        first_position.assigned_power, second_position.assigned_power,
        "the same crew at the same maturity arms the same power"
    );
    // Nothing is throttled: the power is the whole table value for the crew, not the quarter of
    // it the retired starter efficiency used to leave an unbonded wallet.
    assert_ne!(
        first_position.assigned_power,
        first_position.assigned_power * STARTER_EFFICIENCY_BPS as u64 / BPS as u64,
        "the retired starter efficiency is not applied"
    );

    // The whole coin's power sits in the full tranche, so no block is split and no slice of one
    // is left behind in the reserve.
    let coin = flow.env.coin(&mint);
    assert_eq!(coin.starter_power, 0);
    assert_eq!(
        coin.bonded_power,
        first_position.assigned_power + second_position.assigned_power
    );
    assert_eq!(coin.total_power, coin.bonded_power);
    flow.note("every wallet arms the full tranche at full power and nothing is skimmed");
    flow.finish();
}

#[test]
fn mining_pays_from_the_curve_before_graduation_and_from_the_reserve_after() {
    let mut flow = Flow::new("mining_pays_from_the_curve_before_graduation_and_from_the_reserve_after");
    let (_creator, mint) = setup!(flow => launched(&mut flow, 7));
    let (owner, owner_address) = setup!(flow => player(&mut flow, 5 * LAMPORTS_PER_SOL));
    flow.env.create_token_account(&owner_address, &mint);
    let ix = assign_power_ix(owner_address, mint);
    step!(&mut flow, "assign_power", ix, &[&owner]);

    // One block interval is 300 seconds; the crank is what moves the ledger.
    flow.env.advance(300 * 4);
    let cranker = flow.env.wallet(LAMPORTS_PER_SOL);
    let cranker_address = cranker.pubkey();
    let ix = advance_mine_ix(cranker_address, mint);
    step!(&mut flow, "advance_mine", ix, &[&cranker]);

    let before = flow.env.coin(&mint);
    let ix = claim_rewards_ix(owner_address, mint);
    step!(&mut flow, "claim_rewards (curve phase)", ix, &[&owner]);
    let after = flow.env.coin(&mint);

    // Pre-graduation the curve's own inventory pays: the Mining Reserve is untouched, and the
    // index has credited the position with what the curve gave up.
    assert_eq!(
        after.reserve_remaining, before.reserve_remaining,
        "the curve phase may not debit the Mining Reserve"
    );
    assert!(
        after.token_reserve <= before.token_reserve,
        "the curve's inventory pays for the curve phase"
    );
    assert!(
        flow.env.token_amount(&associated_token(&owner_address, &mint)) > 0,
        "the claim delivered tokens"
    );
    flow.env.assert_vault_invariant(&mint);
    flow.env.assert_conservation(&mint);

    // Now graduate, and the same claim path pays out of the reserve instead.
    let trader = flow.env.wallet(200 * LAMPORTS_PER_SOL);
    let trader_address = trader.pubkey();
    let tokens = flow.env.create_token_account(&trader_address, &mint);
    let target = flow.env.coin(&mint).graduation_target;
    let ix = buy_ix(trader_address, mint, tokens, target * 2, 0);
    step!(&mut flow, "buy (to the graduation target)", ix, &[&trader]);
    let ix = graduate_market_ix(cranker_address, mint);
    step!(&mut flow, "graduate_market", ix, &[&cranker]);

    let before_advance = flow.env.coin(&mint);
    flow.env.advance(300 * 4);
    let ix = advance_mine_ix(cranker_address, mint);
    step!(&mut flow, "advance_mine (reserve phase)", ix, &[&cranker]);
    let after_advance = flow.env.coin(&mint);
    assert!(
        after_advance.reserve_remaining < before_advance.reserve_remaining,
        "advance_mine debits the reserve after graduation"
    );
    assert!(after_advance.outstanding_claims >= before_advance.outstanding_claims);

    let token_account = associated_token(&owner_address, &mint);
    let tokens_before_claim = flow.env.token_amount(&token_account);
    let before_claim = flow.env.coin(&mint);
    let ix = claim_rewards_ix(owner_address, mint);
    step!(&mut flow, "claim_rewards (reserve phase)", ix, &[&owner]);
    let after_claim = flow.env.coin(&mint);
    assert!(
        after_claim.reserve_remaining == before_claim.reserve_remaining,
        "claim_rewards pays a reservation already taken by advance_mine"
    );
    assert!(after_claim.outstanding_claims < before_claim.outstanding_claims);
    assert!(flow.env.token_amount(&token_account) > tokens_before_claim);
    assert!(
        after_claim.reserve_remaining
            + after_claim.cumulative_distributed
            + after_claim.outstanding_claims
            <= after_claim.total_supply,
        "conservation holds across the phase change"
    );
    flow.env.assert_vault_invariant(&mint);
    flow.note("the curve paid before graduation and the reserve paid after it");
    flow.finish();
}

#[test]
fn a_coin_of_full_tranche_positions_assigns_the_whole_block() {
    let mut flow = Flow::new("a_coin_of_full_tranche_positions_assigns_the_whole_block");
    let (_creator, mint) = setup!(flow => launched(&mut flow, 8));

    let (first_owner, first) = setup!(flow => player(&mut flow, 5 * LAMPORTS_PER_SOL));
    let ix = assign_power_ix(first, mint);
    step!(&mut flow, "assign_power (first)", ix, &[&first_owner]);
    let cranker = flow.env.wallet(LAMPORTS_PER_SOL);
    let cranker_address = cranker.pubkey();
    flow.env.advance(300 * 4);
    let ix = advance_mine_ix(cranker_address, mint);
    step!(&mut flow, "advance_mine", ix, &[&cranker]);

    // Every position is in the full tranche, so the starter tranche is empty and holds nothing.
    let coin = flow.env.coin(&mint);
    assert_eq!(coin.starter_power, 0, "no position accrues in the starter tranche");
    assert!(coin.bonded_power > 0);
    assert_eq!(coin.total_power, coin.bonded_power);

    // A second miner joins, and the two of them still take the whole block between them.
    let (second_owner, second) = setup!(flow => player(&mut flow, 5 * LAMPORTS_PER_SOL));
    let ix = assign_power_ix(second, mint);
    step!(&mut flow, "assign_power (second)", ix, &[&second_owner]);
    flow.env.advance(300 * 4);
    let ix = advance_mine_ix(cranker_address, mint);
    step!(&mut flow, "advance_mine (two miners)", ix, &[&cranker]);

    let coin = flow.env.coin(&mint);
    let per_block = if coin.graduated == 1 {
        coin.current_block_reward
    } else {
        coin.curve_mining_block_reward
    };
    assert!(per_block > 0, "a live coin has a block reward");
    assert_eq!(coin.starter_power, 0);
    let first_tokens = flow.env.create_token_account(&first, &mint);
    let second_tokens = flow.env.create_token_account(&second, &mint);
    let ix = claim_rewards_ix(first, mint);
    step!(&mut flow, "claim_rewards (first)", ix, &[&first_owner]);
    let first_paid = flow.env.token_amount(&first_tokens);
    let ix = claim_rewards_ix(second, mint);
    step!(&mut flow, "claim_rewards (second)", ix, &[&second_owner]);
    let second_paid = flow.env.token_amount(&second_tokens);
    let assigned = first_paid + second_paid;
    assert!(
        assigned <= per_block * 8,
        "the tranche assigned {assigned} across eight blocks of {per_block}"
    );
    assert!(
        assigned + 2 >= per_block * 7,
        "the tranche assigned {assigned} across eight {per_block} blocks, so most were skimmed"
    );
    flow.env.assert_vault_invariant(&mint);
    flow.note(format!(
        "two full-tranche miners took {assigned} of a {per_block} block"
    ));
    flow.finish();
}

/// The activation gate: a position earns only while its owner's window is open, and a lapse is
/// detected lazily at the settle rather than by a keeper.
#[test]
fn an_expired_activation_window_stops_accrual() {
    let mut flow = Flow::new("an_expired_activation_window_stops_accrual");
    let (_creator, mint) = setup!(flow => launched(&mut flow, 11));
    let (owner, miner) = setup!(flow => player(&mut flow, 5 * LAMPORTS_PER_SOL));
    let ix = assign_power_ix(miner, mint);
    flow.env.create_token_account(&miner, &mint);
    step!(&mut flow, "assign_power", ix, &[&owner]);
    let cranker = flow.env.wallet(LAMPORTS_PER_SOL);
    let cranker_address = cranker.pubkey();

    // Mine inside the window first, so the position has something it genuinely earned.
    flow.env.advance(300 * 2);
    let ix = advance_mine_ix(cranker_address, mint);
    step!(&mut flow, "advance_mine (inside the window)", ix, &[&cranker]);
    let outstanding_after_first = flow.env.coin(&mint).outstanding_claims;

    // Then let the window close and mine well past it. The global index still advances, but the
    // position is gated when it settles and returns that post-window delta to the reserve.
    flow.env.advance(ACTIVATION_SECONDS * 2);
    let ix = advance_mine_ix(cranker_address, mint);
    step!(&mut flow, "advance_mine (past the window)", ix, &[&cranker]);
    assert!(flow.env.coin(&mint).outstanding_claims > outstanding_after_first);
    let distributed_before_rejected_claim = flow.env.coin(&mint).cumulative_distributed;

    // The claim is gated. The failed transaction rolls back the settle, so the ledger still shows
    // the unsettled index obligation and the player has nothing claimable yet.
    let token_account = associated_token(&miner, &mint);
    let tokens_before_rejected_claim = flow.env.token_amount(&token_account);
    let ix = claim_rewards_ix(miner, mint);
    guard!(
        &mut flow,
        "claim_rewards (window closed)",
        ix,
        &[&owner],
        6015
    );
    assert_eq!(
        flow.env.position(&mint, &miner).pending_reward,
        0,
        "a lapsed window leaves nothing claimable"
    );
    let coin = flow.env.coin(&mint);
    assert_eq!(
        flow.env.token_amount(&token_account),
        tokens_before_rejected_claim,
        "the rejected claim transfers no tokens"
    );
    assert_eq!(coin.cumulative_distributed, distributed_before_rejected_claim);
    flow.env.assert_vault_invariant(&mint);

    // Re-activating settles the position, forfeits the whole unsettled interval, and opens a
    // fresh window that earns.
    let coin_pda = coin_pda(&mint);
    let ix = activate_with_position_ix(owner.pubkey(), coin_pda, position_pda(&coin_pda, &miner));
    step!(&mut flow, "activate (with the armed position)", ix, &[&owner]);
    assert_eq!(flow.env.coin(&mint).cumulative_distributed, 0);
    assert_eq!(flow.env.position(&mint, &miner).pending_reward, 0);
    flow.env.advance(300 * 3);
    let ix = advance_mine_ix(cranker_address, mint);
    step!(&mut flow, "advance_mine (fresh window)", ix, &[&cranker]);
    let ix = claim_rewards_ix(miner, mint);
    step!(&mut flow, "claim_rewards (fresh window)", ix, &[&owner]);
    assert_eq!(
        flow.env.position(&mint, &miner).pending_reward,
        0,
        "the claim paid the fresh window out"
    );
    flow.env.assert_vault_invariant(&mint);
    flow.note("a lapse forfeits, and re-activating resumes");
    flow.finish();
}

/// Retired starter positions remain readable by the two-index ledger, but every new position arms
/// in the full tranche.
#[test]
fn new_mining_positions_all_use_the_full_tranche() {
    let mut flow = Flow::new("new_mining_positions_all_use_the_full_tranche");
    let (_creator, mint) = setup!(flow => launched(&mut flow, 12));
    let (first_owner, first) = setup!(flow => player(&mut flow, 5 * LAMPORTS_PER_SOL));
    let (second_owner, second) = setup!(flow => player(&mut flow, 5 * LAMPORTS_PER_SOL));
    let ix = assign_power_ix(first, mint);
    step!(&mut flow, "assign_power (first)", ix, &[&first_owner]);
    let ix = assign_power_ix(second, mint);
    step!(&mut flow, "assign_power (second)", ix, &[&second_owner]);

    let coin = flow.env.coin(&mint);
    assert_eq!(coin.starter_power, 0);
    assert!(coin.bonded_power > 0);
    assert_eq!(coin.total_power, coin.bonded_power);
    assert_eq!(flow.env.position(&mint, &first).tranche, 0);
    assert_eq!(flow.env.position(&mint, &second).tranche, 0);
    flow.note("both new positions accrued in the full tranche");
    flow.finish();
}

// ---- the epoch seed and discovery ----------------------------------------------------------

#[test]
fn the_epoch_seed_comes_from_a_future_slot_and_settlement_needs_it() {
    let mut flow = Flow::new("the_epoch_seed_comes_from_a_future_slot_and_settlement_needs_it");
    setup!(flow => initialize_protocol(&mut flow));
    let creator = flow.env.wallet(5 * LAMPORTS_PER_SOL);
    let accounts = LaunchAccounts::new(creator.pubkey(), 9);
    let mut args = default_launch_args(9);
    // The eligibility fixture below runs for about 18 days. Use a block interval of one epoch so
    // `advance_mine`'s four-segment walk can reach the first rollover in one keeper call.
    args.block_interval = args.epoch_length;
    args.curve_mining_bps = 0;
    let ix = launch_token_ix(&accounts, &args);
    step!(&mut flow, "launch_token", ix, &[&creator]);
    let mint = accounts.mint;
    let (owner, owner_address) = setup!(flow => discovery_eligible_player(&mut flow));
    let cranker = flow.env.wallet(LAMPORTS_PER_SOL);
    let cranker_address = cranker.pubkey();

    // A coin with no assigned power owes no ledger work. Arm one position so `advance_mine`
    // actually walks the epoch boundary this test is exercising.
    let ix = activate_ix(owner_address);
    step!(&mut flow, "reactivate before assigning power", ix, &[&owner]);
    let ix = assign_power_ix(owner_address, mint);
    step!(&mut flow, "assign_power", ix, &[&owner]);

    // Roll the coin into its first epoch, then read the target before unrelated clock movement
    // can move the harness past it.
    flow.env.advance(300 * 4);
    let ix = advance_mine_ix(cranker_address, mint);
    step!(&mut flow, "advance_mine", ix, &[&cranker]);
    let coin = flow.env.coin(&mint);
    assert!(
        coin.epoch_seed_target_slot > flow.env.slot,
        "the seed target is armed in the future, not read from the past (target {}, slot {})",
        coin.epoch_seed_target_slot,
        flow.env.slot
    );

    // Before the target slot passes, the reveal is refused.
    let ix = commit_epoch_seed_ix(cranker_address, mint);
    guard!(
        &mut flow,
        "commit_epoch_seed (target in the future)",
        ix,
        &[&cranker],
        SEED_TARGET_IN_FUTURE
    );

    // A roll is created while the seed is still unknown, and the budget is charged at creation.
    let window = flow.env.player(&owner_address).roll_window;
    let day = (flow.env.now / DAY) as u16;
    let ix = create_discovery_roll_ix(owner_address, mint, window, day);
    step!(&mut flow, "create_discovery_roll", ix, &[&owner]);
    let opportunity = flow.env.opportunity(&mint, &owner_address, window);
    assert_eq!(opportunity.status, 0, "the opportunity is pending");
    assert!(
        opportunity.budget_lamports > 0,
        "the budget is charged at creation, not at settlement"
    );

    // A reroll is impossible by construction: the PDA is seeded by the window index.
    let ix = create_discovery_roll_ix(owner_address, mint, window, day);
    let result = flow.env.send(&[ix], &[&owner]);
    assert!(
        result.is_err(),
        "a second roll in the same window must fail because its opportunity and global-budget PDAs already exist"
    );

    // Settlement before the reveal is refused: there is no seed, so there is no outcome.
    flow.env.create_token_account(&owner_address, &mint);
    let ix = settle_discovery_ix(cranker_address, owner_address, mint, window, Some(day));
    guard!(
        &mut flow,
        "settle_discovery (no seed yet)",
        ix,
        &[&cranker],
        SEED_NOT_COMMITTED
    );

    // Warp past the target slot and publish the slot hash it commits to.
    let target = flow.env.coin(&mint).epoch_seed_target_slot;
    let hash = solana_hash::Hash::new_from_array([9u8; 32]);
    flow.env
        .set_time(flow.env.now + 60, target + 5);
    flow.env.set_slot_hashes(&[(target, hash)]);
    let ix = commit_epoch_seed_ix(cranker_address, mint);
    step!(&mut flow, "commit_epoch_seed", ix, &[&cranker]);
    let coin = flow.env.coin(&mint);
    assert_eq!(
        coin.epoch_seed,
        hash.to_bytes(),
        "the seed is the SlotHashes entry at exactly the armed slot"
    );
    assert_eq!(coin.epoch_seed_recorded_slot, target);
    assert_eq!(coin.epoch_seed_target_slot, target);

    // And now the same seed settles it. The derivation is recomputable by anyone:
    // sha256(epoch_seed || owner || window_index), which is what the parity vectors pin.
    let vault_before = flow.env.token_amount(&vault_pda(&mint));
    let ix = settle_discovery_ix(cranker_address, owner_address, mint, window, Some(day));
    step!(&mut flow, "settle_discovery", ix, &[&cranker]);
    assert!(
        !flow.env.exists(&opportunity_pda(&coin_pda(&mint), &owner_address, window)),
        "settlement closes the opportunity and refunds its rent to the caller"
    );
    let paid = vault_before - flow.env.token_amount(&vault_pda(&mint));
    let coin = flow.env.coin(&mint);
    assert_eq!(
        coin.discovery_remaining,
        flow.env.coin(&mint).discovery_remaining,
        "the discovery ledger is debited by exactly the payout"
    );
    assert!(
        paid <= coin.discovery_reserve_total,
        "a payout can never exceed the reserve it comes from"
    );
    flow.env.assert_vault_invariant(&mint);
    flow.note(format!("the seed settled a {paid} unit discovery"));
    flow.finish();
}

#[test]
fn discovery_caps_bind_per_day_per_week_per_epoch_and_globally() {
    let mut flow = Flow::new("discovery_caps_bind_per_day_per_week_per_epoch_and_globally");
    let (_creator, mint) = setup!(flow => launched(&mut flow, 10));

    // The tightest possible caps, set by the authority through the timelocked path.
    let authority = flow.env.payer_address();
    let ix = update_discovery_limits_ix(authority, 100, 500, 1, 1, 1, 1);
    step!(&mut flow, "update_discovery_limits", ix, &[]);

    let (owner, owner_address) = setup!(flow => discovery_eligible_player(&mut flow));
    let eligible_window = flow.env.player(&owner_address).roll_window;
    let eligible_day = flow.env.player(&owner_address).day_index;
    let ix = create_discovery_roll_ix(owner_address, mint, eligible_window, eligible_day);
    guard!(
        &mut flow,
        "create_discovery_roll (caps are 1 lamport)",
        ix,
        &[&owner],
        DAILY_CAP_EXCEEDED
    );

    // A wallet with no play history is still refused, and the bond is no longer part of why:
    // the gate is the milestone history - active days, valid activations, crew and maturity.
    let (starter_owner, starter) = setup!(flow => player(&mut flow, 5 * LAMPORTS_PER_SOL));
    let window = flow.env.player(&starter).roll_window;
    let day = flow.env.player(&starter).day_index;
    let ix = create_discovery_roll_ix(starter, mint, window, day);
    guard!(
        &mut flow,
        "create_discovery_roll (no play history)",
        ix,
        &[&starter_owner],
        NOT_DISCOVERY_ELIGIBLE
    );

    // The global daily cap is a protocol-wide budget, so it binds across wallets.
    let ix = update_discovery_limits_ix(
        authority,
        100,
        500,
        1_000_000_000,
        1_000_000_000,
        1_000_000_000,
        2_000_000_000,
    );
    step!(&mut flow, "update_discovery_limits (equal daily, weekly and global caps)", ix, &[]);
    let ix = create_discovery_roll_ix(owner_address, mint, eligible_window, eligible_day);
    guard!(
        &mut flow,
        "create_discovery_roll (global cap)",
        ix,
        &[&owner],
        GLOBAL_CAP_EXCEEDED
    );
    flow.note("the day, week, global and epoch caps and the milestone gate all bind");
    flow.finish();
}

#[test]
fn multiple_players_sharing_the_current_day_share_one_global_budget() {
    let mut flow = Flow::new("multiple_players_sharing_the_current_day_share_one_global_budget");
    let (_creator, mint) = setup!(flow => launched(&mut flow, 14));
    let (first, first_address) = setup!(flow => discovery_eligible_player(&mut flow));
    let (second, second_address) = setup!(flow => discovery_eligible_player(&mut flow));

    // Both PlayerAccounts still name yesterday. Clients must derive the GlobalBudget PDA from
    // the clock's current day, not from either stale player cursor.
    flow.env.advance(DAY + 1);
    let current_day = (flow.env.now / DAY) as u16;
    assert_ne!(
        flow.env.player(&first_address).day_index,
        current_day,
        "the first player is deliberately stale"
    );
    assert_ne!(
        flow.env.player(&second_address).day_index,
        current_day,
        "the second player is deliberately stale"
    );

    let first_window = flow.env.player(&first_address).roll_window;
    let second_window = flow.env.player(&second_address).roll_window;
    let ix = create_discovery_roll_ix(first_address, mint, first_window, current_day);
    step!(&mut flow, "create first roll on current day", ix, &[&first]);
    let ix = create_discovery_roll_ix(second_address, mint, second_window, current_day);
    step!(&mut flow, "create second roll on current day", ix, &[&second]);

    let budget = flow.env.global_budget(current_day);
    assert_eq!(budget.day_index, current_day);
    assert_eq!(budget.roll_count, 2, "both players charge one protocol-wide budget");
    assert_eq!(
        budget.spent_lamports,
        flow.env.opportunity(&mint, &first_address, first_window).budget_lamports
            + flow.env.opportunity(&mint, &second_address, second_window).budget_lamports,
        "the aggregate is the sum of the frozen reservations"
    );
    flow.finish();
}

#[test]
fn an_expired_opportunity_pays_nothing_and_refunds_no_budget() {
    let mut flow = Flow::new("an_expired_opportunity_pays_nothing_and_refunds_no_budget");
    let (_creator, mint) = setup!(flow => launched(&mut flow, 11));
    let (owner, owner_address) = setup!(flow => discovery_eligible_player(&mut flow));
    let window = flow.env.player(&owner_address).roll_window;
    let day = (flow.env.now / DAY) as u16;
    let ix = create_discovery_roll_ix(owner_address, mint, window, day);
    step!(&mut flow, "create_discovery_roll", ix, &[&owner]);
    let budget = flow.env.opportunity(&mint, &owner_address, window).budget_lamports;
    let spent_before = flow.env.player(&owner_address).spent_day_lamports;
    let vault_before = flow.env.token_amount(&vault_pda(&mint));

    // One epoch plus a settle window: past it the opportunity is dead and pays nothing.
    flow.env.advance(1_209_600 + DAY);
    let cranker = flow.env.wallet(LAMPORTS_PER_SOL);
    let cranker_address = cranker.pubkey();
    let ix = expire_opportunity_ix(cranker_address, owner_address, mint, window);
    step!(&mut flow, "expire_opportunity", ix, &[&cranker]);
    assert!(
        !flow.env.exists(&opportunity_pda(&coin_pda(&mint), &owner_address, window)),
        "the expired opportunity is closed"
    );
    assert_eq!(
        flow.env.token_amount(&vault_pda(&mint)),
        vault_before,
        "expiry pays nothing"
    );
    assert_eq!(
        flow.env.player(&owner_address).spent_day_lamports,
        spent_before,
        "and refunds no budget: the charge at creation is what neutralises a bad outcome"
    );
    flow.note(format!("an expired {budget}-lamport roll paid nothing"));
    flow.finish();
}

// ---- the crank and the admin surface -------------------------------------------------------

#[test]
fn every_crank_instruction_is_permissionless() {
    let mut flow = Flow::new("every_crank_instruction_is_permissionless");
    let (creator, mint) = setup!(flow => launched(&mut flow, 12));
    let (owner, owner_address) = setup!(flow => player(&mut flow, 5 * LAMPORTS_PER_SOL));
    let ix = assign_power_ix(owner_address, mint);
    step!(&mut flow, "assign_power", ix, &[&owner]);

    // A wallet with no relationship to the coin, the creator or the authority.
    let cranker = flow.env.wallet(LAMPORTS_PER_SOL);
    let cranker_address = cranker.pubkey();
    assert_ne!(cranker_address, creator.pubkey());
    assert_ne!(cranker_address, flow.env.payer_address());

    flow.env.advance(300 * 4);
    let ix = advance_mine_ix(cranker_address, mint);
    step!(&mut flow, "advance_mine (stranger)", ix, &[&cranker]);

    let trader = flow.env.wallet(200 * LAMPORTS_PER_SOL);
    let trader_address = trader.pubkey();
    let tokens = flow.env.create_token_account(&trader_address, &mint);
    let target = flow.env.coin(&mint).graduation_target;
    let ix = buy_ix(trader_address, mint, tokens, target * 2, 0);
    step!(&mut flow, "buy", ix, &[&trader]);
    let ix = graduate_market_ix(cranker_address, mint);
    step!(&mut flow, "graduate_market (stranger)", ix, &[&cranker]);

    // Take the tip while fees are still claimable, then sweep the remaining fixed destinations.
    // sweep_fees pays only the treasury, crank pool and creator; the payer gets nothing else.
    let ix = crank_tip_ix(cranker_address, mint, 1);
    step!(&mut flow, "crank_tip (stranger)", ix, &[&cranker]);
    let ix = sweep_fees_ix(cranker_address, mint, creator.pubkey());
    step!(&mut flow, "sweep_fees (stranger)", ix, &[&cranker]);
    flow.env.assert_vault_invariant(&mint);
    flow.note("a stranger can crank, graduate, sweep and take a bounded tip");
    flow.finish();
}

#[test]
fn no_admin_path_can_withdraw_a_user_balance_a_reserve_or_the_pool() {
    let mut flow = Flow::new("no_admin_path_can_withdraw_a_user_balance_a_reserve_or_the_pool");
    let (_creator, mint) = setup!(flow => launched(&mut flow, 13));
    let (owner, owner_address) = setup!(flow => player(&mut flow, 5 * LAMPORTS_PER_SOL));
    let ix = assign_power_ix(owner_address, mint);
    step!(&mut flow, "assign_power", ix, &[&owner]);
    let trader = flow.env.wallet(200 * LAMPORTS_PER_SOL);
    let trader_address = trader.pubkey();
    let tokens = flow.env.create_token_account(&trader_address, &mint);
    let target = flow.env.coin(&mint).graduation_target;
    let ix = buy_ix(trader_address, mint, tokens, target * 2, 0);
    step!(&mut flow, "buy", ix, &[&trader]);
    let cranker = flow.env.wallet(LAMPORTS_PER_SOL);
    let cranker_address = cranker.pubkey();
    let ix = graduate_market_ix(cranker_address, mint);
    step!(&mut flow, "graduate_market", ix, &[&cranker]);

    // Every balance a user or the protocol holds, before the authority does anything at all.
    let watched = [
        ("vault", vault_pda(&mint)),
        ("coin", coin_pda(&mint)),
        ("player", player_pda(&owner_address)),
        ("pool token vault", pool_vault_pda(&mint)),
        ("pool SOL vault", pool_sol_pda(&mint)),
        ("treasury", treasury_pda()),
        ("crank pool", crank_pool_pda()),
        ("creator", creator_of(&flow, &mint)),
        ("trader", trader_address),
        ("owner", owner_address),
    ];
    let before: Vec<(&str, u64)> = watched
        .iter()
        .map(|(name, address)| (*name, flow.env.lamports(address)))
        .collect();
    let tokens_before = flow.env.token_amount(&vault_pda(&mint));

    let authority = flow.env.payer_address();
    let now = flow.env.now;
    let ix = update_fee_config_ix(authority, 50, 50, 0);
    step!(&mut flow, "update_fee_config", ix, &[]);
    let ix = update_discovery_limits_ix(
        authority,
        100,
        500,
        2_000_000_000,
        8_000_000_000,
        50_000_000_000,
        4_000_000_000,
    );
    step!(&mut flow, "update_discovery_limits", ix, &[]);
    let ix = set_rarity_table_ix(authority, &default_rarity_tiers());
    step!(&mut flow, "set_rarity_table", ix, &[]);
    let ix = set_curve_table_ix(authority, &[1u32; 100], &vec![vec![1u32; 100]; 5]);
    step!(&mut flow, "set_curve_table", ix, &[]);
    let ix = schedule_pause_ix(authority, 1, now + 3_600);
    step!(&mut flow, "schedule_pause", ix, &[]);
    flow.env.advance(3_600);
    let ix = unpause_ix(authority, 1);
    step!(&mut flow, "unpause", ix, &[]);

    for (name, address) in &watched {
        let was = before
            .iter()
            .find(|(watched_name, _)| watched_name == name)
            .map(|(_, lamports)| *lamports)
            .expect("watched");
        assert_eq!(
            flow.env.lamports(address),
            was,
            "an admin instruction moved {name} lamports"
        );
    }
    assert_eq!(
        flow.env.token_amount(&vault_pda(&mint)),
        tokens_before,
        "no admin instruction can move a single token out of the vault"
    );
    flow.env.assert_vault_invariant(&mint);
    flow.env.assert_conservation(&mint);
    flow.note("the whole admin surface left every balance and every reserve untouched");
    flow.finish();
}

#[test]
fn a_sponsor_can_only_withdraw_what_it_did_not_spend() {
    let mut flow = Flow::new("a_sponsor_can_only_withdraw_what_it_did_not_spend");
    setup!(flow => initialize_protocol(&mut flow));
    let sponsor = flow.env.wallet(5 * LAMPORTS_PER_SOL);
    let sponsor_address = sponsor.pubkey();
    let ix = init_sponsor_vault_ix(sponsor_address);
    step!(&mut flow, "init_sponsor_vault", ix, &[&sponsor]);
    let funded = 100_000_000;
    let ix = fund_sponsor_vault_ix(sponsor_address, funded);
    step!(&mut flow, "fund_sponsor_vault", ix, &[&sponsor]);

    // More than was funded is refused, and the vault keeps its own rent floor either way.
    let ix = withdraw_sponsor_vault_ix(sponsor_address, funded + 1);
    guard!(
        &mut flow,
        "withdraw_sponsor_vault (more than unspent)",
        ix,
        &[&sponsor],
        UNSPENT_WITHDRAWAL_ONLY
    );
    let floor = flow.env.svm.minimum_balance_for_rent_exemption(70);
    let ix = withdraw_sponsor_vault_ix(sponsor_address, funded);
    step!(&mut flow, "withdraw_sponsor_vault (all unspent)", ix, &[&sponsor]);
    assert_eq!(
        flow.env.lamports(&sponsor_vault_pda(&sponsor_address)),
        floor,
        "the vault can never be taken below its own rent floor"
    );
    let vault = flow.env.sponsor_vault(&sponsor_address);
    assert_eq!(vault.total_withdrawn, funded, "the withdrawal is recorded");
    assert_eq!(vault.total_spent, 0, "nothing was spent");
    flow.note("a sponsor withdrew exactly the unspent part and kept the vault rent-exempt");
    flow.finish();
}

// ---- sponsorship changes nothing -----------------------------------------------------------

#[test]
fn sponsorship_changes_no_power_and_no_discovery_outcome() {
    let mut flow = Flow::new("sponsorship_changes_no_power_and_no_discovery_outcome");
    let plain = match sponsorship_run(false) {
        Ok(value) => value,
        Err(pending) => {
            flow.pending.extend(pending);
            flow.finish();
            return;
        }
    };
    let sponsored = match sponsorship_run(true) {
        Ok(value) => value,
        Err(pending) => {
            flow.pending.extend(pending);
            flow.finish();
            return;
        }
    };
    let (plain_power, plain_tranche, plain_outcome) = plain;
    let (sponsored_power, sponsored_tranche, sponsored_outcome) = sponsored;
    assert_eq!(
        plain_power, sponsored_power,
        "sponsorship changed the power a wallet mines with"
    );
    assert_eq!(
        plain_tranche, sponsored_tranche,
        "sponsorship changed the tranche"
    );
    assert_eq!(
        plain_outcome, sponsored_outcome,
        "sponsorship changed a discovery derivation input"
    );
    // Both arms are the full tranche with nothing parked: the sponsorship pays fees, and the
    // bond it used to be able to fund is retired.
    assert_eq!(plain_tranche, 0, "the full tranche without a sponsor");
    assert_eq!(sponsored_tranche, 0, "and the full tranche with one");
    flow.note("sponsorship changed no power, no tranche and no discovery input");
    flow.finish();
}

// ---- referral credits --------------------------------------------------------------------

#[test]
fn referral_ore_is_credited_once_to_the_referrer_by_the_keeper() {
    let mut flow = Flow::new("referral_ore_is_credited_once_to_the_referrer_by_the_keeper");
    let keeper = flow.env.wallet(5 * LAMPORTS_PER_SOL);
    setup!(flow => initialize_protocol_with_keeper(&mut flow, keeper.pubkey()));
    let (_referrer, referrer) = setup!(flow => referral_referrer(&mut flow));
    let referee = Keypair::new();
    let amount = REFERRAL_MAX_AMOUNT;
    let before = flow.env.player(&referrer).ore_balance;
    let ix = credit_referral_ore_ix(keeper.pubkey(), referrer, referee.pubkey(), amount);
    step!(&mut flow, "credit_referral_ore", ix, &[&keeper]);
    let player = flow.env.player(&referrer);
    assert_eq!(player.ore_balance, before + amount);
    assert_eq!(player.ore_earned, amount);
    assert_eq!(flow.env.referral_credit(&referrer, &referee.pubkey()).amount, amount);
    assert_eq!(flow.env.referral_week(&referrer).count, 1);
    flow.note("the keeper credited the referrer and the referee was only an identity seed");
    flow.finish();
}

#[test]
fn referral_ore_rejects_non_keeper_signers_amount_out_of_range_and_replay() {
    let mut flow = Flow::new("referral_ore_rejects_non_keeper_signers_amount_out_of_range_and_replay");
    let keeper = flow.env.wallet(5 * LAMPORTS_PER_SOL);
    setup!(flow => initialize_protocol_with_keeper(&mut flow, keeper.pubkey()));
    let (_referrer, referrer) = setup!(flow => referral_referrer(&mut flow));
    let referee = Keypair::new();
    let impostor = flow.env.wallet(5 * LAMPORTS_PER_SOL);
    let ix = credit_referral_ore_ix(impostor.pubkey(), referrer, referee.pubkey(), 1);
    guard!(&mut flow, "credit_referral_ore (non-keeper)", ix, &[&impostor], 2012);
    for amount in [0, REFERRAL_MAX_AMOUNT + 1] {
        let ix = credit_referral_ore_ix(keeper.pubkey(), referrer, referee.pubkey(), amount);
        guard!(
            &mut flow,
            "credit_referral_ore (amount cap)",
            ix,
            &[&keeper],
            REFERRAL_AMOUNT_OUT_OF_RANGE
        );
    }
    let ix = credit_referral_ore_ix(keeper.pubkey(), referrer, referee.pubkey(), 7);
    step!(&mut flow, "credit_referral_ore", ix, &[&keeper]);
    let before = flow.env.player(&referrer).ore_balance;
    let ix = credit_referral_ore_ix(keeper.pubkey(), referrer, referee.pubkey(), 7);
    guard!(&mut flow, "credit_referral_ore (replay)", ix, &[&keeper], 0);
    assert_eq!(flow.env.player(&referrer).ore_balance, before);
    flow.note("authorization, amount bounds, and marker replay are enforced");
    flow.finish();
}

#[test]
fn referral_ore_weekly_cap_resets_next_week() {
    let mut flow = Flow::new("referral_ore_weekly_cap_resets_next_week");
    let keeper = flow.env.wallet(20 * LAMPORTS_PER_SOL);
    setup!(flow => initialize_protocol_with_keeper(&mut flow, keeper.pubkey()));
    let (_referrer, referrer) = setup!(flow => referral_referrer(&mut flow));
    for index in 0..25u8 {
        let referee = Keypair::new();
        let ix = credit_referral_ore_ix(keeper.pubkey(), referrer, referee.pubkey(), 1);
        step!(&mut flow, "credit_referral_ore (weekly cap)", ix, &[&keeper]);
        assert_eq!(flow.env.referral_week(&referrer).count, index + 1);
    }
    let extra = Keypair::new();
    let ix = credit_referral_ore_ix(keeper.pubkey(), referrer, extra.pubkey(), 1);
    guard!(
        &mut flow,
        "credit_referral_ore (26th)",
        ix,
        &[&keeper],
        REFERRAL_WEEKLY_CAP_EXCEEDED
    );
    flow.env.advance(REFERRAL_WEEK_SECONDS + 1);
    let next = Keypair::new();
    let ix = credit_referral_ore_ix(keeper.pubkey(), referrer, next.pubkey(), 1);
    step!(&mut flow, "credit_referral_ore (next week)", ix, &[&keeper]);
    assert_eq!(flow.env.referral_week(&referrer).count, 1);
    flow.note("the 26th credit is refused and a new week resets the counter");
    flow.finish();
}

#[test]
fn referral_ore_rejects_full_storage_without_partial_credit() {
    let mut flow = Flow::new("referral_ore_rejects_full_storage_without_partial_credit");
    let keeper = flow.env.wallet(5 * LAMPORTS_PER_SOL);
    setup!(flow => initialize_protocol_with_keeper(&mut flow, keeper.pubkey()));
    let (_referrer, referrer) = setup!(flow => referral_referrer(&mut flow));
    let capacity = diggo_protocol::ore_capacity(flow.env.player(&referrer).crew_levels).unwrap();
    while flow.env.player(&referrer).ore_balance < capacity {
        let remaining = capacity - flow.env.player(&referrer).ore_balance;
        let amount = remaining.min(REFERRAL_MAX_AMOUNT as u64);
        let full = Keypair::new();
        let ix = credit_referral_ore_ix(keeper.pubkey(), referrer, full.pubkey(), amount);
        step!(&mut flow, "credit_referral_ore (fill storage)", ix, &[&keeper]);
    }
    let rejected = Keypair::new();
    let ix = credit_referral_ore_ix(keeper.pubkey(), referrer, rejected.pubkey(), 1);
    guard!(
        &mut flow,
        "credit_referral_ore (full storage)",
        ix,
        &[&keeper],
        STORAGE_CAPACITY_EXCEEDED
    );
    assert_eq!(flow.env.player(&referrer).ore_balance, capacity);
    flow.note("a credit that cannot fit is rejected atomically, with no partial balance");
    flow.finish();
}

#[test]
fn referral_ore_mismatch_is_rejected() {
    let mut flow = Flow::new("referral_ore_mismatch_is_rejected");
    let keeper = flow.env.wallet(5 * LAMPORTS_PER_SOL);
    setup!(flow => initialize_protocol_with_keeper(&mut flow, keeper.pubkey()));
    let (_referrer, referrer) = setup!(flow => referral_referrer(&mut flow));
    let referee = Keypair::new();
    let other = Keypair::new();
    let mut instruction = credit_referral_ore_ix(keeper.pubkey(), referrer, other.pubkey(), 1);
    instruction.data[8..40].copy_from_slice(referee.pubkey().as_ref());
    guard!(
        &mut flow,
        "credit_referral_ore (referee mismatch)",
        instruction,
        &[&keeper],
        REFERRAL_REFEREE_MISMATCH
    );
    flow.finish();
}

/// The sponsor half of the retirement: a vault can still be funded and the owner can still take
/// back everything it did not spend, but no event may promise to fund a bond. Nothing is left
/// parked in the vault by the refusal.
#[test]
fn a_sponsor_can_no_longer_fund_a_bond() {
    let mut flow = Flow::new("a_sponsor_can_no_longer_fund_a_bond");
    let (_creator, _mint) = setup!(flow => launched(&mut flow, 15));
    let sponsor = flow.env.wallet(5 * LAMPORTS_PER_SOL);
    let sponsor_address = sponsor.pubkey();
    let ix = init_sponsor_vault_ix(sponsor_address);
    step!(&mut flow, "init_sponsor_vault", ix, &[&sponsor]);
    let funded = 10 * BOND_LAMPORTS;
    let ix = fund_sponsor_vault_ix(sponsor_address, funded);
    step!(&mut flow, "fund_sponsor_vault", ix, &[&sponsor]);
    let vault = sponsor_vault_pda(&sponsor_address);

    // A PlayerBondSubsidy event may not even be created any more.
    let now = flow.env.now;
    let ix = create_sponsor_event_ix(
        sponsor_address,
        0,
        3, // PlayerBondSubsidy
        now - 60,
        now + 30 * DAY,
        funded,
        0,
        BOND_LAMPORTS,
    );
    guard!(
        &mut flow,
        "create_sponsor_event (bond kind is retired)",
        ix,
        &[&sponsor],
        BOND_RETIRED
    );

    // The vault is whole and entirely the sponsor's to take back.
    let vault_balance = flow.env.lamports(&vault);
    assert_eq!(
        flow.env.sponsor_vault(&sponsor_address).total_spent,
        0,
        "nothing was spent against the vault"
    );
    let ix = withdraw_sponsor_vault_ix(sponsor_address, vault_balance - 1);
    guard!(
        &mut flow,
        "withdraw_sponsor_vault (more than funded)",
        ix,
        &[&sponsor],
        UNSPENT_WITHDRAWAL_ONLY
    );
    let before = flow.env.lamports(&sponsor_address);
    let ix = withdraw_sponsor_vault_ix(sponsor_address, funded);
    step!(&mut flow, "withdraw_sponsor_vault (unspent)", ix, &[&sponsor]);
    assert_eq!(
        flow.env.lamports(&sponsor_address),
        before + funded,
        "the sponsor takes back every lamport it funded"
    );
    flow.note("no event may fund a bond and the unspent vault balance is not stranded");
    flow.finish();
}

/// One arm of the sponsorship invariance: the same wallet (a fixed keypair), the same coin
/// parameters and the same seed, with and without a live PlatformTradeFeeWaiver event in the
/// vault. Design 1.7 promises the two arms are indistinguishable in power and in discovery, and
/// the derivation input of design 4.1 - sha256(epoch_seed || owner || window) - is what the second
/// return value stands for. Returns the pending instruction names when a handler is still a
/// skeleton, so the caller can report them.
fn sponsorship_run(sponsored: bool) -> Result<(u64, u8, u64), Vec<&'static str>> {
    let mut flow = Flow::new("sponsorship_run");
    let (_creator, mint) = launched(&mut flow, 14)?;
    let owner = Keypair::new_from_array([7u8; 32]);
    let owner_address = owner.pubkey();
    flow.env
        .svm
        .airdrop(&owner_address, 5 * LAMPORTS_PER_SOL)
        .expect("airdrop");
    let ix = initialize_player_ix(owner_address, None);
    try_step!(&mut flow, "initialize_player", ix, &[&owner]);
    let ix = activate_ix(owner_address);
    try_step!(&mut flow, "activate", ix, &[&owner]);
    if sponsored {
        let sponsor = flow.env.wallet(5 * LAMPORTS_PER_SOL);
        let sponsor_address = sponsor.pubkey();
        let ix = init_sponsor_vault_ix(sponsor_address);
        try_step!(&mut flow, "init_sponsor_vault", ix, &[&sponsor]);
        let ix = fund_sponsor_vault_ix(sponsor_address, 10 * BOND_LAMPORTS);
        try_step!(&mut flow, "fund_sponsor_vault", ix, &[&sponsor]);
        let now = flow.env.now;
        // A live fee waiver, not a bond subsidy: the bond kind can no longer be created at all,
        // which a_sponsor_can_no_longer_fund_a_bond asserts on its own.
        let ix = create_sponsor_event_ix(
            sponsor_address,
            0,
            1, // PlatformTradeFeeWaiver
            now - 60,
            now + 30 * DAY,
            10 * BOND_LAMPORTS,
            BOND_LAMPORTS,
            0,
        );
        try_step!(&mut flow, "create_sponsor_event", ix, &[&sponsor]);
    }
    let ix = assign_power_ix(owner_address, mint);
    try_step!(&mut flow, "assign_power", ix, &[&owner]);
    let position = flow.env.position(&mint, &owner_address);
    let outcome = window_outcome(&flow, &mint, &owner_address);
    flow.finish();
    Ok((position.assigned_power, position.tranche, outcome))
}

// ---- helpers ------------------------------------------------------------------------------

fn to_anchor(address: solana_address::Address) -> anchor_lang::prelude::Pubkey {
    anchor_lang::prelude::Pubkey::new_from_array(address.to_bytes())
}

/// The creator recorded on a coin, as a plain address.
fn creator_of(flow: &Flow, mint: &solana_address::Address) -> solana_address::Address {
    solana_address::Address::new_from_array(flow.env.coin(mint).creator.to_bytes())
}

/// The derivation input a discovery outcome depends on: the coin's recorded seed, the wallet and
/// the window index, hashed exactly as design 4.1 says. Sponsorship cannot reach any of the three,
/// which is why the sponsored and unsponsored runs have to agree on it.
fn window_outcome(flow: &Flow, mint: &solana_address::Address, owner: &solana_address::Address) -> u64 {
    use sha2::{Digest, Sha256};
    let coin = flow.env.coin(mint);
    let player = flow.env.player(owner);
    let mut hasher = Sha256::new();
    hasher.update(coin.epoch_seed);
    hasher.update(owner.as_ref());
    hasher.update(player.roll_window.to_le_bytes());
    let digest = hasher.finalize();
    u64::from_le_bytes(digest[..8].try_into().unwrap())
}
