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
    pub player: Box<Account<'info, PlayerAccount>>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, seeds = [COIN_SEED, mint.key().as_ref()], bump = coin.bump)]
    pub coin: Box<Account<'info, Coin>>,
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
    pub opportunity: Box<Account<'info, DiscoveryOpportunity>>,
    /// CHECK: checked and initialised manually against the current clock day in the handler.
    #[account(mut)]
    pub global_budget: UncheckedAccount<'info>,
    #[account(seeds = [PROTOCOL_SEED], bump = protocol.bump)]
    pub protocol: Box<Account<'info, ProtocolConfig>>,
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
    pub coin: Box<Account<'info, Coin>>,
    #[account(mut, seeds = [VAULT_SEED, mint.key().as_ref()], bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    // The player's own token account. The spine asserted address = owner.key(), which no
    // wallet's associated token account satisfies; the payout destination is the account the
    // recorded owner holds, and the owner itself is already proven by the PDA seeds above.
    #[account(mut, token::mint = mint, token::authority = owner)]
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
    pub opportunity: Box<Account<'info, DiscoveryOpportunity>>,
    #[account(
        mut,
        seeds = [GLOBAL_BUDGET_SEED, &opportunity.day_index.to_le_bytes()],
        bump,
    )]
    pub global_budget: Option<Box<Account<'info, GlobalBudget>>>,
    #[account(seeds = [PROTOCOL_SEED], bump = protocol.bump)]
    pub protocol: Box<Account<'info, ProtocolConfig>>,
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
    pub coin: Box<Account<'info, Coin>>,
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
    pub opportunity: Box<Account<'info, DiscoveryOpportunity>>,
    pub system_program: Program<'info, System>,
}

/// Moves units out of the coin's own vault. The Coin PDA is the vault's authority, and this
/// is the only place discovery ever signs for it.
fn transfer_from_coin<'info>(
    token_program: &Interface<'info, TokenInterface>,
    mint: &InterfaceAccount<'info, Mint>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    to: &InterfaceAccount<'info, TokenAccount>,
    coin: &Account<'info, Coin>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let mint_key = mint.key();
    let seeds: &[&[&[u8]]] = &[&[COIN_SEED, mint_key.as_ref(), &[coin.bump]]];
    token_interface::transfer_checked(
        CpiContext::new(
            token_program.key(),
            TransferChecked {
                mint: mint.to_account_info(),
                from: vault.to_account_info(),
                to: to.to_account_info(),
                authority: coin.to_account_info(),
            },
        )
        .with_signer(seeds),
        amount,
        mint.decimals,
    )
}

/// Open or load the one global budget for `day` without ever relabelling another day's account.
/// Anchor cannot derive a PDA from `Clock::get()` in account constraints, so this does the PDA
/// derivation and one-time system-account initialisation explicitly after the day is known.
fn open_global_budget<'info>(
    owner: &Signer<'info>,
    global_budget: &UncheckedAccount<'info>,
    system_program: &Program<'info, System>,
    day: u16,
    cap_lamports: u64,
    now: i64,
    slot: u64,
) -> Result<GlobalBudget> {
    let (expected, bump) = Pubkey::find_program_address(
        &[GLOBAL_BUDGET_SEED, &day.to_le_bytes()],
        &crate::ID,
    );
    require!(
        global_budget.key() == expected,
        DiggoError::GlobalCapExceeded
    );

    if global_budget.lamports() == 0 {
        require!(
            global_budget.data_is_empty(),
            DiggoError::GlobalCapExceeded
        );
        let space = GlobalBudget::SIZE;
        let lamports = Rent::get()?.minimum_balance(space);
        let day_bytes = day.to_le_bytes();
        let bump_bytes = [bump];
        let seeds: &[&[u8]] = &[GLOBAL_BUDGET_SEED, &day_bytes, &bump_bytes];
        system_program::create_account(
            CpiContext::new_with_signer(
                system_program.key(),
                system_program::CreateAccount {
                    from: owner.to_account_info(),
                    to: global_budget.to_account_info(),
                },
                &[seeds],
            ),
            lamports,
            space as u64,
            &crate::ID,
        )?;
        let mut opened = GlobalBudget::open(day, cap_lamports, now, slot);
        opened.bump = bump;
        store_global_budget(&global_budget.to_account_info(), &opened)?;
        return Ok(opened);
    }

    require!(
        *global_budget.owner == crate::ID,
        DiggoError::GlobalCapExceeded
    );
    let mut data = global_budget.try_borrow_mut_data()?;
    let budget = GlobalBudget::try_deserialize(&mut &data[..])?;
    require!(
        budget.is_identity_for(day),
        DiggoError::GlobalCapExceeded
    );
    Ok(budget)
}

