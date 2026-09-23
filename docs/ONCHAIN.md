# On-chain authority, locked liquidity and account migration

This document covers the parts of the Diggo protocol that only exist on Solana: who can
change the program, how a graduated market's liquidity is locked, and how the program's
accounts are upgraded when their layout changes. It is the operator-facing companion to
[ARCHITECTURE.md](./ARCHITECTURE.md) and [CUSTODY.md](./CUSTODY.md), and it assumes the
program in `programs/diggo-protocol/src/lib.rs` is the source of truth.

## 1. The three authorities

Three keys have any power over the protocol. Everything else — the mining reserve, the
discovery reserve, the graduated pool and every player balance — lives in program-derived
accounts that no key can withdraw from.

| Authority | Stored in | Can do | Cannot do |
| --- | --- | --- | --- |
| Program upgrade authority | the BPF loader's `ProgramData` account | replace the program code, and therefore change any rule | withdraw a reserve, a pool or a balance |
| Guardian | `ProtocolConfig.guardian` | flip the scoped circuit breakers, tune the bounded parameters, migrate an account layout | move a reserve token, LP SOL, the treasury or a balance |
| Keeper | `ProtocolConfig.keeper` | push a player's off-chain Crew Power (`sync_crew_power`), pay a server-approved discovery (`claim_discovery`), call the permissionless `graduate_market` | move the launch market, the treasury, or a player's claimable rewards |

The upgrade authority is the strongest of the three, and by a wide margin: it can deploy a
new program that changes every rule below it. That is why it is the first key to hand to a
multisig, and why the transfer script below moves all three at once.

Two structural properties keep the roles honest, and both are pinned by tests:

- The guardian-only account sets (`GuardianConfig`, `GuardianMineConfig`, `MigrateAccount`)
  hold no mint, token account or vault, so no instruction built on them can move a token or
  a lamport. `migrate_account` never even touches lamports.
- Every reserve debit goes through one ledger, `apply_reserve_debit`, whose only permitted
  arms are a real mining claim and a real discovery claim. `ReserveDebit::AdminWithdraw`
  exists purely so the ledger rejects that idea explicitly.

## 2. set_upgrade_path

`set_upgrade_path` is the runbook for handing the protocol to a Squads multisig. There is no
instruction by that name: the upgrade path is set by transferring the program's upgrade
authority on the BPF loader, and by rotating the guardian and keeper, which is exactly what
`scripts/onchain/transfer-authorities.ts` does.

### Order of operations

1. **Create the Squads multisig first.** The script refuses to run against an address that
   has no account, and it refuses a target whose owner is the system program (a plain
   wallet) rather than a program. That guard is deliberate: the most common way to lose a
   protocol is to hand it to a keypair you believe is a multisig.
2. **Deploy and initialize with the deployer key.** `initialize_protocol` is callable only by
   the program's upgrade authority and sets that same payer as the initial guardian. The
   keeper is passed in as an argument.
3. **Review the transfer plan.** The script is dry-run by default and needs no keypairs for
   the plan itself:

   ```
   node scripts/onchain/transfer-authorities.ts --multisig <SQUADS_ADDRESS>
   ```

   It prints the current upgrade authority, guardian and keeper, the target, the owner of the
   target account, and one line per step with the key that would sign it. Any keypair it could
   not load is called out as `NOT LOADED` with the exact `--*-keypair` flag to pass.
4. **Execute.**

   ```
   node scripts/onchain/transfer-authorities.ts \
     --multisig <SQUADS_ADDRESS> \
     --upgrade-authority-keypair ~/.config/solana/deployer.json \
     --guardian-keypair ~/.config/solana/guardian.json \
     --keeper-keypair ~/.config/solana/keeper.json \
     --execute
   ```

   Each step is skipped when the on-chain value already equals the target, so a run that
   failed halfway can simply be repeated. The script re-reads the chain at the end and exits
   non-zero unless all three authorities really are the multisig.
5. **Retire the old keys.** After the transfer the deployer key can no longer upgrade the
   program, the old guardian can no longer pause anything, and the old keeper can no longer
   sign a Crew power sync or a discovery payout. Move those keys out of any CI secret store
   and, if the keeper key was ever exposed to a runtime environment, treat it as burned.

### What the transfer does on the wire

