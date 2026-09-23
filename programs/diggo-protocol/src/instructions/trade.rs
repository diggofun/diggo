//! instructions::trade.rs (phase 0a mechanical split of lib.rs).

use crate::*;



#[derive(Accounts)]
pub struct Buy<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(mut, has_one = mint, has_one = market_vault)]
    pub mine: Account<'info, Mine>,
    #[account(mut, seeds = [b"market", mint.key().as_ref()], bump = market.bump, has_one = mine)]
    pub market: Account<'info, LaunchMarket>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, address = mine.market_vault)]
    pub market_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = buyer,
        associated_token::mint = mint,
        associated_token::authority = buyer,
        associated_token::token_program = token_program,
    )]
    pub buyer_tokens: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}


#[derive(Accounts)]
pub struct Sell<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    #[account(has_one = mint, has_one = market_vault)]
    pub mine: Account<'info, Mine>,
    #[account(mut, seeds = [b"market", mint.key().as_ref()], bump = market.bump, has_one = mine)]
    pub market: Account<'info, LaunchMarket>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, address = mine.market_vault)]
    pub market_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = seller)]
    pub seller_tokens: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}


/// Graduation, the one instruction that creates the liquidity pool (spec 36).
///
/// The pool, its token vault and its SOL vault are all PDAs created here. Nothing in
/// this account set can reach a mining reserve, a discovery reserve, a player balance or
/// the treasury: it only reads the market's own curve reserves and moves exactly those.
#[derive(Accounts)]
pub struct GraduateMarket<'info> {
    /// Anyone may call graduation; the caller only pays for the pool's rent.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, has_one = mint, has_one = market_vault)]
    pub mine: Account<'info, Mine>,
    #[account(mut, seeds = [b"market", mint.key().as_ref()], bump = market.bump, has_one = mine)]
    pub market: Account<'info, LaunchMarket>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, address = mine.market_vault)]
    pub market_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init,
        payer = payer,
        space = 8 + LiquidityPool::INIT_SPACE,
        seeds = [POOL_SEED, mint.key().as_ref()],
        bump,
    )]
    pub pool: Account<'info, LiquidityPool>,
    #[account(
        init,
        payer = payer,
        token::mint = mint,
        token::authority = pool,
        token::token_program = token_program,
        seeds = [POOL_VAULT_SEED, mint.key().as_ref()],
        bump,
    )]
    pub pool_token_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init,
        payer = payer,
        space = 8 + PoolSolVault::INIT_SPACE,
        seeds = [POOL_SOL_SEED, mint.key().as_ref()],
        bump,
    )]
    pub pool_sol_vault: Account<'info, PoolSolVault>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}


/// Post-graduation buy. Every pool reference is pinned to the pool PDA, and the pool
/// itself is pinned to the market and the mine, so a trade can only ever touch the
/// liquidity of the market it names.
#[derive(Accounts)]
pub struct PoolBuy<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(has_one = mint)]
    pub mine: Account<'info, Mine>,
    #[account(mut, seeds = [b"market", mint.key().as_ref()], bump = market.bump, has_one = mine)]
    pub market: Account<'info, LaunchMarket>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        seeds = [POOL_SEED, mint.key().as_ref()],
        bump = pool.bump,
        has_one = mine,
        has_one = token_vault,
        has_one = sol_vault,
    )]
    pub pool: Account<'info, LiquidityPool>,
    #[account(mut, address = pool.token_vault, token::authority = pool, token::mint = mint)]
    pub token_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, address = pool.sol_vault, constraint = sol_vault.pool == pool.key() @ DiggoError::InvalidPool)]
    pub sol_vault: Account<'info, PoolSolVault>,
    #[account(
        init_if_needed,
        payer = buyer,
        associated_token::mint = mint,
        associated_token::authority = buyer,
        associated_token::token_program = token_program,
    )]
    pub buyer_tokens: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}


