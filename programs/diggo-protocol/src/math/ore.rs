//! math::ore.rs - lazy ORE accrual, storage and the streak grant. WS-A owns this file.
//!
//! ORE is the non-transferable progression resource (design section 2, item 4): never an SPL
//! token, never tradeable, never purchasable. The only thing it can be spent on is
//! `upgrade_crew`, and crew levels are the only player input to Mining Power, so ORE is the
//! whole progression loop and real money has no path into it.
//!
//! The module is a pure mirror of the off-chain curve in `shared/ore.ts`, at the precision the
//! chain can actually pay: the frozen tables below are the same integers the TypeScript ships,
//! and `shared/parity/player.json` pins the two against each other from the Rust side.
//!
//! `math/mod.rs` is read-only in Phase 1 (CONTRACTS.md rule 1), so this new module is declared
//! from `math/power.rs` with an explicit path instead. The integrator should move those two
//! lines into `math/mod.rs` and delete them from `power.rs`.

use crate::*;

/// ORE is earned per active second, so the accrual is a rate rather than a schedule.
pub const SECONDS_PER_HOUR: u64 = 3_600;
/// Length of one ORE-maturity day. ORE maturity is measured from `created_at` (design
/// section 5), where the extra precision over a slot count is worth more than the residual.
pub const SECONDS_PER_DAY: i64 = 86_400;
/// Base ORE per fully active hour, before maturity and before Carts and Foreman.
pub const BASE_ORE_PER_ACTIVE_HOUR: u64 = 30;
/// ORE granted for a fresh activation, before maturity.
pub const ACTIVATION_BONUS_ORE: u64 = 50;
/// Storage always holds at least this much, whatever the crew looks like.
pub const STORAGE_BASE_CAPACITY: u64 = 1_800;
/// Hours of offline accrual at storage level 1, and the hours each further level adds.
pub const OFFLINE_HOURS_BASE: u64 = 24;
pub const OFFLINE_HOURS_PER_STORAGE_LEVEL: u64 = 4;
/// Hard ceiling on offline hours, so no crew accrues without end.
pub const OFFLINE_HOURS_CAP: u64 = 168;
/// Most Streak Freezes a player may bank. Freezes are earned by playing and by nothing else.
pub const FREEZE_CAP: u8 = 3;
/// Consecutive days of play that earn one Streak Freeze.
pub const FREEZE_EARN_INTERVAL_DAYS: u16 = 7;
/// Missed windows a single Streak Freeze covers.
pub const FREEZE_COVERED_WINDOWS: i64 = 1;

/// Streak milestones as (day, ORE, Streak Freezes). They grant ORE, XP and freezes and
/// nothing else: no token reward multiplier, no block share, no discovery luck. The shape of
/// this table is the guarantee - there is no field here a token payout could be written into.
pub const STREAK_MILESTONES: [(u16, u64, u8); 7] = [
    (3, 75, 0),
    (7, 250, 0),
    (14, 500, 0),
    (30, 1_200, 1),
    (60, 2_500, 0),
    (100, 5_000, 1),
    (365, 25_000, 3),
];

/// round(10_000 * carts_efficiency(level)): Carts raise ORE, never power.
pub static CARTS_ORE_BPS: [u16; CURVE_TABLE_POWER_LEN] = [
     10000,  10241,  10466,  10675,  10870,  11051,  11220,  11377,  11523,  11660,
     11787,  11905,  12015,  12117,  12212,  12301,  12384,  12461,  12532,  12599,
     12661,  12719,  12773,  12823,  12870,  12913,  12954,  12991,  13026,  13059,
     13089,  13118,  13144,  13169,  13191,  13213,  13233,  13251,  13268,  13284,
     13299,  13313,  13326,  13338,  13349,  13359,  13369,  13378,  13386,  13394,
     13402,  13408,  13415,  13421,  13426,  13431,  13436,  13440,  13444,  13448,
     13452,  13455,  13458,  13461,  13464,  13466,  13469,  13471,  13473,  13475,
     13476,  13478,  13480,  13481,  13482,  13483,  13485,  13486,  13487,  13488,
     13488,  13489,  13490,  13491,  13491,  13492,  13492,  13493,  13493,  13494,
     13494,  13495,  13495,  13495,  13496,  13496,  13496,  13497,  13497,  13497,
];

