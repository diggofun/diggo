# Economy simulation (90 days, real shared/ logic)

`scripts/sim/` runs a 90-day, multi-mine economy simulation on top of the **real** game rules: every
Mining Power, ORE, streak, reward-index, emission, discovery-budget, rarity and risk decision comes
from `shared/`. The harness owns only the world - who shows up, when they come back, how they spend
ORE, which mine they pick and how a farm is shaped.

    npm run sim                        # the whole scenario matrix, shadow + enforce enforcement
    npm run sim -- --scenario baseline --days 90
    npm run sim -- --quick             # small population, for iterating
    npm run sim -- --list              # scenario keys
    npm run sim -- --selfcheck-only    # the harness self-checks, no matrix
    npm run sim -- --curve-phase       # the curve-phase scenario on its own, in seconds
    npm run sim -- --inspect --bots 0 --humans 400 --days 90   # one run, full summary JSON

Outputs land in `scripts/sim/out/` (gitignored): per-scenario `*.mines.csv`, `*.daily.csv`,
`*.discovery.csv`, `*.cohorts.csv`, `*.power.csv`, `*.risk.csv`, plus `summary.md` and
`summary.json`. Every run is deterministic for a given seed (default 20,260,922) and independent of
population processing order.

## BEFORE and AFTER come from the same code

Every large farm is simulated twice: once with the hardened economy and once with a `-legacy` row
that switches exactly the hardened knobs back to their previous values (`LEGACY_CONFIG_PATCH` in
`scripts/sim/model.ts`: the geometric 25%/epoch reduction schedule, maturity and cluster scaling
switched off, the reward hold switched off, and the old storage and upgrade numbers). Both columns are
therefore **measured on this revision, on the same seed, with the same population** - the only
difference between them is the change under review.

## What is real, and what is assumed

| Concern | Source |
| --- | --- |
| Mining Power, effective power, upgrade costs, crew tiers | `shared/crew.ts` |
| ORE sources, capacity, storage overflow | `shared/ore.ts` |
| Activation windows, streaks, freezes, milestones | `shared/streak.ts` |
| Cumulative reward index, emission schedule, FULLY_MINED, reserve audit | `shared/rewardIndex.ts` |
| Discovery eligibility, per-account/per-token/global caps | `shared/discovery.ts` |
| Robust price, eligibility score, rarity, value normalization | `shared/rarity.ts` |
| Risk score, responses, Mine Trust, reward holds, shadow/enforce decision | `shared/risk.ts`, `shared/riskOps.ts` |
| Every tunable | `shared/config.ts` (`createDiggoConfig`) |

Assumed by the harness, and therefore the only soft numbers in the results:

- **Population**: 5,000 human wallets over a 30-day arrival window, in four habit classes (hardcore
  12%, regular 31%, casual 34%, tourist 23%) with per-class churn up to 6%/day; 1-3 visits on an
  active day. Bots are scripted: *naive* wallets all created at launch and re-activating every 20h
  (the configured minimum re-activation), *stealthy* wallets staggered over 30 days in batches of
  eight with their own daily anchor, ±2h drift, ±2min jitter and 5% dormancy.
- **Mines**: four launches with 1B supply, 5% Mining Reserve and 0.5% Discovery Reserve each. Each
  launch carries its own reward per block **and its own target lifetime** - a launch parameter, like
  the reserve split: a flagship at 7,500/block reserved for 365 days, a mid-cap at 9,200 for 270
  days, a long tail at 3,000 for 90 days and a fresh launch on day 14 at 5,000 for 30 days.
- **Risk signals**: the raw counts `worker/risk.ts` reads from D1 are derived here from the scripted
  behaviour - activation-timing regularity as `2 × (1 − stdev(days between activations) / 6h)`,
  synchrony, wallets per device/network, creation cluster, burst actions and claim bursts per farm
  style. The mapping is in `scripts/sim/market.ts`; production measures the same quantities from
  `account_signals`. Humans are one wallet per device and per network environment, so the harness
  cannot measure the false-positive cost of the cluster damping on a shared device (see Limitations).
- **Not modelled**: rate limits, circuit breakers, admin restrictions, and the fact that a wallet
  signature challenge is free for a script (the harness assumes it is always passed). Prices are
  constant per token, so discovery USD caps are evaluated at launch prices.
- **Curve-phase scenario** (`scripts/sim/curve.ts`): trade arrivals are a seeded draw per
  block (25% chance of a buy, 15% of a sell, uniform sizes), and one farm shape - every wallet on
  one device and one network. Discovery, ORE and rank are not part of it: it prices the curve, the
  cap and the sell capacity.

## Headline results

Tabulated outputs below are copied from `scripts/sim/out/summary.md` for seed 20,260,922 (5,000
humans, 90 days, 4 mines, 200,000,000 tokens of Mining Reserve in total). Only the columns that carry
the argument are reproduced; the full tables and every CSV are in `scripts/sim/out/`.

### 1. Emission: the whole Mining Reserve is now always distributable

