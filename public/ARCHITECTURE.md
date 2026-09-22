# Diggo.fun — Architecture

> Diggo.fun is a Solana memecoin launchpad/DEX with an idle mining game on top. A player builds a
> **Mining Crew**, activates it manually once a day for 24 hours, picks a memecoin to mine, and the
> crew works — including while the browser is closed.

This document describes the **currently implemented** design. It supersedes the earlier
"equipment bought with real tokens" model entirely: nothing in this codebase lets real money,
real memecoins or SOL buy Mining Power.

## 1. Core loop

1. Connect a wallet and sign in (Ed25519 challenge; no on-chain transaction).
2. Collect the **Mining Report** for the window that just ended.
3. Click **Activate Mine** — a second, purpose-built signed challenge, once per 24h.
4. Pick a memecoin; the crew mines it automatically, online or not.
5. Spend ORE on the five Crew components to raise Mining Power.
6. Occasionally the crew finds a random real-memecoin **Discovery**.
7. Switch mines at any time without losing activation or streak.
8. Come back the next day and activate again to keep the streak alive.

## 2. Two separate economies

**Real memecoins** are ordinary SPL tokens: ownable, transferable, tradable. They arrive as
proportional block rewards and random Discoveries.

**ORE** is internal game state, never a token: not transferable, no market, no price, and not
purchasable with SOL, USDC or a memecoin. It only ever comes from keeping a crew active, and it
only ever buys Crew progression.

**Hard rule, enforced by what the code does not contain: real money never buys Mining Power.**
There is no `SOL → power`, `memecoin → power`, `buy ORE`, `pay to extend`, premium, subscription
or paid-lootbox path in the client, the Worker or the program. A cosmetic never grants power,
reward multipliers or better discovery odds either.

## 3. Daily activation and streak

`POST /api/mine/activate` requires a fresh single-use wallet-signed challenge
(`POST /api/mine/activate/challenge`). The nonce is consumed on first use, so a captured request
cannot be replayed for a second day. Windows are configuration, not constants
(`DIGGO_CONFIG.streak`): 24h active, +12h grace before the streak breaks, and a minimum 20h before
the next activation is accepted.

Activation is global Crew state, not per-token. A correct consecutive activation grows the streak;
streak milestones grant **ORE, XP, badges, titles and Streak Freezes only** — never a multiplier on
real block rewards. Freezes are earned in game and cannot be bought, and a freeze can cover one
missed window.

A paused crew accrues no ORE, joins no new blocks and rolls no new Discoveries. Rewards already
earned are never lost.

## 4. Mining Crew

Five components with distinct roles: **Miners** (base power), **Drills** (efficiency multiplier),
**Carts** (ORE efficiency and capacity), **Foreman** (organisation: cheaper upgrades, ORE
efficiency), **Storage** (offline hours and ORE capacity).

`crewPower()` applies diminishing returns (a sub-linear Miners curve, multiplicative Drills) so a
veteran is meaningfully but not absurdly stronger than a new account; `upgradeOreCost()` grows
super-linearly, so ORE cannot max everything at once. Upgrades cost **only ORE** and are applied
with an optimistic-concurrency guard (`UPDATE ... WHERE ore_balance >= ? AND level = ?`), so
concurrent requests cannot double-spend the same ORE. Tiers are a display grouping over total
level, and every tier is reachable through play alone.

## 5. Block accounting

Each mine is a fixed supply with a program-controlled **Mining Reserve**. Blocks are paid through a
per-mine cumulative reward index (`mine_reward_state.reward_index`), not per-miner transfers:

```
global_reward_index += block_reward / total_eligible_power
```

A position (`mining_positions`) stores `assigned_power`, `last_reward_index` and `pending_reward`.
Anything that changes entitlement — collect, switch, upgrade, expiry, claim — settles the index
delta first. Blocks are advanced lazily in bounded batches on read/write, so nothing scales with
players × blocks (spec 78). All token math is BigInt with an explicit fixed-point scale, and
rounding dust is tracked so reserve audits balance exactly.

**Eligibility boundary rule (spec 77):** a position is credited for block time `t` iff
`activated_at <= t < active_until`. The block landing exactly on `active_until` is **not** credited,
while a block landing exactly on the activation instant is. Both boundaries are covered by tests
(`worker/mining.test.ts`). A position is always armed on the mine's block grid and stores the later
of its activation instant and the mine's cursor, which is what makes the credited-block count exact
for a crew that switched mines mid-window.

## 6. Reserves, reductions and FULLY_MINED

- The **Mining Reserve** and each token's **Discovery Reserve** are program-controlled. Neither a
  creator nor an admin can withdraw either one; tokens leave only through the valid mining or
  discovery path.
