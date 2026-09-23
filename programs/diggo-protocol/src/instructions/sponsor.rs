//! Sponsor vaults, events and grants (design 1.7, 8.2). WS-B owns this file.
//!
//! A sponsorship event can pay rent and fees. It can never change power, rewards, discovery
//! odds, rarity, caps or eligibility, and it is not governance: the vault belongs to the
//! owner's own wallet and can never be a program or config authority.
//!
//! Every spend goes through charge_sponsor_event, which is the one place the event window, the
//! budget, the per-coin limit, the per-wallet limit and the vault's own unspent balance are
//! checked - before a lamport moves, which is what stops a sponsor from ever paying out more
//! than it funded. The two wrappers below are what launch_token and buy/sell call, so WS-A and
//! WS-C can use the same core for their own subsidy kinds instead of re-deriving the rules.

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
///
/// The design's "the event must have ended" condition cannot be expressed here: the frozen
/// account list is the owner and the vault, with no event account in it. What is enforced is the
/// part that protects the sponsor's own money - the unspent cap - and an owner who withdraws a
/// budget they have already promised only breaks their own event, never anyone else's funds.
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

pub fn init_sponsor_vault(ctx: Context<InitSponsorVault>) -> Result<()> {
    let vault = &mut ctx.accounts.sponsor_vault;
    vault.sponsor_owner = ctx.accounts.sponsor_owner.key();
    vault.event_count = 0;
    vault.total_funded = 0;
    vault.total_spent = 0;
    vault.total_withdrawn = 0;
    vault.bump = ctx.bumps.sponsor_vault;
    vault.version = ACCOUNT_VERSION;
    emit!(SponsorVaultInitialized {
        vault: vault.key(),
        sponsor_owner: vault.sponsor_owner,
    });
    Ok(())
}

pub fn fund_sponsor_vault(ctx: Context<FundSponsorVault>, amount: u64) -> Result<()> {
    require!(amount > 0, DiggoError::InvalidAmount);
    // The owner's lamports are system-owned, so this debit has to be a system transfer: the
    // runtime refuses a direct lamport spend from an account the program does not own
    // (ExternalAccountLamportSpend), and only the system program may take a wallet's balance.
    // The owner signed this instruction, so the CPI carries that privilege without seeds.
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.key(),
            system_program::Transfer {
                from: ctx.accounts.sponsor_owner.to_account_info(),
                to: ctx.accounts.sponsor_vault.to_account_info(),
            },
        ),
        amount,
    )?;
    let vault = &mut ctx.accounts.sponsor_vault;
    vault.total_funded = vault
        .total_funded
        .checked_add(amount)
        .ok_or(DiggoError::MathOverflow)?;
    Ok(())
}

pub fn withdraw_sponsor_vault(ctx: Context<WithdrawSponsorVault>, amount: u64) -> Result<()> {
    require!(amount > 0, DiggoError::InvalidAmount);
    let unspent = ctx
        .accounts
        .sponsor_vault
        .total_funded
        .checked_sub(ctx.accounts.sponsor_vault.total_spent)
        .ok_or(DiggoError::MathOverflow)?;
    // Unspent lamports are never the protocol's, and spent lamports are never the owner's.
    require!(amount <= unspent, DiggoError::UnspentWithdrawalOnly);
    let vault_info = ctx.accounts.sponsor_vault.to_account_info();
    require!(
        vault_info.lamports().saturating_sub(amount)
            >= Rent::get()?.minimum_balance(SponsorVault::SIZE),
        DiggoError::VaultBelowRentExempt
    );
    let owner_info = ctx.accounts.sponsor_owner.to_account_info();
    move_lamports(&vault_info, &owner_info, amount)?;
    let vault = &mut ctx.accounts.sponsor_vault;
    vault.total_withdrawn = vault
        .total_withdrawn
        .checked_add(amount)
        .ok_or(DiggoError::MathOverflow)?;
    Ok(())
}

