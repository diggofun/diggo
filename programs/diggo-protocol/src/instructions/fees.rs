//! Fees and the crank tip (design 6, 8.2). WS-B owns this file.
//!
//! A coin's fee buckets live in the coin account's own lamports, above its rent floor, next to
//! the curve's SOL reserve. Every payout here is a direct lamport move out of that ledger and
//! every one of them is bounded by the bucket it pays from, so a fee claim can never reach the
//! curve's SOL, a reserve, or the locked pool.

use crate::*;
use crate::instructions::sponsor::move_lamports;

/// Permissionless sweep of a coin's accrued fees to the fixed destinations held in
/// ProtocolConfig. No instruction takes a destination argument.
#[derive(Accounts)]
pub struct SweepFees<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, seeds = [COIN_SEED, mint.key().as_ref()], bump = coin.bump)]
    pub coin: Account<'info, Coin>,
    #[account(seeds = [PROTOCOL_SEED], bump = protocol.bump)]
    pub protocol: Account<'info, ProtocolConfig>,
    #[account(mut, seeds = [TREASURY_SEED], bump)]
    pub treasury: SystemAccount<'info>,
    #[account(mut, seeds = [CRANK_POOL_SEED], bump)]
    pub crank_pool: SystemAccount<'info>,
    /// The coin's creator: the only account a creator payout may reach.
    #[account(mut, address = coin.creator)]
    pub creator: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimCreatorFees<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, seeds = [COIN_SEED, mint.key().as_ref()], bump = coin.bump, has_one = creator)]
    pub coin: Account<'info, Coin>,
    pub system_program: Program<'info, System>,
}

/// Pays at most min(max_tip, crank_tip_bps * accrued fees) to the payer, out of the coin's
/// accrued fees only: never out of a reserve and never out of the pool.
#[derive(Accounts)]
pub struct CrankTip<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, seeds = [COIN_SEED, mint.key().as_ref()], bump = coin.bump)]
    pub coin: Account<'info, Coin>,
    #[account(seeds = [PROTOCOL_SEED], bump = protocol.bump)]
    pub protocol: Account<'info, ProtocolConfig>,
    pub system_program: Program<'info, System>,
}

/// Pays the coin's two buckets to their fixed destinations: the creator's share to the creator,
/// and the protocol's share split between the treasury and the crank pool.
///
/// Permissionless, because there is nothing to choose: every destination is a ProtocolConfig
/// field and every amount is already accrued in the coin. The payer pays the transaction fee and
/// gets nothing, which is what makes this safe to leave open to anyone.
pub fn sweep_fees(ctx: Context<SweepFees>) -> Result<()> {
    let (crank_pool_lamports, treasury_lamports) = split_platform_bucket(
        ctx.accounts.coin.platform_fee_claimable,
        ctx.accounts.protocol.crank_pool_fee_bps,
    )?;
    let creator_lamports = ctx.accounts.coin.creator_fee_claimable;
    let total = creator_lamports
        .checked_add(crank_pool_lamports)
        .and_then(|value| value.checked_add(treasury_lamports))
        .ok_or(DiggoError::MathOverflow)?;
    require!(total > 0, DiggoError::NothingToClaim);

    let coin_info = ctx.accounts.coin.to_account_info();
    let rent_floor = Coin::rent_floor()?;
    require!(
        coin_info.lamports().saturating_sub(total) >= rent_floor,
        DiggoError::LedgerInvariantViolated
    );

    let coin = &mut ctx.accounts.coin;
    coin.creator_fee_claimable = 0;
    coin.platform_fee_claimable = 0;
    let coin_key = coin_info.key();

    move_lamports(
        &coin_info,
        &ctx.accounts.treasury.to_account_info(),
        treasury_lamports,
    )?;
    move_lamports(
        &coin_info,
        &ctx.accounts.creator.to_account_info(),
        creator_lamports,
    )?;
    move_lamports(
        &coin_info,
        &ctx.accounts.crank_pool.to_account_info(),
        crank_pool_lamports,
    )?;

    emit!(FeesSwept {
        coin: coin_key,
        treasury_lamports,
        creator_lamports,
        crank_pool_lamports,
    });
    Ok(())
}

/// The creator claims their own trading fees. Nothing else is reachable from here: the amount is
/// the creator's bucket, the destination is the signer, and the curve's SOL is not the bucket.
pub fn claim_creator_fees(ctx: Context<ClaimCreatorFees>) -> Result<()> {
    let creator_lamports = ctx.accounts.coin.creator_fee_claimable;
    require!(creator_lamports > 0, DiggoError::NothingToClaim);
    let coin_info = ctx.accounts.coin.to_account_info();
    require!(
        coin_info.lamports().saturating_sub(creator_lamports) >= Coin::rent_floor()?,
        DiggoError::LedgerInvariantViolated
    );
    ctx.accounts.coin.creator_fee_claimable = 0;
    move_lamports(
        &coin_info,
        &ctx.accounts.creator.to_account_info(),
        creator_lamports,
    )?;
    Ok(())
}

/// Pays a cranker out of the protocol's own accrued fees.
///
/// The bound is CRANK_TIP_BPS of the coin's protocol bucket, so a tip can never reach a
/// creator's fees, a reserve, the curve's SOL or the locked pool, and it can never be paid twice
/// for the same accrual because the bucket it comes from is debited by exactly what it pays.
pub fn crank_tip(ctx: Context<CrankTip>, max_tip: u64) -> Result<()> {
    let accrued = ctx.accounts.coin.platform_fee_claimable;
    let tip = max_tip.min(max_crank_tip(accrued)?).min(accrued);
    require!(tip > 0, DiggoError::CrankTipExceedsAccrual);
    let coin_info = ctx.accounts.coin.to_account_info();
    require!(
        coin_info.lamports().saturating_sub(tip) >= Coin::rent_floor()?,
        DiggoError::LedgerInvariantViolated
    );
    ctx.accounts.coin.platform_fee_claimable = accrued
        .checked_sub(tip)
        .ok_or(DiggoError::CrankTipExceedsAccrual)?;
    let payer_key = ctx.accounts.payer.key();
    let coin_key = coin_info.key();
    move_lamports(&coin_info, &ctx.accounts.payer.to_account_info(), tip)?;
    emit!(CrankTipPaid {
        coin: coin_key,
        payer: payer_key,
        lamports: tip,
    });
    Ok(())
}