1. `BPFLoaderUpgradeable::SetAuthority` on the program's `ProgramData` account, with the
   multisig as the new authority. `SetAuthority` (tag 4) is used rather than
   `SetAuthorityChecked`, because a multisig cannot sign a transaction as an ordinary keypair.
2. `diggo_protocol::rotate_guardian`, signed by the current guardian.
3. `diggo_protocol::rotate_keeper`, signed by the current keeper.

Rotating the guardian emits `GuardianRotated`, so the hand-off is auditable on-chain. Keeper
rotation is a plain field write; the `keeper` field is visible in `ProtocolConfig` at all
times.

### Verifying afterwards

```
node scripts/onchain/transfer-authorities.ts --multisig <SQUADS_ADDRESS>
```

A correct deployment prints `every authority is already the multisig; nothing to do`.

## 3. Locked liquidity at graduation (spec 36)

Before graduation a market trades on its bonding curve, exactly as before. Once the curve has
collected `graduation_target` lamports, `graduate_market` moves that liquidity into a real
constant-product pool that the program owns and no key can withdraw from.

### The pool

| Account | PDA seeds | Notes |
| --- | --- | --- |
| `LiquidityPool` | `[b"pool", mint]` | reserves, vault addresses, graduation timestamp |
| pool token vault | `[b"pool-vault", mint]` | token account whose authority is the pool PDA |
| `PoolSolVault` | `[b"pool-sol", mint]` | lamports = rent floor + `pool.sol_reserve`, and nothing else |

There is no LP mint and no LP token. Nobody receives a claim on the pool, so there is nothing
to redeem and nothing to dump. Liquidity leaves the pool only through a swap, and that rule is
written as a ledger rather than as an absence of code: `apply_pool_swap` is the only function
that writes the pool's reserves, and its `PoolDebit::AdminWithdraw` arm always returns
`PoolWithdrawForbidden`. `PoolWithdrawForbidden` exists for the same reason
`ReserveWithdrawForbidden` does — so that a future instruction which tries to reach the LP is
rejected explicitly instead of quietly succeeding.

`graduate_market` itself is permissionless. Anyone may pay the pool's rent once the market has
genuinely reached its target; the caller gains nothing. The program never flips `graduated` on
a buy: the flag and the pool are created together, so a market can never end up graduated with
its liquidity stranded in neither venue.

### Which venue a trade uses

| Market state | Buy | Sell |
| --- | --- | --- |
| `graduated == false` | `buy` (bonding curve, unchanged) | `sell` (bonding curve, unchanged) |
| `graduated == true` | `pool_buy` | `pool_sell` |

The two curve instructions now reject a graduated market with `MarketGraduated`, and the two
pool instructions reject a pre-graduation market with `MarketNotGraduated`. That is not just
politeness: after graduation `market.token_reserve` and `market.sol_reserve` are both zero by
design, so a curve quote would return zero tokens and fail on slippage anyway. The explicit
error is easier to debug than a silent zero.

Both pool instructions take the same explicit slippage floor as the curve — `min_tokens_out`
and `min_sol_out` — and both use the same capped fee schedule the market snapshotted at
launch, so the pool is not a way around `MAX_TRADING_FEE_BPS`. Fees are taken off the top and
paid into the market's existing fee buckets, which keeps the lamport invariant of a market
account exactly as it was: `lamports - rent_floor == sol_reserve + creator_fee_claimable +
platform_fee_claimable`. Post-graduation `sol_reserve` is zero, so a market account holds only
accrued fees, and `claim_creator_fees` / `claim_platform_fees` keep working unchanged.

The swap math is `x * y = k` with the input added to the SOL side, integer-divided so the
rounding always favours the pool. k is checked before and after every swap and may only grow;
that is what makes the locked liquidity impossible to dilute.

### Who calls graduation

`worker/keeper.ts` exports `keeperGraduateMarket(env, mint)`. It reads the market, and does
nothing at all — returning `null` rather than throwing — when the market is missing, already
graduated, short of its target, or already has a pool. That makes it safe to run on every
indexing pass. It is called from the `epoch_sync` branch of the indexing queue
(`worker/indexing.ts`), and only when the fresh chain read says there is something to do
(`needsGraduation`), so a healthy graduated market costs nothing. A market therefore graduates
without anyone calling `graduate_market` by hand, and a missed call is retried on the next pass
rather than leaving liquidity in neither venue.

