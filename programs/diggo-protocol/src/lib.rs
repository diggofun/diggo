pub use anchor_lang::prelude::*;
pub use anchor_lang::system_program::{self, Transfer as SolTransfer};
pub use anchor_spl::associated_token::AssociatedToken;
pub use anchor_spl::token_interface::spl_token_2022::instruction::AuthorityType;
pub use anchor_spl::token_interface::{
    self, Mint, MintTo, SetAuthority, TokenAccount, TokenInterface, TransferChecked,
};

declare_id!("H3Y8GgTnvwv5U1bajfzj386YSPC48vvwjFroXYyHZFj5");

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod math;
pub mod seeds;
pub mod state;

#[cfg(test)]
mod tests;

pub use constants::*;
pub use errors::*;
pub use events::*;
pub use math::*;
pub use seeds::*;
pub use state::*;

// The instruction modules are re-exported item by item. The #[program] macro already
// publishes one glob of the handler names at the crate root, so a `pub use instructions::*;`
// here would make every handler name ambiguous.
pub use instructions::admin::{AdminConfig, InitializeProtocol, ProtocolConfigArgs, SetCurveTable};
pub use instructions::crank::*;
pub use instructions::discovery::{CreateDiscoveryRoll, ExpireOpportunity, SettleDiscovery};
pub use instructions::fees::{ClaimCreatorFees, CrankTip, SweepFees};
pub use instructions::launch::{validate_launch_args, LaunchToken, LaunchTokenArgs};
pub use instructions::mining_advance::AdvanceMine;
pub use instructions::mining_seed::CommitEpochSeed;
pub use instructions::player_activate::{Activate, InitializePlayer};
pub use instructions::player_bond::{PostBond, RequestUnbond, WithdrawBond};
pub use instructions::player_crew::UpgradeCrew;
pub use instructions::player_mine::{AssignPower, ClaimRewards, RemovePower, SwitchMine};
pub use instructions::player_ore::CollectOre;
pub use instructions::sponsor::{
    CloseSponsorEvent, CreateSponsorEvent, FundSponsorVault, InitSponsorVault,
    WithdrawSponsorVault,
};
pub use instructions::token::*;
pub use instructions::trade::{Buy, GraduateMarket, PoolBuy, PoolSell, Sell};

// #[program] re-exports `crate::__client_accounts_<struct>` for every instruction, so the
// generated client-account module of every derive(Accounts) struct must be reachable at the
// crate root as well. The handler functions are deliberately not re-exported: the macro
// publishes one glob of those names itself.
pub(crate) use instructions::admin::{
    __client_accounts_admin_config, __client_accounts_initialize_protocol,
    __client_accounts_set_curve_table,
};
pub(crate) use instructions::discovery::{
    __client_accounts_create_discovery_roll, __client_accounts_expire_opportunity,
    __client_accounts_settle_discovery,
};
pub(crate) use instructions::fees::{
    __client_accounts_claim_creator_fees, __client_accounts_crank_tip,
    __client_accounts_sweep_fees,
};
pub(crate) use instructions::launch::__client_accounts_launch_token;
pub(crate) use instructions::mining_advance::__client_accounts_advance_mine;
pub(crate) use instructions::mining_seed::__client_accounts_commit_epoch_seed;
pub(crate) use instructions::player_activate::{
    __client_accounts_activate, __client_accounts_initialize_player,
};
pub(crate) use instructions::player_bond::{
    __client_accounts_post_bond, __client_accounts_request_unbond,
    __client_accounts_withdraw_bond,
};
pub(crate) use instructions::player_crew::__client_accounts_upgrade_crew;
pub(crate) use instructions::player_mine::{
    __client_accounts_assign_power, __client_accounts_claim_rewards,
    __client_accounts_remove_power, __client_accounts_switch_mine,
};
pub(crate) use instructions::player_ore::__client_accounts_collect_ore;
pub(crate) use instructions::sponsor::{
    __client_accounts_close_sponsor_event, __client_accounts_create_sponsor_event,
    __client_accounts_fund_sponsor_vault, __client_accounts_init_sponsor_vault,
    __client_accounts_withdraw_sponsor_vault,
};
pub(crate) use instructions::trade::{
    __client_accounts_buy, __client_accounts_graduate_market, __client_accounts_pool_buy,
    __client_accounts_pool_sell, __client_accounts_sell,
};

