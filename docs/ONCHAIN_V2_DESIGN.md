# On-chain v2: moving the game's economic authority to Solana

Status: design proposal, not implemented. Supersedes the authority split in
`docs/ARCHITECTURE.md` sections 3-9, 13 and `docs/ONCHAIN.md` section 1. Program today:
`BLF7g1SbT72xb5M8rVrD7V3mdDXxb1AqwChcoeF4ppmE` (Anchor 1.2.0, `ACCOUNT_VERSION = 4`).

## 0. Why, and what "the bigger part" means

The program is already authoritative for the things that hold tokens: fixed supply, the
Mining Reserve, the Discovery Reserve, the cumulative reward index, the locked pool, and the
fee vaults. Everything that decides *who earns and how much* lives in the Worker:

| Decision | Today | Signer |
| --- | --- | --- |
| Mining Power | `crewPower()` in `shared/crew.ts` | keeper via `sync_crew_power` |
| Whether a discovery happens, which token, which rarity, how many units | `worker/discovery.ts` + `DISCOVERY_SECRET` | keeper via `claim_discovery` |
| Eligibility, maturity, caps | `shared/discovery.ts`, `worker/risk.ts` | Worker only |
| Activation, streak, ORE, crew levels | D1 (`players`) | Worker only |
| Risk holds, breakers | `worker/risk.ts`, `worker/breakers.ts` | guardian authority |
| Graduation | `worker/indexing.ts` triggers it | keeper pays rent |
| Price for value normalisation | `worker/oracle.ts` (Jupiter, Pyth) | none on-chain |

That split is the exact thing MiCA recital 22 asks about. Recital 22 keeps a service outside
the CASP regime where the provider has no control over the assets, and it names "fully
decentralised" provision as the test: the closer the token-holder relationship is to a smart
contract no operator can steer, the weaker the argument that a legal person is
intermediating. A Worker that chooses power values, rolls the dice and picks payout sizes is
discretionary control, however bounded the on-chain checks are. "Larger part on-chain"
therefore means: **every state transition that creates, sizes or releases value becomes a
program instruction signed by the player or by anyone, and no operator key is required for
any of them.**

What stays off-chain is only what cannot be a consensus fact: HTTP surfaces, indexing,
notifications, device and network fingerprinting, and prices for display.

+## 1. Cost model

This section is a hard product constraint and the rest of the design bends to it: **one
program serves every coin and is paid for once; creating a coin costs about one cent of SOL;
and the user's ongoing cost is transaction fees only, never a charge per roll.**

### 1.1 One-time program cost, and no per-coin deploys

Every coin is a set of PDAs under the single program
`BLF7g1SbT72xb5M8rVrD7V3mdDXxb1AqwChcoeF4ppmE`. `Anchor.toml` declares exactly one
program for devnet and localnet, `launch_token` deploys and upgrades nothing, and the only
`declare_id!` in the tree is that one. Adding a coin is data, not code. Confirmed: there is
no per-coin deploy anywhere in the design below.

| Item | Size | Rent (lamports) | SOL |
| --- | --- | --- | --- |
| Program account (executable stub) | 36 B | 1,141,440 | 0.00114144 |
| ProgramData account | 45 + 707,728 B | 4,926,990,960 | 4.92699096 |
| Deploy transactions (~708 buffer writes plus the final deploy) | | ~3,500,000 | ~0.0035 |
| **One-time total** | | | **~4.93 SOL = $740 at $150/SOL** |

Growth is the only thing that costs more later. ProgramData is exactly the `.so` length
plus 45 bytes, so any growth is an `ExtendProgram` at **6,960 lamports per byte**, capped at
10,240 bytes added per instruction and 10 MB total. v2 grows the program with the hand-written
curve tables, the VRF CPI and the discovery math, so budget **one 16 KB extend in two calls:
0.114 SOL**, and treat binary size as a real design requirement:

- hand-write the VRF commit/reveal CPI (discriminator plus account list) instead of linking the
  whole vendor SDK;
- keep the curve tables as `&'static` const data, never as account fields;
- keep no `String` in any account (section 1.3);
- add a release profile that `Cargo.toml` does not have today: `lto = "fat"`,
  `codegen-units = 1`, `opt-level = "z"`, `strip = true`, with
  `overflow-checks = true` and `panic = "abort"` kept on. That is typically 20-40% off a
  binary of this shape.

### 1.2 What one coin costs today

`launch_token` creates seven accounts, all with `payer = creator`. The rent-exempt
minimum is `(size + 128) x 3480 x 2 = (size + 128) x 6960` lamports.

| # | Account | Seeds and kind | Size (B) | Rent (lamports) | SOL |
| --- | --- | --- | --- | --- | --- |
| 1 | `mint` | `[b"mint", creator, nonce]`, SPL Mint | 82 | 1,461,600 | 0.0014616 |
| 2 | `mine` | `[b"mine", mint]`, `Mine` | 614 | 5,164,320 | 0.00516432 |
| 3 | `market` | `[b"market", mint]`, `LaunchMarket` | 127 | 1,774,800 | 0.0017748 |
| 4 | `market_vault` | `[b"market-vault", mint]`, token account | 165 | 2,039,280 | 0.00203928 |
| 5 | `reserve_vault` | `[b"reserve-vault", mint]`, token account | 165 | 2,039,280 | 0.00203928 |
| 6 | `discovery_vault` | `[b"discovery-vault", mint]`, token account | 165 | 2,039,280 | 0.00203928 |
| 7 | `fee_vault` | ATA(mint, treasury), token account | 165 | 2,039,280 | 0.00203928 |
| | **Total state** | | **1,483** | **16,557,840** | **0.01655784** |

