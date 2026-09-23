#![allow(dead_code)]
//! WS-G integration harness: drives the built program through LiteSVM.
//!
//! Everything here is written against programs/diggo-protocol/CONTRACTS.md, which is frozen: the
//! instruction names, argument order, account order and mutability below are read straight out of
//! the #[derive(Accounts)] structs, and the discriminators are Anchor's own
//! sha256("global:<name>")[..8]. No test in this crate reads a program source file, and no test
//! builds an instruction through a client library, so a change to either is caught here rather
//! than followed.
//!
//! Two conventions make the suite useful while WS-A/B/C are still landing:
//!
//! 1. DiggoError::NotImplemented (6048) is reported as PENDING, not as a failure. A flow that
//!    reaches that error has already proved its account list, its seeds and its argument encoding
//!    against the real program - Anchor validates every constraint before the handler body runs -
//!    so the plumbing is verified the moment the skeleton answers.
//! 2. Anything else that is not the expected outcome is a real failure, printed with the
//!    program's own logs.
//!
//! Run with --nocapture to see the per-test PASS/PENDING report:
//! cargo test -p diggo-protocol --test flows -- --nocapture --test-threads=1

use anchor_lang::prelude::Pubkey;
use anchor_lang::{AccountDeserialize, AnchorSerialize};
use litesvm::types::{FailedTransactionMetadata, TransactionMetadata, TransactionResult};
use litesvm::LiteSVM;
use sha2::{Digest, Sha256};
use solana_account::Account;
use solana_address::Address;
use solana_clock::Clock;
use solana_hash::Hash;
use solana_instruction::{AccountMeta, Instruction};
use solana_instruction_error::InstructionError;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_slot_hashes::SlotHashes;
use solana_transaction::Transaction;
use solana_transaction_error::TransactionError;
use std::path::{Path, PathBuf};
use std::str::FromStr;

// The program's own constants and layouts are imported rather than restated: a test that
// redefines 70_000_000 can pass while the program charges something else.
use diggo_protocol::{
    Coin, DiscoveryOpportunity, GlobalBudget, LaunchTokenArgs, LiquidityPool, MiningPosition,
    PlayerAccount, ProtocolConfig, ProtocolConfigArgs, RarityTier, ReferralCredit, ReferralWeek,
    SponsorEvent, SponsorGrant, SponsorVault, BOND_COOLDOWN_SECONDS, BOND_LAMPORTS,
};

pub const PROGRAM_ID_STR: &str = "H3Y8GgTnvwv5U1bajfzj386YSPC48vvwjFroXYyHZFj5";
/// The program's own mint is a hand-written Token-2022 mint, so every token account here is a
/// Token-2022 account.
pub const TOKEN_2022_STR: &str = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
pub const SYSTEM_PROGRAM_STR: &str = "11111111111111111111111111111111";
pub const ATA_PROGRAM_STR: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
pub const SYSVAR_ID_STR: &str =
    "SysvarS1otHashes111111111111111111111111111";

/// DiggoError::NotImplemented, the one answer the frozen spine gives today.
pub const NOT_IMPLEMENTED: u32 = 6048;
pub const LAMPORTS_PER_SOL: u64 = 1_000_000_000;
pub const DAY: i64 = 86_400;

// ---- seeds (src/seeds.rs, frozen) ---------------------------------------------------------

pub const PROTOCOL_SEED: &[u8] = b"protocol";
pub const TREASURY_SEED: &[u8] = b"treasury";
pub const CRANK_POOL_SEED: &[u8] = b"crank-pool";
pub const CURVE_TABLE_SEED: &[u8] = b"curve-table";
pub const COIN_SEED: &[u8] = b"coin";
pub const VAULT_SEED: &[u8] = b"vault";
pub const PLAYER_SEED: &[u8] = b"player";
pub const POSITION_SEED: &[u8] = b"position";
pub const OPPORTUNITY_SEED: &[u8] = b"opportunity";
pub const GLOBAL_BUDGET_SEED: &[u8] = b"global-budget";
pub const SPONSOR_VAULT_SEED: &[u8] = b"sponsor-vault";
pub const SPONSOR_EVENT_SEED: &[u8] = b"sponsor-event";
pub const SPONSOR_GRANT_SEED: &[u8] = b"sponsor-grant";
pub const MINT_SEED: &[u8] = b"mint";
pub const POOL_SEED: &[u8] = b"pool";
pub const POOL_VAULT_SEED: &[u8] = b"pool-vault";
pub const POOL_SOL_SEED: &[u8] = b"pool-sol";
pub const REFERRAL_CREDIT_SEED: &[u8] = b"referral";
pub const REFERRAL_WEEK_SEED: &[u8] = b"referral_week";

pub fn address(text: &str) -> Address {
    Address::from_str(text).expect("base58 address")
}

pub fn program_id() -> Address {
    address(PROGRAM_ID_STR)
}

pub fn token_program() -> Address {
    address(TOKEN_2022_STR)
}

pub fn system_program() -> Address {
    address(SYSTEM_PROGRAM_STR)
}

pub fn ata_program() -> Address {
    address(ATA_PROGRAM_STR)
}

pub fn sysvar_id() -> Address {
    address(SYSVAR_ID_STR)
}

/// The program's own id is what Anchor reads as "this optional account is absent".
pub fn omitted() -> Address {
    program_id()
}

pub fn pda(seeds: &[&[u8]]) -> Address {
    Address::find_program_address(seeds, &program_id()).0
}

pub fn pda_with_bump(seeds: &[&[u8]]) -> (Address, u8) {
    Address::find_program_address(seeds, &program_id())
}

/// The upgradeable loader, which owns both the program account and its ProgramData.
pub fn upgradeable_loader() -> Address {
    address("BPFLoaderUpgradeab1e11111111111111111111111")
}

/// The program's ProgramData account. initialize_protocol proves the caller against the upgrade
/// authority recorded here, so the harness has to own that authority before it can seed anything.
pub fn program_data_pda() -> Address {
    Address::find_program_address(&[program_id().as_ref()], &upgradeable_loader()).0
}

pub fn protocol_pda() -> Address {
    pda(&[PROTOCOL_SEED])
}

pub fn treasury_pda() -> Address {
    pda(&[TREASURY_SEED])
}

pub fn crank_pool_pda() -> Address {
    pda(&[CRANK_POOL_SEED])
}

pub fn curve_table_pda() -> Address {
    pda(&[CURVE_TABLE_SEED])
}

pub fn mint_pda(creator: &Address, nonce: u8) -> Address {
    pda(&[MINT_SEED, creator.as_ref(), &[nonce]])
}

