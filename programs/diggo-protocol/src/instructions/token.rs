//! instructions::token.rs (phase 0a mechanical split of lib.rs).

use crate::*;



pub fn mint_to<'info>(
    program: &Interface<'info, TokenInterface>,
    mint: &InterfaceAccount<'info, Mint>,
    to: &InterfaceAccount<'info, TokenAccount>,
    authority: &Account<'info, Mine>,
    seeds: &[&[&[u8]]],
    amount: u64,
) -> Result<()> {
    token_interface::mint_to(
        CpiContext::new(
            program.key(),
            MintTo {
                mint: mint.to_account_info(),
                to: to.to_account_info(),
                authority: authority.to_account_info(),
            },
        )
        .with_signer(seeds),
        amount,
    )
}


pub fn revoke_authority<'info>(
    program: &Interface<'info, TokenInterface>,
    mint: &InterfaceAccount<'info, Mint>,
    authority: &Account<'info, Mine>,
    seeds: &[&[&[u8]]],
    authority_type: AuthorityType,
) -> Result<()> {
    token_interface::set_authority(
        CpiContext::new(
            program.key(),
            SetAuthority {
                current_authority: authority.to_account_info(),
                account_or_mint: mint.to_account_info(),
            },
        )
        .with_signer(seeds),
        authority_type,
        None,
    )
}


pub fn transfer_from_mine<'info>(
    program: &Interface<'info, TokenInterface>,
    mint: &InterfaceAccount<'info, Mint>,
    from: &InterfaceAccount<'info, TokenAccount>,
    to: &InterfaceAccount<'info, TokenAccount>,
    mine: &Account<'info, Mine>,
    amount: u64,
) -> Result<()> {
    let mint_key = mint.key();
    let seeds: &[&[&[u8]]] = &[&[b"mine", mint_key.as_ref(), &[mine.bump]]];
    token_interface::transfer_checked(
        CpiContext::new(
            program.key(),
            TransferChecked {
                mint: mint.to_account_info(),
                from: from.to_account_info(),
                to: to.to_account_info(),
                authority: mine.to_account_info(),
            },
        )
        .with_signer(seeds),
        amount,
        mint.decimals,
    )
}


pub fn transfer_from_user<'info>(
    program: &Interface<'info, TokenInterface>,
    mint: &InterfaceAccount<'info, Mint>,
    from: &InterfaceAccount<'info, TokenAccount>,
    to: &InterfaceAccount<'info, TokenAccount>,
    authority: &Signer<'info>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    token_interface::transfer_checked(
        CpiContext::new(
            program.key(),
            TransferChecked {
                mint: mint.to_account_info(),
                from: from.to_account_info(),
                to: to.to_account_info(),
                authority: authority.to_account_info(),
            },
        ),
        amount,
        mint.decimals,
    )
}


/// Token movement out of the pool's vault. The pool PDA is the vault's authority and this
/// is the only place that ever signs for it, for an amount the swap math already capped.
pub fn transfer_from_pool<'info>(
    program: &Interface<'info, TokenInterface>,
    mint: &InterfaceAccount<'info, Mint>,
    from: &InterfaceAccount<'info, TokenAccount>,
    to: &InterfaceAccount<'info, TokenAccount>,
    pool: &Account<'info, LiquidityPool>,
    amount: u64,
) -> Result<()> {
    let mint_key = mint.key();
    let seeds: &[&[&[u8]]] = &[&[POOL_SEED, mint_key.as_ref(), &[pool.bump]]];
    token_interface::transfer_checked(
        CpiContext::new(
            program.key(),
            TransferChecked {
                mint: mint.to_account_info(),
                from: from.to_account_info(),
                to: to.to_account_info(),
                authority: pool.to_account_info(),
            },
        )
        .with_signer(seeds),
        amount,
        mint.decimals,
    )
}
