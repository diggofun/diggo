# On-chain v2: moving the game's economic authority to Solana

Status: design proposal, not implemented. Supersedes the authority split in
`docs/ARCHITECTURE.md` sections 3-9, 13 and `docs/ONCHAIN.md` section 1. Program today:
`H3Y8GgTnvwv5U1bajfzj386YSPC48vvwjFroXYyHZFj5` (Anchor 1.2.0, `ACCOUNT_VERSION = 4`).
v2 deploys as a **new program id** with `ACCOUNT_VERSION = 5` and a wiped devnet (section 7);
there is no account migration path.

The product owner's final decisions of 2026-09-23 are integrated throughout and the
alternatives they superseded are removed: creator pays 100% by default with on-chain
sponsorship events on top (1.4, 1.7); no per-player VRF, an epoch seed committed to a future
slot's `SlotHashes` entry (4.1); no bond and no starter mode, because every wallet mines at full
efficiency from its first block and posting a bond is refused, with the withdrawal path kept for
lamports parked before the retirement (3.2, 5); discovery caps in SOL priced by our own pool
TWAP (4.3);
Squads 2-of-3 with a timelock, then a program freeze after audit (6); fresh deploy, no
migration (7). Section 9.1 lists them as decisions and section 9.2 lists what is still open.

**Amendment: the bond and the starter penalty are retired.** A later decision of 2026-09-23
removes the last pay-to-play surface. Nothing a player does costs a lamport beyond the rent and
the network fee of the transactions they sign: `post_bond` is refused with `BondRetired` (6097),
`STARTER_EFFICIENCY_BPS` gates nothing, `mining_power(levels, maturity_bps)` takes no bond and no
efficiency factor, every wallet is armed in the full tranche, and discovery eligibility is the
milestone history alone. There is no fee floor either: no instruction charges a minimum fee, and
the only protocol fee anywhere is the trade split, a bps share of a gross trade that is capped,
rounds down and can be zero on a small trade. `request_unbond` and `withdraw_bond` stay live with
the seven-day cooldown still enforced, so lamports parked before the retirement still come back.
Sections 1.5, 3.2, 5, 8.2, 8.5 and 9 carry the corrected text; where an older paragraph
disagrees with this amendment, this amendment wins.

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

## 1. Cost model

This section is a hard product constraint and the rest of the design bends to it: **one
program serves every coin and the owner pays for it once; creating a coin costs about one cent
of SOL and the creator pays it by default; and the user's ongoing cost is transaction fees
only, never a charge per roll.** Sponsorship events (1.7) can move the creator's launch cost
onto a sponsor vault, and nobody else posts a deposit: a player pays only the network fee of the
transactions they sign and the rent of the accounts they create (1.5, 3.2).

### 1.1 One-time program cost, and no per-coin deploys

Every coin is a set of PDAs under one program. `Anchor.toml` declares exactly one program per
cluster, `launch_token` deploys and upgrades nothing, and there is exactly one
`declare_id!` in the tree. Adding a coin is data, not code. The owner pays the program cost
once; the v4 program `H3Y8GgTnvwv5U1bajfzj386YSPC48vvwjFroXYyHZFj5` is retired at the v2
cutover (section 7) and nothing is deployed per coin, ever.

| Item | Size | Rent (lamports) | SOL |
| --- | --- | --- | --- |
| Program account (executable stub) | 36 B | 1,141,440 | 0.00114144 |
| ProgramData account | 45 + 707,728 B | 4,926,990,960 | 4.92699096 |
| Deploy transactions (~708 buffer writes plus the final deploy) | | ~3,500,000 | ~0.0035 |
| **One-time total** | | | **~4.93 SOL = $740 at $150/SOL** |

Growth is the only thing that costs more later. ProgramData is exactly the `.so` length
plus 45 bytes, so any growth is an `ExtendProgram` at **6,960 lamports per byte**, capped at
10,240 bytes added per instruction and 10 MB total. v2 grows the program with the curve
tables, the sponsor and epoch-seed logic and the discovery math, so budget **at most one
16 KB extend in two calls: 0.114 SOL**, and treat binary size as a real design requirement:

- read the `SlotHashes` sysvar directly instead of linking a randomness vendor SDK or CPI-ing
  into one (section 4.1): no external program, no oracle accounts, no vendor code in the
  binary;
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
bytes of account space become 384.

| | Today (`Mine` + `LaunchMarket`) | v2 (`Coin`) | Bytes |
| --- | --- | --- | --- |
| Fields | 606 + 119 = 725 | 376 | -349 |
| Discriminators | 8 + 8 = 16 | 8 | -8 |
| **Account space** | **741** | **384** | **-357** |
| Billable space (data, plus 128 B per account) | 997 | 512 | -485 |
| Rent | 0.00693912 SOL | 0.00356352 SOL | -0.0033756 SOL |

Where the bytes go, and it does add up to 437 removed and 88 added: `name`,
`symbol` and `uri` leave the account (254 B) and move into the mint's metadata; the
four vault pubkeys plus `LaunchMarket.mine` collapse to a single vault (128 B);
`Mine.mint` drops because it is the PDA seed (32 B); `epoch`, `epoch_length`
and `block_interval` narrow to `u32` seconds (12 B);
`discovery_epoch_ends_at` drops because it already equalled `epoch_ends_at` (8 B); the
duplicated `bump`, `graduated` and `version` collapse to one each (3 B). Every
value-bearing field stays: `reward_index` as `u128`, all reserves, all curve state,
both fee counters and the TWAP. Added: `outstanding_claims` (8 B), the TWAP accumulator
and its slot cursor (24 B) that section 4.3 needs, a discovery epoch cursor (4 B), and the
epoch-seed block (52 B: `epoch_seed [u8; 32]`, `epoch_seed_epoch u32`,
`epoch_seed_target_slot u64`, `epoch_seed_recorded_slot u64`) that section 4.1 needs.
Sponsorship adds **no** field to `Coin`: which event a coin launched under is recorded in
the `SponsorGrant` PDA (1.7), so a coin that never sees a sponsor pays nothing for the
mechanism.

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
| Coin state | 741 B, 0.00693912 | 384 B, 0.00356352 | -0.0033756 |
| Token vaults | 660 B in 4 accounts, 0.00815712 | 165 B in 1 account, 0.00203928 | -0.00611784 |
| Transaction fees | ~0.00013 | ~0.00013 | 0 |
| **Total per coin** | **0.01669 SOL** | **0.00912 SOL** | **-45%** |
| **At $150/SOL** | **$2.50** | **$1.37** | |
| **At $200/SOL** | **$3.34** | **$1.82** | |

Without the metadata extension the mint stays at 82 bytes and the total is **0.00719 SOL
($1.08)**. There is a floor worth naming: three accounts carry 128 bytes of account overhead
each, which is 0.00267 SOL before a single byte of state, so a coin cannot be built for free and
sharding into more accounts makes it worse, not better, until more than 128 bytes move out of an
account.

**Who pays: the creator, 100%, by default.** 0.00912 SOL is charged to the account that calls
`launch_token`, once, in the launch transaction. Three optional levers sit on top and none of
them is a protocol requirement:

- **Sponsorship events (1.7)** pay the mint, `Coin` and vault rent at launch from a
  `SponsorVault`, within the event's per-coin limit. The creator then pays only the
  transaction fee.
- **Platform fee waiver events (1.7)** pay the platform share of trading fees from the same
  vault for the event's duration, so the trader pays the creator's share only and the treasury
  is kept whole from the vault.
- **A treasury refund out of accrued platform fees** is discretionary policy, not a protocol
  guarantee, and no instruction depends on it.

These lamports are spent, not deposited: the coin account and the vault can never be closed
while supply exists. The one realistically closable account is a `MiningPosition` once it
is fully claimed and abandoned, which returns 0.00139896 SOL to the player. No player-side
lamport is a deposit either, now that the bond is retired (3.2): the `PlayerAccount` rent and
the transaction fee are the whole of it (1.5).

### 1.5 Player-side costs

A player's cost is **the network fee of the transactions they sign, plus rent**, and nothing
else. There is no bond, no deposit, no subscription and no fee floor: no instruction charges a
minimum fee to play, mine, roll or claim. The only protocol fee in the system is the trade split
of section 6, a bps share of a gross trade that is capped at `MAX_TRADING_FEE_BPS` (100 = 1% over
both shares), rounds down, and can therefore be zero on a small trade.

`PlayerAccount` is 216 bytes: 159 for the game state and 57 for the bond block
(`bond_lamports u64`, `bond_locked_at i64`, `unbond_available_at i64`,
`bond_source u8`, `bond_sponsor_vault Pubkey`, plus the padding that keeps the struct
8-byte aligned). That block is **legacy layout and nothing more** since the retirement in 3.2:
nothing writes it except the withdrawal path of a bond posted before the change, a wallet that
never posted one reads zeros, and no tranche, power, eligibility or maturity rule consults it. It
is allocated at its full size on the first `activate`, so the layout never reallocs, and the
lamports an old bond parked sit in the PDA's balance above its rent-exempt minimum, so they need
no account of their own.