pub fn coin_pda(mint: &Address) -> Address {
    pda(&[COIN_SEED, mint.as_ref()])
}

pub fn vault_pda(mint: &Address) -> Address {
    pda(&[VAULT_SEED, mint.as_ref()])
}

pub fn pool_pda(mint: &Address) -> Address {
    pda(&[POOL_SEED, mint.as_ref()])
}

pub fn pool_vault_pda(mint: &Address) -> Address {
    pda(&[POOL_VAULT_SEED, mint.as_ref()])
}

pub fn pool_sol_pda(mint: &Address) -> Address {
    pda(&[POOL_SOL_SEED, mint.as_ref()])
}

pub fn player_pda(owner: &Address) -> Address {
    pda(&[PLAYER_SEED, owner.as_ref()])
}

pub fn position_pda(coin: &Address, owner: &Address) -> Address {
    pda(&[POSITION_SEED, coin.as_ref(), owner.as_ref()])
}

pub fn opportunity_pda(coin: &Address, owner: &Address, window_index: u16) -> Address {
    pda(&[
        OPPORTUNITY_SEED,
        coin.as_ref(),
        owner.as_ref(),
        &window_index.to_le_bytes(),
    ])
}

pub fn global_budget_pda(day_index: u16) -> Address {
    pda(&[GLOBAL_BUDGET_SEED, &day_index.to_le_bytes()])
}

pub fn sponsor_vault_pda(sponsor_owner: &Address) -> Address {
    pda(&[SPONSOR_VAULT_SEED, sponsor_owner.as_ref()])
}

pub fn sponsor_event_pda(vault: &Address, event_id: u32) -> Address {
    pda(&[
        SPONSOR_EVENT_SEED,
        vault.as_ref(),
        &event_id.to_le_bytes(),
    ])
}

pub fn sponsor_grant_pda(event: &Address, subject: &Address) -> Address {
    pda(&[SPONSOR_GRANT_SEED, event.as_ref(), subject.as_ref()])
}

pub fn referral_credit_pda(referrer: &Address, referee: &Address) -> Address {
    pda(&[REFERRAL_CREDIT_SEED, referrer.as_ref(), referee.as_ref()])
}

pub fn referral_week_pda(referrer: &Address) -> Address {
    pda(&[REFERRAL_WEEK_SEED, referrer.as_ref()])
}

/// The associated token account of an owner for a mint under the program's token program.
pub fn associated_token(owner: &Address, mint: &Address) -> Address {
    pda(&[owner.as_ref(), token_program().as_ref(), mint.as_ref()])
}

// ---- instruction encoding -----------------------------------------------------------------

/// Anchor's discriminator: the first eight bytes of sha256("global:<snake_case_name>").
pub fn discriminator(name: &str) -> [u8; 8] {
    let mut hasher = Sha256::new();
    hasher.update(format!("global:{name}").as_bytes());
    let digest = hasher.finalize();
    let mut out = [0u8; 8];
    out.copy_from_slice(&digest[..8]);
    out
}

pub fn args_data<T: AnchorSerialize>(name: &str, args: &T) -> Vec<u8> {
    let mut data = discriminator(name).to_vec();
    data.extend(borsh::to_vec(args).expect("borsh args"));
    data
}

pub fn no_args_data(name: &str) -> Vec<u8> {
    discriminator(name).to_vec()
}

fn ro(key: Address) -> AccountMeta {
    AccountMeta::new_readonly(key, false)
}

fn rw(key: Address) -> AccountMeta {
    AccountMeta::new(key, false)
}

fn rw_signer(key: Address) -> AccountMeta {
    AccountMeta::new(key, true)
}

fn ix(program: Address, data: Vec<u8>, accounts: Vec<AccountMeta>) -> Instruction {
    Instruction::new_with_bytes(program, &data, accounts)
}

// ---- one builder per instruction -----------------------------------------------------------

/// The account list of InitializeProtocol, in the struct's own order.
///
/// The program and its ProgramData are what the handler proves the authority with, and the
/// builder was written against the spine's shorter list: without them every flow stopped at
/// initialize_protocol with AccountNotEnoughKeys. The list is positional, so the order here is
/// the contract.
pub fn initialize_protocol_ix(
    authority: Address,
    config: &ProtocolConfigArgs,
    crank_pool: Address,
) -> Instruction {
    ix(
        program_id(),
        args_data("initialize_protocol", config),
        vec![
            rw_signer(authority),
            rw(protocol_pda()),
            ro(treasury_pda()),
            ro(crank_pool),
            ro(program_id()),
            ro(program_data_pda()),
            ro(system_program()),
        ],
    )
}

pub fn update_fee_config_ix(
    authority: Address,
    creator_fee_bps: u16,
    platform_fee_bps: u16,
    crank_pool_fee_bps: u16,
) -> Instruction {
    #[derive(AnchorSerialize)]
    struct Args {
        creator_fee_bps: u16,
        platform_fee_bps: u16,
        crank_pool_fee_bps: u16,
    }
    ix(
        program_id(),
        args_data(
            "update_fee_config",
            &Args {
                creator_fee_bps,
                platform_fee_bps,
                crank_pool_fee_bps,
            },
        ),
        vec![rw_signer(authority), rw(protocol_pda())],
    )
}

pub fn update_discovery_limits_ix(
    authority: Address,
    discovery_max_bps: u16,
    discovery_epoch_budget_bps: u16,
    daily_cap_lamports: u64,
    weekly_cap_lamports: u64,
    global_daily_cap_lamports: u64,
    epoch_budget_lamports: u64,
) -> Instruction {
    #[derive(AnchorSerialize)]
    struct Args {
        discovery_max_bps: u16,
        discovery_epoch_budget_bps: u16,
        daily_cap_lamports: u64,
        weekly_cap_lamports: u64,
        global_daily_cap_lamports: u64,
        epoch_budget_lamports: u64,
    }
    ix(
        program_id(),
        args_data(
            "update_discovery_limits",
            &Args {
                discovery_max_bps,
                discovery_epoch_budget_bps,
                daily_cap_lamports,
                weekly_cap_lamports,
                global_daily_cap_lamports,
                epoch_budget_lamports,
            },
        ),
        vec![rw_signer(authority), rw(protocol_pda())],
    )
}

pub fn set_rarity_table_ix(authority: Address, tiers: &[RarityTier]) -> Instruction {
    #[derive(AnchorSerialize)]
    struct Args {
        tiers: Vec<RarityTier>,
    }
    ix(
        program_id(),
        args_data(
            "set_rarity_table",
            &Args {
                tiers: tiers.to_vec(),
            },
        ),
        vec![rw_signer(authority), rw(protocol_pda())],
    )
}

