# Diggo.fun — Architecture

> Diggo.fun combines a Solana memecoin launchpad/DEX with an idle mining
> game. Players build and grow a **Mining Crew**, activate it manually once
> a day for 24 hours, and pick a memecoin for the crew to mine. The crew
> works automatically — including while the player is offline.

This document reflects the **currently implemented** design. It supersedes
the earlier "equipment upgraded by paying real tokens" model entirely: real
money and real memecoins never buy Mining Power in this codebase.

---

## 1. Core loop

1. Player connects a wallet and signs in (Ed25519 challenge, no on-chain
   transaction).
2. Player clicks **Activate Mine** — a second, purpose-built signed
   challenge proves it's really their wallet, once per day.
3. The crew mines the selected coin for 24h (+12h grace), online or not.
4. On the next visit, the player collects a **Mining Report**: ORE earned,
   streak progress, and any random real-memecoin **Discovery**.
5. ORE — an internal, non-transferable resource — is spent to upgrade the
   five Crew components (Miners, Drills, Carts, Foreman, Storage).
6. A stronger crew means more Mining Power, which means a larger
   proportional share of each coin's block reward.
7. The player can switch which coin the crew mines at any time without
   losing activation or streak.

## 2. Two separate economies

**Real memecoins** are ordinary SPL tokens: ownable, tradable, transferable.
They come from proportional block rewards and random Discoveries.

**ORE** is internal game state only:

- not an SPL token, not transferable, no market, no price;
- cannot be bought with SOL, USDC, a memecoin, or anything else;
- can only be earned by keeping the crew active.

**Hard rule enforced throughout this codebase: real money never directly
buys Mining Power.** There is no `SOL → power`, `memecoin → power`,
`buy ORE`, or "premium" path anywhere in the client, the Worker, or the
Solana program.

## 3. Daily activation

`POST /api/mine/activate` requires a fresh, single-use, wallet-signed
challenge (`POST /api/mine/activate/challenge`) — not a bare unauthenticated
POST. The nonce is consumed from KV on first use, so a captured request
cannot be replayed for a second reward.

- Activation window: 24h (`GAMEPLAY_DEFAULTS.activationSeconds`).
- Grace period: +12h before the streak breaks.
- Earliest reactivation: 20h after the previous activation — this is what
  actually rate-limits the daily-report/discovery-roll path, independent of
  the generic per-IP/per-wallet rate limiters.
- Reactivating does not require the app to stay open; ORE accrues for the
  time the crew was genuinely active, computed server-side from
  `last_activation_at` / `activation_expires_at`, never from a client claim.

Streak rewards are **cosmetic/progression only** (ORE, streak count, Streak
Freezes) — never a multiplier on real block rewards. See
`shared/economics.ts` (`nextStreak`, `GAMEPLAY_DEFAULTS`).

## 4. Mining Crew

Five components, each with its own strategic role and its own level curve:

| Component | Role |
| --- | --- |
| Miners | Base Mining Power |
| Drills | Efficiency multiplier on top of Miners |
| Carts | ORE storage capacity |
| Foreman | A second, smaller efficiency multiplier |
| Storage | ORE storage capacity |

`crewPower()` combines these with diminishing returns (`Math.pow`,
`Math.log2`) so a veteran account is meaningfully but not absurdly stronger
than a new one. `upgradeOreCost()` grows super-linearly
(`level ** 1.72`) per component so ORE can't fund maxing everything at once.
Crew tiers (`CREW_TIERS`) are a cosmetic/display grouping over total crew
level.

Upgrades (`POST /api/crew/upgrade`) cost **only ORE**, applied with an
optimistic-concurrency SQL guard (`UPDATE ... WHERE ore_balance >= ? AND
level = ?`) so two concurrent upgrade requests can't double-spend the same
ORE.

## 5. Mining rewards (on-chain, unchanged math)

Each launched coin still gets its own on-chain `Mine`: a fixed reserve,
periodic block rewards, epoch-based reward reduction, and O(1)
cumulative-reward-index accounting (`reward_index`, `MiningPosition`) so the
program never loops over every miner. See `programs/diggo-protocol/src/lib.rs`.
This part of the original design was already correct and is unchanged.

What changed: **Mining Power on-chain is no longer purchased with tokens.**
`Player.power` is set exclusively by a new `sync_crew_power` instruction,
callable only by the protocol's `keeper` authority — the backend pushing the
off-chain, ORE-funded Crew Power it already computed. The old
`upgrade_equipment` instruction (pay tokens → burn/recycle/fee → more power)
is removed.

> Wiring status: the Worker computes Crew Power (`crewPower()`) and stores it
> in D1 today; it does not yet hold keeper key material or submit Solana
> transactions. `sync_crew_power` exists on-chain and is ready for a
> dedicated signer service — see "Not yet wired" below.

## 6. Random memecoin discoveries

A crew that had a genuine prior 24h active window and clears
`discoveryEligible()` (account age, active days, crew tier) gets one
server-side roll per activation (`rollDiscovery` in `worker/index.ts`).

- RNG is `crypto.getRandomValues`, server-side, never frontend
  `Math.random()` — the frontend never decides whether a discovery
  happened, what rarity it is, or how much it's worth.
- Rarity (`common` → `mythic`) comes from `rollDiscoveryRarity()`, a pure
  function over a caller-supplied uniform draw, weighted 70% common down to
  0.05% mythic.
- The discovered coin is a different `MINING_ACTIVE` token above a minimum
  market cap (`DISCOVERY_DEFAULTS.minimumMarketCapUsd`) — an illiquid,
  easily-manipulated token can't become a Mythic discovery just because its
  spot price is high.
