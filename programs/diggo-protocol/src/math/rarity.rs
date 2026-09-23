//! math::rarity.rs (phase 0a mechanical split of lib.rs).

use crate::*;



/// Outcome of the pre-flight checks for one discovery payout. Returned instead of
/// mutating the mine so the whole rule set stays unit-testable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DiscoveryApproval {
    pub epoch_spent: u64,
    pub epoch_ends_at: i64,
    pub epoch_budget: u64,
}


/// The complete on-chain rule set for a discovery payout: scoped circuit breakers,
/// per-call ceiling, per-mine per-epoch budget, and reserve sufficiency. Idempotency is
/// enforced separately by the DiscoveryReceipt PDA.
pub fn approve_discovery_payout(
    protocol: &ProtocolConfigV4,
    mine: &Mine,
    amount: u64,
    now: i64,
) -> Result<DiscoveryApproval> {
    require!(
        !protocol.discovery_payouts_paused,
        DiggoError::DiscoveryPayoutsPaused
    );
    require!(!mine.discovery_paused, DiggoError::MineDiscoveryPaused);
    require!(amount > 0, DiggoError::InvalidAmount);
    require!(
        amount <= mine.remaining_discovery_reserve,
        DiggoError::InsufficientDiscoveryReserve
    );
    let max_per_call = mul_bps(mine.discovery_reserve_total, protocol.discovery_max_bps)?;
    require!(
        max_per_call > 0 && amount <= max_per_call,
        DiggoError::DiscoveryAmountTooLarge
    );
    let (epoch_spent, epoch_ends_at) = roll_discovery_epoch(mine, now)?;
    let spent = epoch_spent
        .checked_add(amount)
        .ok_or(DiggoError::MathOverflow)?;
    require!(
        spent <= mine.discovery_epoch_budget,
        DiggoError::DiscoveryEpochBudgetExceeded
    );
    Ok(DiscoveryApproval {
        epoch_spent: spent,
        epoch_ends_at,
        epoch_budget: mine.discovery_epoch_budget,
    })
}


/// Rolls the per-mine discovery epoch forwards past now in one step (no loop), resetting
/// the spent counter for every elapsed epoch.
pub fn roll_discovery_epoch(mine: &Mine, now: i64) -> Result<(u64, i64)> {
    if now < mine.discovery_epoch_ends_at {
        return Ok((mine.discovery_epoch_spent, mine.discovery_epoch_ends_at));
    }
    let length = mine.epoch_length.max(1);
    let elapsed = now.saturating_sub(mine.discovery_epoch_ends_at);
    let skipped = (elapsed / length)
        .checked_add(1)
        .ok_or(DiggoError::MathOverflow)?;
    let advance = skipped.checked_mul(length).ok_or(DiggoError::MathOverflow)?;
    let ends_at = mine
        .discovery_epoch_ends_at
        .checked_add(advance)
        .ok_or(DiggoError::MathOverflow)?;
    Ok((0, ends_at))
}

// ---- v2: the derived discovery outcome (design 4.1, 4.3, 8.2) ----------------------------

/// SHA-256 of the concatenation of the given slices.
///
/// The discovery derivation needs exactly one hash, and the Anchor version this program
/// builds against re-exports the granular Solana crates rather than the umbrella one, so no
/// SHA-256 hasher is reachable from the program's dependencies. Rather than add a dependency
/// to a frozen workspace and churn a Cargo.lock six workstreams share, the function is
/// implemented here in integer code and pinned by the golden vectors in the tests below -
/// which the TypeScript mirror in shared/epochSeed.ts asserts against the same values.
#[derive(Clone, Copy)]
struct Sha256 {
    state: [u32; 8],
    block: [u8; 64],
    block_len: usize,
    total: u64,
}

const SHA256_K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
    0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
    0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
    0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
    0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
    0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
    0xc67178f2,
];

impl Sha256 {
    fn new() -> Self {
        Self {
            state: [
                0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
                0x1f83d9ab, 0x5be0cd19,
            ],
            block: [0u8; 64],
            block_len: 0,
            total: 0,
        }
    }

    fn update(&mut self, mut data: &[u8]) {
        while !data.is_empty() {
            let take = core::cmp::min(64 - self.block_len, data.len());
            self.block[self.block_len..self.block_len + take].copy_from_slice(&data[..take]);
            self.block_len += take;
            self.total += take as u64;
            data = &data[take..];
            if self.block_len == 64 {
                self.compress();
                self.block_len = 0;
            }
        }
    }

    fn compress(&mut self) {
        let mut w = [0u32; 64];
        for index in 0..16 {
            let at = index * 4;
            w[index] = u32::from_be_bytes([
                self.block[at],
                self.block[at + 1],
                self.block[at + 2],
                self.block[at + 3],
            ]);
        }
        for index in 16..64 {
            let s0 = w[index - 15].rotate_right(7)
                ^ w[index - 15].rotate_right(18)
                ^ (w[index - 15] >> 3);
            let s1 = w[index - 2].rotate_right(17)
                ^ w[index - 2].rotate_right(19)
                ^ (w[index - 2] >> 10);
            w[index] = w[index - 16]
                .wrapping_add(s0)
                .wrapping_add(w[index - 7])
                .wrapping_add(s1);
        }
        let mut a = self.state[0];
        let mut b = self.state[1];
        let mut c = self.state[2];
        let mut d = self.state[3];
        let mut e = self.state[4];
        let mut f = self.state[5];
        let mut g = self.state[6];
        let mut h = self.state[7];
        for index in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let t1 = h
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(SHA256_K[index])
                .wrapping_add(w[index]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        self.state[0] = self.state[0].wrapping_add(a);
        self.state[1] = self.state[1].wrapping_add(b);
        self.state[2] = self.state[2].wrapping_add(c);
        self.state[3] = self.state[3].wrapping_add(d);
        self.state[4] = self.state[4].wrapping_add(e);
        self.state[5] = self.state[5].wrapping_add(f);
        self.state[6] = self.state[6].wrapping_add(g);
        self.state[7] = self.state[7].wrapping_add(h);
    }

    fn finish(mut self) -> [u8; 32] {
        let bit_len = self.total.wrapping_mul(8);
        self.update(&[0x80]);
        while self.block_len != 56 {
            self.update(&[0]);
        }
        self.update(&bit_len.to_be_bytes());
        let mut out = [0u8; 32];
        for index in 0..8 {
            out[index * 4..index * 4 + 4].copy_from_slice(&self.state[index].to_be_bytes());
        }
        out
    }
}

/// SHA-256 over the concatenation of the slices.
pub fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part);
    }
    hasher.finish()
}
// The scale every price in this file is denominated in is PRICE_SCALE, declared once in
// math/curve.rs and used by the pool's accumulator, the coin's mirror and the discovery payout
// alike. There is deliberately no second constant here: two scales that must agree is exactly how
// a payout ends up a million times too large, which is the row docs/CONTRACT_CHANGE_REQUESTS.md
// carried.
/// The discovery derivation: sha256 of the epoch seed, the player's wallet and the roll's
/// window index, in that order and with the window little-endian.
///
/// This is the whole of the randomness (design 4.1 step 4). The seed is a slot hash nobody
/// could know while the epoch's rolls were being created, the wallet and the window are
/// unique per roll, and there is no secret, no signature and no operator input anywhere in
/// the path - so anyone can recompute any past outcome from the recorded seed.
pub fn discovery_digest(seed: &[u8; 32], owner: &Pubkey, window_index: u16) -> [u8; 32] {
    sha256(&[
        seed.as_ref(),
        owner.as_ref(),
        window_index.to_le_bytes().as_ref(),
    ])
}

