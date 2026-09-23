//! Curve and pool trading, and graduation (design 8.2). WS-B owns this file.
//!
//! A coin trades on its bonding curve until it reaches its graduation target and in its locked
//! pool afterwards, and the two paths share one fee split: the creator's share and the protocol's
//! share, both snapshotted into the coin at launch so a later config change can never alter an
//! existing market retroactively. A PlatformTradeFeeWaiver event does not change the split; it
//! changes who funds the platform's share, which is why the treasury is kept whole either way.
//!
//! The optional sponsor accounts are trailing, so an unsponsored trade passes None and pays the
//! creator's share and the platform's share itself.

use crate::*;
use crate::instructions::sponsor::{load_or_create_grant, move_lamports, waive_platform_fee};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token_interface::spl_token_2022::instruction as token_ix;

/// Token-2022 CPI updates the account data, but Anchor's `amount` field is a
/// deserialized snapshot taken when the instruction context was created. Read
/// the live account before checking a ledger that the CPI has just changed.
fn live_token_amount<'info>(account: &AccountInfo<'info>) -> Result<u64> {
    let data = account.try_borrow_data()?;
    let mut slice: &[u8] = &data;
    Ok(token_interface::TokenAccount::try_deserialize_unchecked(&mut slice)?.amount)
}

#[derive(Accounts)]
pub struct Buy<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, seeds = [COIN_SEED, mint.key().as_ref()], bump = coin.bump)]
    pub coin: Account<'info, Coin>,
    #[account(mut, seeds = [VAULT_SEED, mint.key().as_ref()], bump, token::mint = mint)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = buyer)]
    pub buyer_tokens: InterfaceAccount<'info, TokenAccount>,
    #[account(seeds = [PROTOCOL_SEED], bump = protocol.bump)]
    pub protocol: Account<'info, ProtocolConfig>,
    #[account(mut)]
    pub sponsor_vault: Option<Account<'info, SponsorVault>>,
    #[account(mut)]
    pub sponsor_event: Option<Account<'info, SponsorEvent>>,
    /// CHECK: re-derived by the handler as [b"sponsor-grant", event, coin] and created at the
    /// vault's expense when it is missing.
    #[account(mut)]
    pub sponsor_grant: Option<UncheckedAccount<'info>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Sell<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, seeds = [COIN_SEED, mint.key().as_ref()], bump = coin.bump)]
    pub coin: Account<'info, Coin>,
    #[account(mut, seeds = [VAULT_SEED, mint.key().as_ref()], bump, token::mint = mint)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = seller)]
    pub seller_tokens: InterfaceAccount<'info, TokenAccount>,
    #[account(seeds = [PROTOCOL_SEED], bump = protocol.bump)]
    pub protocol: Account<'info, ProtocolConfig>,
    #[account(mut)]
    pub sponsor_vault: Option<Account<'info, SponsorVault>>,
    #[account(mut)]
    pub sponsor_event: Option<Account<'info, SponsorEvent>>,
    /// CHECK: re-derived by the handler as [b"sponsor-grant", event, coin] and created at the
    /// vault's expense when it is missing.
    #[account(mut)]
    pub sponsor_grant: Option<UncheckedAccount<'info>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// Permissionless: once the condition is on-chain true, anyone may pay for the pool accounts.
