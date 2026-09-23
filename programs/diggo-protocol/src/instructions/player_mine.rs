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
    /// Boxed because ProtocolConfig is the largest account this instruction holds and the
    /// generated try_accounts frame is close to the SBF stack limit (see
    /// docs/CONTRACT_CHANGE_REQUESTS.md, the CurveTable frame note).
    #[account(seeds = [PROTOCOL_SEED], bump = protocol.bump)]
    pub protocol: Box<Account<'info, ProtocolConfig>>,
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
    /// Boxed: a `Coin` is 408 bytes and `Account` holds it inline, so two of them by value put
    /// this instruction's `try_accounts` frame over the SBF limit. See
    /// docs/CONTRACT_CHANGE_REQUESTS.md.
    #[account(mut, seeds = [COIN_SEED, from_mint.key().as_ref()], bump = from_coin.bump)]
    pub from_coin: Box<Account<'info, Coin>>,
    #[account(
        mut,
        seeds = [POSITION_SEED, from_coin.key().as_ref(), owner.key().as_ref()],
        bump = from_position.bump,
    )]
    pub from_position: Account<'info, MiningPosition>,
    pub to_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, seeds = [COIN_SEED, to_mint.key().as_ref()], bump = to_coin.bump)]
    pub to_coin: Box<Account<'info, Coin>>,
    #[account(
        init,
        payer = owner,
        space = MiningPosition::SIZE,
        seeds = [POSITION_SEED, to_coin.key().as_ref(), owner.key().as_ref()],
        bump,
    )]
    pub to_position: Account<'info, MiningPosition>,
    #[account(seeds = [PROTOCOL_SEED], bump = protocol.bump)]
    pub protocol: Account<'info, ProtocolConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimRewards<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [PLAYER_SEED, owner.key().as_ref()], bump = player.bump)]
    pub player: Box<Account<'info, PlayerAccount>>,
    pub mint: InterfaceAccount<'info, Mint>,
    /// Boxed: a Coin is 464 bytes and Account holds it inline, so the deserializer's frame is where
    /// the SBF stack checker counts it. The account list is unchanged, so no client sees this.
    #[account(mut, seeds = [COIN_SEED, mint.key().as_ref()], bump = coin.bump)]
    pub coin: Box<Account<'info, Coin>>,
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

/// Arms a position on a coin.
///
/// Power is derived, never asserted: this instruction takes no power argument, reads no
/// keeper attestation and consults no off-chain input. The two things it checks are the ones
/// the design freezes - the player holds no other active position, and their activation window
/// is open - and the tranche is the full one for every wallet, so arming costs a player nothing
/// beyond the transaction fee and no deposit stands between a new wallet and full efficiency.
pub fn assign_power(ctx: Context<AssignPower>) -> Result<()> {
    let clock = Clock::get()?;
    let player = &mut ctx.accounts.player;

    require!(
        !player.has_active_position(),
        DiggoError::PowerAlreadyAssigned
    );
    // Activation arms the position: a player who has never activated, or whose window has
    // lapsed, cannot put power on a coin's ledger.
    require!(
        player.is_activated(clock.unix_timestamp),
        DiggoError::NotActivated
    );

    let tranche = player.tranche();
    let power = derive_power(player, clock.slot)?;
    require!(power > 0, DiggoError::NoPowerAssigned);

    let position = &mut ctx.accounts.position;
    **position = MiningPosition::armed(
        &ctx.accounts.coin,
        tranche,
        power,
        clock.slot,
        ctx.bumps.position,
    );
    position.add_power_to(&mut ctx.accounts.coin)?;
    player.active_mine = ctx.accounts.coin.key();

    emit!(PowerAssigned {
        coin: ctx.accounts.coin.key(),
        owner: player.key(),
        power,
        tranche,
    });
    Ok(())
}

/// Settles the index delta, removes the position's power from the coin's totals and closes the
/// account, refunding its rent to the owner.
///
/// A position with an unsettled credit is refused rather than closed: closing it would strand
/// the reward in the coin's vault with no account left to claim it from. `claim_rewards` and
/// `remove_power` therefore belong in one transaction, where both see the same clock and the
/// delta between them is exactly zero.
pub fn remove_power(ctx: Context<RemovePower>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let player = &mut ctx.accounts.player;
    let position = &mut ctx.accounts.position;

    // Gated by the activation window: a position whose owner let the window lapse forfeits the
    // interval rather than carrying it into the removal.
    position.settle(&mut ctx.accounts.coin, player.is_activated(now))?;
    // An unsettled credit is refused rather than closed, and the error names the situation:
    // closing would strand the reward in the coin's vault with no account left to claim it from.
    // claim_rewards and remove_power belong in one transaction, where both see the same clock and
    // the delta between them is exactly zero.
    require!(
        position.pending_reward == 0,
        DiggoError::UnclaimedRewards
    );
    position.remove_power_from(&mut ctx.accounts.coin)?;

    // A position that `switch_mine` left behind has no power and no claim on active_mine, so
    // it is closed without disturbing the mine the player is actually on now.
    if player.active_mine == ctx.accounts.coin.key() {
        player.active_mine = Pubkey::default();
    }

    emit!(PowerRemoved {
        coin: ctx.accounts.coin.key(),
        owner: player.key(),
        pending_reward: position.pending_reward,
    });
    Ok(())
}