The rest of the trimming is unchanged: `owner` drops because it is the PDA seed and every
authority check is a `seeds` constraint (32 B); `grace_until` drops because it is
`active_until + graceSeconds` (8 B); the streak counters narrow to `u16` and `u8`
(6 B); the budget window indexes become `u16`, which is 179 years of days (4 B).
`MiningPosition` drops `owner` and `mine` for the same reason, 105 bytes down to 73.
Discovery receipts stop existing as a separate account altogether: the per-opportunity PDA
already has to exist to make a reroll impossible, and it is closed on settlement, so its rent
is transient and returns to the crank that settles it.

| Action | Rent | Tx fee (1 signature, ~1,000 micro-lamports/CU) | Total |
| --- | --- | --- | --- |
| First `activate` (creates `PlayerAccount`, 216 B) | 0.00239424 | ~0.000025 | 0.00242 SOL, about $0.36 |
| First `assign_power` for a coin (creates `MiningPosition`, 73 B) | 0.00139896 | ~0.00003 | 0.00143 SOL |
| `post_bond` (retired) | 0 | ~0.00002 | refused with `BondRetired`; nothing moves |
| `request_unbond` / `withdraw_bond` (a bond posted before the retirement) | 0 | ~0.00002 | refunds what the PDA balance holds, after the cooldown |
| `activate` after that | 0 | ~0.000025 | 0.000025 |
| `upgrade_crew` | 0 | ~0.000055 | 0.000055 |
| `switch_mine` | 0 | ~0.00006 | 0.00006 |
| `claim_rewards` | 0 | ~0.000045 | 0.000045 |
| `create_discovery_roll` | 0 | ~0.00004 | 0.00004 |
| `settle_discovery` (anyone; closes the opportunity PDA) | refunds 0.00169824 | ~0.00005 | net credit |

The one-time player cost is 0.00242 SOL, all of it the `PlayerAccount` rent plus the network fee
of the transaction that creates it, and every daily action after that is 0.000025 to 0.00006
SOL. `activate` stays free in the sense the spec demands: no ORE, no tokens, no payment, only
the network fee the player pays for any Solana transaction. Crew progression remains closed to
real money, because the only way to spend ORE is `upgrade_crew` and the only way to get ORE is to
play. A wallet that posts nothing mines at full efficiency from its first block (3.2), and the
only lamports it can ever take back are the rent of an account it closes.

### 1.6 Discovery randomness: cost, and why it is never pay-to-play

| Option | Vendor cost/day | Requests/day | Player SOL/roll | Verdict |
| --- | --- | --- | --- | --- |
| Per-account VRF, ORAO Classic flat 0.001 SOL, 1,470 active accounts | 1.47 SOL (~$220) | 1,470 | 0 or 0.001 | Rejected: about 12x the ~$24/day of payouts, and charging it to the player is pay-to-play |
| Per-account VRF funded by protocol fees | 1.47 SOL | 1,470 | 0 | The same 12x arithmetic with a different payer |
| Per-account Switchboard On-Demand (randomness account plus LUT rent) | ~1.95 SOL | 1,470 | 0 | Rejected on the same arithmetic, plus cleanup discipline |
| **One seed per (coin, epoch) committed to a future slot's `SlotHashes` entry** | **0** | one per coin per epoch | 0 | **Chosen** (4.1): no vendor, no oracle account, no per-roll cost |
| One seed per (coin, epoch) from a vendor VRF | ~0.008 SOL | 4 | 0 | Kept only as the documented future upgrade path (4.1) |

The per-account request is rejected on arithmetic that no tuning fixes: the configured common
discovery is worth about $0.05 and a vendor fee is $0.20 at these prices, so per-account
randomness costs about 12x the value it hands out, and charging it to the player is
pay-to-play. The epoch seed costs one `commit_epoch_seed` transaction per coin per epoch,
about 0.00002 SOL, paid by whoever cranks it and reimbursed from the crank-tip pool (6). It
needs no rent at all, because the seed lives in fields of the `Coin` account that already
exist. The player's only discovery cost is the standard transaction fee for
`create_discovery_roll`, about 0.00004 SOL, which is what every other action costs too.

### 1.7 Sponsorship and events

Sponsorship is the only mechanism that moves cost off the creator, and it is deliberately
narrow: **a sponsorship event can pay rent and fees, and it can never change power, rewards,
discovery odds, rarity, caps or eligibility.** Phase 1 asserts this with a test (8.3, WS-G):
the same coin launched with and without an active event produces identical power and identical
discovery outcomes for the same seed.

| Account | Seeds | Holds | Rent, and who pays |
| --- | --- | --- | --- |
| `SponsorVault` | `[b"sponsor-vault", sponsor_owner]` | `sponsor_owner`, `event_count u32`, `total_funded u64`, `total_spent u64`, `total_withdrawn u64`, `bump u8`, `version u8` (70 B) | 0.00137736 SOL, the sponsor owner, once |
| `SponsorEvent` | `[b"sponsor-event", sponsor_vault, event_id u32]` | `vault`, `kind u8`, `start_at i64`, `end_at i64`, `budget_lamports u64`, `spent_lamports u64`, `per_coin_limit_lamports u64`, `per_wallet_limit_lamports u64`, `paused u8`, `bump u8`, `version u8` (92 B) | 0.0015312 SOL, the sponsor vault |
| `SponsorGrant` | `[b"sponsor-grant", sponsor_event, coin]` | `spent_lamports u64`, `waived_fee_lamports u64`, `created_slot u64`, `bump u8`, `version u8` (42 B) | 0.0011832 SOL, the sponsor vault, only on the sponsored path |

Event kinds: `LaunchRentSubsidy` pays the mint, `Coin` and vault rent at
`launch_token`; `PlatformTradeFeeWaiver` pays the platform share of the trading fee at
accrual, so the trader pays the creator's share only and the treasury is kept whole from the
vault; `PlayerAccountSubsidy` pays a player's `PlayerAccount` rent at
`initialize_player`. `PlayerBondSubsidy` is retired with the bond (3.2): the kind byte may still
be decoded from an event created before the retirement, and no instruction accepts one.

Rules, all enforced on-chain:

- The vault holds lamports only, in the PDA balance. It must stay above its own rent-exempt
  minimum at all times, and a withdrawal can never take more than
  `total_funded - total_spent`.
- An event is active only between `start_at` and `end_at`, only while
  `spent_lamports + amount <= budget_lamports`, and only while it is not paused.
- Every spend is checked against the event's per-coin and per-wallet limits **before** it
  happens and recorded in the `SponsorGrant` for that coin. A grant is created at most once
  per (event, coin), so re-launching cannot reset the per-coin limit.
- Withdrawal belongs to the sponsor owner alone, is capped at the unspent balance, and requires
  the event to have ended or to be closed with `close_sponsor_event`. Unspent lamports are
  never the protocol's.
- No event may post or fund a bond: `PlayerBondSubsidy` is retired and no instruction accepts it
  (3.2). Lamports an old sponsor-funded bond left in a PDA balance still return to the vault the
  player recorded, through the same `withdraw_bond` path.
- Sponsorship is not governance. The sponsor vault belongs to the owner's own wallet, it is not
  part of the Squads configuration, and it can never be a program upgrade or config authority.
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
| 11 | Discovery outcome (whether, which token, rarity, amount) | Worker commit-reveal with `DISCOVERY_SECRET` | On-chain, derived from the epoch seed (4.1) | The core RNG discretion, gone: the seed is a recorded fact, not a choice |
| 12 | Discovery eligibility (age, active days, crew total level, maturity) | `shared/discovery.ts` | On-chain | Caps the roll before it happens; the bond is out of the rule |
| 13 | Discovery caps (account/day, account/week, coin/epoch, global/day, per-call) | D1 aggregates in USD | `PlayerAccount` windows, `Coin` epoch counters, `GlobalBudget` PDA, all denominated in lamports | Damage bound that must survive a compromised Worker, priced by our own pool TWAP (4.3) |
| 14 | Rarity table | `DIGGO_CONFIG.rarity.tiers` | `ProtocolConfig` table | Rarity is a value class; keep it auditable and timelocked |
| 15 | Price for value normalisation | `worker/oracle.ts` (Jupiter, Pyth) | Pool TWAP kept by `apply_pool_swap` | Removes the off-chain oracle: the only price the program trusts is its own AMM |
| 16 | Discovery payout (`claim_discovery`) | keeper-signed | `settle_discovery`, permissionless | Idempotent per opportunity PDA, no keeper |
| 17 | Mining reward claim | already user-signed `claim_rewards` | unchanged | Already correct |
| 18 | Risk score, holds, bans | `worker/risk.ts` | Off-chain advisory only, with no on-chain effect | Needs device and network signals that cannot be consensus facts; maturity, the milestone gates and the caps are what the chain can hold instead (5) |
| 19 | Circuit-breaker pauses | guardian authority | Timelocked, self-expiring and narrow (6) | Cannot move value, but is still discretion, so bound it in time and put it behind governance |
| 20 | Fees: accrual, split, payout | on-chain accrual, authority-signed `claim_platform_fees` | Fixed split to fixed destinations, permissionless sweep; a fee-waiver event can pay the platform share from a sponsor vault | Removes per-call routing discretion |
| 21 | Keeper power sync | `sync_crew_power` | **Removed** | Replaced by on-chain derivation (8) |
| 22 | Keeper | `worker/keeper.ts`, `DIGGO_KEEPER_SECRET_KEY` | **Removed**, replaced by a public crank | Anyone can advance, seed, settle and graduate |
| 23 | Graduation trigger | Worker detects the target | Program-internal; `graduate_market` is already permissionless and its condition is on-chain | Keep the condition, delete the trigger's privileged status |
| 24 | Price oracle (Jupiter, Pyth) | `worker/oracle.ts` | Off-chain advisory and display only | Screen copy and cross-checks; no instruction consumes it |
| 25 | Launch metadata, achievements, cosmetics, notifications, leaderboards | Worker and D1 | Off-chain | Not value-bearing |
| 26 | **Who pays for a launch** | the creator, with no alternative | `SponsorVault` + `SponsorEvent` + `SponsorGrant` on-chain (1.7) | The only way to move launch cost off the creator: bounded per coin and per wallet, and unable to touch the game |
| 27 | **Anti-bot economic commitment** | none | **None**: the refundable bond and starter mode were tried and retired (3.2, 5) | The deposit gated honest players as hard as it gated farms, so what remains is maturity, eligibility and the caps |