/// round(10_000 * foreman_efficiency(level)): the Foreman's ORE half.
pub static FOREMAN_ORE_BPS: [u16; CURVE_TABLE_POWER_LEN] = [
     10000,  10108,  10210,  10307,  10399,  10485,  10567,  10644,  10718,  10787,
     10852,  10915,  10973,  11029,  11081,  11131,  11178,  11222,  11264,  11304,
     11342,  11377,  11411,  11443,  11473,  11501,  11528,  11554,  11578,  11601,
     11622,  11643,  11662,  11680,  11698,  11714,  11729,  11744,  11758,  11771,
     11783,  11795,  11806,  11817,  11826,  11836,  11845,  11853,  11861,  11869,
     11876,  11882,  11889,  11895,  11900,  11906,  11911,  11916,  11920,  11925,
     11929,  11933,  11936,  11940,  11943,  11946,  11949,  11952,  11954,  11957,
     11959,  11961,  11963,  11965,  11967,  11969,  11971,  11972,  11974,  11975,
     11977,  11978,  11979,  11980,  11981,  11982,  11983,  11984,  11985,  11986,
     11987,  11987,  11988,  11989,  11989,  11990,  11990,  11991,  11991,  11992,
];

/// floor(storage_capacity_scale * level ^ storage_capacity_exponent).
pub static STORAGE_CAPACITY: [u32; CURVE_TABLE_POWER_LEN] = [
      420,   721,   989,  1238,  1473,  1699,  1916,  2126,  2331,  2530,
     2726,  2917,  3105,  3290,  3472,  3651,  3828,  4002,  4175,  4345,
     4514,  4681,  4846,  5009,  5171,  5332,  5491,  5649,  5806,  5962,
     6116,  6269,  6422,  6573,  6723,  6873,  7021,  7169,  7316,  7462,
     7607,  7751,  7895,  8037,  8180,  8321,  8462,  8602,  8741,  8880,
     9018,  9156,  9293,  9430,  9566,  9701,  9836,  9970, 10104, 10237,
    10370, 10503, 10634, 10766, 10897, 11027, 11158, 11287, 11416, 11545,
    11674, 11802, 11930, 12057, 12184, 12310, 12436, 12562, 12688, 12813,
    12938, 13062, 13186, 13310, 13433, 13556, 13679, 13802, 13924, 14046,
    14167, 14289, 14410, 14530, 14651, 14771, 14891, 15010, 15130, 15249,
];

/// floor(carts_capacity_scale * sqrt(level)).
pub static CARTS_CAPACITY: [u32; CURVE_TABLE_POWER_LEN] = [
     120,  169,  207,  240,  268,  293,  317,  339,  360,  379,
     397,  415,  432,  448,  464,  480,  494,  509,  523,  536,
     549,  562,  575,  587,  600,  611,  623,  634,  646,  657,
     668,  678,  689,  699,  709,  720,  729,  739,  749,  758,
     768,  777,  786,  795,  804,  813,  822,  831,  840,  848,
     856,  865,  873,  881,  889,  897,  905,  913,  921,  929,
     937,  944,  952,  960,  967,  974,  982,  989,  996, 1003,
    1011, 1018, 1025, 1032, 1039, 1046, 1052, 1059, 1066, 1073,
    1080, 1086, 1093, 1099, 1106, 1112, 1119, 1125, 1132, 1138,
    1144, 1150, 1157, 1163, 1169, 1175, 1181, 1187, 1193, 1200,
];

