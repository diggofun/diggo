//! Player creation and activation (design 3.3). WS-A owns this file.

use crate::instructions::player_ore::settle_ore;
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
    /// Present only on a PlayerAccountSubsidy path. Created here, at most once per
    /// (event, subject), which is what stops a re-registration from resetting the limits.
    #[account(
        init_if_needed,
        payer = owner,
        space = SponsorGrant::SIZE,
        seeds = [
            SPONSOR_GRANT_SEED,
            sponsor_event.as_ref().map(|event| event.key()).unwrap_or_default().as_ref(),
            owner.key().as_ref(),
        ],
        bump,
    )]
    pub sponsor_grant: Option<Account<'info, SponsorGrant>>,
    pub system_program: Program<'info, System>,
}

/// Settles accrual, rolls the activation window and applies the streak rule. Free, always.
///
/// The coin and the position are optional because a player who holds no position has nothing to
/// settle, and the handler requires both whenever the player does hold one: activation is where a
/// lapsed window is detected and forfeited, so a caller must not be able to skip the settle and
/// carry the accrual into the window it is about to open.
///
/// The coin is identified by player.active_mine rather than by a mint, because that is the account
/// the program itself wrote when it armed the position, and the position PDA is derived from it.
#[derive(Accounts)]
pub struct Activate<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [PLAYER_SEED, owner.key().as_ref()], bump = player.bump)]
    pub player: Box<Account<'info, PlayerAccount>>,
    #[account(mut)]
    pub coin: Option<Box<Account<'info, Coin>>>,
    #[account(
        mut,
        seeds = [
            POSITION_SEED,
            player.active_mine.as_ref(),
            owner.key().as_ref(),
        ],
        bump = position.bump,
    )]
    pub position: Option<Account<'info, MiningPosition>>,
    #[account(seeds = [PROTOCOL_SEED], bump = protocol.bump)]
    pub protocol: Box<Account<'info, ProtocolConfig>>,
}

/// Charges one player-kind sponsor subsidy and moves the lamports out of the vault.
///
/// Sponsorship can pay rent and fees and nothing else (design 1.7): it can never change power,
/// rewards, discovery odds, rarity, caps or eligibility, which is why the only thing this
/// function touches is lamports. Every bound is checked **before** the spend, and the vault has
/// to stay above its own rent-exempt minimum, because the vault is the sponsor's money and the
/// protocol may never touch it.
#[allow(clippy::too_many_arguments)]
pub fn pay_sponsor_subsidy<'info>(
    now: i64,
    slot: u64,
    kind: u8,
    limit_charge: u64,
    amount: u64,
    destination: &AccountInfo<'info>,
    rent_reimbursement: u64,
    owner: &AccountInfo<'info>,
    vault: &mut Account<'info, SponsorVault>,
    event: &mut Account<'info, SponsorEvent>,
    grant: &mut Account<'info, SponsorGrant>,
    grant_bump: u8,
) -> Result<()> {
    // The vault is a PDA of this program, so its address has to be the one its own seeds
    // derive: without this, a caller could hand over a SponsorVault of another sponsor and
    // spend their balance against somebody else's event.
    let expected_vault = Pubkey::create_program_address(
        &[
            SPONSOR_VAULT_SEED,
            vault.sponsor_owner.as_ref(),
            &[vault.bump],
        ],
        &crate::ID,
    )
    .map_err(|_| error!(DiggoError::EventNotActive))?;
    require!(expected_vault == vault.key(), DiggoError::EventNotActive);
    require!(event.vault == vault.key(), DiggoError::EventNotActive);
    require!(event.kind == kind, DiggoError::InvalidEventKind);
    require!(event.paused == 0, DiggoError::EventNotActive);
    require!(
        now >= event.start_at && now <= event.end_at,
        DiggoError::EventNotActive
    );
    require!(
        destination.key() != vault.key() && owner.key() != vault.key(),
        DiggoError::EventNotActive
    );

    // What actually leaves the vault: the subsidy, plus the rent of a grant that this call had
    // to create. Both are charged to the event's budget, because both are the sponsor's money
    // and the withdrawal cap of design 1.7 is `total_funded - total_spent`.
    let vault_out = amount
        .checked_add(rent_reimbursement)
        .ok_or(DiggoError::EventBudgetExhausted)?;
    let spent = event
        .spent_lamports
        .checked_add(vault_out)
        .ok_or(DiggoError::EventBudgetExhausted)?;
    require!(spent <= event.budget_lamports, DiggoError::EventBudgetExhausted);
    // The per-wallet limit is the one that applies to a player-kind subject, because the grant
    // of a PlayerAccountSubsidy or a PlayerBondSubsidy is keyed by the wallet rather than by a
    // coin. Checked before the spend, exactly as the design requires.
    let wallet_spent = grant
        .wallet_spent_lamports
        .checked_add(limit_charge)
        .ok_or(DiggoError::PerWalletLimitExceeded)?;
    require!(
        wallet_spent <= event.per_wallet_limit_lamports,
        DiggoError::PerWalletLimitExceeded
    );

    let vault_info = vault.to_account_info();
    let remaining = vault_info
        .lamports()
        .checked_sub(vault_out)
        .ok_or(DiggoError::EventBudgetExhausted)?;
    require!(
        remaining >= Rent::get()?.minimum_balance(SponsorVault::SIZE),
        DiggoError::VaultBelowRentExempt
    );
    **vault_info.try_borrow_mut_lamports()? -= vault_out;
    **destination.try_borrow_mut_lamports()? += amount;
    if rent_reimbursement > 0 {
        **owner.try_borrow_mut_lamports()? += rent_reimbursement;
    }

    // A freshly created grant is stamped here: `init_if_needed` zeroes the account and writes
    // only the discriminator, so a zero version byte is the one unambiguous "just created".
    if grant.version == 0 {
        grant.created_slot = slot;
        grant.bump = grant_bump;
        grant.version = ACCOUNT_VERSION;
    }
    grant.spent_lamports = grant
        .spent_lamports
        .checked_add(limit_charge)
        .ok_or(DiggoError::EventBudgetExhausted)?;
    grant.wallet_spent_lamports = wallet_spent;
    event.spent_lamports = spent;
    vault.total_spent = vault
        .total_spent
        .checked_add(vault_out)
        .ok_or(DiggoError::EventBudgetExhausted)?;

    emit!(SponsorSpend {
        grant: grant.key(),
        kind,
        lamports: vault_out,
    });
    Ok(())
}