pub fn set_curve_table_ix(
    authority: Address,
    power: &[u32],
    upgrade_ore_cost: &[Vec<u32>],
) -> Instruction {
    #[derive(AnchorSerialize)]
    struct Args {
        power: Vec<u32>,
        upgrade_ore_cost: Vec<Vec<u32>>,
    }
    ix(
        program_id(),
        args_data(
            "set_curve_table",
            &Args {
                power: power.to_vec(),
                upgrade_ore_cost: upgrade_ore_cost.to_vec(),
            },
        ),
        vec![
            rw_signer(authority),
            ro(protocol_pda()),
            rw(curve_table_pda()),
            ro(system_program()),
        ],
    )
}

pub fn schedule_pause_ix(authority: Address, flag: u8, paused_until: i64) -> Instruction {
    #[derive(AnchorSerialize)]
    struct Args {
        flag: u8,
        paused_until: i64,
    }
    ix(
        program_id(),
        args_data(
            "schedule_pause",
            &Args {
                flag,
                paused_until,
            },
        ),
        vec![rw_signer(authority), rw(protocol_pda())],
    )
}

/// CONTRACTS.md lists unpause as "anyone", but the frozen AdminConfig accounts struct carries
/// has_one = authority, so the authority has to sign it. Filed as a contract change request; this
/// builder follows the struct that is actually frozen.
pub fn unpause_ix(authority: Address, flag: u8) -> Instruction {
    #[derive(AnchorSerialize)]
    struct Args {
        flag: u8,
    }
    ix(
        program_id(),
        args_data("unpause", &Args { flag }),
        vec![rw_signer(authority), rw(protocol_pda())],
    )
}

pub struct LaunchAccounts {
    pub creator: Address,
    pub nonce: u8,
    pub mint: Address,
    pub coin: Address,
    pub vault: Address,
    /// (vault, event, grant) on a LaunchRentSubsidy path, None otherwise.
    pub sponsor: Option<(Address, Address, Address)>,
}

impl LaunchAccounts {
    pub fn new(creator: Address, nonce: u8) -> Self {
        let mint = mint_pda(&creator, nonce);
        Self {
            creator,
            nonce,
            mint,
            coin: coin_pda(&mint),
            vault: vault_pda(&mint),
            sponsor: None,
        }
    }

    pub fn with_sponsor(mut self, vault: Address, event: Address, grant: Address) -> Self {
        self.sponsor = Some((vault, event, grant));
        self
    }
}

pub fn launch_token_ix(accounts: &LaunchAccounts, args: &LaunchTokenArgs) -> Instruction {
    let (sponsor_vault, sponsor_event, sponsor_grant) = match accounts.sponsor {
        Some((vault, event, grant)) => (rw(vault), rw(event), rw(grant)),
        None => (ro(omitted()), ro(omitted()), ro(omitted())),
    };
    ix(
        program_id(),
        args_data("launch_token", args),
        vec![
            rw_signer(accounts.creator),
            rw(accounts.mint),
            rw(accounts.coin),
            rw(accounts.vault),
            ro(protocol_pda()),
            sponsor_vault,
            sponsor_event,
            sponsor_grant,
            ro(token_program()),
            ro(system_program()),
        ],
    )
}

fn curve_trade_ix(
    name: &str,
    trader: Address,
    mint: Address,
    trader_tokens: Address,
    amount_in: u64,
    min_out: u64,
) -> Instruction {
    #[derive(AnchorSerialize)]
    struct Args {
        amount_in: u64,
        min_out: u64,
    }
    ix(
        program_id(),
        args_data(
            name,
            &Args {
                amount_in,
                min_out,
            },
        ),
        vec![
            rw_signer(trader),
            ro(mint),
            rw(coin_pda(&mint)),
            rw(vault_pda(&mint)),
            rw(trader_tokens),
            ro(protocol_pda()),
            // Buy and Sell both carry the sponsor trio as Option accounts between the protocol
            // and the token program. An unsponsored trade passes None in all three - the
            // program's own id as the account key - and cannot simply drop them, because the
            // trailing programs are positional too.
            ro(omitted()),
            ro(omitted()),
            ro(omitted()),
            ro(token_program()),
            ro(system_program()),
        ],
    )
}

pub fn buy_ix(
    trader: Address,
    mint: Address,
    trader_tokens: Address,
    sol_in: u64,
    min_tokens_out: u64,
) -> Instruction {
    curve_trade_ix("buy", trader, mint, trader_tokens, sol_in, min_tokens_out)
}

pub fn sell_ix(
    trader: Address,
    mint: Address,
    trader_tokens: Address,
    tokens_in: u64,
    min_sol_out: u64,
) -> Instruction {
    curve_trade_ix("sell", trader, mint, trader_tokens, tokens_in, min_sol_out)
}

pub fn graduate_market_ix(payer: Address, mint: Address) -> Instruction {
    ix(
        program_id(),
        no_args_data("graduate_market"),
        vec![
            rw_signer(payer),
            ro(mint),
            rw(coin_pda(&mint)),
            rw(vault_pda(&mint)),
            rw(pool_pda(&mint)),
            rw(pool_vault_pda(&mint)),
            rw(pool_sol_pda(&mint)),
            ro(protocol_pda()),
            ro(token_program()),
            ro(system_program()),
        ],
    )
}

fn pool_trade_ix(
    name: &str,
    trader: Address,
    mint: Address,
    trader_tokens: Address,
    amount_in: u64,
    min_out: u64,
) -> Instruction {
    #[derive(AnchorSerialize)]
    struct Args {
        amount_in: u64,
        min_out: u64,
    }
    ix(
        program_id(),
        args_data(
            name,
            &Args {
                amount_in,
                min_out,
            },
        ),
        vec![
            rw_signer(trader),
            ro(mint),
            rw(coin_pda(&mint)),
            rw(pool_pda(&mint)),
            rw(pool_vault_pda(&mint)),
            rw(pool_sol_pda(&mint)),
            rw(trader_tokens),
            ro(protocol_pda()),
            // PoolBuy and PoolSell declare the sponsor trio exactly as Buy and Sell do, between
            // the protocol and the token program, so an unsponsored pool trade passes the
            // program's own id three times rather than dropping the slots.
            ro(omitted()),
            ro(omitted()),
            ro(omitted()),
            ro(token_program()),
            ro(system_program()),
        ],
    )
}

