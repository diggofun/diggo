//! instructions::mining.rs (phase 0a mechanical split of lib.rs).

use crate::*;



#[derive(Accounts)]
pub struct AdvanceMine<'info> {
    #[account(mut)]
    pub mine: Account<'info, Mine>,
    /// See AssignPower.market. Required here: advance_mine is the catch-up call, and every
    /// caller of it holds the mint.
    #[account(mut, has_one = mine)]
    pub market: Account<'info, LaunchMarket>,
}


#[derive(Accounts)]
pub struct ClaimRewards<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    /// Read-only: carries the protocol-wide reward-claims circuit breaker.
    #[account(seeds = [b"protocol"], bump = protocol.bump)]
    pub protocol: Account<'info, ProtocolConfig>,
    #[account(mut, has_one = mint, has_one = reserve_vault, has_one = market_vault)]
    pub mine: Account<'info, Mine>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, address = mine.reserve_vault)]
    pub reserve_vault: InterfaceAccount<'info, TokenAccount>,
    /// The market carries the curve-mining ledger; its vault holds the tokens the curve
    /// has emitted but no claimer has taken yet. A claim pays the curve's share out of
    /// that vault and whatever is left of it out of the Mining Reserve.
    #[account(mut, has_one = mine)]
    pub market: Account<'info, LaunchMarket>,
    #[account(mut, address = mine.market_vault)]
    pub market_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = owner,
        associated_token::mint = mint,
        associated_token::authority = owner,
        associated_token::token_program = token_program,
    )]
    pub owner_tokens: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, seeds = [b"position", mine.key().as_ref(), owner.key().as_ref()], bump = position.bump, has_one = owner, has_one = mine)]
    pub position: Account<'info, MiningPosition>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Walks this mine's mining ledger forward by at most MAX_SYNC_SEGMENTS segments and
/// commits the progress. Permissionless by design: a mine that has been idle longer
/// than one call can afford is caught up by calling this repeatedly, which is also how
/// a caller that received SyncBehind from claim_rewards or assign_power unblocks
/// itself. Each call is a deterministic continuation of the previous one, so the
/// ledger it finally lands on is the same one a single unbounded pass would have
/// produced.
pub fn advance_mine(ctx: Context<AdvanceMine>) -> Result<()> {
    sync_mine_phase(&mut ctx.accounts.mine, &ctx.accounts.market);
    sync_mine(
        &mut ctx.accounts.mine,
        Some(&mut ctx.accounts.market),
        Clock::get()?.unix_timestamp,
    )
    .map(|_| ())
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
    require!(
        !ctx.accounts.protocol.reward_claims_paused,
        DiggoError::RewardClaimsPaused
    );
    let now = Clock::get()?.unix_timestamp;
    sync_mine_phase(&mut ctx.accounts.mine, &ctx.accounts.market);
    sync_mine_to_now(
        &mut ctx.accounts.mine,
        Some(&mut ctx.accounts.market),
        now,
    )?;
    settle_position(&mut ctx.accounts.position, &ctx.accounts.mine)?;
    let amount = ctx.accounts.position.pending_reward;
    require!(amount > 0, DiggoError::NothingToClaim);
    ctx.accounts.position.pending_reward = 0;
    let from_curve = amount.min(ctx.accounts.market.curve_mining_unpaid);
    let from_reserve = amount
        .checked_sub(from_curve)
        .ok_or(DiggoError::MathOverflow)?;
    if from_curve > 0 {
        transfer_from_mine(
            &ctx.accounts.token_program,
            &ctx.accounts.mint,
            &ctx.accounts.market_vault,
            &ctx.accounts.owner_tokens,
            &ctx.accounts.mine,
            from_curve,
        )?;
        let market = &mut ctx.accounts.market;
        market.curve_mining_unpaid = market
            .curve_mining_unpaid
            .checked_sub(from_curve)
            .ok_or(DiggoError::MathOverflow)?;
    }
    if from_reserve > 0 {
        transfer_from_mine(
            &ctx.accounts.token_program,
            &ctx.accounts.mint,
            &ctx.accounts.reserve_vault,
            &ctx.accounts.owner_tokens,
            &ctx.accounts.mine,
            from_reserve,
        )?;
    }
    emit!(RewardsClaimed {
        mint: ctx.accounts.mint.key(),
        owner: ctx.accounts.owner.key(),
        amount
    });
    Ok(())
}
