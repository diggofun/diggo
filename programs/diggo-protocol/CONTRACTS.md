# Diggo.fun on-chain v2 - frozen contracts

Program id: `H3Y8GgTnvwv5U1bajfzj386YSPC48vvwjFroXYyHZFj5` (keypair at
`/home/jurek/.solana-diggo/program-v3.json`, never in the repository).

This is the Phase 0b spine: every account layout, seed, instruction signature, event and error
code below is frozen. Phase 1 workstreams implement against it and do not edit it. A change to
any name, field, order, size or seed list is a contract amendment and belongs to the
integrator, not to a worker.

Source of truth for the design: [`docs/ONCHAIN_V2_DESIGN.md`](../../docs/ONCHAIN_V2_DESIGN.md).
Where this file and the design disagree, this file is the contract and the disagreement is
listed under *Deviations* below.

## Building and testing

Build and test happen in WSL, never on the Windows tree, and never in `/home/jurek/diggo-build`
(another flow owns that directory):

```bash
rsync -a --delete /mnt/c/Users/Jurek/Documents/Diggo_Fun_v2/programs/ /home/jurek/diggo-build-v2/programs/
cp /mnt/c/Users/Jurek/Documents/Diggo_Fun_v2/{Anchor.toml,Cargo.toml,Cargo.lock} /home/jurek/diggo-build-v2/
cd /home/jurek/diggo-build-v2 && anchor build && cargo test --workspace
```

State at the spine commit: `anchor build` green, 45 unit tests green, `.so` 582,368 bytes.

## Accounts

`SIZE` is the whole account space and equals `8 + borsh length`. Every one of them is asserted
twice in `src/tests.rs`: once against a borsh round trip of `Default::default()`, and once
against the literal number in the table below.

| Account | File | Seeds | Body | Size | Rent (lamports) |
| --- | --- | --- | --- | --- | --- |
| `ProtocolConfig` | `state/protocol.rs` | `[b"protocol"]` | 426 | 434 | 3,911,400 |
| `CurveTable` | `state/protocol.rs` | `[b"curve-table"]` | 2402 | 2410 | 17,662,800 |
| `Coin` | `state/coin.rs` | `[b"coin", mint]` | 400 | 408 | 3,729,600 |
| coin vault (token account) | `state/coin.rs` | `[b"vault", mint]` | 165 | 165 | 2,039,280 |
| `PlayerAccount` | `state/player.rs` | `[b"player", owner]` | 208 | 216 | 2,394,240 |
| `MiningPosition` | `state/player.rs` | `[b"position", coin, owner]` | 43 | 51 | 1,246,440 |
| `LiquidityPool` | `state/pool.rs` | `[b"pool", mint]` | 177 | 185 | 2,178,480 |
| pool token vault | `state/pool.rs` | `[b"pool-vault", mint]` | 165 | 165 | 2,039,280 |
| pool SOL vault | `state/pool.rs` | `[b"pool-sol", mint]` | 0 | 0 | rent floor only |
| `DiscoveryOpportunity` | `state/epoch.rs` | `[b"opportunity", coin, owner, window u16 le]` | 108 | 116 | 1,698,240 |
| `GlobalBudget` | `state/epoch.rs` | `[b"global-budget", day u16 le]` | 45 | 53 | 1,259,880 |
| `SponsorVault` | `state/sponsor.rs` | `[b"sponsor-vault", sponsor_owner]` | 62 | 70 | 1,377,360 |
| `SponsorEvent` | `state/sponsor.rs` | `[b"sponsor-event", vault, event_id u32 le]` | 84 | 92 | 1,531,200 |
| `SponsorGrant` | `state/sponsor.rs` | `[b"sponsor-grant", event, subject]` | 34 | 42 | 1,183,200 |
| treasury PDA | `state/protocol.rs` | `[b"treasury"]` | 0 | 0 | rent floor only |
| crank-tip pool PDA | `state/protocol.rs` | `[b"crank-pool"]` | 0 | 0 | rent floor only |
| `mint` | `instructions/launch.rs` | `[b"mint", creator, nonce u8]` | 359 | 359 | 3,389,520 |

