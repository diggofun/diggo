# API surface

The Worker is an indexer of the on-chain v2 program, a read API over that index, a notification
sender, and an optional permissionless crank. It is not an authority over anyone's money, and the
API reflects that: **every endpoint below is read-only with respect to value.** Nothing here can
move a token, a lamport, a claim or a reserve, and no endpoint decides an outcome.

Two conventions run through every payload:

- An integer amount that came from the chain is a **string** (`"70000000"`), because a lamport
  count and a u128 reward index do not survive a JavaScript number without losing digits.
- A number that was **derived for display** is a separate field with its own name (`priceUsd`,
`unitsWhole`, `mining.bond.sol`). A client can therefore always tell a program fact from a display
convenience, and a conversion bug can never masquerade as a balance.

Anything that changes state is a Solana transaction the player signs. The paths that used to exist
for that - `/api/mine/activate`, `/api/crew/upgrade`, `/api/mine/switch`, `/api/rewards/claim`,
`/api/discovery/roll`, `/api/discovery/claim` - are gone, along with the keeper-signed write path
behind them.

## Read endpoints

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/api/config` | Cluster, program id and public client keys |
| GET | `/api/bootstrap` | The coin list plus the protocol parameters the UI needs |
| GET | `/api/tokens?limit=` | `{ tokens: CoinSummary[], syncedAt }` |
| GET | `/api/tokens/:slug` | One coin |
| GET | `/api/tokens/:mint/trades?limit=` | Indexed trades for one coin |
| GET | `/api/tokens/:mint/live` | The live market snapshot Durable Object |
| GET | `/api/leaderboards?limit=` | Every board, each capped at `limit` |
| GET | `/api/mines/:slug/info` | Mine information, including the vault ledger check |
| GET | `/api/mines/:slug/report?wallet=` | One wallet's position on one coin |
| GET | `/api/coins/:mint/discoveries` | A coin's indexed rolls |
| GET | `/api/player/:wallet` | Profile: username, mirrored account, positions |
| GET | `/api/player/:wallet/discoveries` | A wallet's own rolls |
| GET | `/api/player/:wallet/achievements` | Earned achievements |
| GET | `/api/discovery/seeds?coin=&limit=` | Committed epoch seeds, for independent verification |
| GET | `/api/discovery/budget` | The protocol-wide daily discovery budget |
| GET | `/api/cosmetics` | The cosmetic catalogue and what the caller owns |
| GET | `/api/notifications` | Notifications derived from indexed state |
| GET | `/api/profile/:wallet` | Public username |
| GET | `/api/push/key` | The VAPID application server key |
| GET | `/api/status` | Indexer and crank diagnostics |
| GET | `/media/:key` | An uploaded image |

### `CoinSummary`

Every value-bearing field is the program's own, copied from the `Coin` account: `reserveRemaining`,
`discoveryReserveRemaining`, `networkPower`, `bondedPower`, `starterPower`, `rewardPerBlock`,
`epochIndex`, `liquidityLamports`. `priceSol`, `priceUsd`, `marketCapUsd`, `liquiditySol` and
`curveMining.*` are derived for display.

`bondedPower` and `starterPower` are the coin's two tranche totals rather than two classes of
player: every position armed since the bond was retired is in the full tranche, so a live coin's
`starterPower` stays zero, and only lamports parked by a bond posted before the retirement keep
the withdrawal path of `docs/ONCHAIN_V2_DESIGN.md` 3.2 alive.

`venue` is `"curve"` before graduation and `"pool"` after it, whether or not the pool account came
back: a graduated coin's curve reserves are zero by design, so calling it a curve would describe a
venue that holds nothing. A graduated coin whose pool cannot be read reports a price of zero rather
than its empty curve, because a visibly wrong zero is better than a plausibly wrong price.

`epochSeedCommitted` says whether the epoch's seed has been recorded on chain; until it has, no roll
from that epoch can settle.

### `/api/mines/:slug/info` and the ledger check

The `ledger` block is the vault invariant of design 1.3(a), recomputed from a fresh vault read:

```
vault.amount >= curve_tokens + reserve_remaining + discovery_remaining + outstanding_claims
```

The Worker **reports** this and cannot enforce it, because it cannot move a token. `ok: false` with
a `shortfall` is a finding for a human, not a halt.

### `/api/discovery/seeds`

The endpoint that makes the whole scheme auditable. Every discovery outcome is
`sha256(epoch_seed || owner_pubkey_bytes || window_index_u16_le)`, expanded in order into whether
the roll occurs, which rarity tier, and how much. With a seed from this endpoint, anyone can
recompute any past outcome and check a payout without trusting this server.

The seed is a `SlotHashes` entry the program recorded at a slot that was in the future while the
epoch's rolls were being created. It is not an operator value, and there is no commitment to
publish because there is no operator to commit.

## Write endpoints (no value)

These mutate off-chain data only. Each requires a signed wallet session.

| Method | Path | Effect |
| --- | --- | --- |
| POST | `/api/auth/challenge` | Issue a sign-in challenge |
| POST | `/api/auth/verify` | Exchange a signature for a session |
| POST | `/api/profile/username` | Set the caller's username |
| POST | `/api/tokens/register` | Attach a description and image to a coin **the indexer has already seen** |
| POST | `/api/media` | Upload an image |
| POST | `/api/cosmetics/equip`, `/api/cosmetics/unequip` | Equip a cosmetic (visual only) |
| POST | `/api/seasonal/sync` | Recompute off-chain seasonal points |
| POST | `/api/notifications/read` | Mark notifications read |
| POST/DELETE | `/api/push/subscription` | Manage web-push subscriptions |
| POST | `/api/telegram/link` | Start a Telegram link |
| POST | `/api/rpc` | Read-only JSON-RPC proxy; signed transaction methods require a wallet session |
| POST | `/api/verify/challenge` | Clear progressive friction for a short window |

`/api/tokens/register` is the one worth reading twice: it refuses a mint the indexer has never
seen. In v4 a client-reported launch created a row; now a coin that does not exist on chain has no
row to attach metadata to, and only the coin's own creator may set it.

`/api/rpc` forwards only the documented read methods anonymously. `sendTransaction` and
`simulateTransaction` require a session created by `/api/auth/verify`; the session wallet must be
the transaction fee payer, every required signature is checked, and transactions may call the
Diggo program plus the standard system, token, associated-token and compute-budget programs.
Send-capable wallets may also submit directly through their provider. The Worker never holds a
transaction-signing key for player actions.

## Webhooks

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/webhooks/helius` | Authenticated by `HELIUS_WEBHOOK_AUTH` |
| POST | `/webhooks/telegram` | Fails closed when `TELEGRAM_WEBHOOK_SECRET` is unset or wrong |