The old schedule reduced the block reward by 25% every epoch, which caps lifetime distribution at
`epochSeconds / blockInterval / 0.25` = 8,064 blocks' worth of the reward. A 50M reserve was
therefore unreachable below 6,201/block, and the flagship at 7,500/block exhausted its reserve on day
44 - a launch parameter, not a function of how many players showed up.

The default schedule is now `reserve_runway`: each epoch pays the remaining reserve over the blocks
left of that mine's configured target lifetime (rounded up), never above the epoch before it, with a
floor that keeps paying until the reserve is empty. Unspent tokens still stay in the reserve, and
`applyBlock` still caps every block at what is left.

| Launch parameters | Reserve | Target lifetime | BEFORE (25%/epoch) | AFTER (reserve runway) |
| --- | --- | --- | --- | --- |
| flagship 1,200/block | 50,000,000 | 365 days | 27.8% distributable, then locked forever | 100.0% distributed, FULLY_MINED day 371 |
| flagship 1,900/block | 50,000,000 | 365 days | 39.1% locked forever | 100.0%, day 371 |
| flagship 3,000/block | 50,000,000 | 365 days | 56.8% locked forever | 100.0%, day 371 |
| flagship 7,500/block | 50,000,000 | 365 days | 100.0% by day 43 | 100.0%, day 371 |
| long tail 300/block | 3,000,000 | 90 days | 100.0% by day 768 (8x late) | 100.0%, day 91 |
| large lift-off 40,000/block | 200,000,000 | 730 days | 100.0% by day 24 (30x early) | 100.0%, day 735 |

In-sim, the flagship is still mining on day 90 with 22,940,675 of its 50M reserve left (45.9%
distributed) instead of being fully mined on day 44, and the fresh 30-day launch reaches
`FULLY_MINED` on **day 48**, which is the spec-20 terminal state exercised end to end. The target
lifetime is a launch parameter with a 12-month default (`economy.emission.targetLifetimeDays`), and
the harness prices it: a 30-day target drains the flagship in 35 days, 90 days in 91, 180 in 182, 730
in 735 - the schedule counts in whole epochs, so the honest bound is the target rounded up to one.

### 2. Anti-sybil: a farm now captures a fraction of what it used to

Three layers were added, all configurable, all applied where a block share is created (spec 40, 53,
58, 61, 64):

1. **Account maturity scales effective Mining Power**, not only ORE: day 1 20%, day 3 40%, day 7 70%,
   day 7+ 100% (`effectivePower.maturityRamp`). Time is the anti-sybil resource (spec 58).
2. **Reward holds are enforced in every mode.** Mining accounting keeps running for an
   `UNDER_REVIEW`, `HELD` or `BLOCKED` account - it accrues, keeps its streak and keeps its
   progression - but its *real-token claims* (mining and discovery) are parked as `HELD` instead of
   released, and clear with the state (spec 53). Friction, challenges, discovery *rolls* and bans stay
   governed by `enforcement.mode` exactly as before (spec 63).
3. **Cluster damping and a cluster share ceiling**: a wallet on its own device and network keeps full
   weight; each further wallet on one device keeps 70% of the previous factor (allowance 4), the
   network factor never falls below 50% so a dorm, office or carrier NAT is slowed rather than
   crippled, and a *cluster* past its allowance may hold at most 2% of a block measured against the
   power the mine carries outside that cluster, never below `shareCapFloorPower` (spec 64). See
   "Splitting and the cluster ceiling" below.

| Scenario | Bot share of minted (BEFORE) | Bot share of minted (AFTER) | Bot share **released** (AFTER) | Held for the farm (AFTER) |
| --- | --- | --- | --- | --- |
| 10,000 naive wallets, shadow | 41.6% | 5.7% | 0.0% | 8,560,000 |
| 10,000 staggered wallets, shadow | 63.4% | 10.8% | 0.0% | 16,178,919 |
| 10,000 staggered wallets, enforced | 63.4% | 10.8% | 0.0% | 16,178,919 |
| 10,000 staggered wallets, risk gate off | 63.4% | 10.8% | 10.8% | 0 |

"Released" is what the farm actually walked away with: every claim is parked, so a 10,000-wallet
staggered farm captures **0.0%** of minted tokens in shadow mode, in enforce mode, and with the
discovery caps raised. "Minted" is what its positions accrued. The gate-off row is the
detection-independent bound: even with no score at all, the maturity ramp, cluster damping and share
cap cut a 10,000-wallet farm from 63.4% to 10.8% of accrual.

Honest players pay nothing for this: in the 10,000-wallet scenario all **1,470 retained humans stay
NORMAL** (0 held, 0 under review, 0 blocked), their median ORE is identical to the no-bot baseline
(33,373) and their median power is identical (568). Their mining rewards drop from 102,426 to 91,247
tokens per retained human (-10.9%) because a farm that still takes 10.8% of accrual is still in the
index; before the hardening the same comparison was 40,253 (-60.7%).

### 3. ORE and crew progression: the storage loop no longer eats the game

The previous storage numbers pinned the median player exactly at capacity (p10 = p50 = 1,125 ORE)
and threw 18,614 ORE per player away, so Mining Power barely moved: 1.64x the starter crew after 90
days against the 22.59x the curves allow.

