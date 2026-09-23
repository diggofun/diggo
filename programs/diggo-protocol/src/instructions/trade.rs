//! Curve and pool trading, and graduation (design 8.2). WS-B owns this file.

use crate::*;

#[derive(Accounts)]
pub struct Buy<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, seeds = [COIN_SEED, mint.key().as_ref()], bump = coin.bump)]
    pub coin: Account<'info, Coin>,
    #[account(mut, seeds = [VAULT_SEED, mint.key().as_ref()], bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = buyer)]
    pub buyer_tokens: InterfaceAccount<'info, TokenAccount>,
    #[account(seeds = [PROTOCOL_SEED], bump = protocol.bump)]
    pub protocol: Account<'info, ProtocolConfig>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Sell<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, seeds = [COIN_SEED, mint.key().as_ref()], bump = coin.bump)]
    pub coin: Account<'info, Coin>,
    #[account(mut, seeds = [VAULT_SEED, mint.key().as_ref()], bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = seller)]
    pub seller_tokens: InterfaceAccount<'info, TokenAccount>,
    #[account(seeds = [PROTOCOL_SEED], bump = protocol.bump)]
    pub protocol: Account<'info, ProtocolConfig>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// Permissionless: once the condition is on-chain true, anyone may pay for the pool accounts.
#[derive(Accounts)]
pub struct GraduateMarket<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, seeds = [COIN_SEED, mint.key().as_ref()], bump = coin.bump)]
    pub coin: Account<'info, Coin>,
    #[account(mut, seeds = [VAULT_SEED, mint.key().as_ref()], bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(init, payer = payer, space = LiquidityPool::SIZE, seeds = [POOL_SEED, mint.key().as_ref()], bump)]
    pub pool: Account<'info, LiquidityPool>,
    #[account(
        init,
        payer = payer,
        token::mint = mint,
        token::authority = pool,
        seeds = [POOL_VAULT_SEED, mint.key().as_ref()],
        bump,
    )]
    pub pool_token_vault: InterfaceAccount<'info, TokenAccount>,
    /// The pool's SOL vault: a program-owned PDA holding lamports only.
    #[account(mut, seeds = [POOL_SOL_SEED, mint.key().as_ref()], bump)]
    pub pool_sol_vault: SystemAccount<'info>,
    #[account(seeds = [PROTOCOL_SEED], bump = protocol.bump)]
    pub protocol: Account<'info, ProtocolConfig>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PoolBuy<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, seeds = [COIN_SEED, mint.key().as_ref()], bump = coin.bump)]
    pub coin: Account<'info, Coin>,
    #[account(mut, seeds = [POOL_SEED, mint.key().as_ref()], bump = pool.bump)]
    pub pool: Account<'info, LiquidityPool>,
    #[account(mut, seeds = [POOL_VAULT_SEED, mint.key().as_ref()], bump)]
    pub pool_token_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, seeds = [POOL_SOL_SEED, mint.key().as_ref()], bump)]
    pub pool_sol_vault: SystemAccount<'info>,
    #[account(mut, token::mint = mint, token::authority = buyer)]
    pub buyer_tokens: InterfaceAccount<'info, TokenAccount>,
    #[account(seeds = [PROTOCOL_SEED], bump = protocol.bump)]
    pub protocol: Account<'info, ProtocolConfig>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PoolSell<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, seeds = [COIN_SEED, mint.key().as_ref()], bump = coin.bump)]
    pub coin: Account<'info, Coin>,
    #[account(mut, seeds = [POOL_SEED, mint.key().as_ref()], bump = pool.bump)]
    pub pool: Account<'info, LiquidityPool>,
    #[account(mut, seeds = [POOL_VAULT_SEED, mint.key().as_ref()], bump)]
    pub pool_token_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, seeds = [POOL_SOL_SEED, mint.key().as_ref()], bump)]
    pub pool_sol_vault: SystemAccount<'info>,
    #[account(mut, token::mint = mint, token::authority = seller)]
    pub seller_tokens: InterfaceAccount<'info, TokenAccount>,
    #[account(seeds = [PROTOCOL_SEED], bump = protocol.bump)]
    pub protocol: Account<'info, ProtocolConfig>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn buy(_ctx: Context<Buy>, _sol_in: u64, _min_tokens_out: u64) -> Result<()> {
    err!(DiggoError::NotImplemented)
}

pub fn sell(_ctx: Context<Sell>, _tokens_in: u64, _min_sol_out: u64) -> Result<()> {
    err!(DiggoError::NotImplemented)
}

pub fn pool_buy(_ctx: Context<PoolBuy>, _sol_in: u64, _min_tokens_out: u64) -> Result<()> {
    err!(DiggoError::NotImplemented)
}

pub fn pool_sell(_ctx: Context<PoolSell>, _tokens_in: u64, _min_sol_out: u64) -> Result<()> {
    err!(DiggoError::NotImplemented)
}

pub fn graduate_market(_ctx: Context<GraduateMarket>) -> Result<()> {
    err!(DiggoError::NotImplemented)
}