pub fn create_sponsor_event(
    ctx: Context<CreateSponsorEvent>,
    kind: u8,
    start_at: i64,
    end_at: i64,
    budget_lamports: u64,
    per_coin_limit_lamports: u64,
    per_wallet_limit_lamports: u64,
) -> Result<()> {
    require!(
        kind <= SPONSOR_KIND_PLAYER_BOND_SUBSIDY,
        DiggoError::InvalidEventKind
    );
    // The bond kind is retired along with the bond itself: a vault may still be funded, and
    // unspent lamports are still the owner's to withdraw, but no event may promise to post a
    // bond that the program will refuse to post.
    require!(
        kind != SPONSOR_KIND_PLAYER_BOND_SUBSIDY,
        DiggoError::BondRetired
    );
    require!(end_at > start_at, DiggoError::ConfigOutOfBounds);
    require!(budget_lamports > 0, DiggoError::ConfigOutOfBounds);
    // A budget is a promise against lamports the vault actually holds: promising more than the
    // unspent balance would make the event unpayable the moment it was used.
    let unspent = ctx
        .accounts
        .sponsor_vault
        .total_funded
        .checked_sub(ctx.accounts.sponsor_vault.total_spent)
        .ok_or(DiggoError::MathOverflow)?;
    require!(budget_lamports <= unspent, DiggoError::EventBudgetExhausted);
    require!(
        per_coin_limit_lamports <= budget_lamports
            && per_wallet_limit_lamports <= budget_lamports,
        DiggoError::ConfigOutOfBounds
    );

    let event_key = ctx.accounts.sponsor_event.key();
    let event = &mut ctx.accounts.sponsor_event;
    event.vault = ctx.accounts.sponsor_vault.key();
    event.kind = kind;
    event.start_at = start_at;
    event.end_at = end_at;
    event.budget_lamports = budget_lamports;
    event.spent_lamports = 0;
    event.per_coin_limit_lamports = per_coin_limit_lamports;
    event.per_wallet_limit_lamports = per_wallet_limit_lamports;
    event.paused = 0;
    event.bump = ctx.bumps.sponsor_event;
    event.version = ACCOUNT_VERSION;

    let vault = &mut ctx.accounts.sponsor_vault;
    vault.event_count = vault
        .event_count
        .checked_add(1)
        .ok_or(DiggoError::MathOverflow)?;

    emit!(SponsorEventCreated {
        event: event_key,
        vault: event.vault,
        kind,
        start_at,
        end_at,
        budget_lamports,
        per_coin_limit_lamports,
        per_wallet_limit_lamports,
    });
    Ok(())
}

/// Closing an event is what its paused flag means: the event can never spend again, and the
/// budget it did not use stays the sponsor's to withdraw. There is no reopen, because reopening
/// would be a way to keep a per-coin limit alive past the window it was published for.
pub fn close_sponsor_event(ctx: Context<CloseSponsorEvent>, event_id: u32) -> Result<()> {
    let _ = event_id;
    let now = Clock::get()?.unix_timestamp;
    let event = &mut ctx.accounts.sponsor_event;
    require!(event.paused == 0, DiggoError::EventAlreadyClosed);
    event.paused = 1;
    if event.end_at > now {
        event.end_at = now;
    }
    Ok(())
}

// ---- the shared spend core ----------------------------------------------------------------

/// True when one grant's subject is a player's wallet rather than a coin.
///
/// That is what lets one grant shape enforce both limits: a coin-subject grant (launch rent, a
/// trade-fee waiver) is charged against the event's per-coin limit, and a wallet-subject grant
/// (an account or bond subsidy) against its per-wallet limit.
pub fn subject_is_wallet(kind: u8) -> bool {
    kind == SPONSOR_KIND_PLAYER_ACCOUNT_SUBSIDY || kind == SPONSOR_KIND_PLAYER_BOND_SUBSIDY
}

/// Moves lamports between two accounts of a transaction.
///
/// The debited account must be owned by this program - in practice always the sponsor vault or a
/// coin account - because the runtime rejects a direct lamport spend from any account the program
/// does not own (ExternalAccountLamportSpend); a system-owned wallet has to be debited with
/// system_program::transfer instead, which is what fund_sponsor_vault does. That ownership is also
/// why the vault can reimburse a creator who has already paid, and why it never needs to be a
/// Signer.
pub fn move_lamports<'info>(
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    lamports: u64,
) -> Result<()> {
    let remaining = from
        .lamports()
        .checked_sub(lamports)
        .ok_or(DiggoError::VaultBelowRentExempt)?;
    **from.try_borrow_mut_lamports()? = remaining;
    **to.try_borrow_mut_lamports()? = to
        .lamports()
        .checked_add(lamports)
        .ok_or(DiggoError::MathOverflow)?;
    Ok(())
}