/// Creates the player's PDA. Free in the sense the spec demands: no ORE, no tokens, no
/// payment beyond the network fee and the account's own rent - and on a subsidy path, not even
/// that, because the sponsor event pays the rent back to the owner in this same instruction.
pub fn initialize_player(ctx: Context<InitializePlayer>) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let slot = clock.slot;
    let player_rent = Rent::get()?.minimum_balance(PlayerAccount::SIZE);

    let mut sponsor_event = Pubkey::default();
    // Only when the client actually hands the event over. A player with no sponsor simply does
    // not pass these accounts, and pays their own rent.
    if ctx.accounts.sponsor_grant.is_some() {
        let grant_is_new = ctx
            .accounts
            .sponsor_grant
            .as_ref()
            .map(|grant| grant.version == 0)
            .unwrap_or(false);
        // The owner is the payer for the grant as well, because a PDA cannot be one; the vault
        // pays both rents back below, so the owner is never out of pocket on the sponsored path.
        let grant_rent = if grant_is_new {
            Rent::get()?.minimum_balance(SponsorGrant::SIZE)
        } else {
            0
        };
        let event = ctx
            .accounts
            .sponsor_event
            .as_mut()
            .ok_or(DiggoError::EventNotActive)?;
        sponsor_event = event.key();
        let grant_bump = ctx
            .bumps
            .sponsor_grant
            .ok_or(DiggoError::EventNotActive)?;
        let payer = ctx.accounts.owner.to_account_info();
        let vault = ctx
            .accounts
            .sponsor_vault
            .as_mut()
            .ok_or(DiggoError::VaultBelowRentExempt)?;
        let grant = ctx
            .accounts
            .sponsor_grant
            .as_mut()
            .ok_or(DiggoError::EventNotActive)?;
        pay_sponsor_subsidy(
            now,
            slot,
            SPONSOR_KIND_PLAYER_ACCOUNT_SUBSIDY,
            player_rent,
            player_rent.checked_add(grant_rent).ok_or(DiggoError::EventBudgetExhausted)?,
            &payer,
            0,
            &payer,
            vault,
            event,
            grant,
            grant_bump,
        )?;
    }

    let player = &mut ctx.accounts.player;
    **player = PlayerAccount::initialise(now, slot, ctx.bumps.player);

    emit!(PlayerInitialized {
        player: player.key(),
        owner: ctx.accounts.owner.key(),
        sponsor_event,
    });
    Ok(())
}

