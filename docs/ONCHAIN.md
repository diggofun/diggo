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
- Every reserve debit goes through one of two ledgers, and neither has an arm any key can
  reach: `apply_reserve_debit`, whose only permitted arms are a real mining claim and a real
  discovery claim, and `apply_curve_mining_debit`, whose only permitted arm is a settled
  mining emission drawn from a market's own curve inventory (section 4). The
  `AdminWithdraw` arm on each exists purely so the ledger rejects that idea explicitly.

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

The curve phase ends in that same transaction, so the mine's ledger has to reach the present
first. `graduate_market` walks the mine to `now` under the curve phase — the same bounded walk
`advance_mine` performs — before it flips anything, which is what makes every block that landed
before graduation be paid out of the curve's own token inventory, the side that was open when it
landed. A mine further behind than one bounded walk can cover is refused with `SyncBehind`
instead: retryable, and nothing about the phase moves. Without that walk the emission source is
derived from the phase at walk time, so the whole un-walked stretch would be paid out of the
Mining Reserve the first time anybody walked it — tokens the curve never gave up, at the
reserve's own far larger rate, with `curve_mining_mined` still reading zero and the curve's cap
unspent — while the curve inventory then seeded the pool in full. The plan is re-derived after
the walk, so the pool moves exactly the post-mining inventory the curve holds at that instant.

Graduation also records the instant the phase ended, on the mine's own `curve_phase_ends_at`
cursor, and the walk classifies every block that landed before that cursor as curve-phase for
good. In the ordinary path the cursor only records where the walk already got to; it exists so
the phase is a fact about time rather than about walk order, and so that no un-walked stretch can
ever be paid out of the Mining Reserve.

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

The loop advances the mine before it asks, and asks whatever that advance reported.
`graduate_market` refuses a mine that is still behind with `SyncBehind`, so a mine this tick could
not catch up is deferred to the next tick — counted as `chain.graduation_deferred`, not as a
failure — and that refusal is the **program's own verdict**, which is why the loop reacts to it
(`isSyncBehindError`) instead of predicting it from its own model of the ledger. Predicting it is
what used to stall: a mine with no power to divide a block reward by owes nothing, so
`advance_mine` answers `CaughtUp` without moving the cursor, and a keeper that read that untouched
cursor as "still behind" deferred on every tick and never formed the pool. `mineLedgerCanMove`
mirrors the program's short-circuit for exactly that case, and a wasted transaction is an
acceptable price for never stalling a graduation the program would allow. When graduation does
land, the loop re-reads the mine once: the row it wrote earlier describes the curve, and after
graduation the liquidity, and therefore the price, the venue and the reserves the API serves,
lives in the pool.

## 4. Curve-phase mining (spec: mining works from the launch block)

Mining used to start at graduation: `launch_token` wrote `MineStatus::Launching` and nothing
was ever paid until `graduate_market` flipped the mine to `MiningActive`. It now starts at the
launch block, and the blocks it pays before graduation are paid out of the **market's own
bonding-curve token inventory** rather than out of the mine's Mining Reserve. That is the whole
point of the change: a mined token moves the curve exactly where a bought one moves the token
side of it, so mining is priced by the market instead of being invisible to it.

### The two ledgers

`apply_curve_mining_debit` is the only thing in the program that may shrink a market's
`token_reserve` for a reason other than a buy, and it is written the same way the reserve and
pool ledgers are:

| Guard | Rule |
| --- | --- |
| Graduated market | `MarketGraduated`. The curve is closed for good once the pool exists. |
| Zero amount | `InvalidAmount`. |
| Cap | `cumulative emission + amount <= curve_mining_cap`, else `CurveMiningCapExceeded`. |
| Inventory | `amount <= market.token_reserve`, else `InsufficientLiquidity`. |
| `CurveDebit::AdminWithdraw` | Always `CurveWithdrawForbidden`, for every amount. |

There is no admin, guardian, creator or keeper arm, and no instruction reaches the emission
arm: the only caller is the mining ledger walk (`sync_mine_with_budget`), and
`nothing_but_a_settled_mining_emission_can_debit_the_curve` pins both halves of that.

### The cap

