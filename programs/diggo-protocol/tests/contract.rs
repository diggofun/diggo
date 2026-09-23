//! The frozen contract of CONTRACTS.md, pinned against the built program.
//!
//! Every test here passes on the spine commit and keeps passing as A, B and C land: it asserts
//! the things the workstreams are not allowed to change - account sizes, the seed lists, the
//! instruction surface and the error-code blocks - and it does it by loading the real .so rather
//! than by reading the source, so a rename or a moved field is caught where it matters.

mod common;

use common::*;
use diggo_protocol::{
    Coin, CurveTable, DiggoError, DiscoveryOpportunity, GlobalBudget, LiquidityPool,
    MiningPosition, PlayerAccount, ProtocolConfig, SponsorEvent, SponsorGrant, SponsorVault,
    ReferralCredit, ReferralWeek,
};
use solana_address::Address;
use solana_signer::Signer;

/// The whole account space of every v2 account, from CONTRACTS.md. The four numbers marked in the
/// contract's deviations table are the ones a worker is most likely to "fix" by accident.
#[test]
fn account_sizes_match_the_frozen_table() {
    assert_eq!(ProtocolConfig::SIZE, 434, "ProtocolConfig");
    assert_eq!(CurveTable::SIZE, 2_410, "CurveTable");
    assert_eq!(Coin::SIZE, 464, "Coin");
    assert_eq!(PlayerAccount::SIZE, 216, "PlayerAccount");
    assert_eq!(MiningPosition::SIZE, 51, "MiningPosition");
    assert_eq!(LiquidityPool::SIZE, 185, "LiquidityPool");
    assert_eq!(DiscoveryOpportunity::SIZE, 124, "DiscoveryOpportunity");
    assert_eq!(GlobalBudget::SIZE, 53, "GlobalBudget");
    assert_eq!(SponsorVault::SIZE, 70, "SponsorVault");
    assert_eq!(SponsorEvent::SIZE, 92, "SponsorEvent");
    assert_eq!(SponsorGrant::SIZE, 42, "SponsorGrant");
    assert_eq!(ReferralCredit::SIZE, 17, "ReferralCredit");
    assert_eq!(ReferralWeek::SIZE, 18, "ReferralWeek");
    assert_eq!(diggo_protocol::MINT_V2_SIZE, 438, "the hand-written mint");
    assert_eq!(diggo_protocol::TOKEN_ACCOUNT_SIZE, 165, "an SPL token account");
}

/// The rent a creator actually pays, computed by the cluster's own rent parameters:
/// (size + 128) * 6,960 lamports. This is the launch cost story of design 1.3, measured rather
/// than quoted.
///
/// Four of the numbers in CONTRACTS.md's rent column are a few hundred lamports away from this
/// formula - Coin says 3,729,600 where the formula gives 3,730,560, MiningPosition 1,246,440
/// against 1,245,840, GlobalBudget 1,259,880 against 1,259,760, SponsorVault 1,377,360 against
/// 1,378,080, ProtocolConfig 3,911,400 against 3,911,520 and CurveTable 17,662,800 against
/// 17,664,480 - so this test pins the formula, which is what the runtime charges, and the report
/// files the documentation gap.
///
/// The mint is the one account whose size moved: token-2022 8.0.1 puts the account-type byte at
/// `Account::LEN`, so a mint carries 83 bytes of padding its own 82 bytes never accounted for,
/// and the mint is 438 bytes rather than 355. That is 577,680 lamports of extra rent and it takes
/// the paid launch to 10,098,960 lamports, just over a hundredth of a SOL. The padding is not
/// optional: it is the layout the token program's InitializeMint2 accepts.
#[test]
fn rent_follows_the_cluster_formula_and_a_launch_stays_under_a_cent() {
    let env = Env::new();
    let formula = |size: usize| ((size + 128) as u64) * 6_960;
    for size in [
        ProtocolConfig::SIZE,
        CurveTable::SIZE,
        Coin::SIZE,
        PlayerAccount::SIZE,
        MiningPosition::SIZE,
        LiquidityPool::SIZE,
        DiscoveryOpportunity::SIZE,
        GlobalBudget::SIZE,
        SponsorVault::SIZE,
        SponsorEvent::SIZE,
        SponsorGrant::SIZE,
        ReferralCredit::SIZE,
        ReferralWeek::SIZE,
        diggo_protocol::MINT_V2_SIZE,
        diggo_protocol::TOKEN_ACCOUNT_SIZE,
    ] {
        assert_eq!(
            env.svm.minimum_balance_for_rent_exemption(size),
            formula(size),
            "rent for {size} bytes"
        );
    }
    // The three accounts a paid launch creates: the mint, the Coin and its one vault.
    let launch = formula(diggo_protocol::MINT_V2_SIZE)
        + formula(Coin::SIZE)
        + formula(diggo_protocol::TOKEN_ACCOUNT_SIZE);
    assert_eq!(launch, 10_098_960, "a launch costs {} lamports", launch);
    assert!(launch < 10_200_000, "just over 0.01 SOL: {}", launch);
    // A player is a PlayerAccount, and a position is a MiningPosition: under 0.004 SOL together.
    let player = formula(PlayerAccount::SIZE) + formula(MiningPosition::SIZE);
    assert!(player < 4_000_000, "a player costs {} lamports", player);
}

