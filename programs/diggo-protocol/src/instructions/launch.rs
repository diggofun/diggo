//! Launch (design 1.3, 1.4, 8.2). WS-B owns this file.
//!
//! One coin is three accounts - the mint, the Coin and one token vault - and this instruction
//! creates all three, so a launch is one transaction and the creator pays its rent. The mint is
//! a Token-2022 mint carrying the metadata pointer and the token-metadata extension, created by
//! hand at its computed size rather than by Anchor's `init`: `mint::decimals` always makes an
//! 82-byte mint, and the metadata could never live in it.
//!
//! The vault is created by hand for the same reason the mint is: Anchor evaluates every account
//! constraint before the handler body runs, so a vault declared with `token::mint = mint` would
//! be initialized before the mint exists. It is an UncheckedAccount with a seeds constraint and
//! is re-loaded as a typed token account for the ledger assertion, so nothing about it is
//! unchecked in practice.

use crate::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token_interface::spl_token_2022::extension::metadata_pointer::instruction as metadata_pointer_ix;
use anchor_spl::token_2022_extensions::spl_token_metadata_interface::instruction as token_metadata_ix;
use anchor_spl::token_interface::spl_token_2022::instruction as token_ix;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct LaunchTokenArgs {
    pub nonce: u8,
    pub decimals: u8,
    pub name: String,
    pub symbol: String,
    pub uri: String,
    pub total_supply: u64,
    pub reserve_bps: u16,
    pub discovery_reserve_bps: u16,
    pub curve_mining_bps: u16,
    pub curve_mining_runway_days: u16,
    pub creator_fee_bps: u16,
    pub platform_fee_bps: u16,
    pub graduation_target: u64,
    pub block_interval: u32,
    pub epoch_length: u32,
    pub reduction_bps: u16,
    pub minimum_reward: u64,
}

/// The space a Token-2022 mint is created at, before its metadata exists.
///
/// Token-2022's InitializeMint2 requires the account's length to equal exactly what its current
/// extensions add up to, and the metadata-pointer extension has to be initialized before the
/// mint is, so the token-metadata extension cannot be pre-allocated: the mint is created with
/// room for the base region, its account-type byte and the metadata pointer, and the
/// token-metadata CPI reallocs it to its settled size once the metadata is written.
///
/// The base region is MINT_BASE_SIZE, which is 165 and not the mint's own 82: token-2022 8.0.1
/// keeps the account-type byte at `Account::LEN` for mints and token accounts alike, so the 82
/// bytes of mint state are followed by 83 zero bytes of padding, and only then the byte and the
/// TLV data. That is the number MetadataPointerInstruction::Initialize checks - it reads the
/// account type at `Account::LEN - Mint::LEN` and refuses a buffer that ends before it - so
/// allocating 82 + 1 + 68 = 151 made every launch fail there with InvalidAccountData. 234 is both
/// the minimum and the exact size InitializeMint2 accepts.
pub const MINT_INITIAL_SIZE: usize =
    MINT_BASE_SIZE + MINT_ACCOUNT_TYPE_SIZE + MINT_METADATA_POINTER_SIZE;

/// The fixed part of one token-metadata entry: the TLV header, the update authority, the mint,
/// the three string lengths and the empty additional-metadata vector.
pub const MINT_TOKEN_METADATA_FIXED: usize = 4 + 32 + 32 + 4 + 4 + 4 + 4;

/// The space one mint settles at once its metadata is written. For a maximal metadata (16/8/96)
/// this is exactly MINT_V2_SIZE, which is what the frozen size now means: the caps are the layout,
/// so the account the creator funds and the account the mint settles at are the same number. A
/// shorter metadata settles smaller and the difference is reallocated away, which is why the
/// funding is the maximum and never a headroom.
pub fn mint_settled_size(name: &str, symbol: &str, uri: &str) -> usize {
    MINT_INITIAL_SIZE + MINT_TOKEN_METADATA_FIXED + name.len() + symbol.len() + uri.len()
}

