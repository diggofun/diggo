//! The permissionless ledger crank (design 6). WS-C owns this file; the walk it drives lives
//! in math/index.rs and instructions/crank.rs.

use crate::*;

/// Walks the coin's ledger forward by at most MAX_SYNC_SEGMENTS segments. Permissionless by
/// design, and deterministic: each call is a continuation of the previous one.
#[derive(Accounts)]
pub struct AdvanceMine<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, seeds = [COIN_SEED, mint.key().as_ref()], bump = coin.bump)]
    pub coin: Box<Account<'info, Coin>>,
    #[account(seeds = [PROTOCOL_SEED], bump = protocol.bump)]
    pub protocol: Box<Account<'info, ProtocolConfig>>,
}

/// Walks the coin's ledger forward, and arms the next epoch's seed target when the walk rolls
/// an epoch.
///
/// Permissionless and deterministic: the progress lives in the coin account, so a caller
/// further behind than one call can cover simply sends another one. This is the whole of the
/// keeper's old job on the mining side (design 6): there is no authority here, no signer
/// whose key matters beyond paying the transaction fee, and nothing an operator can decide.
///
/// A coin that is already caught up succeeds and does nothing, so a crank that runs on a
/// timer never has to guess whether there is work to do. The tip that makes cranking worth
/// running is a separate, fee-funded instruction (crank_tip); this one pays nothing.
pub fn advance_mine(ctx: Context<AdvanceMine>) -> Result<()> {
    let clock = Clock::get()?;
    let protocol = &ctx.accounts.protocol;
    let coin = &mut ctx.accounts.coin;
    let outcome = sync_coin(coin, protocol, clock.unix_timestamp, clock.slot)?;
    if outcome.epochs_rolled > 0 {
        emit!(EpochAdvanced {
            coin: coin.key(),
            epoch_index: coin.epoch_index,
            epoch_ends_at: coin.epoch_ends_at,
            epoch_ends_slot: coin.epoch_ends_slot,
        });
        emit!(EpochSeedTargetArmed {
            coin: coin.key(),
            epoch_index: coin.epoch_index,
            target_slot: outcome.target_slot,
        });
    }
    Ok(())
}