/// The v2 error blocks, in the order 8.2 reserves them. The names and the order are the contract;
/// the numeric range is what the tree actually produces.
#[test]
fn v2_error_codes_are_appended_in_the_designed_order() {
    /// Anchor numbers a program error 6000 + its index in the enum, and it carries that number
    /// on the AnchorError it builds, which is the number a client matches on.
    fn code(error: DiggoError) -> u32 {
        match anchor_lang::error::Error::from(error) {
            anchor_lang::error::Error::AnchorError(inner) => inner.error_code_number,
            anchor_lang::error::Error::ProgramError(_) => panic!("expected an anchor error"),
        }
    }
    // The whole v2 block, in the order 8.2 reserves it: 48 variants, 6048..=6095, appended after
    // the 48 v4 variants that keep 6000..=6047. A worker that inserts a variant anywhere moves
    // every code below it, and a client that matches on a number would silently match the wrong
    // error, which is why this list is written out rather than sampled.
    let expected: [(&str, u32); 53] = [
        ("NotImplemented", 6048),
        ("InvalidPauseWindow", 6049),
        ("NotTimelocked", 6050),
        ("ConfigOutOfBounds", 6051),
        ("InvalidRarityTable", 6052),
        ("InvalidCurveTable", 6053),
        ("NotActivated", 6054),
        ("AccrualOverflow", 6055),
        ("CrewAtMaxLevel", 6056),
        ("InsufficientOre", 6057),
        ("StorageCapacityExceeded", 6058),
        ("ReactivationTooSoon", 6059),
        ("BondAlreadyPosted", 6060),
        ("NoBondPosted", 6061),
        ("PositionStillActive", 6062),
        ("BondCooldownActive", 6063),
        ("SponsorBondNotWithdrawable", 6064),
        ("VaultBelowRentExempt", 6065),
        ("LedgerInvariantViolated", 6066),
        ("MetadataTooLong", 6067),
        ("InvalidMintLayout", 6068),
        ("CurveExhausted", 6069),
        ("PoolNotInitialised", 6070),
        ("TwapUnavailable", 6071),
        ("FeeSplitOverflow", 6072),
        ("CrankTipExceedsAccrual", 6073),
        ("NotCoinCreator", 6074),
        ("EventNotActive", 6075),
        ("EventBudgetExhausted", 6076),
        ("PerCoinLimitExceeded", 6077),
        ("PerWalletLimitExceeded", 6078),
        ("EventAlreadyClosed", 6079),
        ("UnspentWithdrawalOnly", 6080),
        ("InvalidEventKind", 6081),
        ("EpochNotRolled", 6082),
        ("SeedTargetInFuture", 6083),
        ("SeedTargetNotInSysvar", 6084),
        ("SeedAlreadyCommitted", 6085),
        ("SeedNotCommitted", 6086),
        ("CoinNotAdvanced", 6087),
        ("RollAlreadyExists", 6088),
        ("NotDiscoveryEligible", 6089),
        ("OpportunityExpired", 6090),
        ("OpportunityAlreadySettled", 6091),
        ("DailyCapExceeded", 6092),
        ("WeeklyCapExceeded", 6093),
        ("GlobalCapExceeded", 6094),
        ("EpochBudgetExhausted", 6095),
        ("UnclaimedRewards", 6096),
        ("BondRetired", 6097),
        ("ReferralAmountOutOfRange", 6098),
        ("ReferralWeeklyCapExceeded", 6099),
        ("ReferralRefereeMismatch", 6100),
    ];
    for (index, (name, number)) in expected.iter().enumerate() {
        let variant = v2_error_variant(name);
        assert_eq!(
            code(variant),
            *number,
            "{name} is the {}th v2 variant",
            index + 1
        );
    }
    // And the v4 block really does end where the v2 block begins.
    assert_eq!(code(DiggoError::InvalidCurveMining), 6047);
}

