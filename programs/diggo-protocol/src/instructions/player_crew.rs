//! Crew progression (design 2, 3.3). WS-A owns this file.

use crate::*;

#[derive(Accounts)]
pub struct UpgradeCrew<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [PLAYER_SEED, owner.key().as_ref()], bump = player.bump)]
    pub player: Account<'info, PlayerAccount>,
    #[account(seeds = [PROTOCOL_SEED], bump = protocol.bump)]
    pub protocol: Account<'info, ProtocolConfig>,
    /// Present only once a curve-table override exists; the compiled-in tables are the
    /// default and the fallback.
    pub curve_table: Option<Account<'info, CurveTable>>,
}

/// ore_balance -= cost, crew_levels[component] += 1. The cost and the foreman discount come
/// from the same on-chain curves, so the price cannot be steered by the operator.
pub fn upgrade_crew(_ctx: Context<UpgradeCrew>, _component: u8) -> Result<()> {
    err!(DiggoError::NotImplemented)
}