## 3. On-chain Player account v2

One PDA per wallet, `seeds = [b"player", owner]`, replacing the current 81-byte
`Player` plus its D1 row. The owner is never stored: it arrives either as the signer or
as the account the `seeds` constraint re-derives the PDA from, so every authority check
is a seed check, and that same pubkey is the epoch-seed derivation input in section 4.2.
`MiningPosition` keeps its own PDA per (owner, coin), so the reward-index math is
untouched.

### 3.1 Layout

| Field | Type | Purpose |
| --- | --- | --- |
| `created_slot`, `created_at` | `u64`, `i64` | Maturity anchors, fixed at PDA creation and never reset |
| `active_until`, `last_activation_at` | `i64` | Activation window; `grace_until` is derived as `active_until + graceSeconds` |
| `streak`, `longest_streak`, `valid_activations`, `active_days`, `last_active_day` | `u16` x5 | Streak and eligibility |
| `streak_freezes` | `u8` | Earned in game only |
| `crew_levels` | `[u16; 5]` | miners, drills, carts, foreman, storage |
| `ore_balance`, `ore_earned`, `ore_spent` | `u64` x3 | Non-transferable, never an SPL token |
| `ore_accrued_at` | `i64` | Lazy accrual cursor |
| `active_mine` | `Pubkey` | Current coin |
| `day_index`, `week_index` | `u16` | Discovery budget windows, 179 years of days |
| `spent_day_lamports`, `spent_week_lamports` | `u64` | Caps, charged at roll creation |
| `roll_window` | `u16` | Last window a roll was created in; a repeat is a no-op, never a reroll |
| `bond_lamports` | `u64` | Legacy: lamports a pre-retirement bond left in this PDA's balance above its rent-exempt minimum (3.2) |
| `bond_locked_at` | `i64` | Legacy: when that bond was posted; never a maturity input |
| `unbond_available_at` | `i64` | Cooldown end set by `request_unbond`, which is live for a legacy bond |
| `bond_source` | `u8` | Legacy: 0 = the player's own lamports, 1 = a sponsor vault. It only decides where the lamports go on exit |
| `bond_sponsor_vault` | `Pubkey` | Legacy: the vault a sponsor-funded bond returns to; zero when self-funded |
| `bump`, `version` | `u8` | Layout versioning, same discipline as v4 |

216 bytes with the discriminator, which is 0.00239424 SOL of rent
(`(216 + 128) x 6960` lamports). Sharding it is not free: every account carries 128 bytes
of overhead, which is 0.00089 SOL, so moving fields into a second PDA only pays off above
roughly 128 bytes moved. Keep it as one account, allocated at full size on the first
`activate`.

### 3.2 The bond and the starter penalty are retired

The anti-bot layer used to be an economic commitment: a flat, refundable bond that bought full
efficiency and discovery eligibility. It is gone. No new bond may be posted, no sponsor may fund
one, and nothing a wallet holds or pays changes what it earns. The decision is that there is no
pay-to-play: a wallet plays with the ordinary rent and network SOL it already needs, and there is
no starter penalty either, because there is no longer a tier to belong to.

| Rule | Value |
| --- | --- |
| Posting a bond | `post_bond` refuses with `BondRetired` (6097). Its account list is unchanged, so an old client gets a named program error rather than a deserialization failure |
| Mining power | `mining_power(levels, maturity_bps)`: crew levels and maturity, nothing else. There is no bond argument and no efficiency factor, and `STARTER_EFFICIENCY_BPS` gates nothing |
| Tranche | `PlayerAccount::tranche()` is the full tranche for every wallet, so a live coin's starter tranche stays empty. `STARTER_TRANCHE_BPS` (1,000 = 10%) still bounds only a position armed *before* the retirement, which keeps the tranche it was armed with until it is removed |
| Discovery eligibility | The milestone history alone: account age, active days, valid activations, crew total level and maturity. The bond is out of the rule in `math/rarity.rs` |
| Maturity | Still measured from the `PlayerAccount` PDA creation slot, and never from anything a player deposits or holds. Nothing a wallet posts or withdraws resets, accelerates or delays it |
| Legacy withdrawal | `request_unbond` sets `unbond_available_at = now + bond_cooldown_seconds` (604,800 s = 7 days), then `withdraw_bond` returns the lamports parked before the retirement. It requires no active `MiningPosition` (unassign first), pays the player, or the sponsor vault when `bond_source = 1`, and there is no partial withdrawal |
| Cost to a player | The `PlayerAccount` rent and the network fee of the transactions they sign (1.5). No deposit, no hold, no minimum fee and no fee floor |

The point of keeping the withdrawal path is narrow and worth stating exactly: the lamports a
player parked before the retirement are theirs, they sit in the PDA's own balance above its
rent-exempt minimum, and `withdraw_bond` returns them in one piece. That is also why the
seven-day cooldown is still enforced: it is the only thing standing between a bond posted before
the retirement and its withdrawal.

What is left of the anti-bot layer is time, eligibility and the caps (5). The honest reading is
that a farm's per-wallet cost drops back to the rent of the accounts it creates, and the
re-measurement in 5 is what prices that.

### 3.3 Instructions

All signed by the player wallet, none with a paid path:

| Instruction | Effect |
| --- | --- |
| `initialize_player` | Creates the 216-byte `PlayerAccount` PDA, `payer = owner`. Optional `PlayerAccountSubsidy` event pays the rent |
| `activate` | Settle accrual, roll the window: `active_until = now + activationSeconds`, apply the streak rule against `last_activation_at`, grant milestone ORE, arm the position. Rate-limited on-chain by `minimumReactivationSeconds`. Free, always |
| `collect_ore` | Settle lazily accrued ORE into `ore_balance`, clamped by storage capacity; overflow is reported, never silently kept |
| `upgrade_crew(component)` | `ore_balance -= cost`, `crew_levels[c] += 1`. Cost and the foreman discount read from the same on-chain curves, so the price cannot be steered |
| `assign_power(coin)` | Creates the `MiningPosition` PDA. The v4 `power: u64` argument is gone: power is `crew_power(crew_levels, maturity)` computed in-program, so a caller cannot assert it |
| `remove_power(coin)` | Settles the index delta and clears the position; required before `request_unbond` |
| `switch_mine(coin)` | Settle the old `MiningPosition` index delta, re-arm on the new coin; never touches activation or streak |
| `claim_rewards(coin)` | Unchanged, user-signed |
| `post_bond` | Retired: refuses with `BondRetired` (6097), with its account list unchanged so an old client gets a named error. Nothing may post or fund a bond (3.2) |
| `request_unbond` | Legacy bond only: requires no active position and sets `unbond_available_at` (3.2) |
| `withdraw_bond` | Legacy bond only, after the cooldown: pays the player, or the sponsor vault when `bond_source = 1`. No partial withdrawal |
| `create_discovery_roll` | Section 4 |
| `settle_discovery` | Section 4, permissionless |
| `expire_opportunity` | Section 4, permissionless |
| `crank_tip` | Section 6, paid only from accrued fees |

Removed: `sync_crew_power`, the `power` argument on `assign_power`, the keeper
authority, `RotateKeeper`, the `CrewPowerSynced` event, and the operator
`power_attestation` field: the risk score stays off-chain advisory only (5).

The consequence worth stating plainly: after this a compromised Worker key can do nothing
that moves value. It can lie in its own index and it can refuse to serve the UI, but every
balance and every payout is decided by an instruction nobody needs permission to send.

## 4. Discovery on-chain

### 4.1 Which randomness

Requirement: unpredictable when participation locks, verifiable afterwards by anyone, readable
by our program without a vendor, and cheap enough that the fee does not eat the Discovery
Reserve.

**Chosen: one seed per (coin, epoch), committed to a future slot's `SlotHashes` entry.**
There is no per-player randomness anywhere in the design.