/// The share of the graduation target the curve starts with as a virtual SOL reserve.
///
/// The frozen LaunchTokenArgs has no field for it and it has to be derived from something: a
/// curve with no virtual depth prices its first lamport at nothing. 3,500 bps of the target is
/// the shape the off-chain fixtures already assume - an 85 SOL target, about 30 SOL of depth.
pub const DEFAULT_VIRTUAL_SOL_BPS: u16 = 3_500;

/// The initial per-block reward of a coin's Mining Reserve: the reserve spread over the blocks
/// of one epoch, floored at the launch's minimum reward.
pub fn initial_block_reward(
    reserve_remaining: u64,
    epoch_length: u32,
    block_interval: u32,
    minimum_reward: u64,
) -> Result<u64> {
    require!(
        block_interval > 0 && epoch_length > 0,
        DiggoError::InvalidSchedule
    );
    let blocks = (epoch_length / block_interval).max(1) as u64;
    Ok((reserve_remaining / blocks).max(minimum_reward))
}

/// One coin is three accounts: the mint, the Coin and one token vault.
///
/// The mint is created by hand in the handler rather than by Anchor's `init`, because a
/// Token-2022 mint carrying the metadata pointer and the token-metadata extension has to be
/// created at its computed size (design 1.3(c)): `mint::decimals` would always make an
/// 82-byte mint and the metadata could never live in it.
#[derive(Accounts)]
#[instruction(args: LaunchTokenArgs)]
pub struct LaunchToken<'info> {
    /// Pays the rent. On a LaunchRentSubsidy path the sponsor vault reimburses this account
    /// inside the same instruction, because a PDA cannot be a Signer.
    #[account(mut)]
    pub creator: Signer<'info>,
    /// CHECK: created by the handler with system_program::create_account at MINT_INITIAL_SIZE.
    /// The seeds constraint proves it is this creator's mint PDA before anything exists.
    #[account(mut, seeds = [MINT_SEED, creator.key().as_ref(), &[args.nonce]], bump)]
    pub mint: UncheckedAccount<'info>,
    #[account(init, payer = creator, space = Coin::SIZE, seeds = [COIN_SEED, mint.key().as_ref()], bump)]
    pub coin: Account<'info, Coin>,
    /// CHECK: created by the handler with system_program::create_account at TOKEN_ACCOUNT_SIZE
    /// and initialized with the coin PDA as its authority. Created by hand because Anchor runs
    /// every constraint - including a token::mint init - before the handler creates the mint.
    #[account(mut, seeds = [VAULT_SEED, mint.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(seeds = [PROTOCOL_SEED], bump = protocol.bump)]
    pub protocol: Account<'info, ProtocolConfig>,
    /// Present only on a LaunchRentSubsidy path.
    #[account(mut)]
    pub sponsor_vault: Option<Account<'info, SponsorVault>>,
    #[account(mut)]
    pub sponsor_event: Option<Account<'info, SponsorEvent>>,
    /// CHECK: present only on a LaunchRentSubsidy path. The handler re-derives
    /// [b"sponsor-grant", event, coin], checks the owner and creates it at the vault's expense
    /// when it is missing, so a re-launch can never reset the event's per-coin limit.
    #[account(mut)]
    pub sponsor_grant: Option<UncheckedAccount<'info>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// Bounds the whole launch, including the three metadata caps that keep the mint's rent