Storage capacity, offline hours and the upgrade cost curve were rebalanced
(`ore.storageBaseCapacity`, `ore.storageCapacityScale`, `ore.offlineHours*`,
`crew.upgradeCostBase`, `crew.upgradeCostExponent`, `ore.baseOrePerActiveHour`).

| Metric | BEFORE | AFTER |
| --- | --- | --- |
| Median ORE held at day 90 | 1,125 (= capacity) | 1,202 (capacity is no longer the binding constraint) |
| Median ORE earned in 90 days | 22,973 | 33,373 |
| Mean ORE destroyed by overflow per player | 18,614 | 522 |
| Median Mining Power, day 30 | 247 | 359 (2.35x the starter crew) |
| Median Mining Power, day 90 | 251 | 568 (**3.71x**) |
| Retained day-1 veteran, day 90 | 251 (1.64x) | 594 (**3.88x**) |
| Veteran vs a day-7 joiner | 1.31x | 3.78x vs day 1, 1.05x vs day 7 |
| Theoretical maximum from the crew curves | 22.59x | 22.59x (unchanged, still within the 25x bound) |

Progression is now a curve a player can feel (2.35x by day 30, 3.71x by day 90, with the two power
branches as the main spend) while the crew curve keeps the veteran ceiling at 22.59x, inside the
existing `maxVeteranPowerRatio` test. Bots gain exactly the same progression, which is why they also
clear the discovery tier-2 gate - see the discovery caveat below.

### 4. Accounting: reserve conservation is exact

`shared/rewardIndex.ts` `auditReserve` now carries forfeits and releases as first-class terms and
checks two exact identities:

    released - forfeited               == initialReserve - remaining
    released == claimed + forfeited + outstanding + openRemainder + dust

`unattributed` reports whatever the two sides disagree by, in scaled units, instead of hiding a real
leak inside a rounding-sized tolerance. Forfeits and unassigned rewards return to
`reserveRemaining` (never burned, never lost), and the harness books every parked reward against the
mine whose index released it - filtering on the mine a player currently points at was what left the
old residual behind (up to 25,633 tokens per mine, ~0.05%).

| Check | BEFORE | AFTER |
| --- | --- | --- |
| Mining Reserve conservation (4 mines) | FAIL, -7,318 to +8,516 out of 50,000,000 (<=0.02%) | **PASS**, `unattributed == 0` on all four mines |

The reproducer from the previous report (`npm run sim -- --inspect --humans 0 --bots 400 --stealth
stealthy --days 90`) is the same case: each mine now balances exactly, with `released - forfeited ==
initial - remaining` and every settled token attributed to a cohort.

### 5. Discovery: caps hold, the farm's committed share is up, its released share is zero

Discovery is the one place where fixing progression had a cost: the farm's wallets now reach crew tier
2, so they roll and their discoveries are *committed* against the Discovery Reserve (65.1% of payouts
in the 10,000-wallet scenario). The reward hold means they receive **0.0%** of it: 1,189,891 tokens
sit in held claims, recoverable only if the account is cleared.

| Scenario | Paid out (90d) | Bot share committed | Bot share released | Held tokens | Avg Discovery Reserve used | Cap refusals |
| --- | --- | --- | --- | --- | --- | --- |
| baseline (humans only) | $2,160.40 | 0.0% | 0.0% | 0 | 3.3% | no_budget_left: 10,967 |
| 10,000 staggered wallets | $3,249.95 | 65.1% | 0.0% | 1,189,891 | 9.1% | no_budget_left: 145,780 |
| ... discovery caps x5 | $11,212.45 | 73.6% | 0.0% | 2,580,979 | 17.5% | none |
| ... discovery caps off | $29,971.90 | 81.2% | 0.0% | 4,196,812 | 25.8% | none |

Every cap still holds end to end (no cap is ever exceeded, in any scenario), and the caps remain the
binding constraint: removing them raises payouts by 14x, which is exactly the damage a farm could do
if the eligibility gates were the only defence. With the reward hold in place it cannot receive any of
it. The tier-2 counterfactual (below) is the alternative lever if discovery should not be *committed*
to a farm at all.


### 6. Splitting cannot dilute the share ceiling

A block-share cap is only worth anything if it cannot be diluted by splitting, so the cap is applied
per **cluster** and measured against the power the mine carries *outside* that cluster
(`shared/crew.ts` `effectiveMiningPower`). A per-account ceiling taken from the mine's running total
is self-defeating: every wallet a farm adds both raises the total the ceiling is a fraction of and
collects a ceiling of its own, so N wallets on one device were each allowed roughly one account's
whole share. The cluster's allowance is now `perAccountBlockShareCapBps` of the outside power, never
below `shareCapFloorPower`, divided over the wallets past the configured allowance.

- A household, dorm or office **inside** the device (4) or network (50) allowance is not a farm, so
  it keeps the whole ceiling and the ceiling is inert for it.
- A cluster past an allowance is bounded to roughly what a *single* out-of-scale account would be
  allowed, however many wallets it is split into.