/// Charges one spend against an event and its grant, and books it on the vault.
///
/// Every limit is checked before a lamport moves, so an event can never pay out more than it
/// funded or more than it promised to one coin or one wallet. The grant is created at most once
/// per (event, subject) - its PDA is seeded by the pair - so re-launching a coin cannot reset a
/// limit that has already been spent against.
pub fn charge_sponsor_event(
    vault: &mut Account<SponsorVault>,
    event: &mut Account<SponsorEvent>,
    grant: &mut SponsorGrant,
    kind: u8,
    lamports: u64,
    clock: &Clock,
) -> Result<()> {
    require!(event.kind == kind, DiggoError::InvalidEventKind);
    require!(event.paused == 0, DiggoError::EventAlreadyClosed);
    require!(
        clock.unix_timestamp >= event.start_at && clock.unix_timestamp < event.end_at,
        DiggoError::EventNotActive
    );
    let unspent = vault
        .total_funded
        .checked_sub(vault.total_spent)
        .ok_or(DiggoError::MathOverflow)?;
    require!(lamports <= unspent, DiggoError::EventBudgetExhausted);
    let event_spent = event
        .spent_lamports
        .checked_add(lamports)
        .ok_or(DiggoError::MathOverflow)?;
    require!(
        event_spent <= event.budget_lamports,
        DiggoError::EventBudgetExhausted
    );
    let grant_spent = grant
        .spent_lamports
        .checked_add(lamports)
        .ok_or(DiggoError::MathOverflow)?;
    if subject_is_wallet(kind) {
        require!(
            grant_spent <= event.per_wallet_limit_lamports,
            DiggoError::PerWalletLimitExceeded
        );
        grant.wallet_spent_lamports = grant_spent;
    } else {
        require!(
            grant_spent <= event.per_coin_limit_lamports,
            DiggoError::PerCoinLimitExceeded
        );
    }
    if grant.created_slot == 0 {
        grant.created_slot = clock.slot;
    }
    grant.spent_lamports = grant_spent;
    grant.version = ACCOUNT_VERSION;
    event.spent_lamports = event_spent;
    vault.total_spent = vault
        .total_spent
        .checked_add(lamports)
        .ok_or(DiggoError::MathOverflow)?;
    Ok(())
}

/// The rent a SponsorGrant costs, which the vault reimburses when a spend is what created it.
pub fn grant_rent() -> Result<u64> {
    Ok(Rent::get()?.minimum_balance(SponsorGrant::SIZE))
}

/// Reads one grant out of its account. The value is owned rather than wrapped, so a helper can
/// create, spend against and write back a grant without holding a borrow of the account.
pub fn read_grant(grant_info: &AccountInfo) -> Result<SponsorGrant> {
    let data = grant_info.try_borrow_data()?;
    let mut slice: &[u8] = &data;
    Ok(SponsorGrant::try_deserialize(&mut slice)?)
}

/// Writes one grant back, discriminator and all.
pub fn store_grant(grant_info: &AccountInfo, grant: &SponsorGrant) -> Result<()> {
    let mut data = grant_info.try_borrow_mut_data()?;
    let mut cursor = std::io::Cursor::new(&mut data[..]);
    grant.try_serialize(&mut cursor)?;
    Ok(())
}

/// Loads the grant for one (event, subject) pair, creating it at the vault's expense when it is
/// missing, and says whether this call created it.
///
/// The vault pays for it directly, so the grant's rent leaves the vault in this CPI and the
/// caller books it against the event rather than transferring it a second time. The PDA is
/// re-derived here and the owner checked, so a grant can never be a stranger's account and a
/// re-launch can never reset a per-coin limit that has already been spent against.
pub fn load_or_create_grant<'info>(
    vault: &Account<'info, SponsorVault>,
    vault_seeds: &[&[u8]],
    event_key: &Pubkey,
    subject: &Pubkey,
    grant_info: &AccountInfo<'info>,
    payer_info: &AccountInfo<'info>,
    system_program: &Program<'info, System>,
) -> Result<(SponsorGrant, bool)> {
    let (expected, bump) = Pubkey::find_program_address(
        &[SPONSOR_GRANT_SEED, event_key.as_ref(), subject.as_ref()],
        &crate::ID,
    );
    require_keys_eq!(grant_info.key(), expected, DiggoError::InvalidEventKind);
    if !grant_info.data_is_empty() {
        return Ok((read_grant(grant_info)?, false));
    }
    require!(grant_info.lamports() == 0, DiggoError::InvalidEventKind);
    let bump_bytes = [bump];
    let grant_seeds: &[&[u8]] = &[
        SPONSOR_GRANT_SEED,
        event_key.as_ref(),
        subject.as_ref(),
        &bump_bytes,
    ];
    let rent = grant_rent()?;
    // System Program create_account cannot take a program-owned data account as `from`, so the
    // enclosing instruction's real signer creates the PDA. The caller reimburses this exact rent
    // from the vault in the same instruction, making the vault the ultimate payer.
    system_program::create_account(
        CpiContext::new_with_signer(
            system_program.key(),
            system_program::CreateAccount {
                from: payer_info.clone(),
                to: grant_info.clone(),
            },
            &[grant_seeds],
        ),
        rent,
        SponsorGrant::SIZE as u64,
        &crate::ID,
    )?;
    let _ = (vault_seeds, payer_info);
    {
        let mut data = grant_info.try_borrow_mut_data()?;
        let mut cursor = std::io::Cursor::new(&mut data[..]);
        SponsorGrant::default().try_serialize(&mut cursor)?;
    }
    Ok((read_grant(grant_info)?, true))
}