`LaunchMarket` carries the curve-mining ledger, appended after its layout version byte:
`curve_mining_cap`, `curve_mining_mined`, `curve_mining_unpaid` and
`curve_mining_block_reward`. The cap is `curve_mining_bps` of the token inventory the curve
actually started with, validated at launch against `MAX_CURVE_MINING_BPS` (10%; the launch
default is 5%), and **no instruction writes it after that**. `migrate_account` can only ever
default the whole ledger to zero, so a legacy market can never be handed an allowance it was
not launched with. `only_launch_token_ever_writes_the_curve_mining_budget` greps every handler
for a write to the cap, the rate or the mined total; the only writer of the mined total is the
ledger itself, and the only writer of the unpaid total is that ledger plus the payout that
clears what it pays.

`curve_mining_block_reward` is the cap spread over the launch runway
(`curve_mining_runway_days`, 30 by default), rounded up so the budget is always finishable. It
is deliberately **not** the mine's own block reward and not the reserve-runway schedule: a
reserve-sized reward would spend a 5% budget in hours, and an epoch step-down would make the
cap's end unpredictable. Rounding up can only make the last block smaller, because every block
is clamped to the room left.

### A runway has to be a schedule, not one block

Because the rate is `cap / runway_blocks`, a launch whose runway holds a single block would
emit the whole cap at block one: one cliff in the curve's inventory, no price path, and a budget
gone before anyone could mine it. `validate_launch_args` therefore requires a runway of at
least `MIN_CURVE_MINING_BLOCKS` (48) whenever `curve_mining_bps > 0`, and rejects the launch
with `InvalidCurveMining` otherwise. A launch that asks for no curve share has no runway to
bound and is still accepted. `shared/curve.ts` mirrors the bound as
`CURVE_MINING_MIN_BLOCKS` / `curveMiningRunwayIsValid`, and
`a_curve_budget_needs_a_runway_of_more_than_one_block` pins it.

### The ledger debits what the index owes, and nothing else

A segment's budget is the flat rate times the blocks it covers, clamped to the room left under
the cap — but the amount the curve actually gives up is what the **reward index** can pay out of
it. The index divides a segment's budget by the mine's total power and truncates, so a remainder
can be owed to nobody at all. The walk therefore debits
`index_owed(reward_index_after) - index_owed(reward_index_before)` — the cumulative index's own
owed amount — which carries the index's remainders forward instead of approximating them.

That matters twice over. Every base unit that leaves the curve's inventory is a base unit some
position can claim, so `curve_mining_unpaid` is never over-provisioned; and the remainder stays
in `token_reserve` — curve inventory, which `graduate_market` moves into the pool with the rest.
Debiting the whole clamped budget instead would park the remainder in `curve_mining_unpaid`,
where it would read as claimable for the rest of the market's life and then be stranded in the
market vault at graduation, because graduation deliberately leaves the unpaid part behind. The
cap's room is still the hard bound on every debit, so the clamp can only ever leave behind the
last base units of a cap that ran out. `the_curve_debits_exactly_what_the_index_owes` pins the
identity and the conservation, and the `--curve-phase` simulator checks it end to end.

### The cap's room is not the only bound: the inventory has to cover it

The cap is a promise about a launch's own token inventory, and a buy takes inventory out of the
curve, so a market can be left holding less than the cap still allows. `curve_mining_room` — the
room every debit is clamped to — is therefore `min(cap - mined, token_reserve - 1)`, and the walk
clamps each segment to it before the index is advanced. That ordering is what makes the clamp
exact: the index is only ever credited what the ledger then debits, so a segment the inventory
cannot cover credits nothing and pays nothing.

Without it the debit could be refused for liquidity, and a revert there is permanent: the walk can
never get past the segment it cannot pay, so `advance_mine`, every claim, every assignment and
`graduate_market` itself fail forever behind it. What the inventory cannot cover is never emitted
and never booked — it is not in `curve_mining_mined` (nothing left the curve) and deliberately not
in `curve_mining_unpaid` (a position can claim that total, and there would be nothing behind it).
The cursor still consumes those blocks, exactly as it does for a spent cap, and the phase closes:
`curve_mining_is_open` is derived from the room, so a market with nothing left to emit into reads
as closed rather than as open with an empty budget.