/// The roll the digest decides, in bps of BPS. The first two bytes, little-endian, reduced
/// into the table's own range.
pub fn discovery_roll_bps(digest: &[u8; 32]) -> u16 {
    (u16::from_le_bytes([digest[0], digest[1]]) % BPS as u16).min(BPS as u16 - 1)
}

/// The number of live tiers in the protocol's table.
pub fn rarity_tier_count(protocol: &ProtocolConfig) -> usize {
    (protocol.rarity_tier_count as usize).min(MAX_RARITY_TIERS)
}

/// The tier the roll lands in: the first live tier whose cumulative chance the roll falls
/// inside. Cumulative chances are non-decreasing and the last live tier is expected to be
/// BPS, which is what the launch-time table validation enforces; a table that ends short of
/// BPS simply has no outcome above its last tier, and None means no discovery at all.
pub fn rolled_rarity_tier(protocol: &ProtocolConfig, roll_bps: u16) -> Option<usize> {
    let count = rarity_tier_count(protocol);
    (0..count).find(|index| roll_bps < protocol.rarity_tiers[*index].cumulative_chance_bps)
}

/// The facts the on-chain eligibility rule is computed from, and the score it produces.
///
/// Every input is a fact the program owns (design 4.3): the SOL side of the coin's own
/// market, the SOL that market has actually taken in, what is left of the Discovery Reserve
/// and what is left of this epoch's discovery budget. No external price and no off-chain
/// volume feed is consulted, which is exactly why an illiquid token cannot be promoted to a
/// high rarity by anything a caller controls.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DiscoveryFacts {
    pub liquidity_lamports: u64,
    pub volume_lamports: u64,
    pub eligibility_score: u16,
}

/// One component of the score, each worth at most 25 of the 100 points, measured against a
/// reference the coin itself carries so the score cannot be inflated by a caller.
fn score_component(value: u64, reference: u64) -> u16 {
    if reference == 0 {
        return 0;
    }
    let scaled = (value as u128) * 25 / (reference as u128);
    (scaled.min(25)) as u16
}

/// The on-chain facts behind one discovery outcome.
///
/// Liquidity is the SOL side of the coin's own market including its virtual seed, which is
/// the only liquidity fact the discovery instructions can read: the pool account is not on
/// their account list, so a graduated coin's pooled liquidity is not visible here. Volume is
/// the SOL the curve has actually taken in. Both are compared against the coin's own
/// graduation target, and the reserve and headroom components against the coin's own
/// reserves, so nothing here is denominated in anything off chain.
pub fn discovery_facts(coin: &Coin, protocol: &ProtocolConfig) -> DiscoveryFacts {
    let _ = protocol;
    let liquidity = coin.sol_reserve.saturating_add(coin.virtual_sol_reserve);
    let volume = coin.sol_reserve;
    let reference = coin.graduation_target;
    let epoch_remaining = coin
        .discovery_epoch_budget
        .saturating_sub(coin.discovery_epoch_spent);
    let score = score_component(liquidity, reference)
        .saturating_add(score_component(volume, reference))
        .saturating_add(score_component(
            coin.discovery_remaining,
            coin.discovery_reserve_total,
        ))
        .saturating_add(score_component(epoch_remaining, coin.discovery_epoch_budget));
    DiscoveryFacts {
        liquidity_lamports: liquidity,
        volume_lamports: volume,
        eligibility_score: score.min(100),
    }
}

/// The highest tier at or below the rolled one whose floors the coin clears. None means the
/// coin clears no tier at all and the discovery pays nothing.
///
/// Downgrading rather than refusing is what the rarity floors are for: an illiquid coin can
/// still pay a common discovery, it simply cannot pay a mythic one.
pub fn resolve_rarity_tier(
    protocol: &ProtocolConfig,
    rolled: usize,
    facts: &DiscoveryFacts,
) -> Option<usize> {
    let count = rarity_tier_count(protocol);
    if count == 0 {
        return None;
    }
    let start = rolled.min(count - 1);
    for index in (0..=start).rev() {
        let tier = &protocol.rarity_tiers[index];
        if facts.eligibility_score < tier.min_eligibility_score {
            continue;
        }
        if facts.liquidity_lamports < tier.min_liquidity_lamports {
            continue;
        }
        if facts.volume_lamports < tier.min_volume_lamports {
            continue;
        }
        return Some(index);
    }
    None
}