#[derive(Accounts)]
pub struct GraduateMarket<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, seeds = [COIN_SEED, mint.key().as_ref()], bump = coin.bump)]
    pub coin: Account<'info, Coin>,
    #[account(mut, seeds = [VAULT_SEED, mint.key().as_ref()], bump, token::mint = mint, token::authority = coin)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(init, payer = payer, space = LiquidityPool::SIZE, seeds = [POOL_SEED, mint.key().as_ref()], bump)]
    pub pool: Account<'info, LiquidityPool>,
    #[account(
        init,
        payer = payer,
        token::mint = mint,
        token::authority = pool,
        seeds = [POOL_VAULT_SEED, mint.key().as_ref()],
        bump,
    )]
    pub pool_token_vault: InterfaceAccount<'info, TokenAccount>,
    /// The pool's SOL vault: a program-owned PDA holding lamports only.
    #[account(mut, seeds = [POOL_SOL_SEED, mint.key().as_ref()], bump)]
    pub pool_sol_vault: SystemAccount<'info>,
    #[account(seeds = [PROTOCOL_SEED], bump = protocol.bump)]
    pub protocol: Account<'info, ProtocolConfig>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PoolBuy<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, seeds = [COIN_SEED, mint.key().as_ref()], bump = coin.bump)]
    pub coin: Box<Account<'info, Coin>>,
    #[account(mut, seeds = [POOL_SEED, mint.key().as_ref()], bump = pool.bump)]
    pub pool: Box<Account<'info, LiquidityPool>>,
    #[account(mut, seeds = [POOL_VAULT_SEED, mint.key().as_ref()], bump, token::mint = mint)]
    pub pool_token_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, seeds = [POOL_SOL_SEED, mint.key().as_ref()], bump)]
    pub pool_sol_vault: SystemAccount<'info>,
    #[account(mut, token::mint = mint, token::authority = buyer)]
    pub buyer_tokens: InterfaceAccount<'info, TokenAccount>,
    #[account(seeds = [PROTOCOL_SEED], bump = protocol.bump)]
    pub protocol: Box<Account<'info, ProtocolConfig>>,
    #[account(mut)]
    pub sponsor_vault: Option<Account<'info, SponsorVault>>,
    #[account(mut)]
    pub sponsor_event: Option<Account<'info, SponsorEvent>>,
    /// CHECK: re-derived by the handler as [b"sponsor-grant", event, coin] and created at the
    /// vault's expense when it is missing.
    #[account(mut)]
    pub sponsor_grant: Option<UncheckedAccount<'info>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PoolSell<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, seeds = [COIN_SEED, mint.key().as_ref()], bump = coin.bump)]
    pub coin: Box<Account<'info, Coin>>,
    #[account(mut, seeds = [POOL_SEED, mint.key().as_ref()], bump = pool.bump)]
    pub pool: Box<Account<'info, LiquidityPool>>,
    #[account(mut, seeds = [POOL_VAULT_SEED, mint.key().as_ref()], bump, token::mint = mint, token::authority = pool)]
    pub pool_token_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, seeds = [POOL_SOL_SEED, mint.key().as_ref()], bump)]
    pub pool_sol_vault: SystemAccount<'info>,
    #[account(mut, token::mint = mint, token::authority = seller)]
    pub seller_tokens: InterfaceAccount<'info, TokenAccount>,
    #[account(seeds = [PROTOCOL_SEED], bump = protocol.bump)]
    pub protocol: Box<Account<'info, ProtocolConfig>>,
    #[account(mut)]
    pub sponsor_vault: Option<Account<'info, SponsorVault>>,
    #[account(mut)]
    pub sponsor_event: Option<Account<'info, SponsorEvent>>,
    /// CHECK: re-derived by the handler as [b"sponsor-grant", event, coin] and created at the
    /// vault's expense when it is missing.
    #[account(mut)]
    pub sponsor_grant: Option<UncheckedAccount<'info>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// The rent floor of the pool's SOL vault, which holds no data.
pub fn pool_sol_rent_floor() -> Result<u64> {
    Ok(Rent::get()?.minimum_balance(0))
}

/// TransferChecked out of a program-owned token account, signed by its PDA.
#[allow(clippy::too_many_arguments)]
fn signed_transfer_checked<'info>(
    token_program: &Pubkey,
    from: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    amount: u64,
    decimals: u8,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let ix = token_ix::transfer_checked(
        token_program,
        from.key,
        mint.key,
        to.key,
        authority.key,
        &[],
        amount,
        decimals,
    )
    .map_err(|_| error!(DiggoError::InvalidMintLayout))?;
    invoke_signed(
        &ix,
        &[from.clone(), mint.clone(), to.clone(), authority.clone()],
        signer_seeds,
    )?;
    Ok(())
}

/// The sponsor accounts of one trade, resolved into the waiver it applies.
struct TradeWaiver {
    /// True when a sponsor event funds the platform share, so the trader pays the creator's
    /// share only.
    waived: bool,
}

