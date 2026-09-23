//! instructions::discovery.rs (phase 0a mechanical split of lib.rs).

use crate::*;



#[derive(Accounts)]
#[instruction(discovery_id: u64, amount: u64)]
pub struct ClaimDiscovery<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(seeds = [b"protocol"], bump = protocol.bump, has_one = keeper)]
    pub protocol: Account<'info, ProtocolConfig>,
    #[account(mut, has_one = mint, has_one = discovery_vault)]
    pub mine: Account<'info, Mine>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, address = mine.discovery_vault)]
    pub discovery_vault: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: reward recipient wallet; only used to derive/own the destination ATA.
    pub recipient: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = keeper,
        associated_token::mint = mint,
        associated_token::authority = recipient,
        associated_token::token_program = token_program,
    )]
    pub recipient_tokens: InterfaceAccount<'info, TokenAccount>,
    /// One receipt per (mine, discovery_id), created with init: replaying the same
    /// discovery_id fails the transaction instead of paying the same discovery twice.
    #[account(
        init,
        payer = keeper,
        space = 8 + DiscoveryReceipt::INIT_SPACE,
        seeds = [DISCOVERY_RECEIPT_SEED, mine.key().as_ref(), &discovery_id.to_le_bytes()],
        bump,
    )]
    pub receipt: Account<'info, DiscoveryReceipt>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Pays out a server-authoritative random memecoin discovery from the
/// Discovery Reserve. Only the protocol keeper may call this, and only
/// after the backend's eligibility, budget and anti-abuse checks pass —
/// this instruction performs no RNG or eligibility logic itself.
///
/// Idempotency is enforced on-chain: discovery_id seeds a DiscoveryReceipt PDA that
/// is created with init, so replaying an id fails instead of paying twice. The scoped
/// circuit breakers, the per-call ceiling, the per-mine per-epoch budget and reserve
/// sufficiency all live in approve_discovery_payout, and the Discovery Reserve is
/// debited through the shared reserve ledger.
pub fn claim_discovery(
    ctx: Context<ClaimDiscovery>,
    discovery_id: u64,
    amount: u64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let mine = &mut ctx.accounts.mine;
    let approval = approve_discovery_payout(&ctx.accounts.protocol, mine, amount, now)?;
    mine.discovery_epoch_spent = approval.epoch_spent;
    mine.discovery_epoch_ends_at = approval.epoch_ends_at;
    apply_reserve_debit(mine, ReserveDebit::DiscoveryClaim, amount)?;

    let receipt = &mut ctx.accounts.receipt;
    receipt.mine = mine.key();
    receipt.discovery_id = discovery_id;
    receipt.recipient = ctx.accounts.recipient.key();
    receipt.amount = amount;
    receipt.claimed_at = now;
    receipt.bump = ctx.bumps.receipt;

    transfer_from_mine(
        &ctx.accounts.token_program,
        &ctx.accounts.mint,
        &ctx.accounts.discovery_vault,
        &ctx.accounts.recipient_tokens,
        mine,
        amount,
    )?;
    emit!(DiscoveryClaimed {
        mint: mine.mint,
        recipient: ctx.accounts.recipient.key(),
        discovery_id,
        amount,
        epoch_spent: approval.epoch_spent,
        epoch_budget: approval.epoch_budget,
    });
    Ok(())
}