pub fn pool_buy_ix(
    trader: Address,
    mint: Address,
    trader_tokens: Address,
    sol_in: u64,
    min_tokens_out: u64,
) -> Instruction {
    pool_trade_ix("pool_buy", trader, mint, trader_tokens, sol_in, min_tokens_out)
}

pub fn pool_sell_ix(
    trader: Address,
    mint: Address,
    trader_tokens: Address,
    tokens_in: u64,
    min_sol_out: u64,
) -> Instruction {
    pool_trade_ix(
        "pool_sell",
        trader,
        mint,
        trader_tokens,
        tokens_in,
        min_sol_out,
    )
}

pub fn sweep_fees_ix(payer: Address, mint: Address, creator: Address) -> Instruction {
    ix(
        program_id(),
        no_args_data("sweep_fees"),
        vec![
            rw_signer(payer),
            ro(mint),
            rw(coin_pda(&mint)),
            ro(protocol_pda()),
            rw(treasury_pda()),
            rw(crank_pool_pda()),
            rw(creator),
            ro(system_program()),
        ],
    )
}

pub fn claim_creator_fees_ix(creator: Address, mint: Address) -> Instruction {
    ix(
        program_id(),
        no_args_data("claim_creator_fees"),
        vec![
            rw_signer(creator),
            ro(mint),
            rw(coin_pda(&mint)),
            ro(system_program()),
        ],
    )
}

pub fn crank_tip_ix(payer: Address, mint: Address, max_tip: u64) -> Instruction {
    #[derive(AnchorSerialize)]
    struct Args {
        max_tip: u64,
    }
    ix(
        program_id(),
        args_data("crank_tip", &Args { max_tip }),
        vec![
            rw_signer(payer),
            ro(mint),
            rw(coin_pda(&mint)),
            ro(protocol_pda()),
            ro(system_program()),
        ],
    )
}

pub fn init_sponsor_vault_ix(sponsor_owner: Address) -> Instruction {
    ix(
        program_id(),
        no_args_data("init_sponsor_vault"),
        vec![
            rw_signer(sponsor_owner),
            rw(sponsor_vault_pda(&sponsor_owner)),
            ro(system_program()),
        ],
    )
}

fn sponsor_amount_ix(name: &str, sponsor_owner: Address, amount: u64) -> Instruction {
    #[derive(AnchorSerialize)]
    struct Args {
        amount: u64,
    }
    ix(
        program_id(),
        args_data(name, &Args { amount }),
        vec![
            rw_signer(sponsor_owner),
            rw(sponsor_vault_pda(&sponsor_owner)),
            ro(system_program()),
        ],
    )
}

pub fn fund_sponsor_vault_ix(sponsor_owner: Address, amount: u64) -> Instruction {
    sponsor_amount_ix("fund_sponsor_vault", sponsor_owner, amount)
}

pub fn withdraw_sponsor_vault_ix(sponsor_owner: Address, amount: u64) -> Instruction {
    sponsor_amount_ix("withdraw_sponsor_vault", sponsor_owner, amount)
}

pub fn create_sponsor_event_ix(
    sponsor_owner: Address,
    event_id: u32,
    kind: u8,
    start_at: i64,
    end_at: i64,
    budget_lamports: u64,
    per_coin_limit_lamports: u64,
    per_wallet_limit_lamports: u64,
) -> Instruction {
    #[derive(AnchorSerialize)]
    struct Args {
        kind: u8,
        start_at: i64,
        end_at: i64,
        budget_lamports: u64,
        per_coin_limit_lamports: u64,
        per_wallet_limit_lamports: u64,
    }
    let vault = sponsor_vault_pda(&sponsor_owner);
    ix(
        program_id(),
        args_data(
            "create_sponsor_event",
            &Args {
                kind,
                start_at,
                end_at,
                budget_lamports,
                per_coin_limit_lamports,
                per_wallet_limit_lamports,
            },
        ),
        vec![
            rw_signer(sponsor_owner),
            rw(vault),
            rw(sponsor_event_pda(&vault, event_id)),
            ro(system_program()),
        ],
    )
}

pub fn close_sponsor_event_ix(sponsor_owner: Address, event_id: u32) -> Instruction {
    #[derive(AnchorSerialize)]
    struct Args {
        event_id: u32,
    }
    let vault = sponsor_vault_pda(&sponsor_owner);
    ix(
        program_id(),
        args_data("close_sponsor_event", &Args { event_id }),
        vec![
            rw_signer(sponsor_owner),
            ro(vault),
            rw(sponsor_event_pda(&vault, event_id)),
        ],
    )
}

pub fn initialize_player_ix(
    owner: Address,
    sponsor: Option<(Address, Address, Address)>,
) -> Instruction {
    let (sponsor_vault, sponsor_event, sponsor_grant) = match sponsor {
        Some((vault, event, grant)) => (rw(vault), ro(event), rw(grant)),
        None => (ro(omitted()), ro(omitted()), ro(omitted())),
    };
    ix(
        program_id(),
        no_args_data("initialize_player"),
        vec![
            rw_signer(owner),
            rw(player_pda(&owner)),
            rw(protocol_pda()),
            sponsor_vault,
            sponsor_event,
            sponsor_grant,
            ro(system_program()),
        ],
    )
}

pub fn activate_ix(owner: Address) -> Instruction {
    ix(
        program_id(),
        no_args_data("activate"),
        vec![
            rw_signer(owner),
            rw(player_pda(&owner)),
            // Activate's coin and position are Option accounts sitting between the player and
            // the protocol, so a player holding no position still has to name both slots: the
            // program's own id is what Anchor reads as None, and the list is positional, so
            // dropping them would shift the protocol into the coin slot.
            ro(omitted()),
            ro(omitted()),
            ro(protocol_pda()),
        ],
    )
}

/// Activate for a player that holds a position.
///
/// The armed coin and position are optional on chain because a player with no position has nothing
/// to settle, and the handler refuses to run without them when the player holds one: activation is
/// where a lapsed window is detected and forfeited, so a caller must not be able to skip the settle
/// and carry the accrual into the window it is about to open.
pub fn activate_with_position_ix(owner: Address, coin: Address, position: Address) -> Instruction {
    ix(
        program_id(),
        no_args_data("activate"),
        vec![
            rw_signer(owner),
            rw(player_pda(&owner)),
            rw(coin),
            rw(position),
            ro(protocol_pda()),
        ],
    )
}

