//! instructions::admin.rs (phase 0a mechanical split of lib.rs).

use crate::*;



#[derive(Accounts)]
pub struct InitializeProtocol<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: constrained to this executable program's address.
    #[account(address = crate::ID)]
    pub program: UncheckedAccount<'info>,
    #[account(
        constraint = program_data.key() == Pubkey::find_program_address(
            &[crate::ID.as_ref()],
            &anchor_lang::solana_program::bpf_loader_upgradeable::ID,
        ).0 @ DiggoError::InvalidProgramData,
        constraint = program_data.upgrade_authority_address == Some(payer.key()) @ DiggoError::UnauthorizedInitializer,
    )]
    pub program_data: Account<'info, ProgramData>,
    #[account(init, payer = payer, space = 8 + ProtocolConfig::INIT_SPACE, seeds = [b"protocol"], bump)]
    pub protocol: Account<'info, ProtocolConfig>,
    pub system_program: Program<'info, System>,
}


#[derive(Accounts)]
pub struct RotateKeeper<'info> {
    pub keeper: Signer<'info>,
    #[account(mut, seeds = [b"protocol"], bump = protocol.bump, has_one = keeper)]
    pub protocol: Account<'info, ProtocolConfig>,
}


/// Guardian-only layout migration. Like GuardianConfig, this account set holds no mint,
/// token account or vault — and unlike every other instruction it never even touches
/// lamports, so no balance or reserve can move through it.
#[derive(Accounts)]
pub struct MigrateAccount<'info> {
    pub guardian: Signer<'info>,
    /// CHECK: read out of the raw bytes rather than deserialized — the protocol account
    /// is exactly the account that may be awaiting migration. See migrate_account.
    #[account(
        address = Pubkey::find_program_address(&[b"protocol"], &crate::ID).0 @ DiggoError::InvalidAccountLayout,
    )]
    pub protocol: UncheckedAccount<'info>,
    /// CHECK: validated in the handler against the declared kind's discriminator, the
    /// program's own ownership and the current layout size. Its existing bytes are copied
    /// verbatim, so nothing but the trailing version byte can change.
    #[account(mut)]
    pub target: UncheckedAccount<'info>,
}


/// Account set for every guardian-only protocol action (pause flags and bounded
/// parameter updates).
///
/// It holds exactly two accounts: the guardian signer and the config it may edit.
/// There is no mint, token account, vault or lamport-bearing state here, so no
/// instruction built on this struct can ever move a reserve token, LP SOL, or any
/// user balance — the handlers can only assign the flags and bounds below.
#[derive(Accounts)]
pub struct GuardianConfig<'info> {
    pub guardian: Signer<'info>,
    #[account(mut, seeds = [b"protocol"], bump = protocol.bump, has_one = guardian)]
    pub protocol: Account<'info, ProtocolConfig>,
}


/// Guardian-only, single-mine circuit breaker. Same reasoning as GuardianConfig: the
/// scoped pause can only assign one boolean on one Mine account.
#[derive(Accounts)]
pub struct GuardianMineConfig<'info> {
    pub guardian: Signer<'info>,
    #[account(seeds = [b"protocol"], bump = protocol.bump, has_one = guardian)]
    pub protocol: Account<'info, ProtocolConfig>,
    #[account(mut, seeds = [b"mine", mint.key().as_ref()], bump = mine.bump, has_one = mint)]
    pub mine: Account<'info, Mine>,
    pub mint: InterfaceAccount<'info, Mint>,
}


/// Guardian-only guardian rotation (spec 65: scoped, auditable emergency controls).
#[derive(Accounts)]
pub struct RotateGuardian<'info> {
    pub guardian: Signer<'info>,
    #[account(mut, seeds = [b"protocol"], bump = protocol.bump, has_one = guardian)]
    pub protocol: Account<'info, ProtocolConfig>,
}