/// bounded: name <= MAX_NAME_LEN, symbol <= MAX_SYMBOL_LEN, uri <= MAX_URI_LEN.
pub fn validate_launch_args(args: &LaunchTokenArgs, protocol: &ProtocolConfig) -> Result<()> {
    require!(!args.name.is_empty(), DiggoError::MetadataTooLong);
    require!(args.name.len() <= MAX_NAME_LEN, DiggoError::MetadataTooLong);
    require!(args.symbol.len() <= MAX_SYMBOL_LEN, DiggoError::MetadataTooLong);
    require!(args.uri.len() <= MAX_URI_LEN, DiggoError::MetadataTooLong);
    require!(args.decimals <= 9, DiggoError::ConfigOutOfBounds);
    require!(args.total_supply > 0, DiggoError::ConfigOutOfBounds);
    require!(
        args.reserve_bps > 0 && args.reserve_bps <= BPS as u16,
        DiggoError::ConfigOutOfBounds
    );
    // The curve has to keep something: a split that hands the whole supply to the two reserves
    // leaves a coin with no market at all.
    require!(
        (args.reserve_bps as u32 + args.discovery_reserve_bps as u32) < BPS as u32,
        DiggoError::ConfigOutOfBounds
    );
    require!(
        args.curve_mining_bps <= MAX_CURVE_MINING_BPS,
        DiggoError::InvalidCurveMining
    );
    require!(
        args.curve_mining_runway_days <= MAX_CURVE_MINING_RUNWAY_DAYS,
        DiggoError::InvalidCurveMining
    );
    if args.curve_mining_bps > 0 {
        let blocks =
            curve_mining_runway_blocks(args.block_interval as i64, args.curve_mining_runway_days)?;
        require!(
            blocks >= protocol.min_curve_mining_blocks,
            DiggoError::InvalidCurveMining
        );
    }
    require!(
        args.creator_fee_bps <= MAX_TRADING_FEE_BPS,
        DiggoError::ConfigOutOfBounds
    );
    require!(
        args.platform_fee_bps <= MAX_TRADING_FEE_BPS,
        DiggoError::ConfigOutOfBounds
    );
    require!(
        args.creator_fee_bps as u32 + args.platform_fee_bps as u32 <= MAX_TRADING_FEE_BPS as u32,
        DiggoError::ConfigOutOfBounds
    );
    require!(args.block_interval > 0, DiggoError::ConfigOutOfBounds);
    require!(args.epoch_length > 0, DiggoError::ConfigOutOfBounds);
    require!(args.graduation_target > 0, DiggoError::ConfigOutOfBounds);
    require!(args.reduction_bps <= BPS as u16, DiggoError::ConfigOutOfBounds);
    Ok(())
}

