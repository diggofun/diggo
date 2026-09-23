# API surface

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/bootstrap?limit=1000` | one request for public runtime config and up to 1,000 cached token cards |
| `GET` | `/api/config` | public cluster, Turnstile site key and suffix |
| `GET` | `/api/tokens` | KV-cached token discovery list backed by D1 |
| `GET` | `/api/tokens/:slug` | token detail |
| `GET` | `/api/tokens/:mint/live` | WebSocket stream backed by a per-mint Durable Object |
| `POST` | `/api/auth/challenge` | create a single-use wallet message |
| `POST` | `/api/auth/verify` | verify Ed25519 signature and issue a short session |
| `POST` | `/api/media` | authenticated token image upload to private Supabase Storage |
| `POST` | `/api/tokens` | authenticated, Turnstile-protected launch job |
| `POST` | `/api/mine/activate/challenge` | create a single-use, wallet-signed daily-activation message |
| `POST` | `/api/mine/activate` | verify the activation signature, settle offline ORE/streak, roll an eligible Discovery, extend the 24h window |
| `POST` | `/api/mine/switch` | move an already-active crew to a different mine without resetting activation or streak |
| `POST` | `/api/mine/report/collect` | authenticated; settles the live mining position and returns the idempotent Mining Report |
| `GET` | `/api/mines/:mint/info` | public mine information: block reward, total power, remaining reserve, labelled block-share estimate, reward-reduction schedule, fully-mined progress |
| `POST` | `/api/rewards/claim/challenge` | create a single-use, wallet-signed claim message bound to one reward id |
| `POST` | `/api/rewards/claim` | verify the claim signature and move exactly one reward `ELIGIBLE -> CLAIMED` |
| `POST` | `/api/rewards/claim/confirm` | verify the player's own `claim_rewards` transaction against chain and record the payout (idempotent; a signature already backing another reward is a 409) |
| `GET` | `/api/player/:wallet/rewards` | authenticated (self only) reward-claim history |
| `POST` | `/api/crew/upgrade` | authenticated, ORE-only Crew component upgrade |
| `GET` | `/api/player/:wallet` | authenticated (self only) Crew/ORE/streak/activation profile |
| `POST` | `/api/discovery/opportunity` | authenticated; lazily authors this window's single-use discovery opportunity (idempotent inside the window) |
| `POST` | `/api/discovery/roll` | authenticated; consumes the window's opportunity and rolls the server-authoritative discovery. 409 once the window is spent |
| `POST` | `/api/discovery/claim/challenge` | create a single-use, wallet-signed discovery-claim message |
| `POST` | `/api/discovery/claim` | verify the claim signature and commit the discovery to the keeper (PENDING -> ELIGIBLE -> CLAIMED) |
| `GET` | `/api/discovery/commitments` | public, unauthenticated commit-reveal RNG schedule: the current epoch, its commitment and its window |
| `GET` | `/api/discovery/commitments/:epoch` | one epoch's commitment, plus its revealed seed once that epoch has ended |
| `GET` | `/api/player/:wallet/discoveries` | authenticated (self only) discovery history plus the live opportunity |
| `GET` | `/api/notifications` | authenticated; the signed-in wallet's notifications and unread count |
| `POST` | `/api/notifications/read` | authenticated; mark one notification, or all of them, read |
| `GET` | `/api/push/key` | the VAPID application server key a browser needs before it can subscribe (readable before sign-in) |
| `POST` | `/api/push/subscription` | authenticated; register this device for the signed-in wallet |
| `DELETE` | `/api/push/subscription` | authenticated; drop this device's subscription |
| `POST` | `/api/telegram/link` | authenticated; issue a one-time code for linking a Telegram chat |
| `POST` | `/api/appeals` | authenticated; file one appeal against a hold or restriction |
| `GET` | `/api/admin/appeals?status=` | admin; the appeals queue (`OPEN`/`ACCEPTED`/`REJECTED`, or all) |
| `POST` | `/api/admin/appeals` | admin; decide one appeal. Requires a signed step-up, and can only lift restrictions |
| `POST` | `/api/admin/stepup` | admin; issue the short-lived, single-use message an admin mutation has to sign |
| `POST` | `/webhooks/helius` | authenticated async event ingestion |
| `POST` | `/webhooks/telegram` | Telegram's own callback for the optional notification channel; fails closed unless `TELEGRAM_WEBHOOK_SECRET` matches |
| `GET` | `/media/*` | streamed private Supabase Storage object delivery |

Authenticated calls use `Authorization: Bearer <session>`. The Helius route uses its own independently configured authorization value. `/api/player/:wallet*` routes 401 unless the session's wallet matches the path wallet — no player can read another player's Crew/ORE/discovery state.

Daily activation is a distinct signed-challenge flow from wallet sign-in (`/api/auth/challenge` + `/api/auth/verify`): it uses its own nonce namespace and message, is consumed on first use (replay protection), and is rate-limited per-wallet in addition to the general per-IP limiter. See `docs/ARCHITECTURE.md` §3.

Block rewards settle through a per-mine cumulative reward index (`mine_reward_state`) with one
position per wallet and mine (`mining_positions`). Blocks are advanced lazily and in bounded
batches when a report, switch, upgrade or claim reads the mine, so nothing scales with
players × blocks. A position is eligible for a block only while `activated_at <= blockTime <
active_until`: the block landing exactly on `active_until` is not credited, and a paused crew
keeps neither ORE nor block rewards. Settling moves a position's pending reward into one
`reward_claims` row, and claiming is a single conditional `UPDATE` guarded on
`status = 'ELIGIBLE' AND eligible_until > now`, so of any number of concurrent claims exactly one
can win. `HELD`/under-review rewards are parked and only become claimable once the hold is lifted.
When a mine's on-chain program is authoritative, the numbers in these responses are the indexed
estimate and say so (`accounting.source = 'ONCHAIN_INDEXED'`); otherwise they are the accounting
source for the report. See `worker/mining.ts`.

A settled reward is paid by the **player**, not the backend. The Mining Reserve is program-controlled
and leaves the program only through the user-signed `claim_rewards` instruction, so the
`reward_claim` indexing job never moves it: with no reported transaction it exposes the claim as
`ready`, and with one it verifies the transaction against chain before recording it through
`markClaimPaid`. Every claim view therefore carries
`payout: { route: 'USER_SIGNED', instruction: 'claim_rewards', ready, txSignature }`, where
`ready: true` means the accounting is finished and the player still has to submit the on-chain
claim. A keeper-signed payout of the Mining Reserve is deliberately not implemented — it would give
a backend key the power to drain a mine (see `docs/SECURITY.md` invariant 7 and
`settleRewardClaim` in `worker/mining.ts`).

`POST /api/rewards/claim/confirm` closes that loop: the player's wallet has submitted
`claim_rewards`, and the client reports `{ rewardId, signature }`. Nothing is recorded on trust —
the Worker fetches the transaction and checks that it really is this reward's payout before writing
`tx_signature` through `markClaimPaid`. The endpoint is idempotent in both directions: confirming
the same signature again succeeds (`idempotent: true`), while a signature that already backs a
different reward is refused with `SIGNATURE_REUSED` (a partial UNIQUE index on `tx_signature`
enforces the same rule in storage), an unverifiable transaction is `PAYOUT_UNVERIFIED`, and a claim
whose accounting has not settled is `NOT_SETTLED`. Its per-IP budget is deliberately higher than the
claim endpoint's, because a player with several banked rewards confirms them one after another.
Reporting the signature is not optional housekeeping: `worker/reconcile.ts` compares paid claims
against chain, and a settled reward with no recorded signature is what halts a mine's mint.

Discovery is the most protected surface in the API, because it hands out real memecoin value. One
opportunity is authored per active Crew per time window, carries a deterministic `eventId` and a
server-derived `nonce`, and can be rolled exactly once — a second roll in the same window is a 409,
not a reroll. The roll itself, the token, the rarity, the visual event and the token amount are all
derived server-side from `DISCOVERY_SECRET`; the client sends no seed and never computes an outcome.
Claiming needs its own wallet-signed single-use challenge, and the payout is committed by one guarded
`PENDING -> ELIGIBLE` update, so concurrent claims cannot both win. See `docs/ARCHITECTURE.md` and
`worker/discovery.ts`.

The RNG is **commit-reveal**, not a bare random draw. Each epoch the Worker derives a seed from
`DISCOVERY_SECRET` and publishes only its commitment, so an outcome cannot be ground out after the
fact; the seed is revealed once the epoch has closed, and anyone can check it against the
commitment they read earlier. `GET /api/discovery/commitments` is public and unauthenticated for
exactly that reason — a commitment nobody can read proves nothing. The epoch length is
`DISCOVERY_EPOCH_SECONDS`, bounded to `[3600, 2592000]` and a day by default.

Two more surfaces deserve a note. **Appeals** are the only path by which a player can ask a person
to look again: `POST /api/appeals` is signed-in only, rate limited on five dimensions, length
bounded, and answers with the same neutral sentence whether or not the account is under anything,
so it cannot be used to probe what the risk layer thinks. Filing one changes nothing by itself, and
deciding one can only lift restrictions, never add them. **Web push and Telegram** are delivery
channels for notifications a player can already read through `/api/notifications`; both are opt-in,
both are optional to the deployment, and a push subscription is always scoped to the signed-in
wallet.

## Price oracle

`worker/oracle.ts` is the only module that answers what a token or SOL is worth, and it is built to
refuse rather than guess: `getRobustPrice` combines the token's own observed history, a
volume-weighted average of recorded trades, Jupiter and Pyth, and returns `null` when the sources
disagree beyond the deviation gate or are stale. A discovery that cannot be valued pays nothing.
`GET /api/mines/:mint/info` and the token cards carry whatever the oracle last agreed on; the
`price_usd` column is display-only and settlement never reads it. Every knob is an optional
environment variable with a working default — `JUPITER_PRICE_URL`, `JUPITER_PRICE_V2_URL`,
`JUPITER_API_KEY`, `PYTH_HERMES_URL`, `PYTH_API_KEY`, `PYTH_SOL_USD_FEED_ID`,
`ORACLE_MIN_EXTERNAL_SOURCES` and `ORACLE_SOL_USD_OVERRIDE` (the last pins the rate for local work
only). See `docs/SECURITY.md`.

## Risk enforcement, step-up and appeals

`RISK_OPS.enforcement.mode` decides what a score-derived refusal actually does. It ships as
`shadow`: the gate still reaches a verdict and records it (`risk.shadow_would_block`, the
`shadowed` flag and `computedState` on every admin account row), but the account keeps playing. An
operator moves it to `enforce` once they have reviewed what it would have done, and
`enforcement.overrides` can enforce or shadow a single action while the global mode stays put.
Hard safety is never shadowed: rate limits, circuit breakers and an operator restriction all still
apply in either mode.

Every mutating admin call carries a **step-up**: `POST /api/admin/stepup` issues a short-lived
message bound to one action and its exact payload, the admin wallet signs it, and the signature is
sent back as `stepUp: { nonce, signature }`. It is single use, so a captured admin request cannot be
replayed against a different payload — an admin session on its own can never place a restriction,
flip a breaker or decide an appeal.

The full admin route set is `GET /api/admin/abuse`, `GET /api/admin/metrics`,
`POST /api/admin/restrictions`, `POST /api/admin/breakers`, `POST /api/admin/stepup`,
`GET /api/admin/appeals` and `POST /api/admin/appeals`. All of them require a session whose wallet
is listed in `ADMIN_WALLETS`, all answer 401 for anyone else, and all are audited. None can move,
seize or redirect value: they can only restrict an account, halt a scope, or lift a restriction.
