//! Epoch seed commit and reveal (design 4.1). WS-C owns this file.

use crate::*;
use solana_hash::Hash;

/// Reads the SlotHashes sysvar at exactly `coin.epoch_seed_target_slot` and stores that
/// entry as the coin's epoch seed. Permissionless: one transaction per coin per epoch.
///
/// The sysvar is taken as `Sysvar<SlotHashes>` and never as an unchecked account, so Anchor
/// checks its address and owner. It keeps the last SLOT_HASHES_WINDOW slot hashes, which is
/// the window the reveal must land in: past EPOCH_SEED_MAX_LATENESS_SLOTS the seed re-arms
/// instead of being committed.
#[derive(Accounts)]
pub struct CommitEpochSeed<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, seeds = [COIN_SEED, mint.key().as_ref()], bump = coin.bump)]
    pub coin: Box<Account<'info, Coin>>,
    #[account(seeds = [PROTOCOL_SEED], bump = protocol.bump)]
    pub protocol: Box<Account<'info, ProtocolConfig>>,
    /// CHECK: checked against the canonical SlotHashes sysvar address; the data is read with
    /// the runtime syscall because Solana deliberately rejects deserializing this 20 KB sysvar
    /// from an AccountInfo inside a program.
    pub slot_hashes: UncheckedAccount<'info>,
}

/// The slot hash recorded at `slot`, if the sysvar still carries it.
fn slot_hash_at(slot_hashes: &[(u64, Hash)], slot: u64) -> Option<[u8; 32]> {
    slot_hashes
        .iter()
        .find(|entry| entry.0 == slot)
        .map(|entry| entry.1.to_bytes())
}

/// The oldest entry the sysvar still carries, with the slot it belongs to. The sysvar keeps
/// its entries newest first, so the last one is the oldest.
fn oldest_slot_hash(slot_hashes: &[(u64, Hash)]) -> Option<(u64, [u8; 32])> {
    slot_hashes
        .iter()
        .last()
        .map(|entry| (entry.0, entry.1.to_bytes()))
}

/// Loads the SlotHashes window through `sol_get_sysvar`. The account stays in the instruction
/// for client compatibility and the canonical-address check below; Anchor's generic Sysvar
/// wrapper cannot be used because Solana defines this sysvar as too large to deserialize in BPF.
fn read_slot_hashes(account: &AccountInfo<'_>) -> Result<Vec<(u64, Hash)>> {
    require_keys_eq!(
        *account.owner,
        solana_sysvar_id::ID,
        DiggoError::InvalidAccountLayout
    );
    require_eq!(
        *account.key,
        solana_sysvar::slot_hashes::id(),
        DiggoError::InvalidAccountLayout
    );

    const SLOT_HASH_BYTES: usize = 8 + 32;
    let mut bytes = vec![0u8; 8 + solana_slot_hashes::MAX_ENTRIES * SLOT_HASH_BYTES];
    let bytes_len = bytes.len() as u64;
    solana_sysvar::get_sysvar(
        &mut bytes,
        &solana_sysvar::slot_hashes::id(),
        0,
        bytes_len,
    )?;
    let count = bytes[..8]
        .try_into()
        .map(u64::from_le_bytes)
        .ok()
        .and_then(|count| usize::try_from(count).ok())
        .filter(|count| *count <= solana_slot_hashes::MAX_ENTRIES)
        .ok_or(DiggoError::InvalidAccountLayout)?;
    let mut entries = Vec::with_capacity(count);
    for index in 0..count {
        let start = 8 + index * SLOT_HASH_BYTES;
        let slot = bytes[start..start + 8]
            .try_into()
            .map(u64::from_le_bytes)
            .map_err(|_| error!(DiggoError::InvalidAccountLayout))?;
        let hash = bytes[start + 8..start + SLOT_HASH_BYTES]
            .try_into()
            .map(Hash::new_from_array)
            .map_err(|_| error!(DiggoError::InvalidAccountLayout))?;
        entries.push((slot, hash));
    }
    Ok(entries)
}

/// Reveals the epoch seed: reads the SlotHashes entry the walk armed, and records it on the
/// coin together with the slot it actually came from.
///
/// Permissionless and idempotent per epoch. The three deterministic branches of design 4.1
/// are all here:
///
/// - the target is still inside the sysvar's window: its own hash is the seed, and
///   `epoch_seed_recorded_slot` is the target;
/// - the target has aged out but the crank is no later than `epoch_seed_max_lateness_slots`:
///   the oldest hash still recorded is used instead, and its slot is stored so the fallback
///   is visible and the derivation stays publicly recomputable;
/// - the crank is later than that bound: no seed is set at all and the target re-arms at
///   `current_slot + epoch_seed_delay_slots`, which delays settlement by one delay window
///   rather than making the outcome predictable.
///
/// Settlement is impossible without a seed, so a missed reveal delays payouts. It never makes
/// them predictable and it never pays twice, because the opportunity PDA is unique per
/// (coin, owner, window) and is closed when it settles.
pub fn commit_epoch_seed(ctx: Context<CommitEpochSeed>) -> Result<()> {
    let clock = Clock::get()?;
    let protocol = &ctx.accounts.protocol;
    let coin = &mut ctx.accounts.coin;
    let slot_hashes = read_slot_hashes(&ctx.accounts.slot_hashes)?;

    let target = coin.epoch_seed_target_slot;
    require!(target > 0, DiggoError::EpochNotRolled);
    // One commit per epoch. A successful commit stamps the coin's own epoch index, so a
    // second call in the same epoch is refused; the walk's next rollover moves the index and
    // arms the next target, which is what re-opens this path.
    require!(
        coin.epoch_seed_recorded_slot == 0 || coin.epoch_seed_epoch < coin.epoch_index,
        DiggoError::SeedAlreadyCommitted
    );
    require!(target <= clock.slot, DiggoError::SeedTargetInFuture);

    let (recorded_slot, seed) = match plan_seed_reveal(
        target,
        clock.slot,
        protocol.epoch_seed_max_lateness_slots,
        protocol.epoch_seed_delay_slots,
    )? {
        SeedRevealPlan::Target => match slot_hash_at(&slot_hashes, target) {
            Some(seed) => (target, seed),
            None => return Err(error!(DiggoError::SeedTargetNotInSysvar)),
        },
        SeedRevealPlan::Oldest => match oldest_slot_hash(&slot_hashes) {
            Some((slot, seed)) => (slot, seed),
            None => return Err(error!(DiggoError::SeedTargetNotInSysvar)),
        },
        // Too late for the hash this epoch committed to. Re-arm at a slot that has not been
        // produced yet rather than settle from a slot whose hash was already public while the
        // epoch's rolls were being created.
        SeedRevealPlan::Rearm(rearmed) => {
            coin.epoch_seed_target_slot = rearmed;
            emit!(EpochSeedRearmed {
                coin: coin.key(),
                epoch_index: coin.epoch_index,
                target_slot: rearmed,
            });
            return Ok(());
        }
    };

    coin.epoch_seed = seed;
    coin.epoch_seed_recorded_slot = recorded_slot;
    coin.epoch_seed_epoch = coin.epoch_index;
    emit!(EpochSeedCommitted {
        coin: coin.key(),
        epoch_index: coin.epoch_index,
        target_slot: target,
        recorded_slot,
        seed,
    });
    Ok(())
}
