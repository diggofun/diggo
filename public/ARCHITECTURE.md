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

### Which side pays: the curve phase

Mining works from the launch block, not from graduation. While a market is still on its bonding
curve, the blocks it pays are drawn out of **that curve's own token inventory** instead of the
Mining Reserve, so a mined token moves the token side of the curve exactly where a bought one moves
it and the SOL side does not move at all. `shared/curve.ts` is the client-and-Worker mirror of the
rule (`isCurveMiningOpen`, `curveMiningRoom`, `curveMiningBlockReward`, `curveSellCapacity`),
and `programs/diggo-protocol/src/lib.rs` is the authority for it.

- **The budget is a launch parameter and immutable.** `curve_mining_bps` of the curve's initial
  token inventory, default 5% and capped at 10%, snapshotted into `LaunchMarket.curve_mining_cap`
  at launch. Nothing writes it again, and `migrate_account` can only default it to zero, so a
  legacy market can never be handed an allowance it was not launched with.
- **The rate is the cap over a runway**, not the mine's block reward: spread over
  `curve_mining_runway_days` (30 by default) and flat, so a 5% budget is a month of rewards rather
  than the hours a reserve-sized reward would spend it in. The reserve-runway schedule still steps
  down on the mine's own epochs, because it governs the reserve the mine inherits at graduation.
- **When the cap is spent, curve-phase emission stops.** The mine is idle, not finished: it keeps
  its whole Mining Reserve, `FULLY_MINED` keeps its existing meaning of "nothing more to pay", and
  graduation turns mining back on out of the reserve. The off-chain index follows the same rule
  (`reconcileEmissionSource` in `worker/mining.ts`), so indexed accrual and on-chain emission can
  never disagree about which side paid.
- **Mined tokens bring no SOL.** Sell capacity is the real SOL the curve holds, which the quote path
  caps every payout at, so pre-graduation sells are limited to what buyers put in. The API reports
  it read-only as `sellCapacity` and the cap's progress as `curveMining`.
- **Conservation holds through the phase.** Tokens in the curve plus mined out plus sold, net of
  buy-backs, is the inventory the launch created; graduation seeds the pool with the post-mining
  inventory and leaves the mined-but-unclaimed tokens in the market vault for the positions the
  index already credited. `npm run sim -- --curve-phase` prices the whole scenario on the real
  rules, including the price impact of the emission against the same curve with no mining at all.

## 6. Reserves, reductions and FULLY_MINED

- The **Mining Reserve** and each token's **Discovery Reserve** are program-controlled. Neither a
  creator nor an admin can withdraw either one; tokens leave only through the valid mining or
  discovery path.
- Mining never mints. Supply is fixed at launch, mint and freeze authorities are revoked, and the
  default allocation has 0% creator and platform premine.
- Block rewards are capped at the remaining reserve — or, before graduation, at the curve-mining cap
  the launch set (see section 5). When the source runs out the mine is `FULLY_MINED`:
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

Collecting is therefore a client-driven two-step. `src/rewardsClaim.ts` signs and submits
`claim_rewards` from the player's own wallet, then reports the transaction to
`POST /api/rewards/claim/confirm`; the Worker verifies it against chain before writing
`tx_signature`. The report is idempotent, a signature already backing another reward is refused,
and a payout the client could not confirm is still recorded later — but a settled reward with no
recorded signature is exactly what `worker/reconcile.ts` treats as a divergence, and that halts the
mine's mint until a human looks. Reporting the signature is part of the payout, not an optimisation.

## 8. Random memecoin Discoveries

The most security-sensitive subsystem, because it hands out real value.