The Helius handler **never trusts its payload for content**. It reads a signature or an account out
of the delivery, enqueues a job, and the consumer re-reads the fact from chain. A forged or replayed
delivery can therefore cause a redundant read and nothing else.

## Admin

Admin is a real signed wallet session whose wallet appears in `ADMIN_WALLETS`, plus a short-lived
signature (`/api/admin/stepup`) on every mutating call.

| Method | Path | Effect |
| --- | --- | --- |
| GET | `/api/admin/abuse` | A compact anti-abuse view, with no raw IP, device or session id |
| POST | `/api/admin/restrictions` | Place or lift an **off-chain** restriction |
| GET | `/api/admin/metrics` | Metrics, alerts, advisory alerts and the audit trail |
| POST | `/api/admin/stepup` | Issue the step-up proof |
| GET/POST | `/api/admin/appeals` | Read the appeal queue, resolve an appeal |

There is no breaker endpoint. In v4 an operator could halt discoveries, claims or one mine's
Discovery Reserve; v2 has no such switch, because a claim is decided by the player's own signed
instruction and a public crank. What replaced it is the advisory alert list on
`/api/admin/metrics`: the same detections, recorded instead of enforced.

## Indexer operations

| Method | Path | Effect |
| --- | --- | --- |
| POST | `/api/indexer/coin?mint=` | Re-read one coin from chain now |
| POST | `/api/indexer/player?wallet=` | Re-read one wallet's account now |

Both only re-read chain. The cron trigger does the same work on a two-minute cadence: a signature
sweep (events and trade instructions) and an account sweep (coins, pools, positions, opportunities,
budgets, sponsor accounts, the protocol config, and every wallet the indexer has seen).

Two intakes feed the index and neither is trusted for content. A webhook is a hint; the sweep is the
backstop, so the index converges even with no webhook configured at all.

### Where trades come from

v2 emits no trade event, so a fill is indexed in two halves and each is labelled with where it came
from:

