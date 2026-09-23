//! Bond release (design 3.2, 5). WS-A owns this file.
//!
//! There is no longer a way to post a bond. The bond was the flat, refundable 0.07 SOL deposit
//! that bought full mining efficiency and discovery eligibility; both are unconditional now -
//! every position is armed in the full tranche at full efficiency, and the discovery gate is the
//! milestone history alone - so the deposit has nothing left to buy and the instruction that
//! collected it is gone. No path in the program takes a lamport from a player beyond the rent and
//! the transaction fee they already pay.
//!
//! The two release paths stay, because the lamports players parked before the change are still
//! sitting in their PlayerAccount balances and are still theirs: `request_unbond` starts the
//! cooldown and `withdraw_bond` pays the bond back in one piece, to the sponsor vault when a
//! sponsor funded it. The bond block of `PlayerAccount` is left exactly where it was, so a bond
//! posted before the change stays readable and withdrawable.

use crate::*;

/// Requires no active position and sets unbond_available_at.
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

/// Starts the seven-day cooldown.
///
/// It requires no active position, because a bond that could be pulled out from under a live
/// position would let a farm mine at full efficiency on capital it has already withdrawn. The
/// call is idempotent: a second request does not extend the cooldown, so the wait can never be
/// cycled or griefed into growing.
pub fn request_unbond(ctx: Context<RequestUnbond>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let player = &mut ctx.accounts.player;
    require!(player.has_legacy_bond(), DiggoError::NoBondPosted);
    require!(
        !player.has_active_position(),
        DiggoError::PositionStillActive
    );

    if player.unbond_available_at == 0 {
        player.unbond_available_at = now.saturating_add(ctx.accounts.protocol.bond_cooldown_seconds);
    }

    emit!(UnbondRequested {
        player: player.key(),
        unbond_available_at: player.unbond_available_at,
    });
    Ok(())
}

/// Returns the bond after the cooldown, in one piece: there is no partial withdrawal.
///
/// A sponsor-funded bond is not the player's to keep. It goes back to the vault it came from,
/// and the vault's own unspent balance goes up with it, so the sponsor can withdraw what was
/// returned rather than watching it strand. A player who asks for a sponsor bond to be paid to
/// themselves - or who hands over a vault that is not the one recorded - is refused outright.
///
/// The PDA is left above its own rent-exempt minimum, which is the only way a bond withdrawal
/// could ever damage the account it lives in.
pub fn withdraw_bond(ctx: Context<WithdrawBond>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let player = &mut ctx.accounts.player;
    let amount = player.bond_lamports;
    require!(player.has_legacy_bond(), DiggoError::NoBondPosted);
    require!(
        player.unbond_available_at > 0 && now >= player.unbond_available_at,
        DiggoError::BondCooldownActive
    );

    let sponsor_funded = player.bond_source == BOND_SOURCE_SPONSOR;
    let recorded_vault = player.bond_sponsor_vault;
    let recipient = if sponsor_funded {
        let vault = ctx
            .accounts
            .sponsor_vault
            .as_mut()
            .ok_or(DiggoError::SponsorBondNotWithdrawable)?;
        require!(
            vault.key() == recorded_vault,
            DiggoError::SponsorBondNotWithdrawable
        );
        vault.total_spent = vault.total_spent.saturating_sub(amount);
        vault.to_account_info()
    } else {
        require!(
            ctx.accounts.sponsor_vault.is_none(),
            DiggoError::SponsorBondNotWithdrawable
        );
        ctx.accounts.owner.to_account_info()
    };

    let player_info = player.to_account_info();
    let remaining = player_info
        .lamports()
        .checked_sub(amount)
        .ok_or(DiggoError::VaultBelowRentExempt)?;
    require!(
        remaining >= Rent::get()?.minimum_balance(PlayerAccount::SIZE),
        DiggoError::VaultBelowRentExempt
    );
    **player_info.try_borrow_mut_lamports()? -= amount;
    **recipient.try_borrow_mut_lamports()? += amount;

    player.bond_lamports = 0;
    player.bond_locked_at = 0;
    player.unbond_available_at = 0;
    player.bond_source = BOND_SOURCE_SELF;
    player.bond_sponsor_vault = Pubkey::default();

    emit!(BondWithdrawn {
        player: player.key(),
        lamports: amount,
        recipient: recipient.key(),
    });
    Ok(())
}