- **Server-authoritative, commit-reveal RNG.** Whether a discovery happens, which token, which
  rarity, which visual event and how many units are all derived server-side from a seed derived
  from `DISCOVERY_SECRET`. The client sends no seed and never computes an outcome; unset, the
  subsystem fails closed rather than falling back to a predictable seed. Each epoch
  (`DISCOVERY_EPOCH_SECONDS`, bounded to `[3600, 2592000]`, a day by default) publishes only a
  commitment to that seed through the public `GET /api/discovery/commitments`, and reveals the seed
  once the epoch has closed, so an outcome cannot be ground out after the fact and a revealed seed
  can be checked against the commitment anyone read earlier. It is verifiable, not yet trustless.
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
- **Price confidence is a gate, not a number.** `worker/oracle.ts` is the only module that answers
  what a token or SOL is worth. `getRobustPrice` combines the token's own observed history, a
  volume-weighted average of real recorded trades, Jupiter and Pyth, and returns `null` when the
  sources disagree beyond the deviation gate or are stale — a discovery that cannot be valued pays
  nothing rather than paying a wrong amount. `getSolUsd` replaces the old hardcoded illustrative
  rate wherever a USD figure is shown, and falls back to that constant only as a clearly labelled
  last resort. Cron keeps the cache warm; a player request never blocks on a third-party API.

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
- **Enforcement is shadowed until a person adopts it** (spec 63). `RISK_OPS.enforcement.mode` ships
  as `shadow`: the gate still reaches a verdict, records it as `risk.shadow_would_block` and shows
  the operator what it would have done (`computedState` next to the state in force, `shadowed` on
  each admin account row), while the account keeps playing. Rate limits, circuit breakers and an
  operator restriction are enforced in either mode, and `enforcement.overrides` moves one action in
  or out of enforcement without changing the global mode.
- **Appeals** are the human path back: a player files one, an operator decides from a queue. Filing
  changes nothing by itself; deciding one can only lift restrictions. Both directions are bounded
  and the filing endpoint answers identically whether or not the account is under anything, so it
  cannot be used to probe the risk layer.
- **Player lock** (`worker/playerLock.ts`): a Durable Object per wallet arbitrates the reward paths,
  so two concurrent activations or claims cannot interleave a read-modify-write. It is defence in
  depth and fails open, loudly — a broken binding must not stop players from playing, and every
  guarded update underneath it is still conditional in SQL. `worker/reconcile.ts` closes the other
  half of the loop: it compares paid claims and reserves against chain on a schedule and halts the
  affected mine's mint on divergence.
- **Admin anti-abuse surface** (`/api/admin/*`): account risk level, age, active days, streak, crew
  level, discoveries, claimed value, flags, related accounts and current restrictions, plus
  restrictions and breaker controls. Admin actions are audited and can only restrict or halt.
  Every mutation carries a signed, single-use **step-up** bound to that action and its exact
  payload, so an admin session alone is never enough.
- **Notifications** are delivered on whatever channel the player opted into: the in-app list is
  always the record, Web Push (`worker/push.ts`, RFC 8291 + 8292) is the default, and an optional
  Telegram bot is the fallback for browsers that cannot do either. Both are opt-in, both are
  optional to the deployment, and a push subscription is always scoped to the signed-in wallet.

## 10. Configuration

Every gameplay, economic and anti-abuse parameter lives in **`shared/config.ts`**
(`DIGGO_CONFIG`), deeply frozen, with `createDiggoConfig()` for derived tuning. Deployment-time
tuning goes through `configFromEnv()`, the single override layer between the frozen defaults and a
Worker environment: values are clamped to declared bounds, so a mistyped variable can neither open
the floodgates nor stop a subsystem. Anti-abuse budgets, thresholds and alert rules live beside it
in **`shared/riskOps.ts`** (`RISK_OPS`). Both are covered by unit tests, so the tuned values are the
executable specification.

Curve-phase mining adds one section to that object: `DIGGO_CONFIG.curve` holds the launch defaults
and bounds for the pre-graduation emission budget (`defaultMiningBps`, `maxMiningBps`,
`defaultRunwayDays`, `maxRunwayDays`) and the two windows the indexed 24h metrics are measured
over (`changeBaselineSeconds`, `volumeWindowSeconds`). The share and the runway are per-launch
parameters in the sense that a launcher picks them for each mine; these are the defaults a launch
that does not pick gets, and they are pinned to the program's own constants by
`shared/curve.test.ts`, because a default the program would reject is a launch that cannot land.