Plus transaction cost: one signature (5,000 lamports) and roughly 120k CU for three
`mint_to`, two `revoke_authority` and seven account creations. At 1,000
micro-lamports per CU that is 0.00012 SOL; at a congested 10,000 it is 0.0012 SOL.

**Current total: 0.01656 + about 0.00013 = 0.01669 SOL, or $2.50 at $150/SOL.**

Two findings worth acting on before anything else is designed:

- **`fee_vault` is dead weight.** It is created at launch and written into
  `mine.fee_vault`, and then no instruction ever reads it: `claim_creator_fees` and
  `claim_platform_fees` pay lamports accounted in `LaunchMarket.creator_fee_claimable`
  and `platform_fee_claimable`, not tokens from this account. That is 0.00203928 SOL of pure
  waste per coin, and an unused account is also an unused attack surface.
- **There is no on-chain metadata today.** There is no Metaplex account, `anchor-spl` is
  built without the metadata feature, and `name`, `symbol` and `uri` live as
  `String`s inside `Mine`, where they cost 254 bytes (0.00176784 SOL) and are invisible
  to wallets and explorers. So the Token-2022 metadata work in section 1.3 is not a saving to
  bank, it is a new capability that costs slightly more than the invisible strings it replaces.
  Worth knowing before anyone promises a cheaper launch on the strength of it.

Two things are already lazy and should stay that way. `graduate_market` creates
`LiquidityPool` (161 B), `pool_token_vault` (165 B) and `pool_sol_vault` (41 B)
with its own `payer`, so that 0.005227 SOL is paid at graduation by whoever calls it rather
than added to the launch price. And the per-player accounts are paid once, by the player:
`Player` 81 B (0.00145464 SOL), `MiningPosition` 105 B (0.00162168 SOL), and
`DiscoveryReceipt` 97 B (0.001566 SOL) by whoever settles.

### 1.3 Target: one coin for about a cent of SOL

Three changes, ordered by how much each one saves.

**(a) One token vault with an internal ledger, instead of four token accounts.** A coin needs
exactly one token account: the program-owned vault holding everything not yet distributed.
`curve_tokens`, `reserve_remaining`, `discovery_remaining` and
`outstanding_claims` become fields of the coin account, and every payout debits the ledger it
is allowed to touch. Replacing four vaults (660 B of data, 1,172 B billable once the 128-byte
per-account overhead is counted) with one 165-byte vault saves **0.00611784 SOL** of rent, of
which 0.00203928 is the dead fee vault.

The trade-off is real and needs compensating. Today the three vaults give physical separation,
so a bug in the mining path cannot spend discovery tokens. With one vault the only separation is
the ledger fields, so add a global invariant asserted at the end of every instruction that
touches the vault:

`vault.amount >= curve_tokens + reserve_remaining + discovery_remaining + outstanding_claims`

`outstanding_claims` (the part of the index already credited to positions but not yet
claimed) is what makes the invariant complete: without it the sum is short by exactly the
mined-but-unclaimed amount and the check is vacuous. Add a litesvm property test that fuzzes
buy, sell, claim and graduate and asserts the invariant after every instruction.

**(b) Merge `Mine` and `LaunchMarket` into one compact `Coin` account.** 741
bytes of account space become 332.

| | Today (`Mine` + `LaunchMarket`) | v2 (`Coin`) | Bytes |
| --- | --- | --- | --- |
| Fields | 606 + 119 = 725 | 324 | -401 |
| Discriminators | 8 + 8 = 16 | 8 | -8 |
| **Account space** | **741** | **332** | **-409** |
| Billable space (data, plus 128 B per account) | 997 | 460 | -537 |
| Rent | 0.00693912 SOL | 0.0032016 SOL | -0.00373752 SOL |

Where the bytes go, and it does add up to 437 removed and 36 added: `name`,
`symbol` and `uri` leave the account (254 B) and move into the mint's metadata; the
four vault pubkeys plus `LaunchMarket.mine` collapse to a single vault (128 B);
`Mine.mint` drops because it is the PDA seed (32 B); `epoch`, `epoch_length`
and `block_interval` narrow to `u32` seconds (12 B);
`discovery_epoch_ends_at` drops because it already equalled `epoch_ends_at` (8 B); the
duplicated `bump`, `graduated` and `version` collapse to one each (3 B). Every
value-bearing field stays: `reward_index` as `u128`, all reserves, all curve state,
both fee counters and the TWAP. Added: `outstanding_claims` (8 B), the TWAP accumulator
and its slot cursor (24 B) that section 4.3 needs, and a discovery epoch cursor (4 B).

**(c) Self-hosted Token-2022 metadata in the mint.** A Token-2022 mint with a metadata pointer
pointing at itself plus the token-metadata extension, name up to 16, symbol up to 8, uri up to
96: 82 base + 1 account type + 68 metadata pointer + 208 token metadata = **359 B =
0.00338952 SOL**, against 0.0014616 for a bare 82-byte mint. So wallet-visible metadata costs
0.00192792 SOL and releases 0.00176784 SOL of invisible strings: net **+0.00016 SOL** for a
feature the product wants anyway. Metaplex would be the expensive route, at about 679 bytes for
the metadata account alone, 0.00707832 SOL with the mint, roughly 0.0037 SOL more.