/// floor(base[component] * level ^ upgrade_cost_exponent), indexed [component][level - 1].
pub const UPGRADE_ORE_COST: [[u32; CURVE_TABLE_POWER_LEN]; CREW_COMPONENTS] = [
  // miners
  [
       80,   211,   372,   557,   761,   982,  1219,  1470,  1733,  2009,
     2296,  2593,  2901,  3218,  3545,  3880,  4223,  4575,  4935,  5303,
     5678,  6060,  6449,  6845,  7247,  7656,  8072,  8493,  8921,  9355,
     9794, 10239, 10690, 11147, 11608, 12075, 12547, 13025, 13507, 13995,
    14487, 14984, 15486, 15992, 16503, 17019, 17539, 18064, 18593, 19127,
    19664, 20206, 20752, 21303, 21857, 22415, 22978, 23544, 24114, 24688,
    25266, 25848, 26434, 27023, 27616, 28213, 28813, 29417, 30024, 30635,
    31250, 31868, 32489, 33114, 33742, 34373, 35008, 35646, 36288, 36933,
    37581, 38232, 38886, 39544, 40204, 40868, 41535, 42205, 42878, 43554,
    44233, 44915, 45600, 46288, 46978, 47672, 48369, 49068, 49771, 50476,
  ],
  // drills
  [
      115,   303,   535,   800,  1094,  1412,  1753,  2113,  2492,  2888,
     3301,  3728,  4170,  4626,  5095,  5577,  6071,  6577,  7095,  7623,
     8162,  8711,  9270,  9839, 10418, 11006, 11603, 12210, 12824, 13448,
    14080, 14719, 15368, 16023, 16687, 17358, 18037, 18723, 19417, 20117,
    20825, 21540, 22261, 22989, 23724, 24465, 25213, 25967, 26728, 27495,
    28268, 29047, 29832, 30623, 31419, 32222, 33031, 33845, 34664, 35490,
    36321, 37157, 37999, 38846, 39698, 40556, 41419, 42287, 43160, 44038,
    44922, 45810, 46703, 47601, 48504, 49412, 50325, 51242, 52164, 53091,
    54022, 54958, 55899, 56844, 57794, 58748, 59706, 60669, 61637, 62609,
    63585, 64565, 65550, 66539, 67532, 68529, 69530, 70536, 71546, 72560,
  ],
  // carts
  [
      120,   316,   558,   835,  1142,  1474,  1829,  2205,  2600,  3014,
     3444,  3890,  4352,  4827,  5317,  5820,  6335,  6863,  7403,  7954,
     8517,  9090,  9673, 10267, 10871, 11485, 12108, 12740, 13382, 14033,
    14692, 15359, 16036, 16720, 17413, 18113, 18821, 19537, 20261, 20992,
    21730, 22476, 23229, 23989, 24755, 25529, 26309, 27096, 27890, 28690,
    29497, 30309, 31129, 31954, 32786, 33623, 34467, 35316, 36172, 37033,
    37900, 38773, 39651, 40535, 41424, 42319, 43220, 44125, 45037, 45953,
    46875, 47802, 48734, 49671, 50613, 51560, 52513, 53470, 54432, 55399,
    56371, 57348, 58329, 59316, 60307, 61302, 62302, 63307, 64317, 65331,
    66349, 67372, 68400, 69432, 70468, 71509, 72554, 73603, 74656, 75714,
  ],
  // foreman
  [
      190,   501,   884,  1323,  1808,  2334,  2896,  3492,  4118,  4772,
     5453,  6160,  6890,  7644,  8419,  9215, 10031, 10867, 11722, 12594,
    13485, 14392, 15316, 16257, 17213, 18185, 19171, 20173, 21189, 22218,
    23262, 24319, 25390, 26474, 27570, 28679, 29801, 30935, 32080, 33238,
    34407, 35587, 36779, 37982, 39196, 40421, 41657, 42903, 44159, 45426,
    46703, 47990, 49287, 50594, 51911, 53237, 54573, 55918, 57272, 58636,
    60008, 61390, 62781, 64180, 65589, 67006, 68431, 69866, 71308, 72759,
    74219, 75686, 77162, 78646, 80138, 81638, 83145, 84661, 86184, 87716,
    89255, 90801, 92355, 93917, 95486, 97062, 98646, 100237, 101835, 103441,
    105053, 106673, 108300, 109934, 111574, 113222, 114877, 116538, 118206, 119881,
  ],
  // storage
  [
      150,   395,   698,  1044,  1427,  1842,  2286,  2756,  3251,  3767,
     4305,  4863,  5440,  6034,  6646,  7275,  7919,  8579,  9254,  9943,
    10646, 11362, 12092, 12834, 13589, 14356, 15135, 15926, 16728, 17541,
    18365, 19199, 20045, 20900, 21766, 22641, 23527, 24422, 25326, 26240,
    27163, 28095, 29036, 29986, 30944, 31911, 32887, 33871, 34863, 35863,
    36871, 37887, 38911, 39943, 40982, 42029, 43084, 44145, 45215, 46291,
    47375, 48466, 49564, 50669, 51780, 52899, 54025, 55157, 56296, 57441,
    58593, 59752, 60917, 62089, 63266, 64451, 65641, 66838, 68040, 69249,
    70464, 71685, 72912, 74145, 75383, 76628, 77878, 79134, 80396, 81664,
    82937, 84215, 85500, 86790, 88085, 89386, 90692, 92004, 93321, 94643,
  ],
];