/// Applies a PlatformTradeFeeWaiver event to one trade, if the caller passed one.
///
/// The waiver is all-or-nothing: three sponsor accounts or none, so a caller can never half-fund
/// a fee. Everything else about the split is unchanged, which is what keeps the invariance test
/// the design promises - same coin, same seed, with and without an event - meaningful.
#[allow(clippy::too_many_arguments)]
fn resolve_trade_waiver<'info>(
    sponsor_vault: Option<&mut Account<'info, SponsorVault>>,
    sponsor_event: Option<&mut Account<'info, SponsorEvent>>,
    sponsor_grant: Option<&UncheckedAccount<'info>>,
    coin_info: &AccountInfo<'info>,
    coin_key: &Pubkey,
    platform_fee: u64,
    clock: &Clock,
    payer_info: &AccountInfo<'info>,
    system_program: &Program<'info, System>,
) -> Result<TradeWaiver> {
    match (sponsor_vault, sponsor_event, sponsor_grant) {
        (None, None, None) => Ok(TradeWaiver {
            waived: false,
        }),
        (Some(vault), Some(event), Some(grant_account)) => {
            let (vault_key, vault_bump) = Pubkey::find_program_address(
                &[SPONSOR_VAULT_SEED, vault.sponsor_owner.as_ref()],
                &crate::ID,
            );
            require_keys_eq!(vault.key(), vault_key, DiggoError::EventNotActive);
            require_keys_eq!(event.vault, vault_key, DiggoError::EventNotActive);
            let vault_bump_bytes = [vault_bump];
            let vault_seeds: &[&[u8]] = &[
                SPONSOR_VAULT_SEED,
                vault.sponsor_owner.as_ref(),
                &vault_bump_bytes,
            ];
            let grant_info = grant_account.to_account_info();
            let (mut grant, grant_created) = load_or_create_grant(
                vault,
                vault_seeds,
                &event.key(),
                coin_key,
                &grant_info,
                payer_info,
                system_program,
            )?;
            waive_platform_fee(
                vault,
                event,
                &mut grant,
                &grant_info,
                coin_info,
                payer_info,
                platform_fee,
                grant_created,
                clock,
            )?;
            Ok(TradeWaiver {
                waived: true,
            })
        }
        _ => Err(error!(DiggoError::EventNotActive)),
    }
}

pub fn buy(ctx: Context<Buy>, sol_in: u64, min_tokens_out: u64) -> Result<()> {
    require!(sol_in > 0, DiggoError::InvalidAmount);
    require!(ctx.accounts.coin.graduated == 0, DiggoError::MarketGraduated);
    let clock = Clock::get()?;
    let mint_key = ctx.accounts.mint.key();
    let coin_key = ctx.accounts.coin.key();
    let coin_bump = [ctx.accounts.coin.bump];
    let coin_seeds: &[&[u8]] = &[COIN_SEED, mint_key.as_ref(), &coin_bump];
    let decimals = ctx.accounts.mint.decimals;

    let fees = split_trade_fees(
        sol_in,
        ctx.accounts.coin.creator_fee_bps,
        ctx.accounts.coin.platform_fee_bps,
    )?;
    let coin_info = ctx.accounts.coin.to_account_info();
    let waiver = resolve_trade_waiver(
        ctx.accounts.sponsor_vault.as_mut(),
        ctx.accounts.sponsor_event.as_mut(),
        ctx.accounts.sponsor_grant.as_ref(),
        &coin_info,
        &coin_key,
        fees.platform,
        &clock,
        &ctx.accounts.buyer.to_account_info(),
        &ctx.accounts.system_program,
    )?;

    // What the curve receives: the whole trade minus the fees the trader pays. On a waived trade
    // the platform's share is already in the coin, funded by the vault.
    let net_sol = if waiver.waived {
        sol_in
            .checked_sub(fees.creator)
            .ok_or(DiggoError::FeeSplitOverflow)?
    } else {
        net_after_trade_fees(sol_in, fees)?
    };
    let tokens_out = curve_buy_out(
        ctx.accounts.coin.token_reserve,
        ctx.accounts.coin.sol_reserve,
        ctx.accounts.coin.virtual_sol_reserve,
        net_sol,
    )?;
    require!(tokens_out >= min_tokens_out, DiggoError::SlippageExceeded);

    // The whole gross joins the coin, which is what keeps its lamport ledger exact: the net
    // becomes the curve's SOL reserve and the fees become its two buckets.
    // The buyer is a system-owned wallet. A program cannot debit that account by mutating its
    // lamports directly (ExternalAccountLamportSpend); the signed system transfer is the only
    // runtime-supported way to take the trader's SOL.
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.key(),
            system_program::Transfer {
                from: ctx.accounts.buyer.to_account_info(),
                to: coin_info.clone(),
            },
        ),
        sol_in,
    )?;
    apply_curve_buy(&mut ctx.accounts.coin, net_sol, tokens_out)?;
    accrue_coin_fees(&mut ctx.accounts.coin, fees)?;

    signed_transfer_checked(
        &ctx.accounts.token_program.key,
        &ctx.accounts.vault.to_account_info(),
        &ctx.accounts.mint.to_account_info(),
        &ctx.accounts.buyer_tokens.to_account_info(),
        &coin_info,
        tokens_out,
        decimals,
        &[coin_seeds],
    )?;

    ctx.accounts
        .coin
        .assert_vault_ledger(live_token_amount(&ctx.accounts.vault.to_account_info())?)?;
    ctx.accounts
        .coin
        .assert_lamport_ledger(coin_info.lamports(), Coin::rent_floor()?)?;
    Ok(())
}