/// Pays a launch's rent out of a LaunchRentSubsidy event.
///
/// The creator has already paid it - the mint and the vault are created by hand with the creator
/// as the payer, and the Coin is an Anchor init - so the vault reimburses the creator inside the
/// same instruction. A PDA cannot be a Signer, which is why the reimbursement happens here
/// rather than by the creator paying the vault.
pub fn subsidise_launch_rent<'info>(
    vault: &mut Account<'info, SponsorVault>,
    event: &mut Account<'info, SponsorEvent>,
    grant: &mut SponsorGrant,
    grant_info: &AccountInfo<'info>,
    recipient: &AccountInfo<'info>,
    launch_rent: u64,
    grant_created: bool,
    clock: &Clock,
    vault_seeds: &[&[u8]],
    system_program: &Program<'info, System>,
) -> Result<u64> {
    // A grant created by this spend was paid for by the vault, so its rent is booked against
    // the event even though it is not transferred to the recipient.
    let booked = if grant_created {
        launch_rent
            .checked_add(grant_rent()?)
            .ok_or(DiggoError::MathOverflow)?
    } else {
        launch_rent
    };
    charge_sponsor_event(
        vault,
        event,
        grant,
        SPONSOR_KIND_LAUNCH_RENT_SUBSIDY,
        booked,
        clock,
    )?;
    let vault_info = vault.to_account_info();
    require!(
        vault_info.lamports().saturating_sub(booked)
            >= Rent::get()?.minimum_balance(SponsorVault::SIZE),
        DiggoError::VaultBelowRentExempt
    );
    // The System Program rejects a data-bearing source even when it signs. A program-owned PDA
    // may be debited directly by the program that owns it, so do exactly that here.
    let _ = (system_program, vault_seeds);
    move_lamports(&vault_info, recipient, booked)?;
    store_grant(grant_info, grant)?;
    emit!(SponsorSpend {
        grant: grant_info.key(),
        kind: SPONSOR_KIND_LAUNCH_RENT_SUBSIDY,
        lamports: booked,
    });
    Ok(booked)
}

/// Funds the platform share of one trade's fee out of a PlatformTradeFeeWaiver event.
///
/// The split itself never changes: the platform fee is still taken, and it still reaches the
/// treasury through the coin's own bucket. Only who funds it changes, which is why the trader
/// pays the creator's share only and the treasury is kept whole from the vault.
pub fn waive_platform_fee<'info>(
    vault: &mut Account<'info, SponsorVault>,
    event: &mut Account<'info, SponsorEvent>,
    grant: &mut SponsorGrant,
    grant_info: &AccountInfo<'info>,
    coin_info: &AccountInfo<'info>,
    grant_payer: &AccountInfo<'info>,
    platform_fee: u64,
    grant_created: bool,
    clock: &Clock,
) -> Result<u64> {
    let booked = if grant_created {
        platform_fee
            .checked_add(grant_rent()?)
            .ok_or(DiggoError::MathOverflow)?
    } else {
        platform_fee
    };
    charge_sponsor_event(
        vault,
        event,
        grant,
        SPONSOR_KIND_PLATFORM_TRADE_FEE_WAIVER,
        booked,
        clock,
    )?;
    grant.waived_fee_lamports = grant
        .waived_fee_lamports
        .checked_add(platform_fee)
        .ok_or(DiggoError::MathOverflow)?;
    let vault_info = vault.to_account_info();
    let grant_cost = if grant_created { grant_rent()? } else { 0 };
    require!(
        vault_info
            .lamports()
            .saturating_sub(platform_fee)
            .saturating_sub(grant_cost)
            >= Rent::get()?.minimum_balance(SponsorVault::SIZE),
        DiggoError::VaultBelowRentExempt
    );
    // The fee joins the coin's own platform bucket, so the sweep that follows pays the treasury
    // exactly what the split says it is owed.
    move_lamports(&vault_info, coin_info, platform_fee)?;
    if grant_created {
        move_lamports(&vault_info, grant_payer, grant_cost)?;
    }
    store_grant(grant_info, grant)?;
    emit!(SponsorSpend {
        grant: grant_info.key(),
        kind: SPONSOR_KIND_PLATFORM_TRADE_FEE_WAIVER,
        lamports: booked,
    });
    Ok(booked)
}