/// Maturity of a PlayerAccount measured from its creation timestamp, in bps of full accrual.
/// The same schedule power uses, so an account never has to reason about two ages.
pub fn ore_maturity_bps(created_at: i64, now: i64) -> u16 {
    if now < created_at {
        return 0;
    }
    maturity_ramp_bps(((now - created_at) / SECONDS_PER_DAY) as u64)
}

/// `floor(carts_ore_bps[carts] * foreman_ore_bps[foreman] / BPS)`: the logistics bonus.
/// Carts and Foreman raise ORE and never Mining Power, which is what keeps a crew that
/// invests in logistics from also mining harder.
pub fn ore_efficiency_bps(levels: [u16; CREW_COMPONENTS]) -> Result<u64> {
    let carts = CARTS_ORE_BPS[level_index(levels[2])?] as u64;
    let foreman = FOREMAN_ORE_BPS[level_index(levels[3])?] as u64;
    u64::try_from(
        (carts as u128)
            .checked_mul(foreman as u128)
            .ok_or(DiggoError::MathOverflow)?
            / BPS,
    )
    .map_err(|_| error!(DiggoError::MathOverflow))
}

/// How much ORE the crew's storage can hold. Storage is the offline branch and Carts adds a
/// little to it as well, because both are about getting the load out of the shaft.
pub fn ore_capacity(levels: [u16; CREW_COMPONENTS]) -> Result<u64> {
    let storage = STORAGE_CAPACITY[level_index(levels[4])?] as u64;
    let carts = CARTS_CAPACITY[level_index(levels[2])?] as u64;
    STORAGE_BASE_CAPACITY
        .checked_add(storage)
        .and_then(|value| value.checked_add(carts))
        .ok_or_else(|| error!(DiggoError::MathOverflow))
}

/// How long an activated crew keeps accruing while the player is away, before the accrual
/// clamps. It is a cap on one settlement, never a cap on the day's earnings.
pub fn offline_hours(levels: [u16; CREW_COMPONENTS]) -> Result<u64> {
    let storage = level_index(levels[4])? as u64;
    let hours = OFFLINE_HOURS_BASE
        .checked_add(
            OFFLINE_HOURS_PER_STORAGE_LEVEL
                .checked_mul(storage)
                .ok_or(DiggoError::MathOverflow)?,
        )
        .ok_or(DiggoError::MathOverflow)?;
    Ok(hours.min(OFFLINE_HOURS_CAP))
}

/// Longest stretch one settlement may pay for. The activation window and the accrual cap are
/// the same day, so a settlement never pays for time the window was closed.
pub fn max_accrual_seconds() -> u64 {
    (ACTIVATION_SECONDS as u64).min(SECONDS_PER_DAY as u64)
}

/// `floor(seconds * BASE_ORE_PER_ACTIVE_HOUR * maturity_bps * efficiency_bps / (3600 * BPS^2))`.
///
/// One rounding, at the end, downwards: the chain never hands out a fractional unit of ORE it
/// did not earn, and the off-chain mirror rounds in exactly the same place. A lapsed window
/// passes `active_seconds = 0`, because a paused mine accrues nothing.
pub fn ore_for_active_seconds(
    active_seconds: u64,
    maturity_bps: u16,
    efficiency_bps: u64,
) -> Result<u64> {
    if active_seconds == 0 {
        return Ok(0);
    }
    let seconds = active_seconds.min(max_accrual_seconds());
    let numerator = (seconds as u128)
        .checked_mul(BASE_ORE_PER_ACTIVE_HOUR as u128)
        .and_then(|value| value.checked_mul(maturity_bps as u128))
        .and_then(|value| value.checked_mul(efficiency_bps as u128))
        .ok_or(DiggoError::AccrualOverflow)?;
    let denominator = (SECONDS_PER_HOUR as u128)
        .checked_mul(BPS)
        .and_then(|value| value.checked_mul(BPS))
        .ok_or(DiggoError::AccrualOverflow)?;
    u64::try_from(numerator / denominator).map_err(|_| error!(DiggoError::AccrualOverflow))
}