The last base unit of the inventory is reserved rather than emitted, because graduation requires
the market to have something to move: a walk that drained the curve to zero would leave a market
that can never graduate, which is the same deadlock one step later. A buy already holds that
invariant (it may never take the last base unit), and so does this debit. The reserved unit stays
curve inventory, so it seeds the pool with the rest of what was never sold.
`a_walk_whose_curve_inventory_cannot_cover_its_cap_emits_what_is_there_and_closes` pins the whole
path — walk completes, phase closes, conservation holds, graduation still works — and
`the_curve_room_is_never_more_than_the_curve_holds` pins the clamp itself.

`shared/curve.ts` mirrors the cap ledger but not the inventory bound: it can report a market as
open while the program has closed it. The program's own answer is on the mine,
`Mine.curve_mining_open`, which `worker/chain.ts` already decodes on every sync — the off-chain
status and index should follow that flag rather than re-deriving the phase from the cap alone.


### Which side pays, and what stops

The walk decides per segment from the mine's own phase — never from whether the optional market
account happened to be handed over. `Mine` carries two appended flags, both mirrored from the
market by every instruction that holds it and refreshed by the walk at both ends: `graduated`
(which side pays) and `curve_mining_open` (whether the curve's cap still has room). A third
appended field, the graduation cursor `curve_phase_ends_at`, records when that phase ended.

| Phase | Source of a block | Stop condition |
| --- | --- | --- |
| before the graduation cursor, cap has room and the inventory covers it | the curve's token inventory (`CurveDebit::MiningEmission`) | the cap runs out, or the inventory can no longer cover the emission |
| not graduated, cap spent or never granted, or nothing left to emit into | nothing | curve-phase emission stops until graduation |
| graduated and past the cursor | the Mining Reserve (`ReserveDebit::MiningClaim`) | the reserve runs out |

The cursor is read before the flag, because a block that landed before it is curve-phase whatever
`graduated` says now: `graduate_market` walks the ledger to that instant before it flips
anything, so the two only disagree on an account whose flag was set without the walk. Those blocks
pay nothing — the curve's inventory has moved into the pool by then and its cap is frozen at
graduation — rather than draining the reserve with emission the curve phase never made.
`a_graduation_cursor_keeps_pre_graduation_blocks_off_the_reserve` pins it, reserve balance
included, and the walk itself is pinned by
`graduation_walks_the_curve_phase_before_it_ends_it`,
`graduation_behind_a_bounded_walk_is_retryable_and_lands_where_a_full_walk_lands` and
`graduation_conserves_the_curve_inventory_and_leaves_the_reserve_alone`.

A spent cap is **idle, not finished**: `FullyMined` still means what it always meant — there is
nothing left to pay — and a curve-phase mine whose budget is gone keeps its whole Mining Reserve
and is switched back on by graduation. Graduation is the only thing that moves a mine from one
side to the other, which is why the phase is re-derived on every read rather than stored as a
decision. Two consequences are worth spelling out, because both were bugs once:

- **The cursor still moves while the mine is idle.** A segment with no room on its side is
  consumed: the cursor advances past the blocks that landed while nothing could pay them, and
  they accrue nothing. If it stopped instead, the whole idle stretch would be paid out of the
  Mining Reserve in one go the moment the market graduated — the same wrong-side payout in a
  slower shape. `sync_is_complete` says so explicitly: pre-graduation, a walk holding the mine
  and its market is never complete until the cursor has reached the present.
- **`market.is_some()` is not a phase test.** A spent cap and a graduated market both clear
  `curve_mining_open`, so a walk that fell back to the reserve whenever the market account was
  missing paid curve-phase blocks out of the Mining Reserve — the whole reason the `graduated`
  mirror exists. The source now comes from the graduation cursor first, then `Mine.graduated` (or
  the market's own flag, when the market is held), and a pre-graduation walk without the market
  can only ever answer `SyncBehind`: a retryable refusal, never a payout.
  `a_spent_cap_stays_idle_and_never_falls_through_to_the_reserve` pins it, reserve balance
  included.

### Who has to pass the market

The walk needs the market to know which side pays, so the instructions that settle a position
carry it:

| Instruction | Market |
| --- | --- |
| `advance_mine` | required, `has_one = mine` |
| `claim_rewards` | required, `has_one = mine` |
| `sync_crew_power` | required, `has_one = mine` |
| `assign_power`, `remove_power` | required, `has_one = mine` |

The market is not optional anywhere, including on `assign_power` and `remove_power`: their market
is pinned to the mine by `has_one` rather than by a seed, because the market's own seed is the mint
and an Anchor account set cannot derive a PDA it was not handed. `buildAssignPowerInstruction` and
`buildRemovePowerInstruction` take the mine's **mint as a required parameter**, derive the market
from it with `deriveMarketPdaSync` and append it unconditionally, so no caller can build a
pre-graduation sync the program can only refuse. `assignPowerOnChain` in `src/solanaProgram.ts`
and the keeper's builders all pass it.

`shared/program.test.ts` pins both account lists against `AssignPower` in declaration order, and
`src/solanaProgram.assign.test.ts` drives the real client path against a stubbed RPC and decodes
the transaction the wallet actually submitted, so the market is asserted where it matters rather
than where it is derived.

A walk that still arrives without a market is safe rather than free, and there is no instruction
left that can arrive that way. `sync_is_complete` answers only for the reserve phase when the
market is missing, so a non-graduated mine proceeds and is refused with `SyncBehind` — the same
retryable answer it gives when it is behind — whatever its cap state is. "The curve is closed" is
deliberately not a conclusion a market-less walk may draw: a spent cap used to read as a settled
ledger, and it is exactly the mirror that a walk must not decide from.
`the_market_is_a_required_account_on_every_walk_that_settles_a_position` pins the account sets and
`a_spent_cap_stays_idle_and_never_falls_through_to_the_reserve` the refusal.

### Claims pay from the vault that emitted

`claim_rewards` pays `min(amount, curve_mining_unpaid)` out of the market vault and the rest
out of the reserve vault. Curve emission is strictly older than reserve emission (the curve
phase ends at graduation), so the oldest unpaid tokens are the curve's, and the aggregate split
is exact even though a position's `pending_reward` is a single number. Both transfers are
signed by the mine PDA, which is the authority of both vaults.

### Conservation through mining, trading and graduation

The vault holds the curve's inventory plus the tokens mining has emitted and nobody has claimed:

```
tokens in the curve + mined out + sold to buyers - bought back == the launch inventory
```

`curve_mining_unpaid` is exactly the mined-but-unclaimed part, and `graduate_market` requires
the market vault to hold `plan.tokens + curve_mining_unpaid` before it moves
`plan.tokens` — the **post-mining** curve inventory — into the pool. So graduation seeds the LP
with a curve that has already paid its miners, and the tokens a position has been credited with
stay in the vault to be claimed. `graduation_moves_exactly_the_reserve_amounts` and
`curve_mining_conserves_the_curve_inventory_through_trades_and_graduation` pin both halves.

### Solvency: mined tokens bring no SOL

None of this adds a lamport to the curve. `sell` is still capped by the real SOL reserve minus
rent (`available >= sol_out + fees_after`, and `quote_sell` itself caps the gross at
`sol_reserve`), so pre-graduation sell capacity is what buyers have put in and nothing else.
`mining_never_adds_sell_capacity` tests that, and `shared/curve.ts` `curveSellCapacity`
exposes the same number read-only for the UI:

```ts
curveSellCapacity(market) // { realSolLamports, tokensForFullCapacity | null }
```

with `tokensForFullCapacity = sol * tokens / virtual` (null when the curve has no virtual SOL
reserve, where the real reserve can only be approached asymptotically). The API reports it as
`sellCapacity: { sol, tokens }`.

### What a client is told

`worker/chain.ts` reports a curve-phase mine as `MINING_ACTIVE` while its budget has room, and
as `CURVE_CAP_REACHED` once it is spent: **idle, not finished**. That distinction is load-bearing,
not cosmetic. The indexing loop's re-read set is `status != 'FULLY_MINED' OR venue != 'pool'`,
and that pass is the only thing in the Worker that ever notices a curve reaching its graduation
target — so a spent-cap market written as `FULLY_MINED` was never read again, never graduated,
and never paid another block. `FULLY_MINED` is now written only where the program itself says it:
a graduated market whose Mining Reserve has run out. `worker/mining.ts` never writes it over a
curve-phase mine either (a spent curve budget leaves `emissionSource: "CURVE"` until
`venue = 'pool'`), and the off-chain walk credits nothing over an idle stretch while keeping the
cursor current.

The status lives in the `tokens` table, which carried a `CHECK` constraint from
`0001_initial.sql`, so `migrations/0020_curve_cap_reached.sql` widens it. That migration
rebuilds the table (SQLite cannot alter a `CHECK` in place), stashing the rows in a scratch
table, dropping the old one and copying them back into a rebuilt `tokens` so the one foreign key
that points at it (`trades.mint`) still resolves at commit; it runs under `PRAGMA
defer_foreign_keys`, never `PRAGMA foreign_keys = OFF`, which D1 refuses inside a migration
transaction.

Finally, a market that **never had a budget at all** — launched with a zero share, or written
before the curve ledger existed, where a migration can only ever default the cap to zero — is
reported with `curveMining.disabled = true`. It is the same idle state to a miner, but a
different sentence to a player: mining is not paused there, it starts at graduation.

## 5. Account versioning and migration

`ProtocolConfig`, `Mine` and `LaunchMarket` each carry an appended `version: u8`, currently
`ACCOUNT_VERSION = 4`. Appended is the operative word: the byte sat after every field that
existed when it was introduced, so an account written before it still decodes for every other
field and reads back as version 0.

Version 2 added the curve-mining ledger to `LaunchMarket` and the curve-phase flag to `Mine`,
version 3 added the `graduated` mirror to `Mine` after it, and version 4 added the graduation
cursor `curve_phase_ends_at` after that. Every one of them goes **after** the version byte:

```
... bump, version, curve_mining_cap, curve_mining_mined, curve_mining_unpaid, curve_mining_block_reward
... bump, version, curve_mining_open, graduated, curve_phase_ends_at
```

That ordering is the reason a version 1 account still decodes at all. Borsh reads fields in
declaration order, so a field appended *before* the version byte would take the version byte's
own byte as its first byte and shift everything after it; appended *after* it, a legacy account
simply runs out of data and reads each new field as its safe default. Two of those defaults carry
real weight:

- **A legacy market reads as a zero budget.** No curve emission at all until it graduates, which
  is the pre-curve behaviour. A migration can therefore never hand a legacy market an allowance
  it was not launched with — but it also means pre-graduation mining is genuinely off for every
  market that predates the ledger, not merely unmeasured. That is surfaced rather than hidden:
  `worker/chain.ts` (and the mine-info payload) reports those markets with
  `curveMining.disabled = true`, `cap = 0` and `onCurve = true`, so the UI says "mining starts at
  graduation" instead of drawing an empty progress bar over a budget that was never granted.
- **A version 2 mine reads as `graduated = false`.** Which is the safe default rather than the
  permissive one: a walk handed no market then refuses pre-graduation work with `SyncBehind`
  instead of reaching for the Mining Reserve.
- **A version 3 mine reads as `curve_phase_ends_at = 0`.** Zero means no cursor, so the phase
  follows `graduated` alone — the behaviour that account was written under. A migration cannot
  invent a graduation instant, and inventing one would be the unsafe direction anyway: it would
  classify a stretch as curve-phase that may already have been paid from the reserve.

`migrate_account` still upgrades in place and still cannot write anything but these defaults, so
the widening is one-directional in exactly the way section 4 relies on.

`the_version_byte_marks_where_a_legacy_layout_ended` pins the shape — the version byte's offset
in both layouts, `LaunchMarket::INIT_SPACE`, and that a legacy account of either kind decodes
with every field added since at its default. It replaces the older
`version_is_appended_after_every_existing_field` test, whose premise (that the version byte is
the last byte of the account) is exactly what version 2 changed.

Adding a field to an Anchor account is not a no-op. A legacy account is one byte short, so
`Account<Mine>` cannot deserialize it and every instruction that touches it fails until it has
been reallocated. That is what `migrate_account` is for.

### migrate_account

- **Guardian-only.** Its account set is the guardian signer, the protocol config read from raw
  bytes, and the target account. There is no mint, no token account, no vault and no system
  program in it.
- **Byte-preserving.** It snapshots the account, reallocates it to the current size, and
  rewrites the buffer from `upgraded_account_data`: the account's own values re-serialized
  with only the fields appended after the version byte set to their safe default. Borsh is
  deterministic, so every field that already existed keeps its exact bytes — no balance,
  reserve, fee bucket or timestamp can move. The version byte itself is the single byte a
  migration rewrites, which is what it is for. The account's own values are read back, never
  recomputed from lamports. The snapshot is padded to the account's full *new* size rather than
  by a fixed slack, because how many bytes a legacy account is missing is a property of the
  current layout: a version 1 market is 33 bytes short of a version 2 one.
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

## 6. Tests

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
  `the_version_byte_marks_where_a_legacy_layout_ended` — the migratable kinds, and the shape a
  later layout change has to keep: the version byte marks where version 1 ended, every field
  added since sits after it, and both a legacy market and a legacy mine decode with each of those
  fields at its safe default (a zero curve budget, no curve phase, no graduation cursor).
- `a_mining_debit_moves_the_token_side_exactly_like_a_buy` — the economic claim of section 4:
  the debit takes exactly the tokens a buy of the same amount would take off the curve, with the
  same price effect on the token side and no SOL movement at all, and the same SOL buys exactly
  the ratio of tokens it did before.
- `curve_mining_can_never_pass_the_cap_however_many_blocks_it_takes` — a cap split into 143
  uneven blocks lands on the cap exactly and one base unit more is refused, and even under its
  own cap a debit can never take more than the curve holds.
- `only_launch_token_ever_writes_the_curve_mining_budget` — no other handler writes the cap, the
  rate or the mined total, and a migration can only default the ledger to zero.
- `nothing_but_a_settled_mining_emission_can_debit_the_curve` — the admin arm is rejected for
  every amount including `u64::MAX`, a graduated market may not emit at all, and no instruction
  reaches the emission arm: only the ledger walk does.
- `mining_never_adds_sell_capacity` — the real SOL a seller can take is unchanged by emission,
  and no token amount, however large, is ever quoted above it.
- `curve_mining_conserves_the_curve_inventory_through_trades_and_graduation` — the conservation
  identity of section 4 through buys, sells, mining and graduation, with the mined-but-unclaimed
  tokens left in the vault and the cap unchanged.
- `the_walk_emits_from_the_curve_until_the_cap_is_spent` — the walk pays out of the curve at the
  launch-time rate, never touches the Mining Reserve before graduation, marks a spent cap idle
  rather than finished, and hands the mine back its own reserve once the market graduates.
- `a_walk_without_the_market_refuses_an_open_curve_phase` — the refusal that keeps
  `assign_power` and `remove_power` from ever paying a curve-phase block out of the wrong side,
  and the proof that a graduated mine still walks its reserve without the market.
- `a_spent_cap_stays_idle_and_never_falls_through_to_the_reserve` — the regression section 4 is
  built around: with the curve's cap spent, walking the mine with the market and without it both
  leave `remaining_reserve` untouched (the reviewer's probe was a reserve that fell by ~2M base
  units), the idle blocks are still consumed so they cannot be paid out of the reserve after
  graduation, and graduation is what makes the reserve pay.
- `graduation_walks_the_curve_phase_before_it_ends_it` — the regression section 3 is built
  around: a mine left un-walked for an epoch and then graduated pays that whole stretch out of the
  curve's cap, leaves `remaining_reserve` exactly where it was, and seeds the pool with the
  post-mining inventory only.
- `graduation_behind_a_bounded_walk_is_retryable_and_lands_where_a_full_walk_lands` — a mine 200
  epochs behind is refused with `SyncBehind` with no flag and no cursor moved, is caught up by
  the same bounded calls `advance_mine` makes, and then lands on the ledger one unbounded pass
  produces.
- `graduation_conserves_the_curve_inventory_and_leaves_the_reserve_alone` — conservation through
  the phase change with the cap spent before graduation: the idle stretch pays nothing from either
  side, the pool and the vault still hold the launch inventory between them, and the curve's ledger
  is frozen where graduation left it.
- `a_graduation_cursor_keeps_pre_graduation_blocks_off_the_reserve` — a mine whose `graduated`
  flag was set without the walk still classifies every block before the cursor as curve-phase, so
  they pay nothing and the reserve is untouched, while the blocks after it are the reserve's
  exactly as before.
- `only_launch_and_graduation_write_the_graduation_cursor` — `launch_token` starts the phase
  with no cursor and `graduate_market` records the instant it ended; no other instruction writes
  it, so the classification cannot be forged by a caller.
- `the_curve_debits_exactly_what_the_index_owes` — the ledger identity: the debit is the index's
  own owed amount, so every base unit that leaves the curve is claimable, the curve's inventory
  is conserved, and graduation moves the unowed remainder into the pool instead of stranding it
  in the market vault.
- `a_curve_budget_needs_a_runway_of_more_than_one_block` — the review's one-day-row case: a
  one-day block interval with a one-day runway is refused, one block short of
  `MIN_CURVE_MINING_BLOCKS` is refused, the bound itself spreads the budget over every block it
  was given, and a zero share is still legal.
- `launch_validation_bounds_the_curve_share_and_its_runway` and
  `the_curve_runway_spreads_the_cap_over_the_launch_days` — the share ceiling, a legal zero
  share, and the runway arithmetic that turns a 5% budget into a month of rewards instead of the
  hours a reserve-sized reward would spend it in.
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
and the curve-phase work extended them: `decodeMine` reads the curve-phase flag and
`decodeLaunchMarket` the four ledger fields, both through trailing `tryU64` / `tryBool`
reads so a legacy account returns the same safe defaults the program would, and the builders
that the walk instructions now need a market for derive it synchronously
(`deriveMarketPdaSync`, `deriveMarketVaultPdaSync`) from the mint the caller already holds.
`buildClaimRewardsInstruction` appends both, `buildSyncCrewPowerInstruction` appends the
market, `buildAssignPowerInstruction` / `buildRemovePowerInstruction` require the mint and append
the market derived from it, and `buildAdvanceMineInstruction` needs one of them and says so rather
than building a transaction the program will reject. No builder can be talked out of the market
account, which is what keeps a pre-graduation sync from coming back `SyncBehind`.

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

## 7. Follow-ups this document tracked

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
   `worker/indexing.ts` and only when the fresh chain read says there is something to do — after
   that tick's `advance_mine` reports the ledger is current, since `graduate_market` walks the
   mine itself and refuses a mine that is behind. The pass re-reads the mine once graduation has
   landed, so the row describes the pool rather than the curve it just replaced. See section 3.
4. **`src/push.ts` typechecks.** The `Uint8Array` / `BufferSource` mismatch is fixed, so the
   notification path compiles under the same gate as everything else.
5. **`scripts/onchain/` is covered by a tsconfig.** `tsconfig.node.json` includes `scripts`, so
   `npm run typecheck` and `npm run lint` see those scripts.

The curve phase followed the same path, and its own follow-ups are recorded here for the same
reason — a reader should not have to guess whether the program's new source of block rewards is
actually priced, indexed and displayed:

6. **`worker/chain.ts` mirrors the ledger.** `buildSyncedToken` reports `curveMining` (open,
   on-curve, cap, mined, remaining, progress, per-block reward, unpaid) and the read-only
   `sellCapacity` straight off the decoded market, and `syncTokenWithVenue` persists them.
   Migration `0019_curve_mining.sql` adds the columns, and `worker/tokens.ts` maps them back
   into the API's `TokenSummary`. The tokens cache key was bumped to `tokens:v3:1000` so a
   payload cached by an older revision cannot be served as a complete summary.
7. **The off-chain index follows the same rule.** `worker/mining.ts` reconciles the emission
   source on every load (`reconcileEmissionSource`): a mine on its curve index spends the
   launch-time cap at the flat launch-time rate, a graduated one spends its Mining Reserve on the
   reserve runway, and the switch re-bases the budget exactly once, leaving the reward index and
   every position cursor untouched. `worker/keeper.ts` hands the market to `advance_mine` and
   stops purging a mine the program cannot source a block for (a spent cap is not "behind").
8. **The price the index samples is the post-emission price.** `worker/indexing.ts` samples the
   venue's spot price from a fresh account read, so a block the ledger just emitted is already in
   it — and it asks the oracle for external corroboration based on the **venue**
   (`chainToken.venue === "pool"`) rather than on the token status, because a curve-phase mine
   with a spent budget has no external market at all.
9. **Graduation leaves the mined-but-unclaimed tokens behind**, and the API says so
   (`curveMining.unpaid`), which is what lets a claim made after graduation still be paid out of
   the vault that emitted it.
10. **An idle curve-phase mine keeps being synced.** This is the follow-up the review found
    missing: the loop's re-read set used to be `status != 'FULLY_MINED'`, and a spent cap was
    written as `FULLY_MINED`, so the mine was never re-read, never graduated and never paid
    again. `CURVE_CAP_REACHED` (migration `0020_curve_cap_reached.sql`) plus the
    `OR venue != 'pool'` clause in `queueEpochSync` is the fix, and `worker/mining.ts` was the
    second writer that had to stop calling a curve-phase mine finished.
11. **Callers pass the market.** `buildAssignPowerInstruction` / `buildRemovePowerInstruction`
    now require the mint and append the market derived from it, and the call sites in
    `src/solanaProgram.ts` (which already hold the mint) pass it, so a pre-graduation assignment
    on an open curve phase settles instead of being refused with `SyncBehind`. The account list
    is pinned against `AssignPower` in `shared/program.test.ts`, and the submitted transaction in
    `src/solanaProgram.assign.test.ts`.
    The program now requires it too: `AssignPower`'s market is a required account pinned by
    `has_one = mine`, so there is no walk left that has to decide a phase without the ledger that
    holds it — and the branch that read a spent cap as a settled ledger went with it.
12. **The list API carries `curveMining.disabled` too.** `worker/chain.ts`, the mine-info payload
    and `worker/tokens.ts`'s `mapToken` all report it, off the same `isCurveMiningDisabled` rule,
    so the cached token list no longer relies on a client re-deriving `cap == 0 && onCurve`.

## 8. Invariants this document relies on

- Real money never buys Mining Power or ORE.
- ORE is non-transferable.
- Reserves leave only through a valid mining or discovery claim; `apply_reserve_debit` has no
  other permitted arm.
- A market's curve token inventory leaves through exactly three doors: a buy, a settled mining
  emission while the curve phase is open and under its immutable launch-time cap, and graduation
  moving the post-mining inventory into the pool. `apply_curve_mining_debit` has no other
  permitted arm, and mining never brings a lamport with it.
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

## 9. Resumable mining sync (advance_mine, SyncBehind)

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
them. `graduate_market` refuses the same way for a different reason: it is what ends the curve
phase, so it walks the mine to the present first and answers `SyncBehind` while the mine is
further behind than one call can cover — otherwise the un-walked stretch would be paid out of the
Mining Reserve rather than the curve it landed under. Recovery needs no privileged key:

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
no mirror update for the refusal itself: the `advanceMine` discriminator it already exports is
enough to build the recovery call. What a client does need to handle is the new error, because a
claim that used to be impossible now fails with a retryable answer that anyone can clear.

The layout that did change is Mine's, in the same append-only way: version 4 adds the graduation
cursor `curve_phase_ends_at` after the phase flags, so `shared/program.ts` decodes it
(`decodeMine`'s trailing `tryI64`, `ACCOUNT_VERSION` 4) and a version 3 account reads it as
zero, which is the phase following `graduated` alone. `migrate_account` restamps the version and
defaults the new field without touching a byte that already existed.

Two properties keep the per-call cost bounded rather than proportional to how long a mine was
idle. Launch validation forces `epoch_length >= block_interval` (`validate_launch_args`), which
is what holds the epoch rollover loop to at most one iteration per segment; and the walk refuses
a stored schedule with a non-positive `block_interval` or `epoch_length` (`InvalidSchedule`)
rather than looping on a cursor that cannot advance.

The number of calls a catch-up needs is the elapsed epochs divided by `MAX_SYNC_SEGMENTS` (64),
which for a mine on the default one-week epochs is roughly one call per year of backlog. A mine
launched with the shortest legal epoch (60 seconds) needs far more calls, all permissionless and
each one cheap; the constant is the knob if a wider single-call window is ever wanted.