/// Moves the player's power from one coin to another.
///
/// The old position is settled and emptied but deliberately **not** closed: its pending reward
/// stays claimable through `claim_rewards` and its rent comes back through `remove_power`, and
/// neither of those is this instruction's business. Activation and streak are untouched, which
/// is what makes switching a free repositioning rather than a reset.
pub fn switch_mine(ctx: Context<SwitchMine>) -> Result<()> {
    let clock = Clock::get()?;
    let player = &mut ctx.accounts.player;

    require!(
        player.is_activated(clock.unix_timestamp),
        DiggoError::NotActivated
    );
    require!(
        player.active_mine == ctx.accounts.from_coin.key(),
        DiggoError::NoPowerAssigned
    );
    require!(
        ctx.accounts.from_coin.key() != ctx.accounts.to_coin.key(),
        DiggoError::PowerAlreadyAssigned
    );

    let from_position = &mut ctx.accounts.from_position;
    // The window is required to be open above, so this settle is exact: a switch is a
    // repositioning, never a way to launder a lapsed window into a fresh index.
    from_position.settle(
        &mut ctx.accounts.from_coin,
        player.is_activated(clock.unix_timestamp),
    )?;
    from_position.remove_power_from(&mut ctx.accounts.from_coin)?;
    from_position.assigned_power = 0;

    let tranche = player.tranche();
    let power = derive_power(player, clock.slot)?;
    require!(power > 0, DiggoError::NoPowerAssigned);

    let to_position = &mut ctx.accounts.to_position;
    **to_position = MiningPosition::armed(
        &ctx.accounts.to_coin,
        tranche,
        power,
        clock.slot,
        ctx.bumps.to_position,
    );
    to_position.add_power_to(&mut ctx.accounts.to_coin)?;
    player.active_mine = ctx.accounts.to_coin.key();

    emit!(MineSwitched {
        owner: player.key(),
        from_coin: ctx.accounts.from_coin.key(),
        to_coin: ctx.accounts.to_coin.key(),
    });
    emit!(PowerAssigned {
        coin: ctx.accounts.to_coin.key(),
        owner: player.key(),
        power,
        tranche,
    });
    Ok(())
}

/// Pays a position's pending reward out of the coin's vault, user-signed and permissionless in
/// the sense that matters: no keeper, no attestation and no operator input is on this path.
///
/// The claim is debited from `outstanding_claims` before the tokens move, so the vault ledger
/// invariant of design 1.3(a) holds at every point: what the index credited to positions is
/// counted until it is actually paid, and never after.
pub fn claim_rewards(ctx: Context<ClaimRewards>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let position = &mut ctx.accounts.position;
    // The claim is gated by the same window: what was earned while the owner was eligible is paid,
    // and what the index credited after the window lapsed is forfeited here rather than paid.
    position.settle(
        &mut ctx.accounts.coin,
        ctx.accounts.player.is_activated(now),
    )?;
    let amount = position.pending_reward;
    require!(amount > 0, DiggoError::NothingToClaim);

    let coin_key = ctx.accounts.coin.key();
    let coin_info = ctx.accounts.coin.to_account_info();
    let coin = &mut ctx.accounts.coin;
    coin.outstanding_claims = coin
        .outstanding_claims
        .checked_sub(amount)
        .ok_or(DiggoError::LedgerInvariantViolated)?;
    position.pending_reward = 0;

    let mint_key = ctx.accounts.mint.key();
    let vault_key = ctx.accounts.vault.key();
    let coin_bump = [coin.bump];
    let vault_bump = [ctx.bumps.vault];
    // The vault is the coin's own token account, so this program is its only authority and the
    // signer has to be whichever PDA `launch_token` actually made the authority. Both shapes
    // are accepted because WS-B owns that choice; nothing else is.
    let authority = ctx.accounts.vault.owner;
    let (authority_info, signer_seeds) = if authority == coin.key() {
        (
            coin_info,
            &[COIN_SEED, mint_key.as_ref(), &coin_bump],
        )
    } else if authority == vault_key {
        (
            ctx.accounts.vault.to_account_info(),
            &[VAULT_SEED, mint_key.as_ref(), &vault_bump],
        )
    } else {
        return err!(DiggoError::LedgerInvariantViolated);
    };

    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.vault.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.owner_tokens.to_account_info(),
                authority: authority_info,
            },
            &[signer_seeds],
        ),
        amount,
        ctx.accounts.mint.decimals,
    )?;

    emit!(RewardsClaimed {
        coin: coin_key,
        owner: ctx.accounts.owner.key(),
        amount,
    });
    Ok(())
}

/// The one place power is derived, so every instruction that arms a position agrees about it.
///
/// Crew levels and account maturity are the only inputs, and the bond is not one of them: the
/// starter penalty is retired, so a wallet that parks no capital brings exactly the power its
/// crew and its account age have earned. Maturity is the only throttle left, and no payment can
/// buy it back.
fn derive_power(player: &PlayerAccount, slot: u64) -> Result<u64> {
    let maturity = power_maturity_bps(player.created_slot, slot);
    mining_power(player.crew_levels, maturity)
}