pub fn collect_ore_ix(owner: Address) -> Instruction {
    ix(
        program_id(),
        no_args_data("collect_ore"),
        vec![rw_signer(owner), rw(player_pda(&owner)), ro(protocol_pda())],
    )
}

pub fn credit_referral_ore_ix(
    keeper: Address,
    referrer: Address,
    referee: Address,
    amount: u64,
) -> Instruction {
    #[derive(AnchorSerialize)]
    struct Args {
        referee: Pubkey,
        amount: u64,
    }
    ix(
        program_id(),
        args_data("credit_referral_ore", &Args { referee, amount }),
        vec![
            rw_signer(keeper),
            rw(player_pda(&referrer)),
            rw(referral_credit_pda(&referrer, &referee)),
            rw(referral_week_pda(&referrer)),
            ro(protocol_pda()),
            ro(referee),
            ro(referrer),
            ro(system_program()),
        ],
    )
}

pub fn upgrade_crew_ix(owner: Address, component: u8) -> Instruction {
    #[derive(AnchorSerialize)]
    struct Args {
        component: u8,
    }
    ix(
        program_id(),
        args_data("upgrade_crew", &Args { component }),
        vec![
            rw_signer(owner),
            rw(player_pda(&owner)),
            ro(protocol_pda()),
            ro(omitted()),
        ],
    )
}

pub fn assign_power_ix(owner: Address, mint: Address) -> Instruction {
    let coin = coin_pda(&mint);
    ix(
        program_id(),
        no_args_data("assign_power"),
        vec![
            rw_signer(owner),
            rw(player_pda(&owner)),
            ro(mint),
            rw(coin),
            rw(position_pda(&coin, &owner)),
            ro(protocol_pda()),
            ro(system_program()),
        ],
    )
}

pub fn remove_power_ix(owner: Address, mint: Address) -> Instruction {
    let coin = coin_pda(&mint);
    ix(
        program_id(),
        no_args_data("remove_power"),
        vec![
            rw_signer(owner),
            rw(player_pda(&owner)),
            ro(mint),
            rw(coin),
            rw(position_pda(&coin, &owner)),
            ro(system_program()),
        ],
    )
}

pub fn switch_mine_ix(owner: Address, from_mint: Address, to_mint: Address) -> Instruction {
    let from_coin = coin_pda(&from_mint);
    let to_coin = coin_pda(&to_mint);
    ix(
        program_id(),
        no_args_data("switch_mine"),
        vec![
            rw_signer(owner),
            rw(player_pda(&owner)),
            ro(from_mint),
            rw(from_coin),
            rw(position_pda(&from_coin, &owner)),
            ro(to_mint),
            rw(to_coin),
            rw(position_pda(&to_coin, &owner)),
            ro(system_program()),
        ],
    )
}

pub fn claim_rewards_ix(owner: Address, mint: Address) -> Instruction {
    let coin = coin_pda(&mint);
    ix(
        program_id(),
        no_args_data("claim_rewards"),
        vec![
            rw_signer(owner),
            rw(player_pda(&owner)),
            ro(mint),
            rw(coin),
            rw(vault_pda(&mint)),
            rw(associated_token(&owner, &mint)),
            rw(position_pda(&coin, &owner)),
            ro(protocol_pda()),
            ro(token_program()),
        ],
    )
}

pub fn request_unbond_ix(owner: Address) -> Instruction {
    ix(
        program_id(),
        no_args_data("request_unbond"),
        vec![rw_signer(owner), rw(player_pda(&owner)), ro(protocol_pda())],
    )
}

pub fn withdraw_bond_ix(owner: Address, sponsor_vault: Option<Address>) -> Instruction {
    ix(
        program_id(),
        no_args_data("withdraw_bond"),
        vec![
            rw_signer(owner),
            rw(player_pda(&owner)),
            ro(protocol_pda()),
            sponsor_vault.map(rw).unwrap_or_else(|| ro(omitted())),
            ro(system_program()),
        ],
    )
}

pub fn advance_mine_ix(payer: Address, mint: Address) -> Instruction {
    ix(
        program_id(),
        no_args_data("advance_mine"),
        vec![
            rw_signer(payer),
            ro(mint),
            rw(coin_pda(&mint)),
            ro(protocol_pda()),
        ],
    )
}

pub fn commit_epoch_seed_ix(payer: Address, mint: Address) -> Instruction {
    ix(
        program_id(),
        no_args_data("commit_epoch_seed"),
        vec![
            rw_signer(payer),
            ro(mint),
            rw(coin_pda(&mint)),
            ro(protocol_pda()),
            ro(sysvar_id()),
        ],
    )
}

pub fn create_discovery_roll_ix(
    owner: Address,
    mint: Address,
    roll_window: u16,
    day: u16,
) -> Instruction {
    let coin = coin_pda(&mint);
    ix(
        program_id(),
        no_args_data("create_discovery_roll"),
        vec![
            rw_signer(owner),
            rw(player_pda(&owner)),
            ro(mint),
            rw(coin),
            rw(opportunity_pda(&coin, &owner, roll_window)),
            rw(global_budget_pda(day)),
            ro(protocol_pda()),
            ro(system_program()),
        ],
    )
}

pub fn settle_discovery_ix(
    payer: Address,
    owner: Address,
    mint: Address,
    window_index: u16,
    global_budget: Option<u16>,
) -> Instruction {
    let coin = coin_pda(&mint);
    ix(
        program_id(),
        no_args_data("settle_discovery"),
        vec![
            rw_signer(payer),
            ro(owner),
            ro(mint),
            rw(coin),
            rw(vault_pda(&mint)),
            rw(associated_token(&owner, &mint)),
            rw(opportunity_pda(&coin, &owner, window_index)),
            global_budget
                .map(|day| rw(global_budget_pda(day)))
                .unwrap_or_else(|| ro(omitted())),
            ro(protocol_pda()),
            ro(token_program()),
            ro(system_program()),
        ],
    )
}

pub fn expire_opportunity_ix(
    payer: Address,
    owner: Address,
    mint: Address,
    window_index: u16,
) -> Instruction {
    let coin = coin_pda(&mint);
    ix(
        program_id(),
        no_args_data("expire_opportunity"),
        vec![
            rw_signer(payer),
            ro(owner),
            ro(mint),
            rw(coin),
            rw(opportunity_pda(&coin, &owner, window_index)),
            ro(system_program()),
        ],
    )
}

// ---- the environment ----------------------------------------------------------------------

pub struct Env {
    pub svm: LiteSVM,
    pub payer: Keypair,
    pub now: i64,
    pub slot: u64,
}