pub fn sell(ctx: Context<Sell>, tokens_in: u64, min_sol_out: u64) -> Result<()> {
    require!(tokens_in > 0, DiggoError::InvalidAmount);
    require!(ctx.accounts.coin.graduated == 0, DiggoError::MarketGraduated);
    let clock = Clock::get()?;
    let coin_key = ctx.accounts.coin.key();
    let decimals = ctx.accounts.mint.decimals;

    let gross = curve_sell_out(
        ctx.accounts.coin.token_reserve,
        ctx.accounts.coin.sol_reserve,
        ctx.accounts.coin.virtual_sol_reserve,
        tokens_in,
    )?;
    let fees = split_trade_fees(
        gross,
        ctx.accounts.coin.creator_fee_bps,
        ctx.accounts.coin.platform_fee_bps,
    )?;
    let coin_info = ctx.accounts.coin.to_account_info();
    let waiver = resolve_trade_waiver(
        ctx.accounts.sponsor_vault.as_mut(),
        ctx.accounts.sponsor_event.as_mut(),
        ctx.accounts.sponsor_grant.as_ref(),
        &coin_info,
        &coin_key,
        fees.platform,
        &clock,
        &ctx.accounts.seller.to_account_info(),
        &ctx.accounts.system_program,
    )?;

    // The trader's net is the capped gross minus the shares they pay; on a waived trade that is
    // the creator's share only.
    let net_sol = if waiver.waived {
        gross
            .checked_sub(fees.creator)
            .ok_or(DiggoError::FeeSplitOverflow)?
    } else {
        net_after_trade_fees(gross, fees)?
    };
    require!(net_sol >= min_sol_out, DiggoError::SlippageExceeded);

    apply_curve_sell(&mut ctx.accounts.coin, gross, tokens_in)?;
    accrue_coin_fees(&mut ctx.accounts.coin, fees)?;
    let mint_key = ctx.accounts.mint.key();
    let coin_bump = [ctx.accounts.coin.bump];
    let coin_seeds: &[&[u8]] = &[COIN_SEED, mint_key.as_ref(), &coin_bump];
    // The trader's tokens rejoin the curve's inventory, which is what a sell is.
    signed_transfer_checked(
        &ctx.accounts.token_program.key,
        &ctx.accounts.seller_tokens.to_account_info(),
        &ctx.accounts.mint.to_account_info(),
        &ctx.accounts.vault.to_account_info(),
        &ctx.accounts.seller.to_account_info(),
        tokens_in,
        decimals,
        &[],
    )?;

    // The Coin PDA is program-owned and carries account data, so it cannot be the source of a
    // System Program transfer. Move the curve's SOL directly after the token CPI has consumed
    // the seller account, which keeps LiteSVM's account-balance accounting balanced.
    move_lamports(
        &coin_info,
        &ctx.accounts.seller.to_account_info(),
        net_sol,
    )?;

    ctx.accounts
        .coin
        .assert_vault_ledger(live_token_amount(&ctx.accounts.vault.to_account_info())?)?;
    ctx.accounts
        .coin
        .assert_lamport_ledger(coin_info.lamports(), Coin::rent_floor()?)?;
    Ok(())
}