## 4. Account versioning and migration

`ProtocolConfig`, `Mine` and `LaunchMarket` each end with an appended `version: u8`, currently
`ACCOUNT_VERSION = 1`. Appended is the operative word: the byte sits after every field that
already existed, so an account written before the field existed still decodes for every other
field and reads back as version 0.

Adding a field to an Anchor account is not a no-op. A legacy account is one byte short, so
`Account<Mine>` cannot deserialize it and every instruction that touches it fails until it has
been reallocated. That is what `migrate_account` is for.

### migrate_account

- **Guardian-only.** Its account set is the guardian signer, the protocol config read from raw
  bytes, and the target account. There is no mint, no token account, no vault and no system
  program in it.
- **Byte-preserving.** It snapshots the account, reallocates it to the current size, and
  rewrites the buffer from `upgraded_account_data`: the account's own values re-serialized
  with only the appended fields set to their safe default. Borsh is deterministic, so every
  field that already existed keeps its exact bytes — no balance, reserve, fee bucket or
  timestamp can move. The account's own values are read back, never recomputed from lamports.
- **Never touches lamports.** It cannot fund the account it migrates. It requires the account
  to already hold its new rent-exempt minimum and returns `MigrationNeedsFunding` otherwise.
- **Kind-checked.** The caller passes a kind (0 protocol, 1 mine, 2 market). The program
  derives the expected discriminator and size from that kind, so a migration cannot be aimed
  at a layout the program does not know or at an account of a different type.
- **Auditable.** Every migration emits `AccountMigrated` with the account, kind, old and new
  lengths and the resulting version.

One detail is worth calling out because it is easy to get wrong: `Mine` has variable-length
`name`, `symbol` and `uri` fields, so its account is allocated for the maximum string lengths
and the serialized payload is usually shorter than the buffer. Writing the version byte at the
end of the *buffer* would therefore write into padding, and the field would still read as 0.
`upgraded_account_data` re-serializes instead, which puts the byte where the deserializer will
actually look. A mine whose strings are all at maximum length has no slack at all, and that
case is covered by its own test.

### The migration runbook

The window between deploying a layout change and migrating the accounts is a real outage for
the affected mines: they cannot trade, mine or claim until they are migrated. Plan it as a
maintenance step, not as something that resolves itself.

1. **Upgrade the program.**
2. **Migrate immediately**, protocol config first:

   ```
   node scripts/onchain/migrate-accounts.ts
   node scripts/onchain/migrate-accounts.ts --execute --guardian-keypair ~/.config/solana/guardian.json
   ```

   The dry run needs no keys. It discovers every account of the requested kinds with
   `getProgramAccounts`, reports how many are already current, how many need migrating and the
   total rent top-up required, and prints one line per account. If your RPC provider has
   disabled `getProgramAccounts`, pass the mints explicitly with `--mints <mint1>,<mint2>`;
   `--kinds` and `--max` narrow the run further.
3. **The script funds what it needs to.** `migrate_account` never touches lamports, so when an
   account is short of its new rent-exempt minimum the script sends a plain system transfer
   from the guardian first, then the migration. The top-up is one byte of rent plus rounding —
   a few thousand lamports per account.
4. **Verify.** The script re-reads every account it migrated and exits non-zero unless each one
   has the expected length and `version == ACCOUNT_VERSION`.

Because migrations are append-only and idempotent — an account already on the current layout is
rejected with `AccountAlreadyCurrent` rather than reallocated — a partially completed run can be
repeated safely.

## 5. Tests

Rust unit tests live beside the logic in `programs/diggo-protocol/src/lib.rs`. Run them, and the
BPF build, in WSL:

```
cp programs/diggo-protocol/src/lib.rs /home/jurek/diggo-build/programs/diggo-protocol/src/lib.rs
cd /home/jurek/diggo-build && cargo test && anchor build
```

The tests that pin the rules in this document:

- `pool_swaps_never_reduce_the_invariant` — k is non-decreasing across a sequence of buys and
  sells, and the pool still holds a real market on both sides afterwards.
- `pool_quotes_never_drain_a_side` — no single trade, however large, can empty either reserve.
- `pool_trades_use_the_capped_fee_schedule` — pool trades reuse `net_after_fees`, so the fee cap
  binds on the pool too.