Two caveats. Wallet and explorer support for Token-2022 metadata must be verified before this is
promised: Solana Explorer, Phantom and Solflare all handle Token-2022, but display of the
metadata extension is uneven, so make it a spike with a documented fallback (a Metaplex account
created lazily by whoever wants it, paid by them). And it cannot use Anchor's `init` with
`mint::decimals`, which always makes an 82-byte mint: this needs a hand-written init of
`system_program::create_account` at the computed size followed by `InitializeMint2`,
`InitializeMetadataPointer` and `InitializeTokenMetadata` in the same instruction, with
the 16/8/96 caps enforced by `validate_launch_args` so rent stays bounded.

### 1.4 Current versus v2

| Item | Today | v2 | Delta |
| --- | --- | --- | --- |
| Per-coin accounts | 7 | 3 | -4 |
| `mint` | 82 B, 0.0014616 | 359 B, 0.00338952 | +0.00192792 |
| Coin state | 741 B, 0.00693912 | 332 B, 0.0032016 | -0.00373752 |
| Token vaults | 660 B in 4 accounts, 0.00815712 | 165 B in 1 account, 0.00203928 | -0.00611784 |
| Transaction fees | ~0.00013 | ~0.00013 | 0 |
| **Total per coin** | **0.01669 SOL** | **0.00876 SOL** | **-48%** |
| **At $150/SOL** | **$2.50** | **$1.31** | |

Without the metadata extension the mint stays at 82 bytes and the total is **0.00683 SOL
($1.02)**. There is a floor worth naming: three accounts carry 128 bytes of account overhead
each, which is 0.00267 SOL before a single byte of state, so a coin cannot be built for free and
sharding into more accounts makes it worse, not better, until more than 128 bytes move out of an
account.

These lamports are spent, not deposited: the coin account and the vault can never be closed
while supply exists. The one realistically closable account is a `MiningPosition` once it
is fully claimed and abandoned, which returns 0.00139896 SOL to the player. Who pays by default
is the creator, at 0.0088 SOL; two optional policy levers sit on top without changing the rent —
the treasury can refund the creator from platform trading fees (now routed on-chain with a fixed
split, section 6), or a transparent launch fee can be charged. Neither is a protocol requirement.

### 1.5 Player-side costs

Trimmed to meet the "about 0.002 SOL or less" target, `PlayerAccount` is 159 bytes:
`owner` drops because it is the PDA seed and every authority check is a `seeds`
constraint (32 B); `grace_until` drops because it is `active_until + graceSeconds`
(8 B); the streak counters narrow to `u16` and `u8` (6 B); the budget window
indexes become `u16`, which is 179 years of days (4 B). `MiningPosition` drops
`owner` and `mine` for the same reason, 105 bytes down to 73. Discovery
receipts stop existing as a separate account altogether: the per-opportunity PDA already has to
exist to make a reroll impossible, and it is closed on settlement, so its rent is transient and
returns to the crank that settles it.

| Action | Rent | Tx fee (1 signature, ~1,000 micro-lamports/CU) | Total |
| --- | --- | --- | --- |
| First `activate` (creates `PlayerAccount`) | 0.00199752 | ~0.000025 | 0.00202 SOL, about $0.30 |
| First `assign_power` for a mine | 0.00139896 | ~0.00003 | 0.00143 SOL |
| `activate` after that | 0 | ~0.000025 | 0.000025 |
| `upgrade_crew` | 0 | ~0.000055 | 0.000055 |
| `switch_mine` | 0 | ~0.00006 | 0.00006 |
| `claim_rewards` | 0 | ~0.000045 | 0.000045 |
| `create_discovery_roll` | 0 | ~0.0002 | 0.0002 |
| `settle_discovery` (crank, closes the opportunity) | refunds 0.00171912 | ~0.0002 | net credit |

The one-time player cost is 0.0034 SOL, about $0.51, and every daily action after that is
0.000025 to 0.00006 SOL. `activate` stays free in the sense the spec demands: no ORE, no
tokens, no payment, only the network fee the player pays for any Solana transaction. Crew
progression remains genuinely closed to real money, because the only way to spend ORE is
`upgrade_crew` and the only way to get ORE is to play.

### 1.6 Discovery randomness: cost, and why it is never pay-to-play

| Option | Requests/day | Protocol SOL/day | Player SOL/roll | Verdict |
| --- | --- | --- | --- | --- |
| Per-account roll, ORAO Classic flat 0.001 SOL, 1,470 active accounts | 1,470 | 1.47 (~$220) | 0 or 0.001 | Rejected: about 12x the ~$24/day of payouts, and charging it to the player is pay-to-play |
| Per-account roll, funded by protocol fees | 1,470 | 1.47 | 0 | The same 12x arithmetic with a different payer |
| **One shared seed per (mine, epoch), Switchboard On-Demand** | 4 | ~0.008 | 0 | **Recommended**: rounds to nothing beside trading fees |
| One shared seed per (mine, epoch), ORAO Classic flat | 4 | 0.004 | 0 | The same shape and simpler to price |
| Slot hash, no VRF network | 0 | 0 | 0 | Rejected: predictable to the block producer producing the slot |

Who funds it: the platform trading fee split (section 6) carries a `vrf_budget`
destination, and the crank tip pays whoever submits the request, so both are fixed on-chain
fractions rather than operator goodwill. The player's only discovery cost is the standard
transaction fee for `create_discovery_roll`, about 0.0002 SOL, which is what every other
action costs too. The reason the request must be batched per epoch per mine rather than per
player is cost: Switchboard's per-round randomness account and address-lookup-table rent is about
0.00195 SOL, so at per-account cadence that rent alone rivals the payout.


