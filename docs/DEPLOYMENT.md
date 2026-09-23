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
| `PLAYER_LOCK` | Durable Objects | one mutex per wallet, serializing activation, mine switching, Crew upgrades, reward claims and the discovery roll/claim pair |
| `RATE_LIMITER` | Rate Limiting | strongly consistent per-key limiter consulted before the KV counters in `worker/http.ts` |
| `DIGGO_METRICS` | Analytics Engine | counter mirror of `metrics_counters`, for dashboard and alerting queries |

Create a queue named `diggo-indexing-dlq` before production deployment if automatic provisioning does not create the configured dead-letter queue.

## Required secrets

- `DISCOVERY_SECRET`: server-only HMAC secret every discovery roll is derived from. Without it the
  discovery subsystem fails closed and grants nothing (spec 55).
- `DIGGO_DEVICE_SALT`: server-side salt for the IP/device/network hashes in `worker/signals.ts`.
- `ADMIN_WALLETS`: comma-separated wallet addresses allowed to use `/api/admin/*`. An admin session
  still has to be a real signed wallet session; the list only decides which wallets may try.
- `TURNSTILE_SECRET`: private key for the production Turnstile widget. Two optional companion vars
  tune the gate (`worker/auth.ts verifyTurnstile`):
  - `TURNSTILE_ALLOWED_HOSTNAMES`: comma-separated hostnames a token may have been solved on. The
    host the request arrived on is always allowed, so this is only for the extra hosts one
    deployment answers on (apex, `www`, a preview host). A token solved on an attacker's own page is
    refused whatever this says.
  - `TURNSTILE_ACTIONS`: comma-separated, lower-case actions this deployment expects its widgets to
    declare. Leave it unset when the widgets declare no action: an unset list accepts every action,
    while a set one refuses a token carrying an action that is not in it. Both are ordinary vars
    (`wrangler.jsonc` or the dashboard), not secrets.
- `HELIUS_WEBHOOK_AUTH`: exact authorization header configured in Helius, including `Bearer `.
- `SUPABASE_SERVICE_ROLE_KEY`: Supabase secret key used only by the Worker to upload and retrieve private artwork.
- `DIGGO_RPC_URL` (optional): devnet RPC endpoint; falls back to the public devnet RPC.
- `DIGGO_KEEPER_SECRET_KEY` (optional): the keeper signer, needed only for `sync_crew_power` and
  `claim_discovery`. See `docs/CUSTODY.md` for how it must be held.
- `ALERT_WEBHOOK_URL` (optional): Discord/Slack-compatible incoming webhook that fired risk alerts
  are pushed to. Without it alerts are only logged and counted. `ALERT_DEDUPE_SECONDS` is an
  ordinary var (default 1800, `0` disables dedupe).
- `SENTRY_DSN` (optional): when set, unhandled errors from the fetch, scheduled and queue handlers
  are reported as a plain Sentry envelope over `fetch` (no SDK). `SENTRY_RELEASE` tags the events.
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (optional): Web Push credentials. All
  three unset means the push channel reports itself unavailable and the notification bell stays
  empty. Generate the pair once with `npx web-push generate-vapid-keys` and keep it stable across
  deployments — rotating it invalidates every browser subscription already registered. `VAPID_SUBJECT`
  is a `mailto:` or `https:` URL the push service can contact about this application.
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET` (optional): the Telegram
  fallback channel. The token is the only required part; the username is what a player is shown
  when linking. Set the webhook to `https://diggo.fun/webhooks/telegram` with the secret as its
  `secret_token` — the route fails closed when it is unset or wrong.
- `JUPITER_API_KEY`, `PYTH_API_KEY` (optional): raise the price oracle's rate limits. The endpoints
  and the Pyth SOL/USD feed id have working public defaults, so an unconfigured deployment still
  reads a real price; `JUPITER_PRICE_URL`, `JUPITER_PRICE_V2_URL`, `PYTH_HERMES_URL`,
  `PYTH_SOL_USD_FEED_ID`, `ORACLE_MIN_EXTERNAL_SOURCES` and `ORACLE_SOL_USD_OVERRIDE` are ordinary
  vars for pinning those. `ORACLE_SOL_USD_OVERRIDE` is for local work only.

Set every production value with `wrangler secret put <NAME>`. `DISCOVERY_WINDOW_SECONDS`,
`DISCOVERY_ROLL_CHANCE_BPS` and `DISCOVERY_EPOCH_SECONDS` are ordinary vars: they are clamped by
`DISCOVERY_TUNABLE_BOUNDS` and `RNG_EPOCH_BOUNDS`, so a bad value cannot open the floodgates, stop
the subsystem, or stretch a commit-reveal epoch beyond its bounds.

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

The Worker also consults the `RATE_LIMITER` Rate Limiting binding before its KV counters: the binding is strongly consistent per key, while KV is eventually consistent and therefore not a replacement for WAF rate limiting. Both are defense in depth underneath the dashboard rules above.

## Observability

Workers Logs and Traces are enabled with full sampling for the MVP. Reduce `head_sampling_rate` once traffic grows. Logs are structured JSON and intentionally omit secrets, wallet signatures and Turnstile tokens.

## Initial page load

The frontend makes one Worker request on entry: `GET /api/bootstrap?limit=1000`. It returns public runtime configuration and up to 1,000 token summaries. The Worker reads the token batch from KV for 60 seconds; a D1 read occurs only after a cache miss. Individual token cards do not trigger follow-up Worker requests.

## Staging