/// The price the discovery path prices a payout with, in lamports per base unit scaled by
/// PRICE_SCALE.
///
/// Two readings of the coin's own market are taken and the higher one wins, with a deviation guard
/// between them:
///
///   - the short-window TWAP, the time-weighted price of the last TWAP_WINDOW_SLOTS slots, which
///     is the price the pool has actually traded at recently and the divisor a payout is
///     normalised by;
///   - the marginal price, which is what the coin's own curve implies right now before graduation
///     and the last price the pool traded at after it.
///
/// Taking the higher of the two is the safe direction: a price that has been pushed down would
/// otherwise buy more units for the same lamport value, which is how a discovery payout could be
/// used to drain the reserve, and pricing high can only ever pay fewer units than the value class
/// names. The guard is the second line: past DISCOVERY_TWAP_MAX_DEVIATION_BPS the spot is not
/// merely unhelpful, it is evidence of a sandwich around the settlement, so it is dropped and the
/// window stands on its own.
///
/// No external oracle is consulted, here or anywhere else in the discovery path.
pub fn coin_price_lamports_per_unit_scaled(coin: &Coin, now_slot: u64) -> Result<u128> {
    let window = coin.twap_price(now_slot).ok();
    let spot = coin_spot_lamports_per_unit_scaled(coin).ok();
    let price = match (window, spot) {
        (None, None) => return Err(error!(DiggoError::TwapUnavailable)),
        (Some(window), None) => window,
        (None, Some(spot)) => spot,
        (Some(window), Some(spot)) => {
            require!(window > 0, DiggoError::TwapUnavailable);
            let deviation = (spot.abs_diff(window))
                .checked_mul(BPS)
                .ok_or(DiggoError::MathOverflow)?
                / window;
            if deviation > DISCOVERY_TWAP_MAX_DEVIATION_BPS as u128 {
                window
            } else {
                window.max(spot)
            }
        }
    };
    require!(price > 0, DiggoError::TwapUnavailable);
    Ok(price)
}

/// The marginal price the coin's own state implies right now, in lamports per base unit scaled by
/// PRICE_SCALE.
///
/// Before graduation that is the curve: its virtual SOL over its token inventory, which is the
/// price the next base unit trades at. After graduation the curve's reserves are zero - they moved
/// into the locked pool - so the marginal reading is the last price the pool traded at, which
/// observe_pool_price mirrors onto the coin. The discovery account list carries no pool, so that
/// mirror is the only marginal reading the discovery path can reach, and it is the same reading the
/// window's anchor is priced from.
pub fn coin_spot_lamports_per_unit_scaled(coin: &Coin) -> Result<u128> {
    let curve = (coin.sol_reserve as u128).checked_add(coin.virtual_sol_reserve as u128);
    if let Some(sol) = curve {
        if sol > 0 && coin.token_reserve > 0 {
            return Ok(sol
                .checked_mul(PRICE_SCALE)
                .ok_or_else(|| error!(DiggoError::MathOverflow))?
                / coin.token_reserve as u128);
        }
    }
    require!(coin.twap_last_price > 0, DiggoError::TwapUnavailable);
    Ok(coin.twap_last_price)
}

/// Token units a lamport value class buys at the coin's own price. Rounded down, so the program
/// never hands out a unit the value did not pay for.
pub fn discovery_units_for_value(coin: &Coin, value_lamports: u64, now_slot: u64) -> Result<u64> {
    if value_lamports == 0 {
        return Ok(0);
    }
    let price = coin_price_lamports_per_unit_scaled(coin, now_slot)?;
    let units = (value_lamports as u128)
        .checked_mul(PRICE_SCALE)
        .ok_or(DiggoError::MathOverflow)?
        / price;
    u64::try_from(units).map_err(|_| error!(DiggoError::MathOverflow))
}

/// What one settled opportunity pays.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DiscoveryPayout {
    pub tier: u8,
    pub value_lamports: u64,
    pub units: u64,
}

/// The whole on-chain rule set for one settled opportunity, derived only from the recorded
/// seed and the coin's own state.
///
/// The lamport caps - per account per day, per account per week and protocol-wide per day -
/// are charged at roll creation against a reservation, which is what makes the scheme safe
/// whatever a wallet knows about the seed before it rolls. What is left to enforce here is the
/// token side: the value class cannot pay more units than the coin's Discovery Reserve, than
/// the per-call bps ceiling, or than the lamport value frozen into the opportunity at creation.
/// The creation epoch was charged when the roll was created, so settlement never debits a
/// refreshed epoch's budget. Each clamp only ever reduces the payout, so the reserve is never
/// asked for more than it holds.
/// Kept out of line for the same reason as the ledger walk: the derivation, the rarity walk
/// and the three clamps together are a large frame.
#[inline(never)]
pub fn plan_discovery_payout(
    protocol: &ProtocolConfig,
    coin: &Coin,
    opportunity: &DiscoveryOpportunity,
    now_slot: u64,
) -> Result<DiscoveryPayout> {
    require!(
        opportunity.is_pending(),
        DiggoError::OpportunityAlreadySettled
    );
    let digest = discovery_digest(&coin.epoch_seed, &opportunity.owner, opportunity.window_index);
    let roll = discovery_roll_bps(&digest);
    let rolled = match rolled_rarity_tier(protocol, roll) {
        Some(tier) => tier,
        None => return Ok(DiscoveryPayout::default()),
    };
    let facts = discovery_facts(coin, protocol);
    let tier = match resolve_rarity_tier(protocol, rolled, &facts) {
        Some(tier) => tier,
        None => return Ok(DiscoveryPayout::default()),
    };
    let value = protocol.rarity_tiers[tier]
        .value_lamports
        .min(opportunity.budget_lamports);
    if value == 0 {
        return Ok(DiscoveryPayout {
            tier: tier as u8,
            value_lamports: 0,
            units: 0,
        });
    }
    let price = coin_price_lamports_per_unit_scaled(coin, now_slot)?;
    let per_call = mul_bps(coin.discovery_reserve_total, protocol.discovery_max_bps)?;
    let units = discovery_units_for_value(coin, value, now_slot)?
        // The unit exposure is frozen at creation. A lower settlement price may reduce the
        // lamport value of the same units, but it must never increase the number of units paid.
        .min(opportunity.reserved_units)
        .min(coin.discovery_remaining)
        .min(per_call);
    let paid_value = (units as u128)
        .checked_mul(price)
        .ok_or(DiggoError::MathOverflow)?
        / PRICE_SCALE;
    let paid_value = u64::try_from(paid_value).map_err(|_| error!(DiggoError::MathOverflow))?;
    Ok(DiscoveryPayout {
        tier: tier as u8,
        value_lamports: paid_value,
        units,
    })
}

// ---- v2: eligibility and the reservation a roll charges (design 3.2, 4.2, 4.3) ----------

/// Eligibility floors, mirroring the rules in shared/discovery.ts so the client can show
/// the same answer the chain enforces.
pub const DISCOVERY_MIN_ACCOUNT_AGE_DAYS: i64 = 7;
pub const DISCOVERY_MIN_ACTIVE_DAYS: u16 = 5;
pub const DISCOVERY_MIN_VALID_ACTIVATIONS: u16 = 5;
/// Total crew levels of tier 2, Small Mining Crew, in shared/config.ts.
pub const DISCOVERY_MIN_TOTAL_CREW_LEVEL: u16 = 15;
pub const DISCOVERY_MIN_MATURITY_BPS: u16 = 5_000;