pub fn pool_buy(ctx: Context<PoolBuy>, sol_in: u64, min_tokens_out: u64) -> Result<()> {
    require!(sol_in > 0, DiggoError::InvalidAmount);
    require!(ctx.accounts.coin.graduated != 0, DiggoError::PoolNotInitialised);
    let clock = Clock::get()?;
    let mint_key = ctx.accounts.mint.key();
    let coin_key = ctx.accounts.coin.key();
    let pool_key = ctx.accounts.pool.key();
    let pool_bump = [ctx.accounts.pool.bump];
    let pool_seeds: &[&[u8]] = &[POOL_SEED, mint_key.as_ref(), &pool_bump];
    let (_, pool_sol_bump) = Pubkey::find_program_address(
        &[POOL_SOL_SEED, mint_key.as_ref()],
        &crate::ID,
    );
    let pool_sol_bump = [pool_sol_bump];
    let pool_sol_seeds: &[&[u8]] = &[POOL_SOL_SEED, mint_key.as_ref(), &pool_sol_bump];
    let decimals = ctx.accounts.mint.decimals;

    let fees = split_trade_fees(
        sol_in,
        ctx.accounts.coin.creator_fee_bps,
        ctx.accounts.coin.platform_fee_bps,
    )?;
    let coin_info = ctx.accounts.coin.to_account_info();
    let waiver = resolve_trade_waiver(
        ctx.accounts.sponsor_vault.as_mut(),
        ctx.accounts.sponsor_event.as_mut(),
        ctx.accounts.sponsor_grant.as_ref(),
        &coin_info,
        &coin_key,
        fees.platform,
        &clock,
        &ctx.accounts.buyer.to_account_info(),
        &ctx.accounts.system_program,
    )?;
    let net_sol = if waiver.waived {
        sol_in
            .checked_sub(fees.creator)
            .ok_or(DiggoError::FeeSplitOverflow)?
    } else {
        net_after_trade_fees(sol_in, fees)?
    };
    let tokens_out = pool_buy_out(
        ctx.accounts.pool.token_reserve,
        ctx.accounts.pool.sol_reserve,
        net_sol,
    )?;
    require!(tokens_out >= min_tokens_out, DiggoError::SlippageExceeded);

    // The price the pool held is accumulated before the swap that changes it.
    observe_pool_price(&mut ctx.accounts.coin, &mut ctx.accounts.pool, clock.slot)?;
    apply_pool_swap_v2(
        &mut ctx.accounts.pool,
        PoolDebit::Swap,
        net_sol,
        0,
        0,
        tokens_out,
    )?;

    system_program::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.key(),
            system_program::Transfer {
                from: ctx.accounts.buyer.to_account_info(),
                to: ctx.accounts.pool_sol_vault.to_account_info(),
            },
            &[pool_sol_seeds],
        ),
        net_sol,
    )?;
    let to_coin = sol_in
        .checked_sub(net_sol)
        .ok_or(DiggoError::FeeSplitOverflow)?;
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.key(),
            system_program::Transfer {
                from: ctx.accounts.buyer.to_account_info(),
                to: coin_info.clone(),
            },
        ),
        to_coin,
    )?;
    accrue_coin_fees(&mut ctx.accounts.coin, fees)?;

    signed_transfer_checked(
        &ctx.accounts.token_program.key,
        &ctx.accounts.pool_token_vault.to_account_info(),
        &ctx.accounts.mint.to_account_info(),
        &ctx.accounts.buyer_tokens.to_account_info(),
        &ctx.accounts.pool.to_account_info(),
        tokens_out,
        decimals,
        &[pool_seeds],
    )?;

    let _ = pool_key;
    ctx.accounts
        .coin
        .assert_lamport_ledger(coin_info.lamports(), Coin::rent_floor()?)?;
    require!(
        ctx.accounts.pool_sol_vault.lamports()
            >= pool_sol_rent_floor()?
                .checked_add(ctx.accounts.pool.sol_reserve)
                .ok_or(DiggoError::MathOverflow)?,
        DiggoError::LedgerInvariantViolated
    );
    Ok(())
}