- Value is priced in USD first, then converted to token units
  (`discoveryTokenAmount`), so a cheaper token yields more units and a
  pricier one yields fewer, at a roughly constant real value.
- Every discovery is capped by four independent budgets before it's rolled:
  per-account/day, per-account/week, per-token/day, and global/day
  (`discoveryBudgetRemainingUsd`). A discovery is only written to the
  `discoveries` table — and therefore only exists — if all four checks
  pass.
- Discoveries are idempotent, single-write records (`PENDING`/`ELIGIBLE`),
  never re-rolled or re-granted for the same activation.

On-chain, each coin also gets a small program-controlled **Discovery
Reserve** (`Mine.remaining_discovery_reserve`, minted at launch alongside
the mining reserve) that only the keeper can pay out of, via
`claim_discovery` — again, never a creator- or platform-controlled wallet.

## 7. Account maturity and anti-Sybil design

The spec's core security assumption: **a wallet address is not a human**,
and creating 10,000 wallets must not create 10,000 fully-effective mines.
Implemented today:

- **Progressive maturity** (`maturityBps`): a fresh account earns ORE at
  20% efficiency on day 0, ramping to 100% by day 7. Applied to both the
  time-based ORE rate and the daily activation bonus.
- **Starter Crew**: every new account starts at level 1 in all five
  components — there is no way to buy past this.
- **Discovery eligibility gate** (`discoveryEligible`): minimum account age,
  minimum active days, and minimum crew tier before *any* discovery can
  roll, on top of the four discovery budget caps above.
- **Two independent rate-limit dimensions**: per-IP (`checkRateLimit`,
  existing) and per-wallet (`checkWalletRateLimit`, new) on activation and
  crew-upgrade endpoints, so neither IP-rotation nor wallet-rotation alone
  defeats the limiter.
- **Signed, single-use activation challenges** — see §3 — make scripted
  mass-activation meaningfully more expensive than a bare POST loop.
- **`risk_state`** per player (`NORMAL` / `UNDER_REVIEW` / `HELD` /
  `BLOCKED`) gates discovery rolls today; `risk_events` is populated (e.g.
  on a budget-exhaustion hit) as the substrate for a future behavioral
  risk score. The score, its weights and its thresholds are intentionally
  not exposed to clients.

None of this requires depositing money to unlock — maturity is earned only
through time and legitimate play, per the spec's explicit "don't paywall
account trust" rule.

## 8. High-level architecture

```text
                         ┌───────────────────────────┐
                         │        WEB / MOBILE        │
                         │  Launch • Activate • Crew  │
                         │  Discover • Trade          │
                         └─────────────┬─────────────┘
                                       │
                          Wallet sign / read APIs
                                       │
              ┌────────────────────────┴────────────────────────┐
              │                                                  │
      ┌───────▼────────┐                                ┌────────▼────────┐
      │ Backend / API   │                                │ Solana Programs │
      │ (Cloudflare)    │                                │ (Anchor)        │
      │                 │                                │                 │
      │ indexer         │                                │ Token Factory   │
      │ leaderboards    │                                │ Launch Market   │
      │ Crew / ORE      │                                │ Mining Reserve  │
      │ daily activation│                                │ Discovery       │
      │ discovery RNG    │                                │  Reserve        │
      │ anti-bot / rate │                                │ Mining Engine   │
      │  limiting        │                                │ Keeper-gated    │
      │                 │                                │  power sync     │
      └───────┬────────┘                                └────────┬────────┘
              │                                                  │
      ┌───────▼────────┐                                ┌────────▼────────┐
      │ D1 / KV         │                                │ DEX / AMM / LP  │
      └────────────────┘                                └─────────────────┘
```

The Solana program remains the source of truth for token ownership,
reserves, block-reward distribution, and burns. The Worker is the source of
truth for Crew/ORE/streak/discovery-eligibility game state — it is
authoritative for that internal game state (by design; see §6-§7) but is
**never** authoritative for a player's actual token balance, which only ever
moves through the Solana program. See `docs/SECURITY.md` and
`docs/CUSTODY.md`.

## 9. Not yet wired (explicit gaps)

Being direct about what exists versus what's demonstrated end-to-end:

- The Worker computes Crew Power and rolls/records Discoveries, but does
  not yet hold a keeper Solana keypair or submit `sync_crew_power` /
  `claim_discovery` transactions. That requires a dedicated signer service
  kept out of the request path (see `docs/CUSTODY.md`).
- Buying/selling and claiming real mining rewards on-chain
  (`buy`/`sell`/`assign_power`/`claim_rewards`) are implemented in the
  program but not yet called from the frontend — that gap predates this
  change and is unrelated to the Crew/ORE system.
- There is no admin anti-abuse dashboard yet; `risk_events` and
  `risk_state` exist as the data substrate for one.
- Discovery RNG uses `crypto.getRandomValues` in the Worker (server-side,
  not client-influenced) rather than an on-chain/verifiable-random source;
  the spec explicitly asks for an abstraction that can migrate to a more
  trustless RNG later, which this satisfies but does not yet implement.

## 10. Reference: game tuning constants

All gameplay numbers live in `shared/economics.ts` and are intentionally
not hardcoded into the Worker or the program beyond their use there —
tune `GAMEPLAY_DEFAULTS`, `DISCOVERY_DEFAULTS`, `DISCOVERY_RARITY_TABLE` and
`CREW_TIERS` in one place. See that file's exported functions
(`crewPower`, `upgradeOreCost`, `oreForActiveSeconds`, `maturityBps`,
`nextStreak`, `discoveryEligible`, `rollDiscoveryRarity`,
`discoveryTokenAmount`, `crewTier`) and its tests for the exact behavior —
they're the executable specification.
