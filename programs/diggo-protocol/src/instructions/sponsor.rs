//! Sponsor vaults, events and grants (design 1.7, 8.2). WS-B owns this file.
//!
//! A sponsorship event can pay rent and fees. It can never change power, rewards, discovery
//! odds, rarity, caps or eligibility, and it is not governance: the vault belongs to the
//! owner's own wallet and can never be a program or config authority.

use crate::*;

#[derive(Accounts)]
pub struct InitSponsorVault<'info> {
    #[account(mut)]
    pub sponsor_owner: Signer<'info>,
    #[account(
        init,
        payer = sponsor_owner,
        space = SponsorVault::SIZE,
        seeds = [SPONSOR_VAULT_SEED, sponsor_owner.key().as_ref()],
        bump,
    )]
    pub sponsor_vault: Account<'info, SponsorVault>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FundSponsorVault<'info> {
    #[account(mut)]
    pub sponsor_owner: Signer<'info>,
    #[account(
        mut,
        seeds = [SPONSOR_VAULT_SEED, sponsor_owner.key().as_ref()],
        bump = sponsor_vault.bump,
        has_one = sponsor_owner,
    )]
    pub sponsor_vault: Account<'info, SponsorVault>,
    pub system_program: Program<'info, System>,
}

/// Withdrawal belongs to the sponsor owner alone, is capped at total_funded - total_spent, and
/// can never take the vault below its own rent-exempt minimum. Unspent lamports are never the
/// protocol's.
#[derive(Accounts)]
pub struct WithdrawSponsorVault<'info> {
    #[account(mut)]
    pub sponsor_owner: Signer<'info>,
    #[account(
        mut,
        seeds = [SPONSOR_VAULT_SEED, sponsor_owner.key().as_ref()],
        bump = sponsor_vault.bump,
        has_one = sponsor_owner,
    )]
    pub sponsor_vault: Account<'info, SponsorVault>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateSponsorEvent<'info> {
    #[account(mut)]
    pub sponsor_owner: Signer<'info>,
    #[account(
        mut,
        seeds = [SPONSOR_VAULT_SEED, sponsor_owner.key().as_ref()],
        bump = sponsor_vault.bump,
        has_one = sponsor_owner,
    )]
    pub sponsor_vault: Account<'info, SponsorVault>,
    #[account(
        init,
        payer = sponsor_owner,
        space = SponsorEvent::SIZE,
        seeds = [
            SPONSOR_EVENT_SEED,
            sponsor_vault.key().as_ref(),
            &sponsor_vault.event_count.to_le_bytes(),
        ],
        bump,
    )]
    pub sponsor_event: Account<'info, SponsorEvent>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(event_id: u32)]
pub struct CloseSponsorEvent<'info> {
    #[account(mut)]
    pub sponsor_owner: Signer<'info>,
    #[account(
        seeds = [SPONSOR_VAULT_SEED, sponsor_owner.key().as_ref()],
        bump = sponsor_vault.bump,
        has_one = sponsor_owner,
    )]
    pub sponsor_vault: Account<'info, SponsorVault>,
    #[account(
        mut,
        seeds = [
            SPONSOR_EVENT_SEED,
            sponsor_vault.key().as_ref(),
            &event_id.to_le_bytes(),
        ],
        bump = sponsor_event.bump,
    )]
    pub sponsor_event: Account<'info, SponsorEvent>,
}

pub fn init_sponsor_vault(_ctx: Context<InitSponsorVault>) -> Result<()> {
    err!(DiggoError::NotImplemented)
}

pub fn fund_sponsor_vault(_ctx: Context<FundSponsorVault>, _amount: u64) -> Result<()> {
    err!(DiggoError::NotImplemented)
}

pub fn withdraw_sponsor_vault(_ctx: Context<WithdrawSponsorVault>, _amount: u64) -> Result<()> {
    err!(DiggoError::NotImplemented)
}

pub fn create_sponsor_event(
    _ctx: Context<CreateSponsorEvent>,
    _kind: u8,
    _start_at: i64,
    _end_at: i64,
    _budget_lamports: u64,
    _per_coin_limit_lamports: u64,
    _per_wallet_limit_lamports: u64,
) -> Result<()> {
    err!(DiggoError::NotImplemented)
}

pub fn close_sponsor_event(_ctx: Context<CloseSponsorEvent>, _event_id: u32) -> Result<()> {
    err!(DiggoError::NotImplemented)
}
