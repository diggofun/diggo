# API surface

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/config` | public cluster, Turnstile site key and suffix |
| `GET` | `/api/tokens` | KV-cached token discovery list backed by D1 |
| `GET` | `/api/tokens/:slug` | token detail |
| `GET` | `/api/tokens/:mint/live` | WebSocket stream backed by a per-mint Durable Object |
| `POST` | `/api/auth/challenge` | create a single-use wallet message |
| `POST` | `/api/auth/verify` | verify Ed25519 signature and issue a short session |
| `POST` | `/api/media` | authenticated token image upload to private Supabase Storage |
| `POST` | `/api/tokens` | authenticated, Turnstile-protected launch job |
| `POST` | `/webhooks/helius` | authenticated async event ingestion |
| `GET` | `/media/*` | streamed private Supabase Storage object delivery |

Authenticated calls use `Authorization: Bearer <session>`. The Helius route uses its own independently configured authorization value.