## 2. Inventory of off-chain state and decisions

"On-chain" below means a program account plus an instruction that writes it. "Off-chain
advisory" means the Worker may compute it, show it and index it, but no instruction depends
on it for correctness. "Removed" means the mechanism is deleted.

| # | State or decision | Today | v2 location | Rationale |
| --- | --- | --- | --- | --- |
| 1 | Activation window (`active_until`, grace) | D1 `players` | On-chain `PlayerAccount` | Gates block eligibility and ORE accrual; pure value |
| 2 | Streak, longest streak, freezes, valid activations | D1 | On-chain `PlayerAccount` | Drives ORE milestones and discovery eligibility |
| 3 | Active-day count | D1 `active_days` | On-chain `active_days` + `last_active_day` | Discovery eligibility input |
| 4 | ORE balance, lifetime earned and spent | D1 `ore_balance` | `ore_balance: u64` in `PlayerAccount` | ORE is non-transferable game state, never an SPL token; a program account makes it unforgeable and lets `upgrade_crew` be self-contained |
| 5 | ORE accrual rate, capacity, offline hours | `shared/ore.ts` | On-chain, same curves | Accrual settles on-chain, so the curve must be the program's |
| 6 | Crew levels (five components) | D1 columns | On-chain `[u16; 5]` | The only input to power |
| 7 | Crew upgrade price | `upgradeOreCost()` in the Worker | On-chain, same curve | A price the operator computes is a price the operator controls |
| 8 | Mining Power | derived in Worker, pushed by keeper | Derived on-chain from 6 | Deletes `sync_crew_power`, the single largest operator power |
| 9 | Maturity ramp (progression and power) | config ramps vs Worker `now` | On-chain vs `created_slot` and `created_at` | Time as the anti-Sybil resource, unarguable by the operator |
| 10 | Block eligibility | Worker `isEligibleForBlock` | On-chain, same half-open rule | Already mirrored; the mine ledger is on-chain |
| 11 | Discovery roll (whether, which token, rarity, visual, amount) | Worker commit-reveal | On-chain VRF, section 4 | The core RNG discretion |
| 12 | Discovery eligibility (age, active days, crew tier, maturity) | `shared/discovery.ts` | On-chain | Caps the roll before it happens |
| 13 | Discovery caps (account/day, account/week, mine/epoch, global/day, per-call) | D1 aggregates | `PlayerAccount` windows, `Mine` epoch, `GlobalBudget` PDA | Damage bound that must survive a compromised Worker |
| 14 | Rarity table | `DIGGO_CONFIG.rarity.tiers` | `ProtocolConfig` table | Rarity is a value class; keep it auditable and timelocked |
| 15 | Price for value normalisation | `worker/oracle.ts` | Pool TWAP kept by `apply_pool_swap` | Removes the off-chain oracle: the only price the program trusts is its own AMM |
| 16 | Discovery payout (`claim_discovery`) | keeper-signed | `settle_discovery`, permissionless | Idempotent per opportunity PDA, no keeper |
| 17 | Mining reward claim | already user-signed `claim_rewards` | unchanged | Already correct |
| 18 | Risk score, holds, bans | `worker/risk.ts` | Off-chain advisory plus optional bounded attestation, section 5 | Needs device and network signals that cannot be consensus facts |
| 19 | Circuit-breaker pauses | guardian authority | On-chain, timelocked and self-expiring, section 6 | Cannot move value, but still discretion, so bound it in time |
| 20 | Fees: accrual, split, payout | on-chain accrual, authority-signed `claim_platform_fees` | Fixed split to fixed destinations, permissionless sweep | Removes per-call routing discretion |
| 21 | Keeper power sync | `sync_crew_power` | **Removed** | Replaced by on-chain derivation (8) |
| 22 | Keeper | `worker/keeper.ts`, `DIGGO_KEEPER_SECRET_KEY` | **Removed**, replaced by a public crank | Anyone can advance, settle and graduate |
| 23 | Graduation trigger | Worker detects the target | Program-internal; `graduate_market` is already permissionless and its condition is on-chain | Keep the condition, delete the trigger's privileged status |
| 24 | Price oracle (Jupiter, Pyth) | `worker/oracle.ts` | Off-chain advisory and display only | Screen copy and cross-checks; no instruction consumes it |
| 25 | Launch metadata, achievements, cosmetics, notifications, leaderboards | Worker and D1 | Off-chain | Not value-bearing |

## 3. On-chain Player account v2

One PDA per wallet, `seeds = [b"player", owner]`, replacing the current 81-byte
`Player` plus its D1 row. The owner is never stored: it arrives either as the signer or
as the account the `seeds` constraint re-derives the PDA from, so every authority check
is a seed check, and that same pubkey is the VRF derivation input in section 4.2.
`MiningPosition` keeps its own PDA per (owner, mine), so the reward-index math is
untouched.

