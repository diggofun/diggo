//! instructions::crew.rs (phase 0a mechanical split of lib.rs).

use crate::*;



#[derive(Accounts)]
pub struct InitializePlayer<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(init, payer = owner, space = 8 + Player::INIT_SPACE, seeds = [b"player", owner.key().as_ref()], bump)]
    pub player: Account<'info, Player>,
    pub system_program: Program<'info, System>,
}


#[derive(Accounts)]
pub struct AssignPower<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"player", owner.key().as_ref()], bump = player.bump, has_one = owner)]
    pub player: Account<'info, Player>,
    #[account(mut)]
    pub mine: Account<'info, Mine>,
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + MiningPosition::INIT_SPACE,
        seeds = [b"position", mine.key().as_ref(), owner.key().as_ref()],
        bump,
    )]
    pub position: Account<'info, MiningPosition>,
    pub system_program: Program<'info, System>,
    /// The mine's market, which carries the curve-mining ledger the walk needs: pre-graduation
    /// emission comes out of the curve's own token inventory, never out of the Mining Reserve,
    /// and only the market knows which of the two is paying.
    ///
    /// Required, and pinned to this mine by has_one. Every caller holds the mint the market PDA
    /// is derived from, so there is no longer a caller that has to walk the ledger without it -
    /// and with it gone, so is the branch that read a spent cap as a settled ledger. A walk that
    /// cannot hand over the market has no honest answer to give, and none is reachable.
    #[account(mut, has_one = mine)]
    pub market: Account<'info, LaunchMarket>,
}


#[derive(Accounts)]
pub struct SyncCrewPower<'info> {
    pub keeper: Signer<'info>,
    #[account(seeds = [b"protocol"], bump = protocol.bump, has_one = keeper)]
    pub protocol: Account<'info, ProtocolConfig>,
    /// CHECK: the player's wallet; only used to derive PDAs, never signs here.
    pub owner: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"player", owner.key().as_ref()], bump = player.bump, has_one = owner)]
    pub player: Account<'info, Player>,
    #[account(mut, has_one = mint)]
    pub mine: Account<'info, Mine>,
    pub mint: InterfaceAccount<'info, Mint>,
    /// See AssignPower.market: the keeper always holds the mint, so the market is required
    /// here and the walk this triggers can never be asked to guess an emission source.
    #[account(mut, has_one = mine)]
    pub market: Account<'info, LaunchMarket>,
    #[account(mut, seeds = [b"position", mine.key().as_ref(), owner.key().as_ref()], bump = position.bump, has_one = mine)]
    pub position: Account<'info, MiningPosition>,
}

pub fn initialize_player(ctx: Context<InitializePlayer>) -> Result<()> {
    let player = &mut ctx.accounts.player;
    player.owner = ctx.accounts.owner.key();
    player.power = STARTER_POWER;
    player.active_mine = Pubkey::default();
    player.bump = ctx.bumps.player;
    Ok(())
}

pub fn assign_power(ctx: Context<AssignPower>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    // The market is a required account (has_one = mine), so the walk always has the ledger
    // that says which side pays; a curve-phase mine settles its due blocks out of the
    // curve's inventory instead of refusing.
    sync_mine_to_now(
        &mut ctx.accounts.mine,
        Some(&mut ctx.accounts.market),
        now,
    )?;
    settle_position(&mut ctx.accounts.position, &ctx.accounts.mine)?;

    let player = &mut ctx.accounts.player;
    require!(
        player.active_mine == Pubkey::default()
            || player.active_mine == ctx.accounts.mine.key(),
        DiggoError::PowerAlreadyAssigned
    );
    let old_power = ctx.accounts.position.assigned_power;
    let new_power = player.power;
    ctx.accounts.mine.total_power = ctx
        .accounts
        .mine
        .total_power
        .checked_sub(old_power)
        .and_then(|value| value.checked_add(new_power))
        .ok_or(DiggoError::MathOverflow)?;
    ctx.accounts.position.owner = ctx.accounts.owner.key();
    ctx.accounts.position.mine = ctx.accounts.mine.key();
    ctx.accounts.position.assigned_power = new_power;
    ctx.accounts.position.last_reward_index = ctx.accounts.mine.reward_index;
    ctx.accounts.position.bump = ctx.bumps.position;
    player.active_mine = ctx.accounts.mine.key();
    Ok(())
}

pub fn remove_power(ctx: Context<AssignPower>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    // See assign_power: the market is required, so this walk never has to guess.
    sync_mine_to_now(
        &mut ctx.accounts.mine,
        Some(&mut ctx.accounts.market),
        now,
    )?;
    settle_position(&mut ctx.accounts.position, &ctx.accounts.mine)?;
    let assigned = ctx.accounts.position.assigned_power;
    require!(assigned > 0, DiggoError::NoPowerAssigned);
    ctx.accounts.mine.total_power = ctx
        .accounts
        .mine
        .total_power
        .checked_sub(assigned)
        .ok_or(DiggoError::MathOverflow)?;
    ctx.accounts.position.assigned_power = 0;
    ctx.accounts.position.last_reward_index = ctx.accounts.mine.reward_index;
    ctx.accounts.player.active_mine = Pubkey::default();
    Ok(())
}

/// Pushes a player's off-chain, ORE-funded Crew power on-chain. Only the
/// protocol keeper may call this — real tokens or SOL never buy power;
/// power only ever comes from the backend's Crew progression accounting.
pub fn sync_crew_power(ctx: Context<SyncCrewPower>, new_power: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    sync_mine_phase(&mut ctx.accounts.mine, &ctx.accounts.market);
    sync_mine_to_now(
        &mut ctx.accounts.mine,
        Some(&mut ctx.accounts.market),
        now,
    )?;
    settle_position(&mut ctx.accounts.position, &ctx.accounts.mine)?;

    let mine = &mut ctx.accounts.mine;
    let player = &mut ctx.accounts.player;
    let previous_power = player.power;
    // Never above the configured ceiling, and never more than the configured
    // per-call increase bound above the previous value. Both bounds live in
    // ProtocolConfig and are hard-clamped by protocol constants.
    validate_power_update(&ctx.accounts.protocol, previous_power, new_power)?;
    player.power = new_power;
    if player.active_mine == mine.key() {
        mine.total_power = mine
            .total_power
            .checked_sub(previous_power)
            .and_then(|value| value.checked_add(new_power))
            .ok_or(DiggoError::MathOverflow)?;
        ctx.accounts.position.assigned_power = new_power;
        ctx.accounts.position.last_reward_index = mine.reward_index;
    }
    emit!(CrewPowerSynced {
        owner: player.owner,
        mint: ctx.accounts.mint.key(),
        previous_power,
        power: new_power,
        max_crew_power: ctx.accounts.protocol.max_crew_power,
    });
    Ok(())
}