The price oracle's bounds live in `DIGGO_CONFIG.oracle` (`shared/config.ts`) with every other
tunable, and `worker/oracle.ts` re-exports them as `ORACLE_LIMITS` for its own callers, so one config
object still describes the whole deployment. Its environment variables — `JUPITER_PRICE_URL`,
`JUPITER_PRICE_V2_URL`, `JUPITER_API_KEY`, `PYTH_HERMES_URL`, `PYTH_API_KEY`,
`PYTH_SOL_USD_FEED_ID`, `ORACLE_MIN_EXTERNAL_SOURCES`, `ORACLE_SOL_USD_OVERRIDE` and
`DISCOVERY_EPOCH_SECONDS` — are declared once in `worker/env.ts` and every one of them has a
working default, so an unconfigured deployment still reads a real price.

## 11. Module map

| Area | Where |
| --- | --- |
| Config, risk-ops parameters | `shared/config.ts`, `shared/riskOps.ts` |
| Crew, ORE, streak, reward index, rarity, discovery math | `shared/crew.ts`, `shared/ore.ts`, `shared/streak.ts`, `shared/rewardIndex.ts`, `shared/rarity.ts`, `shared/discovery.ts`, `shared/random.ts` |
| Curve-phase mining: cap, rate, runway, sell capacity, budget selection | `shared/curve.ts` |
| Activation, streak, report, claims | `worker/mining.ts` |
| Discoveries | `worker/discovery.ts` |
| Auth, challenges, sessions | `worker/auth.ts` |
| Risk gate, score, holds, cron | `worker/risk.ts`, `worker/signals.ts`, `worker/breakers.ts`, `worker/telemetry.ts` |
| Admin surface | `worker/admin.ts` |
| Price oracle, commit-reveal RNG | `worker/oracle.ts`, `shared/commitReveal.ts` |
| Per-wallet lock, reconciliation | `worker/playerLock.ts`, `worker/reconcile.ts` |
| Appeals, notifications, push, Telegram | `worker/appeals.ts`, `worker/notifications.ts`, `worker/push.ts` |
| Keeper (bounded signer) | `worker/keeper.ts` |
| Chain sync, indexing queue | `worker/chain.ts`, `worker/indexing.ts` |
| Cosmetics, achievements, notifications, leaderboards | `worker/cosmetics.ts`, `worker/notifications.ts`, `worker/leaderboard.ts` |
| Legal documents, consent, web push | `src/components/legal/*`, `src/components/ConsentBanner.tsx`, `src/push.ts`, `worker/push.ts` |
| Router, cron, queue consumer | `worker/index.ts` |

The legal pages (`/terms`, `/privacy`, `/risk`, `/cookies`) are plain documents with no
JavaScript-dependent decoration, and they are the one place a player can change or withdraw the
analytics choice the consent banner records. Analytics is off until that choice is made, which is
why `src/analytics.ts` starts PostHog from the stored decision rather than at boot.

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

- The keeper runs inside the Worker — queue-triggered from `worker/indexing.ts`, never on the request
  path — and signs with `DIGGO_KEEPER_SECRET_KEY`, a Cloudflare secret (`docs/CUSTODY.md`). That is a
  lower bar than a dedicated signer service: a leaked secret or a Worker compromise exposes
  `sync_crew_power`, `claim_discovery` and `graduate_market` up to their on-chain bounds, which are
  what limit the damage rather than the key's isolation.
- There is no AMM integration, and the price oracle is a Worker-side policy rather than an on-chain
  one: the program does not re-check a price it is handed, so a compromised Worker could still
  value a discovery wrongly. The oracle's own refusals are what bound that today.
- Discovery RNG is commit-reveal in the Worker. A revealed seed can be checked against its published
  commitment, but a player still has to trust that the Worker committed before it knew the outcome;
  it is verifiable today, not trustless.
- The vanity-mint worker pool is not implemented.

The website therefore presents a limited initial product experience.