/// Writes a manually created Anchor account with its discriminator and payload.
fn store_global_budget(info: &AccountInfo, budget: &GlobalBudget) -> Result<()> {
    let mut data = info.try_borrow_mut_data()?;
    let mut cursor = std::io::Cursor::new(&mut data[..]);
    budget.try_serialize(&mut cursor)?;
    Ok(())
}

/// Creates the roll and charges every cap it can charge, while the seed still does not
/// exist.
///
/// Signed by the player, and the only discovery instruction that is. No randomness is
/// requested here: the epoch's seed is armed a whole epoch ahead, so the outcome cannot be
/// known at this point even by the cranker who will reveal it. What is decided here is the
/// reservation - the largest value any tier could pay - which is charged against the
/// account's day and week budgets and against the protocol-wide day, and which is never
/// refunded, not even on expiry. That is what makes the scheme safe under any assumption
/// about when the seed becomes public.
///
/// The opportunity PDA is keyed by the player's own roll window, so a reroll is impossible
/// by construction: the window advances with every roll and the account for the previous one
/// already exists until it is settled or expired.
pub fn create_discovery_roll(ctx: Context<CreateDiscoveryRoll>) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let protocol = &ctx.accounts.protocol;
    let coin = &mut ctx.accounts.coin;
    let player = &mut ctx.accounts.player;
    // Every cap read below comes off the coin's ledger, so the ledger has to be current
    // before any of them is trusted.
    sync_coin_to_now(coin, protocol, now, clock.slot)?;

    require!(
        discovery_is_eligible(player, now),
        DiggoError::NotDiscoveryEligible
    );

    let day = discovery_day_index(now);
    let week = discovery_week_index(now);
    if player.day_index != day {
        player.day_index = day;
        player.spent_day_lamports = 0;
    }
    if player.week_index != week {
        player.week_index = week;
        player.spent_week_lamports = 0;
    }

    let reservation = discovery_reservation_lamports(protocol, coin, clock.slot)?;
    require!(reservation > 0, DiggoError::EpochBudgetExhausted);
    let reserved_units = reserve_discovery_epoch(coin, reservation, clock.slot)?;

    let day_spent = player
        .spent_day_lamports
        .checked_add(reservation)
        .ok_or(DiggoError::MathOverflow)?;
    require!(
        day_spent <= protocol.discovery_daily_cap_lamports,
        DiggoError::DailyCapExceeded
    );
    let week_spent = player
        .spent_week_lamports
        .checked_add(reservation)
        .ok_or(DiggoError::MathOverflow)?;
    require!(
        week_spent <= protocol.discovery_weekly_cap_lamports,
        DiggoError::WeeklyCapExceeded
    );

    let mut global = open_global_budget(
        &ctx.accounts.owner,
        &ctx.accounts.global_budget,
        &ctx.accounts.system_program,
        day,
        protocol.discovery_global_daily_cap_lamports,
        now,
        clock.slot,
    )?;
    global.charge(reservation)?;
    store_global_budget(
        &ctx.accounts.global_budget.to_account_info(),
        &global,
    )?;

    let opportunity = &mut ctx.accounts.opportunity;
    opportunity.coin = coin.key();
    opportunity.owner = ctx.accounts.owner.key();
    // The window the PDA was derived from, and the one the seed derivation will use.
    opportunity.window_index = player.roll_window;
    opportunity.day_index = day;
    opportunity.epoch_index = coin.epoch_index;
    opportunity.budget_lamports = reservation;
    opportunity.reserved_units = reserved_units;
    opportunity.created_at = now;
    opportunity.created_slot = clock.slot;
    opportunity.expires_at = now
        .checked_add(OPPORTUNITY_EXPIRY_SECONDS)
        .ok_or(DiggoError::MathOverflow)?;
    opportunity.status = OPPORTUNITY_PENDING;
    opportunity.rarity = 0;
    opportunity.bump = ctx.bumps.opportunity;
    opportunity.version = ACCOUNT_VERSION;

    player.spent_day_lamports = day_spent;
    player.spent_week_lamports = week_spent;
    player.roll_window = player
        .roll_window
        .checked_add(1)
        .ok_or(DiggoError::MathOverflow)?;
    player.roll_count = player
        .roll_count
        .checked_add(1)
        .ok_or(DiggoError::MathOverflow)?;
    player.last_roll_at = now;

    emit!(DiscoveryRollCreated {
        opportunity: opportunity.key(),
        coin: coin.key(),
        owner: opportunity.owner,
        window_index: opportunity.window_index,
        day_index: day,
    });
    Ok(())
}