| Column | Meaning |
| --- | --- |
| `amount_in` | what the trader offered: lamports for a buy, base units for a sell, read from the trade **instruction** that caused it |
| `amount_out` | what the trader received, read from the transaction's own **balance table** (`meta.preTokenBalances`/`postTokenBalances`, and the lamport delta plus the fee for a sell). 0 when the table was not in the response |
| `fill_source` | `meta` when `amount_out` came from the balance table, `instruction` when only the input is known, `event` reserved for a v2 trade event if the contract ever declares one |
| `price_sol` | the venue's **observed spot price** at that slot, never presented as the fill |

`GET /api/tokens/:slug/trades` returns all four. If the contract gains a trade event, that event
becomes the first source for `amount_out` and `fill_source` becomes `event`; the columns and the
endpoint do not change.

## Sponsorship

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/api/sponsors/events` | every sponsor event the indexer knows about |
| GET | `/api/sponsors/:owner/events` | the same list, scoped to one sponsor vault's owner |

Sponsor events are PDAs keyed on `(vault, event_id)` and there is deliberately no on-chain registry
that lists them, so the indexer is the only thing that can enumerate them: it sweeps every
SponsorEvent by discriminator and mirrors them in D1. Each item carries the event id, so a client can
re-read the event on chain before believing it, which is what the launch form does
(`findLaunchSubsidy` in src/solanaProgram.ts is the decision; this endpoint is the address list).

```ts
{
  eventId: number;               // the vault's event_count at creation, i.e. the event PDA's seed
  event: string; vault: string;  // the SponsorEvent and SponsorVault PDAs
  kind: number;                  // 0 launch rent, 1 platform fee waiver, 2 player account, 3 bond (retired)
  startAt: number; endAt: number;
  budgetLamports: string; spentLamports: string;
  perCoinLimitLamports: string; perWalletLimitLamports: string;
  paused: boolean;
}
```

Both endpoints are public: a sponsor event is a public on-chain fact and the payload holds no
wallet's private state, so scoping by owner only narrows the list. An event whose id cannot be
recovered - its vault is not mirrored yet - is left out rather than given a guessed id, because the
client re-reads at the id it is handed and a wrong id would silently drop a real subsidy. An empty
list means "the creator pays", which is the honest default.

### The one gap in the shared decoder surface

`shared/program.ts` names an event from its discriminator but does not read the body, so the Anchor
event **payload** reader lives in `worker/v2/program.ts` (`decodeEventData`,
`decodeProgramEvents`) and is the only decode code outside the shared layer. `worker/v2/program.ts`
is otherwise a pure re-export of `shared/program.ts` and `shared/pdas.ts`; its own test pins the set
of events it can read against the contract's table, so an event added to the program fails the test
until a reader exists rather than decoding to null.

## Notifications

Notifications are **derived from indexed on-chain state** and from off-chain progression, never
authored by an operator. The generator reads a wallet's mirrored account, its coin and its recent
discoveries and emits the events those facts imply; the sweep in `runSocialCron` covers wallets
that are not currently in the app.

Delivery is Web Push (RFC 8291/8292) and an optional Telegram channel. Without the VAPID keys the
push channel reports itself unavailable and the bell stays empty rather than silently dropping
alerts.

### Exercising notifications locally

```bash
npm run db:local
npm run dev:worker
curl -s localhost:8787/api/notifications -H "cookie: diggo_session=<session>"
```

## Price oracle

The oracle is **display-only** in v2. Discovery value is normalised by the coin's own pool TWAP, a
price the program observed itself, so no external source is consulted in any payout path.
`getSolUsd()` reads Jupiter's wrapped-SOL price and Pyth's published SOL/USD feed, caches the result
for five minutes, and falls back to `ILLUSTRATIVE_DEVNET_SOL_USD` with `fromOracle: false` when
neither answers. A wrong rate moves a number on a page and nothing else.

## Risk, step-up and appeals

The risk layer is **advisory**. It can flag, rate limit HTTP surfaces and inform support, and it
cannot lower a player's on-chain power, freeze a position, or touch ORE, crew levels, claims or
reserves. There is no instruction that reads it.

`gateAction` is the one gate that still refuses something: it applies multi-key rate limits and
account restrictions to *off-chain* actions (a username change, an appeal, a metadata edit). A
refusal there costs a request, never a reward.
