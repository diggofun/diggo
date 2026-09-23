//! Position lifecycle and reward claims (design 3.3). WS-A owns this file; WS-C owns the
//! index math it settles against (math/index.rs).

use crate::*;

/// Creates the MiningPosition PDA. There is deliberately no `power` argument: power is
/// crew_power(crew_levels, maturity, bond) computed in-program, so a caller cannot assert it.
#[derive(Accounts)]
pub struct AssignPower<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [PLAYER_SEED, owner.key().as_ref()], bump = player.bump)]
    pub player: Account<'info, PlayerAccount>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, seeds = [COIN_SEED, mint.key().as_ref()], bump = coin.bump)]
    pub coin: Account<'info, Coin>,
    #[account(
        init,
        payer = owner,
        space = MiningPosition::SIZE,
        seeds = [POSITION_SEED, coin.key().as_ref(), owner.key().as_ref()],
        bump,
    )]
    pub position: Account<'info, MiningPosition>,
    #[account(seeds = [PROTOCOL_SEED], bump = protocol.bump)]
    pub protocol: Account<'info, ProtocolConfig>,
    pub system_program: Program<'info, System>,
}

/// Settles the index delta and clears the position. Required before request_unbond.
#[derive(Accounts)]
pub struct RemovePower<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [PLAYER_SEED, owner.key().as_ref()], bump = player.bump)]
    pub player: Account<'info, PlayerAccount>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, seeds = [COIN_SEED, mint.key().as_ref()], bump = coin.bump)]
    pub coin: Account<'info, Coin>,
    #[account(
        mut,
        close = owner,
        seeds = [POSITION_SEED, coin.key().as_ref(), owner.key().as_ref()],
        bump = position.bump,
    )]
    pub position: Account<'info, MiningPosition>,
    pub system_program: Program<'info, System>,
}

/// Settles the old position's index delta and re-arms on the new coin. It never touches
/// activation or streak.
#[derive(Accounts)]
pub struct SwitchMine<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [PLAYER_SEED, owner.key().as_ref()], bump = player.bump)]
    pub player: Account<'info, PlayerAccount>,
    pub from_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, seeds = [COIN_SEED, from_mint.key().as_ref()], bump = from_coin.bump)]
    pub from_coin: Account<'info, Coin>,
    #[account(
        mut,
        seeds = [POSITION_SEED, from_coin.key().as_ref(), owner.key().as_ref()],
        bump = from_position.bump,
    )]
    pub from_position: Account<'info, MiningPosition>,
    pub to_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, seeds = [COIN_SEED, to_mint.key().as_ref()], bump = to_coin.bump)]
    pub to_coin: Account<'info, Coin>,
    #[account(
        init,
        payer = owner,
        space = MiningPosition::SIZE,
        seeds = [POSITION_SEED, to_coin.key().as_ref(), owner.key().as_ref()],
        bump,
    )]
    pub to_position: Account<'info, MiningPosition>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimRewards<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [PLAYER_SEED, owner.key().as_ref()], bump = player.bump)]
    pub player: Account<'info, PlayerAccount>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, seeds = [COIN_SEED, mint.key().as_ref()], bump = coin.bump)]
    pub coin: Account<'info, Coin>,
    #[account(mut, seeds = [VAULT_SEED, mint.key().as_ref()], bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = owner)]
    pub owner_tokens: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [POSITION_SEED, coin.key().as_ref(), owner.key().as_ref()],
        bump = position.bump,
    )]
    pub position: Account<'info, MiningPosition>,
    #[account(seeds = [PROTOCOL_SEED], bump = protocol.bump)]
    pub protocol: Account<'info, ProtocolConfig>,
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn assign_power(_ctx: Context<AssignPower>) -> Result<()> {
    err!(DiggoError::NotImplemented)
}

pub fn remove_power(_ctx: Context<RemovePower>) -> Result<()> {
    err!(DiggoError::NotImplemented)
}

pub fn switch_mine(_ctx: Context<SwitchMine>) -> Result<()> {
    err!(DiggoError::NotImplemented)
}

pub fn claim_rewards(_ctx: Context<ClaimRewards>) -> Result<()> {
    err!(DiggoError::NotImplemented)
}