/// Permissionless settlement: recomputes the derivation from the recorded seed, pays out of
/// the coin's Discovery Reserve and closes the PDA, refunding its rent to whoever called.
///
/// The roll can only be settled by a seed that was recorded after the roll was created, so
/// the outcome could not have been known when the player committed to it. The value class
/// and the units are recomputed here rather than trusted from anywhere. The value is capped
/// by the reservation frozen at creation, so settlement can neither pay above that
/// reservation nor debit a refreshed epoch's budget.
pub fn settle_discovery(ctx: Context<SettleDiscovery>) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let protocol = &ctx.accounts.protocol;
    let coin = &mut ctx.accounts.coin;
    // Bring price and reserve state current, but do not charge the refreshed epoch again:
    // this opportunity's reservation was consumed in the epoch that created it.
    sync_coin_to_now(coin, protocol, now, clock.slot)?;

    let opportunity = &mut ctx.accounts.opportunity;
    require!(
        opportunity.is_pending(),
        DiggoError::OpportunityAlreadySettled
    );
    require!(!opportunity.is_expired_at(now), DiggoError::OpportunityExpired);
    require!(
        opportunity.is_covered_by(coin.epoch_seed_epoch, coin.epoch_seed_recorded_slot),
        DiggoError::SeedNotCommitted
    );

    let payout = plan_discovery_payout(protocol, coin, opportunity, clock.slot)?;
    if payout.units > 0 {
        require!(
            payout.units <= coin.discovery_remaining,
            DiggoError::InsufficientDiscoveryReserve
        );
        coin.discovery_remaining = coin
            .discovery_remaining
            .checked_sub(payout.units)
            .ok_or(DiggoError::InsufficientDiscoveryReserve)?;
        transfer_from_coin(
            &ctx.accounts.token_program,
            &ctx.accounts.mint,
            &ctx.accounts.vault,
            &ctx.accounts.owner_tokens,
            coin,
            payout.units,
        )?;
    }

    opportunity.status = OPPORTUNITY_SETTLED;
    opportunity.rarity = payout.tier;

    if let Some(global) = ctx.accounts.global_budget.as_mut() {
        if global.is_open_for(opportunity.day_index) {
            global.note_settled()?;
        }
    }

    emit!(DiscoverySettled {
        opportunity: opportunity.key(),
        coin: coin.key(),
        owner: opportunity.owner,
        rarity: payout.tier,
        units: payout.units,
        value_lamports: payout.value_lamports,
    });
    Ok(())
}

/// Permissionless expiry: a pending opportunity past its window is closed, paying nothing and
/// refunding no budget. Charging the budget at creation and paying nothing here is exactly
/// what makes the epoch seed affordable to optimise for, because a wallet that pre-computes a
/// bad outcome and walks away is strictly worse off than one that settles.
///
/// An opportunity the recorded seed can still settle is never expired. Expiry is for a roll
/// whose epoch never got a seed, and closing a settleable one first would deny the player a
/// payout the program owes them.
pub fn expire_opportunity(ctx: Context<ExpireOpportunity>) -> Result<()> {
    let clock = Clock::get()?;
    let coin = &ctx.accounts.coin;
    let opportunity = &mut ctx.accounts.opportunity;
    require!(
        opportunity.is_pending(),
        DiggoError::OpportunityAlreadySettled
    );
    require!(
        opportunity.is_expired_at(clock.unix_timestamp),
        DiggoError::OpportunityExpired
    );
    require!(
        !opportunity.is_covered_by(coin.epoch_seed_epoch, coin.epoch_seed_recorded_slot),
        DiggoError::NotDiscoveryEligible
    );
    opportunity.status = OPPORTUNITY_EXPIRED;
    emit!(DiscoveryExpired {
        opportunity: opportunity.key(),
        coin: coin.key(),
        owner: opportunity.owner,
    });
    Ok(())
}