/// Maps a v2 variant name to the variant, so the table above can be written as data.
fn v2_error_variant(name: &str) -> DiggoError {
    match name {
        "NotImplemented" => DiggoError::NotImplemented,
        "InvalidPauseWindow" => DiggoError::InvalidPauseWindow,
        "NotTimelocked" => DiggoError::NotTimelocked,
        "ConfigOutOfBounds" => DiggoError::ConfigOutOfBounds,
        "InvalidRarityTable" => DiggoError::InvalidRarityTable,
        "InvalidCurveTable" => DiggoError::InvalidCurveTable,
        "NotActivated" => DiggoError::NotActivated,
        "AccrualOverflow" => DiggoError::AccrualOverflow,
        "CrewAtMaxLevel" => DiggoError::CrewAtMaxLevel,
        "InsufficientOre" => DiggoError::InsufficientOre,
        "StorageCapacityExceeded" => DiggoError::StorageCapacityExceeded,
        "ReactivationTooSoon" => DiggoError::ReactivationTooSoon,
        "BondAlreadyPosted" => DiggoError::BondAlreadyPosted,
        "NoBondPosted" => DiggoError::NoBondPosted,
        "PositionStillActive" => DiggoError::PositionStillActive,
        "BondCooldownActive" => DiggoError::BondCooldownActive,
        "SponsorBondNotWithdrawable" => DiggoError::SponsorBondNotWithdrawable,
        "VaultBelowRentExempt" => DiggoError::VaultBelowRentExempt,
        "LedgerInvariantViolated" => DiggoError::LedgerInvariantViolated,
        "MetadataTooLong" => DiggoError::MetadataTooLong,
        "InvalidMintLayout" => DiggoError::InvalidMintLayout,
        "CurveExhausted" => DiggoError::CurveExhausted,
        "PoolNotInitialised" => DiggoError::PoolNotInitialised,
        "TwapUnavailable" => DiggoError::TwapUnavailable,
        "FeeSplitOverflow" => DiggoError::FeeSplitOverflow,
        "CrankTipExceedsAccrual" => DiggoError::CrankTipExceedsAccrual,
        "NotCoinCreator" => DiggoError::NotCoinCreator,
        "EventNotActive" => DiggoError::EventNotActive,
        "EventBudgetExhausted" => DiggoError::EventBudgetExhausted,
        "PerCoinLimitExceeded" => DiggoError::PerCoinLimitExceeded,
        "PerWalletLimitExceeded" => DiggoError::PerWalletLimitExceeded,
        "EventAlreadyClosed" => DiggoError::EventAlreadyClosed,
        "UnspentWithdrawalOnly" => DiggoError::UnspentWithdrawalOnly,
        "InvalidEventKind" => DiggoError::InvalidEventKind,
        "EpochNotRolled" => DiggoError::EpochNotRolled,
        "SeedTargetInFuture" => DiggoError::SeedTargetInFuture,
        "SeedTargetNotInSysvar" => DiggoError::SeedTargetNotInSysvar,
        "SeedAlreadyCommitted" => DiggoError::SeedAlreadyCommitted,
        "SeedNotCommitted" => DiggoError::SeedNotCommitted,
        "CoinNotAdvanced" => DiggoError::CoinNotAdvanced,
        "RollAlreadyExists" => DiggoError::RollAlreadyExists,
        "NotDiscoveryEligible" => DiggoError::NotDiscoveryEligible,
        "OpportunityExpired" => DiggoError::OpportunityExpired,
        "OpportunityAlreadySettled" => DiggoError::OpportunityAlreadySettled,
        "DailyCapExceeded" => DiggoError::DailyCapExceeded,
        "WeeklyCapExceeded" => DiggoError::WeeklyCapExceeded,
        "GlobalCapExceeded" => DiggoError::GlobalCapExceeded,
        "EpochBudgetExhausted" => DiggoError::EpochBudgetExhausted,
        "UnclaimedRewards" => DiggoError::UnclaimedRewards,
        "BondRetired" => DiggoError::BondRetired,
        "ReferralAmountOutOfRange" => DiggoError::ReferralAmountOutOfRange,
        "ReferralWeeklyCapExceeded" => DiggoError::ReferralWeeklyCapExceeded,
        "ReferralRefereeMismatch" => DiggoError::ReferralRefereeMismatch,
        other => panic!("unknown v2 error variant {other}"),
    }
}