- `no_instruction_can_withdraw_pool_liquidity` — the pool ledger rejects every withdrawal amount,
  a swap can never pay out more than the pool tracks, and only `pool_buy` / `pool_sell` debit the
  pool or sign for its token vault.
- `graduation_moves_exactly_the_reserve_amounts` — graduation moves the market's curve reserves
  and nothing else, conserves both assets, and leaves the fee buckets untouched.
- `graduation_is_gated_and_single_shot` — the target must be met, graduation happens once, and it
  cannot be replayed onto a funded pool.
- `graduation_switches_venues_atomically` — the curve handlers are closed after graduation, the
  pool handlers require it, and `GraduateMarket` is the only account set that creates a pool.
- `migration_preserves_every_existing_byte`, `migration_handles_an_account_with_no_spare_bytes`,
  `migration_cannot_change_reserves_or_fee_buckets`, `protocol_config_migrates_without_losing_configuration`
  — a migration cannot move a reserve, a fee bucket or a configuration value, including for a
  mine whose variable-length fields leave no slack.
- `protocol_guardian_offset_matches_the_layout` — the raw offset `migrate_account` reads the
  guardian from is pinned against the real serialized layout.
- `account_layouts_are_explicit_and_unknown_kinds_are_rejected` and
  `version_is_appended_after_every_existing_field` — the migratable kinds and the append-only
  shape of the version field.
- `mine_sync_is_resumable_and_matches_a_single_pass` — a mine left unsynced for 200 epochs
  reaches the ledger one unbounded pass produces, at every per-call budget, and each call that
  reports `Behind` strictly advances the cursors.
- `a_partially_synced_mine_can_never_settle_a_position` — `sync_mine_to_now` refuses a
  half-walked ledger with `SyncBehind`, the index it refused is strictly behind the truth, and
  finishing the walk opens the gate.
- `only_advance_mine_may_touch_a_behind_ledger` — every instruction that settles a position goes
  through the caught-up gate, and `advance_mine` settles nothing.
- `a_resumable_walk_never_distributes_more_than_the_reserve`,
  `a_mine_with_an_unusable_schedule_fails_instead_of_spinning` and
  `launch_schedule_keeps_one_sync_segment_bounded` — the walk conserves the reserve, refuses a
  schedule whose cursors cannot advance, and stays bounded because launch validation forces
  `epoch_length >= block_interval`.

The client mirrors in `shared/program.ts` were checked against the program's own generated IDL
and against Rust-computed vectors for the pool PDAs and the pool quotes, including the
`u64::MAX` edges. Comparing every builder's account list against the IDL — order, writability
and signer flags — confirmed the new pool, graduation, migration and rotation builders, and
exposed two pre-existing bugs in `shared/program.ts`, both now fixed:

- The `updateDiscoveryLimits` discriminator did not match the program, so every
  `update_discovery_limits` transaction built by this client would have failed with
  `InstructionFallbackNotFound`.
- `buildClaimDiscoveryInstruction` marked the keeper as a read-only signer, but the program
  declares it mutable (it pays for the discovery receipt and the recipient's associated token
  account). The program would have rejected it with `AccountNotMutable`, so no discovery
  payout built this way could have succeeded.

## 6. Follow-ups this document tracked

The pool was introduced here before the rest of the stack knew about it. All five follow-ups it
listed have since landed, and this section records where each one went rather than leaving a
reader to guess whether a graduated market is actually usable:

1. **Price and index paths read the pool.** `keeperReadVenue(env, mint)` in `worker/keeper.ts`
   returns the reserves of whichever venue a market is on, and `worker/chain.ts` prices from it
   (`venueSpotPriceLamports`, `venueLiquidityLamports`) instead of reading `LaunchMarket`'s
   reserves, which are zero after graduation. `worker/indexing.ts` and `worker/tokens.ts` follow
   the same path.
2. **The trade UI routes by venue.** `src/components/SwapPanel.tsx` decodes the market on every
   load and after every trade, quotes against the venue it found, and passes it to
   `src/solanaProgram.ts`, which builds `pool_buy` / `pool_sell` on a graduated market and
   `buy` / `sell` before it. A graduated market's curve reserves are zero, so the venue is a
   correctness question, not a preference.
3. **Graduation is triggered from the indexing loop**, on the `epoch_sync` branch of
   `worker/indexing.ts` and only when the fresh chain read says there is something to do. See
   section 3.