- A single account is never cut at all: `shareCapFloorPower` sits above the strongest reachable crew
  (a maxed veteran brings 2,259 power), and `shared/crew.test.ts` pins that relationship, so moving
  the crew curve cannot silently turn the floor into a per-crew ceiling.

The modelled population shows exactly that. The two **naive** bot scenarios, whose wallets all
present the same device and network fingerprint, now lose accrual to the ceiling: the 10,000-wallet
naive farm drops from 8.8% to 5.7% of mined tokens and from 13,250,000 to 8,560,000 tokens held,
and the 1,000-wallet one from 2.5% to 2.2%. Every honest number in this report is unchanged. The
`stealthy` farm, which presents distinct fingerprints, is not touched by the ceiling at all: it is
damped by maturity and clustering instead.

A farm split across wallets that share **neither** a device nor a network is bounded by account
maturity and cluster damping rather than by this ceiling, and that is by design. Such a split has to
age every wallet through the ramp (day 1 20%, day 3 40%, day 7 70%, day 7+ 100%) and pays the risk
pipeline's creation and synchrony signals on the way. That is the lever the `bots-10000-stealthy`
row prices: 63.4% of accrual before the hardening, 10.8% after, and 0.0% released while holds are in
force.

## Scenario matrix

Copied verbatim from `scripts/sim/out/summary.md`.

| Scenario | Humans | Bots | Style | Flagship FULLY_MINED | Tokens distributed (90d) | Bot share of mined | Bot share released | Held tokens | Discovery spent | Stranded tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 5,000 | 0 | - | not mined out | 150,563,439 | 0.0% | 0.0% | 0 | $2,160.40 | 0 |
| baseline-legacy | 5,000 | 0 | - | day 44 | 161,979,353 | 0.0% | 0.0% | 0 | $1,621.20 | 0 |
| bots-100-naive | 5,000 | 100 | naive | not mined out | 150,703,372 | 0.6% | 0.0% | 934,500 | $2,269.05 | 0 |
| bots-1000-naive | 5,000 | 1,000 | naive | not mined out | 150,703,344 | 2.2% | 0.0% | 3,278,000 | $2,718.45 | 0 |
| bots-10000-naive | 5,000 | 10,000 | naive | not mined out | 150,703,333 | 5.7% | 0.0% | 8,560,000 | $3,884.85 | 0 |
| bots-10000-naive-legacy | 5,000 | 10,000 | naive | day 44 | 161,979,379 | 41.6% | 41.6% | 0 | $1,621.20 | 0 |
| bots-1000-stealthy | 5,000 | 1,000 | stealthy | not mined out | 150,603,940 | 2.4% | 0.0% | 3,642,309 | $2,451.20 | 0 |
| bots-10000-stealthy | 5,000 | 10,000 | stealthy | not mined out | 150,644,412 | 10.8% | 0.0% | 16,178,919 | $3,249.95 | 0 |
| bots-10000-stealthy-legacy | 5,000 | 10,000 | stealthy | day 44 | 162,074,343 | 63.4% | 63.4% | 0 | $1,621.20 | 0 |
| bots-10000-stealthy-nogate | 5,000 | 10,000 | stealthy | not mined out | 150,644,412 | 10.8% | 10.8% | 0 | $3,249.95 | 0 |
| bots-10000-stealthy-nogate-legacy | 5,000 | 10,000 | stealthy | day 44 | 162,074,343 | 63.4% | 63.4% | 0 | $1,621.20 | 0 |
| bots-10000-stealthy-caps-off | 5,000 | 10,000 | stealthy | not mined out | 150,644,412 | 10.8% | 0.0% | 16,178,919 | $29,971.90 | 0 |
| bots-10000-stealthy-caps-5x | 5,000 | 10,000 | stealthy | not mined out | 150,644,412 | 10.8% | 0.0% | 16,178,919 | $11,212.45 | 0 |
| bots-10000-stealthy-tier2 | 5,000 | 10,000 | stealthy | not mined out | 127,752,334 | 9.6% | 0.0% | 12,228,983 | $3,249.95 | 0 |
| sweep-lifetime-30 | 5,000 | 0 | - | day 35 | 177,638,603 | 0.0% | 0.0% | 0 | $1,581.40 | 0 |
| sweep-lifetime-90 | 5,000 | 0 | - | not mined out | 177,207,727 | 0.0% | 0.0% | 0 | $2,160.40 | 0 |
| sweep-lifetime-180 | 5,000 | 0 | - | not mined out | 159,193,146 | 0.0% | 0.0% | 0 | $2,160.40 | 0 |
| sweep-lifetime-730 | 5,000 | 0 | - | not mined out | 146,571,304 | 0.0% | 0.0% | 0 | $2,160.40 | 0 |
| sweep-launch-400 | 5,000 | 0 | - | not mined out | 137,981,122 | 0.0% | 0.0% | 0 | $2,160.40 | 0 |
| bots-10000-stealthy **#enforce** | 5,000 | 10,000 | stealthy | not mined out | 150,644,412 | **10.8%** | **0.0%** | 16,178,919 | $2,160.40 | 0 |
| bots-10000-naive **#enforce** | 5,000 | 10,000 | naive | not mined out | 150,703,330 | **2.7%** | **0.0%** | 4,040,000 | $2,160.40 | 0 |
| bots-10000-stealthy-legacy **#enforce** | 5,000 | 10,000 | stealthy | day 44 | 162,074,343 | **63.4%** | **63.4%** | 0 | $1,621.20 | 0 |