/// Settles accrual, rolls the window and applies the streak rule.
///
/// Free, always: no ORE, no tokens, no payment, and no operator input. What it grants is ORE
/// and Streak Freezes and nothing else - no block share, no token, no discovery luck - so a
/// longer streak is time invested rather than value bought.
pub fn activate(ctx: Context<Activate>) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    // Settle the armed position first, against the window as it stands right now, before anything
    // moves. This is where a lapsed window is detected lazily and exactly: the settle is gated by
    // is_activated, so a player whose window has expired forfeits the interval instead of carrying
    // it into the fresh window they are about to open. It is also what makes the honest path
    // exact, because a player who re-activates inside their window settles at the index of an
    // instant the walk was allowed to reach.
    if ctx.accounts.player.has_active_position() {
        let armed = ctx.accounts.player.active_mine;
        let activated = ctx.accounts.player.is_activated(now);
        let owner = ctx.accounts.owner.key();
        let coin = ctx
            .accounts
            .coin
            .as_deref_mut()
            .ok_or(DiggoError::NotActivated)?;
        require!(coin.key() == armed, DiggoError::NotActivated);
        let position = ctx
            .accounts
            .position
            .as_mut()
            .ok_or(DiggoError::NotActivated)?;
        let (credited, forfeited) = position.settle(coin, activated)?;
        if credited > 0 {
            emit!(RewardsClaimed {
                coin: armed,
                owner,
                amount: credited,
            });
        }
        if forfeited > 0 {
            emit!(RewardsForfeited {
                coin: armed,
                owner,
                amount: forfeited,
            });
        }
    }

    let player = &mut ctx.accounts.player;

    // Rate limited on-chain, so the activation bonus cannot be farmed by spamming the window.
    //
    // REACTIVATION_EARLY_SECONDS is the boundary fix the activation gate needs. The window is half
    // open - [last_activation_at, active_until) - and MIN_REACTIVATION_SECONDS is exactly
    // ACTIVATION_SECONDS, so the earliest re-activation the old rule allowed landed one second
    // after the previous window had closed: precisely the settle the gate forfeits. Allowing the
    // re-activation to land inside the window it closes is what stops a diligent player from
    // forfeiting the window they just mined.
    if player.last_activation_at > 0 {
        require!(
            now >= player.last_activation_at.saturating_add(
                MIN_REACTIVATION_SECONDS.saturating_sub(REACTIVATION_EARLY_SECONDS)
            ),
            DiggoError::ReactivationTooSoon
        );
    }

    // Book everything the previous window earned before the window moves, so an activation can
    // never retroactively change what was already accrued.
    let (stored, overflow) = settle_ore(player, now)?;

    let previous_streak = player.streak;
    let previous_activation = if player.last_activation_at > 0 {
        Some(player.last_activation_at)
    } else {
        None
    };
    let (streak, freezes_left, _used_freeze) = next_streak(
        previous_activation,
        now,
        previous_streak,
        player.streak_freezes,
        ACTIVATION_SECONDS,
        ACTIVATION_GRACE_SECONDS,
        FREEZE_COVERED_WINDOWS,
    );
    let (milestone_ore, milestone_freezes) = milestone_rewards(previous_streak, streak);
    let earned_freezes = milestone_freezes.saturating_add(freezes_earned_by_interval(
        previous_streak,
        streak,
    ));
    let (freezes, _awarded) = grant_freezes(freezes_left, earned_freezes);

    let maturity = ore_maturity_bps(player.created_at, now);
    let granted = ore_from_activation(maturity)?
        .checked_add(milestone_ore)
        .ok_or(DiggoError::AccrualOverflow)?;
    let capacity = ore_capacity(player.crew_levels)?;
    let (balance, granted_stored, granted_overflow) = store_ore(player.ore_balance, granted, capacity);
    player.ore_balance = balance;
    player.ore_earned = player
        .ore_earned
        .checked_add(granted_stored)
        .ok_or(DiggoError::AccrualOverflow)?;

    player.streak = streak;
    player.longest_streak = player.longest_streak.max(streak);
    player.valid_activations = player.valid_activations.saturating_add(1);
    player.streak_freezes = freezes;
    player.last_activation_at = now;
    player.active_until = now.saturating_add(ACTIVATION_SECONDS);
    // The accrual cursor opens with the window: time before the window was time a paused mine
    // accrued nothing for, and it must not be paid for twice.
    player.ore_accrued_at = now;

    let day = PlayerAccount::day_index_at(now);
    if day != player.last_active_day {
        player.active_days = player.active_days.saturating_add(1);
        player.last_active_day = day;
    }

    emit!(Activated {
        player: player.key(),
        active_until: player.active_until,
        streak,
        valid_activations: player.valid_activations,
    });
    if stored > 0 || overflow > 0 {
        emit!(OreCollected {
            player: player.key(),
            amount: stored,
            balance: player.ore_balance,
            overflow,
        });
    }
    if granted_overflow > 0 {
        emit!(OreCollected {
            player: player.key(),
            amount: granted_stored,
            balance: player.ore_balance,
            overflow: granted_overflow,
        });
    }
    Ok(())
}
