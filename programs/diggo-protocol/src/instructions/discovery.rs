//! Discovery: roll, settle, expire (design 4.2, 8.2). WS-C owns this file.

use crate::*;

/// Checks eligibility and every cap, charges the day, week and global budgets immediately,
/// and creates the opportunity PDA as pending against the current epoch. No randomness is
/// requested here: the seed does not exist yet.
#[derive(Accounts)]
pub struct CreateDiscoveryRoll<'info> {
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
        space = DiscoveryOpportunity::SIZE,
        seeds = [
            OPPORTUNITY_SEED,
            coin.key().as_ref(),
            owner.key().as_ref(),
            &player.roll_window.to_le_bytes(),
        ],
        bump,
    )]
    pub opportunity: Account<'info, DiscoveryOpportunity>,
    #[account(
        init_if_needed,
        payer = owner,
        space = GlobalBudget::SIZE,
        seeds = [GLOBAL_BUDGET_SEED, &player.day_index.to_le_bytes()],
        bump,
    )]
    pub global_budget: Account<'info, GlobalBudget>,
    #[account(seeds = [PROTOCOL_SEED], bump = protocol.bump)]
    pub protocol: Account<'info, ProtocolConfig>,
    pub system_program: Program<'info, System>,
}

/// Permissionless. Requires the coin's committed seed to cover the opportunity's epoch,
/// recomputes the same derivation, pays out of the discovery ledger and closes the PDA,
/// refunding its rent to the caller.
#[derive(Accounts)]
pub struct SettleDiscovery<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the recorded owner of the opportunity, checked against the PDA seeds.
    pub owner: UncheckedAccount<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, seeds = [COIN_SEED, mint.key().as_ref()], bump = coin.bump)]
    pub coin: Account<'info, Coin>,
    #[account(mut, seeds = [VAULT_SEED, mint.key().as_ref()], bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, address = owner.key())]
    pub owner_tokens: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        close = payer,
        seeds = [
            OPPORTUNITY_SEED,
            coin.key().as_ref(),
            owner.key().as_ref(),
            &opportunity.window_index.to_le_bytes(),
        ],
        bump = opportunity.bump,
    )]
    pub opportunity: Account<'info, DiscoveryOpportunity>,
    #[account(mut)]
    pub global_budget: Option<Account<'info, GlobalBudget>>,
    #[account(seeds = [PROTOCOL_SEED], bump = protocol.bump)]
    pub protocol: Account<'info, ProtocolConfig>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// Permissionless. A pending opportunity past its expiry may be closed: it pays nothing and
/// refunds no budget, which is exactly why charging the budget at roll creation is safe.
#[derive(Accounts)]
pub struct ExpireOpportunity<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the recorded owner of the opportunity, checked against the PDA seeds.
    pub owner: UncheckedAccount<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, seeds = [COIN_SEED, mint.key().as_ref()], bump = coin.bump)]
    pub coin: Account<'info, Coin>,
    #[account(
        mut,
        close = payer,
        seeds = [
            OPPORTUNITY_SEED,
            coin.key().as_ref(),
            owner.key().as_ref(),
            &opportunity.window_index.to_le_bytes(),
        ],
        bump = opportunity.bump,
    )]
    pub opportunity: Account<'info, DiscoveryOpportunity>,
    pub system_program: Program<'info, System>,
}

pub fn create_discovery_roll(_ctx: Context<CreateDiscoveryRoll>) -> Result<()> {
    err!(DiggoError::NotImplemented)
}

pub fn settle_discovery(_ctx: Context<SettleDiscovery>) -> Result<()> {
    err!(DiggoError::NotImplemented)
}

pub fn expire_opportunity(_ctx: Context<ExpireOpportunity>) -> Result<()> {
    err!(DiggoError::NotImplemented)
}