| Field | Type | Purpose |
| --- | --- | --- |
| `created_slot`, `created_at` | `u64`, `i64` | Maturity anchors |
| `active_until`, `last_activation_at` | `i64` | Activation window; `grace_until` is derived as `active_until + graceSeconds` |
| `streak`, `longest_streak`, `valid_activations`, `active_days`, `last_active_day` | `u16` x5 | Streak and eligibility |
| `streak_freezes` | `u8` | Earned in game only |
| `crew_levels` | `[u16; 5]` | miners, drills, carts, foreman, storage |
| `ore_balance`, `ore_earned`, `ore_spent` | `u64` x3 | Non-transferable, never an SPL token |
| `ore_accrued_at` | `i64` | Lazy accrual cursor |
| `active_mine` | `Pubkey` | Current mine |
| `day_index`, `week_index` | `u16` | Discovery budget windows, 179 years of days |
| `spent_day_lamports`, `spent_week_lamports` | `u64` | Caps, charged at roll creation |
| `roll_window` | `u16` | Last window a roll was created in; a repeat is a no-op, never a reroll |
| `power_attestation` | `{ bps: u16, expires_at: i64 }` | Optional, section 5; can only lower future accrual |
| `bump`, `version` | `u8` | Layout versioning, same discipline as v4 |

159 bytes with the discriminator, which is 0.00199752 SOL of rent (`(159 + 128) x 6960`
lamports), inside the "about 0.002 SOL" budget in section 1.5. Sharding it is not free: every
account carries 128 bytes of overhead, which is 0.00089 SOL, so moving fields into a second PDA
only pays off above roughly 128 bytes moved. Keep it as one account.

Instructions, all signed by the player wallet, none with a paid path:

| Instruction | Effect |
| --- | --- |
| `activate` | Settle accrual, roll the window: `active_until = now + activationSeconds`, `grace_until = active_until + graceSeconds`, apply the streak rule against `last_activation_at`, grant milestone ORE, arm the position. Rate-limited on-chain by `minimumReactivationSeconds`. Free, always |
| `upgrade_crew(component)` | `ore_balance -= cost`, `crew_levels[c] += 1`. Cost and the foreman discount read from the same on-chain curves, so the price cannot be steered |
| `switch_mine(mint)` | Settle the old `MiningPosition` index delta, re-arm on the new mine; never touches activation or streak |
| `collect_ore` | Settle lazily accrued ORE into `ore_balance`, clamped by storage capacity; overflow is reported, never silently kept |
| `claim_rewards` | Unchanged, user-signed |
| `create_discovery_roll` | Section 4 |
| `settle_discovery` | Section 4, permissionless |
| `crank_tip` | Section 6, paid only from accrued fees |

Removed: `sync_crew_power`, and the `power: u64` argument on
`assign_power` (power becomes `crew_power(crew_levels)` computed in-program,
so a caller cannot assert it). The keeper authority, `RotateKeeper` and the
`CrewPowerSynced` event all disappear.

The consequence worth stating plainly: after this a compromised Worker key can do nothing
that moves value. It can lie in its own index and it can refuse to serve the UI, but every
balance and every payout is decided by an instruction nobody needs permission to send.

## 4. Discovery on-chain

### 4.1 Which randomness

Requirement: unpredictable at commit time, verifiable afterwards by anyone, readable by our
program, and cheap enough that the fee does not eat the Discovery Reserve.

| Option | Program ID (devnet / mainnet) | Cost | Read how |
| --- | --- | --- | --- |
| Switchboard On-Demand | `Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2` / `SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv` | no published flat VRF price; the account and LUT round costs about 0.00195 SOL, partly reclaimable | commit and reveal CPI against a randomness account, value read on the reveal |
| ORAO Classic VRF | `VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y` (same ID on devnet and mainnet) | 0.001 SOL per request, flat; 4-20 s typical | CPI to request, then read the fulfilled randomness account |
| ORAO Callback VRF | `VRFCBePmGTpZ234BhbzNNzmyg39Rgdd6VgdfhHwKypU` | same order | fulfillment calls back into our program |

**Recommendation: Switchboard On-Demand, behind a two-method trait.** It is the larger and
more audited oracle network of the two, its pull-based commit-and-reveal model is exactly the
request-then-settle shape this game already has, and both clusters have published program IDs.
Its known wart is the randomness-account and LUT rent per round plus the cleanup discipline
that demands, which is an operational cost rather than a correctness problem. The trait
(`request(seed, payer) -> PendingRandomness`, `read(pending) -> [u8; 32]`)
keeps ORAO Classic VRF a drop-in alternative: it is a flat 0.001 SOL with one program ID on
both clusters, which is simpler to run and easier to price if request volume ever rises.

### 4.2 Request and settle, and why the cost decides the shape

Per-opportunity PDA: `seeds = [b"opportunity", mine, player, window_index]`, so an
opportunity exists at most once and a reroll is impossible by construction rather than by a
guarded SQL update.

| Step | Who | What happens |
| --- | --- | --- |
| `create_discovery_roll` | the player | Checks eligibility and caps, **charges the account's day and week budget immediately**, creates the PDA as pending, requests randomness |
| `settle_discovery` | anyone | Reads the fulfilled randomness, derives rarity and amount, marks the opportunity settled, transfers units from the mine's Discovery Vault, updates the mine's epoch spend |
| expiry | anyone | A pending opportunity past its window can be marked expired, which pays nothing and refunds no budget |

Charging the budget at creation and paying nothing on expiry is what makes the scheme safe
under any assumption about when the seed becomes public, and it is what makes the
optimisation below affordable.

The naive design is one VRF request per player per window. That is unpredictable per account,
the strongest property available, but it does not survive contact with this game's numbers:

| Roll frequency | Requests/day at 1,470 active accounts | VRF cost/day at 0.001 SOL and SOL at $200 | Measured discovery payout/day (sim baseline) |
| --- | --- | --- | --- |
| one per account per day | 1,470 (up to 1.5 SOL) | about $294 | about $24 |
| one per account per week | 210 | about $42 | about $24 |
| one per mine per epoch | 4 | $0.80 | about $24 |