(The `#enforce` rows run with `createRiskOpsConfig({ enforcement: { mode: "enforce" } })`; every other
row is the launch default, shadow mode. `strandedTokens` is zero everywhere: no settled reward is left
unsettled at the end of the horizon.)

## Mining Reserve drain per token

Reference population (5,000 humans, no bots):

| Mine | Reserve | Target lifetime | Launch reward/block | Reward/block at end | day 30 | day 60 | day 90 | FULLY_MINED |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| DRILL (flagship) | 50,000,000 | 365 days | 7,500 | 335 | 32,848,125 | 29,953,725 | 27,059,325 | not mined out |
| STONE (mid-cap) | 50,000,000 | 270 days | 9,200 | 414 | 28,921,650 | 25,344,690 | 21,767,730 | not mined out |
| BYTE (long tail) | 50,000,000 | 90 days | 3,000 | 1,821 | 31,992,250 | 16,255,355 | 521,915 | not mined out |
| FROG (day 14 launch) | 50,000,000 | 30 days | 5,000 | 4,963 | 25,721,597 | 0 | 0 | **day 48** |

Same mines with 10,000 staggered wallets and the risk gate off - the reserves are identical, only the
recipients change:

| Mine | day 90 reserve | Bot share of that mine's minted tokens |
| --- | --- | --- |
| DRILL (flagship) | 27,059,325 | 0.3% |
| STONE (mid-cap) | 21,686,740 | 13.4% |
| BYTE (long tail) | 521,915 | 0.0% |
| FROG (day 14 launch) | 0 (FULLY_MINED day 48) | 24.7% |

## Emission schedule and launch parameters (flagship)

| Flagship launch parameters | Launch reward/block | Target lifetime | Reward/block at day 90 | FULLY_MINED (simulated) | FULLY_MINED (analytic) | Reserve distributed (90d) |
| --- | --- | --- | --- | --- | --- | --- |
| lifetime-30 | 7,500 | 30 days | 4,348 | day 35 | day 35 | 100.0% |
| lifetime-90 | 7,500 | 90 days | 1,449 | not mined out | day 91 | 99.2% |
| lifetime-180 | 7,500 | 180 days | 696 | not mined out | day 182 | 63.1% |
| lifetime-730 | 7,500 | 730 days | 168 | not mined out | day 735 | 37.9% |
| launch-400 | 400 | 365 days | 400 | not mined out | day 440 | 20.7% |

The last row is the other side of the same rule: a launch reward *below* the reserve-runway budget is
a ceiling the schedule never exceeds, so that mine distributes more slowly than its target lifetime
and still empties completely (day 440 of a 365-day target, with nothing locked).

## Is the whole Mining Reserve distributable? (independent model)

`scripts/sim/selfcheck.ts` re-implements the schedule from scratch (`analyticRunway`) and is
required to empty every one of these reserves within its target lifetime. This is the proof for the
emission redesign, and it is one of the seven harness self-checks.

| Launch parameters | Reserve | Launch reward/block | Target lifetime | BEFORE (fixed reduction) | AFTER (reserve runway) |
| --- | --- | --- | --- | --- | --- |
| flagship 1,200/block, 12 months | 50,000,000 | 1,200 | 365 days | 27.8% locked forever | 100.0%, day 371 |
| flagship 1,900/block, 12 months | 50,000,000 | 1,900 | 365 days | 39.1% locked forever | 100.0%, day 371 |
| flagship 3,000/block, 12 months | 50,000,000 | 3,000 | 365 days | 56.8% locked forever | 100.0%, day 371 |
| flagship 7,500/block, 12 months | 50,000,000 | 7,500 | 365 days | 100.0%, day 43 | 100.0%, day 371 |
| long tail 300/block, 90 days | 3,000,000 | 300 | 90 days | 100.0%, day 768 | 100.0%, day 91 |
| large lift-off 40,000/block, 24 months | 200,000,000 | 40,000 | 730 days | 100.0%, day 24 | 100.0%, day 735 |

## ORE distribution at day 90

| Cohort | ORE p10 | ORE p50 | ORE p90 | ORE p99 | ORE mean | Earned p50 | Earned p90 | Overflow mean | Power p50 | Effective power p50 | Streak p50 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Humans (1,470) | 167 | 1,202 | 2,554 | 3,515 | 1,310 | 33,373 | 58,818 | 522 | 568 | 568 | 6 |

## Mining Power by vintage

| Vintage | day 1 | day 7 | day 14 | day 30 | day 60 | day 90 |
| --- | --- | --- | --- | --- | --- | --- |
| Joined day 1 (veterans) | 153 | 157 | 251 | 359 | 506 | 594 |
| Joined day 7 | - | 153 | 197 | 294 | 477 | 568 |
| Joined day 2-6 | 153 | 157 | 206 | 329 | 500 | 568 |
| Joined day 8-30 | - | 153 | 153 | 247 | 405 | 540 |