| Step | What happens |
| --- | --- |
| 1. Commit, at epoch start | When `advance_mine` rolls the coin into a new epoch, the coin records `epoch_seed_target_slot = epoch_ends_slot + epoch_seed_delay_slots` (default 32 slots of delay). The slot is in the future by roughly one epoch, so nobody can know its hash yet. This is the commit |
| 2. Participation locks | Activation, power, position assignment and every eligibility and cap check for that epoch happen during the epoch, **before** the seed exists. A roll is created, its budget is charged, and the opportunity PDA is written, all while the seed is unknown |
| 3. Reveal | After `target_slot` has passed, any wallet sends `commit_epoch_seed(coin)`. The instruction reads the `SlotHashes` sysvar, takes the entry at exactly `target_slot`, and stores it as `epoch_seed` together with `epoch_seed_recorded_slot` and `epoch_seed_epoch`. Permissionless, one transaction per coin per epoch |
| 4. Derive | Every outcome of that epoch is `sha256(epoch_seed \|\| owner \|\| window_index)`, expanded in order into: does the discovery occur, which rarity tier, and the amount. No secret, no signature, no operator input |
| 5. Settle | `settle_discovery` recomputes the same hash and pays. Anyone can recompute any past outcome from the recorded seed, which is why the seed is written to an account and echoed in an event |

The `SlotHashes` sysvar keeps only the last 512 slot hashes, so the reveal must land within 512
slots (about 3.4 minutes at 400 ms) of `target_slot`. The documented fallback: if
`target_slot` is no longer in the sysvar when the crank runs, the crank uses the **oldest slot
hash still recorded**, and the program stores that slot number in
`epoch_seed_recorded_slot` so the derivation stays publicly recomputable and the fallback is
visible. If the crank is later than `epoch_seed_max_lateness_slots` (default 512) past
`target_slot`, the seed is not set at all: the instruction re-arms
`target_slot = current_slot + epoch_seed_delay_slots` and emits `EpochSeedRearmed`. That
keeps the seed coming from a slot whose hash was unknown while the epoch's rolls were locked,
at the cost of delaying settlement by one delay window. Settlement is impossible without a
seed, so a missed reveal delays payouts; it never makes them predictable, and it never pays
twice.

**Warning, for whoever implements or extends this: never derive a payout from public predictable
inputs alone.** Creator addresses, epoch or window indexes, timestamps, block heights and the
coin's own state are all known in advance and can be ground by anyone. Only the
`SlotHashes` entry of a slot that has not been produced yet qualifies, which is exactly why
the commit happens a full epoch ahead of the reveal.

Two residuals, stated rather than hidden. First, a cranker who is deliberately late shifts
which recorded slot is used, by at most `epoch_seed_max_lateness_slots`; the earliest honest
crank wins the tip, and after the lateness bound the seed re-arms instead, so the choice set is
bounded and cannot be extended indefinitely. Second, the revealed seed is public before
settlement, so a wallet can pre-compute its own outcome; charging the budget at roll creation
(4.2) is what neutralises that. Both belong in the Phase 2 review list (8.5).

**Documented upgrade path.** If a future audit wants vendor randomness, the shape does not
change: one draw per (coin, epoch) instead of the slot-hash read, behind the same
`epoch_seed` field, so `settle_discovery`, the caps and every client derivation stay
identical. The rejected alternatives are per-player VRF (about 12x the value it hands out,
section 1.6) and deriving from the current slot's hash, which the producer of that slot can
grind.

### 4.2 Request and settle

Per-opportunity PDA: `seeds = [b"opportunity", coin, owner, window_index]`, so an
opportunity exists at most once and a reroll is impossible by construction rather than by a
guarded SQL update.

**Which window index, exactly (CCR-F1).** The seed uses `player.roll_window` **as it stands before
the handler runs**: the accounts struct derives the PDA from that field, the body copies it into
`opportunity.window_index`, and the increment happens last. A wallet's pending opportunity is
therefore always the window one below its current `roll_window`, `roll_window == 0` means it has
never rolled, and a client needs no probe. Frozen in CONTRACTS.md.

| Step | Who | What happens |
| --- | --- | --- |
| `create_discovery_roll` | the player | Checks eligibility (milestones and maturity, 3.2) and caps, **charges the account's day and week budget immediately**, creates the PDA as pending against the current epoch. No randomness is requested here |
| `settle_discovery` | anyone | Requires `epoch_seed_epoch` to cover the opportunity's epoch. Derives occur, rarity and amount from the seed, marks the opportunity settled, transfers units from the coin's vault against the discovery ledger, updates the coin's epoch spend, and closes the PDA, refunding its rent to the caller |
| `expire_opportunity` | anyone | A pending opportunity past its window can be marked expired, which pays nothing and refunds no budget |

Charging the budget at creation and paying nothing on expiry is what makes the scheme safe
under any assumption about when the seed becomes public, and it is what makes the
epoch-seed optimisation affordable: a wallet that pre-computes a bad outcome and walks away is
strictly worse off than one that settles. Selecting *wallets* rather than rolls still lets a
farm settle only the accounts whose derived outcome clears a threshold, and that uplift is
bounded by the per-account and per-account/week caps, so it appears as roughly a 2-3x
multiplier on farm payouts inside the existing caps rather than as an unbounded drain. That is
the price of trading 12x of cost away, and it belongs in the same caveat list as the loss of
cluster damping in section 5.

### 4.3 Rarity, value and caps on-chain

The rarity table moves into `ProtocolConfig` as a bounded array (max 8 tiers) of
`{ cumulative_chance_bps: u16, value_lamports: u64, min_eligibility_score: u16,
min_liquidity_lamports: u64, min_volume_lamports: u64 }`, seeded from today's
`DIGGO_CONFIG.rarity.tiers` (0.7, 0.9, 0.97, 0.995, 0.9995, 1.0 cumulative, $0.05 to
$20 of value, converted once to lamports). The eligibility score is computed on-chain from
facts the program owns: pool liquidity and 24h volume from its own pool, remaining Discovery
Reserve, and the epoch's headroom. That is why no external price can promote an illiquid token
to Mythic.

Value normalisation uses **the coin's own pool TWAP**, accumulated in `LiquidityPool`
on every `apply_pool_swap` (`cum_price_lamports_per_unit: u128`,
`last_update_slot`, plus a short-window sum for the deviation gate), so the divisor
in the payout is a price the program observed itself:
`amount = value_lamports * PRICE_SCALE / twap`, clamped to the coin's remaining
Discovery Reserve, the coin's per-call bps cap and the epoch budget, all in integer math. No
external oracle is consulted anywhere in this path, and none is consulted for caps either.

**Caps are denominated in SOL (lamports), not USD.** Today's caps are in USD and the spec asks
for "about $0.50 equivalent per day"; on-chain there is no USD, so the caps are stored in
lamports and the dollar figures stay UI copy converted at display time by the off-chain oracle.
The rejected alternative, a governance-set SOL/USD rate on-chain, reintroduces exactly the
manipulable external input this section exists to remove. The accepted trade-off is that the
caps' real value floats with the price of SOL.

Caps enforced on-chain: per account per day and per week in `PlayerAccount`; per coin
per epoch in `Coin` (`discovery_epoch_budget` and `discovery_epoch_spent`);
per call via `discovery_max_bps`; and global per day in a small `GlobalBudget` PDA
keyed by day index, created by the first roll of the day and closed by a crank once the day
passes.
## 5. Anti-bot: what cannot move, and what replaces it

This is the honest cost of the design. The measured farm defence in
`docs/ECONOMY_SIM.md` is three layers: the account-maturity ramp, cluster damping,
and the cluster share ceiling. Only the first is expressible on-chain. Device fingerprints and
network or ASN clustering are not consensus facts, and no amount of program design makes them
one.

After v2 the on-chain Sybil dampers are:

