//! Player creation and activation (design 3.3). WS-A owns this file.

use crate::*;

/// Creates the 216-byte PlayerAccount PDA at its full size, so posting a bond later never
/// reallocs it. `payer` is the owner by default; on a PlayerAccountSubsidy path the sponsor
/// vault reimburses the owner inside the same instruction, because a PDA cannot be a Signer.
#[derive(Accounts)]
pub struct InitializePlayer<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = owner,
        space = PlayerAccount::SIZE,
        seeds = [PLAYER_SEED, owner.key().as_ref()],
        bump,
    )]
    pub player: Account<'info, PlayerAccount>,
    #[account(mut, seeds = [PROTOCOL_SEED], bump = protocol.bump)]
    pub protocol: Account<'info, ProtocolConfig>,
    /// Present only on a PlayerAccountSubsidy path.
    #[account(mut)]
    pub sponsor_vault: Option<Account<'info, SponsorVault>>,
    pub sponsor_event: Option<Account<'info, SponsorEvent>>,
    #[account(mut)]
    pub sponsor_grant: Option<Account<'info, SponsorGrant>>,
    pub system_program: Program<'info, System>,
}

/// Settles accrual, rolls the activation window and applies the streak rule. Free, always.
#[derive(Accounts)]
pub struct Activate<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [PLAYER_SEED, owner.key().as_ref()], bump = player.bump)]
    pub player: Account<'info, PlayerAccount>,
    #[account(seeds = [PROTOCOL_SEED], bump = protocol.bump)]
    pub protocol: Account<'info, ProtocolConfig>,
}

pub fn initialize_player(_ctx: Context<InitializePlayer>) -> Result<()> {
    err!(DiggoError::NotImplemented)
}

pub fn activate(_ctx: Context<Activate>) -> Result<()> {
    err!(DiggoError::NotImplemented)
}