| Ratio | Value |
| --- | --- |
| Retained day-1 veteran at day 90 vs the starter crew (153) | 3.88x (p50 594) |
| Median retained human at day 30 / day 90 | 359 (2.35x) / 568 (3.71x) |
| Veteran vs a day-7 joiner at day 90 | 1.05x |
| Theoretical maximum from the configured curves | 22.59x (within the 25x bound) |
| On-chain `DEFAULT_MAX_CREW_POWER` | 50,000 - never binding (the highest power reached in 90 days is well under it) |

## What the hardening costs honest players

| Scenario | Humans retained | Tokens released per human | Tokens held per human | ORE earned p50 | Power p50 | Humans held/reviewed/blocked | Humans NORMAL |
| --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 1,470 | 102,426.03 | 0.00 | 33,373 | 568 | 0 | 1,470 |
| baseline-legacy | 1,470 | 110,186.99 | 0.00 | 32,138 | 247 | 0 | 1,470 |
| bots-10000-stealthy | 1,470 | 91,247.41 | 0.00 | 33,373 | 568 | 0 | 1,470 |
| bots-10000-stealthy-legacy | 1,470 | 40,253.02 | 0.00 | 32,138 | 247 | 0 | 1,470 |

Two honest readings of this table:

- **No false positives.** Not one retained human is held, reviewed or blocked in any scenario, and the
  human median ORE and median power are byte-identical to the no-bot baseline once progression
  works. The hardening is invisible to the modelled population.
- **The 90-day token comparison against legacy is not a like-for-like number.** The legacy economy
  pays 7.5M tokens a week out of the flagship until it is empty on day 44, which is more tokens in 90
  days than a 12-month runway pays, so per-human rewards look higher. The trade is 44 days of runway
  for 365.

## Risk posture at the end of the run

| Scenario | Cohort | Score p50 | NORMAL | UNDER_REVIEW | HELD | BLOCKED | Trust p50 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | humans | 8 | 1,470 | 0 | 0 | 0 | 95 |
| bots-10000-stealthy (shadow) | humans | 8 | 1,470 | 0 | 0 | 0 | 95 |
| bots-10000-stealthy (shadow) | bots | 43 | 10,000 | 0 | 0 | 0 | 79 |
| bots-10000-stealthy **#enforce** | bots | 43 | 0 | 10,000 | 0 | 0 | 79 |
| bots-10000-naive **#enforce** | bots | 100 | 0 | 0 | 0 | 10,000 | 99 |

In shadow mode the stored state stays `NORMAL` for the staggered farm, which is why its bot share of
*released* tokens is still 0.0%: the reward hold reads the *computed* state, not the enforced one, and
a hold destroys nothing.

## Harness self-checks

`npm run sim` runs the seven harness checks below, plus the five curve-phase checks that
`scripts/sim/curve.ts` asserts, and prints them all in `summary.md`:

| Check | Result (seed 20,260,922) |
| --- | --- |
| Determinism and population-order independence | PASS - identical digest twice, and identical with the population processed in reverse |
| Block schedule vs an independently written runway model | PASS - over 30 days the simulated reserve is 32,673,875 and the independent model's is 32,673,875 |
| The whole Mining Reserve is distributable | PASS - all six launch parameter sets reach FULLY_MINED within their target lifetime (1,200/1,900/3,000/7,500 per block on a 50M reserve: day 371 of 373; 300 per block on 3M: day 91 of 93; 40,000 per block on 200M: day 735 of 737). The old schedule never empties three of them |
| Mining Reserve conservation (`shared/rewardIndex.ts` `auditReserve`) | PASS - all four mines balance exactly, `unattributed == 0`, every settled token attributed to a cohort |
| Discovery caps hold end to end | PASS - token daily/period, global daily and per-request caps are never exceeded |
| ORE ledger closes (`earned == held + overflow + spent`) | PASS - 69,354,528 = 3,300,733 + 854,415 + 65,199,380 |
| Harness RNG matches `shared/random.ts` | PASS - HMAC mean 0.4966 / chi² 6.3, harness mean 0.5036 / chi² 7.9 (threshold 27.88 for 9 degrees of freedom) |


## Curve-phase mining: what mining does to a curve

Mining is paid out of the market's own bonding-curve token inventory before graduation, so it is a
market question rather than an accounting one — and nothing else in this harness models a curve.
`scripts/sim/curve.ts` does, on the real rules: the program's own quote math and spot price
(`shared/program.ts`), the launch-time cap, rate, room and sell capacity (`shared/curve.ts`), and
the same reward index the Worker runs (`shared/rewardIndex.ts`), with the power pointed at the mine
split into honest players and one farm.

Two curves run over the same seeded trade sequence, one that mines and one that does not, so the gap
between them is the **price impact of the emission itself**, measured. It runs as the last section of
every `summary.md` and on its own in a few seconds:

    npm run sim -- --curve-phase --days 90