/// Post-graduation sell. Same pinning as PoolBuy; the SOL that leaves the vault is
/// bounded by pool.sol_reserve inside the handler, never by the vault's raw balance.
#[derive(Accounts)]
pub struct PoolSell<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    #[account(has_one = mint)]
    pub mine: Account<'info, Mine>,
    #[account(mut, seeds = [b"market", mint.key().as_ref()], bump = market.bump, has_one = mine)]
    pub market: Account<'info, LaunchMarket>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        seeds = [POOL_SEED, mint.key().as_ref()],
        bump = pool.bump,
        has_one = mine,
        has_one = token_vault,
        has_one = sol_vault,
    )]
    pub pool: Account<'info, LiquidityPool>,
    #[account(mut, address = pool.token_vault, token::authority = pool, token::mint = mint)]
    pub token_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, address = pool.sol_vault, constraint = sol_vault.pool == pool.key() @ DiggoError::InvalidPool)]
    pub sol_vault: Account<'info, PoolSolVault>,
    #[account(mut, token::mint = mint, token::authority = seller)]
    pub seller_tokens: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

/// Trading is deliberately outside every circuit breaker: this instruction never
/// reads a pause flag, so pausing discoveries or claims can never stop the market.
pub fn buy(ctx: Context<Buy>, sol_in: u64, min_tokens_out: u64) -> Result<()> {
    require!(sol_in > 0, DiggoError::InvalidAmount);
    // Once a market has graduated its curve reserves are zero and the liquidity lives
    // in the pool, so the curve is closed. pool_buy is the post-graduation venue.
    require!(!ctx.accounts.market.graduated, DiggoError::MarketGraduated);
    // Explicit fees come off the top of the gross SOL: the curve only ever sees the
    // net input, and the two fee buckets are credited in the same step.
    let (net_sol, creator_fee, platform_fee) = net_after_fees(
        sol_in,
        ctx.accounts.market.creator_fee_bps,
        ctx.accounts.market.platform_fee_bps,
    )?;
    require!(net_sol > 0, DiggoError::InvalidAmount);
    let tokens_out = quote_buy(
        ctx.accounts.market.token_reserve,
        ctx.accounts.market.sol_reserve,
        ctx.accounts.market.virtual_sol_reserve,
        net_sol,
    )?;
    require!(
        tokens_out >= min_tokens_out && tokens_out > 0,
        DiggoError::SlippageExceeded
    );

    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.key(),
            SolTransfer {
                from: ctx.accounts.buyer.to_account_info(),
                to: ctx.accounts.market.to_account_info(),
            },
        ),
        sol_in,
    )?;

    transfer_from_mine(
        &ctx.accounts.token_program,
        &ctx.accounts.mint,
        &ctx.accounts.market_vault,
        &ctx.accounts.buyer_tokens,
        &ctx.accounts.mine,
        tokens_out,
    )?;

    let market = &mut ctx.accounts.market;
    market.sol_reserve = market
        .sol_reserve
        .checked_add(net_sol)
        .ok_or(DiggoError::MathOverflow)?;
    market.token_reserve = market
        .token_reserve
        .checked_sub(tokens_out)
        .ok_or(DiggoError::MathOverflow)?;
    accrue_fees(market, creator_fee, platform_fee)?;
    // Graduation is deliberately not decided here. A market that has reached its
    // target keeps trading on the curve until graduate_market atomically creates the
    // pool and moves the reserves into it; flipping the flag on its own would strand
    // the market between two venues with the liquidity in neither.
    emit!(TradeExecuted {
        mint: ctx.accounts.mint.key(),
        trader: ctx.accounts.buyer.key(),
        side: 0,
        token_amount: tokens_out,
        sol_amount: sol_in,
        creator_fee,
        platform_fee,
    });
    Ok(())
}

