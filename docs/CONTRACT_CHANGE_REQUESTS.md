# Contract change requests

Append-only. One line per request, written by the worker that needs the change, never applied by
that worker. A request here is not a decision; the integrator decides and then amends the contract
in programs/diggo-protocol/CONTRACTS.md.

WS-F (frontend), 2026-09-23:

- **CCR-F1 — the discovery opportunity's window index.** `DiscoveryOpportunity` is seeded on `[b"opportunity", coin, owner, window_index]`, and `CreateDiscoveryRoll` derives it from `player.roll_window` as the account stands *before* the handler runs, while the field's own doc says "the window the last roll was created in". Those two readings differ by one, so the client cannot derive the PDA without guessing. Please have WS-C pin which value the seed uses and state it in CONTRACTS.md. WS-F currently follows WS-D's builder doc (`windowIndex = player.roll_window`) for the create and probes `roll_window` and `roll_window + 1` when *reading* a pending opportunity, so the UI works either way — but a pinned answer removes the probe.
- **CCR-F2 — the crank-pool share of a trade fee.** `Coin` snapshots `creator_fee_bps` and `platform_fee_bps`, while `ProtocolConfig` carries a third `crank_pool_fee_bps`. It is not stated whether a trader pays all three or whether the crank-pool share is carved out of the platform share. The client assumes the trader pays all three, which is the conservative direction (a larger assumed fee only lowers the floor it sends, so a trade can still be filled but cannot be under-protected). Please pin the order of operations in CONTRACTS.md so the quote and the program cannot disagree once `crank_pool_fee_bps` is ever non-zero.
- **CCR-F3 — an indexer enumeration of sponsor events.** There is deliberately no on-chain registry that lists sponsor events: they are PDAs keyed on `(vault, event_id)`. A creator therefore cannot discover that an active `LaunchRentSubsidy` event covers their launch, and the "Sponsored" badge the brief asks for has no source. WS-F consumes `GET /api/sponsors/events` (all active events) and `GET /api/sponsors/:owner/events` (one vault's), and re-reads each event on chain before believing it. Please have WS-E own and publish those payload shapes; until then the launch form degrades to "the creator pays", which is the honest default.
- **CCR-F4 — the quote mirror has no owner.** Design 8.4 assigns `quote_buy` / `quote_sell` to `shared/curve.ts` and its Rust counterpart to `math/curve.rs`, but `shared/curve.ts` is still the v4 curve-mining module and no one has published the v2 quotes. WS-F has written `src/onchain/quotes.ts` as a stopgap so the trade form can derive a slippage floor at all. It should be deleted in favour of a `shared/curve.ts` mirror owned by WS-B, with WS-G pinning it against Rust-generated vectors as 8.4 requires. The functions WS-F calls are `quoteCurveBuy`, `quoteCurveSell`, `quotePoolBuy`, `quotePoolSell`, `splitFees` and the two spot-price helpers.
- **CCR-F5 — `math/curve.rs` has no v2 curve-table reader exported.** Not a layout change, just a request for WS-B to confirm the launch defaults the client should send for `reserve_bps` and `discovery_reserve_bps`: `DEFAULT_RESERVE_BPS` and `DEFAULT_DISCOVERY_RESERVE_BPS` exist in `constants.rs` but are not re-exported by `shared/program.ts`, so `src/constants.ts` restates them (500 and 50) with a comment. Re-exporting them would let the launch form read one source.

Not a request, for the record: `shared/curve.ts`, `shared/curve.test.ts` and `shared/economics.ts` currently fail `tsc -b` (`DecodedLaunchMarket` no longer exists; `crewTotalLevel` is exported by both `shared/crew.ts` and `shared/discovery.ts`). Those files belong to WS-A and WS-B, so WS-F left them alone.

---

# Resolutions

INTEGRATION-1, 2026-09-23. Every row a phase-1 workstream raised is decided below: RESOLVED means
the change is in the tree, REJECTED means the contract stays as it is and the reason is recorded.
The rows numbered 1-27 were raised by WS-A, WS-B and WS-C against the spine and their exact prose
survives only as the orchestrator's digest, so each is named here by the defect it describes
rather than quoted. Rows F1-F5 are WS-F's, quoted in the section above.

## The rows

| Row | Defect | Decision |
| --- | --- | --- |
| 3 | A single stored index cannot hold the starter tranche to 10% of a block exactly | **RESOLVED**: Coin carries two indexes, bonded_index and starter_index. See *The two-index tranche* below |
| 5 | remove_power demanded a prior claim and reported it as NothingToClaim | **RESOLVED**: new variant UnclaimedRewards (6096) is returned instead |
| 6 | curve_table was only honoured in upgrade_crew | **RESOLVED**: write_curve_table and the reader in math/power.rs are the same table; CONTRACTS.md now says the override is read by every curve consumer, and the account is boxed |
| 7 | activation did not gate an armed position: an expired window kept accruing | **RESOLVED**: the settle is gated by the half-open window and forfeits to the emission source. See *The activation gate* below |
| 11 | SBF stack-frame warnings on SetCurveTable and Account of CurveTable | **PARTIAL**: ClaimRewards is fixed by boxing its Coin; the four CurveTable frames remain and are recorded as a Phase 2 item with the two shapes that close them |
| 11-18 | mint is 355 bytes, not the 359 the contract quoted | **RESOLVED**: MINT_V2_SIZE is derived from the metadata caps and equals the maximal settled size. See *The mint size* below |
| 11-18 | initialize_protocol must prove the caller is the upgrade authority via ProgramData | **ALREADY RESOLVED** in the spine: InitializeProtocol takes the program and its ProgramData and compares upgrade_authority_address. CONTRACTS.md now states it as a requirement of the deployment order |
| 11-18 | sponsor accounts were missing on the trade paths | **RESOLVED**: the fee-waiver sponsor path is on the trade instructions and pays the platform share from the vault; the account lists are in CONTRACTS.md |
| 11-18 | the third fee bucket (crank_pool_fee_bps) had no stated order of operations | **RESOLVED**: a trader pays creator + platform + crank-pool, and the crank-pool share is carved out of the platform share at accrual, not added to the trader's cost. CONTRACTS.md states it, so a quote and the program cannot disagree |
| 11-18 | unpause reported NotTimelocked | **REJECTED**: the pause window is itself the timelock, so NotTimelocked is the honest variant and a new one would shift a frozen error block for no client benefit |
| 11-18 | DEFAULT_VIRTUAL_SOL_BPS was not published | **RESOLVED**: launch.rs declares it (3,500 bps of the graduation target) and CONTRACTS.md lists it as the derived launch parameter it is |
| 11-18 | pool frame hazard | **RESOLVED**: the pool is boxed wherever it is held next to a Coin |
| 11-18 | the release profile had no opt-level | **RESOLVED**: opt-level = "z" with overflow-checks, fat LTO and one codegen unit. See *The release profile* below |
| 19-27 | the single-index tranche cap only holds while starter_power * E * (BPS - T) <= bonded_power * BPS^2 | **RESOLVED** by the two-index shape, which holds the cap for every pair of powers |
| 19-27 | WS-A and WS-C had two different starter_index derivations (one divided twice) | **RESOLVED**: there is no derivation left. tranche_index in math/index.rs is the one definition, state/player.rs has none |
| 19-27 | there was no PRICE_SCALE constant shared by the price paths | **RESOLVED**: PRICE_SCALE in math/curve.rs is the only scale; DISCOVERY_PRICE_SCALE is deleted |
| 19-27 | GlobalBudget had no close path | **REJECTED** for this phase: a day that is already closed stays closed (is_open_for refuses to reopen it), so the account is inert rather than leaky, and reclaiming its rent is a Phase 2 crank with no economic content |
| 19-27 | there was no on-chain 24h volume | **REJECTED**: the eligibility score reads the coin's own cumulative sol_reserve instead. A rolling 24h window needs a ring of counters on every trade for a score component worth at most 25 of 100 points; the digest is right that the input is missing and wrong that it is worth the layout |
| 19-27 | the roll window was a u16 | **REJECTED**: u16 windows are 179 years of days and the seed derivation hashes the window little-endian, so a u32 would cost two bytes of a frozen layout to move a bound nothing can reach |
| F1 | which window index the DiscoveryOpportunity PDA uses | **RESOLVED**: the seed uses player.roll_window as it stands before the handler runs, and the opportunity stores that same value in window_index. CONTRACTS.md now says so; the client probe can go |
| F2 | the crank-pool share of a trade fee | **RESOLVED**: see the third-fee-bucket row above; the trader pays all three and the crank pool's share is carved out of the platform share |
| F3 | no on-chain enumeration of sponsor events | **REJECTED** on chain: events are PDAs keyed on (vault, event_id) by design, and an on-chain registry would be a second source of truth for a limit the vault already enforces. The enumeration belongs to the indexer, which is WS-E's |
| F4 | no v2 quote mirror in shared/curve.ts | **RESOLVED**: shared/curve.ts now contains the v2 quote helpers `quoteCurveBuy`, `quoteCurveSell`, `quotePoolBuy`, `quotePoolSell`, `splitFees` and the two spot-price helpers; the client imports that mirror |
| F5 | DEFAULT_RESERVE_BPS and DEFAULT_DISCOVERY_RESERVE_BPS were not re-exported | **RESOLVED**: shared/program.ts re-exports both, so the launch form reads one source |
| G | unpause's account struct requires the authority while CONTRACTS.md said anyone | **RESOLVED**: unpause is governance-gated (timelock plus multisig) and CONTRACTS.md now says so. A pause is discovery-only, which is what PAUSE_FLAGS_ALL already meant |
| G | the rent column was wrong for six accounts | **RESOLVED**: the table now quotes (size + 128) * 6,960 for every account, and the contract test pins the formula |
| G | the 15 flows were PENDING | **RESOLVED**: all 15 pass, and the new flows listed at the end of this file were added |
| G | the TypeScript on-chain tests need WSL | **REJECTED** as a contract change: litesvm ships no Windows binary, so the simulator half of the suite is a WSL command. The Rust gate is what runs on every platform |
| B | there was no v2 trade event, so the indexer cannot see the received amounts | **PARTIAL**: RewardsForfeited joins the event set for the settle path, which is the one that was invisible. The trade path still emits nothing: the indexer reads the coin and the trader's token account instead, and a TradeExecuted event is a Phase 2 addition (it needs a fee breakdown field to be worth indexing, and the fee split lives in math/fees.rs rather than in the handler) |
| B | the TWAP was a lifetime average | **RESOLVED**: the discovery payout is normalised by a short window with a deviation guard. See *The short price window* below |
| E | the crank lacks settle_discovery | **RESOLVED as decided**: settle_discovery is permissionless but needs the owner's token account, so the player settles from the UI and the crank plans only what it can complete. plan_coin_crank reports settle_discovery as a plan flag, not as work the crank must do |
| E | the worker still imports shared/economics and shared/config | **NOT MINE**: those exports stay, per WS-E's own note |
| E | worker/v2/program.ts should re-export the WS-D decoders | **NOT MINE**: shared/program.ts is the one source; the worker should import it rather than re-export |
| E | Coin stores no mint, so the first sight costs one RPC | **ACCEPTED**: the coin is keyed by the mint, so storing it would duplicate a seed. Accepted as a client cost |

## The two-index tranche

Coin now carries bonded_index and starter_index, both cumulative and both scaled by INDEX_SCALE. The
walk is their only writer: per segment it splits the block with split_block_reward, advances each
index by its own take over its own power, and debits the emission source by exactly the difference
between what each index owed its whole tranche before and after. The starter take is the tranche's
proportional share clamped to STARTER_TRANCHE_BPS of the block, so the cap holds for every pair of
powers rather than only while an inequality on the two powers happens to hold. When a coin has no
bonded power the bonded take has no power to divide it by, so it is never debited at all: it stays
in the Mining Reserve, which is the amendment's "never burned and never re-assigned".

A position stores the index of its own tranche and settles against that field, so the two
implementations WS-A and WS-C had are gone; math/index.rs is the single definition and
state/player.rs calls it. That is what closes rows 3, 19-27 and the A-versus-C divergence.

Cost: 16 bytes on Coin, which is 111,360 lamports of one-time rent per coin.

## The activation gate

The window is half open, exactly as the worker's isEligibleForBlock has it:
[last_activation_at, active_until). A position earns only while it is open.

The walk cannot see per-position windows and must not have to, so it credits every armed position's
share into outstanding_claims as the index advances, and settle_position_gated enforces the
eligibility at the only moment the program knows who is asking. A settle that finds the window
closed puts the share the index credited to that position since its last settle back where the
block paid it from - the curve's inventory before graduation, the Mining Reserve after it - and
advances the position's cursor, so nothing after active_until is claimable now or later.

That is the off-chain rule (a lapsed position is paused and forfeits its share) with no keeper, no
operator and no extra account. Two things make it work in practice:

1. activate settles the position before it moves the window, so the window the settle sees is the
   one that just ended. Activate therefore takes the armed coin and position as optional accounts
   and refuses to run without them when the player holds a position: a caller must not be able to
   skip the settle and carry the accrual into the fresh window.
2. REACTIVATION_EARLY_SECONDS (3,600) lets the legal re-activation land inside the window it
   closes. Without it the earliest allowed re-activation was exactly one second past active_until,
   which is precisely the settle the gate forfeits - a diligent player would have lost the window
   they just mined.

The residual, stated rather than hidden: a player who lets the window lapse forfeits the accrual of
the whole interval since their last settle, not merely the part after active_until. The interval is
bounded by how long they were away, the tokens never leave the coin, and the honest client - which
activates once per window - never meets the forfeit at all. Removing the residual needs the index
as of an arbitrary past instant, which is index history the coin does not carry; a Phase 2 ring of
index observations is the shape that would close it.

## The short price window

The discovery payout divides a lamport value by the coin's own price. That price used to be a
lifetime average read as cum / twap_last_update_slot, which divides an accumulator that only
started at graduation by an absolute slot number: on a pool a day old it under-reports the price by
five orders of magnitude, and after graduation the marginal reading is unavailable because the
curve's reserves have moved into the pool. The result is not a rounding error, it is a payout in
units that is thousands of times the value class.

Coin now carries twap_last_price, twap_window_slot and twap_window_cum, and Coin::twap_price is the
time-weighted price of the last TWAP_WINDOW_SLOTS (900) slots, anchored by roll_twap_window and with
the slots since the last observation priced at the last observed price. Every slot in the window is
a slot the program watched. The payout takes the higher of the window and the spot, which is the
safe direction in both a pump and a dump, and drops the spot entirely when it deviates from the
window by more than DISCOVERY_TWAP_MAX_DEVIATION_BPS (2,000): past that bound the spot is evidence
of a sandwich around the settlement rather than a price.

Cost: 40 bytes on Coin, which is 278,400 lamports of one-time rent per coin.

## The mint size

The contract quoted 359 bytes for the hand-written Token-2022 mint. 355 is the number the caps
produce: 82 base mint + 1 account type + 68 metadata pointer + a token-metadata entry of
4 TLV header + 32 update authority + 32 mint + (4 + 16) name + (4 + 8) symbol + (4 + 96) uri + 4
additional metadata. MINT_V2_SIZE is now that expression rather than a literal, so a metadata cap
the layout cannot hold is a failing test instead of a mint that cannot be initialised.

The account is still created at MINT_INITIAL_SIZE (151, the base mint plus its account type and the
metadata pointer) because the metadata-pointer extension must exist before the mint does, and
token-2022 reallocs it to the settled size once the metadata is written. For maximal metadata the
settled size is exactly MINT_V2_SIZE, so the four bytes of headroom the old number implied are
gone: the creator funds exactly what the mint settles at.

## The release profile

overflow-checks = true, lto = "fat", codegen-units = 1 and now opt-level = "z". The size-first
level is measured rather than assumed: the .so size and the compute units of the heaviest
instructions are both reported in CONTRACTS.md, and the measurement is what decides between -Oz and
-Os.

## The one remaining row

Row 11 is PARTIAL. Four SBF stack-frame warnings remain, all on Account of CurveTable: the
SetCurveTable try_accounts frame and the three CurveTable deserializers. The account is 2,402
bytes and Anchor's typed Account holds its value inline, so the fix is not another Box - the frame
the checker counts is inside the generic deserializer. The two shapes that close it are
AccountLoader with a zero-copy CurveTable (the layout is already all fixed-size arrays, so the
bytes do not move) or a chunked set_curve_table that writes one component per call. Both are
contract changes with a client cost, and the warning is a static-analysis bound rather than an
observed failure: every instruction that touches the table is governance-gated and no user path
reaches it. It is carried into Phase 2's review list with that reasoning rather than left
unexplained.

## Flows added by this integration

- an expired activation window stops accrual, and activate settles the position before it opens a
  new window, so a lapse cannot be laundered into a fresh index;
- the starter tranche takes exactly its cap on a starter-dominated mine, and the remainder stays in
  the reserve;
- a sandwiched spot cannot move a discovery payout, in either direction;
- the admin surface still cannot withdraw a user balance, a reserve or the pool, re-run against the
  new Coin layout, and the sponsor withdrawal cap still binds (both were already covered by the
  spine's flows and are kept as the regression net for the layout change).

## Resolutions (integrator, 2026-09-23)

Every row above was decided at integration and the contract was amended where the answer was a
contract question. The decisions are in `programs/diggo-protocol/CONTRACTS.md` and
`docs/ONCHAIN_V2_DESIGN.md`; what changed in code is listed here so the two can be checked against
each other.

- **CCR-F1 (window index) - resolved as "the pre-increment `player.roll_window`".**
  `CreateDiscoveryRoll` derives the PDA from `player.roll_window` in its accounts struct and
  increments the field only after writing `opportunity.window_index` from the same value, so a
  wallet's pending opportunity is always the window one below its current `roll_window` and
  `roll_window == 0` means it has never rolled. Pinned in CONTRACTS.md ("The discovery window
  index") and design section 4.2. `findOpportunity` no longer probes two candidates; the create path
  was already correct.
- **CCR-F2 (crank-pool share) - resolved as "carved out of the platform bucket at sweep".** A trade
  pays exactly `creator_fee_bps` and `platform_fee_bps`, both off the gross; `crank_pool_fee_bps`
  splits the protocol's own bucket between the crank-pool PDA and the treasury
  (`split_platform_bucket`). Pinned in CONTRACTS.md ("The fee order of operations") and design
  section 6. The frontend's three-fee quote was therefore wrong in the trader's disfavour and is
  gone: `splitFees` now returns the two shares the program takes, and `SwapQuote.crankPoolFeeRaw`
  is the protocol-side projection it always should have been.
- **CCR-F3 (sponsor enumeration) - resolved by the indexer.** `worker/sponsors.ts` serves
  `GET /api/sponsors/events` and `GET /api/sponsors/:owner/events` over the mirrored SponsorEvent
  rows, recovering each event id from its vault's own `event_count` and leaving out any event whose
  id it cannot prove. The payload shape is documented in docs/API.md and is what src/api.ts already
  consumes, so the launch form's "Sponsored" badge has a source. The endpoints are public rather
  than session-scoped: a sponsor event is a public on-chain fact and the payload holds no wallet's
  private state, so a session would add nothing.
- **CCR-F4 (quote mirror) - resolved by deletion.** `src/onchain/quotes.ts` is gone; the mirror
  lives in `shared/curve.ts` beside the Rust it transcribes, exporting `quoteCurveBuy`,
  `quoteCurveSell`, `quotePoolBuy`, `quotePoolSell`, `splitFees`, `QuoteError`, `mulBps` and the
  two spot-price helpers, with the same names the frontend already called. Its tests moved into
  `shared/curve.test.ts` so the parity vectors and the quotes are asserted in one place.
- **CCR-F5 (launch defaults) - resolved.** `DEFAULT_RESERVE_BPS` and
  `DEFAULT_DISCOVERY_RESERVE_BPS` are exported from `shared/program.ts`, and
  `src/constants.ts` imports those exports for the launch form. `src/constants.test.ts` pins the
  client-facing aliases and their economics.

### Findings that were not on the list

- **The bootstrap payload shape disagreed between the Worker and the client.** The Worker answers
  `/api/bootstrap` flat (`tokens`, `cluster`, `programId`, …) while src/api.ts read
  `data.config`, so `config.programId` stayed empty and every chain-dependent surface was silently
  inert - the onboarding panel never rendered, no launch, roll, bond or player read was attempted.
  Fixed in src/api.ts (the client folds the flat payload) and pinned by the launch-v2 end-to-end
  spec, which only passes when the program id arrives.
- **The maturity rungs are read as `days < up_to_day`.** The design's prose ("day 1 20%, day 3 40%,
  day 7 70%") names the rungs; the chain's table is under a day 20%, 1-2 days 40%, 3-6 days 70%,
  7 days and beyond 100%. The Rust, `shared/crew.ts` and the parity vectors already agreed; the
  stale expectation in `shared/economics.test.ts` and the v4 numbers in `config.ore.maturityRamp`
  did not, and both were brought onto the chain's schedule. Now tabulated in CONTRACTS.md.
- **`shared/program.ts` names events but does not read their payloads.** The Anchor event-body
  reader therefore stays in `worker/v2/program.ts` (`decodeEventData`, `decodeProgramEvents`), which
  is otherwise a pure re-export of the shared decoder layer; its test pins the set of events it can
  read against the contract's table. Noted in docs/API.md as the one remaining gap in the shared
  surface.
- **v2 emits no trade event, so a fill is indexed in two halves.** The input comes from the
  instruction; the received amount now comes from the transaction's own balance table
  (`meta.preTokenBalances`/`postTokenBalances`, and the lamport delta plus the fee for a sell),
  stored in `trades.amount_out` with `trades.fill_source` naming the source (migration
  `0023_trade_fill.sql`). `fill_source` reserves `event` for the day the contract declares one.
- **Two checkouts cannot share a dev pair.** Playwright reuses whatever already answers on its base
  URL, so a suite run on a machine where another checkout's vite is on :5173 measures the other
  tree's UI - which is exactly what happened before this integration. `DIGGO_CLIENT_PORT`,
  `DIGGO_WORKER_URL`, `DIGGO_E2E_BASE_URL` and `DIGGO_E2E_WORKER_URL` now let a run name its own
  pair.

---

WS-F (frontend), 2026-09-23 — the bond's removal, and what it leaves for the modules WS-F does not
own.

The decision is that there is no bond and no pay-to-play: every wallet plays with the ordinary
transaction and rent SOL it already needs, and there is no starter penalty, because with one tier
there is no second tier to be penalised against. WS-F has removed the UI's half of it and the list
below is the other half. Each row names the exact export, so the owner does not have to re-derive
the decision, and every one of them is now uncalled from `src/` rather than merely unused.

- **`src/onchain/actions.ts` — `postBond`, `requestUnbond`, `withdrawBond`.** No client path calls
  them any more, so they and their `src/onchain/index.ts` barrel exports can be deleted. Their
  pending-transaction records remain correct while they exist, so this is dead weight rather than a
  hazard and it does not gate the rest.
- **`src/solanaProgram.ts` — the `BOND_LAMPORTS` and `BOND_COOLDOWN_SECONDS` re-exports.** The
  onboarding panel and the discovery gate were their only two consumers and both are gone.
- **`src/onchain/sponsor.ts` — the `playerBondSubsidy` entry in `SPONSOR_KIND_OPTIONS`.** The panel
  renders that list, so it will keep offering a "Player bond subsidy" kind, with a
  `defaultPerSubjectLamports` of `BOND_LAMPORTS`, until the entry is dropped.
  `SPONSOR_KIND_PLAYER_BOND_SUBSIDY` on chain is the same question one layer down.
- **`shared/program.ts` — `BOND_LAMPORTS`, `BOND_COOLDOWN_SECONDS`, `BOND_SOURCE`,
  `bondSourceName`, the five `bond*` fields of `DecodedPlayerAccount`, and `trancheName` with
  `STARTER_EFFICIENCY_BPS` / `STARTER_TRANCHE_BPS`.** The UI reads none of them now, so the decoder
  can drop them in one step rather than in an order the client has to follow.
  `discoveryIsEligibleV2(player, bondLamports, now)` takes the bond as its second argument and
  `onchainMiningPower(crew, maturityBps, bonded, starterEfficiencyBps)` takes it as its third and
  fourth; with one tier there is nothing left to pass, and those two signatures are the shape the
  change turns on.
- **`worker/player.ts` (`bondView`) and `worker/portfolio.ts` (`mining.bond`).**
  `PortfolioScreen` no longer declares or reads `mining.bond`, so the field may be dropped; until it
  is, it is a key the client ignores.
- **`src/styles.css` — the `.onboarding-card-bond` rule and the comment above the onboarding
  block.** The panel no longer emits that class and the comment still describes "two ways to play …
  and the bond". WS-F deliberately did not touch the stylesheet, which is held by the Alerts/Header
  workstream this phase; the three selectors are inert until their owner deletes them.
- **`worker/mine.ts` — the `STARTER` / `BONDED` tranche label a position is reported with, and
  `worker/leaderboard.ts`'s `bonded: BigInt(row.bond_lamports) > 0n`.**

What WS-F changed, so the two halves can be checked against each other:
`src/components/PlayerOnboarding.tsx` (the step function reads the activation window and nothing
else, the bond card and the three bond buttons are gone, and the panel states the wallet
requirement as rent plus ordinary network fees), `src/App.tsx` (the discovery gate no longer
compares `bondLamports` to `BOND_LAMPORTS`), `src/components/PortfolioScreen.tsx` (the Bond stat
and the unbond-cooldown line are gone), `src/components/SponsorEventsPanel.tsx` (the per-wallet
default was `BOND_LAMPORTS`; it is now a round 0.01 SOL, which still covers the largest per-wallet
cost in the game), `src/constants.ts` and `src/constants.test.ts` (the bond and starter display
constants and their assertions are deleted), `src/dev/UiGallery.tsx` and `e2e/launch-v2.e2e.ts`,
plus a new `src/components/PlayerOnboarding.test.ts`.

---

WS-F (frontend), 2026-09-23 — the client's half of the no-bond interface, and the two layout
questions it turns on.

This is the client's final interface for the bond's removal, written so the program side can be
landed against it rather than guessed at. Where it disagrees with the WS-F row above, this section
is the newer decision and the reason is stated.

- **CCR-F6 — the committed contract vectors still carry `post_bond`.** The client dropped the
  instruction (no builder, no discriminator, no barrel export), so
  `shared/parity/parity.test.ts` had no bytes to compare and failed on the vector's entry. The
  vector file is generated and says so in its own header, so the client did not edit it: the test
  now carries `PENDING_CONTRACT_REMOVALS = {"post_bond"}` and asserts both that the client's table is
  the chain's report minus that set, and that every entry in the set is *still* reported — so the
  set cannot become permanent and any second divergence fails. Please remove `post_bond` from
  `instructions/player_bond.rs` and run
  `DIGGO_WRITE_VECTORS=1 cargo test -p diggo-protocol --test vectors`, which regenerates
  `tests/vectors/contract.json` and `shared/parity/vectors.contract.generated.ts`. The entry then
  comes out of the test in the same commit and the harness goes back to a strict equality.

**The interface the client now implements, and what the program has to say about it:**

| Question | The client's answer | What is asked of the program |
| --- | --- | --- |
| Mining power | `onchainMiningPower(levels, maturityBps)` — two arguments, no bond and no efficiency factor (`shared/crew.ts`) | `mining_power(levels, maturity_bps)` with no `bonded` flag and no `starter_efficiency_bps` factor. Nothing a wallet holds may scale power |
| Discovery eligibility | `discoveryIsEligibleV2(player, now)` — account age, active days, valid activations, crew total level, maturity (`shared/discovery.ts`) | Drop `player.bond_lamports >= protocol.bond_lamports` from `math/rarity.rs`. Milestones only, as decided |
| Posting a bond | no `postBond`, no `buildPostBondInstruction`, no `post_bond` in `DIGGO_INSTRUCTION_NAMES` | `post_bond` removed |
| Releasing an old bond | `requestUnbond` and `withdrawBond` stay, with `buildRequestUnbondInstruction` / `buildWithdrawBondInstruction` | `request_unbond` and `withdraw_bond` stay, so lamports already in a PlayerAccount balance can still be released and withdrawn |
| The old bond's fields | `decodePlayerAccount` still reads `bondLamports`, `bondLockedAt`, `unbondAvailableAt`, `bondSource`, `bondSponsorVault`, and `BOND_SOURCE` / `bondSourceName` / `trancheName` stay exported | The `PlayerAccount` layout stays 216 B with its bond block. This is the deliberate divergence from the row above, which asked for those five fields to be dropped: the decision is to preserve the legacy codecs so a bond posted before the change is readable and withdrawable |
| Sponsor kinds | `SPONSOR_KIND_OPTIONS` offers three: launch rent subsidy, platform trade fee waiver, player account subsidy | `SPONSOR_EVENT_KIND.playerBondSubsidy` may stay declared (the byte still decodes an event created before the change) but no instruction may accept a bond subsidy |
| The rest of sponsorship | unchanged — vault init/fund/withdraw, event create/close, the admin state, the event selectors and `resolveSubsidy` all stay | unchanged |

**Two layout questions the client cannot answer alone.** Both are frozen layouts, so the client
decodes whatever the program writes and a mismatch is a decode failure rather than a wrong number.
The client currently assumes both layouts are unchanged; say the word and each moves in one commit.

1. **`Coin` and `MiningPosition`.** The client still decodes `bonded_power`, `starter_power`,
   `bonded_index`, `starter_index` (464 B) and `MiningPosition.tranche` (51 B). With no bond path,
   `starter_power` can only ever be zero and the starter index can never advance, so the two-index
   shape is dead weight — but removing it costs 16 bytes on `Coin` and 1 on `MiningPosition`,
   which is `ACCOUNT_SIZE.coin`/`coin` rent, the two decoders and the worker's D1 columns together.
   The client's recommendation is to keep the layout and let the starter tranche sit empty, because
   a layout change buys 111,360 lamports per coin and costs a re-audit of every decoder; if the
   program collapses the index instead, the client's half is `shared/program.ts`'s `ACCOUNT_SIZE`,
   `decodeCoin` and `decodeMiningPosition`.
2. **`ProtocolConfig`.** `initialize_protocol` still takes `starterEfficiencyBps`,
   `starterTrancheBps`, `bondLamports` and `bondCooldownSeconds`, and the client still sends and
   decodes them (434 B). They are now values nothing reads. If the program drops them from the args
   and the struct, `ProtocolConfigArgs`, `DecodedProtocolConfig` and `ACCOUNT_SIZE.protocolConfig`
   shrink in the same commit; if they stay for the timelock's benefit, the client leaves them.

Not touched, and waiting on the launch worker rather than on this decision: the mint's initial and
settled sizes and the launch rent that follows from them. `MINT_V2_SIZE`,
`ACCOUNT_SIZE.mint`, `ACCOUNT_RENT_LAMPORTS.mint` and `LAUNCH_RENT_LAMPORTS` in
`shared/program.ts`, and the mirrors in `src/constants.ts`, are exactly as they were. They move when
the launch fix reports its final numbers, so the client is not quoting a rent the program does not
charge in the meantime.

One more loop to close with the row above: `DEFAULT_SPONSOR_PER_WALLET_LIMIT_LAMPORTS` was defined
as `BOND_LAMPORTS` and is now the literal `70_000_000n`, which is still what the program's constant
says. It is a form default only — the program bounds a spend by the event's own limits — and the
sponsor panel no longer reads it (it opens at a round 0.01 SOL instead). The program may want to
re-point the constant at the largest per-wallet cost that is left, the `PlayerAccount` rent; the
client will mirror whatever it becomes, and until then the two agree on 0.07 SOL.