/// The only state change a protocol pause instruction may perform.
pub fn set_discovery_payouts_paused(protocol: &mut ProtocolConfig, paused: bool) {
    protocol.discovery_payouts_paused = paused;
}


/// The only state change the reward-claims pause instruction may perform.
pub fn set_reward_claims_paused(protocol: &mut ProtocolConfig, paused: bool) {
    protocol.reward_claims_paused = paused;
}


/// The only state change the per-mine pause instruction may perform.
pub fn set_mine_discovery_paused(mine: &mut Mine, paused: bool) {
    mine.discovery_paused = paused;
}


/// Reads ProtocolConfig.guardian out of raw account bytes.
///
/// migrate_account cannot load the protocol account as a typed Account<ProtocolConfig>,
/// because the protocol account is exactly the account that may itself be awaiting migration
/// and is therefore one byte short. This reads the single field the instruction needs, and
/// validates the discriminator on the way so the bytes cannot be from another account type.
pub fn guardian_from_raw_protocol(data: &[u8]) -> Result<Pubkey> {
    require!(
        data.len() >= PROTOCOL_GUARDIAN_OFFSET + 32,
        DiggoError::InvalidAccountLayout
    );
    require!(
        &data[..8] == ProtocolConfig::DISCRIMINATOR,
        DiggoError::InvalidAccountLayout
    );
    let bytes: [u8; 32] = data[PROTOCOL_GUARDIAN_OFFSET..PROTOCOL_GUARDIAN_OFFSET + 32]
        .try_into()
        .map_err(|_| error!(DiggoError::InvalidAccountLayout))?;
    Ok(Pubkey::new_from_array(bytes))
}


/// (discriminator, current on-chain size) for one migratable account kind. Deriving the
/// expected size here rather than taking it from the caller is what stops a migration
/// from being pointed at a layout the program does not actually know.
pub fn account_layout(kind: u8) -> Result<(&'static [u8], usize)> {
    match kind {
        ACCOUNT_KIND_PROTOCOL => Ok((ProtocolConfig::DISCRIMINATOR, 8 + ProtocolConfig::INIT_SPACE)),
        ACCOUNT_KIND_MINE => Ok((Mine::DISCRIMINATOR, 8 + Mine::INIT_SPACE)),
        ACCOUNT_KIND_MARKET => Ok((LaunchMarket::DISCRIMINATOR, 8 + LaunchMarket::INIT_SPACE)),
        _ => Err(error!(DiggoError::UnsupportedAccountKind)),
    }
}