A per-account on-chain VRF therefore costs about **12x the value it hands out**. That is not
a tuning problem but a structural one: the configured common discovery is worth $0.05 and the
vendor fee is $0.20 at these prices. Three ways out, and the design has to pick one
deliberately instead of discovering it in production:

1. **Raise the stakes.** Keep per-account requests and raise the per-call and per-account/day
   caps until the expected payout clears the fee by about 20x. That changes the game, so it
   is a product decision.
2. **Epoch randomness stream (recommended default).** One VRF draw per mine per epoch, and
   each account's outcome derived as
   `draw = H(epoch_seed || mine || player || window_index)`. Cost drops to cents a day.
3. Per-account requests funded from the fee vault, which is the same arithmetic with a
   different payer.

Option 2 has a real weakness and it should be stated rather than hidden: the fulfilled seed
is public, so anyone can pre-compute their own outcome. Charging the budget at roll creation
is what neutralises it. Because a forfeited roll consumes the budget and pays nothing, a
player who pre-computes a bad outcome and walks away is strictly worse off than one who
settles. Selecting *wallets* rather than rolls still lets a farm roll only accounts whose
draws clear a threshold, and that uplift is bounded by the per-account and per-account/week
caps, so it appears as roughly a 2-3x multiplier on farm payouts inside the existing caps
rather than as an unbounded drain. That is the price of trading 12x of cost away, and it
belongs in the same caveat list as the loss of cluster damping in section 5.

### 4.3 Rarity, value and caps on-chain

The rarity table moves into `ProtocolConfig` as a bounded array (max 8 tiers) of
`{ cumulative_chance_bps: u16, value_lamports: u64, min_eligibility_score: u16,
min_liquidity_lamports: u64, min_volume_lamports: u64 }`, seeded from today's
`DIGGO_CONFIG.rarity.tiers` (0.7, 0.9, 0.97, 0.995, 0.9995, 1.0 cumulative, $0.05 to
$20 of value). The eligibility score is computed on-chain from facts the program owns: pool
liquidity and 24h volume from its own pool, remaining Discovery Reserve, and the epoch's
headroom. That is why no external price can promote an illiquid token to Mythic.

Value normalisation uses **the mine's own pool TWAP**, accumulated in `LiquidityPool`
on every `apply_pool_swap` (`cum_price_lamports_per_unit: u128`,
`last_update_slot`, plus a short-window sum for the deviation gate), so the divisor
in the payout is a price the program observed itself:
`amount = value_lamports * PRICE_SCALE / twap`, clamped to the mine's remaining
Discovery Reserve, the mine's per-call bps cap and the epoch budget, all in integer math.

One consequence to decide deliberately: today's caps are in **USD** and the spec asks for
"about $0.50 equivalent per day". On-chain there is no USD. The clean answer is to
**re-denominate the caps in lamports** and keep the dollar figures as UI copy converted at
display time by the off-chain oracle. A governance-set SOL/USD rate on-chain is the
alternative, and it reintroduces exactly the manipulable external input this section exists to
remove. The trade-off is that the caps' real value then floats with SOL.

Caps enforced on-chain: per account per day and per week in `PlayerAccount`; per mine
per epoch already in `Mine` (`discovery_epoch_budget` and
`discovery_epoch_spent`); per call via `discovery_max_bps`; and global per
day in a small `GlobalBudget` PDA keyed by day index.

## 5. Anti-bot: what cannot move, and what replaces it

This is the honest cost of the design. The measured farm defence in
`docs/ECONOMY_SIM.md` is three layers: the account-maturity ramp, cluster damping,
and the cluster share ceiling. Only the first is expressible on-chain. Device fingerprints and
network or ASN clustering are not consensus facts, and no amount of program design makes them
one.

After v2 the on-chain Sybil dampers are:

- **Maturity**, on `created_slot` for power and `created_at` for ORE: day 1
  20%, day 3 40%, day 7 70%, then 100%. A farm's 10,000 wallets still have to age.
- **Streak and valid activations as eligibility**, so discovery stays behind time rather than
  behind a fingerprint.
- **Per-account caps charged at roll creation**, which is what bounds the epoch-stream
  selection uplift above.
- **Time-weighted claim availability**: ORE can only be spent on crew, and crew power only
  affects future blocks, so nothing a bot earns is withdrawable value.

What is lost is cluster damping and the cluster share ceiling, which the sim credits with
taking a 10,000-wallet naive farm from 8.8% to 5.7% of mined tokens. The 10.8%-of-accrual row
is the *gate-off* row, and it already contains both cluster mechanisms, so the true post-v2
on-chain-only bound is **looser than 10.8%** and should be re-measured with `npm run sim`
before any mainnet decision rather than quoted from this document.

The mitigation that keeps the defence without keeping full discretion is to hold
`worker/risk.ts` as an **advisory** layer and add an optional on-chain **power
attestation**: an operator-signed instruction that can only *lower* one account's effective
power, that must carry an expiry of at most 24 hours, that cannot touch ORE, crew levels,
claims or reserves, and that lapses unless extended. That keeps the damping enforceable while
leaving the operator unable to move a single token. It is still operator control, so it should
be reviewed against the same question this document exists to answer, and the design must be
able to ship without it (attestation default 10,000 bps, which is inert).

## 6. Keeper out, crank in

