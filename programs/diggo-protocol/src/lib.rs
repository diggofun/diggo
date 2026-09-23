pub use anchor_lang::prelude::*;
pub use anchor_lang::system_program::{self, Transfer as SolTransfer};
pub use anchor_spl::associated_token::AssociatedToken;
pub use anchor_spl::token_interface::spl_token_2022::instruction::AuthorityType;
pub use anchor_spl::token_interface::{
    self, Mint, MintTo, SetAuthority, TokenAccount, TokenInterface, TransferChecked,
};

declare_id!("BLF7g1SbT72xb5M8rVrD7V3mdDXxb1AqwChcoeF4ppmE");

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
pub use instructions::admin::{GuardianConfig, GuardianMineConfig, InitializeProtocol, MigrateAccount, RotateGuardian, RotateKeeper};
pub use instructions::crew::{AssignPower, InitializePlayer, SyncCrewPower};
pub use instructions::discovery::{ClaimDiscovery};
pub use instructions::fees::{ClaimCreatorFees, ClaimPlatformFees};
pub use instructions::launch::{LaunchToken};
pub use instructions::mining::{AdvanceMine, ClaimRewards};
pub use instructions::trade::{Buy, GraduateMarket, PoolBuy, PoolSell, Sell};
pub use instructions::crank::*;
pub use instructions::token::*;
pub use instructions::launch::{validate_launch_args, LaunchTokenArgs};
pub use instructions::admin::{
    account_layout, guardian_from_raw_protocol, set_discovery_payouts_paused,
    set_mine_discovery_paused, set_reward_claims_paused, upgraded_account_data,
};