- Mining never mints. Supply is fixed at launch, mint and freeze authorities are revoked, and the
  default allocation has 0% creator and platform premine.
- Block rewards are capped at the remaining reserve. When it runs out the mine is `FULLY_MINED`:
  mining stops, trading continues, and the crew can move to another coin.
- Rewards reduce on a configured epoch schedule (e.g. 10,000 → 7,500 → 5,625 → 4,219). The
  configured minimum is a floor on how far one step may travel and can never raise a reward, so the
  schedule is non-increasing. Unreduced tokens stay in the reserve; they are never burned.

## 7. Claims and payout routes

A settled reward becomes one `reward_claims` row and moves `PENDING → ELIGIBLE → CLAIMED`.
Claiming is a single conditional `UPDATE` guarded on `status = 'ELIGIBLE' AND eligible_until > now`,
so of any number of concurrent claims exactly one can win; a replay reports the same claim and pays
nothing twice. `HELD`/under-review rewards are parked until the hold lifts.

**A mining reward is paid by the player, not the backend.** The Mining Reserve leaves the program
only through the user-signed `claim_rewards` instruction, so `worker/indexing.ts`'s `reward_claim`
job never moves it: without a reported transaction the claim is exposed as `ready` (see the
`payout` field on every claim view) and with one the transaction is verified against chain and then
recorded through `markClaimPaid`. A keeper-signed payout of the Mining Reserve was rejected on
purpose — it would hand a backend key the power to drain a mine. The keeper's authority is bounded
to `sync_crew_power` (bounded by `ProtocolConfig.max_crew_power` and a per-call increase cap) and
`claim_discovery` (idempotent via an on-chain receipt per discovery id).

## 8. Random memecoin Discoveries

The most security-sensitive subsystem, because it hands out real value.

- **Server-authoritative RNG.** Whether a discovery happens, which token, which rarity, which
  visual event and how many units are all derived server-side from `DISCOVERY_SECRET`. The client
  sends no seed and never computes an outcome; unset, the subsystem fails closed rather than falling
  back to a predictable seed.
- **One roll per window.** The server authors a single-use opportunity per active Crew per window
  with a deterministic event id and a server nonce, consumed by one guarded update. A second roll is
  a 409, not a reroll — no spam-until-Rare, no cancelling an unfavourable roll, no best-of-N.
- **Eligibility before any roll** (spec 44): account age, active days, valid activations, Crew
  tier, maturity and a normal risk state.
- **Value caps even if detection fails** (spec 45, 64): per-account/day, per-account/week,
  per-token/day, per-token/period, per-request and global/day budgets, plus the token's indexed
  Discovery Reserve and its on-chain epoch budget.
- **Rarity is not price** (spec 26). It blends reserve availability, liquidity, volume/activity,
  token health and price confidence, so an illiquid token cannot become Mythic because its unit
  price is high. The amount is then normalized from robustness-checked price samples, never the raw
  spot price of a small pool, so a cheaper token pays more units and a dearer one fewer.

## 9. Anti-Sybil design

The working assumption is that wallets are free: an attacker can script activations, claims, mine
switches and thousands of headless browsers, and can rotate IPs. `1 wallet = 1 human` is never a
design premise. What makes farming expensive is **time**, and what bounds the damage is **caps**.

- **Account maturity** ramps progression efficiency over the first days, and every account starts
  with a small Starter Crew. Neither can be bought past (spec 41): no deposit, hold or premium
  removes a limit.
- **Discovery eligibility is stricter than mining progression**, and discoveries carry the budget
  caps above.
- **Progressive friction** (spec 52, 63): observation → rate limit → challenge → discovery
  restriction → reward hold → review → ban, and only with strong multi-signal evidence. A single
  weak signal cannot reach a ban.
- **Multi-key rate limiting**: wallet, session, IP, device and network budgets are checked together
  and all must pass, so neither IP rotation nor wallet rotation alone helps, while a household,
  school or CGNAT egress stays playable. Network and device signals are inputs to a score, never a
  ban on their own.
- **Account Risk Score** (`NORMAL`/`UNDER_REVIEW`/`HELD`/`BLOCKED`) combines device and network
  clusters, activation timing regularity and synchrony, action bursts, claim bursts, switching
  similarity, creation clusters and linked abuse history. Scores, weights and thresholds are never
  returned to a client; users see neutral copy such as "Additional verification required".
- **Reward holds**: a suspicious account keeps mining (accounting is observed) while claim,
  discovery and withdrawal paths are held, so an attacker cannot drain value before the system
  reacts.
