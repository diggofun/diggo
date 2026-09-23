//! Lazy ORE accrual (design 2, 3.3). WS-A owns this file.

use crate::*;

#[derive(Accounts)]
pub struct CollectOre<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [PLAYER_SEED, owner.key().as_ref()], bump = player.bump)]
    pub player: Account<'info, PlayerAccount>,
    #[account(seeds = [PROTOCOL_SEED], bump = protocol.bump)]
    pub protocol: Account<'info, ProtocolConfig>,
}

/// Settles lazily accrued ORE into ore_balance, clamped by storage capacity. Accrued ORE the
/// capacity cannot hold is reported in the OreCollected event, never silently kept.
pub fn collect_ore(_ctx: Context<CollectOre>) -> Result<()> {
    err!(DiggoError::NotImplemented)
}