/// ORE for a fresh activation, throttled by the same maturity ramp as the accrual.
pub fn ore_from_activation(maturity_bps: u16) -> Result<u64> {
    mul_bps(ACTIVATION_BONUS_ORE, maturity_bps)
}

/// Deposits ORE into storage and reports the overflow explicitly. Nothing is ever silently
/// discarded: the caller receives the overflow and the OreCollected event reports it.
pub fn store_ore(balance: u64, amount: u64, capacity: u64) -> (u64, u64, u64) {
    let free = capacity.saturating_sub(balance);
    let stored = free.min(amount);
    (balance.saturating_add(stored), stored, amount - stored)
}

/// ORE and Streak Freezes granted by the milestones crossed between `previous_streak` and
/// `new_streak`, lowest day first. A streak that did not grow crosses nothing.
pub fn milestone_rewards(previous_streak: u16, new_streak: u16) -> (u64, u8) {
    let mut ore = 0u64;
    let mut freezes = 0u8;
    if new_streak <= previous_streak {
        return (0, 0);
    }
    for (day, milestone_ore, milestone_freezes) in STREAK_MILESTONES {
        if day > previous_streak && day <= new_streak {
            ore = ore.saturating_add(milestone_ore);
            freezes = freezes.saturating_add(milestone_freezes);
        }
    }
    (ore, freezes)
}

/// Streak Freezes earned by sustained play: one per whole FREEZE_EARN_INTERVAL_DAYS crossed.
pub fn freezes_earned_by_interval(previous_streak: u16, new_streak: u16) -> u8 {
    if FREEZE_EARN_INTERVAL_DAYS == 0 {
        return 0;
    }
    let before = previous_streak / FREEZE_EARN_INTERVAL_DAYS;
    let after = new_streak / FREEZE_EARN_INTERVAL_DAYS;
    after.saturating_sub(before) as u8
}

/// Applies a freeze grant and the banked cap. Freezes are only ever granted by gameplay:
/// there is no purchase path in this module, and there is no instruction that mints one.
pub fn grant_freezes(current_freezes: u8, granted: u8) -> (u8, u8) {
    let base = current_freezes.min(FREEZE_CAP);
    let freezes = base.saturating_add(granted).min(FREEZE_CAP);
    (freezes, freezes - base)
}