/// Trading is deliberately outside every circuit breaker: like buy, this never
/// reads a pause flag.
pub fn sell(ctx: Context<Sell>, tokens_in: u64, min_sol_out: u64) -> Result<()> {
    require!(tokens_in > 0, DiggoError::InvalidAmount);
    // See buy: a graduated market trades through pool_sell only.
    require!(!ctx.accounts.market.graduated, DiggoError::MarketGraduated);
    let gross_sol = quote_sell(
        ctx.accounts.market.token_reserve,
        ctx.accounts.market.sol_reserve,
        ctx.accounts.market.virtual_sol_reserve,
        tokens_in,
    )?;
    require!(gross_sol > 0, DiggoError::SlippageExceeded);
    require!(
        gross_sol <= ctx.accounts.market.sol_reserve,
        DiggoError::InsufficientLiquidity
    );
    // The seller receives the gross curve output minus the explicit fees; the curve
    // reserve is debited by the gross amount in the same step.
    let (sol_out, creator_fee, platform_fee) = net_after_fees(
        gross_sol,
        ctx.accounts.market.creator_fee_bps,
        ctx.accounts.market.platform_fee_bps,
    )?;
    require!(sol_out >= min_sol_out, DiggoError::SlippageExceeded);

    transfer_from_user(
        &ctx.accounts.token_program,
        &ctx.accounts.mint,
        &ctx.accounts.seller_tokens,
        &ctx.accounts.market_vault,
        &ctx.accounts.seller,
        tokens_in,
    )?;

    let market_info = ctx.accounts.market.to_account_info();
    let seller_info = ctx.accounts.seller.to_account_info();
    let rent_floor = Rent::get()?.minimum_balance(market_info.data_len());
    let available = market_info.lamports().saturating_sub(rent_floor);
    // Defensive: the market must still hold its rent floor, the whole curve reserve
    // and both fee buckets after the seller's net proceeds leave.
    let fees_after = ctx
        .accounts
        .market
        .creator_fee_claimable
        .checked_add(ctx.accounts.market.platform_fee_claimable)
        .and_then(|value| value.checked_add(creator_fee))
        .and_then(|value| value.checked_add(platform_fee))
        .ok_or(DiggoError::MathOverflow)?;
    require!(
        available >= sol_out.checked_add(fees_after).ok_or(DiggoError::MathOverflow)?,
        DiggoError::InsufficientLiquidity
    );
    **market_info.try_borrow_mut_lamports()? = market_info
        .lamports()
        .checked_sub(sol_out)
        .ok_or(DiggoError::MathOverflow)?;
    **seller_info.try_borrow_mut_lamports()? = seller_info
        .lamports()
        .checked_add(sol_out)
        .ok_or(DiggoError::MathOverflow)?;

    let market = &mut ctx.accounts.market;
    market.sol_reserve = market
        .sol_reserve
        .checked_sub(gross_sol)
        .ok_or(DiggoError::MathOverflow)?;
    market.token_reserve = market
        .token_reserve
        .checked_add(tokens_in)
        .ok_or(DiggoError::MathOverflow)?;
    accrue_fees(market, creator_fee, platform_fee)?;
    emit!(TradeExecuted {
        mint: ctx.accounts.mint.key(),
        trader: ctx.accounts.seller.key(),
        side: 1,
        token_amount: tokens_in,
        sol_amount: sol_out,
        creator_fee,
        platform_fee,
    });
    Ok(())
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
    // Pre-flight first: a market that has not reached its target, or that has already
    // graduated, costs nothing here and cannot be walked into readiness.
    plan_graduation(&ctx.accounts.market)?;
    let now = Clock::get()?.unix_timestamp;
    // Then the ledger. The curve phase ends in this transaction, so the mine has to reach
    // the present first: every block that landed before this instant is paid out of the
    // curve's own token inventory, the side that was open when it landed, and a mine further
    // behind than one bounded walk can cover is refused with SyncBehind rather than
    // graduated over. advance_mine is permissionless, so the caller catches it up and calls
    // again.
    sync_mine_for_graduation(&mut ctx.accounts.mine, &mut ctx.accounts.market, now)?;
    // Re-derived after the walk: the curve inventory the walk just emitted from is smaller
    // than the one the pre-flight read, and the plan has to move what is actually there.
    let plan = plan_graduation(&ctx.accounts.market)?;
    let mine_key = ctx.accounts.mine.key();
    let mint_key = ctx.accounts.mint.key();

    // Tokens first: exactly the market's curve reserve, base unit for base unit.
    // The curve's mined-but-unclaimed tokens are already credited to positions, so they
    // stay in the market vault and are paid out by claim_rewards. Only the post-mining
    // curve inventory moves into the pool, and this is what pins it: the vault must hold
    // that inventory plus everything the reward index has emitted and nobody has taken.
    require!(
        ctx.accounts.market_vault.amount
            >= plan
                .tokens
                .saturating_add(ctx.accounts.market.curve_mining_unpaid),
        DiggoError::InsufficientLiquidity
    );
    transfer_from_mine(
        &ctx.accounts.token_program,
        &ctx.accounts.mint,
        &ctx.accounts.market_vault,
        &ctx.accounts.pool_token_vault,
        &ctx.accounts.mine,
        plan.tokens,
    )?;

    // Then the SOL side: exactly the market's curve reserve, leaving behind both the
    // rent floor and every accrued fee lamport.
    {
        let market_info = ctx.accounts.market.to_account_info();
        let pool_sol_info = ctx.accounts.pool_sol_vault.to_account_info();
        let rent_floor = Rent::get()?.minimum_balance(market_info.data_len());
        let fees = ctx
            .accounts
            .market
            .creator_fee_claimable
            .checked_add(ctx.accounts.market.platform_fee_claimable)
            .ok_or(DiggoError::MathOverflow)?;
        require!(
            market_info.lamports().saturating_sub(rent_floor)
                >= plan.sol.saturating_add(fees),
            DiggoError::InsufficientLiquidity
        );
        **market_info.try_borrow_mut_lamports()? = market_info
            .lamports()
            .checked_sub(plan.sol)
            .ok_or(DiggoError::MathOverflow)?;
        **pool_sol_info.try_borrow_mut_lamports()? = pool_sol_info
            .lamports()
            .checked_add(plan.sol)
            .ok_or(DiggoError::MathOverflow)?;
    }

    let pool_key = ctx.accounts.pool.key();
    let pool_bump = ctx.bumps.pool;
    let pool_token_vault_key = ctx.accounts.pool_token_vault.key();
    let pool_sol_vault_key = ctx.accounts.pool_sol_vault.key();
    let sol_vault_bump = ctx.bumps.pool_sol_vault;

    let pool = &mut ctx.accounts.pool;
    pool.mine = mine_key;
    pool.mint = mint_key;
    pool.token_vault = pool_token_vault_key;
    pool.sol_vault = pool_sol_vault_key;
    pool.graduated_at = now;
    pool.bump = pool_bump;
    apply_graduation(&mut ctx.accounts.market, pool, plan)?;

    let sol_vault = &mut ctx.accounts.pool_sol_vault;
    sol_vault.pool = pool_key;
    sol_vault.bump = sol_vault_bump;

    ctx.accounts.mine.status = MineStatus::MiningActive;
    // The curve phase ends here for good: from now on every block is paid out of the
    // Mining Reserve, so the walk goes back to the mine's own reduction schedule.
    ctx.accounts.mine.curve_mining_open = false;
    ctx.accounts.mine.graduated = true;
    // And the instant it ended, recorded so the walk can never mistake a block that landed
    // before it for a reserve-phase one. The walk above has already consumed everything up
    // to here, so this closes the phase rather than leaving a gap behind it - and it is what
    // keeps the classification right even if the flag is ever set on a mine the walk never
    // reached.
    ctx.accounts.mine.curve_phase_ends_at = now;

    emit!(MarketGraduated {
        mint: mint_key,
        sol_reserve: plan.sol,
        pool: pool_key,
        token_reserve: plan.tokens,
    });
    Ok(())
}