4. **`src/push.ts` typechecks.** The `Uint8Array` / `BufferSource` mismatch is fixed, so the
   notification path compiles under the same gate as everything else.
5. **`scripts/onchain/` is covered by a tsconfig.** `tsconfig.node.json` includes `scripts`, so
   `npm run typecheck` and `npm run lint` see those scripts.

## 7. Invariants this document relies on

- Real money never buys Mining Power or ORE.
- ORE is non-transferable.
- Reserves leave only through a valid mining or discovery claim; `apply_reserve_debit` has no
  other permitted arm.
- Pool liquidity leaves only through a swap; `apply_pool_swap` has no other permitted arm, and no
  LP token exists to redeem.
- The frontend never decides a reward or an RNG outcome; the keeper pushes only server-approved,
  bounded values.
- Claims are idempotent and replay-safe; discovery receipts are seeded by `(mine, discovery_id)`
  and migrations refuse to run twice.
- Graduation conserves both assets exactly: what the pool holds is what the curve held a moment
  earlier.
- A mine that is behind is advanced by anyone and unlocked by no one: a partially walked
  `reward_index` is never spendable, every walk resumes exactly where it stopped, and no key —
  including the upgrade authority's guardian — can move a mine's cursor or reach its reserve.

## 8. Resumable mining sync (advance_mine, SyncBehind)

`sync_mine` walks a mine's mining ledger one segment at a time: at most one run of blocks and,
given the schedule bounds below, at most one epoch rollover per segment. It used to stop at
`MAX_SYNC_SEGMENTS` (64) with `SyncWindowTooLarge`, which meant a mine left unsynced for more
than 64 epochs could never be walked forward again — its Mining Reserve, and every
`claim_rewards` against it, was permanently unreachable, and no admin instruction can move a
mine's cursor or debit its reserve. The walk is now resumable.

The progress lives entirely in the mine account (`next_block_at`, `epoch`, `epoch_ends_at`,
`current_block_reward`, `reward_index`, `remaining_reserve`), so a call that runs out of budget
returns `Ok` with the cursors exactly where it stopped. `advance_mine` is permissionless — its
account set is a single writable `Mine` with no signer and no authority constraint — so anyone
can call it repeatedly to walk a mine forward 64 segments at a time. Each call is a
deterministic continuation of the previous one: the ledger a mine lands on is identical to the
one a single unbounded pass would have produced, however many calls it took, and every segment
strictly advances `next_block_at`, so no call can fail to make progress.

The instructions that settle a position against `mine.reward_index` — `claim_rewards`,
`assign_power`, `remove_power` and `sync_crew_power` — refuse to run on a half-walked ledger
and return `SyncBehind` instead. Settling against a partial index would credit the epochs the
walk got through and then hide the rest behind the position's `last_reward_index`, forfeiting
them. Recovery needs no privileged key:

```
# Anyone, as many times as it takes: each call commits 64 more segments.
advance_mine(mine)
# Then the settling call succeeds. Retrying it is the stop condition:
# while it answers SyncBehind, call advance_mine again.
claim_rewards(mine, ...)
```

`SyncBehind` is appended at the end of `DiggoError`, so every existing error code keeps its
number, and `SyncWindowTooLarge` is retained for the same reason — it is no longer returned by
anything. No account layout and no instruction signature changed, so `shared/program.ts` needs
no mirror update: the `advanceMine` discriminator it already exports is enough to build the
recovery call. What a client does need to handle is the new error, because a claim that used to
be impossible now fails with a retryable answer that anyone can clear.

Two properties keep the per-call cost bounded rather than proportional to how long a mine was
idle. Launch validation forces `epoch_length >= block_interval` (`validate_launch_args`), which
is what holds the epoch rollover loop to at most one iteration per segment; and the walk refuses
a stored schedule with a non-positive `block_interval` or `epoch_length` (`InvalidSchedule`)
rather than looping on a cursor that cannot advance.

The number of calls a catch-up needs is the elapsed epochs divided by `MAX_SYNC_SEGMENTS` (64),
which for a mine on the default one-week epochs is roughly one call per year of backlog. A mine
launched with the shortest legal epoch (60 seconds) needs far more calls, all permissionless and
each one cheap; the constant is the knob if a wider single-call window is ever wanted.
