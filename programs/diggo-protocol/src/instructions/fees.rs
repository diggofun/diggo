//! Fees and the crank tip (design 6, 8.2). WS-B owns this file.

use crate::*;

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

pub fn sweep_fees(_ctx: Context<SweepFees>) -> Result<()> {
    err!(DiggoError::NotImplemented)
}

pub fn claim_creator_fees(_ctx: Context<ClaimCreatorFees>) -> Result<()> {
    err!(DiggoError::NotImplemented)
}

pub fn crank_tip(_ctx: Context<CrankTip>, _max_tip: u64) -> Result<()> {
    err!(DiggoError::NotImplemented)
}