| Today | v2 |
| --- | --- |
| `worker/keeper.ts` signs with `DIGGO_KEEPER_SECRET_KEY` | deleted; no keeper key material anywhere |
| `sync_crew_power` | deleted; power is derived |
| `claim_discovery` (keeper-only) | `settle_discovery`, permissionless, one opportunity PDA |
| `advance_mine` | already permissionless; stays the crank's job |
| `graduate_market` | already permissionless and condition-driven on-chain; the Worker stops being a privileged trigger |
| pause flags | timelocked and self-expiring, below |
| `claim_platform_fees` (authority-signed) | permissionless sweep to fixed destinations |

A **permissionless crank** anyone can run replaces the keeper: `advance_mine` for
mines with an open ledger, `settle_discovery` for pending opportunities, and
`graduate_market` for markets past their target. To make it self-sustaining rather
than charitable, add an optional `crank_tip(payer, max_tip)` that pays at most
`min(max_tip, crank_tip_bps * accrued_fees)` to `payer` from the mine's fee
vault, accrual only, never from a reserve or the LP. That is enough to keep a public crank
running and costs the protocol nothing it was not already paying out as fees. The protocol must
also work with no crank at all: every user-signed instruction opportunistically advances the
mine it touches, exactly as it does today.

**Pause flags.** The guardian can currently flip three pause flags and change power bounds, fee
config and discovery limits. Pauses cannot move, seize or redirect value and trading is
unaffected, so they are the least objectionable of the operator powers, but they are still
discretionary. Change: every pause carries a mandatory `paused_until` no further than
72 hours out; extending a pause past that requires the timelocked governance path; and
`unpause` is permissionless once the expiry passes. Parameter changes (power bounds,
fee config, discovery limits, rarity table, caps) move behind the timelock entirely.
`update_power_bounds` and `max_crew_power` are removed with the sync
instruction, since power is no longer pushed.

**Upgrade authority.** Staged, with the end state named in advance: a Squads v4 multisig
(2-of-3) immediately, with its own 48-hour config-transaction timelock for program upgrades,
then a program freeze (`set_upgrade_authority` to none) after an external audit and
before any mainnet value. The freeze is the point at which the decentralisation argument
becomes strong, so it should be scheduled rather than left as an aspiration.

**Fee routing.** Today an authority signs `claim_platform_fees` and chooses a
destination. In v2 `accrue_fees` splits every trade at accrual time into fixed
on-chain destinations held in `ProtocolConfig` (a treasury PDA, the creator, a
crank-tip pool and the VRF budget of section 1.6), each bps-bounded; the sweep is permissionless
and pays that fixed split.
Changing a destination goes through the timelock. No instruction anywhere takes a destination
argument.

## 7. Solana constraints

- **Program size.** `lib.rs` is 271 KB across 6,004 lines, already past the point where
  a single file is auditable. Phase 0 splits it before any behaviour change. The deployed
  `.so` is 707,728 bytes, so any growth is an `ExtendProgram` at 6,960 lamports per
  byte (section 1.1): the refactor itself should be size-neutral, and the curve tables plus the
  hand-written VRF CPI are budgeted at one 16 KB extend, 0.114 SOL.
- **Account sizes and rent.** All measured, and collected in section 1: `PlayerAccount`
  159 B (0.00199752 SOL), `MiningPosition` 73 B (0.00139896 SOL), the merged `Coin`
  332 B (0.0032016 SOL), `GlobalBudget` about 64 B. Creating a new player's accounts
  cannot be one transaction, because `PlayerAccount` and `MiningPosition` need two
  calls, which is fine since the second is the player's first real action anyway.
- **Compute units.** Estimates to be pinned by measured logs in tests:

| Instruction | Estimated CU | Notes |
| --- | --- | --- |
| `activate` | 15-25k | one account, no CPI, no token movement |
| `upgrade_crew` | 40-70k | settle index delta plus a curve table lookup |
| `create_discovery_roll` | 100-200k | the VRF commit and reveal CPI dominates |
| `settle_discovery` | 150-300k | VRF read, rarity and amount math, token transfer |
| `advance_mine` (64 segments) | 100-250k | existing implementation; measure it |

  The default 200k budget is tight for the two discovery instructions, so a settle has to be
  its own transaction, which the request-then-settle split already gives us. The 1.4M ceiling
  leaves room for a crank to pair a request and a settle in one transaction.
- **Transaction size.** 1,232 bytes legacy. The VRF instructions carry the randomness account
  plus the oracle's own accounts, so the client builders in `shared/program.ts` need
  Address Lookup Tables and versioned transactions. That is a client change, not a program one.
- **No floating point.** `crewPower()` uses `pow(x, 0.62)` and
  `1 + gain * (1 - e^-k)`, and `upgradeOreCost()` uses
  `pow(level, exponent)`. Emulating exponentials in integer math invites drift from the
  values the off-chain code and its tests already publish. Instead ship **precomputed tables as
  program constant data**: 100 `u32` entries for miner power and five sets of 100 for
  upgrade costs, about 2 KB total, zero CU to read, no rounding questions. Pin them with a
  golden-vector test against `shared/crew.ts` so the tables and the TypeScript cannot
  silently diverge, and expose `set_curve_table` behind the timelock for the day a
  balance pass needs new numbers.
- **CPI to VRF.** Switchboard On-Demand needs the randomness account and its oracle accounts in
  the same transaction, with `invoke_signed` for the reveal. It must not sit on the
  request path of anything the player experiences as synchronous: the roll is created, fulfilled
  a few seconds later, and settled by whoever gets there first.