/// The sum of a player's five crew components.
pub fn crew_total_level(levels: &[u16; CREW_COMPONENTS]) -> u16 {
    let mut total = 0u16;
    for level in levels {
        total = total.saturating_add(*level);
    }
    total
}

/// How far a player's maturity ramp has come, in bps of full power.
///
/// The rungs are the MATURITY_RAMP constant; past the last rung the ramp is complete. Time
/// is the anti-Sybil resource here (design 5), so a wallet that was created a minute ago
/// brings a fifth of its crew's power and cannot roll for a discovery at all.
///
/// WS-A owns the authoritative maturity in math/power.rs, which applies the same ramp to the
/// same field. This is the eligibility reading of it, and the two are pinned to the same
/// constant; see docs/CONTRACT_CHANGE_REQUESTS.md.
pub fn discovery_maturity_bps(player: &PlayerAccount, now: i64) -> u16 {
    let age_days = now.saturating_sub(player.created_at).max(0) / DISCOVERY_DAY_SECONDS;
    let last_rung = MATURITY_RAMP[MATURITY_RAMP.len() - 1].0 as i64;
    if age_days > last_rung {
        return BPS as u16;
    }
    let mut bps = 0u16;
    for (day, value) in MATURITY_RAMP {
        if age_days >= day as i64 {
            bps = value;
        }
    }
    bps
}

/// The whole on-chain eligibility rule for a discovery roll (design 3.2, 4.3): enough active
/// days and valid activations, a crew tier, and enough maturity.
///
/// The bond is gone from this rule. It used to be the load-bearing condition - the flat,
/// refundable cost that made a farm park capital per wallet for a week - and it is retired, so a
/// wallet that never posted one rolls on exactly the same terms as one that did. What is left is
/// the milestone history the program already holds about the wallet's own play: the days it was
/// active, the activations that were valid, the crew it has bought with ORE, and its own age.
pub fn discovery_is_eligible(player: &PlayerAccount, now: i64) -> bool {
    player.active_days >= DISCOVERY_MIN_ACTIVE_DAYS
        && player.valid_activations >= DISCOVERY_MIN_VALID_ACTIVATIONS
        && crew_total_level(&player.crew_levels) >= DISCOVERY_MIN_TOTAL_CREW_LEVEL
        && discovery_maturity_bps(player, now) >= DISCOVERY_MIN_MATURITY_BPS
}

/// The discovery day a timestamp falls in. The u16 wraps after about 179 years, which is
/// the width the frozen PlayerAccount layout carries.
pub fn discovery_day_index(now: i64) -> u16 {
    (now.max(0) / DISCOVERY_DAY_SECONDS) as u16
}

/// The discovery week a timestamp falls in.
pub fn discovery_week_index(now: i64) -> u16 {
    (now.max(0) / DISCOVERY_WEEK_SECONDS) as u16
}

/// The largest value, in lamports, one discovery on this coin could pay right now.
///
/// This is what a roll reserves at creation, while the outcome is still unknown, and it is
/// the conservative number: the top live tier's value class, clamped by every token-side
/// ceiling the coin carries and priced at the coin's own price. Charging the maximum at
/// creation is what makes the scheme safe whatever a wallet knows about the seed before it
/// rolls - a wallet that reads the published seed and walks away from a bad outcome has
/// already spent the budget, so settling is always the better choice.
pub fn discovery_reservation_lamports(
    protocol: &ProtocolConfig,
    coin: &Coin,
    now_slot: u64,
) -> Result<u64> {
    let count = rarity_tier_count(protocol);
    let mut top = 0u64;
    for index in 0..count {
        top = top.max(protocol.rarity_tiers[index].value_lamports);
    }
    if top == 0 {
        return Ok(0);
    }
    let price = coin_price_lamports_per_unit_scaled(coin, now_slot)?;
    let units_ceiling = mul_bps(coin.discovery_reserve_total, protocol.discovery_max_bps)?
        .min(coin.discovery_remaining)
        .min(
            coin.discovery_epoch_budget
                .saturating_sub(coin.discovery_epoch_spent),
        );
    let value_ceiling = (units_ceiling as u128)
        .checked_mul(price)
        .ok_or(DiggoError::MathOverflow)?
        / PRICE_SCALE;
    let value_ceiling = u64::try_from(value_ceiling).map_err(|_| error!(DiggoError::MathOverflow))?;
    Ok(top.min(value_ceiling))
}

/// Reserve an opportunity against the coin's current discovery epoch.
///
/// The epoch budget is denominated in token units, while the frozen opportunity reservation is
/// a lamport value. Convert at the creation price and charge the resulting unit exposure now.
/// Settlement after a rollover therefore cannot spend the new epoch's budget, and expiry keeps
/// the reservation consumed as the protocol's anti-walk-away rule requires.
pub fn reserve_discovery_epoch(
    coin: &mut Coin,
    reservation_lamports: u64,
    now_slot: u64,
) -> Result<u64> {
    let reserved_units = discovery_units_for_value(coin, reservation_lamports, now_slot)?;
    require!(reserved_units > 0, DiggoError::EpochBudgetExhausted);
    let spent = coin
        .discovery_epoch_spent
        .checked_add(reserved_units)
        .ok_or(DiggoError::MathOverflow)?;
    require!(spent <= coin.discovery_epoch_budget, DiggoError::EpochBudgetExhausted);
    coin.discovery_epoch_spent = spent;
    Ok(reserved_units)
}

#[cfg(test)]
mod v2_discovery_limit_tests {
    use super::*;

    /// The slot every price assertion in this module is settled at.
    const TWAP_SLOT: u64 = 1_000_000;

    fn protocol() -> ProtocolConfig {
        let mut tiers = [RarityTier::default(); MAX_RARITY_TIERS];
        tiers[0] = RarityTier {
            cumulative_chance_bps: 7_000,
            value_lamports: 333_333,
            ..Default::default()
        };
        tiers[5] = RarityTier {
            cumulative_chance_bps: 10_000,
            value_lamports: 133_333_333,
            ..Default::default()
        };
        ProtocolConfig {
            rarity_tiers: tiers,
            rarity_tier_count: 6,
            bond_lamports: BOND_LAMPORTS,
            discovery_max_bps: 100,
            discovery_epoch_budget_bps: 500,
            discovery_daily_cap_lamports: 1_000_000_000,
            discovery_weekly_cap_lamports: 4_000_000_000,
            ..Default::default()
        }
    }

