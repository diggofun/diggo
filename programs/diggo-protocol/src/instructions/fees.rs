//! instructions::fees.rs (phase 0a mechanical split of lib.rs).

use crate::*;



/// Creator trading-fee claim. Pays out only the creator's accrued fee bucket and can
/// never touch the curve's LP SOL or either program reserve; see withdrawable_fee.
#[derive(Accounts)]
pub struct ClaimCreatorFees<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(seeds = [b"mine", mint.key().as_ref()], bump = mine.bump, has_one = mint)]
    pub mine: Account<'info, Mine>,
    #[account(mut, seeds = [b"market", mint.key().as_ref()], bump = market.bump, has_one = mine)]
    pub market: Account<'info, LaunchMarket>,
}


/// Platform trading-fee claim, signed by the treasury wallet stored in ProtocolConfig.
#[derive(Accounts)]
pub struct ClaimPlatformFees<'info> {
    #[account(mut)]
    pub treasury: Signer<'info>,
    #[account(seeds = [b"protocol"], bump = protocol.bump)]
    pub protocol: Account<'info, ProtocolConfig>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(seeds = [b"mine", mint.key().as_ref()], bump = mine.bump, has_one = mint)]
    pub mine: Account<'info, Mine>,
    #[account(mut, seeds = [b"market", mint.key().as_ref()], bump = market.bump, has_one = mine)]
    pub market: Account<'info, LaunchMarket>,
}

/// Claims the mine creator's explicitly accrued trading fee. The creator can claim
/// only their own fee bucket: withdrawable_fee refuses to move anything unless the
/// market still holds its rent floor, the whole curve reserve (LP SOL) and the other
/// fee bucket afterwards. There is no path from here to a program reserve.
pub fn claim_creator_fees(ctx: Context<ClaimCreatorFees>) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.creator.key(),
        ctx.accounts.mine.creator,
        DiggoError::UnauthorizedCreator
    );
    let market_info = ctx.accounts.market.to_account_info();
    let rent_floor = Rent::get()?.minimum_balance(market_info.data_len());
    let amount = withdrawable_fee(
        &ctx.accounts.market,
        market_info.lamports(),
        rent_floor,
        FeeBucket::Creator,
    )?;
    ctx.accounts.market.creator_fee_claimable = 0;
    **market_info.try_borrow_mut_lamports()? = market_info
        .lamports()
        .checked_sub(amount)
        .ok_or(DiggoError::MathOverflow)?;
    let creator_info = ctx.accounts.creator.to_account_info();
    **creator_info.try_borrow_mut_lamports()? = creator_info
        .lamports()
        .checked_add(amount)
        .ok_or(DiggoError::MathOverflow)?;
    emit!(FeesClaimed {
        mint: ctx.accounts.mint.key(),
        claimant: ctx.accounts.creator.key(),
        kind: 0,
        amount,
    });
    Ok(())
}

/// Claims the platform trading fee accrued on one market, paid to the treasury wallet
/// stored in ProtocolConfig. Same guard as the creator claim: the curve reserve and
/// the other fee bucket are untouchable.
pub fn claim_platform_fees(ctx: Context<ClaimPlatformFees>) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.treasury.key(),
        ctx.accounts.protocol.treasury,
        DiggoError::InvalidTreasury
    );
    let market_info = ctx.accounts.market.to_account_info();
    let rent_floor = Rent::get()?.minimum_balance(market_info.data_len());
    let amount = withdrawable_fee(
        &ctx.accounts.market,
        market_info.lamports(),
        rent_floor,
        FeeBucket::Platform,
    )?;
    ctx.accounts.market.platform_fee_claimable = 0;
    **market_info.try_borrow_mut_lamports()? = market_info
        .lamports()
        .checked_sub(amount)
        .ok_or(DiggoError::MathOverflow)?;
    let treasury_info = ctx.accounts.treasury.to_account_info();
    **treasury_info.try_borrow_mut_lamports()? = treasury_info
        .lamports()
        .checked_add(amount)
        .ok_or(DiggoError::MathOverflow)?;
    emit!(FeesClaimed {
        mint: ctx.accounts.mint.key(),
        claimant: ctx.accounts.treasury.key(),
        kind: 1,
        amount,
    });
    Ok(())
}
