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
| `POST` | `/api/crew/upgrade` | authenticated, ORE-only Crew component upgrade |
| `GET` | `/api/player/:wallet` | authenticated (self only) Crew/ORE/streak/activation profile |
| `GET` | `/api/player/:wallet/discoveries` | authenticated (self only) discovery history |
| `POST` | `/webhooks/helius` | authenticated async event ingestion |
| `GET` | `/media/*` | streamed private Supabase Storage object delivery |

Authenticated calls use `Authorization: Bearer <session>`. The Helius route uses its own independently configured authorization value. `/api/player/:wallet*` routes 401 unless the session's wallet matches the path wallet — no player can read another player's Crew/ORE/discovery state.

Daily activation is a distinct signed-challenge flow from wallet sign-in (`/api/auth/challenge` + `/api/auth/verify`): it uses its own nonce namespace and message, is consumed on first use (replay protection), and is rate-limited per-wallet in addition to the general per-IP limiter. See `docs/ARCHITECTURE.md` §3.