`wrangler.jsonc` declares a `staging` environment with its own D1 database, KV namespace, queues,
Durable Objects, rate-limit namespace and Analytics Engine dataset, on devnet vars. Replace the two
placeholder ids marked `TODO(staging)` (the D1 `database_id` and the KV `id`) with the real ones
before the first deploy, then:

```bash
npx wrangler d1 create diggo-db-staging
npx wrangler kv namespace create TOKEN_CACHE --env staging
npx wrangler queues create diggo-indexing-staging
npx wrangler queues create diggo-indexing-staging-dlq
npm run types                     # regenerate bindings after any wrangler.jsonc change
npm run db:staging                # apply migrations to the staging database
npm run deploy:staging
```

Staging declares no custom-domain route, so it stays on `workers.dev` and can never serve
`diggo.fun` traffic. Secrets are per environment: use `wrangler secret put <NAME> --env staging`.

## Continuous integration

`.github/workflows/ci.yml` runs two jobs on every push and pull request:

- **Worker and client** — `npm ci`, `npm run types`, `npm run typecheck`, `npm run lint`,
  `npm test`, `npm run build`, then `wrangler deploy --dry-run` for both the production and the
  staging environment. A dry run needs no credentials; it proves the config resolves and the entry
  point bundles.
- **Anchor program** — pinned to the toolchain this repo is developed with (`anchor-cli 1.2.0`,
  Solana/Agave `4.1.2`, Rust `1.98.1`, matching `Anchor.toml`), then `cargo test --workspace
  --locked` followed by `anchor build`. Rust, cargo, Solana, avm and the SBF platform tools are
  cached between runs; bump the versions in the workflow `env` block whenever `Anchor.toml`
  changes, so CI cannot drift onto a different program toolchain than the one used locally.

`npm run check` remains the full local gate and covers everything the Worker job does.

## Observability and alerts

- Every counter written to `metrics_counters` in D1 is mirrored into Analytics Engine under
  `DIGGO_METRICS`, so a dashboard can query the same series with SQL without reading D1.
- When `ALERT_WEBHOOK_URL` is set, each alert that fires in the risk cron is pushed as a
  Discord/Slack compatible body (`content` for Discord, `text` for Slack, plus the structured
  alert). Alert names are deduped for `ALERT_DEDUPE_SECONDS` and at most five messages go out per
  tick; a delivery that fails does **not** start the dedupe window, so the next tick retries.
- When `SENTRY_DSN` is set, unhandled fetch, scheduled and queue errors are reported as a plain
  Sentry envelope over `fetch` — no SDK, so the bundle and the reporting path stay cheap.

## Production checklist

1. **Freeze.** Announce the window and stop merges to the branch being deployed.
2. **CI green.** `npm run check` locally and the `CI` workflow green on the exact commit being
   deployed. A red Rust job blocks the program, a red Worker job blocks the deploy.
3. **Secrets.** `wrangler secret put` for `DISCOVERY_SECRET`, `DIGGO_DEVICE_SALT`,
   `ADMIN_WALLETS`, `TURNSTILE_SECRET`, `HELIUS_WEBHOOK_AUTH`, `SUPABASE_SERVICE_ROLE_KEY`,
   `ALERT_WEBHOOK_URL` and `SENTRY_DSN`, plus whichever optional channels are wanted:
   `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT` for Web Push and
   `TELEGRAM_BOT_TOKEN`/`TELEGRAM_BOT_USERNAME`/`TELEGRAM_WEBHOOK_SECRET` for Telegram — and
   `DIGGO_KEEPER_SECRET_KEY` only if a keeper signer is deliberately hosted in the Worker.
   Confirm with `wrangler secret list` and replace the development Turnstile site key in
   `wrangler.jsonc` with the production one.
4. **Back up before migrating.** Take a D1 Time Travel bookmark first and record its id:
   `npx wrangler d1 time-travel info diggo-db`. Never apply a migration without a bookmark from
   the same minute; Time Travel is the only fast path back from a bad migration.
5. **Migrate.** `npm run db:production`. Migrations are sequential and additive — never edit or
   reorder one that has already been applied.
6. **Stage the rollout.** Deploy staging, run the smoke list below against it, then production. For
   a risky change, use `npx wrangler versions upload` followed by `npx wrangler versions deploy
   <version-id>@10%` and ramp 10% → 50% → 100% while watching error rates and the cron log lines.
7. **Verify after deploy.** `/api/config`; one activation, mine switch, reward claim and discovery
   roll on devnet; the `epoch.cron`, `social.cron` and `risk.cron` log lines every five minutes;
   one deliberate test alert through the webhook (in staging, with `ALERT_DEDUPE_SECONDS=0`).
8. **Multisig.** Treasury, keeper and program upgrade authority must be a Squads-style multisig on
   mainnet, never a single hot key: upgrade authority on a multisig, the keeper signer isolated in a
   dedicated signer service (see `docs/CUSTODY.md`), and at least two signers held separately.
   Confirm with `solana program show <PROGRAM_ID>` that the upgrade authority is the multisig and
   that no single-key admin survives.
9. **Know the rollback.** Keep the previous Worker version id and the Time Travel bookmark to hand:
   `npx wrangler versions deploy <previous-version-id>` for code, and
   `npx wrangler d1 time-travel restore diggo-db --bookmark <id>` for data — a restore discards
   every write after the bookmark, so it is a last resort for a bad migration only.
10. **Mainnet switch.** Move `SOLANA_CLUSTER` and the program/treasury/keeper ids together in one
    reviewed change, re-run the dry-run deploy diff, and repeat steps 6–7.