| Day | Price (SOL) | Price with mining vs without | Curve inventory | Cap spent | Mined by humans | Mined by the farm | Farm share | Sell capacity (SOL) | Sell capacity (tokens) | Capped out |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 3.225e+1 | 0.17% | 936,870,570 | 3.3% | 828,908 | 746,092 | 47.4% | 0.21 | 6,549,431 | no |
| 7 | 3.530e+1 | 1.17% | 890,759,292 | 23.3% | 8,028,065 | 2,996,935 | 27.2% | 1.45 | 42,931,076 | no |
| 30 | 4.891e+1 | 5.06% | 739,957,277 | 100.0% | 41,858,695 | 5,391,305 | 11.4% | 6.19 | 152,757,311 | yes |
| 60 | 6.031e+1 | 3.62% | 666,389,356 | 100.0% | 41,858,695 | 5,391,305 | 11.4% | 10.19 | 226,325,247 | yes |
| 90 | 7.127e+1 | 2.60% | 613,025,364 | 100.0% | 41,858,695 | 5,391,305 | 11.4% | 13.69 | 279,689,252 | yes |

5,000 honest wallets arriving over 30 days plus a 10,000-wallet farm, a 945,000,000 token curve
inventory, the default 5% cap (47,250,000 tokens) over a 30-day runway, seed 20,260,922.

Four things this run settles:

1. **The cap is real and the runway is the reason it lasts.** The 5% budget is spent on **day 30** of
   a 30-day runway, exactly where the launch arithmetic puts it — and from that block on, curve-phase
   emission is over for everyone until the market graduates. Mined total: 47,250,000 of 47,250,000,
   never a base unit more.
2. **Mining moves the price and nothing else.** Against the same curve over the same trades with no
   mining at all, the emission is worth **+5.06% at its peak on day 30** (and 2.60% by day 90, as
   trading catches up). Sell capacity is the real SOL the curve holds — 0.21 SOL on day 1, 13.69 by
   day 90 — and it moves only when somebody buys: mined tokens bring no SOL with them, so the two
   curves' sell capacity is the same curve's worth of buying, not a lamport more.
3. **A farm's share of the cap is damped but not zero, and it is front-loaded.** The farm takes
   **47.4% of day 1's emission** — before the honest population has aged through the maturity ramp —
   and 11.4% over the whole 30 days the cap lasts. The configured device and network factors are what
   hold it there (10,000 wallets on one device keep the 1.5% floor), and this is the row that prices
   them on a budget rather than on a stream: a finite cap is what a farm can actually exhaust.
4. **Conservation holds to the base unit.** Curve inventory + mined out + bought - sold back == the
   launch inventory, residual 0.00e+0 whole tokens, and the positions the index credited hold
   47,249,999.992 of the 47,250,000 emitted — the 0.008 token difference is index rounding dust that
   the program also leaves unallocated.

The scenario asserts all five of its own checks (conservation, the cap, credited ≤ emitted, mining
never lowers the price, mining never adds sell capacity) and `npm run sim` fails if any of them does.


## Limitations

- Risk-signal values are derived from scripted behaviour (see the mapping note above); production
  measures the same quantities from `account_signals` in D1 and may disagree on the margins. Rate
  limits, circuit breakers and operator restrictions are not simulated, and a wallet-signature
  challenge is assumed passable - both are conservative for a farm.
- **The cluster damping is only as good as the device and network fingerprints.** The harness models
  one honest-ish farm shape (15 wallets per device, 25 per network environment) and one wallet per
  device for humans. A farm that spoofs a distinct device header per wallet is not damped by the
  device factor; it is caught by the other signals (creation cluster, activation synchrony, timing
  regularity) or not at all, which is why the reward hold and the discovery caps are the backstops
  that do not depend on the fingerprint. Such a farm is not bounded by the cluster ceiling either (a
  cluster of one is inside its allowance), so an unlinked split is held back by account maturity and
  by the risk signals rather than by the ceiling. That residual is by design and is what the
  `bots-10000-stealthy` row prices; the mixed shape it does not price is noted below.
- **The false-positive cost of the device factor is not measurable in this harness** (humans are one
  wallet per device by construction). The configured curve, with the default allowance of 4 wallets,
  is:

  | Wallets on one device | 4 or fewer | 5 | 6 | 8 | 10 | 12 | 15 | 17+ |
  | --- | --- | --- | --- | --- | --- | --- | --- | --- |
  | Share of Mining Power | 100% | 70% | 49% | 24% | 11.8% | 5.8% | 2.0% | 1.5% (floor) |

  A shared browser profile with more than four wallets is throttled, never blocked: the account keeps
  its streak, its ORE, its position and its claim, and `effectivePower.cluster` is the knob to change.
- One mining position per wallet at a time, one target token per discovery, static per-token prices,
  and no trading, liquidity or market-cap dynamics. Discovery is assumed to be rolled once per active
  wallet per configured window.
- The harness models the off-chain index accounting that `worker/mining.ts` implements; it does not
  run D1 or the Solana program, so on-chain effects (rent, transaction costs, the per-call power
  increase bound) are out of scope. The effective power a position is armed with is the same number
  the off-chain index pays it; a mine indexed on chain should register the same effective power.