/// Byte-exact account upgrade.
///
/// The account's own values are read back out of its data and re-serialized, with only the
/// fields an upgrade appended set to the safe default. Borsh is deterministic, so every
/// field that already existed keeps its exact bytes and nothing derived from a lamport
/// balance, a reserve or a fee bucket is ever recomputed — the only new byte is the
/// appended version.
///
/// Fields added after the version byte come out as their safe default, which is what makes
/// a later layout change compatible in one direction only: LaunchMarket's curve-mining
/// ledger reads as a zero budget on an account written before it existed, so a migration
/// can never hand a legacy market an emission allowance it was not launched with.
///
/// Re-serializing rather than writing a fixed offset matters: Mine has variable-length
/// name, symbol and uri fields, so its account is allocated for the maximum lengths and the
/// serialized payload is usually shorter than the buffer. A fixed tail write would land in
/// padding and the version would still read as 0. The data is padded for reading because the
/// appended field lives past the end of what the account currently holds.
pub fn upgraded_account_data(kind: u8, old: &[u8], new_len: usize) -> Result<Vec<u8>> {
    let (discriminator, expected_len) = account_layout(kind)?;
    require!(new_len == expected_len, DiggoError::InvalidAccountLayout);
    require!(old.len() >= 8, DiggoError::InvalidAccountLayout);
    require!(&old[..8] == discriminator, DiggoError::InvalidAccountLayout);
    require!(old.len() < new_len, DiggoError::AccountAlreadyCurrent);

    // Padded to the account's full new size rather than by a fixed slack: the fields a
    // legacy account is missing are appended after its version byte, and how many there are
    // is a property of the current layout, not of this function.
    let mut padded = old.to_vec();
    padded.resize(new_len, 0);
    let payload = match kind {
        ACCOUNT_KIND_PROTOCOL => {
            let mut value = ProtocolConfig::try_deserialize(&mut &padded[..])?;
            value.version = ACCOUNT_VERSION;
            borsh::to_vec(&value).map_err(|_| error!(DiggoError::InvalidAccountLayout))?
        }
        ACCOUNT_KIND_MINE => {
            let mut value = Mine::try_deserialize(&mut &padded[..])?;
            value.version = ACCOUNT_VERSION;
            borsh::to_vec(&value).map_err(|_| error!(DiggoError::InvalidAccountLayout))?
        }
        ACCOUNT_KIND_MARKET => {
            let mut value = LaunchMarket::try_deserialize(&mut &padded[..])?;
            value.version = ACCOUNT_VERSION;
            borsh::to_vec(&value).map_err(|_| error!(DiggoError::InvalidAccountLayout))?
        }
        _ => return Err(error!(DiggoError::UnsupportedAccountKind)),
    };

    require!(
        8 + payload.len() <= new_len,
        DiggoError::InvalidAccountLayout
    );
    let mut out = vec![0u8; new_len];
    out[..8].copy_from_slice(discriminator);
    out[8..8 + payload.len()].copy_from_slice(&payload);
    Ok(out)
}

pub fn initialize_protocol(
    ctx: Context<InitializeProtocol>,
    treasury: Pubkey,
    keeper: Pubkey,
) -> Result<()> {
    require!(treasury != Pubkey::default(), DiggoError::InvalidTreasury);
    require!(keeper != Pubkey::default(), DiggoError::InvalidKeeper);
    let protocol = &mut ctx.accounts.protocol;
    protocol.treasury = treasury;
    protocol.keeper = keeper;
    // The deployer (program upgrade authority) is the initial circuit-breaker
    // guardian and can hand the role over with rotate_guardian.
    protocol.guardian = ctx.accounts.payer.key();
    protocol.reserve_bps = DEFAULT_RESERVE_BPS;
    protocol.discovery_reserve_bps = DEFAULT_DISCOVERY_RESERVE_BPS;
    protocol.creator_fee_bps = DEFAULT_CREATOR_FEE_BPS;
    protocol.platform_fee_bps = DEFAULT_PLATFORM_FEE_BPS;
    protocol.max_crew_power = DEFAULT_MAX_CREW_POWER;
    protocol.max_power_increase_bps = DEFAULT_MAX_POWER_INCREASE_BPS;
    protocol.discovery_max_bps = DEFAULT_DISCOVERY_MAX_BPS;
    protocol.discovery_epoch_budget_bps = DEFAULT_DISCOVERY_EPOCH_BUDGET_BPS;
    protocol.discovery_payouts_paused = false;
    protocol.reward_claims_paused = false;
    protocol.bump = ctx.bumps.protocol;
    protocol.version = ACCOUNT_VERSION;
    Ok(())
}

/// Rotates the backend keeper key without touching treasury, reserves or any
/// player balance. Only the current keeper can hand off to a new one.
pub fn rotate_keeper(ctx: Context<RotateKeeper>, new_keeper: Pubkey) -> Result<()> {
    require!(new_keeper != Pubkey::default(), DiggoError::InvalidKeeper);
    ctx.accounts.protocol.keeper = new_keeper;
    Ok(())
}

/// Hands the circuit-breaker role to another key. Only the current guardian may do
/// this, and GuardianRotated keeps every hand-off auditable on-chain.
pub fn rotate_guardian(ctx: Context<RotateGuardian>, new_guardian: Pubkey) -> Result<()> {
    require!(new_guardian != Pubkey::default(), DiggoError::InvalidGuardian);
    let protocol = &mut ctx.accounts.protocol;
    let previous_guardian = protocol.guardian;
    protocol.guardian = new_guardian;
    emit!(GuardianRotated {
        previous_guardian,
        guardian: new_guardian,
    });
    Ok(())
}

