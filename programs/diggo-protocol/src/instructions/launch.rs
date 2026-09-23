//! Launch (design 1.3, 1.4, 8.2). WS-B owns this file.

use crate::*;

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
    /// CHECK: created by the handler with system_program::create_account at MINT_V2_SIZE.
    /// The seeds constraint proves it is this creator's mint PDA before anything exists.
    #[account(mut, seeds = [MINT_SEED, creator.key().as_ref(), &[args.nonce]], bump)]
    pub mint: UncheckedAccount<'info>,
    #[account(init, payer = creator, space = Coin::SIZE, seeds = [COIN_SEED, mint.key().as_ref()], bump)]
    pub coin: Account<'info, Coin>,
    #[account(
        init,
        payer = creator,
        token::mint = mint,
        token::authority = coin,
        seeds = [VAULT_SEED, mint.key().as_ref()],
        bump,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(seeds = [PROTOCOL_SEED], bump = protocol.bump)]
    pub protocol: Account<'info, ProtocolConfig>,
    /// Present only on a LaunchRentSubsidy path.
    #[account(mut)]
    pub sponsor_vault: Option<Account<'info, SponsorVault>>,
    pub sponsor_event: Option<Account<'info, SponsorEvent>>,
    #[account(mut)]
    pub sponsor_grant: Option<Account<'info, SponsorGrant>>,
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
        require!(blocks >= protocol.min_curve_mining_blocks, DiggoError::InvalidCurveMining);
    }
    require!(
        args.creator_fee_bps <= MAX_TRADING_FEE_BPS,
        DiggoError::ConfigOutOfBounds
    );
    require!(
        args.platform_fee_bps <= MAX_TRADING_FEE_BPS,
        DiggoError::ConfigOutOfBounds
    );
    require!(args.block_interval > 0, DiggoError::ConfigOutOfBounds);
    require!(args.epoch_length > 0, DiggoError::ConfigOutOfBounds);
    Ok(())
}

pub fn launch_token(_ctx: Context<LaunchToken>, _args: LaunchTokenArgs) -> Result<()> {
    err!(DiggoError::NotImplemented)
}