- The harness prices a farm of one shape at a time. A mixed strategy (many small farms, each inside
  the cluster allowance) is the obvious next adversarial case and is not in the matrix.

## Knobs and launch parameters

Each row names the exact knob and the simulation evidence behind it. "Launch parameter" means a value
an operator sets per mine (`launch_mine` / `sync_mine`), not a `DIGGO_CONFIG` field.

| Knob | Where | Now | Evidence |
| --- | --- | --- | --- |
| `economy.emission.schedule` | `shared/config.ts` | `reserve_runway` | The only schedule that distributes a whole reserve: 100% of all six launch parameter sets, versus 27.8-56.8% locked forever at 1,200-3,000 per block on the old curve. |
| `economy.emission.targetLifetimeDays` | `shared/config.ts` | 365 | The runway is a launch decision, not an accident of the launch reward: 30/90/180/730-day targets drain on day 35/91/182/735. |
| `economy.emission.minimumRewardPerBlock` | `shared/config.ts` | 1 | The floor that makes the tail finishable; without it a reserve can reach a reward of zero and stall. |
| `economy.emission.nonIncreasing` | `shared/config.ts` | `true` | Keeps spec 21 a reduction schedule. A mine that sits idle longer than planned stretches its runway instead of paying a catch-up burst. |
| Mine `rewardPerBlock` | launch parameter | 7,500 flagship | Now a ceiling, not a runway: the flagship pays 7,500 for its first epoch and then the reserve-runway budget (335/block by day 90). |
| Mine `lifetimeDays` | launch parameter | 365 flagship | Per-mine target lifetime; the config value is the default for mines that do not set one. |
| `effectivePower.maturityRamp` | `shared/config.ts` | 20/40/70/100% at day 1/3/7/7+ | Applied to block share, not just ORE (spec 40, 58). On its own it is a first-week speed bump; combined with the cluster factor it is what makes a young farm unprofitable. |
| `effectivePower.cluster.*` | `shared/config.ts` | allowance 4, 70% per extra wallet, network floor 50%, combined floor 1.5% | Cuts a 10,000-wallet farm from 63.4% to 10.8% of accrual with the risk gate switched off entirely. |
| `effectivePower.perAccountBlockShareCapBps` | `shared/config.ts` | 200 (2% of a block) | A *cluster* ceiling (spec 64): measured against the power the mine carries outside the cluster and divided over the wallets past an allowance, so splitting a farm across wallets cannot compound it. It never binds on one account, whatever that account's crew. Moves the naive farm rows (8.8% to 5.7% of mined, 13,250,000 to 8,560,000 held) and no honest number in this report. |
| `effectivePower.shareCapFloorPower` | `shared/config.ts` | 2,500 | The floor under the cluster ceiling, above the strongest reachable crew (a maxed veteran brings 2,259 power), so the ceiling is inert for a single account and only a cluster past an allowance is bounded. `shared/crew.test.ts` pins the relationship. |
| `enforcement.claimHold` | `shared/riskOps.ts` | `UNDER_REVIEW`, `HELD`, `BLOCKED` on `claim_reward` and `claim_discovery` | The one score-derived response that is applied in every mode (spec 53): it takes a farm from 10.8% of accrual to 0.0% actually received, and costs an honest player nothing. |
| `enforcement.mode` | `shared/riskOps.ts` | `shadow` | Still the launch default, and now much less load-bearing: with discovery and claims held, a shadow-mode farm captures 0.0%. Enforcing adds rate limits and challenges on top. |
| `ore.storageBaseCapacity` / `storageCapacityScale` / `offlineHours*` | `shared/config.ts` | 1,800 (+420 × level^0.78), 24h (+4h/level, cap 168h) | Overflow per player falls from 18,614 ORE to 522, and the median player stops being pinned at capacity (p10 = p50 = 1,125 before). |
| `crew.upgradeCostBase` / `upgradeCostExponent` / `ore.baseOrePerActiveHour` | `shared/config.ts` | miners 80, exponent 1.4, 30 ORE/hour | Realised progression 1.64x -> 3.71x at day 90 (veterans 3.88x) while the crew curve keeps the ceiling at 22.59x. |
| `discovery.minimumCrewTier` | `shared/config.ts` | 2 (total crew level 15) | Now that progression works, farms clear it too: the `bots-10000-stealthy-tier2` counterfactual (which bars them) cuts the farm's *committed* discovery share and still distributes 127.8M of Mining Reserve in 90 days. Raising the tier, or adding the risk state to eligibility, is the lever if discovery should not be committed to a farm at all. |
| `discovery.accountDailyCapUsd` / `accountWeeklyCapUsd` | `shared/config.ts` | 0.5 / 2.5 | 10,967 `no_budget_left` refusals in 90 days for humans, 145,780 in the farm scenario: the caps are still the binding constraint, which is why removing them multiplies discovery payouts by 14x. |
| `discovery.tokenDailyCapUsd` / `globalDailyCapUsd` | `shared/config.ts` | 25 / 500 | Leave as is: no scenario ever reaches them. |