pub fn launch_token(ctx: Context<LaunchToken>, args: LaunchTokenArgs) -> Result<()> {
    validate_launch_args(&args, &ctx.accounts.protocol)?;
    let clock = Clock::get()?;
    let protocol = &ctx.accounts.protocol;
    let creator_key = ctx.accounts.creator.key();
    let mint_key = ctx.accounts.mint.key();
    let coin_key = ctx.accounts.coin.key();
    let vault_key = ctx.accounts.vault.key();
    let token_program_key = ctx.accounts.token_program.key;

    let mint_nonce = [args.nonce];
    let mint_bump = [ctx.bumps.mint];
    let mint_seeds: &[&[u8]] = &[MINT_SEED, creator_key.as_ref(), &mint_nonce, &mint_bump];
    let vault_bump = [ctx.bumps.vault];
    let vault_seeds: &[&[u8]] = &[VAULT_SEED, mint_key.as_ref(), &vault_bump];
    let coin_bump = [ctx.bumps.coin];
    let coin_seeds: &[&[u8]] = &[COIN_SEED, mint_key.as_ref(), &coin_bump];

    let rent = Rent::get()?;
    let settled_size = mint_settled_size(&args.name, &args.symbol, &args.uri);
    let mint_rent = rent.minimum_balance(MINT_V2_SIZE);
    let coin_rent = rent.minimum_balance(Coin::SIZE);
    let vault_rent = rent.minimum_balance(TOKEN_ACCOUNT_SIZE);

    // --- the mint: created at its initial size, then the two extensions, then the mint ---
    //
    // The order is Token-2022's, not ours: the metadata pointer has to be initialized while the
    // account still reads as uninitialized, and the token metadata needs an initialized mint
    // whose pointer already points at itself.
    system_program::create_account(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.key(),
            system_program::CreateAccount {
                from: ctx.accounts.creator.to_account_info(),
                to: ctx.accounts.mint.to_account_info(),
            },
            &[mint_seeds],
        ),
        mint_rent,
        MINT_INITIAL_SIZE as u64,
        token_program_key,
    )?;

    let ix =
        metadata_pointer_ix::initialize(token_program_key, &mint_key, Some(coin_key), Some(mint_key))
            .map_err(|_| error!(DiggoError::InvalidMintLayout))?;
    invoke_signed(&ix, &[ctx.accounts.mint.to_account_info()], &[mint_seeds])?;

    let ix = token_ix::initialize_mint2(token_program_key, &mint_key, &coin_key, None, args.decimals)
        .map_err(|_| error!(DiggoError::InvalidMintLayout))?;
    invoke_signed(&ix, &[ctx.accounts.mint.to_account_info()], &[mint_seeds])?;

    // The metadata is self-hosted: the pointer names the mint itself, so the coin's name, symbol
    // and uri live in the mint and are visible to wallets without a second account.
    let ix = token_metadata_ix::initialize(
        token_program_key,
        &mint_key,
        &creator_key,
        &mint_key,
        &coin_key,
        args.name.clone(),
        args.symbol.clone(),
        args.uri.clone(),
    );
    invoke_signed(
        &ix,
        &[
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.creator.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.coin.to_account_info(),
        ],
        &[mint_seeds, coin_seeds],
    )?;
    require!(
        ctx.accounts.mint.data_len() == settled_size,
        DiggoError::InvalidMintLayout
    );

    // --- the vault: the coin's one token account, authority = the coin PDA ---
    system_program::create_account(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.key(),
            system_program::CreateAccount {
                from: ctx.accounts.creator.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
            &[vault_seeds],
        ),
        vault_rent,
        TOKEN_ACCOUNT_SIZE as u64,
        token_program_key,
    )?;
    let ix = token_ix::initialize_account3(token_program_key, &vault_key, &mint_key, &coin_key)
        .map_err(|_| error!(DiggoError::InvalidMintLayout))?;
    invoke_signed(
        &ix,
        &[
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.mint.to_account_info(),
        ],
        &[vault_seeds],
    )?;

    // --- the ledger ---
    let (reserve, discovery, curve) =
        Coin::split_supply(args.total_supply, args.reserve_bps, args.discovery_reserve_bps)?;
    let curve_cap = mul_bps(curve, args.curve_mining_bps)?;
    let curve_block_reward = if curve_cap == 0 {
        0
    } else {
        curve_mining_rate(
            curve_cap,
            args.block_interval as i64,
            args.curve_mining_runway_days,
        )?
    };
    let block_reward = initial_block_reward(
        reserve,
        args.epoch_length,
        args.block_interval,
        args.minimum_reward,
    )?;

    let epoch_ends_at = clock
        .unix_timestamp
        .checked_add(args.epoch_length as i64)
        .ok_or(DiggoError::MathOverflow)?;
    let epoch_slots = (args.epoch_length as u64)
        .checked_mul(SLOTS_PER_SECOND)
        .ok_or(DiggoError::MathOverflow)?;
    let epoch_ends_slot = clock
        .slot
        .checked_add(epoch_slots)
        .ok_or(DiggoError::MathOverflow)?;

    {
        let coin = &mut ctx.accounts.coin;
        coin.creator = creator_key;
        coin.vault = vault_key;
        coin.total_supply = args.total_supply;
        coin.reserve_remaining = reserve;
        coin.discovery_remaining = discovery;
        coin.outstanding_claims = 0;
        coin.cumulative_distributed = 0;
        coin.total_power = 0;
        coin.bonded_power = 0;
        coin.starter_power = 0;
        coin.bonded_index = 0;
        coin.starter_index = 0;
        coin.current_block_reward = block_reward;
        coin.block_interval = args.block_interval;
        coin.next_block_at = clock
            .unix_timestamp
            .checked_add(args.block_interval as i64)
            .ok_or(DiggoError::MathOverflow)?;
        coin.epoch_index = 1;
        coin.epoch_length = args.epoch_length;
        coin.epoch_ends_at = epoch_ends_at;
        coin.epoch_ends_slot = epoch_ends_slot;
        coin.reduction_bps = args.reduction_bps;
        coin.minimum_reward = args.minimum_reward;
        coin.token_reserve = curve;
        coin.sol_reserve = 0;
        coin.virtual_sol_reserve = mul_bps(args.graduation_target, DEFAULT_VIRTUAL_SOL_BPS)?;
        coin.graduation_target = args.graduation_target;
        coin.creator_fee_claimable = 0;
        coin.platform_fee_claimable = 0;
        coin.creator_fee_bps = args.creator_fee_bps;
        coin.platform_fee_bps = args.platform_fee_bps;
        coin.curve_mining_cap = curve_cap;
        coin.curve_mining_mined = 0;
        coin.curve_mining_unpaid = 0;
        coin.curve_mining_block_reward = curve_block_reward;
        coin.graduated = 0;
        coin.curve_phase_ends_at = 0;
        coin.discovery_reserve_total = discovery;
        coin.discovery_epoch_budget = mul_bps(discovery, protocol.discovery_epoch_budget_bps)?;
        coin.discovery_epoch_spent = 0;
        coin.discovery_epoch_index = 1;
        coin.discovery_paused = 0;
        coin.twap_cum_price_lamports_per_unit = 0;
        coin.twap_last_update_slot = 0;
        coin.twap_last_price = 0;
        coin.twap_window_slot = 0;
        coin.twap_window_cum = 0;
        coin.epoch_seed = [0u8; 32];
        coin.epoch_seed_epoch = 0;
        coin.epoch_seed_recorded_slot = 0;
        // The commit half of the epoch seed: a slot roughly one epoch out, which nobody can know
        // the hash of while this epoch's rolls are being locked.
        coin.arm_epoch_seed_target(protocol.epoch_seed_delay_slots);
        // A fresh coin is Launching, not MiningActive: the curve phase is the only side that pays
        // blocks until graduation, and graduation is what moves the coin to MiningActive
        // (math/curve.rs), with the curve-cap transition doing the same from the crank. Clients
        // read the byte through shared/types.ts's tokenStatusFromCoin, whose LAUNCHING branch is
        // only reachable for a coin that carries this zero.
        coin.status = COIN_STATUS_LAUNCHING;
        coin.bump = ctx.bumps.coin;
        coin.version = ACCOUNT_VERSION;
        coin.curve_mining_open = if coin.curve_mining_is_open() { 1 } else { 0 };
    }

    // --- the supply, then the mint authority is gone for good ---
    let ix = token_ix::mint_to(
        token_program_key,
        &mint_key,
        &vault_key,
        &coin_key,
        &[],
        args.total_supply,
    )
    .map_err(|_| error!(DiggoError::InvalidMintLayout))?;
    invoke_signed(
        &ix,
        &[
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.coin.to_account_info(),
        ],
        &[coin_seeds],
    )?;
    // Fixed supply, and no freeze authority was ever set: after this line nothing can mint, burn
    // or freeze this coin, the program included.
    let ix = token_ix::set_authority(
        token_program_key,
        &mint_key,
        None,
        AuthorityType::MintTokens,
        &coin_key,
        &[],
    )
    .map_err(|_| error!(DiggoError::InvalidMintLayout))?;
    invoke_signed(
        &ix,
        &[
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.coin.to_account_info(),
        ],
        &[coin_seeds],
    )?;

    // --- the optional sponsor path: the vault pays the launch rent ---
    let mut sponsor_event_key = Pubkey::default();
    if let (Some(vault), Some(event), Some(grant_account)) = (
        ctx.accounts.sponsor_vault.as_mut(),
        ctx.accounts.sponsor_event.as_mut(),
        ctx.accounts.sponsor_grant.as_ref(),
    ) {
        sponsor_event_key = event.key();
        // The vault and its event are both re-derived rather than trusted: a sponsor's event
        // may only ever be spent by the vault that owns it.
        let sponsor_owner = vault.sponsor_owner;
        let (vault_key, vault_bump) = Pubkey::find_program_address(
            &[SPONSOR_VAULT_SEED, sponsor_owner.as_ref()],
            &crate::ID,
        );
        require_keys_eq!(vault.key(), vault_key, DiggoError::EventNotActive);
        require_keys_eq!(event.vault, vault_key, DiggoError::EventNotActive);
        let vault_bump_bytes = [vault_bump];
        let vault_seeds: &[&[u8]] = &[
            SPONSOR_VAULT_SEED,
            sponsor_owner.as_ref(),
            &vault_bump_bytes,
        ];
        let launch_rent = mint_rent
            .checked_add(coin_rent)
            .and_then(|value| value.checked_add(vault_rent))
            .ok_or(DiggoError::MathOverflow)?;
        let grant_info = grant_account.to_account_info();
        let (mut grant, grant_created) = crate::instructions::sponsor::load_or_create_grant(
            vault,
            vault_seeds,
            &event.key(),
            &coin_key,
            &grant_info,
            &ctx.accounts.creator.to_account_info(),
            &ctx.accounts.system_program,
        )?;
        crate::instructions::sponsor::subsidise_launch_rent(
            vault,
            event,
            &mut grant,
            &grant_info,
            &ctx.accounts.creator.to_account_info(),
            launch_rent,
            grant_created,
            &clock,
            vault_seeds,
            &ctx.accounts.system_program,
        )?;
    } else {
        require!(
            ctx.accounts.sponsor_vault.is_none()
                && ctx.accounts.sponsor_event.is_none()
                && ctx.accounts.sponsor_grant.is_none(),
            DiggoError::EventNotActive
        );
    }

    // --- the two ledgers this instruction must leave whole ---
    let vault_amount = {
        let data = ctx.accounts.vault.try_borrow_data()?;
        let mut slice: &[u8] = &data;
        token_interface::TokenAccount::try_deserialize_unchecked(&mut slice)?.amount
    };
    let coin_lamports = ctx.accounts.coin.to_account_info().lamports();
    ctx.accounts.coin.assert_vault_ledger(vault_amount)?;
    ctx.accounts
        .coin
        .assert_lamport_ledger(coin_lamports, Coin::rent_floor()?)?;

    emit!(CoinLaunched {
        coin: coin_key,
        mint: mint_key,
        creator: creator_key,
        sponsor_event: sponsor_event_key,
    });
    Ok(())
}