`subject` in the `SponsorGrant` seeds is the coin for the launch-rent and trade-fee-waiver
kinds, and the player's wallet for the account and bond subsidies. That is what lets one grant
shape enforce both the per-coin and the per-wallet limit.

### Frozen field layouts

Field order is the borsh order and is part of the contract; the sizes above are derived from
it. The complete layouts are in the owning files, and `docs/ONCHAIN_V2_DESIGN.md` sections
1.3(b), 3.1, 4.1, 4.3 and 1.7 describe what each field is for. Two points are worth repeating
here because two workstreams share them:

- `Coin` carries the **epoch-seed block** (`epoch_seed [u8; 32]`, `epoch_seed_epoch u32`,
  `epoch_seed_target_slot u64`, `epoch_seed_recorded_slot u64`). WS-B writes it, WS-C reads it,
  and it must not move.
- `Coin` carries **two power totals** and the **starter tranche cap** (`bonded_power`,
  `starter_power`, and the `starter_tranche_bps` default in `ProtocolConfig`). See *Amendment*
  below.

## Instructions

Every handler lives in the file below and is a thin delegation from the `#[program]` shell in
`src/lib.rs`. Until its workstream lands, the body is exactly `err!(DiggoError::NotImplemented)`.

| Instruction | Arguments | Signer | Owner |
| --- | --- | --- | --- |
| `initialize_protocol` | `config: ProtocolConfigArgs` | upgrade authority | WS-B |
| `update_fee_config` | `creator_fee_bps, platform_fee_bps, crank_pool_fee_bps: u16` | governance | WS-B |
| `update_discovery_limits` | `discovery_max_bps, discovery_epoch_budget_bps: u16`, four `u64` caps | governance | WS-B |
| `set_rarity_table` | `tiers: Vec<RarityTier>` | governance | WS-B |
| `set_curve_table` | `power: Vec<u32>, upgrade_ore_cost: Vec<Vec<u32>>` | governance | WS-B |
| `schedule_pause` | `flag: u8, paused_until: i64` | governance | WS-B |
| `unpause` | `flag: u8` | anyone | WS-B |
| `launch_token` | `args: LaunchTokenArgs` | creator | WS-B |
| `buy` / `sell` | `amount_in: u64, min_out: u64` | trader | WS-B |
| `pool_buy` / `pool_sell` | `sol_in/tokens_in: u64, min_out: u64` | trader | WS-B |
| `graduate_market` | none | anyone | WS-B |
| `sweep_fees` | none | anyone | WS-B |
| `claim_creator_fees` | none | creator | WS-B |
| `crank_tip` | `max_tip: u64` | anyone | WS-B |
| `init_sponsor_vault` | none | sponsor owner | WS-B |
| `fund_sponsor_vault` / `withdraw_sponsor_vault` | `amount: u64` | sponsor owner | WS-B |
| `create_sponsor_event` | `kind: u8, start_at/end_at: i64`, three `u64` limits | sponsor owner | WS-B |
| `close_sponsor_event` | `event_id: u32` | sponsor owner | WS-B |
| `initialize_player` | none | owner | WS-A |
| `activate` | none | owner | WS-A |
| `collect_ore` | none | owner | WS-A |
| `upgrade_crew` | `component: u8` | owner | WS-A |
| `assign_power` / `remove_power` / `switch_mine` | none | owner | WS-A |
| `claim_rewards` | none | owner | WS-A |
| `post_bond` / `request_unbond` / `withdraw_bond` | none | owner | WS-A |
| `advance_mine` | none | anyone | WS-C |
| `commit_epoch_seed` | none (`Sysvar<SlotHashes>`) | anyone | WS-C |
| `create_discovery_roll` | none | owner | WS-C |
| `settle_discovery` / `expire_opportunity` | none | anyone | WS-C |

Notes that are contract, not advice:

- `assign_power` takes **no power argument**. Power is derived in-program, so no caller can
  assert it.
- No instruction anywhere takes a destination argument: fee destinations are `ProtocolConfig`
  fields.
- `commit_epoch_seed` takes the sysvar as `Sysvar<'info, SlotHashes>`, never as an unchecked
  account.