fn program_so_path() -> PathBuf {
    if let Ok(path) = std::env::var("DIGGO_PROGRAM_SO") {
        return PathBuf::from(path);
    }
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.pop();
    path.pop();
    path.push("target");
    path.push("deploy");
    path.push("diggo_protocol.so");
    path
}

impl Env {
    pub fn new() -> Self {
        let so = program_so_path();
        assert!(
            Path::new(&so).exists(),
            "no program at {}: run anchor build in the WS-G build dir (or set DIGGO_PROGRAM_SO)",
            so.display()
        );
        let mut svm = LiteSVM::new()
            .with_sysvars()
            .with_builtins()
            .with_default_programs()
            .with_sigverify(false)
            .with_blockhash_check(false);
        svm.add_program_from_file(program_id(), &so)
            .expect("load diggo_protocol.so");
        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 1_000 * LAMPORTS_PER_SOL)
            .expect("airdrop payer");
        // The harness has to own the program's upgrade authority before it can seed the protocol,
        // because initialize_protocol refuses a caller that is not that authority. LiteSVM loads an
        // upgradeable program with the authority unset, so it is stamped here: this is the contract's
        // deployment order - create the authority, hand it the program, then initialize - done in
        // the simulator rather than on a cluster.
        //
        // The ProgramData account is the loader's own state: a 4-byte enum tag, the 8-byte slot, the
        // Option tag and the 32-byte authority.
        let program_data = program_data_pda();
        let mut account = svm
            .get_account(&program_data)
            .expect("litesvm creates the programdata account with the program");
        const AUTHORITY_TAG_OFFSET: usize = 4 + 8;
        account.data[AUTHORITY_TAG_OFFSET] = 1;
        account.data[AUTHORITY_TAG_OFFSET + 1..AUTHORITY_TAG_OFFSET + 33]
            .copy_from_slice(payer.pubkey().as_ref());
        svm.set_account(program_data, account)
            .expect("stamp the upgrade authority");
        let mut env = Self {
            svm,
            payer,
            now: 1_767_225_600,
            slot: 100_000,
        };
        env.set_time(env.now, env.slot);
        env
    }

    pub fn payer_address(&self) -> Address {
        self.payer.pubkey()
    }

    /// A funded wallet that is not the fee payer.
    pub fn wallet(&mut self, lamports: u64) -> Keypair {
        let keypair = Keypair::new();
        self.svm
            .airdrop(&keypair.pubkey(), lamports)
            .expect("airdrop wallet");
        keypair
    }

    pub fn set_time(&mut self, unix_timestamp: i64, slot: u64) {
        self.now = unix_timestamp;
        self.slot = slot;
        let mut clock: Clock = self.svm.get_sysvar();
        clock.unix_timestamp = unix_timestamp;
        clock.slot = slot;
        clock.epoch = slot / 432_000;
        clock.epoch_start_timestamp = unix_timestamp;
        self.svm.set_sysvar(&clock);
    }

    /// Moves the clock forward, at the cluster's 400 ms slot time.
    pub fn advance(&mut self, seconds: i64) {
        let slots = (seconds.max(0) as u64) * 5 / 2;
        self.set_time(self.now + seconds, self.slot + slots.max(1));
    }

    pub fn set_slot_hashes(&mut self, entries: &[(u64, Hash)]) {
        let slot_hashes = SlotHashes::new(entries);
        self.svm.set_sysvar(&slot_hashes);
    }

    pub fn send(&mut self, instructions: &[Instruction], signers: &[&Keypair]) -> TransactionResult {
        let payer = self.payer.insecure_clone();
        let mut set: Vec<&Keypair> = Vec::with_capacity(signers.len() + 1);
        set.push(&payer);
        for signer in signers {
            set.push(signer);
        }
        let blockhash = self.svm.latest_blockhash();
        let tx =
            Transaction::new_signed_with_payer(instructions, Some(&payer.pubkey()), &set, blockhash);
        self.svm.send_transaction(tx)
    }

    pub fn account(&self, address: &Address) -> Option<Account> {
        self.svm.get_account(address)
    }

    pub fn lamports(&self, address: &Address) -> u64 {
        self.account(address)
            .map(|account| account.lamports)
            .unwrap_or(0)
    }

    pub fn exists(&self, address: &Address) -> bool {
        self.account(address).is_some()
    }

    pub fn decode<T: AccountDeserialize>(&self, address: &Address) -> Option<T> {
        let account = self.account(address)?;
        let mut data = account.data.as_slice();
        T::try_deserialize(&mut data).ok()
    }

    pub fn protocol(&self) -> ProtocolConfig {
        self.decode(&protocol_pda())
            .expect("ProtocolConfig is initialized")
    }

    pub fn coin(&self, mint: &Address) -> Coin {
        self.decode(&coin_pda(mint)).expect("Coin exists")
    }

    pub fn player(&self, owner: &Address) -> PlayerAccount {
        self.decode(&player_pda(owner))
            .expect("PlayerAccount exists")
    }

    pub fn referral_credit(&self, referrer: &Address, referee: &Address) -> ReferralCredit {
        self.decode(&referral_credit_pda(referrer, referee))
            .expect("ReferralCredit exists")
    }

    pub fn referral_week(&self, referrer: &Address) -> ReferralWeek {
        self.decode(&referral_week_pda(referrer))
            .expect("ReferralWeek exists")
    }

    pub fn position(&self, mint: &Address, owner: &Address) -> MiningPosition {
        self.decode(&position_pda(&coin_pda(mint), owner))
            .expect("MiningPosition exists")
    }

    pub fn pool(&self, mint: &Address) -> LiquidityPool {
        self.decode(&pool_pda(mint)).expect("LiquidityPool exists")
    }

    pub fn opportunity(&self, mint: &Address, owner: &Address, window: u16) -> DiscoveryOpportunity {
        self.decode(&opportunity_pda(&coin_pda(mint), owner, window))
            .expect("DiscoveryOpportunity exists")
    }

    pub fn global_budget(&self, day: u16) -> GlobalBudget {
        self.decode(&global_budget_pda(day))
            .expect("GlobalBudget exists")
    }

    pub fn sponsor_vault(&self, owner: &Address) -> SponsorVault {
        self.decode(&sponsor_vault_pda(owner))
            .expect("SponsorVault exists")
    }

    pub fn sponsor_event(&self, vault: &Address, event_id: u32) -> SponsorEvent {
        self.decode(&sponsor_event_pda(vault, event_id))
            .expect("SponsorEvent exists")
    }

    pub fn sponsor_grant(&self, event: &Address, subject: &Address) -> SponsorGrant {
        self.decode(&sponsor_grant_pda(event, subject))
            .expect("SponsorGrant exists")
    }

    /// The token amount of an SPL token account: mint(32) owner(32) amount(8).
    pub fn token_amount(&self, address: &Address) -> u64 {
        let account = self.account(address).expect("token account exists");
        u64::from_le_bytes(account.data[64..72].try_into().unwrap())
    }

    pub fn token_owner(&self, address: &Address) -> Address {
        let account = self.account(address).expect("token account exists");
        Address::new_from_array(account.data[32..64].try_into().unwrap())
    }

    pub fn token_mint(&self, address: &Address) -> Address {
        let account = self.account(address).expect("token account exists");
        Address::new_from_array(account.data[0..32].try_into().unwrap())
    }

    /// Writes an initialized Token-2022 account directly. The program never creates a trader's
    /// own token account, so the suite has to, and writing the packed layout is both shorter and
    /// stricter than round-tripping through the token program.
    pub fn create_token_account(&mut self, owner: &Address, mint: &Address) -> Address {
        let address = associated_token(owner, mint);
        let mut data = vec![0u8; 165];
        data[0..32].copy_from_slice(mint.as_ref());
        data[32..64].copy_from_slice(owner.as_ref());
        data[108] = 1; // AccountState::Initialized
        let lamports = self.svm.minimum_balance_for_rent_exemption(165);
        self.svm
            .set_account(
                address,
                Account {
                    lamports,
                    data,
                    owner: token_program(),
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .expect("write token account");
        address
    }

    /// The vault ledger invariant of design 1.3(a), as CONTRACTS.md states it:
    /// vault.amount >= curve_tokens + reserve_remaining + discovery_remaining + outstanding_claims.
    pub fn assert_vault_invariant(&self, mint: &Address) {
        let coin = self.coin(mint);
        let vault = self.token_amount(&vault_pda(mint));
        let required = coin
            .token_reserve
            .saturating_add(coin.reserve_remaining)
            .saturating_add(coin.discovery_remaining)
            .saturating_add(coin.outstanding_claims);
        assert!(
            vault >= required,
            "vault ledger invariant broken: vault {} < required {} (curve {} + reserve {} + discovery {} + outstanding {})",
            vault,
            required,
            coin.token_reserve,
            coin.reserve_remaining,
            coin.discovery_remaining,
            coin.outstanding_claims
        );
    }

    /// The three-term conservation the starter-tranche amendment pins.
    pub fn assert_conservation(&self, mint: &Address) {
        let coin = self.coin(mint);
        let total = coin
            .reserve_remaining
            .saturating_add(coin.cumulative_distributed)
            .saturating_add(coin.outstanding_claims);
        assert!(
            total <= coin.total_supply,
            "conservation broken: reserve {} + distributed {} + outstanding {} > supply {}",
            coin.reserve_remaining,
            coin.cumulative_distributed,
            coin.outstanding_claims,
            coin.total_supply
        );
    }
}

// ---- step reporting -----------------------------------------------------------------------

/// What one instruction did.
pub enum Step {
    /// The handler ran: its accounts, seeds and arguments were all accepted.
    Done(TransactionMetadata),
    /// The handler is still the frozen skeleton's NotImplemented.
    Pending,
}

impl Step {
    pub fn is_pending(&self) -> bool {
        matches!(self, Step::Pending)
    }

    pub fn meta(self) -> Option<TransactionMetadata> {
        match self {
            Step::Done(meta) => Some(meta),
            Step::Pending => None,
        }
    }
}

/// The error code a failed transaction carried, if it was a program error.
pub fn error_code(result: &TransactionResult) -> Option<u32> {
    match result {
        Ok(_) => None,
        Err(failed) => match &failed.err {
            TransactionError::InstructionError(_, InstructionError::Custom(code)) => Some(*code),
            _ => None,
        },
    }
}

fn logs_of(failed: &FailedTransactionMetadata) -> String {
    failed.meta.logs.join("\n")
}

fn is_not_implemented(result: &TransactionResult) -> bool {
    match error_code(result) {
        Some(code) => code == NOT_IMPLEMENTED,
        None => match result {
            Ok(_) => false,
            Err(failed) => logs_of(failed).contains("Error Number: 6048"),
        },
    }
}

/// A flow: a named sequence of steps that reports one PASS or PENDING line at the end.
pub struct Flow {
    pub env: Env,
    pub name: &'static str,
    pub pending: Vec<&'static str>,
    pub notes: Vec<String>,
}

impl Flow {
    pub fn new(name: &'static str) -> Self {
        Self {
            env: Env::new(),
            name,
            pending: Vec::new(),
            notes: Vec::new(),
        }
    }

    /// Runs one instruction. Ok returns its metadata, a real failure panics with the logs, and
    /// NotImplemented records the step as pending and returns None.
    pub fn step(
        &mut self,
        instruction: &'static str,
        ix: Instruction,
        signers: &[&Keypair],
    ) -> Option<TransactionMetadata> {
        let result = self.env.send(&[ix], signers);
        match &result {
            Ok(_) => result.ok(),
            Err(_) => {
                if is_not_implemented(&result) {
                    self.pending.push(instruction);
                    None
                } else {
                    let failed = result.err().expect("failed");
                    panic!(
                        "[{}] {} failed: {:?}\n--- logs ---\n{}",
                        self.name,
                        instruction,
                        failed.err,
                        logs_of(&failed)
                    );
                }
            }
        }
    }

    /// Runs one instruction that must fail with the expected code. NotImplemented is pending, so
    /// a guard test is written once and starts asserting the day its handler lands.
    pub fn expect_err(
        &mut self,
        instruction: &'static str,
        ix: Instruction,
        signers: &[&Keypair],
        expected: u32,
    ) -> Option<()> {
        let result = self.env.send(&[ix], signers);
        if error_code(&result) == Some(expected) {
            return Some(());
        }
        if is_not_implemented(&result) {
            self.pending.push(instruction);
            return None;
        }
        match result {
            Err(failed) => panic!(
                "[{}] {} was expected to fail with {} but failed with {:?}\n--- logs ---\n{}",
                self.name,
                instruction,
                expected,
                failed.err,
                logs_of(&failed)
            ),
            Ok(_) => panic!(
                "[{}] {} was expected to fail with {} but succeeded",
                self.name, instruction, expected
            ),
        }
    }

    pub fn note(&mut self, text: impl Into<String>) {
        self.notes.push(text.into());
    }

    /// Ends a test: prints the report and, when the run reached nothing but the skeleton, names
    /// exactly which instruction is still missing.
    pub fn finish(&self) {
        if self.pending.is_empty() {
            println!("[PASS] {}", self.name);
            for note in &self.notes {
                println!("       {note}");
            }
        } else {
            let mut unique = self.pending.clone();
            unique.sort_unstable();
            unique.dedup();
            println!(
                "[PENDING] {}: not implemented yet ({})",
                self.name,
                unique.join(", ")
            );
        }
    }
}

/// step! unwraps a step or ends the test as PENDING.
#[macro_export]
macro_rules! step {
    ($flow:expr, $label:expr, $ix:expr, $signers:expr) => {
        match $flow.step($label, $ix, $signers) {
            Some(meta) => meta,
            None => {
                $flow.finish();
                return;
            }
        }
    };
}

/// guard! unwraps an expected failure or ends the test as PENDING.
#[macro_export]
macro_rules! guard {
    ($flow:expr, $label:expr, $ix:expr, $signers:expr, $code:expr) => {
        if $flow
            .expect_err($label, $ix, $signers, $code)
            .is_none()
        {
            $flow.finish();
            return;
        }
    };
}

/// try_step! is step! for a helper that returns Result: it hands the pending instruction back to
/// its caller instead of ending the test, so a flow can be run more than once inside one test (the
/// sponsorship invariance runs the same scenario with and without an event).
#[macro_export]
macro_rules! try_step {
    ($flow:expr, $label:expr, $ix:expr, $signers:expr) => {
        match $flow.step($label, $ix, $signers) {
            Some(meta) => meta,
            None => return Err($flow.pending.clone()),
        }
    };
}

/// setup! unwraps a fixture that returns Result: the value when the fixture ran, or PENDING with
/// the fixture's missing instructions when it did not. The call is evaluated into a local first so
/// the fixture's borrow of the flow has ended before the flow is read again.
#[macro_export]
macro_rules! setup {
    ($flow:expr => $call:expr) => {{
        let result = $call;
        match result {
            Ok(value) => value,
            Err(pending) => {
                $flow.pending.extend(pending);
                $flow.finish();
                return;
            }
        }
    }};
}

// ---- fixtures -----------------------------------------------------------------------------

/// A protocol config with the design's defaults: 50/50 bps fees, the bond and cooldown from
/// constants.rs, the starter efficiency and tranche caps, and the lamport discovery caps.
pub fn default_protocol_args() -> ProtocolConfigArgs {
    ProtocolConfigArgs {
        creator_fee_bps: 50,
        platform_fee_bps: 50,
        crank_pool_fee_bps: 0,
        discovery_max_bps: 100,
        discovery_epoch_budget_bps: 500,
        starter_efficiency_bps: 2_500,
        starter_tranche_bps: 1_000,
        bond_lamports: BOND_LAMPORTS,
        bond_cooldown_seconds: BOND_COOLDOWN_SECONDS,
        epoch_seed_delay_slots: 32,
        epoch_seed_max_lateness_slots: 512,
        min_curve_mining_blocks: 48,
        discovery_daily_cap_lamports: 1_000_000_000,
        discovery_weekly_cap_lamports: 4_000_000_000,
        discovery_global_daily_cap_lamports: 50_000_000_000,
        discovery_epoch_budget_lamports: 2_000_000_000,
        rarity_tiers: default_rarity_tiers(),
        timelock_seconds: 172_800,
    }
}

/// Five live tiers, cumulative and ending at exactly BPS.
pub fn default_rarity_tiers() -> Vec<RarityTier> {
    vec![
        RarityTier {
            cumulative_chance_bps: 7_000,
            value_lamports: 100_000,
            min_eligibility_score: 0,
            min_liquidity_lamports: 0,
            min_volume_lamports: 0,
        },
        RarityTier {
            cumulative_chance_bps: 9_000,
            value_lamports: 250_000,
            min_eligibility_score: 10,
            min_liquidity_lamports: 1_000_000_000,
            min_volume_lamports: 0,
        },
        RarityTier {
            cumulative_chance_bps: 9_700,
            value_lamports: 600_000,
            min_eligibility_score: 25,
            min_liquidity_lamports: 5_000_000_000,
            min_volume_lamports: 1_000_000_000,
        },
        RarityTier {
            cumulative_chance_bps: 9_950,
            value_lamports: 1_500_000,
            min_eligibility_score: 50,
            min_liquidity_lamports: 20_000_000_000,
            min_volume_lamports: 5_000_000_000,
        },
        RarityTier {
            cumulative_chance_bps: 10_000,
            value_lamports: 3_000_000,
            min_eligibility_score: 80,
            min_liquidity_lamports: 50_000_000_000,
            min_volume_lamports: 20_000_000_000,
        },
    ]
}

/// A launch that satisfies every bound of validate_launch_args: a 1B whole-token supply at six
/// decimals, a 5% Mining Reserve, a 0.5% Discovery Reserve and a 5% curve share over 30 days.
pub fn default_launch_args(nonce: u8) -> LaunchTokenArgs {
    LaunchTokenArgs {
        nonce,
        decimals: 6,
        name: "Test Coin".to_string(),
        symbol: "TEST".to_string(),
        uri: "https://diggo.fun/meta/test.json".to_string(),
        total_supply: 1_000_000_000_000_000,
        reserve_bps: 500,
        discovery_reserve_bps: 50,
        curve_mining_bps: 500,
        curve_mining_runway_days: 30,
        creator_fee_bps: 50,
        platform_fee_bps: 50,
        graduation_target: 100 * LAMPORTS_PER_SOL,
        block_interval: 300,
        epoch_length: 604_800,
        reduction_bps: 2_500,
        minimum_reward: 1,
    }
}

/// Initializes the protocol as the payer, which every other fixture assumes.
pub fn initialize_protocol(flow: &mut Flow) -> Result<(), Vec<&'static str>> {
    let authority = flow.env.payer_address();
    let config = default_protocol_args();
    let ix = initialize_protocol_ix(authority, &config, authority);
    try_step!(flow, "initialize_protocol", ix, &[]);
    Ok(())
}

/// Initializes the protocol with an explicit automated keeper address.
pub fn initialize_protocol_with_keeper(
    flow: &mut Flow,
    keeper: Address,
) -> Result<(), Vec<&'static str>> {
    let authority = flow.env.payer_address();
    let config = default_protocol_args();
    let ix = initialize_protocol_ix(authority, &config, keeper);
    try_step!(flow, "initialize_protocol", ix, &[]);
    Ok(())
}