/// Every seed list of the contract, and the fact that none of them collides with another: a
/// collision would be two accounts that can never coexist.
#[test]
fn every_pda_seed_list_is_distinct() {
    let creator = address("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
    let mint = mint_pda(&creator, 7);
    let coin = coin_pda(&mint);
    let owner = address("3h1zGmCwsRJnVk5BuRNMLsPaQu1y2aqXqXDWYCgrp5UG");

    let mut seen: Vec<(&str, Address)> = vec![
        ("protocol", protocol_pda()),
        ("treasury", treasury_pda()),
        ("crank_pool", crank_pool_pda()),
        ("curve_table", curve_table_pda()),
        ("mint", mint),
        ("coin", coin),
        ("vault", vault_pda(&mint)),
        ("pool", pool_pda(&mint)),
        ("pool_vault", pool_vault_pda(&mint)),
        ("pool_sol", pool_sol_pda(&mint)),
        ("player", player_pda(&owner)),
        ("position", position_pda(&coin, &owner)),
        ("opportunity", opportunity_pda(&coin, &owner, 3)),
        ("global_budget", global_budget_pda(19_000)),
        ("sponsor_vault", sponsor_vault_pda(&owner)),
        (
            "sponsor_event",
            sponsor_event_pda(&sponsor_vault_pda(&owner), 0),
        ),
        (
            "sponsor_grant",
            sponsor_grant_pda(&sponsor_event_pda(&sponsor_vault_pda(&owner), 0), &coin),
        ),
        (
            "referral_credit",
            referral_credit_pda(&owner, &creator),
        ),
        ("referral_week", referral_week_pda(&owner)),
    ];
    seen.sort_by_key(|(_, address)| *address);
    for pair in seen.windows(2) {
        assert_ne!(
            pair[0].1, pair[1].1,
            "{} and {} derive to the same address",
            pair[0].0, pair[1].0
        );
    }

    // The opportunity is unique per window, which is what makes a reroll impossible by
    // construction rather than by a guarded update (design 4.2).
    assert_ne!(
        opportunity_pda(&coin, &owner, 1),
        opportunity_pda(&coin, &owner, 2)
    );
    // The mint is unique per nonce, so a creator can launch many coins.
    assert_ne!(mint_pda(&creator, 0), mint_pda(&creator, 1));
    // The position is unique per (coin, owner).
    assert_ne!(position_pda(&coin, &owner), position_pda(&coin, &creator));
}

/// Anchor's discriminators are the instruction surface. A rename is a contract amendment, and
/// this pins the eight bytes a client would send for each of the 39 callable v2 instructions.
#[test]
fn instruction_discriminators_are_the_frozen_names() {
    let names = [
        "initialize_protocol",
        "update_fee_config",
        "update_discovery_limits",
        "set_rarity_table",
        "set_curve_table",
        "schedule_pause",
        "unpause",
        "launch_token",
        "buy",
        "sell",
        "pool_buy",
        "pool_sell",
        "graduate_market",
        "sweep_fees",
        "claim_creator_fees",
        "crank_tip",
        "init_sponsor_vault",
        "fund_sponsor_vault",
        "withdraw_sponsor_vault",
        "create_sponsor_event",
        "close_sponsor_event",
        "initialize_player",
        "activate",
        "collect_ore",
        "upgrade_crew",
        "assign_power",
        "remove_power",
        "switch_mine",
        "claim_rewards",
        "request_unbond",
        "withdraw_bond",
        "advance_mine",
        "commit_epoch_seed",
        "create_discovery_roll",
        "settle_discovery",
        "expire_opportunity",
        "credit_referral_ore",
    ];
    let mut seen: Vec<[u8; 8]> = names.iter().map(|name| discriminator(name)).collect();
    seen.sort_unstable();
    let before = seen.len();
    seen.dedup();
    assert_eq!(before, seen.len(), "two instruction names share a discriminator");
    // The discriminator really is sha256("global:<name>")[..8] and not a table someone typed.
    // The four values below were computed independently of this suite (node's crypto) and are
    // what a client that hard-codes them would send.
    assert_eq!(
        discriminator("initialize_protocol"),
        [188, 233, 252, 106, 134, 146, 202, 91]
    );
    assert_eq!(
        discriminator("launch_token"),
        [10, 128, 86, 171, 3, 137, 161, 244]
    );
    assert_eq!(
        discriminator("assign_power"),
        [91, 85, 179, 221, 48, 238, 125, 89]
    );
    assert_eq!(
        discriminator("settle_discovery"),
        [202, 88, 119, 119, 175, 49, 63, 61]
    );
}

/// The bond is retired, and its constants and its error code are frozen all the same: the
/// account layouts, the numbers the parity vectors publish and the code every client already
/// matches on cannot move just because the feature did. The starter cap stays live for a
/// position armed before the retirement, and the starter efficiency stays as the value the
/// frozen config field carries.
#[test]
fn the_retired_bond_and_the_starter_tranche_keep_their_published_values() {
    assert_eq!(diggo_protocol::BOND_LAMPORTS, 70_000_000, "0.07 SOL");
    assert_eq!(diggo_protocol::BOND_COOLDOWN_SECONDS, 604_800, "seven days");
    assert_eq!(
        diggo_protocol::STARTER_EFFICIENCY_BPS,
        2_500,
        "25% of the same power"
    );
    assert_eq!(
        diggo_protocol::STARTER_TRANCHE_BPS,
        1_000,
        "at most 10% of a block"
    );
    assert_eq!(diggo_protocol::EPOCH_SEED_DELAY_SLOTS, 32);
    assert_eq!(diggo_protocol::EPOCH_SEED_MAX_LATENESS_SLOTS, 512);
    assert_eq!(diggo_protocol::SLOT_HASHES_WINDOW, 512);
    assert_eq!(diggo_protocol::CRANK_TIP_BPS, 200);
    assert_eq!(diggo_protocol::MAX_PAUSE_SECONDS, 259_200, "72 hours");
    assert_eq!(diggo_protocol::MAX_RARITY_TIERS, 8);
    assert_eq!(diggo_protocol::CREW_COMPONENTS, 5);
    assert_eq!(diggo_protocol::MAX_CREW_LEVEL, 100);
    assert_eq!(diggo_protocol::MIN_CURVE_MINING_BLOCKS, 48);
    assert_eq!(
        diggo_protocol::DEFAULT_DISCOVERY_DAILY_CAP_LAMPORTS,
        1_000_000_000
    );
    assert_eq!(
        diggo_protocol::DEFAULT_DISCOVERY_WEEKLY_CAP_LAMPORTS,
        4_000_000_000
    );
    assert_eq!(
        diggo_protocol::DEFAULT_DISCOVERY_GLOBAL_DAILY_CAP_LAMPORTS,
        50_000_000_000
    );
    assert_eq!(
        diggo_protocol::DEFAULT_DISCOVERY_EPOCH_BUDGET_LAMPORTS,
        2_000_000_000
    );
    assert_eq!(
        diggo_protocol::DEFAULT_SPONSOR_PER_WALLET_LIMIT_LAMPORTS,
        diggo_protocol::BOND_LAMPORTS
    );
    // The retirement is appended after every existing variant, so no code a client matches on
    // moved: the code that used to be last is still last but one, and BondRetired takes 6097.
    assert_eq!(
        u32::from(diggo_protocol::DiggoError::UnclaimedRewards),
        6_096
    );
    assert_eq!(u32::from(diggo_protocol::DiggoError::BondRetired), 6_097);
    assert_eq!(
        u32::from(diggo_protocol::DiggoError::ReferralAmountOutOfRange),
        6_098
    );
    assert_eq!(
        u32::from(diggo_protocol::DiggoError::ReferralWeeklyCapExceeded),
        6_099
    );
    assert_eq!(
        u32::from(diggo_protocol::DiggoError::ReferralRefereeMismatch),
        6_100
    );
    assert_eq!(diggo_protocol::MAX_REFERRAL_ORE_PER_CREDIT, 250);
    assert_eq!(diggo_protocol::MAX_REFERRAL_ORE_CREDITS_PER_WEEK, 25);
}

#[test]
fn referral_marker_and_week_counter_rent_is_exact() {
    let env = Env::new();
    assert_eq!(env.svm.minimum_balance_for_rent_exemption(ReferralCredit::SIZE), 1_009_200);
    assert_eq!(env.svm.minimum_balance_for_rent_exemption(ReferralWeek::SIZE), 1_016_160);
}

/// With the program loaded and no protocol initialized, an admin update must reach the program
/// and fail its protocol account constraint. This proves LiteSVM executed the .so rather than
/// rejecting the transaction at the loader.
#[test]
fn the_loaded_program_answers_an_instruction() {
    let mut env = Env::new();
    let authority = env.payer_address();
    let ix = update_fee_config_ix(authority, 100, 100, 100);
    let result = env.send(&[ix], &[]);
    let code = error_code(&result);
    assert!(
        code.is_some(),
        "expected a program error from an uninitialized protocol, got {:?}",
        result.err().map(|failed| failed.err)
    );
    assert!(
        code != Some(NOT_IMPLEMENTED),
        "initialize_protocol is implemented now; the skeleton's NotImplemented must be gone"
    );
}

/// The launch, run by the real program against the real Token-2022 program, and the mint's
/// bytes read back the way a wallet reads them.
///
/// This is the regression the launch bug needed. Token-2022 8.0.1 reads the account-type byte at
/// `Account::LEN` (165) for mints and token accounts alike, so a mint's own 82 bytes are followed
/// by 83 zero bytes of padding and the extension TLV data starts at 166. A mint created at
/// 82 + 1 + 68 = 151 bytes fails MetadataPointerInstruction::Initialize with InvalidAccountData
/// before the mint exists at all, which is what blocked every flow. 234 is the size that works,
/// and 438 is where a maximal-metadata mint settles.
#[test]
fn a_launch_creates_the_mint_token_2022_accepts_with_its_metadata_pointer() {
    let mut env = Env::new();
    let authority = env.payer_address();
    let result = env.send(
        &[initialize_protocol_ix(authority, &default_protocol_args(), authority)],
        &[],
    );
    assert_eq!(
        error_code(&result),
        None,
        "initialize_protocol: {:?}",
        result.err().map(|failed| failed.err)
    );

    let creator = env.wallet(5 * LAMPORTS_PER_SOL);
    let creator_address = creator.pubkey();
    let accounts = LaunchAccounts::new(creator_address, 4);
    let args = default_launch_args(4);
    let before = env.lamports(&creator_address);
    let result = env.send(&[launch_token_ix(&accounts, &args)], &[&creator]);
    assert_eq!(
        error_code(&result),
        None,
        "launch_token: {:?}",
        result.err().map(|failed| failed.err)
    );

    let mint = env.account(&accounts.mint).expect("the mint exists");
    assert_eq!(mint.owner, token_program(), "the mint belongs to Token-2022");

    // The base region: 82 bytes of mint state, then the 83 padding bytes that separate it from
    // the account-type byte, then the byte itself.
    assert_eq!(
        u32::from_le_bytes(mint.data[0..4].try_into().unwrap()),
        0,
        "the mint authority is revoked: the supply is fixed"
    );
    assert_eq!(
        u64::from_le_bytes(mint.data[36..44].try_into().unwrap()),
        args.total_supply,
        "the whole supply is minted into the vault"
    );
    assert_eq!(mint.data[44], args.decimals);
    assert_eq!(mint.data[45], 1, "the mint is initialized");
    assert_eq!(
        u32::from_le_bytes(mint.data[46..50].try_into().unwrap()),
        0,
        "no freeze authority was ever set"
    );
    assert!(
        mint.data[82..165].iter().all(|byte| *byte == 0),
        "the padding token-2022 requires is zero"
    );
    assert_eq!(mint.data[165], 1, "AccountType::Mint sits at Account::LEN");

    // The metadata pointer is the mint's first extension, and it names the mint itself, so the
    // name, symbol and uri live in the mint and no second account can spoof them.
    assert_eq!(
        u16::from_le_bytes(mint.data[166..168].try_into().unwrap()),
        18,
        "ExtensionType::MetadataPointer"
    );
    assert_eq!(
        u16::from_le_bytes(mint.data[168..170].try_into().unwrap()),
        64,
        "the pointer's 32-byte authority and 32-byte address"
    );
    assert_eq!(
        &mint.data[170..202],
        accounts.coin.as_ref(),
        "the Coin PDA may point the metadata elsewhere"
    );
    assert_eq!(
        &mint.data[202..234],
        accounts.mint.as_ref(),
        "the pointer names the mint: the metadata is self-hosted"
    );

    // Then the metadata itself, at the size its own caps imply: the TLV header, the update
    // authority, the mint, the three length-prefixed strings and the empty additional-metadata
    // vector. The mint settles here, which is smaller than the 438 the creator funded.
    let settled = diggo_protocol::MINT_BASE_SIZE
        + diggo_protocol::MINT_ACCOUNT_TYPE_SIZE
        + diggo_protocol::MINT_METADATA_POINTER_SIZE
        + diggo_protocol::MINT_TLV_HEADER_SIZE
        + 32
        + 32
        + (4 + args.name.len())
        + (4 + args.symbol.len())
        + (4 + args.uri.len())
        + 4;
    assert_eq!(
        mint.data.len(),
        settled,
        "the mint settles at exactly its metadata's size"
    );
    assert!(mint.data.len() <= 438, "and never past the funded layout");
    assert_eq!(
        u16::from_le_bytes(mint.data[234..236].try_into().unwrap()),
        19,
        "ExtensionType::TokenMetadata"
    );
    assert_eq!(
        u16::from_le_bytes(mint.data[236..238].try_into().unwrap()) as usize,
        80 + args.name.len() + args.symbol.len() + args.uri.len(),
        "the metadata's value length"
    );
    assert_eq!(
        &mint.data[238..270],
        creator_address.as_ref(),
        "the creator updates the metadata"
    );
    assert_eq!(
        &mint.data[270..302],
        accounts.mint.as_ref(),
        "the metadata names its mint, which is what stops a spoof"
    );
    let mut at = 302;
    for field in [&args.name, &args.symbol, &args.uri] {
        assert_eq!(
            u32::from_le_bytes(mint.data[at..at + 4].try_into().unwrap()) as usize,
            field.len(),
            "the length prefix of {field}"
        );
        at += 4;
        assert_eq!(&mint.data[at..at + field.len()], field.as_bytes(), "{field}");
        at += field.len();
    }
    assert_eq!(
        u32::from_le_bytes(mint.data[at..at + 4].try_into().unwrap()),
        0,
        "no additional metadata"
    );

    // The vault holds the whole supply and the creator paid exactly the three rents: the mint is
    // funded for the maximal 438-byte layout whatever its metadata settles at, because the caps
    // are what bound the cost.
    assert_eq!(env.token_amount(&accounts.vault), args.total_supply);
    let rent = |size: usize| ((size + 128) as u64) * 6_960;
    assert_eq!(
        before - env.lamports(&creator_address),
        rent(438) + rent(Coin::SIZE) + rent(165),
        "a paid launch costs the mint, the Coin and the vault"
    );
}

/// The gate the orchestrator can run once A, B and C have landed:
/// cargo test -p diggo-protocol --test contract -- --ignored
#[test]
#[ignore = "the Phase 1 gate: fails until every v2 handler is implemented"]
fn no_v2_handler_is_still_a_skeleton() {
    let mut env = Env::new();
    let authority = env.payer_address();
    let config = default_protocol_args();
    let ix = initialize_protocol_ix(authority, &config, authority);
    let result = env.send(&[ix], &[]);
    assert_eq!(
        error_code(&result),
        None,
        "initialize_protocol is still NotImplemented: WS-B has not landed"
    );
}