/// Protocol-wide circuit breaker (spec 65): stops every discovery payout while
/// paused is true. Trading is untouched. The handler assigns one boolean and
/// nothing else — its account set holds no mint, token account or vault, so no
/// instruction built on it can ever move a reserve token.
pub fn pause_discovery_payouts(ctx: Context<GuardianConfig>, paused: bool) -> Result<()> {
    let protocol = &mut ctx.accounts.protocol;
    set_discovery_payouts_paused(protocol, paused);
    emit!(PauseFlagsUpdated {
        guardian: protocol.guardian,
        discovery_payouts_paused: protocol.discovery_payouts_paused,
        reward_claims_paused: protocol.reward_claims_paused,
    });
    Ok(())
}

/// Protocol-wide circuit breaker (spec 65): stops every claim_rewards while paused
/// is true. Trading is untouched.
pub fn pause_reward_claims(ctx: Context<GuardianConfig>, paused: bool) -> Result<()> {
    let protocol = &mut ctx.accounts.protocol;
    set_reward_claims_paused(protocol, paused);
    emit!(PauseFlagsUpdated {
        guardian: protocol.guardian,
        discovery_payouts_paused: protocol.discovery_payouts_paused,
        reward_claims_paused: protocol.reward_claims_paused,
    });
    Ok(())
}

/// Circuit breaker scoped to a single mine's Discovery Reserve (spec 65).
pub fn pause_mine_discovery(ctx: Context<GuardianMineConfig>, paused: bool) -> Result<()> {
    let mine = &mut ctx.accounts.mine;
    set_mine_discovery_paused(mine, paused);
    emit!(MineDiscoveryPauseUpdated {
        guardian: ctx.accounts.guardian.key(),
        mint: mine.mint,
        discovery_paused: mine.discovery_paused,
    });
    Ok(())
}

/// Sets the bounded keeper power rule: a ceiling on Crew Power the keeper may ever
/// push, plus a per-call increase bound. Both are clamped to protocol constants, so
/// neither can be configured away.
pub fn update_power_bounds(
    ctx: Context<GuardianConfig>,
    max_crew_power: u64,
    max_power_increase_bps: u16,
) -> Result<()> {
    require!(
        max_crew_power > 0 && max_crew_power <= MAX_CREW_POWER_HARD_CAP,
        DiggoError::InvalidPowerBounds
    );
    require!(
        max_power_increase_bps > 0 && max_power_increase_bps <= MAX_POWER_INCREASE_BPS,
        DiggoError::InvalidPowerBounds
    );
    let protocol = &mut ctx.accounts.protocol;
    protocol.max_crew_power = max_crew_power;
    protocol.max_power_increase_bps = max_power_increase_bps;
    emit!(PowerBoundsUpdated {
        guardian: protocol.guardian,
        max_crew_power,
        max_power_increase_bps,
    });
    Ok(())
}

/// Sets the default trading fee schedule. Existing markets keep the schedule they
/// snapshotted at launch, so a change here can never retroactively alter a live
/// market, and both fees stay capped at MAX_TRADING_FEE_BPS.
pub fn update_fee_config(
    ctx: Context<GuardianConfig>,
    creator_fee_bps: u16,
    platform_fee_bps: u16,
) -> Result<()> {
    require!(
        creator_fee_bps <= MAX_TRADING_FEE_BPS && platform_fee_bps <= MAX_TRADING_FEE_BPS,
        DiggoError::FeeTooHigh
    );
    let protocol = &mut ctx.accounts.protocol;
    protocol.creator_fee_bps = creator_fee_bps;
    protocol.platform_fee_bps = platform_fee_bps;
    emit!(FeeConfigUpdated {
        guardian: protocol.guardian,
        creator_fee_bps,
        platform_fee_bps,
    });
    Ok(())
}

