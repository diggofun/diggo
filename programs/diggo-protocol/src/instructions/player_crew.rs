//! Crew progression (design 2, 3.3). WS-A owns this file.

use crate::instructions::player_ore::settle_ore;
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
    /// Boxed: `Account` holds its value inline, so a 2,410-byte account would sit inside this
    /// struct's stack frame and push `try_accounts` past the SBF frame limit. See
    /// docs/CONTRACT_CHANGE_REQUESTS.md.
    pub curve_table: Option<Box<Account<'info, CurveTable>>>,
}

/// ore_balance -= cost, crew_levels[component] += 1. The cost and the foreman discount come
/// from the same on-chain curves, so the price cannot be steered by the operator.
///
/// This is the only instruction in the whole program that spends ORE, and ORE can only be
/// earned by playing. That single fact is what keeps crew progression closed to real money:
/// there is no purchase path, no operator-set price, and no way to convert anything else into
/// ORE. The upgrade also settles the accrual first, so the ORE that pays is ORE the player has
/// actually earned by the time they spend it.
pub fn upgrade_crew(ctx: Context<UpgradeCrew>, component: u8) -> Result<()> {
    require!(
        (component as usize) < CREW_COMPONENTS,
        DiggoError::ConfigOutOfBounds
    );
    let now = Clock::get()?.unix_timestamp;
    let player = &mut ctx.accounts.player;

    let (stored, overflow) = settle_ore(player, now)?;
    if stored > 0 || overflow > 0 {
        emit!(OreCollected {
            player: player.key(),
            amount: stored,
            balance: player.ore_balance,
            overflow,
        });
    }

    let index = component as usize;
    let level = player.crew_levels[index];
    require!(level < MAX_CREW_LEVEL, DiggoError::CrewAtMaxLevel);

    // The Foreman discount is read at the level it has now, so buying the Foreman himself
    // cannot discount his own upgrade.
    let foreman = player.crew_levels[CREW_FOREMAN_INDEX];
    let cost = match ctx.accounts.curve_table.as_ref() {
        Some(table) => curve_table_upgrade_ore_cost(table, component, level, foreman)?,
        None => upgrade_ore_cost(component, level, foreman)?,
    };
    require!(player.ore_balance >= cost, DiggoError::InsufficientOre);

    player.ore_balance -= cost;
    player.ore_spent = player
        .ore_spent
        .checked_add(cost)
        .ok_or(DiggoError::MathOverflow)?;
    player.crew_levels[index] = level + 1;

    emit!(CrewUpgraded {
        player: player.key(),
        component,
        level: player.crew_levels[index],
        ore_spent: cost,
    });
    Ok(())
}
