//! state::pool.rs (phase 0a mechanical split of lib.rs).

use crate::*;



/// The program-owned, permanently locked liquidity pool a market graduates into
/// (spec 36).
///
/// There is deliberately no LP mint and no LP token: the pool's token vault is owned by
/// this PDA and its SOL lives in a PDA vault owned by the program, so the only way either
/// can shrink is a real swap through apply_pool_swap. No creator, admin, guardian or
/// keeper instruction can withdraw from it.
#[account]
#[derive(InitSpace)]
pub struct LiquidityPool {
    pub mine: Pubkey,
    pub mint: Pubkey,
    /// Token vault PDA (POOL_VAULT_SEED), authority = this pool.
    pub token_vault: Pubkey,
    /// SOL vault PDA (POOL_SOL_SEED), lamports = rent floor + sol_reserve.
    pub sol_vault: Pubkey,
    pub token_reserve: u64,
    pub sol_reserve: u64,
    pub graduated_at: i64,
    pub bump: u8,
}


/// The pool's SOL vault. It carries no authority of its own: the pool PDA is the only
/// thing that may spend these lamports, and only through a swap.
#[account]
#[derive(InitSpace)]
pub struct PoolSolVault {
    pub pool: Pubkey,
    pub bump: u8,
}