/// Tunes the discovery spend limits used by mines launched from now on. Existing
/// mines keep the budget they snapshotted at launch; the guardian can always stop
/// them outright with pause_mine_discovery.
pub fn update_discovery_limits(
    ctx: Context<GuardianConfig>,
    discovery_max_bps: u16,
    discovery_epoch_budget_bps: u16,
) -> Result<()> {
    require!(
        discovery_max_bps > 0 && discovery_max_bps <= MAX_DISCOVERY_MAX_BPS,
        DiggoError::DiscoveryLimitsOutOfRange
    );
    require!(
        discovery_epoch_budget_bps > 0
            && discovery_epoch_budget_bps <= MAX_DISCOVERY_EPOCH_BUDGET_BPS,
        DiggoError::DiscoveryLimitsOutOfRange
    );
    require!(
        discovery_max_bps <= discovery_epoch_budget_bps,
        DiggoError::DiscoveryLimitsOutOfRange
    );
    let protocol = &mut ctx.accounts.protocol;
    protocol.discovery_max_bps = discovery_max_bps;
    protocol.discovery_epoch_budget_bps = discovery_epoch_budget_bps;
    emit!(DiscoveryLimitsUpdated {
        guardian: protocol.guardian,
        discovery_max_bps,
        discovery_epoch_budget_bps,
    });
    Ok(())
}

/// Guardian-only layout upgrade for one program-owned config, mine or market account.
///
/// It reallocates the account to the current size and stamps the trailing version
/// byte; every byte that already existed is copied verbatim, so no balance, reserve,
/// fee bucket or timestamp can move. The account must already hold enough lamports for
/// its new rent-exempt minimum — top it up with a plain system transfer first, because
/// this instruction deliberately never touches lamports at all.
pub fn migrate_account(ctx: Context<MigrateAccount>, kind: u8) -> Result<()> {
    let (discriminator, new_len) = account_layout(kind)?;
    // Guardian-only, and read out of the raw protocol bytes rather than deserialized: the
    // protocol account is the one account that may itself be awaiting migration, so it
    // cannot be loaded as a typed Account<ProtocolConfig> while it is still short.
    {
        let protocol = ctx.accounts.protocol.to_account_info();
        let data = protocol.try_borrow_data()?;
        require!(
            guardian_from_raw_protocol(&data)? == ctx.accounts.guardian.key(),
            DiggoError::InvalidGuardian
        );
    }
    let target = ctx.accounts.target.to_account_info();
    require!(target.owner == &crate::ID, DiggoError::InvalidAccountLayout);
    let old_len = target.data_len();
    require!(old_len >= 8, DiggoError::InvalidAccountLayout);
    {
        let data = target.try_borrow_data()?;
        require!(&data[..8] == discriminator, DiggoError::InvalidAccountLayout);
    }
    require!(old_len < new_len, DiggoError::AccountAlreadyCurrent);
    require!(
        target.lamports() >= Rent::get()?.minimum_balance(new_len),
        DiggoError::MigrationNeedsFunding
    );

    // Snapshot the old payload, reallocate, then rewrite the whole buffer from the tested
    // transform: the account's own values re-serialized, with only the appended version
    // byte new and the tail beyond the payload zero-filled.
    let snapshot = target.try_borrow_data()?.to_vec();
    // resize zero-extends the account in place, which is exactly the append-only shape
    // this migration needs.
    target.resize(new_len)?;
    let upgraded = upgraded_account_data(kind, &snapshot, new_len)?;
    target.try_borrow_mut_data()?.copy_from_slice(&upgraded);

    emit!(AccountMigrated {
        account: target.key(),
        kind,
        from_len: old_len as u32,
        to_len: new_len as u32,
        version: ACCOUNT_VERSION,
    });
    Ok(())
}