#[cfg(test)]
mod v2_tests {
    use super::*;

    /// The rent schedule the cluster charges: 3,480 lamports per byte-year, exempt at two
    /// years, so a rent-exempt minimum is (size + 128) * 6,960 lamports.
    fn rent() -> Rent {
        Rent {
            lamports_per_byte_year: 3_480,
            exemption_threshold: 2.0,
            burn_percent: 50,
        }
    }

    /// The three accounts a launch creates, and exactly what the creator pays for them. This is
    /// the number the design's cost model is about, measured rather than quoted.
    #[test]
    fn the_launch_rent_is_exactly_the_sum_of_the_three_accounts() {
        let rent = rent();
        let mint_lamports = rent.minimum_balance(MINT_V2_SIZE);
        let coin_lamports = rent.minimum_balance(Coin::SIZE);
        let vault_lamports = rent.minimum_balance(TOKEN_ACCOUNT_SIZE);
        let total = mint_lamports + coin_lamports + vault_lamports;

        assert_eq!(MINT_V2_SIZE, 438);
        assert_eq!(Coin::SIZE, 464);
        assert_eq!(TOKEN_ACCOUNT_SIZE, 165);
        assert_eq!(mint_lamports, 3_939_360);
        // (464 + 128) * 6,960. The rent table in programs/diggo-protocol/CONTRACTS.md quotes the
        // same formula's output for every account; the formula is what the cluster charges.
        assert_eq!(coin_lamports, 4_120_320);
        assert_eq!(vault_lamports, 2_039_280);
        assert_eq!(
            total, 10_098_960,
            "the whole launch costs the creator 0.01009896 SOL"
        );

        // A maximal-metadata mint settles at exactly the frozen layout, because the layout is now
        // derived from the same caps: the account is created at MINT_INITIAL_SIZE, funded for
        // MINT_V2_SIZE, and token-2022's realloc finds both the room and the rent it needs.
        let maximal = mint_settled_size(
            &"A".repeat(MAX_NAME_LEN),
            &"B".repeat(MAX_SYMBOL_LEN),
            &"C".repeat(MAX_URI_LEN),
        );
        assert_eq!(maximal, 438);
        assert_eq!(MINT_V2_SIZE, maximal);
        assert_eq!(rent.minimum_balance(maximal), 3_939_360);
        // The funded amount and the settled amount are the same number, so there is no headroom
        // left in the launch cost and nothing a metadata cap can move without this failing.
        assert_eq!(
            mint_lamports - rent.minimum_balance(maximal),
            0,
            "the frozen mint size is the settled size, with no slack"
        );
        assert_eq!(total, 10_098_960);

        // Every legal metadata length settles inside the funded amount, so a long name costs
        // the creator nothing extra and can never make a launch fail for rent.
        let short = mint_settled_size("D", "D", "https://x");
        assert_eq!(short, MINT_INITIAL_SIZE + MINT_TOKEN_METADATA_FIXED + 1 + 1 + 9);
        assert!(short < maximal);
        for (name, symbol, uri) in [
            (1usize, 1usize, 1usize),
            (4, 3, 24),
            (MAX_NAME_LEN, MAX_SYMBOL_LEN, MAX_URI_LEN),
        ] {
            let settled =
                mint_settled_size(&"A".repeat(name), &"B".repeat(symbol), &"C".repeat(uri));
            assert!(settled <= MINT_V2_SIZE);
            assert!(rent.minimum_balance(settled) <= mint_lamports);
        }
    }