- `launch_token` takes the mint as an `UncheckedAccount` **only** because a Token-2022 mint with
  the metadata pointer and the token-metadata extension has to be created by hand at its
  computed size. It carries a `seeds` constraint, so the PDA is proven before anything exists,
  and the handler creates it with `system_program::create_account`. Everywhere else the mint is
  an `InterfaceAccount<Mint>`.

## Events

All 40 events are declared in `src/events.rs`; Phase 1 only emits them. The v2 set is
`ProtocolInitialized`, `CoinLaunched`, `EpochAdvanced`, `EpochSeedTargetArmed`,
`EpochSeedCommitted`, `EpochSeedRearmed`, `PlayerInitialized`, `Activated`, `OreCollected`,
`CrewUpgraded`, `BondPosted`, `UnbondRequested`, `BondWithdrawn`, `PowerAssigned`,
`PowerRemoved`, `MineSwitched`, `RewardsClaimed`, `DiscoveryRollCreated`, `DiscoverySettled`,
`DiscoveryExpired`, `MarketGraduated`, `FeesSwept`, `CrankTipPaid`, `SponsorVaultInitialized`,
`SponsorEventCreated`, `SponsorSpend`. The other 14 are v4 events kept because the v4 data
model is still in the tree; they are deleted at the integration step.

## Errors

One `#[error_code] enum DiggoError` in `src/errors.rs`. The 48 v4 variants keep codes
`6000..6047`; the 48 v2 variants are appended in the order design section 8.2 reserves them, so
they occupy `6048..6095`:

| Block | Codes | Variants |
| --- | --- | --- |
| protocol, admin, config | 6048-6053 | `NotImplemented`, `InvalidPauseWindow`, `NotTimelocked`, `ConfigOutOfBounds`, `InvalidRarityTable`, `InvalidCurveTable` |
| player, activation, ORE, crew | 6054-6059 | `NotActivated`, `AccrualOverflow`, `CrewAtMaxLevel`, `InsufficientOre`, `StorageCapacityExceeded`, `ReactivationTooSoon` |
| bond | 6060-6065 | `BondAlreadyPosted`, `NoBondPosted`, `PositionStillActive`, `BondCooldownActive`, `SponsorBondNotWithdrawable`, `VaultBelowRentExempt` |
| coin, launch, curve, pool | 6066-6071 | `LedgerInvariantViolated`, `MetadataTooLong`, `InvalidMintLayout`, `CurveExhausted`, `PoolNotInitialised`, `TwapUnavailable` |
| fees | 6072-6074 | `FeeSplitOverflow`, `CrankTipExceedsAccrual`, `NotCoinCreator` |
| sponsor | 6075-6081 | `EventNotActive`, `EventBudgetExhausted`, `PerCoinLimitExceeded`, `PerWalletLimitExceeded`, `EventAlreadyClosed`, `UnspentWithdrawalOnly`, `InvalidEventKind` |
| mining, epoch, seed | 6082-6087 | `EpochNotRolled`, `SeedTargetInFuture`, `SeedTargetNotInSysvar`, `SeedAlreadyCommitted`, `SeedNotCommitted`, `CoinNotAdvanced` |
| discovery | 6088-6095 | `RollAlreadyExists`, `NotDiscoveryEligible`, `OpportunityExpired`, `OpportunityAlreadySettled`, `DailyCapExceeded`, `WeeklyCapExceeded`, `GlobalCapExceeded`, `EpochBudgetExhausted` |

The design quotes 6040, 6100, ... for these blocks because it assumed a shorter v4 enum. The
names and their order are the contract; the numeric ranges above are the ones the tree actually
produces, and `v2_error_codes_are_appended_in_the_designed_order` pins them.

## Constants

`src/constants.rs`. The ones a workstream must not re-derive: `BOND_LAMPORTS = 70_000_000`,
`BOND_COOLDOWN_SECONDS = 604_800`, `STARTER_EFFICIENCY_BPS = 2_500`,
`STARTER_TRANCHE_BPS = 1_000`, `EPOCH_SEED_DELAY_SLOTS = 32`,
`EPOCH_SEED_MAX_LATENESS_SLOTS = SLOT_HASHES_WINDOW = 512`, `CRANK_TIP_BPS = 200`,
`MAX_PAUSE_SECONDS = 259_200`, `MAX_RARITY_TIERS = 8`, `CREW_COMPONENTS = 5`,
`MAX_CREW_LEVEL = 100`, `MIN_CURVE_MINING_BLOCKS = 48`, the four
`DEFAULT_DISCOVERY_*_CAP_LAMPORTS` values, `MINT_V2_SIZE = 359`, `MAX_NAME_LEN = 16`,
`MAX_SYMBOL_LEN = 8`, `MAX_URI_LEN = 96`, `ACCOUNT_VERSION = 5`.