// #[program] re-exports `crate::__client_accounts_<struct>` for every instruction, so the
// generated client-account module of every derive(Accounts) struct must be reachable at the
// crate root as well.
pub(crate) use instructions::admin::{__client_accounts_guardian_config, __client_accounts_guardian_mine_config, __client_accounts_initialize_protocol, __client_accounts_migrate_account, __client_accounts_rotate_guardian, __client_accounts_rotate_keeper};
pub(crate) use instructions::crew::{__client_accounts_assign_power, __client_accounts_initialize_player, __client_accounts_sync_crew_power};
pub(crate) use instructions::discovery::{__client_accounts_claim_discovery};
pub(crate) use instructions::fees::{__client_accounts_claim_creator_fees, __client_accounts_claim_platform_fees};
pub(crate) use instructions::launch::{__client_accounts_launch_token};
pub(crate) use instructions::mining::{__client_accounts_advance_mine, __client_accounts_claim_rewards};
pub(crate) use instructions::trade::{__client_accounts_buy, __client_accounts_graduate_market, __client_accounts_pool_buy, __client_accounts_pool_sell, __client_accounts_sell};
#[program]
pub mod diggo_protocol {
    use super::*;

    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        treasury: Pubkey,
        keeper: Pubkey,
    ) -> Result<()> {
        instructions::admin::initialize_protocol(ctx, treasury, keeper)
    }

    /// Rotates the backend keeper key without touching treasury, reserves or any
    /// player balance. Only the current keeper can hand off to a new one.
    pub fn rotate_keeper(ctx: Context<RotateKeeper>, new_keeper: Pubkey) -> Result<()> {
        instructions::admin::rotate_keeper(ctx, new_keeper)
    }

    /// Hands the circuit-breaker role to another key. Only the current guardian may do
    /// this, and GuardianRotated keeps every hand-off auditable on-chain.
    pub fn rotate_guardian(ctx: Context<RotateGuardian>, new_guardian: Pubkey) -> Result<()> {
        instructions::admin::rotate_guardian(ctx, new_guardian)
    }

    /// Protocol-wide circuit breaker (spec 65): stops every discovery payout while
    /// paused is true. Trading is untouched. The handler assigns one boolean and
    /// nothing else — its account set holds no mint, token account or vault, so no
    /// instruction built on it can ever move a reserve token.
    pub fn pause_discovery_payouts(ctx: Context<GuardianConfig>, paused: bool) -> Result<()> {
        instructions::admin::pause_discovery_payouts(ctx, paused)
    }

    /// Protocol-wide circuit breaker (spec 65): stops every claim_rewards while paused
    /// is true. Trading is untouched.
    pub fn pause_reward_claims(ctx: Context<GuardianConfig>, paused: bool) -> Result<()> {
        instructions::admin::pause_reward_claims(ctx, paused)
    }

    /// Circuit breaker scoped to a single mine's Discovery Reserve (spec 65).
    pub fn pause_mine_discovery(ctx: Context<GuardianMineConfig>, paused: bool) -> Result<()> {
        instructions::admin::pause_mine_discovery(ctx, paused)
    }

    /// Sets the bounded keeper power rule: a ceiling on Crew Power the keeper may ever
    /// push, plus a per-call increase bound. Both are clamped to protocol constants, so
    /// neither can be configured away.
    pub fn update_power_bounds(
        ctx: Context<GuardianConfig>,
        max_crew_power: u64,
        max_power_increase_bps: u16,
    ) -> Result<()> {
        instructions::admin::update_power_bounds(ctx, max_crew_power, max_power_increase_bps)
    }

    /// Sets the default trading fee schedule. Existing markets keep the schedule they
    /// snapshotted at launch, so a change here can never retroactively alter a live
    /// market, and both fees stay capped at MAX_TRADING_FEE_BPS.
    pub fn update_fee_config(
        ctx: Context<GuardianConfig>,
        creator_fee_bps: u16,
        platform_fee_bps: u16,
    ) -> Result<()> {
        instructions::admin::update_fee_config(ctx, creator_fee_bps, platform_fee_bps)
    }

    /// Tunes the discovery spend limits used by mines launched from now on. Existing
    /// mines keep the budget they snapshotted at launch; the guardian can always stop
    /// them outright with pause_mine_discovery.
    pub fn update_discovery_limits(
        ctx: Context<GuardianConfig>,
        discovery_max_bps: u16,
        discovery_epoch_budget_bps: u16,
    ) -> Result<()> {
        instructions::admin::update_discovery_limits(ctx, discovery_max_bps, discovery_epoch_budget_bps)
    }

    /// Guardian-only layout upgrade for one program-owned config, mine or market account.
    ///
    /// It reallocates the account to the current size and stamps the trailing version
    /// byte; every byte that already existed is copied verbatim, so no balance, reserve,
    /// fee bucket or timestamp can move. The account must already hold enough lamports for
    /// its new rent-exempt minimum — top it up with a plain system transfer first, because
    /// this instruction deliberately never touches lamports at all.
    pub fn migrate_account(ctx: Context<MigrateAccount>, kind: u8) -> Result<()> {
        instructions::admin::migrate_account(ctx, kind)
    }

    pub fn launch_token(ctx: Context<LaunchToken>, args: LaunchTokenArgs) -> Result<()> {
        instructions::launch::launch_token(ctx, args)
    }

    /// Trading is deliberately outside every circuit breaker: this instruction never
    /// reads a pause flag, so pausing discoveries or claims can never stop the market.
    pub fn buy(ctx: Context<Buy>, sol_in: u64, min_tokens_out: u64) -> Result<()> {
        instructions::trade::buy(ctx, sol_in, min_tokens_out)
    }

    /// Trading is deliberately outside every circuit breaker: like buy, this never
    /// reads a pause flag.
    pub fn sell(ctx: Context<Sell>, tokens_in: u64, min_sol_out: u64) -> Result<()> {
        instructions::trade::sell(ctx, tokens_in, min_sol_out)
    }

    /// Moves a graduated market's entire curve liquidity into the program-owned
    /// constant-product pool (spec 36). Permissionless on purpose: once a market has
    /// genuinely reached its graduation target, anyone may pay for the pool accounts.
    ///
    /// The pool is created here and only here. It mints no LP token, its token vault is
    /// owned by the pool PDA, and no instruction anywhere can take its liquidity back out
    /// again — see apply_pool_swap. After this call the market holds nothing but accrued
    /// fees and every trade routes through the pool.
    pub fn graduate_market(ctx: Context<GraduateMarket>) -> Result<()> {
        instructions::trade::graduate_market(ctx)
    }

    /// Constant-product buy against the graduated pool: the same explicit fee schedule
    /// and the same slippage floor as the curve, but against reserves that live in the
    /// pool's own vaults and that no instruction can drain (spec 35, 36).
    pub fn pool_buy(ctx: Context<PoolBuy>, sol_in: u64, min_tokens_out: u64) -> Result<()> {
        instructions::trade::pool_buy(ctx, sol_in, min_tokens_out)
    }

    /// Constant-product sell against the graduated pool. The payout comes out of the
    /// pool's SOL vault, never exceeds the reserve the pool tracks, and honours the same
    /// explicit slippage floor.
    pub fn pool_sell(ctx: Context<PoolSell>, tokens_in: u64, min_sol_out: u64) -> Result<()> {
        instructions::trade::pool_sell(ctx, tokens_in, min_sol_out)
    }

    pub fn initialize_player(ctx: Context<InitializePlayer>) -> Result<()> {
        instructions::crew::initialize_player(ctx)
    }

    pub fn assign_power(ctx: Context<AssignPower>) -> Result<()> {
        instructions::crew::assign_power(ctx)
    }

    pub fn remove_power(ctx: Context<AssignPower>) -> Result<()> {
        instructions::crew::remove_power(ctx)
    }

    /// Walks this mine's mining ledger forward by at most MAX_SYNC_SEGMENTS segments and
    /// commits the progress. Permissionless by design: a mine that has been idle longer
    /// than one call can afford is caught up by calling this repeatedly, which is also how
    /// a caller that received SyncBehind from claim_rewards or assign_power unblocks
    /// itself. Each call is a deterministic continuation of the previous one, so the
    /// ledger it finally lands on is the same one a single unbounded pass would have
    /// produced.
    pub fn advance_mine(ctx: Context<AdvanceMine>) -> Result<()> {
        instructions::mining::advance_mine(ctx)
    }

    /// Pays out accrued mining rewards. Blocked while the protocol-wide
    /// reward-claims circuit breaker is on; buying and selling are never affected.
    ///
    /// Neither side is debited here: the walk already debited whichever one paid each
    /// block — the market's curve token inventory through
    /// apply_curve_mining_debit(CurveDebit::MiningEmission, ..) before graduation, the
    /// Mining Reserve through apply_reserve_debit(ReserveDebit::MiningClaim, ..) after it —
    /// and pending_reward is this position's claim on what the ledger already accounted
    /// for. This instruction therefore moves no token that the mining ledger did not first
    /// authorise.
    ///
    /// Curve emission is strictly older than reserve emission (the curve phase ends at
    /// graduation), so the oldest unpaid tokens are the curve's: a claim pays
    /// min(amount, curve_mining_unpaid) out of the market vault and the remainder out of
    /// the Mining Reserve. The curve vault keeps the rest of the mined-but-unclaimed
    /// tokens, which is why graduation moves only the post-mining curve inventory and
    /// leaves these behind for the positions they were credited to.
    pub fn claim_rewards(ctx: Context<ClaimRewards>) -> Result<()> {
        instructions::mining::claim_rewards(ctx)
    }

    /// Pushes a player's off-chain, ORE-funded Crew power on-chain. Only the
    /// protocol keeper may call this — real tokens or SOL never buy power;
    /// power only ever comes from the backend's Crew progression accounting.
    pub fn sync_crew_power(ctx: Context<SyncCrewPower>, new_power: u64) -> Result<()> {
        instructions::crew::sync_crew_power(ctx, new_power)
    }

    /// Pays out a server-authoritative random memecoin discovery from the
    /// Discovery Reserve. Only the protocol keeper may call this, and only
    /// after the backend's eligibility, budget and anti-abuse checks pass —
    /// this instruction performs no RNG or eligibility logic itself.
    ///
    /// Idempotency is enforced on-chain: discovery_id seeds a DiscoveryReceipt PDA that
    /// is created with init, so replaying an id fails instead of paying twice. The scoped
    /// circuit breakers, the per-call ceiling, the per-mine per-epoch budget and reserve
    /// sufficiency all live in approve_discovery_payout, and the Discovery Reserve is
    /// debited through the shared reserve ledger.
    pub fn claim_discovery(
        ctx: Context<ClaimDiscovery>,
        discovery_id: u64,
        amount: u64,
    ) -> Result<()> {
        instructions::discovery::claim_discovery(ctx, discovery_id, amount)
    }

    /// Claims the mine creator's explicitly accrued trading fee. The creator can claim
    /// only their own fee bucket: withdrawable_fee refuses to move anything unless the
    /// market still holds its rent floor, the whole curve reserve (LP SOL) and the other
    /// fee bucket afterwards. There is no path from here to a program reserve.
    pub fn claim_creator_fees(ctx: Context<ClaimCreatorFees>) -> Result<()> {
        instructions::fees::claim_creator_fees(ctx)
    }

    /// Claims the platform trading fee accrued on one market, paid to the treasury wallet
    /// stored in ProtocolConfig. Same guard as the creator claim: the curve reserve and
    /// the other fee bucket are untouchable.
    pub fn claim_platform_fees(ctx: Context<ClaimPlatformFees>) -> Result<()> {
        instructions::fees::claim_platform_fees(ctx)
    }
}