pub fn pool_sell(ctx: Context<PoolSell>, tokens_in: u64, min_sol_out: u64) -> Result<()> {
    require!(tokens_in > 0, DiggoError::InvalidAmount);
    require!(ctx.accounts.coin.graduated != 0, DiggoError::PoolNotInitialised);
    let clock = Clock::get()?;
    let coin_key = ctx.accounts.coin.key();
    let mint_key = ctx.accounts.mint.key();
    let (_, pool_sol_bump) = Pubkey::find_program_address(
        &[POOL_SOL_SEED, mint_key.as_ref()],
        &crate::ID,
    );
    let pool_sol_bump = [pool_sol_bump];
    let pool_sol_seeds: &[&[u8]] = &[POOL_SOL_SEED, mint_key.as_ref(), &pool_sol_bump];
    let decimals = ctx.accounts.mint.decimals;

    let gross = pool_sell_out(
        ctx.accounts.pool.token_reserve,
        ctx.accounts.pool.sol_reserve,
        tokens_in,
    )?;
    let fees = split_trade_fees(
        gross,
        ctx.accounts.coin.creator_fee_bps,
        ctx.accounts.coin.platform_fee_bps,
    )?;
    let coin_info = ctx.accounts.coin.to_account_info();
    let waiver = resolve_trade_waiver(
        ctx.accounts.sponsor_vault.as_mut(),
        ctx.accounts.sponsor_event.as_mut(),
        ctx.accounts.sponsor_grant.as_ref(),
        &coin_info,
        &coin_key,
        fees.platform,
        &clock,
        &ctx.accounts.seller.to_account_info(),
        &ctx.accounts.system_program,
    )?;
    let net_sol = if waiver.waived {
        gross
            .checked_sub(fees.creator)
            .ok_or(DiggoError::FeeSplitOverflow)?
    } else {
        net_after_trade_fees(gross, fees)?
    };
    require!(net_sol >= min_sol_out, DiggoError::SlippageExceeded);

    observe_pool_price(&mut ctx.accounts.coin, &mut ctx.accounts.pool, clock.slot)?;
    apply_pool_swap_v2(
        &mut ctx.accounts.pool,
        PoolDebit::Swap,
        0,
        tokens_in,
        gross,
        0,
    )?;

    let to_coin = gross
        .checked_sub(net_sol)
        .ok_or(DiggoError::FeeSplitOverflow)?;
    system_program::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.key(),
            system_program::Transfer {
                from: ctx.accounts.pool_sol_vault.to_account_info(),
                to: ctx.accounts.seller.to_account_info(),
            },
            &[pool_sol_seeds],
        ),
        net_sol,
    )?;
    system_program::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.key(),
            system_program::Transfer {
                from: ctx.accounts.pool_sol_vault.to_account_info(),
                to: coin_info.clone(),
            },
            &[pool_sol_seeds],
        ),
        to_coin,
    )?;
    accrue_coin_fees(&mut ctx.accounts.coin, fees)?;

    signed_transfer_checked(
        &ctx.accounts.token_program.key,
        &ctx.accounts.seller_tokens.to_account_info(),
        &ctx.accounts.mint.to_account_info(),
        &ctx.accounts.pool_token_vault.to_account_info(),
        &ctx.accounts.seller.to_account_info(),
        tokens_in,
        decimals,
        &[],
    )?;

    ctx.accounts
        .coin
        .assert_lamport_ledger(coin_info.lamports(), Coin::rent_floor()?)?;
    require!(
        ctx.accounts.pool_sol_vault.lamports()
            >= pool_sol_rent_floor()?
                .checked_add(ctx.accounts.pool.sol_reserve)
                .ok_or(DiggoError::MathOverflow)?,
        DiggoError::LedgerInvariantViolated
    );
    Ok(())
}