/// Constant-product buy against the graduated pool: the same explicit fee schedule
/// and the same slippage floor as the curve, but against reserves that live in the
/// pool's own vaults and that no instruction can drain (spec 35, 36).
pub fn pool_buy(ctx: Context<PoolBuy>, sol_in: u64, min_tokens_out: u64) -> Result<()> {
    require!(sol_in > 0, DiggoError::InvalidAmount);
    require!(ctx.accounts.market.graduated, DiggoError::MarketNotGraduated);
    let (net_sol, creator_fee, platform_fee) = net_after_fees(
        sol_in,
        ctx.accounts.market.creator_fee_bps,
        ctx.accounts.market.platform_fee_bps,
    )?;
    require!(net_sol > 0, DiggoError::InvalidAmount);
    let tokens_out = pool_quote_buy(
        ctx.accounts.pool.token_reserve,
        ctx.accounts.pool.sol_reserve,
        net_sol,
    )?;
    require!(
        tokens_out >= min_tokens_out && tokens_out > 0,
        DiggoError::SlippageExceeded
    );

    // Only the net input reaches the pool: the two explicit fees are paid straight
    // into the market's fee buckets, so the vault's lamports always equal its rent
    // floor plus pool.sol_reserve and nothing else.
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.key(),
            SolTransfer {
                from: ctx.accounts.buyer.to_account_info(),
                to: ctx.accounts.sol_vault.to_account_info(),
            },
        ),
        net_sol,
    )?;
    let fees = creator_fee
        .checked_add(platform_fee)
        .ok_or(DiggoError::MathOverflow)?;
    if fees > 0 {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                SolTransfer {
                    from: ctx.accounts.buyer.to_account_info(),
                    to: ctx.accounts.market.to_account_info(),
                },
            ),
            fees,
        )?;
    }

    transfer_from_pool(
        &ctx.accounts.token_program,
        &ctx.accounts.mint,
        &ctx.accounts.token_vault,
        &ctx.accounts.buyer_tokens,
        &ctx.accounts.pool,
        tokens_out,
    )?;

    apply_pool_swap(
        &mut ctx.accounts.pool,
        PoolDebit::Swap,
        net_sol,
        0,
        0,
        tokens_out,
    )?;
    accrue_fees(&mut ctx.accounts.market, creator_fee, platform_fee)?;
    emit!(TradeExecuted {
        mint: ctx.accounts.mint.key(),
        trader: ctx.accounts.buyer.key(),
        side: 0,
        token_amount: tokens_out,
        sol_amount: sol_in,
        creator_fee,
        platform_fee,
    });
    Ok(())
}

