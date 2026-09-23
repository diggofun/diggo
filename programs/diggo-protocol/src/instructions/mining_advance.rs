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
    pub coin: Account<'info, Coin>,
    #[account(seeds = [PROTOCOL_SEED], bump = protocol.bump)]
    pub protocol: Account<'info, ProtocolConfig>,
}

pub fn advance_mine(_ctx: Context<AdvanceMine>) -> Result<()> {
    err!(DiggoError::NotImplemented)
}