    fn coin(token_reserve: u64, sol: u64, virtual_sol: u64) -> Coin {
        Coin {
            token_reserve,
            sol_reserve: sol,
            virtual_sol_reserve: virtual_sol,
            graduation_target: 100_000_000_000,
            discovery_reserve_total: 10_000_000,
            discovery_remaining: 10_000_000,
            discovery_epoch_budget: 1_000_000,
            discovery_epoch_spent: 0,
            ..Default::default()
        }
    }

    fn player(created_at: i64) -> PlayerAccount {
        PlayerAccount {
            created_at,
            active_days: DISCOVERY_MIN_ACTIVE_DAYS,
            valid_activations: DISCOVERY_MIN_VALID_ACTIVATIONS,
            crew_levels: [3u16; CREW_COMPONENTS],
            ..Default::default()
        }
    }

    #[test]
    fn the_maturity_ramp_steps_at_its_rungs_and_completes_past_the_last_one() {
        let created = 1_000_000i64;
        let day = DISCOVERY_DAY_SECONDS;
        let at = |days: i64| discovery_maturity_bps(&player(created), created + days * day);
        assert_eq!(at(0), 0);
        assert_eq!(at(1), 2_000);
        assert_eq!(at(3), 4_000);
        assert_eq!(at(7), 7_000);
        assert_eq!(at(8), BPS as u16);
        assert_eq!(at(365), BPS as u16);
    }

    #[test]
    fn eligibility_is_the_milestone_history_and_no_longer_the_bond() {
        let created = 1_000_000i64;
        let now = created + 30 * DISCOVERY_DAY_SECONDS;
        // The fixture parks no bond at all and is eligible, which is the retirement in one line.
        assert_eq!(player(created).bond_lamports, 0);
        assert!(discovery_is_eligible(&player(created), now));

        let mut fresh = player(created);
        fresh.active_days = DISCOVERY_MIN_ACTIVE_DAYS - 1;
        assert!(!discovery_is_eligible(&fresh, now));

        let mut thin = player(created);
        thin.crew_levels = [2u16; CREW_COMPONENTS];
        assert!(!discovery_is_eligible(&thin, now));

        let mut quiet = player(created);
        quiet.valid_activations = DISCOVERY_MIN_VALID_ACTIVATIONS - 1;
        assert!(!discovery_is_eligible(&quiet, now));

        // A wallet created a minute ago cannot roll, and no deposit buys that back.
        assert!(!discovery_is_eligible(&player(created), created + 60));

        // Parking the old bond changes nothing: eligibility is the same with it and without it.
        let mut bonded = player(created);
        bonded.bond_lamports = BOND_LAMPORTS;
        assert!(discovery_is_eligible(&bonded, now));
    }

    #[test]
    fn the_crew_total_sums_all_five_components() {
        assert_eq!(crew_total_level(&[0, 0, 0, 0, 0]), 0);
        assert_eq!(crew_total_level(&[3, 3, 3, 3, 3]), 15);
        assert_eq!(crew_total_level(&[100, 100, 100, 100, 100]), 500);
    }

    #[test]
    fn the_budget_windows_advance_by_their_own_periods() {
        assert_eq!(discovery_day_index(0), 0);
        assert_eq!(discovery_day_index(DISCOVERY_DAY_SECONDS - 1), 0);
        assert_eq!(discovery_day_index(DISCOVERY_DAY_SECONDS), 1);
        assert_eq!(discovery_week_index(DISCOVERY_WEEK_SECONDS - 1), 0);
        assert_eq!(discovery_week_index(DISCOVERY_WEEK_SECONDS), 1);
        // Seven days is exactly one week, which is the invariant that keeps the two windows
        // consistent with each other.
        assert_eq!(discovery_week_index(7 * DISCOVERY_DAY_SECONDS), 1);
    }

    #[test]
    fn the_reservation_is_the_top_value_class_clamped_by_the_coins_own_ceilings() {
        let protocol = protocol();
        // Thin curve: about 30 lamports per unit, so the per-call ceiling of 1e5 units is
        // worth far less than the top tier's value class.
        let thin = coin(1_000_000_000, 100_000_000, 30_000_000_000);
        assert_eq!(
            discovery_reservation_lamports(&protocol, &thin, TWAP_SLOT).unwrap(),
            3_010_000
        );
        // Deep curve with a wide reserve: the per-call ceiling is worth far more than the top
        // tier, so the value class itself is the binding clamp.
        let mut deep = coin(1_000_000_000_000, 2_000_000_000_000, 5_000_000_000_000);
        deep.discovery_reserve_total = 10_000_000_000;
        deep.discovery_remaining = 10_000_000_000;
        deep.discovery_epoch_budget = 10_000_000_000;
        assert_eq!(
            discovery_reservation_lamports(&protocol, &deep, TWAP_SLOT).unwrap(),
            133_333_333
        );
    }

    #[test]
    fn the_reservation_never_exceeds_what_the_reserve_and_the_epoch_budget_allow() {
        let protocol = protocol();
        let mut drained = coin(1_000_000_000, 100_000_000, 30_000_000_000);
        drained.discovery_remaining = 1;
        // One unit left is still worth something, and the reservation follows it down rather
        // than rounding up to a value class the reserve cannot cover.
        let reservation = discovery_reservation_lamports(&protocol, &drained, TWAP_SLOT).unwrap();
        assert!(reservation > 0 && reservation < 100, "got {reservation}");

        let mut spent = coin(1_000_000_000, 100_000_000, 30_000_000_000);
        spent.discovery_epoch_spent = spent.discovery_epoch_budget;
        assert_eq!(discovery_reservation_lamports(&protocol, &spent, TWAP_SLOT).unwrap(), 0);

        // A coin with no price at all cannot price a discovery, so it cannot reserve one.
        let unpriced = coin(0, 0, 0);
        assert!(discovery_reservation_lamports(&protocol, &unpriced, TWAP_SLOT).is_err());
    }

    #[test]
    fn a_coin_with_no_value_class_reserves_nothing() {
        let mut protocol = protocol();
        for tier in protocol.rarity_tiers.iter_mut() {
            tier.value_lamports = 0;
        }
        let thin = coin(1_000_000_000, 100_000_000, 30_000_000_000);
        assert_eq!(discovery_reservation_lamports(&protocol, &thin, TWAP_SLOT).unwrap(), 0);
    }
}