/// The v2 program: every state transition that creates, sizes or releases value is an
/// instruction here, signed by the player or by anyone, and no operator key is required for
/// any of them. Every body below delegates to the module that owns it; until a workstream
/// lands its logic the module returns DiggoError::NotImplemented.
#[program]
pub mod diggo_protocol {
    use super::*;

    // ---- protocol, config and governance ----

    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        config: ProtocolConfigArgs,
    ) -> Result<()> {
        instructions::admin::initialize_protocol(ctx, config)
    }

    pub fn update_fee_config(
        ctx: Context<AdminConfig>,
        creator_fee_bps: u16,
        platform_fee_bps: u16,
        crank_pool_fee_bps: u16,
    ) -> Result<()> {
        instructions::admin::update_fee_config(
            ctx,
            creator_fee_bps,
            platform_fee_bps,
            crank_pool_fee_bps,
        )
    }

    pub fn update_discovery_limits(
        ctx: Context<AdminConfig>,
        discovery_max_bps: u16,
        discovery_epoch_budget_bps: u16,
        daily_cap_lamports: u64,
        weekly_cap_lamports: u64,
        global_daily_cap_lamports: u64,
        epoch_budget_lamports: u64,
    ) -> Result<()> {
        instructions::admin::update_discovery_limits(
            ctx,
            discovery_max_bps,
            discovery_epoch_budget_bps,
            daily_cap_lamports,
            weekly_cap_lamports,
            global_daily_cap_lamports,
            epoch_budget_lamports,
        )
    }

    pub fn set_rarity_table(ctx: Context<AdminConfig>, tiers: Vec<RarityTier>) -> Result<()> {
        instructions::admin::set_rarity_table(ctx, tiers)
    }

    pub fn set_curve_table(
        ctx: Context<SetCurveTable>,
        power: Vec<u32>,
        upgrade_ore_cost: Vec<Vec<u32>>,
    ) -> Result<()> {
        instructions::admin::set_curve_table(ctx, power, upgrade_ore_cost)
    }

    pub fn schedule_pause(ctx: Context<AdminConfig>, flag: u8, paused_until: i64) -> Result<()> {
        instructions::admin::schedule_pause(ctx, flag, paused_until)
    }

    pub fn unpause(ctx: Context<AdminConfig>, flag: u8) -> Result<()> {
        instructions::admin::unpause(ctx, flag)
    }

    // ---- launch, trading and graduation ----

    pub fn launch_token(ctx: Context<LaunchToken>, args: LaunchTokenArgs) -> Result<()> {
        instructions::launch::launch_token(ctx, args)
    }

    pub fn buy(ctx: Context<Buy>, sol_in: u64, min_tokens_out: u64) -> Result<()> {
        instructions::trade::buy(ctx, sol_in, min_tokens_out)
    }

    pub fn sell(ctx: Context<Sell>, tokens_in: u64, min_sol_out: u64) -> Result<()> {
        instructions::trade::sell(ctx, tokens_in, min_sol_out)
    }

    pub fn pool_buy(ctx: Context<PoolBuy>, sol_in: u64, min_tokens_out: u64) -> Result<()> {
        instructions::trade::pool_buy(ctx, sol_in, min_tokens_out)
    }

    pub fn pool_sell(ctx: Context<PoolSell>, tokens_in: u64, min_sol_out: u64) -> Result<()> {
        instructions::trade::pool_sell(ctx, tokens_in, min_sol_out)
    }

    pub fn graduate_market(ctx: Context<GraduateMarket>) -> Result<()> {
        instructions::trade::graduate_market(ctx)
    }

    // ---- fees and the crank tip ----

    pub fn sweep_fees(ctx: Context<SweepFees>) -> Result<()> {
        instructions::fees::sweep_fees(ctx)
    }

    pub fn claim_creator_fees(ctx: Context<ClaimCreatorFees>) -> Result<()> {
        instructions::fees::claim_creator_fees(ctx)
    }

    pub fn crank_tip(ctx: Context<CrankTip>, max_tip: u64) -> Result<()> {
        instructions::fees::crank_tip(ctx, max_tip)
    }

    // ---- sponsorship ----

    pub fn init_sponsor_vault(ctx: Context<InitSponsorVault>) -> Result<()> {
        instructions::sponsor::init_sponsor_vault(ctx)
    }

    pub fn fund_sponsor_vault(ctx: Context<FundSponsorVault>, amount: u64) -> Result<()> {
        instructions::sponsor::fund_sponsor_vault(ctx, amount)
    }

    pub fn withdraw_sponsor_vault(ctx: Context<WithdrawSponsorVault>, amount: u64) -> Result<()> {
        instructions::sponsor::withdraw_sponsor_vault(ctx, amount)
    }

    pub fn create_sponsor_event(
        ctx: Context<CreateSponsorEvent>,
        kind: u8,
        start_at: i64,
        end_at: i64,
        budget_lamports: u64,
        per_coin_limit_lamports: u64,
        per_wallet_limit_lamports: u64,
    ) -> Result<()> {
        instructions::sponsor::create_sponsor_event(
            ctx,
            kind,
            start_at,
            end_at,
            budget_lamports,
            per_coin_limit_lamports,
            per_wallet_limit_lamports,
        )
    }

    pub fn close_sponsor_event(ctx: Context<CloseSponsorEvent>, event_id: u32) -> Result<()> {
        instructions::sponsor::close_sponsor_event(ctx, event_id)
    }

    // ---- player: creation, activation, ORE, crew ----

    pub fn initialize_player(ctx: Context<InitializePlayer>) -> Result<()> {
        instructions::player_activate::initialize_player(ctx)
    }

    pub fn activate(ctx: Context<Activate>) -> Result<()> {
        instructions::player_activate::activate(ctx)
    }

    pub fn collect_ore(ctx: Context<CollectOre>) -> Result<()> {
        instructions::player_ore::collect_ore(ctx)
    }

    pub fn upgrade_crew(ctx: Context<UpgradeCrew>, component: u8) -> Result<()> {
        instructions::player_crew::upgrade_crew(ctx, component)
    }

    // ---- player: positions, claims and the bond ----

    pub fn assign_power(ctx: Context<AssignPower>) -> Result<()> {
        instructions::player_mine::assign_power(ctx)
    }

    pub fn remove_power(ctx: Context<RemovePower>) -> Result<()> {
        instructions::player_mine::remove_power(ctx)
    }

    pub fn switch_mine(ctx: Context<SwitchMine>) -> Result<()> {
        instructions::player_mine::switch_mine(ctx)
    }

    pub fn claim_rewards(ctx: Context<ClaimRewards>) -> Result<()> {
        instructions::player_mine::claim_rewards(ctx)
    }

    pub fn post_bond(ctx: Context<PostBond>) -> Result<()> {
        instructions::player_bond::post_bond(ctx)
    }

    pub fn request_unbond(ctx: Context<RequestUnbond>) -> Result<()> {
        instructions::player_bond::request_unbond(ctx)
    }

    pub fn withdraw_bond(ctx: Context<WithdrawBond>) -> Result<()> {
        instructions::player_bond::withdraw_bond(ctx)
    }

    // ---- the crank: ledger walk, epoch seed, discovery ----

    pub fn advance_mine(ctx: Context<AdvanceMine>) -> Result<()> {
        instructions::mining_advance::advance_mine(ctx)
    }

    pub fn commit_epoch_seed(ctx: Context<CommitEpochSeed>) -> Result<()> {
        instructions::mining_seed::commit_epoch_seed(ctx)
    }

    pub fn create_discovery_roll(ctx: Context<CreateDiscoveryRoll>) -> Result<()> {
        instructions::discovery::create_discovery_roll(ctx)
    }

    pub fn settle_discovery(ctx: Context<SettleDiscovery>) -> Result<()> {
        instructions::discovery::settle_discovery(ctx)
    }

    pub fn expire_opportunity(ctx: Context<ExpireOpportunity>) -> Result<()> {
        instructions::discovery::expire_opportunity(ctx)
    }
}