All of them are `ProtocolConfig` fields at runtime, except the layout bounds (the metadata
caps, `MAX_RARITY_TIERS`, `CREW_COMPONENTS`, `MAX_CREW_LEVEL`, `MINT_V2_SIZE`) which are
compile-time. The curve tables are `&'static` constant data, never account fields;
`CurveTable` is only the optional timelocked override, and while it is absent every
instruction uses the constants.

## Amendment: STARTER_TRANCHE_CAP

The orchestrator's review added a cap the original design did not have: **the starter tranche
may never receive more than `STARTER_TRANCHE_BPS` (default 1,000 bps = 10%) of any block's
reward.** A bonded player therefore always keeps at least 90% of a block, and when a coin has
no bonded power at all the remaining 90% is **not** handed to the starter index: it stays in
the Mining Reserve. It is never burned and never re-assigned.

Implementation shape, frozen here so WS-A and WS-C agree:

1. `Coin` keeps two power totals, `bonded_power` and `starter_power`, and one cumulative index
   per tranche (`reward_index` for bonded; the starter index is derived as
   `reward_index * starter_efficiency_bps / BPS` scaled by `STARTER_TRANCHE_BPS`), or an
   equivalent exact split that satisfies the three properties below. Either shape is allowed;
   the properties are not negotiable.
2. Per block, `starter_take = min(block_reward * STARTER_TRANCHE_BPS / BPS, ...)`, and the
   bonded index receives `block_reward - starter_take`.
3. `starter_power` is already scaled by `STARTER_EFFICIENCY_BPS`, so starter mode is 25% of the
   same power **and** capped at 10% of the block: both bounds apply, and neither can be traded
   for the other.
4. The vault ledger invariant still holds: `vault.amount >= curve_tokens + reserve_remaining +
   discovery_remaining + outstanding_claims`, and the reserve is debited only by what is
   actually distributed. The unassigned remainder is never debited at all, which is what makes
   it stay in the reserve.
5. WS-G's tests must pin: a bonded position always receives at least 90% of a block; a coin
   with zero bonded power assigns at most 10% and leaves the rest in `reserve_remaining`;
   adding a bond strictly increases the bonded share and never decreases the starter share of
   power; and `reserve_remaining` plus `cumulative_distributed` plus `outstanding_claims` is
   conserved across every path.

## Deviations from the design's rent table

Three account sizes differ from the numbers in design section 1.3 and section 7. Each is
asserted in `src/tests.rs` and each difference is explained; none of them changes the launch
cost story by more than a rounding error.

| Account | Design | Spine | Why |
| --- | --- | --- | --- |
| `Coin` | 384 | 408 | +16 for `bonded_power` and `starter_power`, which the starter-tranche amendment requires, and +8 for `epoch_ends_slot`, which the epoch-seed target needs |
| `MiningPosition` | 73 | 51 | the design's arithmetic drops only one of the two seed pubkeys (`owner` and `coin` are both seeds) |
| `GlobalBudget` | 64 | 53 | the design's field list is not given in full; this is a complete one |
| `LiquidityPool` | 161 | 185 | +24 for the TWAP accumulator and its slot cursor, which design 4.3 adds to the pool |

`ProtocolConfig` and `CurveTable` are new sizes: the design gives neither, and both are
asserted. `CurveTable` is a small contract addition (seed `[b"curve-table"]`) that exists so
`set_curve_table` has somewhere to write while the tables themselves stay `&'static` constant
data, as design section 7 requires.

## Who implements what