#[cfg(test)]
mod v2_rarity_tests {
    /// The slot every price assertion in this module is settled at: the window functions take
    /// the slot a payout is settled at, because a window is only meaningful against a clock.
    const TWAP_SLOT: u64 = 1_000_000;

    use super::*;

    fn hex32(text: &str) -> [u8; 32] {
        let mut out = [0u8; 32];
        for index in 0..32 {
            out[index] = u8::from_str_radix(&text[index * 2..index * 2 + 2], 16).unwrap();
        }
        out
    }

    /// The launch table, with the dollar figures of shared/config.ts converted once to
    /// lamports at roughly 150 USD per SOL. The exact numbers are WS-B's to set; the shape
    /// and the ordering are what these tests are about.
    fn tier(
        cumulative: u16,
        value: u64,
        score: u16,
        liquidity: u64,
        volume: u64,
    ) -> RarityTier {
        RarityTier {
            cumulative_chance_bps: cumulative,
            value_lamports: value,
            min_eligibility_score: score,
            min_liquidity_lamports: liquidity,
            min_volume_lamports: volume,
        }
    }

    fn protocol() -> ProtocolConfig {
        let mut tiers = [RarityTier::default(); MAX_RARITY_TIERS];
        tiers[0] = tier(7_000, 333_333, 0, 0, 0);
        tiers[1] = tier(9_000, 1_000_000, 20, 15_000_000_000, 3_000_000_000);
        tiers[2] = tier(9_700, 3_333_333, 40, 60_000_000_000, 15_000_000_000);
        tiers[3] = tier(9_950, 10_000_000, 60, 300_000_000_000, 60_000_000_000);
        tiers[4] = tier(9_995, 33_333_333, 80, 1_500_000_000_000, 300_000_000_000);
        tiers[5] = tier(10_000, 133_333_333, 92, 6_000_000_000_000, 1_200_000_000_000);
        ProtocolConfig {
            rarity_tiers: tiers,
            rarity_tier_count: 6,
            discovery_max_bps: 100,
            discovery_epoch_budget_bps: 500,
            ..Default::default()
        }
    }

    /// A coin whose curve is thin: it can pay a common discovery and nothing better.
    fn thin_coin() -> Coin {
        Coin {
            token_reserve: 1_000_000_000,
            sol_reserve: 100_000_000,
            virtual_sol_reserve: 30_000_000_000,
            graduation_target: 100_000_000_000,
            discovery_reserve_total: 10_000_000,
            discovery_remaining: 10_000_000,
            discovery_epoch_budget: 1_000_000,
            discovery_epoch_spent: 0,
            epoch_seed: [1u8; 32],
            epoch_seed_epoch: 1,
            epoch_seed_recorded_slot: 100,
            total_power: 1_000,
            bonded_power: 1_000,
            ..Default::default()
        }
    }

    /// A coin with deep liquidity, so the rolled tier survives the floors.
    fn rich_coin() -> Coin {
        Coin {
            token_reserve: 1_000_000_000_000,
            sol_reserve: 2_000_000_000_000,
            virtual_sol_reserve: 5_000_000_000_000,
            graduation_target: 1_000_000_000_000,
            discovery_reserve_total: 1_000_000_000,
            discovery_remaining: 1_000_000_000,
            discovery_epoch_budget: 100_000_000,
            epoch_seed: [1u8; 32],
            epoch_seed_epoch: 1,
            epoch_seed_recorded_slot: 100,
            total_power: 1_000,
            bonded_power: 1_000,
            ..Default::default()
        }
    }

    fn opportunity(window_index: u16) -> DiscoveryOpportunity {
        DiscoveryOpportunity {
            owner: Pubkey::new_from_array([2u8; 32]),
            window_index,
            epoch_index: 1,
            budget_lamports: 133_333_333,
            reserved_units: 133_333_333,
            created_slot: 50,
            expires_at: 1_000_000,
            status: OPPORTUNITY_PENDING,
            ..Default::default()
        }
    }

    #[test]
    fn the_digest_is_sha256_of_the_seed_the_wallet_and_the_window() {
        let seed = [1u8; 32];
        let owner = Pubkey::new_from_array([2u8; 32]);
        // Golden vectors, byte for byte, so the TypeScript mirror in shared/epochSeed.ts
        // can assert the same values. The chain is authoritative.
        assert_eq!(
            discovery_digest(&seed, &owner, 0),
            hex32("c20a6fd2329070420058915cba61711a8fc14592e481cf85d6ef73097da840c4")
        );
        assert_eq!(
            discovery_digest(&seed, &owner, 258),
            hex32("f7ce5e6d1afcc20f6b21eeb0f398dde53f7002241adcafb70eccaf97500c2dd3")
        );
        // The wallet and the window are both bound into the digest, which is what makes one
        // seed per (coin, epoch) enough for every roll of that epoch.
        let other_owner = Pubkey::new_from_array([3u8; 32]);
        assert_ne!(discovery_digest(&seed, &owner, 0), discovery_digest(&seed, &other_owner, 0));
        assert_ne!(discovery_digest(&seed, &owner, 0), discovery_digest(&seed, &owner, 1));
        let other_seed = [9u8; 32];
        assert_ne!(discovery_digest(&seed, &owner, 0), discovery_digest(&other_seed, &owner, 0));
    }

    #[test]
    fn the_roll_is_the_first_two_bytes_reduced_into_bps() {
        let digest = hex32("c20a6fd2329070420058915cba61711a8fc14592e481cf85d6ef73097da840c4");
        assert_eq!(discovery_roll_bps(&digest), 2_754);
        let digest = hex32("f7ce5e6d1afcc20f6b21eeb0f398dde53f7002241adcafb70eccaf97500c2dd3");
        assert_eq!(discovery_roll_bps(&digest), 2_983);
        // Every roll is a live bps value, whatever the bytes are.
        for byte in 0..=255u8 {
            let mut digest = [0u8; 32];
            digest[0] = byte;
            digest[1] = byte;
            assert!(discovery_roll_bps(&digest) < BPS as u16);
        }
    }

    #[test]
    fn tier_selection_walks_the_cumulative_chances() {
        let protocol = protocol();
        assert_eq!(rolled_rarity_tier(&protocol, 0), Some(0));
        assert_eq!(rolled_rarity_tier(&protocol, 6_999), Some(0));
        assert_eq!(rolled_rarity_tier(&protocol, 7_000), Some(1));
        assert_eq!(rolled_rarity_tier(&protocol, 8_999), Some(1));
        assert_eq!(rolled_rarity_tier(&protocol, 9_999), Some(5));
    }