    #[test]
    fn the_mint_starts_at_the_only_size_token_2022_accepts() {
        // InitializeMint2 requires the account length to equal what its current extensions add
        // up to, and the metadata pointer has to be initialized first, so the created size is
        // the base mint, the account-type byte and the metadata pointer - never the metadata.
        // The base region is 165 because token-2022 8.0.1 pads a mint's own 82 bytes with 83
        // zero bytes before the account-type byte; 151 is the size that fails the metadata
        // pointer's Initialize with InvalidAccountData.
        assert_eq!(MINT_INITIAL_SIZE, 165 + 1 + 68);
        assert_eq!(MINT_INITIAL_SIZE, 234);
        assert_eq!(MINT_TOKEN_METADATA_FIXED, 84);
        // The TLV header, the update authority, the mint, three string lengths and the empty
        // additional-metadata vector.
        assert_eq!(MINT_TOKEN_METADATA_FIXED, 4 + 32 + 32 + 4 + 4 + 4 + 4);
        assert!(MINT_INITIAL_SIZE < MINT_V2_SIZE);
    }

    #[test]
    fn the_initial_block_reward_spreads_one_epoch_of_reserve() {
        // A week of five-minute blocks: 2,016 blocks, so a 250,000,000 reserve pays 124,007 a
        // block and lasts exactly one epoch before the reduction bites.
        let reward = initial_block_reward(250_000_000, 604_800, 300, 100).unwrap();
        assert_eq!(reward, 124_007);
        assert!(reward * 2_016 <= 250_000_000);

        // The floor is the launch's own minimum reward, and a short epoch cannot divide by zero.
        assert_eq!(initial_block_reward(1, 604_800, 300, 100).unwrap(), 100);
        assert_eq!(initial_block_reward(1_000, 100, 300, 0).unwrap(), 1_000);
        assert!(initial_block_reward(1_000, 0, 300, 0).is_err());
        assert!(initial_block_reward(1_000, 300, 0, 0).is_err());
    }