| WS | Scope | Writes exclusively |
| --- | --- | --- |
| **A** | player, ORE, crew, activation, bond | `state/player.rs`, `instructions/player_activate.rs`, `player_ore.rs`, `player_crew.rs`, `player_mine.rs`, `player_bond.rs`, `math/power.rs`, `math/ore.rs` (new), `shared/crew.ts`, `shared/ore.ts`, `shared/streak.ts` |
| **B** | coin, launch, curve, pool, fees, sponsor, admin | `state/coin.rs`, `state/pool.rs`, `state/protocol.rs`, `instructions/launch.rs`, `trade.rs`, `fees.rs`, `sponsor.rs`, `admin.rs`, `math/curve.rs`, `math/fees.rs`, `shared/curve.ts`, `shared/config.ts`, `shared/economics.ts` |
| **C** | mining index, blocks, claims, epoch seed, discovery | `state/epoch.rs`, `instructions/mining_advance.rs`, `mining_seed.rs`, `discovery.rs`, `instructions/crank.rs`, `math/index.rs`, `math/rarity.rs`, `shared/rewardIndex.ts`, `shared/rarity.ts`, `shared/discovery.ts`, `shared/epochSeed.ts` (new) |
| **D** | client: builders, decoders, PDAs, IDL | `shared/program.ts` (sole writer), `shared/program.test.ts`, `shared/pdas.ts` (new), `shared/types.ts`, `target/idl/diggo_protocol.json` |
| **E** | worker becomes indexer-only | deletes `worker/keeper.ts`, `worker/playerLock.ts`, `worker/breakers.ts`, `shared/commitReveal.ts`; modifies the worker files listed in design 8.3; adds `migrations/0021_indexer_only.sql` |
| **F** | frontend signing flows | `src/solanaProgram.ts`, `src/rewardsClaim.ts`, `src/api.ts`, `src/constants.ts`, the components listed in design 8.3 |
| **G** | tests, parity and the sim | `programs/diggo-protocol/tests/**` (new), `src/tests.rs`, `tests/onchain/**` (new), `shared/parity/*.test.ts` (new), `scripts/sim/**` |

Rules that make the parallel work safe:

1. `src/lib.rs`, `src/errors.rs`, `src/events.rs`, `src/constants.rs`, `src/seeds.rs`, every
   `mod.rs`, `state/sponsor.rs` and `instructions/token.rs` are **read-only** for Phase 1. A
   worker that needs a change there asks the integrator.
2. `shared/program.ts` has exactly one writer (WS-D). Everyone else imports it read-only.
3. `shared/config.ts` has exactly one writer (WS-B); WS-A and WS-C read named getters WS-B adds.
4. WS-E owns the API payload shapes WS-F consumes.
5. `src/tests.rs` is owned by WS-G, because the design's ownership table does not name it and
   the suite it holds is the parity net the design relies on. This is a contract addition.
6. Deleting the v4 surface is one integration step after A, B and C land: the v4 data model
   still in `state/*.rs` (`Mine`, `LaunchMarket`, `Player`, `MiningPositionV4`,
   `ProtocolConfigV4`, `LiquidityPoolV4`, `DiscoveryReceipt`, `PoolSolVault`, `MineStatus`),
   the v4 events, `math/rarity.rs`'s v4 approval path, and the `PROTOCOL_GUARDIAN_OFFSET` and
   `ACCOUNT_KIND_*` constants. They are kept only because 40 of the 45 unit tests still pin the
   v4 curve, index and pool math that v2 must reproduce; they are not in the IDL and no v2
   instruction may reference them.

## What is expected-broken

The Rust program builds and its tests pass. The TypeScript side does not, by design:

- `shared/program.ts` still builds v4 instructions (`sync_crew_power`, the keeper's
  `claim_discovery`, the four-vault launch, `migrate_account`) that no longer exist, and it
  still encodes the v4 account layouts. WS-D rewrites it against the new IDL.
- `worker/*` still signs with a keeper key and reads v4 accounts; WS-E rewrites it as an
  indexer. `worker/keeper.ts` should be deleted rather than fixed.
- `src/*` still calls `assignPowerOnChain` with a power argument and the v4 claim path; WS-F
  rewrites it.
- `scripts/onchain/*` still targets the v4 program id and a migration that no longer exists;
  Phase 3 replaces them.
- `npm run typecheck` and `npm test` are therefore expected to fail until D, E and F land. The
  Rust gate (`anchor build`, `cargo test`) is the one that is green.

