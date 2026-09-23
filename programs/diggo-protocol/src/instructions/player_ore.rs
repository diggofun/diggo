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
pub fn collect_ore(ctx: Context<CollectOre>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let player = &mut ctx.accounts.player;
    let (stored, overflow) = settle_ore(player, now)?;
    emit!(OreCollected {
        player: player.key(),
        amount: stored,
        balance: player.ore_balance,
        overflow,
    });
    Ok(())
}

/// Books everything the activation window has earned since the accrual cursor, and moves the
/// cursor to `now`. Returns (stored, overflow).
///
/// The accrual is the intersection of two windows, and that intersection is the whole rule: the
/// time since the last settlement, and the time the activation window was open. A player who
/// let the window lapse therefore accrues nothing for the gap - a paused mine accrues nothing,
/// exactly as the off-chain rule says - and the cursor still moves, so the gap can never be
/// paid for later.
///
/// The capacity clamp is applied here and nowhere else: ORE that does not fit is reported to
/// the caller and the event, and is never silently kept.
pub fn settle_ore(player: &mut PlayerAccount, now: i64) -> Result<(u64, u64)> {
    let from = player.ore_accrued_at.max(player.last_activation_at);
    let to = now.min(player.active_until);
    let active_seconds = if to > from { (to - from) as u64 } else { 0 };
    let maturity = ore_maturity_bps(player.created_at, now);
    let efficiency = ore_efficiency_bps(player.crew_levels)?;
    let accrued = ore_for_active_seconds(active_seconds, maturity, efficiency)?;
    player.ore_accrued_at = now;

    let capacity = ore_capacity(player.crew_levels)?;
    let (balance, stored, overflow) = store_ore(player.ore_balance, accrued, capacity);
    player.ore_balance = balance;
    player.ore_earned = player
        .ore_earned
        .checked_add(stored)
        .ok_or(DiggoError::AccrualOverflow)?;
    Ok((stored, overflow))
}

