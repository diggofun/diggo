# Deployment checklist

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars     # then edit it; .dev.vars is git-ignored
npm run dev:local                 # migrations, then Worker (:8787) + client (:5173)
```

`dev:local` applies the local D1 migrations and then runs both processes in one terminal with
prefixed output: `wrangler dev` serves the Worker on `:8787`, and `vite` serves the client on
`:5173` with `/api`, `/media` and `/webhooks` proxied to it (see `vite.config.ts`). Ctrl-C stops
both. `npm run dev:worker` and `npm run dev` still run either side on its own.

Only `DISCOVERY_SECRET` is needed for the game loop to work: without it the discovery subsystem
fails closed and rolls nothing. `DIGGO_DEVICE_SALT` and `ADMIN_WALLETS` are the other two values
worth setting locally; the rest of `.dev.vars.example` is optional and documented in place. For
local play, uncommenting `DISCOVERY_WINDOW_SECONDS=60` and `DISCOVERY_ROLL_CHANCE_BPS=10000` makes
every activation roll a discovery.

There is no devnet dependency for the mining loop. `npm run seed:local` inserts three demo mines
(FROG, DOGGO, MOLE) with `synced_at = 0`, so the Worker treats them as `OFFCHAIN` mines and D1 is
the accounting source: activation, streak, block rewards, ORE, Crew upgrades and discoveries all
work without a chain. The seed is a plain SQL file under `scripts/`, applied with
`wrangler d1 execute --local`, and deliberately **not** part of `migrations/` — production must
never ship demo tokens. `npm run dev:local -- --seed` seeds as part of startup.

## Cloudflare resources

Wrangler declares the following bindings and validates them in dry-run mode:

| Binding | Product | Purpose |
| --- | --- | --- |
| `ASSETS` | Workers Static Assets | React frontend |
| `DB` | D1 | token index, launch jobs, events and history |
| Supabase `token-media` | Supabase Storage | private uploaded token artwork, delivered through the Worker |
| `TOKEN_CACHE` | KV | hot token lists, rate hints and signed wallet sessions |
| `MARKETS` | Durable Objects | one strongly consistent live stream per mint |
| `INDEXING_QUEUE` | Queues | Helius ingestion and retry isolation |
| `EPOCH_WORKFLOW` | Workflows | five-minute index synchronization |

Create a queue named `diggo-indexing-dlq` before production deployment if automatic provisioning does not create the configured dead-letter queue.

## Required secrets

- `DISCOVERY_SECRET`: server-only HMAC secret every discovery roll is derived from. Without it the
  discovery subsystem fails closed and grants nothing (spec 55).
- `DIGGO_DEVICE_SALT`: server-side salt for the IP/device/network hashes in `worker/signals.ts`.
- `ADMIN_WALLETS`: comma-separated wallet addresses allowed to use `/api/admin/*`. An admin session
  still has to be a real signed wallet session; the list only decides which wallets may try.
- `TURNSTILE_SECRET`: private key for the production Turnstile widget.
- `HELIUS_WEBHOOK_AUTH`: exact authorization header configured in Helius, including `Bearer `.
- `SUPABASE_SERVICE_ROLE_KEY`: Supabase secret key used only by the Worker to upload and retrieve private artwork.
- `DIGGO_RPC_URL` (optional): devnet RPC endpoint; falls back to the public devnet RPC.
- `DIGGO_KEEPER_SECRET_KEY` (optional): the keeper signer, needed only for `sync_crew_power` and
  `claim_discovery`. See `docs/CUSTODY.md` for how it must be held.

Set every production value with `wrangler secret put <NAME>`. `DISCOVERY_WINDOW_SECONDS` and
`DISCOVERY_ROLL_CHANCE_BPS` are ordinary vars: they are clamped by `DISCOVERY_TUNABLE_BOUNDS` in
`shared/config.ts`, so a bad value cannot open the floodgates or stop the subsystem.

The repository contains only Cloudflare's public always-pass development site key. Replace it before using a production hostname.

## Helius

Create an enhanced webhook for the protocol program accounts. Set:

- URL: `https://diggo.fun/webhooks/helius`
- auth header: the exact value stored in `HELIUS_WEBHOOK_AUTH`
- transaction status: successful transactions only
- account filters: token factory, launch market, mining engine, equipment and fee router program IDs

The endpoint acknowledges after enqueuing. The Queue consumer persists idempotently by transaction signature.

## WAF and bot controls

Turnstile is validated server-side for every launch. Add dashboard rules as the outer rate-control layer:

- 12 requests/minute/IP on `/api/auth/*`;
- 5 requests/minute/IP on `POST /api/tokens`;
- allow the Helius webhook only with the secret header, then rate limit abnormal bursts;
- enable Cloudflare managed rules and bot fight mode where available.

The Worker includes a best-effort KV limiter as defense in depth. KV is eventually consistent, so it is not a replacement for WAF rate limiting.

## Observability

Workers Logs and Traces are enabled with full sampling for the MVP. Reduce `head_sampling_rate` once traffic grows. Logs are structured JSON and intentionally omit secrets, wallet signatures and Turnstile tokens.

## Initial page load

The frontend makes one Worker request on entry: `GET /api/bootstrap?limit=1000`. It returns public runtime configuration and up to 1,000 token summaries. The Worker reads the token batch from KV for 60 seconds; a D1 read occurs only after a cache miss. Individual token cards do not trigger follow-up Worker requests.

## Order of operations

1. `npm run check`
2. configure production Turnstile key and secrets
3. `npx wrangler deploy`
4. `npx wrangler d1 migrations apply diggo-db --remote`
5. configure Helius
6. attach the custom domain and WAF policies
7. verify `/api/config`, `/api/tokens`, media upload and one signed launch job on devnet