/// Permissionless: once the condition is on-chain true, anyone may pay for the pool accounts.
///
/// Graduation moves exactly the coin's curve reserves into the pool and nothing else. The
/// curve-phase tokens a position has already been credited with are not part of the curve's
/// inventory any more - a curve-phase emission debits it as it credits outstanding_claims - so
/// what moves is exactly what no position is owed, and the Mining and Discovery Reserves stay
/// where they are.
pub fn graduate_market(ctx: Context<GraduateMarket>) -> Result<()> {
    let clock = Clock::get()?;
    // Graduation must not leave a pre-graduation ledger stretch unaccounted. Otherwise the
    // first post-graduation crank would classify those blocks as reserve-phase and pay them
    // from the Mining Reserve even though the curve still owned that inventory.
    sync_coin_to_now(
        &mut ctx.accounts.coin,
        &ctx.accounts.protocol,
        clock.unix_timestamp,
        clock.slot,
    )?;
    let mint_key = ctx.accounts.mint.key();
    let (_, pool_sol_bump) = Pubkey::find_program_address(
        &[POOL_SOL_SEED, mint_key.as_ref()],
        &crate::ID,
    );
    let pool_sol_bump = [pool_sol_bump];
    let coin_bump = [ctx.accounts.coin.bump];
    let coin_seeds: &[&[u8]] = &[COIN_SEED, mint_key.as_ref(), &coin_bump];
    let decimals = ctx.accounts.mint.decimals;

    let curve_tokens = ctx.accounts.coin.token_reserve;
    let curve_sol = ctx.accounts.coin.sol_reserve;
    let coin_info = ctx.accounts.coin.to_account_info();

    // The pool's SOL vault holds lamports only, so its rent floor is paid for by whoever
    // graduates: the design keeps that cost off the launch price.
    let rent_floor = pool_sol_rent_floor()?;
    let shortfall = rent_floor.saturating_sub(ctx.accounts.pool_sol_vault.lamports());
    if shortfall > 0 {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                system_program::Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.pool_sol_vault.to_account_info(),
                },
            ),
            shortfall,
        )?;
    }
    signed_transfer_checked(
        &ctx.accounts.token_program.key,
        &ctx.accounts.vault.to_account_info(),
        &ctx.accounts.mint.to_account_info(),
        &ctx.accounts.pool_token_vault.to_account_info(),
        &coin_info,
        curve_tokens,
        decimals,
        &[coin_seeds],
    )?;

    // The Coin PDA is program-owned and data-bearing; System Program rejects a data-bearing
    // source. Move the curve's SOL directly after the token CPI so the CPI's account-balance
    // accounting has already completed.
    move_lamports(
        &coin_info,
        &ctx.accounts.pool_sol_vault.to_account_info(),
        curve_sol,
    )?;

    apply_graduation_v2(
        &mut ctx.accounts.coin,
        &mut ctx.accounts.pool,
        clock.unix_timestamp,
        clock.slot,
    )?;

    // The pool is created by this instruction, so its identity fields must be written before
    // any later pool instruction can read them. The reserves are assigned by
    // apply_graduation_v2 above; these are the immutable vault links.
    ctx.accounts.pool.coin = ctx.accounts.coin.key();
    ctx.accounts.pool.mint = mint_key;
    ctx.accounts.pool.token_vault = ctx.accounts.pool_token_vault.key();
    ctx.accounts.pool.sol_vault = ctx.accounts.pool_sol_vault.key();
    ctx.accounts.pool.bump = ctx.bumps.pool;

    let pool_key = ctx.accounts.pool.key();
    emit!(MarketGraduated {
        coin: coin_info.key(),
        pool: pool_key,
        token_reserve: curve_tokens,
        sol_reserve: curve_sol,
    });

    // The coin keeps its Mining Reserve, its Discovery Reserve and whatever the index has
    // already credited to a position; the pool holds exactly what the curve held.
    ctx.accounts
        .coin
        .assert_vault_ledger(live_token_amount(&ctx.accounts.vault.to_account_info())?)?;
    ctx.accounts
        .coin
        .assert_lamport_ledger(coin_info.lamports(), Coin::rent_floor()?)?;
    require!(
        ctx.accounts.pool_sol_vault.lamports()
            >= rent_floor
                .checked_add(ctx.accounts.pool.sol_reserve)
                .ok_or(DiggoError::MathOverflow)?,
        DiggoError::LedgerInvariantViolated
    );
    require!(
        live_token_amount(&ctx.accounts.pool_token_vault.to_account_info())?
            == ctx.accounts.pool.token_reserve,
        DiggoError::LedgerInvariantViolated
    );
    Ok(())
}