- **Maturity**, on `created_slot` for power and `created_at` for ORE, on the schedule of
  `MATURITY_RAMP`: 20% under a day, 40% at 1-2 days, 70% at 3-6 days, 100% from day 7. The rungs
  are read as `days < up_to_day` (CCR-F1's neighbour in CONTRACTS.md), so the prose here names the
  rungs and the table there is what a client reproduces. A farm's 10,000 wallets still have to age.
- **No capital cost at all (3.2)**: the refundable bond and the starter penalty are retired, so a
  wallet's floor is the `PlayerAccount` rent and the network fee of what it signs. Every wallet
  mines at full efficiency from its first block, and discovery stays behind the milestone
  history, so there is no tier to buy into, no deposit to park and no fee floor to clear.
- **Streak and valid activations as eligibility**, so discovery stays behind time rather than
  behind a fingerprint.
- **Per-account caps charged at roll creation**, which is what bounds the epoch-seed selection
  uplift in 4.2.
- **Time-weighted claim availability**: ORE can only be spent on crew, and crew power only
  affects future blocks, so nothing a bot earns is withdrawable value.

Why not the obvious alternatives: an instantaneous balance check is cyclable, so one funded
wallet would satisfy it for ten thousand wallets in a single slot; an off-chain wallet-age or
proof-of-humanity attestation is an operator key deciding who may earn, which is the exact thing
this design exists to remove; and the third option, a locked refundable bond, was built and then
retired (3.2), because a deposit gated an honest player as hard as it gated a farm.

What is lost is cluster damping and the cluster share ceiling, which the sim credits with
taking a 10,000-wallet naive farm from 8.8% to 5.7% of mined tokens. The 10.8%-of-accrual row
is the *gate-off* row, and it already contains both cluster mechanisms, so the true post-v2
on-chain-only bound is **looser than 10.8%** and should be re-measured with `npm run sim`
before any mainnet decision rather than quoted from this document. The model must carry no bond
input at all now that it is retired (3.2), which is what WS-G (8.3) re-measures.

`worker/risk.ts` stays as an **advisory** layer with no on-chain effect: it can flag, rate
limit HTTP surfaces, gate off-chain rewards and inform support. It cannot lower a player's
on-chain power, freeze a position, or touch ORE, crew levels, claims or reserves. There is no
power-attestation instruction and no operator-signed input anywhere in a payout path, which is
the property this design was written to buy.

## 6. Keeper out, crank in

| Today | v2 |
| --- | --- |
| `worker/keeper.ts` signs with `DIGGO_KEEPER_SECRET_KEY` | deleted; no keeper key material anywhere |
| `sync_crew_power` | deleted; power is derived |
| `claim_discovery` (keeper-only) | `settle_discovery`, permissionless, one opportunity PDA |
| randomness request and fulfilment | `commit_epoch_seed`, permissionless, one transaction per coin per epoch |
| `advance_mine` | already permissionless; stays the crank's job and also arms the next epoch's seed target |
| `graduate_market` | already permissionless and condition-driven on-chain; the Worker stops being a privileged trigger |
| pause flags | timelocked and self-expiring, below |
| `claim_platform_fees` (authority-signed) | permissionless sweep to fixed destinations |

A **permissionless crank** anyone can run replaces the keeper: `advance_mine` for coins with
an open ledger, `commit_epoch_seed` for coins whose target slot has passed,
`settle_discovery` for pending opportunities, `graduate_market` for markets past their
target, and `sweep_fees`. To make it self-sustaining rather than charitable, add an optional
`crank_tip(payer, max_tip)` that pays at most
`min(max_tip, crank_tip_bps * accrued_fees)` to `payer` from the coin's fee vault,
accrual only, never from a reserve or the LP. That is enough to keep a public crank running and
costs the protocol nothing it was not already paying out as fees. The protocol must also work
with no crank at all: every user-signed instruction opportunistically advances the coin it
touches, exactly as it does today.

**Fee routing.** Today an authority signs `claim_platform_fees` and chooses a destination.
In v2 `accrue_fees` splits every trade at accrual time into fixed on-chain destinations held
in `ProtocolConfig` (a treasury PDA, the creator, and a crank-tip pool), each bps-bounded;
the sweep is permissionless and pays that fixed split. There is no randomness budget line,
because the epoch seed has no vendor to pay (1.6). Changing a destination goes through the
timelock. No instruction anywhere takes a destination argument. When a coin was launched under
an active `PlatformTradeFeeWaiver` event, the platform share is paid from the sponsor vault
to the treasury PDA instead of by the trader, within the event's limits (1.7): the split itself
never changes, only who funds it.

**The order of operations, pinned (CCR-F2).** A trade pays exactly two fees, both taken off the
gross at accrual: the creator's share and the protocol's share, each `mul_bps(gross, bps)` and each
rounded down, with the remainder going to the curve or the pool. The crank-pool share is **not** a
third fee: `ProtocolConfig.crank_pool_fee_bps` is carved out of the protocol's own bucket at sweep
time by `split_platform_bucket`, and a crank tip comes from the same bucket. That is why `Coin`
carries two fee fields and two claimable buckets and no third one, and why a quote that charges the
crank-pool share to the trader is wrong in the trader's disfavour.

**Pause flags and config.** Every pause carries a mandatory `paused_until` no further than
72 hours out; extending a pause past that requires the timelocked governance path; and
`unpause` is permissionless once the expiry passes. Parameter changes (fee config, discovery
limits, rarity table, caps, curve tables) move behind the timelock entirely.
`update_power_bounds` and `max_crew_power` are removed with the sync instruction, since
power is no longer pushed. There is no guardian with discretionary control over user funds:
the narrow, documented, timelocked controls above are the whole of it.

**Governance.** A Squads v4 multisig, **2-of-3**, holds the program upgrade authority and every
remaining admin config, with a 48-hour timelock on its transactions, from day one of v2. After
an external audit, and before any mainnet value, the end state is a **frozen program**:
`set_upgrade_authority` to none, which removes the upgrade path and with it the last
operator-shaped lever over the game. The sponsor vault is not part of this: it belongs to the
owner's own wallet, it holds lamports, and it has no program authority of any kind.

## 7. Solana constraints

- **Program size.** `lib.rs` is 271 KB across 6,004 lines, already past the point where
  a single file is auditable. Phase 0 splits it before any behaviour change. The deployed
  `.so` is 707,728 bytes, so any growth is an `ExtendProgram` at 6,960 lamports per
  byte (section 1.1): the refactor itself should be size-neutral, and the curve tables, the
  sponsor and epoch-seed logic and the discovery math are budgeted at **at most one
  16 KB extend, 0.114 SOL**. Nothing vendor-shaped is linked: no VRF SDK, no CPI into a
  randomness program, no oracle program.
- **Account sizes and rent.** All measured, and collected in sections 1, 3 and 1.7:

| Account | Size | Rent | Paid by |
| --- | --- | --- | --- |
| `PlayerAccount` | 216 B | 0.00239424 SOL | the player, once (or a `PlayerAccountSubsidy` event) |
| `MiningPosition` | 73 B | 0.00139896 SOL | the player, once per coin; refunded when fully claimed and abandoned |
| `Coin` | 384 B | 0.00356352 SOL | the creator at launch (or a `LaunchRentSubsidy` event) |
| coin vault | 165 B | 0.00203928 SOL | the creator at launch (or a `LaunchRentSubsidy` event) |
| `mint` (Token-2022, with metadata) | 359 B | 0.00338952 SOL | the creator at launch (or a `LaunchRentSubsidy` event) |
| `LiquidityPool` + vaults | 161 + 165 + 41 B | 0.005227 SOL | whoever calls `graduate_market`, unchanged |
| `DiscoveryOpportunity` | 116 B | 0.00169824 SOL | transient: created by the player, refunded to whoever settles |
| `GlobalBudget` | 64 B | 0.00133632 SOL | first roll of the day; refunded to whoever closes it |
| `SponsorVault` | 70 B | 0.00137736 SOL | the sponsor owner |
| `SponsorEvent` | 92 B | 0.0015312 SOL | the sponsor vault |
| `SponsorGrant` | 42 B | 0.0011832 SOL | the sponsor vault, only on the sponsored path |

No bond appears in this table, because nothing a player does parks capital any more: the
`PlayerAccount` rent above is the whole of it, and lamports a pre-retirement bond left in a PDA
balance still come back through `withdraw_bond` (3.2).

  Creating a new player's accounts cannot be one transaction, because `PlayerAccount` and
  `MiningPosition` need two calls, which is fine since the second is the player's first real
  action anyway.
- **Compute units.** Estimates to be pinned by measured logs in tests:

| Instruction | Estimated CU | Notes |
| --- | --- | --- |
| `initialize_player` | 20-30k | one account creation |
| `activate` | 15-25k | one account, no CPI, no token movement |
| `collect_ore` | 10-20k | curve lookup and a clamp |
| `upgrade_crew` | 40-70k | settle index delta plus a curve table lookup |
| `request_unbond` / `withdraw_bond` (a bond posted before the retirement) | 10-20k | lamport moves inside one PDA; `post_bond` is retired and does nothing |
| `assign_power` / `remove_power` / `switch_mine` | 25-45k | index delta and maturity |
| `claim_rewards` | 30-50k | unchanged |
| `advance_mine` (64 segments) | 100-250k | existing implementation; measure it |
| `commit_epoch_seed` | 15-30k | one `SlotHashes` read plus one sha256 |
| `create_discovery_roll` | 30-60k | eligibility and caps; **no CPI at all now** |
| `settle_discovery` | 60-120k | three sha256 derivations, rarity and amount math, one token transfer |
| `launch_token` (with Token-2022 metadata) | 150-250k | hand-written mint init, three token extensions, three account creations |
| `buy` / `sell` | 60-120k | existing curve math plus fee split |

  The default 200k budget is comfortable for every discovery instruction now that no vendor CPI
  sits on the path, and the 1.4M ceiling leaves room for a crank to pair
  `commit_epoch_seed` with a batch of settles in one transaction.
- **Transaction size.** 1,232 bytes legacy. Removing the randomness accounts shrinks the
  discovery transactions, but `launch_token` carries the mint, its three extensions, the coin
  account, the vault, the metadata and, on the sponsored path, the vault, event and grant, so
  the client builders in `shared/program.ts` still need Address Lookup Tables and versioned
  transactions. That is a client change, not a program one.
- **The `SlotHashes` sysvar.** `commit_epoch_seed` must take it as
  `Sysvar<'info, SlotHashes>` so Anchor checks the address and the owner; never as a raw
  `UncheckedAccount`. It holds the last 512 slot hashes, which is the window the reveal must
  land in, and the read is a plain binary search over the sysvar's entries.
- **No floating point.** `crewPower()` uses `pow(x, 0.62)` and
  `1 + gain * (1 - e^-k)`, and `upgradeOreCost()` uses
  `pow(level, exponent)`. Emulating exponentials in integer math invites drift from the
  values the off-chain code and its tests already publish. Instead ship **precomputed tables as
  program constant data**: 100 `u32` entries for miner power and five sets of 100 for
  upgrade costs, about 2 KB total, zero CU to read, no rounding questions. Pin them with a
  golden-vector test against `shared/crew.ts` so the tables and the TypeScript cannot
  silently diverge, and expose `set_curve_table` behind the timelock for the day a
  balance pass needs new numbers.
- **Clock.** `Clock::get()?.unix_timestamp` for activation and streak, `slot`
  for maturity and for the epoch-seed target. Both are validator-influenced within a narrow
  window; using slots for maturity removes the incentive to nudge the timestamp at all, and the
  sizes involved make the residual immaterial.
- **Fresh start, no migration.** v2 is a **new program id** with a **wiped devnet**: no coins
  exist, so no v2 account needs a migration path, and `migrate_account` plus its layout
  surgery are deleted rather than extended. `ACCOUNT_VERSION` starts at 5 for the new
  accounts and `version` stays as the discipline for any future layout change. Any mainnet
  future launches on v2 from day one. The v4 program is retired with its devnet state.
## 8. Implementation plan for parallel sub-agents

Three rules make the workstreams below genuinely parallel. First, **the spine is frozen in
Phase 0**: `lib.rs`, `errors.rs`, `events.rs`, `constants.rs`, `seeds.rs`, every
`mod.rs`, and the account structs listed in 8.2 are read-only for every Phase 1 worker, and
a worker that needs a contract change asks the integrator instead of editing them. Second,
**every file has exactly one writer**, so two workstreams never touch the same path. Third,
**interfaces are fixed before work starts**, in 8.2, so a worker can build against a signature
that does not exist yet and be right.

### 8.1 Phase 0 - the spine, in two steps, one worker each, blocking

**Phase 0a - mechanical split, zero behaviour change.** One worker, one commit, nothing runs
concurrently. `programs/diggo-protocol/src/lib.rs` (6,004 lines) becomes:

| New file | Contents |
| --- | --- |
| `src/lib.rs` | `declare_id!`, module declarations, the `#[program]` shell only |
| `src/state/mod.rs` | module list and re-exports |
| `src/state/protocol.rs` | `ProtocolConfig` |
| `src/state/coin.rs` | v4 `Mine` and `LaunchMarket` (still separate at this step) |
| `src/state/pool.rs` | `LiquidityPool` and the pool vaults' layout |
| `src/state/player.rs` | `Player`, `MiningPosition` |
| `src/state/epoch.rs` | discovery receipt and budget structs |
| `src/state/sponsor.rs` | created empty; filled in 0b |
| `src/instructions/mod.rs` | module list |
| `src/instructions/admin.rs` | `initialize_protocol`, authority and pause handlers |
| `src/instructions/launch.rs` | `launch_token` and its validation |
| `src/instructions/trade.rs` | `buy`, `sell`, `pool_buy`, `pool_sell`, `graduate_market` |
| `src/instructions/mining.rs` | `advance_mine`, `claim_rewards` |
| `src/instructions/crew.rs` | `initialize_player`, `assign_power`, `remove_power`, `sync_crew_power` |
| `src/instructions/discovery.rs` | `claim_discovery` and the v4 commit-reveal path |
| `src/instructions/fees.rs` | `accrue_fees`, `claim_creator_fees`, `claim_platform_fees` |
| `src/instructions/crank.rs` | v4 permissionless advance and graduation entry points |
| `src/math/curve.rs`, `src/math/power.rs`, `src/math/index.rs`, `src/math/rarity.rs`, `src/math/fees.rs` | pure functions, moved verbatim |
| `src/errors.rs`, `src/events.rs`, `src/constants.rs`, `src/seeds.rs` | v4 error enum, events, consts and seed helpers, moved verbatim |

Gate: `cargo test --workspace` green with the same test names, `.so` within 2% of 707,728
bytes, no account layout change, no new instruction, and `git diff --stat` touching only
`programs/diggo-protocol/src/`.

**Phase 0b - contract freeze, one worker.** Lands the whole v2 surface as compiling skeletons:
the frozen account structs of 8.2, the full `#[program]` block with every v2 instruction, its
`#[derive(Accounts)]` struct in the owning file, and a body that returns
`err!(DiggoError::NotImplemented)`. The v4 instructions stay present and functional, so the
tree compiles and the suite stays green for the whole of Phase 1; deleting the v4-only surface
(keeper, `sync_crew_power`, guardian pause setters, `migrate_account`, the four-vault launch
path) is a single integration step performed by one worker after A, B and C have landed.

Gate: `cargo build-sbf` and `npm run typecheck` green, the v4 tests still pass,
`target/idl/diggo_protocol.json` contains every v2 instruction name, and no v2 body does
anything except return `DiggoError::NotImplemented`.

Phase 0b also renames the 0a files into the v2 ownership boundaries, so that each Phase 1
workstream owns whole files: `instructions/crew.rs` splits into
`player_activate.rs`, `player_ore.rs`, `player_crew.rs`, `player_mine.rs` and
`player_bond.rs`; `instructions/mining.rs` splits into `mining_advance.rs` and the
claim path; `instructions/discovery.rs` keeps the discovery name; and `math/power.rs`
absorbs the crew and ORE curves, gaining `math/ore.rs`.

### 8.2 Contracts, frozen before Phase 1 starts

**PDA seeds.** Every seed list below is final; changing one is a contract amendment, not a
worker decision.

| Account | Seeds | Owner file |
| --- | --- | --- |
| `ProtocolConfig` | `[b"protocol"]` | `state/protocol.rs` |
| treasury PDA | `[b"treasury"]` | `state/protocol.rs` |
| crank-tip pool | `[b"crank-pool"]` | `state/protocol.rs` |
| `Coin` | `[b"coin", mint]` | `state/coin.rs` |
| coin vault (token account) | `[b"vault", mint]` | `state/coin.rs` |
| `LiquidityPool` | `[b"pool", mint]` | `state/pool.rs` |
| pool token vault | `[b"pool-vault", mint]` | `state/pool.rs` |
| pool SOL vault | `[b"pool-sol", mint]` | `state/pool.rs` |
| `PlayerAccount` | `[b"player", owner]` | `state/player.rs` |
| `MiningPosition` | `[b"position", coin, owner]` | `state/player.rs` |
| `DiscoveryOpportunity` | `[b"opportunity", coin, owner, window_index u16 le]` | `state/epoch.rs` |
| `GlobalBudget` | `[b"global-budget", day_index u16 le]` | `state/epoch.rs` |
| `SponsorVault` | `[b"sponsor-vault", sponsor_owner]` | `state/sponsor.rs` |
| `SponsorEvent` | `[b"sponsor-event", sponsor_vault, event_id u32 le]` | `state/sponsor.rs` |
| `SponsorGrant` | `[b"sponsor-grant", sponsor_event, coin]` | `state/sponsor.rs` |
| `mint` | `[b"mint", creator, nonce u8]` | `instructions/launch.rs` |

**Accounts.** Sizes and field lists are fixed by sections 1.3(b), 1.7 and 3.1:
`Coin` 384 B, `PlayerAccount` 216 B, `MiningPosition` 73 B, `SponsorVault` 70 B,
`SponsorEvent` 92 B, `SponsorGrant` 42 B, `DiscoveryOpportunity` 116 B,
`GlobalBudget` 64 B, `ProtocolConfig` (rarity table of at most 8 tiers, fee split bps,
caps in lamports, curve tables behind the timelock). The epoch-seed fields of `Coin`
(`epoch_seed`, `epoch_seed_epoch`, `epoch_seed_target_slot`,
`epoch_seed_recorded_slot`) are written by WS-B's file and read by WS-C: they are frozen
here and must not move.

**Instruction surface.** Name, arguments, who signs, and the file that owns the handler.

| Instruction | Arguments | Signer | Owning file |
| --- | --- | --- | --- |
| `initialize_protocol` | `config` | upgrade authority | `instructions/admin.rs` |
| `update_fee_config` / `update_discovery_limits` / `set_rarity_table` / `set_curve_table` | values | governance, timelocked | `instructions/admin.rs` |
| `schedule_pause` / `unpause` | `flag`, `paused_until` | governance / permissionless | `instructions/admin.rs` |
| `launch_token` | `args`, optional sponsor accounts | creator | `instructions/launch.rs` |
| `buy` / `sell` | `amount_in`, `min_out` | trader | `instructions/trade.rs` |
| `pool_buy` / `pool_sell` | `amount_in`, `min_out` | trader | `instructions/trade.rs` |
| `graduate_market` | none | permissionless | `instructions/trade.rs` |
| `sweep_fees` | none | permissionless | `instructions/fees.rs` |
| `claim_creator_fees` | none | creator | `instructions/fees.rs` |
| `crank_tip` | `max_tip` | permissionless | `instructions/fees.rs` |
| `init_sponsor_vault` / `fund_sponsor_vault` / `withdraw_sponsor_vault` | `amount` | sponsor owner | `instructions/sponsor.rs` |
| `create_sponsor_event` / `close_sponsor_event` | `kind`, `start_at`, `end_at`, `budget_lamports`, `per_coin_limit_lamports`, `per_wallet_limit_lamports` | sponsor owner | `instructions/sponsor.rs` |
| `initialize_player` | optional `PlayerAccountSubsidy` accounts | owner | `instructions/player_activate.rs` |
| `activate` | none | owner | `instructions/player_activate.rs` |
| `collect_ore` | none | owner | `instructions/player_ore.rs` |
| `upgrade_crew` | `component: u8` | owner | `instructions/player_crew.rs` |
| `assign_power` / `remove_power` / `switch_mine` | none (coin is an account) | owner | `instructions/player_mine.rs` |
| `claim_rewards` | none | owner | `instructions/player_mine.rs` |
| `post_bond` (retired: `BondRetired`) / `request_unbond` / `withdraw_bond` (a pre-retirement bond) | optional `PlayerBondSubsidy` accounts | owner | `instructions/player_bond.rs` |
| `advance_mine` | none | permissionless | `instructions/mining_advance.rs` |
| `commit_epoch_seed` | none (`SlotHashes` sysvar) | permissionless | `instructions/mining_seed.rs` |
| `create_discovery_roll` | none | owner | `instructions/discovery.rs` |
| `settle_discovery` / `expire_opportunity` | none | permissionless | `instructions/discovery.rs` |

**Error codes.** One `#[error_code] pub enum DiggoError` in `errors.rs`, declared in
full by Phase 0b, in this order, so no Phase 1 worker ever edits the file. v4's existing
variants keep codes 6000-6039; the v2 variants are appended in the reserved blocks below and
each workstream refers to them by name only: 6040-6099 protocol, admin and config
(`NotImplemented`, `InvalidPauseWindow`, `NotTimelocked`, `ConfigOutOfBounds`,
`InvalidRarityTable`, `InvalidCurveTable`); 6100-6149 player, activation, ORE and crew
(`NotActivated`, `AccrualOverflow`, `CrewAtMaxLevel`, `InsufficientOre`,
`StorageCapacityExceeded`, `ReactivationTooSoon`); 6150-6199 bond (`BondAlreadyPosted`,
`NoBondPosted`, `PositionStillActive`, `BondCooldownActive`,
`SponsorBondNotWithdrawable`, `VaultBelowRentExempt`); 6200-6249 coin, launch, curve and
pool (`LedgerInvariantViolated`, `MetadataTooLong`, `InvalidMintLayout`,
`CurveExhausted`, `PoolNotInitialised`, `TwapUnavailable`); 6250-6299 fees
(`FeeSplitOverflow`, `CrankTipExceedsAccrual`, `NotCoinCreator`); 6300-6349 sponsor
(`EventNotActive`, `EventBudgetExhausted`, `PerCoinLimitExceeded`,
`PerWalletLimitExceeded`, `EventAlreadyClosed`, `UnspentWithdrawalOnly`,
`InvalidEventKind`); 6350-6399 mining, epoch and seed (`EpochNotRolled`,
`SeedTargetInFuture`, `SeedTargetNotInSysvar`, `SeedAlreadyCommitted`,
`SeedNotCommitted`, `CoinNotAdvanced`); 6400-6449 discovery
(`RollAlreadyExists`, `NotDiscoveryEligible`, `OpportunityExpired`,
`OpportunityAlreadySettled`, `DailyCapExceeded`, `WeeklyCapExceeded`,
`GlobalCapExceeded`, `EpochBudgetExhausted`). `BondRetired` (6097) is appended after every
block above, so the retirement moved no existing code.

**Events.** Declared in full in `events.rs` by Phase 0b; Phase 1 only emits them.
`ProtocolInitialized`, `CoinLaunched{coin, mint, creator, sponsor_event}`,
`EpochAdvanced{coin, epoch_index, epoch_ends_at, epoch_ends_slot}`,
`EpochSeedTargetArmed{coin, epoch_index, target_slot}`,
`EpochSeedCommitted{coin, epoch_index, target_slot, recorded_slot, seed}`,
`EpochSeedRearmed{coin, epoch_index, target_slot}`, `PlayerInitialized`,
`Activated`, `OreCollected`, `CrewUpgraded`, `BondPosted` (declared, unreachable),
`UnbondRequested`,
`BondWithdrawn`, `PowerAssigned`, `PowerRemoved`, `MineSwitched`,
`RewardsClaimed`, `DiscoveryRollCreated{opportunity, coin, owner, window_index, day_index}`,
`DiscoverySettled{opportunity, coin, owner, rarity, units, value_lamports}`,
`DiscoveryExpired`, `MarketGraduated`, `FeesSwept`, `CrankTipPaid`,
`SponsorVaultInitialized`, `SponsorEventCreated`, `SponsorSpend{grant, kind, lamports}`.

**Constants** (`constants.rs`, Phase 0b):
`EPOCH_SEED_DELAY_SLOTS = 32`, `EPOCH_SEED_MAX_LATENESS_SLOTS = 512`,
`SLOT_HASHES_WINDOW = 512`, `CRANK_TIP_BPS = 200`, `MAX_PAUSE_SECONDS = 259_200`,
`MAX_RARITY_TIERS = 8`, `MAX_NAME_LEN = 16`, `MAX_SYMBOL_LEN = 8`,
`MAX_URI_LEN = 96`, plus the default fee split and cap values in lamports. All of them are
`ProtocolConfig` fields, not hard-coded behaviour, except the layout bounds.

Four bond-era constants survive, and only for the reasons above: `BOND_LAMPORTS = 70_000_000` and
`STARTER_EFFICIENCY_BPS = 2_500` are retired values, kept because the frozen `PlayerAccount` and
`ProtocolConfig` layouts and the parity vectors still carry the fields; `BOND_COOLDOWN_SECONDS =
604_800` is still enforced, because it is the only thing between a bond posted before the
retirement and its withdrawal; and `STARTER_TRANCHE_BPS = 1_000` still bounds a position armed
before the retirement (3.2). `DEFAULT_SPONSOR_PER_WALLET_LIMIT_LAMPORTS` is still one retired
bond's worth, a form default for a wallet-subject subsidy and nothing more.

### 8.3 Phase 1 workstreams, disjoint file ownership

| WS | Scope | Writes exclusively | Reads only |
| --- | --- | --- | --- |
| **A** | Player, ORE, crew, activation, bond | `programs/diggo-protocol/src/state/player.rs`, `src/instructions/player_activate.rs`, `player_ore.rs`, `player_crew.rs`, `player_mine.rs`, `player_bond.rs`, `src/math/power.rs`, `src/math/ore.rs`, `shared/crew.ts`, `shared/ore.ts`, `shared/streak.ts` and their `.test.ts` | `state/coin.rs`, `shared/program.ts`, the spine |
| **B** | `Coin`, launch, curve and pool, fees, sponsor, admin | `src/state/coin.rs`, `src/state/pool.rs`, `src/instructions/launch.rs`, `trade.rs`, `fees.rs`, `sponsor.rs`, `admin.rs`, `src/math/curve.rs`, `src/math/fees.rs`, `shared/curve.ts`, `shared/config.ts`, `shared/economics.ts` and their `.test.ts` | `state/player.rs`, `shared/program.ts`, the spine |
| **C** | Mining index, blocks, claims, epoch seed, discovery | `src/state/epoch.rs`, `src/instructions/mining_advance.rs`, `mining_seed.rs`, `discovery.rs`, `src/math/index.rs`, `src/math/rarity.rs`, `shared/rewardIndex.ts`, `shared/rarity.ts`, `shared/discovery.ts`, `shared/epochSeed.ts` (new) and their `.test.ts` | `state/coin.rs` (epoch-seed fields frozen), `state/player.rs`, `shared/program.ts`, the spine |
| **D** | Client: builders, decoders, PDAs, IDL | `shared/program.ts` (sole writer), `shared/program.test.ts`, `shared/pdas.ts` (new), `shared/types.ts`, `target/idl/diggo_protocol.json` | everything else |
| **E** | Worker becomes indexer-only | deletes `worker/keeper.ts`, `worker/playerLock.ts`, `worker/breakers.ts`, `shared/commitReveal.ts` and their tests; modifies `worker/index.ts`, `chain.ts`, `mining.ts`, `discovery.ts`, `indexing.ts`, `crew.ts`, `player.ts`, `tokens.ts`, `market.ts`, `oracle.ts`, `risk.ts`, `reconcile.ts`, `admin.ts`, `env.ts`, `wrangler.jsonc` (keeper secrets out), adds `migrations/0021_indexer_only.sql` | `shared/*` read-only, the IDL |
| **F** | Frontend signing flows | `src/solanaProgram.ts`, `src/rewardsClaim.ts`, `src/api.ts`, `src/constants.ts`, `src/components/{CrewScreen,DashboardPanel,DiscoveriesPanel,MiningReportModal,LaunchModal,SwapPanel,MineInfoPanel,AdminScreen}.tsx` | `shared/program.ts`, the worker API payloads |
| **G** | Tests, parity and the sim | `programs/diggo-protocol/tests/**` (new), `tests/onchain/**` (new), `shared/parity/*.test.ts` (new), `scripts/sim/{engine,model,world,state,curve,market,report,rng,selfcheck}.ts`, `scripts/sim/run.mjs` | everything else, read-only |

The interfaces between them, in addition to 8.2:

1. `shared/program.ts` has exactly one writer, WS-D. Everyone else imports it read-only,
   including WS-G's tests.
2. `shared/config.ts` has exactly one writer, WS-B; WS-A and WS-C read named getters that
   WS-B adds for them rather than editing the file.
3. WS-E owns the API payload shapes that WS-F consumes. WS-F must not define its own.
4. WS-B owns `state/coin.rs` and therefore the epoch-seed fields WS-C depends on; they are
   frozen in 8.2 so WS-C can compile against them from the first commit.
5. Deleting the v4 surface is one integration step by a single worker after A, B and C land:
   `lib.rs` (the v4 instruction lines), `instructions/{crew,discovery,fees,crank}.rs`
   (the v4 handlers), `state/coin.rs` (the `Mine`/`LaunchMarket` split) and
   `errors.rs` (nothing: codes stay).
6. WS-G writes the sponsor-invariance test that the 1.7 promise depends on: same coin, same
   seed, with and without an active event, identical power and identical discovery outcome.
### 8.4 Shared TypeScript that must mirror on-chain math

These pure functions exist twice, once in Rust for the chain and once in TypeScript for the
client and the sim. They must agree bit for bit, including rounding direction, so WS-G pins
them with golden vectors generated **from the Rust side** (the chain is authoritative) and
committed under `tests/vectors/`:

| TypeScript | Rust | What must match exactly |
| --- | --- | --- |
| `shared/crew.ts` | `math/power.rs` | `crew_power(levels)` after the maturity ramp and the foreman discount, and every `upgrade_ore_cost(component, level)` for levels 1-100 |
| `shared/ore.ts` | `math/ore.rs` | accrual per second, the storage-capacity clamp, offline-hour handling |
| `shared/curve.ts` | `math/curve.rs` | `quote_buy` and `quote_sell` including the integer rounding direction and the fee order of operations |
| `shared/rewardIndex.ts` | `math/index.rs` | the cumulative index update and the position delta |
| `shared/rarity.ts` | `math/rarity.rs` | tier selection from the derived roll, the amount clamp, the eligibility score |
| `shared/discovery.ts` | `instructions/discovery.rs` | eligibility, the per-day, per-week, per-epoch and global caps in lamports, budget charging at roll creation |
| `shared/epochSeed.ts` (new) | `instructions/mining_seed.rs` and the derivation | `sha256(epoch_seed \|\| owner \|\| window_index)` and its expansion into occur, rarity and amount, byte for byte |

The parity test runs one way: Rust generates the vectors, TypeScript asserts them. When a value
differs, the Rust value wins and the TypeScript is the bug, because the chain is what pays.

### 8.5 Phase 2 - security review focus list

1. The vault ledger invariant of 1.3(a) on every instruction that touches the vault, and
   `outstanding_claims` being neither double-counted nor omitted.
2. Rounding direction in the curve quotes, the fee split and the reward index: every path
   rounds in the protocol's favour, never the caller's.
3. Legacy bond accounting: the lamports sit above the PDA's rent-exempt minimum; `post_bond`
   refuses with `BondRetired`; no path lets a player withdraw a sponsor-funded bond;
   `request_unbond` cannot be cycled to reset the cooldown; `withdraw_bond` leaves the account
   rent-exempt. That path is the only reason the bond fields stay in the layout.
4. Sponsor vault and events: withdrawal capped at unspent, per-coin and per-wallet limits
   enforced before the spend, `SponsorGrant` uniqueness per (event, coin), event expiry,
   and the invariance test that sponsorship changes no power and no discovery outcome.
5. Epoch seed: `SlotHashes` passed as `Sysvar<SlotHashes>` and never as an unchecked
   account; the target slot is in the future when armed; the fallback and the re-arm path are
   deterministic; no settlement without a seed; a seed can never be used for another epoch or
   another coin; cross-epoch replay.
6. The opportunity PDA: at most one per (coin, owner, window), no double settle, expiry pays
   nothing, the budget is charged exactly once.
7. Caps: integer math in all four scopes, no bypass by rotating wallets or switching coins, and
   the `GlobalBudget` close and reopen path.
8. Power derivation: `crew_power(levels, maturity)` is monotonic in levels, there is no bond and
   no efficiency factor left to read, and no instruction accepts a caller-supplied power.
9. Maturity: `created_slot` is fixed at PDA creation, is not reset by unbond or rebond, and
   cannot be inherited from another account.
10. Fees: the bps split sums within 10000, no instruction takes a destination, a waiver can
    never exceed the event budget, and `crank_tip` pays only from accrued fees.
11. Pauses: `paused_until` is bounded to 72 hours, `unpause` is permissionless after it, and
    no pause can block a bond withdrawal or a reward claim.
12. Upgrade and config authority: Squads 2-of-3 with the timelock, no other key can upgrade or
    change config, and the freeze path is tested on devnet before it is needed.
13. The hand-written Token-2022 mint init: exact sizes, extension order, no realloc path, mint
    and freeze authorities revoked after launch.
14. Account validation everywhere: seeds and bumps re-derived, `has_one` on every parent
    reference, and no `UncheckedAccount` anywhere in a payout path.
15. Griefing: can a crank be blocked, can a coin be pushed into a re-arm loop, can a sponsor
    drain the treasury by opening and closing events, can a player grief the global budget.

### 8.6 Phase 3 - fresh devnet deploy, initialize, multisig

1. `scripts/onchain/deploy-v2.ts` - build with the release profile of 1.1, deploy with a new
   program keypair, write the new program id into `Anchor.toml`, `wrangler.jsonc` and
   `shared/config.ts`, and verify the deployed hash against the local `.so`.
2. `scripts/onchain/wipe-devnet.ts` - retire the v4 program on devnet and close its buffers.
   Devnet holds no coins, so nothing of value is discarded.
3. `scripts/onchain/init-v2.ts` - `initialize_protocol` with the rarity table, the fee
   split, the caps in lamports, the curve tables, the sponsor defaults and the epoch-seed
   delays, then hand the protocol authority to the multisig.
4. `scripts/onchain/squads-setup.ts` - create the 2-of-3 Squads v4 multisig, set the 48-hour
   transaction timelock, transfer the program upgrade authority and the protocol authority to
   it, and print the verification steps a reviewer can repeat by hand.
5. `scripts/onchain/freeze-program.ts` - the post-audit `set_upgrade_authority` to none.
   Committed and tested on devnet, deliberately not run.
6. Delete `scripts/onchain/migrate-accounts.ts` (no migration exists in v2) and replace
   `scripts/onchain/transfer-authorities.ts` with the Squads script, since its single-key
   form is exactly what 6 removes.
7. Acceptance for the phase: one fresh devnet run end to end - launch paid by the creator, then
   launch subsidised by a sponsor event, buy, sell, activate, assign, advance, seed
   commit, roll, settle, sweep and graduate - with the indexer following along, and
   `npm run check` green.

## 9. Decisions, and what is still open

### 9.1 Final product-owner decisions (2026-09-23)

| Decision | Where it lands |
| --- | --- |
| Creator pays 100% by default; on-chain sponsorship and events can subsidise, and sponsorship never affects power, rewards or discovery | 1.4, 1.7 |
| No per-player VRF: one seed per (coin, epoch) committed to a future slot's `SlotHashes` entry, participation locked before the seed is known, all outcomes derived from it | 1.6, 4.1, 4.2 |
| No bond and no starter mode: every wallet mines at full efficiency from its first block, `post_bond` is refused, and `request_unbond` / `withdraw_bond` stay live so lamports parked before the retirement can be withdrawn | 3.2, 5 |
| The starter tranche and its `STARTER_TRANCHE_BPS` (10%) cap survive only for a position armed before the retirement; a live coin's starter tranche is empty, the whole block goes to the full tranche, and the unassigned remainder is never burned | 3.2, 8.2 |
| Discovery caps denominated in SOL, priced by our own pool TWAP, no external oracle | 4.3 |
| Governance: Squads 2-of-3 with a timelock now, program frozen after audit, no discretionary guardian pause over user funds | 6 |
| Fresh start: new program id, wiped devnet, no v2 migration code | 7 |
| The owner pays for the program once; coin creation is as cheap as it can be | 1.1, 1.3, 1.4 |

### 9.2 Still open

1. **Token-2022 metadata display.** Verify wallet and explorer rendering before launch copy
   promises metadata, with the lazy Metaplex fallback of 1.3(c) as the documented plan B.
2. **No bond in the model.** Nothing a player posts is config any more, so the farm bound must be
   re-measured with the retired bond input dropped from the sim (8.3, WS-G).
3. **Curve-table governance cadence.** `set_curve_table` exists behind the timelock and stays
   unused until a balance pass needs it; who proposes and how often is a process question.
4. **A new sponsor event kind.** Three kinds are the whole surface now that the bond subsidy is
   retired; the old byte still decodes, and adding a kind is a program upgrade, which after the
   freeze of 6 is not possible at all.

### 9.3 Accepted residuals

- The reveal must land inside the 512-slot `SlotHashes` window; a late crank shifts which
  recorded slot is used, bounded by `EPOCH_SEED_MAX_LATENESS_SLOTS`, and past that the seed
  re-arms and settlement waits (4.1).
- The revealed seed is public before settlement, so a farm can settle only its favourable
  wallets; that uplift is bounded by the caps at roughly 2-3x inside them (4.2).
- Cluster damping and the cluster share ceiling are gone; the post-v2 farm bound must be
  re-measured with the sim rather than quoted (5).
- Caps in SOL float with the price of SOL (4.3).
- The bond is retired, so a farm's per-wallet floor is time - maturity and the milestone gates -
  rather than capital; the re-measurement in 5 is what prices what is left (3.2).