/// Constant-product sell against the graduated pool. The payout comes out of the
/// pool's SOL vault, never exceeds the reserve the pool tracks, and honours the same
/// explicit slippage floor.
pub fn pool_sell(ctx: Context<PoolSell>, tokens_in: u64, min_sol_out: u64) -> Result<()> {
    require!(tokens_in > 0, DiggoError::InvalidAmount);
    require!(ctx.accounts.market.graduated, DiggoError::MarketNotGraduated);
    let gross_sol = pool_quote_sell(
        ctx.accounts.pool.token_reserve,
        ctx.accounts.pool.sol_reserve,
        tokens_in,
    )?;
    require!(gross_sol > 0, DiggoError::SlippageExceeded);
    let (sol_out, creator_fee, platform_fee) = net_after_fees(
        gross_sol,
        ctx.accounts.market.creator_fee_bps,
        ctx.accounts.market.platform_fee_bps,
    )?;
    require!(sol_out >= min_sol_out, DiggoError::SlippageExceeded);

    transfer_from_user(
        &ctx.accounts.token_program,
        &ctx.accounts.mint,
        &ctx.accounts.seller_tokens,
        &ctx.accounts.token_vault,
        &ctx.accounts.seller,
        tokens_in,
    )?;

    // Gross SOL leaves the vault: the seller's proceeds plus the two explicit fees,
    // which are moved on to the market's fee buckets in the same step.
    let fees = creator_fee
        .checked_add(platform_fee)
        .ok_or(DiggoError::MathOverflow)?;
    let leaving = sol_out.checked_add(fees).ok_or(DiggoError::MathOverflow)?;
    let vault_info = ctx.accounts.sol_vault.to_account_info();
    let market_info = ctx.accounts.market.to_account_info();
    let seller_info = ctx.accounts.seller.to_account_info();
    let rent_floor = Rent::get()?.minimum_balance(vault_info.data_len());
    require!(
        vault_info.lamports().saturating_sub(rent_floor) >= leaving,
        DiggoError::InsufficientLiquidity
    );
    **vault_info.try_borrow_mut_lamports()? = vault_info
        .lamports()
        .checked_sub(leaving)
        .ok_or(DiggoError::MathOverflow)?;
    **seller_info.try_borrow_mut_lamports()? = seller_info
        .lamports()
        .checked_add(sol_out)
        .ok_or(DiggoError::MathOverflow)?;
    **market_info.try_borrow_mut_lamports()? = market_info
        .lamports()
        .checked_add(fees)
        .ok_or(DiggoError::MathOverflow)?;

    apply_pool_swap(
        &mut ctx.accounts.pool,
        PoolDebit::Swap,
        0,
        tokens_in,
        gross_sol,
        0,
    )?;
    accrue_fees(&mut ctx.accounts.market, creator_fee, platform_fee)?;
    emit!(TradeExecuted {
        mint: ctx.accounts.mint.key(),
        trader: ctx.accounts.seller.key(),
        side: 1,
        token_amount: tokens_in,
        sol_amount: sol_out,
        creator_fee,
        platform_fee,
    });
    Ok(())
}