/// The streak rule, as a pure function of the previous activation and now.
///
/// A window that follows within `activation_seconds + grace_seconds` of the previous
/// activation continues the streak. One missed window is covered by a Streak Freeze if the
/// player has one, which is spent. Anything longer breaks the streak back to one.
///
/// Returns (streak, freezes, used_freeze).
pub fn next_streak(
    last_activation_at: Option<i64>,
    now: i64,
    current_streak: u16,
    freezes: u8,
    activation_seconds: i64,
    grace_seconds: i64,
    freeze_covered_windows: i64,
) -> (u16, u8, bool) {
    let Some(previous) = last_activation_at else {
        return (1, freezes, false);
    };
    let deadline = previous
        .saturating_add(activation_seconds)
        .saturating_add(grace_seconds);
    if now <= deadline {
        return (current_streak.saturating_add(1), freezes, false);
    }
    let freeze_deadline = deadline.saturating_add(activation_seconds.saturating_mul(freeze_covered_windows));
    if now <= freeze_deadline && freezes > 0 {
        return (current_streak.saturating_add(1), freezes - 1, true);
    }
    (1, freezes, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn starter() -> [u16; CREW_COMPONENTS] {
        [CREW_START_LEVEL; CREW_COMPONENTS]
    }

    #[test]
    fn ore_tables_are_monotonic_and_the_capacity_floor_holds() {
        for i in 1..CURVE_TABLE_POWER_LEN {
            assert!(STORAGE_CAPACITY[i] > STORAGE_CAPACITY[i - 1]);
            assert!(CARTS_CAPACITY[i] >= CARTS_CAPACITY[i - 1]);
            assert!(CARTS_ORE_BPS[i] >= CARTS_ORE_BPS[i - 1]);
            assert!(FOREMAN_ORE_BPS[i] >= FOREMAN_ORE_BPS[i - 1]);
        }
        assert_eq!(CARTS_ORE_BPS[0], 10_000);
        assert_eq!(FOREMAN_ORE_BPS[0], 10_000);
        assert!(ore_capacity(starter()).unwrap() >= STORAGE_BASE_CAPACITY);
    }

    #[test]
    fn logistics_raise_ore_and_storage_and_never_power() {
        let base = ore_efficiency_bps(starter()).unwrap();
        assert_eq!(base, 10_000);
        let carts = ore_efficiency_bps([1, 1, 60, 1, 1]).unwrap();
        let foreman = ore_efficiency_bps([1, 1, 1, 60, 1]).unwrap();
        assert!(carts > base && foreman > base);
        // The same levels leave Mining Power untouched, which is the whole point of the split.
        assert_eq!(
            crew_power([1, 1, 60, 60, 60]).unwrap(),
            crew_power(starter()).unwrap()
        );
        assert!(ore_capacity([1, 1, 1, 1, 40]).unwrap() > ore_capacity(starter()).unwrap());
        assert!(ore_capacity([1, 1, 40, 1, 1]).unwrap() > ore_capacity(starter()).unwrap());
    }

    #[test]
    fn offline_hours_rise_with_storage_and_stop_at_the_cap() {
        assert_eq!(offline_hours(starter()).unwrap(), OFFLINE_HOURS_BASE);
        assert!(offline_hours([1, 1, 1, 1, 20]).unwrap() > OFFLINE_HOURS_BASE);
        assert_eq!(offline_hours([1, 1, 1, 1, 100]).unwrap(), OFFLINE_HOURS_CAP);
        assert_eq!(offline_hours([1, 1, 1, 1, 100]).unwrap(), offline_hours([1, 1, 1, 1, MAX_CREW_LEVEL]).unwrap());
    }

    #[test]
    fn accrual_rounds_down_once_and_clamps_to_one_day() {
        // One full active hour at full maturity and starter logistics is exactly the base rate.
        assert_eq!(ore_for_active_seconds(SECONDS_PER_HOUR, 10_000, 10_000).unwrap(), BASE_ORE_PER_ACTIVE_HOUR);
        // Maturity throttles it, and a zero-second settlement pays nothing at all.
        assert_eq!(ore_for_active_seconds(SECONDS_PER_HOUR, 2_000, 10_000).unwrap(), 6);
        assert_eq!(ore_for_active_seconds(0, 10_000, 10_000).unwrap(), 0);
        assert_eq!(ore_for_active_seconds(3_599, 10_000, 10_000).unwrap(), 29);
        // The clamp is the accrual cap, so a week away pays the same as a day.
        let capped = ore_for_active_seconds(max_accrual_seconds(), 10_000, 10_000).unwrap();
        assert_eq!(ore_for_active_seconds(7 * SECONDS_PER_DAY as u64, 10_000, 10_000).unwrap(), capped);
        assert_eq!(capped, BASE_ORE_PER_ACTIVE_HOUR * 24);
    }

    #[test]
    fn accrual_is_monotonic_in_every_input() {
        let mut previous = 0;
        for seconds in (0..SECONDS_PER_DAY as u64).step_by(600) {
            let ore = ore_for_active_seconds(seconds, 10_000, 10_000).unwrap();
            assert!(ore >= previous);
            previous = ore;
        }
        let mut previous = 0;
        for maturity in (0..=10_000u16).step_by(500) {
            let ore = ore_for_active_seconds(3_600, maturity, 10_000).unwrap();
            assert!(ore >= previous);
            previous = ore;
        }
    }

    #[test]
    fn activation_bonus_follows_the_maturity_ramp() {
        assert_eq!(ore_from_activation(10_000).unwrap(), ACTIVATION_BONUS_ORE);
        assert_eq!(ore_from_activation(2_000).unwrap(), 10);
        assert!(ore_from_activation(7_000).unwrap() > ore_from_activation(2_000).unwrap());
    }

    #[test]
    fn storage_reports_overflow_instead_of_dropping_it() {
        let capacity = ore_capacity(starter()).unwrap();
        let (balance, stored, overflow) = store_ore(capacity - 10, 50, capacity);
        assert_eq!(stored, 10);
        assert_eq!(overflow, 40);
        assert_eq!(balance, capacity);
        let (balance, stored, overflow) = store_ore(capacity, 50, capacity);
        assert_eq!((stored, overflow), (0, 50));
        assert_eq!(balance, capacity);
        let (balance, stored, overflow) = store_ore(470, 50, capacity);
        assert_eq!((balance, stored, overflow), (520, 50, 0));
    }

    #[test]
    fn milestones_grant_ore_and_freezes_only_when_the_streak_grows() {
        assert_eq!(milestone_rewards(0, 1), (0, 0));
        assert_eq!(milestone_rewards(2, 3), (75, 0));
        assert_eq!(milestone_rewards(2, 8), (325, 0));
        assert_eq!(milestone_rewards(2, 31), (2_025, 1));
        assert_eq!(milestone_rewards(29, 30), (1_200, 1));
        assert_eq!(milestone_rewards(0, 365), (34_525, 5));
        // A broken streak crosses nothing, and a repeat activation cannot re-mint a milestone.
        assert_eq!(milestone_rewards(10, 1), (0, 0));
        assert_eq!(milestone_rewards(7, 7), (0, 0));
    }

    #[test]
    fn freezes_are_earned_by_intervals_and_capped() {
        assert_eq!(freezes_earned_by_interval(0, 6), 0);
        assert_eq!(freezes_earned_by_interval(6, 7), 1);
        assert_eq!(freezes_earned_by_interval(0, 100), 14);
        assert_eq!(grant_freezes(0, 1), (1, 1));
        assert_eq!(grant_freezes(3, 5), (3, 0));
        assert_eq!(grant_freezes(1, 1), (2, 1));
    }

    #[test]
    fn the_streak_continues_freezes_and_breaks() {
        let day = 86_400i64;
        let grace = ACTIVATION_GRACE_SECONDS;
        // First activation.
        assert_eq!(next_streak(None, day, 0, 0, day, grace, FREEZE_COVERED_WINDOWS), (1, 0, false));
        // Inside the window plus grace: the streak grows.
        assert_eq!(next_streak(Some(0), day, 4, 0, day, grace, FREEZE_COVERED_WINDOWS), (5, 0, false));
        assert_eq!(
            next_streak(Some(0), day + grace, 4, 0, day, grace, FREEZE_COVERED_WINDOWS),
            (5, 0, false)
        );
        // One missed window with a freeze in hand: the freeze is spent and the streak lives.
        assert_eq!(
            next_streak(Some(0), day + grace + 1, 4, 2, day, grace, FREEZE_COVERED_WINDOWS),
            (5, 1, true)
        );
        // One missed window with no freeze, and two missed windows with one: both break.
        assert_eq!(
            next_streak(Some(0), day + grace + 1, 4, 0, day, grace, FREEZE_COVERED_WINDOWS),
            (1, 0, false)
        );
        assert_eq!(
            next_streak(Some(0), 3 * day, 4, 3, day, grace, FREEZE_COVERED_WINDOWS),
            (1, 3, false)
        );
    }

    #[test]
    fn ore_maturity_uses_the_same_schedule_as_power() {
        assert_eq!(ore_maturity_bps(0, 0), 2_000);
        assert_eq!(ore_maturity_bps(0, SECONDS_PER_DAY), 4_000);
        assert_eq!(ore_maturity_bps(0, 7 * SECONDS_PER_DAY), 10_000);
        assert_eq!(ore_maturity_bps(1_000, 0), 0);
    }
}