    #[test]
    fn a_launch_is_bounded_including_the_three_metadata_caps() {
        let protocol = ProtocolConfig {
            min_curve_mining_blocks: MIN_CURVE_MINING_BLOCKS,
            ..ProtocolConfig::default()
        };
        let mut args = LaunchTokenArgs {
            nonce: 0,
            decimals: 6,
            name: "Diggo".to_string(),
            symbol: "DIG".to_string(),
            uri: "https://diggo.fun/meta.json".to_string(),
            total_supply: 1_000_000_000,
            reserve_bps: 2_500,
            discovery_reserve_bps: 500,
            curve_mining_bps: DEFAULT_CURVE_MINING_BPS,
            curve_mining_runway_days: DEFAULT_CURVE_MINING_RUNWAY_DAYS,
            creator_fee_bps: DEFAULT_CREATOR_FEE_BPS,
            platform_fee_bps: DEFAULT_PLATFORM_FEE_BPS,
            graduation_target: 85_000_000_000,
            block_interval: 300,
            epoch_length: 604_800,
            reduction_bps: DEFAULT_REDUCTION_BPS,
            minimum_reward: 100,
        };
        assert!(validate_launch_args(&args, &protocol).is_ok());

        // The metadata caps are what keep the mint's rent bounded.
        args.name = "A".repeat(MAX_NAME_LEN + 1);
        assert!(validate_launch_args(&args, &protocol).is_err());
        args.name = "A".repeat(MAX_NAME_LEN);
        args.symbol = "B".repeat(MAX_SYMBOL_LEN + 1);
        assert!(validate_launch_args(&args, &protocol).is_err());
        args.symbol = "B".repeat(MAX_SYMBOL_LEN);
        args.uri = "C".repeat(MAX_URI_LEN + 1);
        assert!(validate_launch_args(&args, &protocol).is_err());
        args.uri = String::new();
        assert!(validate_launch_args(&args, &protocol).is_ok());

        // A split that leaves nothing on the curve is not a market.
        let mut split = LaunchTokenArgs { uri: String::new(), ..args };
        split.reserve_bps = 9_000;
        split.discovery_reserve_bps = 1_000;
        assert!(validate_launch_args(&split, &protocol).is_err());

        // A curve-mining runway shorter than the protocol's minimum block count is refused, so
        // a budget can never be a single block.
        let mut runway = LaunchTokenArgs { uri: String::new(), ..split };
        runway.reserve_bps = 2_500;
        runway.discovery_reserve_bps = 500;
        runway.curve_mining_runway_days = 0;
        assert!(validate_launch_args(&runway, &protocol).is_err());

        // The two trading fees together may not exceed the protocol cap.
        let mut fees = LaunchTokenArgs { uri: String::new(), ..runway };
        fees.curve_mining_runway_days = DEFAULT_CURVE_MINING_RUNWAY_DAYS;
        fees.creator_fee_bps = 60;
        fees.platform_fee_bps = 60;
        assert!(validate_launch_args(&fees, &protocol).is_err());

        // The virtual depth of the curve is a documented derivation, not a launch argument.
        assert_eq!(DEFAULT_VIRTUAL_SOL_BPS, 3_500);
        assert_eq!(mul_bps(85_000_000_000, DEFAULT_VIRTUAL_SOL_BPS).unwrap(), 29_750_000_000);
    }
}
