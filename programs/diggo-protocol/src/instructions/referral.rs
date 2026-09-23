//! Referral credit settlement. Only the configured automated keeper may call this.

use crate::*;
use crate::instructions::player_ore::settle_ore;

#[derive(Accounts)]
pub struct CreditReferralOre<'info> {
    /// The configured automated keeper. It pays the two small PDA rents.
    #[account(mut, address = protocol.crank_pool)]
    pub keeper: Signer<'info>,
    #[account(mut, seeds = [PLAYER_SEED, referrer.key().as_ref()], bump = player.bump)]
    pub player: Account<'info, PlayerAccount>,
    #[account(
        init,
        payer = keeper,
        space = ReferralCredit::SIZE,
        seeds = [REFERRAL_CREDIT_SEED, referrer.key().as_ref(), referee.key().as_ref()],
        bump
    )]
    pub credit: Account<'info, ReferralCredit>,
    #[account(
        init_if_needed,
        payer = keeper,
        space = ReferralWeek::SIZE,
        seeds = [REFERRAL_WEEK_SEED, referrer.key().as_ref()],
        bump
    )]
    pub week: Account<'info, ReferralWeek>,
    #[account(seeds = [PROTOCOL_SEED], bump = protocol.bump)]
    pub protocol: Account<'info, ProtocolConfig>,
    /// The referee is an identity seed, not a destination and not a signer.
    /// CHECK: only its key is used as the referral marker seed; no account data is read.
    pub referee: UncheckedAccount<'info>,
    /// The referrer is an identity seed; the credited player is loaded above.
    /// CHECK: only its key is used to derive the credited player and marker PDAs.
    pub referrer: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn credit_referral_ore(
    ctx: Context<CreditReferralOre>,
    referee_arg: Pubkey,
    amount: u64,
) -> Result<()> {
    require_keys_eq!(
        referee_arg,
        ctx.accounts.referee.key(),
        DiggoError::ReferralRefereeMismatch
    );
    require!(
        amount > 0 && amount <= MAX_REFERRAL_ORE_PER_CREDIT,
        DiggoError::ReferralAmountOutOfRange
    );
    let now = Clock::get()?.unix_timestamp;
    let week_index = now / DISCOVERY_WEEK_SECONDS;
    let week = &mut ctx.accounts.week;
    if week.week_index != week_index {
        week.week_index = week_index;
        week.count = 0;
    }
    require!(
        week.count < MAX_REFERRAL_ORE_CREDITS_PER_WEEK,
        DiggoError::ReferralWeeklyCapExceeded
    );

    let player = &mut ctx.accounts.player;
    let _ = settle_ore(player, now)?;
    let capacity = ore_capacity(player.crew_levels)?;
    require!(
        amount <= capacity.saturating_sub(player.ore_balance),
        DiggoError::StorageCapacityExceeded
    );
    player.ore_balance = player.ore_balance.checked_add(amount).ok_or(DiggoError::MathOverflow)?;
    player.ore_earned = player.ore_earned.checked_add(amount).ok_or(DiggoError::AccrualOverflow)?;
    ctx.accounts.credit.amount = amount;
    week.count = week.count.checked_add(1).ok_or(DiggoError::MathOverflow)?;

    emit!(ReferralOreCredited {
        referrer: ctx.accounts.referrer.key(),
        referee: ctx.accounts.referee.key(),
        amount,
        balance: player.ore_balance,
        week_index: week_index as i64,
    });
    Ok(())
}