    #[test]
    fn a_table_that_ends_short_of_bps_has_no_outcome_above_it() {
        let mut protocol = protocol();
        protocol.rarity_tiers[0].cumulative_chance_bps = 5_000;
        protocol.rarity_tier_count = 1;
        assert_eq!(rolled_rarity_tier(&protocol, 4_999), Some(0));
        assert_eq!(rolled_rarity_tier(&protocol, 5_000), None);
        // An empty table has no outcome at all.
        protocol.rarity_tier_count = 0;
        assert_eq!(rolled_rarity_tier(&protocol, 0), None);
    }

    #[test]
    fn an_illiquid_coin_is_downgraded_rather_than_refused() {
        let protocol = protocol();
        let facts = discovery_facts(&thin_coin(), &protocol);
        // A thin coin scores low and holds little liquidity, so the mythic band it rolled
        // resolves down to the common tier rather than paying a mythic discovery.
        assert!(facts.eligibility_score < 60, "score {}", facts.eligibility_score);
        assert_eq!(resolve_rarity_tier(&protocol, 5, &facts), Some(0));
        assert_eq!(resolve_rarity_tier(&protocol, 0, &facts), Some(0));
    }

    #[test]
    fn a_deep_coin_resolves_the_tier_it_rolled() {
        let protocol = protocol();
        let facts = discovery_facts(&rich_coin(), &protocol);
        assert_eq!(facts.eligibility_score, 100);
        assert_eq!(resolve_rarity_tier(&protocol, 5, &facts), Some(5));
        assert_eq!(resolve_rarity_tier(&protocol, 4, &facts), Some(4));
    }

    #[test]
    fn a_coin_that_clears_no_tier_pays_nothing() {
        let mut protocol = protocol();
        // Even the common tier gets a floor it cannot clear.
        protocol.rarity_tiers[0].min_liquidity_lamports = u64::MAX;
        let facts = discovery_facts(&thin_coin(), &protocol);
        assert_eq!(resolve_rarity_tier(&protocol, 5, &facts), None);
        let payout =
            plan_discovery_payout(&protocol, &thin_coin(), &opportunity(7), TWAP_SLOT).unwrap();
        assert_eq!(payout, DiscoveryPayout::default());
    }

    #[test]
    #[test]
    fn the_price_takes_the_higher_of_the_window_and_the_spot() {
        let mut coin = thin_coin();
        // Only the curve is priced at first: 30.1 SOL over 1e9 units is 30.1 lamports per unit.
        let spot = coin_spot_lamports_per_unit_scaled(&coin).unwrap();
        assert_eq!(spot, 30_100_000_000 * PRICE_SCALE / 1_000_000_000);
        assert_eq!(coin_price_lamports_per_unit_scaled(&coin, TWAP_SLOT).unwrap(), spot);

        // A pool window above a crashed spot is what the payout uses, which is what stops a wallet
        // from selling into its own curve to buy more units with the same value class.
        coin.twap_last_update_slot = TWAP_SLOT - 900;
        coin.twap_last_price = 1_000 * PRICE_SCALE;
        coin.twap_window_slot = TWAP_SLOT - 900;
        coin.twap_window_cum = 0;
        coin.twap_cum_price_lamports_per_unit = 0;
        coin.sol_reserve = 1;
        coin.virtual_sol_reserve = 1;
        let window = coin.twap_price(TWAP_SLOT).unwrap();
        assert_eq!(window, 1_000 * PRICE_SCALE);
        assert_eq!(
            coin_price_lamports_per_unit_scaled(&coin, TWAP_SLOT).unwrap(),
            window
        );

        // With no price at all, the payout path refuses rather than pricing at zero.
        coin.token_reserve = 0;
        coin.sol_reserve = 0;
        coin.virtual_sol_reserve = 0;
        coin.twap_last_price = 0;
        coin.twap_cum_price_lamports_per_unit = 0;
        coin.twap_last_update_slot = 0;
        assert!(coin_price_lamports_per_unit_scaled(&coin, TWAP_SLOT).is_err());
    }

    #[test]
    fn a_sandwiched_spot_is_dropped_in_favour_of_the_window() {
        let mut coin = thin_coin();
        coin.twap_last_update_slot = TWAP_SLOT - 900;
        coin.twap_last_price = 1_000 * PRICE_SCALE;
        coin.twap_window_slot = TWAP_SLOT - 900;
        coin.twap_window_cum = 0;
        coin.twap_cum_price_lamports_per_unit = 0;
        let window = coin.twap_price(TWAP_SLOT).unwrap();
        assert_eq!(window, 1_000 * PRICE_SCALE);

        // A 100x pump on the curve's own spot: past the deviation bound the spot is dropped and the
        // window prices the payout, so a sandwich cannot move what a discovery is worth.
        coin.sol_reserve = 100_000_000_000;
        coin.virtual_sol_reserve = 0;
        coin.token_reserve = 1_000_000;
        assert_eq!(
            coin_spot_lamports_per_unit_scaled(&coin).unwrap(),
            100_000 * PRICE_SCALE
        );
        assert_eq!(
            coin_price_lamports_per_unit_scaled(&coin, TWAP_SLOT).unwrap(),
            window,
            "a pumped spot must not price a payout"
        );

        // A dump is dropped for the same reason. It is also the direction that would drain the
        // reserve, because a lower price buys more units for the same value class.
        coin.sol_reserve = 1;
        coin.virtual_sol_reserve = 0;
        coin.token_reserve = 1_000_000_000;
        assert_eq!(
            coin_price_lamports_per_unit_scaled(&coin, TWAP_SLOT).unwrap(),
            window,
            "a dumped spot must not price a payout"
        );
    }

    #[test]
    fn units_round_down_and_never_exceed_the_value_class() {
        let coin = thin_coin();
        let units = discovery_units_for_value(&coin, 333_333, TWAP_SLOT).unwrap();
        assert_eq!(units, 11_074);
        // Rounding is the protocol's: the units paid back are worth no more than the value.
        let price = coin_price_lamports_per_unit_scaled(&coin, TWAP_SLOT).unwrap();
        assert!((units as u128) * price <= 333_333u128 * PRICE_SCALE);
        assert_eq!(discovery_units_for_value(&coin, 0, TWAP_SLOT).unwrap(), 0);
    }

