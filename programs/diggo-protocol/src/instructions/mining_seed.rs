//! Epoch seed commit and reveal (design 4.1). WS-C owns this file.

use crate::*;

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
    pub coin: Account<'info, Coin>,
    #[account(seeds = [PROTOCOL_SEED], bump = protocol.bump)]
    pub protocol: Account<'info, ProtocolConfig>,
    pub slot_hashes: Sysvar<'info, SlotHashes>,
}

pub fn commit_epoch_seed(_ctx: Context<CommitEpochSeed>) -> Result<()> {
    err!(DiggoError::NotImplemented)
}

