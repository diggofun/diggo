//! math::power.rs (phase 0a mechanical split of lib.rs).

use crate::*;



/// Bounded keeper power rule: never above ProtocolConfig.max_crew_power (itself clamped
/// by MAX_CREW_POWER_HARD_CAP), and never more than max_power_increase_bps plus the
/// always-allowed MIN_POWER_STEP above the previous value. Decreases are intentionally
/// unbounded so abuse handling can still reduce a player's power.
pub fn validate_power_update(
    protocol: &ProtocolConfig,
    previous_power: u64,
    new_power: u64,
) -> Result<()> {
    require!(
        new_power <= protocol.max_crew_power && new_power <= MAX_CREW_POWER_HARD_CAP,
        DiggoError::PowerOutOfRange
    );
    let allowed = previous_power
        .saturating_add(mul_bps(previous_power, protocol.max_power_increase_bps)?)
        .saturating_add(MIN_POWER_STEP);
    require!(new_power <= allowed, DiggoError::PowerIncreaseTooLarge);
    Ok(())
}