- **Clock.** `Clock::get()?.unix_timestamp` for activation and streak, `slot`
  for maturity. Both are validator-influenced within a narrow window; using slots for maturity
  removes the incentive to nudge the timestamp at all, and the sizes involved make the residual
  immaterial.
- **Migration from v4.** `PlayerAccount` v2 is not layout-compatible with v4
  `Player`, and `migrate_account` is in-place byte surgery rather than a
  translation layer. Recommendation: **fresh program id and a fresh devnet start**, keeping
  `migrate_account` for `Mine`, `LaunchMarket` and
  `ProtocolConfig` only. Any mainnet future launches on v2 from day one, so there is no
  player migration path to write or audit.

## 8. Phased implementation plan

**Phase 0 (blocking, single writer).** Split `programs/diggo-protocol/src/lib.rs` into
`state/{protocol,mine,market,pool,player,discovery}.rs`,
`instructions/{admin,launch,market,mining,crew,discovery,fees,crank}.rs`,
`math/{curve,power,rarity,index}.rs`, plus `errors.rs`, `events.rs` and
`seeds.rs`, leaving `lib.rs` as the `#[program]` shell. Behaviour
identical, no account layout changes, `cargo test` passing verbatim. Nothing else starts
until this lands, because it is the file every other workstream would otherwise touch.

Then seven workstreams with disjoint write scopes, in parallel:

| WS | Scope | Owns exclusively |
| --- | --- | --- |
| 1 | Player account, crew, ORE, power | `state/player.rs`, `instructions/crew.rs`, `math/power.rs`, `shared/{crew,ore,streak}.ts` |
| 2 | Discovery and VRF | `state/discovery.rs`, `instructions/discovery.rs`, `math/rarity.rs`, `shared/{rarity,discovery}.ts`, new `shared/vrf.ts` |
| 3 | Crank, keeper removal, authority, fees | `instructions/{admin,crank}.rs`, `state/protocol.rs`, deletes `worker/keeper.ts` and `worker/breakers.ts` |
| 4 | Client builders | `shared/program.ts` (sole writer), `src/solanaProgram.ts` |
| 5 | Worker becomes indexer-only | `worker/{mining,crew,discovery,player,indexing,chain}.ts`, `migrations/0021_*.sql` |
| 6 | Frontend signing flows | `src/rewardsClaim.ts`, `src/api.ts`, `src/components/{CrewScreen,DashboardPanel,DiscoveriesPanel,MiningReportModal}.tsx` |
| 7 | Tests and golden vectors | `tests/**`, additions to `shared/*.test.ts` |

Three rules make that actually parallel: WS4 is the only writer of
`shared/program.ts`, so everyone else imports it read-only; WS2 and WS3 both need new
`ProtocolConfig` fields, so WS3 owns the struct and WS2 requests fields by name; and WS5
owns the API payload shapes that WS6 consumes, so WS6 must not define its own.

**Tests.** `shared/*.test.ts` gains golden vectors pinning the on-chain curve tables and
the rarity and cap math to the TypeScript. The program gains `tests/` on **litesvm**,
which is fast enough for the property tests below, with a bankrun fallback for cases needing CPI.
The properties that matter are: the budget is never exceeded under concurrent rolls of the same
window; the same (mine, player, window) can never settle twice; a pending opportunity cannot pay
after expiry; `settle_discovery` never moves more than
`remaining_discovery_reserve`; ORE can never be transferred or created outside an allowed
source; power equals `crew_power(levels)` for every reachable level vector; and
`activate` is free and rate-limited on-chain.

**Off-chain code to delete.** `worker/keeper.ts` and its tests;
`shared/commitReveal.ts` and `commitReveal.test.ts`; the price oracle's role as
a correctness input (keep `worker/oracle.ts` for display and cross-checks, remove
`getRobustPrice` from every payout path); `worker/playerLock.ts` and its test,
since D1 stops being a serialisation point once the chain is one; the D1 tables and columns that
mirrored on-chain state (`players.ore_balance`, the crew level columns, the activation
columns, `mining_positions`, the discovery budget aggregates) as WS5 lands; the
`sync_power` and `claim_discovery` `IndexingEvent`s; the keeper
environment variables and their config; the guardian's power-bound and discovery-limit updaters;
and `scripts/onchain/transfer-authorities.ts` in its current single-key form.

## 9. Open questions for the product owner

1. **Caps in SOL or USD?** Re-denominating the discovery caps in lamports makes the whole
   discovery path free of external price input, but the caps' dollar value then floats with SOL.
   Accept that, or keep a governance-set SOL/USD rate? (Recommendation: lamports.)
2. **Roll cadence and VRF cost.** A per-account on-chain VRF costs about 12x the value it pays out
   at current settings; the epoch-stream alternative costs cents but allows a bounded 2-3x
   wallet-selection uplift inside the caps. Which trade do we take, or do we raise the
   per-discovery value until per-account requests become affordable?
3. **Do we accept losing cluster damping on-chain?** Either purely advisory risk with no on-chain
   effect, or the bounded expiring power attestation of section 5, which keeps the damping and
   keeps an operator lever with it. Which fits the decentralisation claim we intend to make?
4. **Fresh devnet program id and a wipe?** v2 player accounts cannot be migrated from v4, so the
   alternative is writing and auditing a one-off translation path.
5. **Freeze the program?** Is the end state a frozen program with no upgrade authority after
   audit, or a permanent 2-of-3 multisig behind a 48-hour timelock? This is the single biggest
   lever on the decentralisation argument and it should be named before mainnet rather than
   decided later.
