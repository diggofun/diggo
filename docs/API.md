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
| `GET` | `/api/player/:wallet/rewards` | authenticated (self only) reward-claim history |
| `POST` | `/api/crew/upgrade` | authenticated, ORE-only Crew component upgrade |
| `GET` | `/api/player/:wallet` | authenticated (self only) Crew/ORE/streak/activation profile |
| `POST` | `/api/discovery/opportunity` | authenticated; lazily authors this window's single-use discovery opportunity (idempotent inside the window) |
| `POST` | `/api/discovery/roll` | authenticated; consumes the window's opportunity and rolls the server-authoritative discovery. 409 once the window is spent |
| `POST` | `/api/discovery/claim/challenge` | create a single-use, wallet-signed discovery-claim message |
| `POST` | `/api/discovery/claim` | verify the claim signature and commit the discovery to the keeper (PENDING -> ELIGIBLE -> CLAIMED) |
| `GET` | `/api/player/:wallet/discoveries` | authenticated (self only) discovery history plus the live opportunity |
| `POST` | `/webhooks/helius` | authenticated async event ingestion |
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

Discovery is the most protected surface in the API, because it hands out real memecoin value. One
opportunity is authored per active Crew per time window, carries a deterministic `eventId` and a
server-derived `nonce`, and can be rolled exactly once — a second roll in the same window is a 409,
not a reroll. The roll itself, the token, the rarity, the visual event and the token amount are all
derived server-side from `DISCOVERY_SECRET`; the client sends no seed and never computes an outcome.
Claiming needs its own wallet-signed single-use challenge, and the payout is committed by one guarded
`PENDING -> ELIGIBLE` update, so concurrent claims cannot both win. See `docs/ARCHITECTURE.md` and
`worker/discovery.ts`.