    #[test]
    fn a_payout_is_clamped_to_the_reserve_and_the_per_call_cap() {
        let protocol = protocol();
        let coin = rich_coin();
        let payout = plan_discovery_payout(&protocol, &coin, &opportunity(7), TWAP_SLOT).unwrap();
        // per_call is 100 bps of a 1e9 reserve.
        assert!(payout.units <= coin.discovery_remaining);
        assert!(payout.units <= mul_bps(coin.discovery_reserve_total, 100).unwrap());
        assert!(payout.units > 0);
        assert!(payout.value_lamports > 0);

        let mut drained = rich_coin();
        drained.discovery_remaining = 1;
        let payout = plan_discovery_payout(&protocol, &drained, &opportunity(7), TWAP_SLOT).unwrap();
        assert_eq!(payout.units, 1);

    }

    #[test]
    fn a_roll_reserves_its_creation_epoch_in_units() {
        let mut coin = rich_coin();
        coin.discovery_epoch_budget = 1_000_000;
        let before = coin.discovery_epoch_spent;
        let reserved = reserve_discovery_epoch(&mut coin, 1_000_000, TWAP_SLOT).unwrap();
        assert!(reserved > 0);
        assert_eq!(coin.discovery_epoch_spent, before + reserved);
        assert!(coin.discovery_epoch_spent <= coin.discovery_epoch_budget);
    }

    #[test]
    fn a_roll_reserving_more_than_the_creation_epoch_remains_is_refused() {
        let mut coin = rich_coin();
        coin.discovery_epoch_spent = coin.discovery_epoch_budget;
        assert!(matches!(
            reserve_discovery_epoch(&mut coin, 1, TWAP_SLOT),
            Err(error) if error.to_string().contains("EpochBudgetExhausted")
        ));
    }

    #[test]
    fn a_price_drop_from_one_to_one_tenth_after_rollover_cannot_inflate_units() {
        let protocol = protocol();
        let mut coin = rich_coin();
        let mut roll = opportunity(7);
        roll.budget_lamports = 1_000_000;

        // Creation sees a price of one lamport per unit and reserves 1,000,000 units.
        coin.token_reserve = 1_000_000_000;
        coin.sol_reserve = 1_000_000_000;
        coin.virtual_sol_reserve = 0;
        coin.twap_last_price = PRICE_SCALE;
        coin.twap_cum_price_lamports_per_unit = PRICE_SCALE;
        coin.twap_last_update_slot = TWAP_SLOT - 1;
        coin.twap_window_slot = TWAP_SLOT - 1;
        coin.twap_window_cum = PRICE_SCALE;
        let reserved_units = reserve_discovery_epoch(&mut coin, roll.budget_lamports, TWAP_SLOT)
            .unwrap();
        assert_eq!(reserved_units, 1_000_000);
        roll.reserved_units = reserved_units;
        let old_epoch_spent = coin.discovery_epoch_spent;

        // The coin rolls before settlement. This is the normal epoch rollover path, not a
        // hand-edited counter: the old reservation stays in the opportunity while the new
        // epoch starts with a fresh budget.
        coin.epoch_length = 604_800;
        coin.epoch_ends_at = 0;
        coin.epoch_ends_slot = 0;
        coin.roll_epoch(1, TWAP_SLOT, 32).unwrap();
        assert_eq!(coin.discovery_epoch_index, coin.epoch_index);
        assert_eq!(coin.discovery_epoch_spent, 0);

        // The price falls by 90%. Re-pricing the same lamport class would now buy 10,000,000
        // units, but the opportunity is only allowed to pay its frozen 1,000,000-unit exposure.
        coin.token_reserve = coin.token_reserve.saturating_mul(10);
        coin.sol_reserve = 1_000_000_000;
        coin.virtual_sol_reserve = 0;
        coin.twap_last_price = PRICE_SCALE / 10;
        coin.twap_cum_price_lamports_per_unit = PRICE_SCALE / 10;
        coin.twap_last_update_slot = TWAP_SLOT - 1;
        coin.twap_window_slot = TWAP_SLOT - 1;
        coin.twap_window_cum = PRICE_SCALE / 10;

        assert!(
            discovery_units_for_value(&coin, roll.budget_lamports, TWAP_SLOT).unwrap()
                > roll.reserved_units,
            "the regression must exercise a price fall that would inflate units without the cap"
        );
        let payout = plan_discovery_payout(&protocol, &coin, &roll, TWAP_SLOT).unwrap();
        assert_eq!(payout.units, roll.reserved_units);
        assert!(payout.units < 10_000_000);
        assert!(payout.value_lamports <= roll.budget_lamports);
        assert_eq!(coin.discovery_epoch_spent, 0);
        assert!(payout.value_lamports <= roll.budget_lamports);
        assert_ne!(old_epoch_spent, 0);
    }

    #[test]
    fn a_settled_opportunity_cannot_be_planned_again() {
        let protocol = protocol();
        let mut roll = opportunity(7);
        roll.status = OPPORTUNITY_SETTLED;
        assert!(plan_discovery_payout(&protocol, &thin_coin(), &roll, TWAP_SLOT).is_err());
    }

    #[test]
    fn a_zero_value_tier_pays_nothing_but_still_settles() {
        let mut protocol = protocol();
        protocol.rarity_tiers[0].value_lamports = 0;
        let mut coin = thin_coin();
        // A window whose roll lands in the common band.
        let mut window = 0u16;
        while rolled_rarity_tier(
            &protocol,
            discovery_roll_bps(&discovery_digest(
                &coin.epoch_seed,
                &opportunity(window).owner,
                window,
            )),
        ) != Some(0)
        {
            window += 1;
        }
        coin.epoch_seed = [1u8; 32];
        let payout = plan_discovery_payout(&protocol, &coin, &opportunity(window), TWAP_SLOT).unwrap();
        assert_eq!(payout.units, 0);
        assert_eq!(payout.tier, 0);
    }

    #[test]
    fn the_score_is_bounded_and_monotone_in_the_coins_own_liquidity() {
        let protocol = protocol();
        let mut previous = 0u16;
        for scale in [1u64, 10, 1_000, 100_000, 10_000_000] {
            let mut coin = thin_coin();
            coin.sol_reserve = coin.sol_reserve.saturating_mul(scale);
            coin.virtual_sol_reserve = coin.virtual_sol_reserve.saturating_mul(scale);
            let facts = discovery_facts(&coin, &protocol);
            assert!(facts.eligibility_score <= 100);
            assert!(facts.eligibility_score >= previous);
            previous = facts.eligibility_score;
        }
    }
}
