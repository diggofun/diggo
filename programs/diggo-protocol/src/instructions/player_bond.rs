//! Bond and starter mode (design 3.2, 5). WS-A owns this file.

use crate::*;

/// Moves bond_lamports from the owner into the PDA balance, or, with a PlayerBondSubsidy
/// event plus its SponsorGrant, from the sponsor vault. The bond sits in the PlayerAccount's
/// own balance above its rent-exempt minimum, so no account is created here.
#[derive(Accounts)]
pub struct PostBond<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [PLAYER_SEED, owner.key().as_ref()], bump = player.bump)]
    pub player: Account<'info, PlayerAccount>,
    #[account(seeds = [PROTOCOL_SEED], bump = protocol.bump)]
    pub protocol: Account<'info, ProtocolConfig>,
    /// Present only on a PlayerBondSubsidy path.
    #[account(mut)]
    pub sponsor_vault: Option<Account<'info, SponsorVault>>,
    pub sponsor_event: Option<Account<'info, SponsorEvent>>,
    #[account(mut)]
    pub sponsor_grant: Option<Account<'info, SponsorGrant>>,
    pub system_program: Program<'info, System>,
}

/// Requires no active position and sets unbond_available_at. Posting a new bond cancels it.
#[derive(Accounts)]
pub struct RequestUnbond<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [PLAYER_SEED, owner.key().as_ref()], bump = player.bump)]
    pub player: Account<'info, PlayerAccount>,
    #[account(seeds = [PROTOCOL_SEED], bump = protocol.bump)]
    pub protocol: Account<'info, ProtocolConfig>,
}

/// After the cooldown: pays the player, or the sponsor vault when bond_source = sponsor.
/// No partial withdrawal.
#[derive(Accounts)]
pub struct WithdrawBond<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [PLAYER_SEED, owner.key().as_ref()], bump = player.bump)]
    pub player: Account<'info, PlayerAccount>,
    #[account(seeds = [PROTOCOL_SEED], bump = protocol.bump)]
    pub protocol: Account<'info, ProtocolConfig>,
    /// The vault a sponsor-funded bond returns to; it must be the one the player recorded.
    #[account(mut)]
    pub sponsor_vault: Option<Account<'info, SponsorVault>>,
    pub system_program: Program<'info, System>,
}

pub fn post_bond(_ctx: Context<PostBond>) -> Result<()> {
    err!(DiggoError::NotImplemented)
}

pub fn request_unbond(_ctx: Context<RequestUnbond>) -> Result<()> {
    err!(DiggoError::NotImplemented)
}

pub fn withdraw_bond(_ctx: Context<WithdrawBond>) -> Result<()> {
    err!(DiggoError::NotImplemented)
}