- **Circuit breakers** can halt new discoveries, halt claims, or halt one mine's Discovery Reserve
  payouts — automatically on anomaly or by an admin. They are narrow, audited, and cannot move,
  seize or redirect funds, or stop trading.
- **Monitoring and alerting** (spec 66): activations/new accounts/claims/discoveries per hour,
  average and per-account discovery value, device and network cluster sizes, failed challenges,
  replay attempts, rate-limit hits, synchronised-activity share and reserve drain velocity, with
  alert rules evaluated on a schedule.
- **Admin anti-abuse surface** (`/api/admin/*`): account risk level, age, active days, streak, crew
  level, discoveries, claimed value, flags, related accounts and current restrictions, plus
  restrictions and breaker controls. Admin actions are audited and can only restrict or halt.

## 10. Configuration

Every gameplay, economic and anti-abuse parameter lives in **`shared/config.ts`**
(`DIGGO_CONFIG`), deeply frozen, with `createDiggoConfig()` for derived tuning. Deployment-time
tuning goes through `configFromEnv()`, the single override layer between the frozen defaults and a
Worker environment: values are clamped to declared bounds, so a mistyped variable can neither open
the floodgates nor stop a subsystem. Anti-abuse budgets, thresholds and alert rules live beside it
in **`shared/riskOps.ts`** (`RISK_OPS`). Both are covered by unit tests, so the tuned values are the
executable specification.

## 11. Module map

| Area | Where |
| --- | --- |
| Config, risk-ops parameters | `shared/config.ts`, `shared/riskOps.ts` |
| Crew, ORE, streak, reward index, rarity, discovery math | `shared/crew.ts`, `shared/ore.ts`, `shared/streak.ts`, `shared/rewardIndex.ts`, `shared/rarity.ts`, `shared/discovery.ts`, `shared/random.ts` |
| Activation, streak, report, claims | `worker/mining.ts` |
| Discoveries | `worker/discovery.ts` |
| Auth, challenges, sessions | `worker/auth.ts` |
| Risk gate, score, holds, cron | `worker/risk.ts`, `worker/signals.ts`, `worker/breakers.ts`, `worker/telemetry.ts` |
| Admin surface | `worker/admin.ts` |
| Keeper (bounded signer) | `worker/keeper.ts` |
| Chain sync, indexing queue | `worker/chain.ts`, `worker/indexing.ts` |
| Cosmetics, achievements, notifications, leaderboards | `worker/cosmetics.ts`, `worker/notifications.ts`, `worker/leaderboard.ts` |
| Router, cron, queue consumer | `worker/index.ts` |

The Solana program stays the source of truth for token ownership, reserves and block-reward
distribution. The Worker is authoritative for Crew/ORE/streak/discovery game state, and is never
authoritative for a player's token balance. See `docs/SECURITY.md` and `docs/CUSTODY.md`.

## 12. Invariants

1. Memecoins are real rewards.
2. ORE is non-transferable game progression.
3. SOL or real money cannot buy Mining Power.
4. One wallet does not equal one human.
5. Fresh wallets do not instantly receive full economic capability.
6. Time and account maturity make mass Sybil farming harder.
7. Real-value discoveries require stronger eligibility than normal mining progression.
8. Every real reward claim is replay-safe and idempotent.
9. The frontend never decides real-value RNG outcomes.
10. Reward caps limit damage even if detection fails.
11. CAPTCHA, IP and device fingerprint are never the only control.
12. Anti-abuse enforcement is progressive, to minimise false positives.
13. Creator and admin cannot arbitrarily withdraw Mining or Discovery reserves.
14. Mining works offline only while the 24h activation is valid.
15. Security-sensitive and economic parameters are configurable and testable.

## 13. Not yet mainnet-ready

Stated plainly, because the difference matters:

- The Worker holds no keeper key material and submits no transactions itself; the keeper code paths
  (`sync_crew_power`, `claim_discovery`) exist and are bounded, but need a dedicated signer service
  kept out of the request path (`docs/CUSTODY.md`).
- There is no AMM integration or manipulation-resistant oracle policy; discovery valuation uses
  robustness-checked internal price samples.
- Buying/selling and the user-signed `claim_rewards` transaction are implemented in the program but
  not yet driven from the frontend, so a settled mining reward is exposed as `ready` rather than
  collected.
- Discovery RNG is `crypto.getRandomValues`/HMAC in the Worker behind an abstraction that can
  migrate to a verifiable source later; it is server-authoritative today, not trustless.
- The vanity-mint worker pool is not implemented.

The website therefore labels itself as a devnet MVP.
