//! DiggoError: every program error code.

use crate::*;



#[error_code]
pub enum DiggoError {
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Invalid treasury")]
    InvalidTreasury,
    #[msg("Protocol may only be initialized by the program upgrade authority")]
    UnauthorizedInitializer,
    #[msg("Invalid program data account")]
    InvalidProgramData,
    #[msg("Invalid metadata")]
    InvalidMetadata,
    #[msg("Invalid decimals")]
    InvalidDecimals,
    #[msg("Invalid reserve split")]
    InvalidReserveSplit,
    #[msg("Invalid reward parameters")]
    InvalidReward,
    #[msg("Invalid schedule")]
    InvalidSchedule,
    #[msg("Invalid market parameters")]
    InvalidMarket,
    #[msg("Slippage limit exceeded")]
    SlippageExceeded,
    #[msg("Insufficient launch liquidity")]
    InsufficientLiquidity,
    #[msg("Power is already assigned to another mine")]
    PowerAlreadyAssigned,
    #[msg("No mining power is assigned")]
    NoPowerAssigned,
    #[msg("No rewards are available")]
    NothingToClaim,
    /// Retained so no other error code moves; the ledger walk no longer returns it.
    /// A mine that is more calls behind than the walk can cover now reports SyncBehind
    /// from the settling instructions and is advanced by advance_mine instead.
    #[msg("Mine synchronization requires multiple calls")]
    SyncWindowTooLarge,
    #[msg("Invalid keeper authority")]
    InvalidKeeper,
    #[msg("Keeper-supplied power exceeds the protocol safety bound")]
    PowerOutOfRange,
    #[msg("Discovery reserve does not have enough balance for this claim")]
    InsufficientDiscoveryReserve,
    #[msg("Invalid guardian authority")]
    InvalidGuardian,
    #[msg("Discovery payouts are paused by the protocol circuit breaker")]
    DiscoveryPayoutsPaused,
    #[msg("Reward claims are paused by the protocol circuit breaker")]
    RewardClaimsPaused,
    #[msg("Discovery is paused for this mine")]
    MineDiscoveryPaused,
    #[msg("Discovery amount exceeds the per-call ceiling")]
    DiscoveryAmountTooLarge,
    #[msg("Discovery epoch budget is exhausted for this mine")]
    DiscoveryEpochBudgetExceeded,
    #[msg("Mining reserve does not have enough balance")]
    InsufficientReserve,
    #[msg("Reserve tokens may only leave through a valid mining or discovery claim")]
    ReserveWithdrawForbidden,
    #[msg("Crew power increase exceeds the per-call bound")]
    PowerIncreaseTooLarge,
    #[msg("Trading fee exceeds the protocol cap")]
    FeeTooHigh,
    #[msg("Invalid power bounds")]
    InvalidPowerBounds,
    #[msg("Invalid discovery limits")]
    DiscoveryLimitsOutOfRange,
    #[msg("Only the mine creator may claim creator fees")]
    UnauthorizedCreator,
    #[msg("This market has graduated; trade through the liquidity pool instead")]
    MarketGraduated,
    #[msg("This market has not graduated yet; trade on the bonding curve instead")]
    MarketNotGraduated,
    #[msg("This market has already graduated")]
    MarketAlreadyGraduated,
    #[msg("The market has not reached its graduation target")]
    GraduationTargetNotMet,
    #[msg("Invalid liquidity pool")]
    InvalidPool,
    #[msg("Pool liquidity is permanently locked and may only leave through a swap")]
    PoolWithdrawForbidden,
    #[msg("The swap would have reduced the pool invariant")]
    PoolInvariantViolated,
    #[msg("The account already has the current layout")]
    AccountAlreadyCurrent,
    #[msg("The account is not a migratable program account of the declared kind")]
    InvalidAccountLayout,
    #[msg("Fund the account for its new rent-exempt minimum before migrating it")]
    MigrationNeedsFunding,
    #[msg("Unsupported account kind")]
    UnsupportedAccountKind,
    /// The settling instructions refuse to read a ledger that is still behind now,
    /// because a partially walked reward_index would under-credit the elapsed epochs it
    /// hid behind last_reward_index. Permissionless: call advance_mine repeatedly (each
    /// call walks MAX_SYNC_SEGMENTS segments) and then retry.
    #[msg("This mine is behind and must be advanced with advance_mine before its positions can settle")]
    SyncBehind,
    /// The curve-mining budget a market was launched with is spent. It is immutable, so
    /// this is the end of the curve phase's emission rather than a signal to raise it.
    #[msg("Curve mining has spent the whole budget this market was launched with")]
    CurveMiningCapExceeded,
    #[msg("Curve tokens may only leave the market through a settled mining emission or a buy")]
    CurveWithdrawForbidden,
    #[msg("Invalid curve mining parameters")]
    InvalidCurveMining,
}
