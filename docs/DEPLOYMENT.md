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

No secret is needed for the game loop to work. The v2 Worker holds no key the program trusts: it
indexes, serves reads and sends notifications, and everything that moves value is a transaction the
player signs. `DIGGO_DEVICE_SALT` and `ADMIN_WALLETS` are the two values worth setting locally;
`HELIUS_WEBHOOK_AUTH` is needed only if a webhook is configured, and `DIGGO_RPC_URL` only if the
public devnet RPC is too slow for local work. `DIGGO_CRANK_SECRET_KEY` is optional and can wait:
without it the crank is off and the protocol still converges, because every user-signed instruction
opportunistically advances the coin it touches.

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
| `RATE_LIMITER` | Rate Limiting | strongly consistent per-key limiter consulted before the KV counters in `worker/http.ts` |
| `DIGGO_METRICS` | Analytics Engine | **not declared.** Counter mirror of `metrics_counters`, for dashboard and alerting queries. The account has Analytics Engine disabled, so declaring the binding fails the deploy with error 10089. See "Re-enabling the Analytics Engine mirror" below. |

Create a queue named `diggo-indexing-dlq` before production deployment if automatic provisioning does not create the configured dead-letter queue.

## Required secrets and chain configuration

`DIGGO_RPC_URL` is required for every deployed environment, even though `diggo.fun` is intentionally
on devnet. It must be set with `wrangler secret put DIGGO_RPC_URL`; the public devnet endpoint is
only a local Wrangler fallback. `SOLANA_CLUSTER`, `DIGGO_PROGRAM_ID`, `DIGGO_TREASURY` and the RPC
endpoint must be reviewed together when changing networks. The current devnet program is
`H3Y8GgTnvwv5U1bajfzj386YSPC48vvwjFroXYyHZFj5` and must not be paired with `mainnet-beta`.

The other entries below are optional. The deployment is otherwise fully functional with the
defaults in `wrangler.jsonc`.

- `DIGGO_DEVICE_SALT`: server-side salt for the IP/device/network hashes in `worker/signals.ts`.
  Set it in production so a stolen hash cannot be matched against a rainbow table of known IPs.
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
- `DIGGO_RPC_URL` (required when deployed): the cluster-matched RPC endpoint. Use an HTTP(S) URL
  without embedded credentials. Local `wrangler dev` may omit it and use public devnet.
- `DIGGO_CRANK_SECRET_KEY` (optional): the crank bot's fee payer. It has **no authority of any
  kind** - every instruction it sends (`advance_mine`, `commit_epoch_seed`, `graduate_market`,
  `sweep_fees`) is permissionless, so a stranger could send the same transaction with their own
  wallet. The key exists to pay the fee, and a leaked one costs its holder the fees it was already
  paying. Set `CRANK_ENABLED=0` to turn the bot off without removing the secret.
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

Set every production value with `wrangler secret put <NAME>`. The indexer's own knobs
(`INDEXER_SIGNATURE_LIMIT`, `INDEXER_MAX_PAGES`, `INDEXER_COIN_LIMIT`, `CRANK_ENABLED`) are
ordinary vars and are clamped in `worker/env.ts`, so a bad value costs a slow pass rather than a
runaway one. Every v2 parameter - the discovery caps, the rarity table, the epoch-seed delays and
the sponsor defaults - is a `ProtocolConfig` field changed through the timelock, not a Worker
secret, which is the point: the Worker cannot move any of them.

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
  `DIGGO_METRICS`, so a dashboard can query the same series with SQL without reading D1. The
  mirror is best effort: D1 is the source of truth and nothing alerts on the mirror, so the
  Worker runs unchanged while the binding is absent.
- When `ALERT_WEBHOOK_URL` is set, each alert that fires in the risk cron is pushed as a
  Discord/Slack compatible body (`content` for Discord, `text` for Slack, plus the structured
  alert). Alert names are deduped for `ALERT_DEDUPE_SECONDS` and at most five messages go out per
  tick; a delivery that fails does **not** start the dedupe window, so the next tick retries.
- When `SENTRY_DSN` is set, unhandled fetch, scheduled and queue errors are reported as a plain
  Sentry envelope over `fetch` — no SDK, so the bundle and the reporting path stay cheap.

### Re-enabling the Analytics Engine mirror

`wrangler.jsonc` declares no `analytics_engine_datasets` binding. A Worker that declares one is
rejected at deploy time with error 10089 (`Analytics Engine is not enabled for this account`) on
any account where the product has never been switched on, and the rejection blocks the whole
deploy rather than just the binding. The binding was therefore removed so the rest of the Worker
can ship; `worker/telemetry.ts` already treats it as optional.

To restore the mirror:

1. Enable Analytics Engine for the account in the Cloudflare dashboard: **Workers & Pages** →
   **Analytics Engine** → enable, or subscribe to a plan that includes it.
2. Confirm the dataset exists: `npx wrangler analytics-engine list` (create it first if the
   account requires an explicit dataset, `diggo_metrics` for production and `diggo_metrics_staging`
   for staging).
3. Restore the binding in both blocks of `wrangler.jsonc`:

   ```jsonc
   // top level, production
   "analytics_engine_datasets": [{ "binding": "DIGGO_METRICS", "dataset": "diggo_metrics" }],

   // env.staging
   "analytics_engine_datasets": [{ "binding": "DIGGO_METRICS", "dataset": "diggo_metrics_staging" }],
   ```

   Named environments do not inherit bindings, so the staging block needs its own copy.
4. `npm run types && npm run check`, then deploy. No application code changes are needed:
   `metricsDatasetBinding()` picks the binding up as soon as it exists.

Nothing else depends on the mirror. Alerts, the risk cron and the D1 counters are unaffected
whether or not it is enabled, and the gap is not backfilled, so the AE series restarts from the
moment the binding is restored.

## Production checklist

1. **Freeze.** Announce the window and stop merges to the branch being deployed.
2. **CI green.** `npm run check` locally and the `CI` workflow green on the exact commit being
   deployed. A red Rust job blocks the program, a red Worker job blocks the deploy.
3. **Secrets.** `wrangler secret put` for `DIGGO_DEVICE_SALT`,
   `ADMIN_WALLETS`, `TURNSTILE_SECRET`, `HELIUS_WEBHOOK_AUTH`, `SUPABASE_SERVICE_ROLE_KEY`,
   `ALERT_WEBHOOK_URL` and `SENTRY_DSN`, plus whichever optional channels are wanted:
   `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT` for Web Push and
   `TELEGRAM_BOT_TOKEN`/`TELEGRAM_BOT_USERNAME`/`TELEGRAM_WEBHOOK_SECRET` for Telegram, plus the
   required deployed `DIGGO_RPC_URL` — and
   `DIGGO_CRANK_SECRET_KEY` only if the optional crank is wanted. Confirm that no
   `DIGGO_KEEPER_SECRET_KEY` and no `DISCOVERY_SECRET` survive from a v4 deployment: neither is
   read any more, and leaving a key in place that nothing uses is a liability with no upside.
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
7. **Verify after deploy.** `/api/config` and `/api/status`; the `indexer.cron` log line every
   two minutes showing accounts and events; `/api/discovery/seeds` returning a seed for the running
   epoch; then one full devnet pass driven from the client - launch, buy, activate, assign,
   advance, seed commit, roll, settle, sweep and graduate - with the index following along. If the
   crank is enabled, `/api/status` should show its recent runs.
8. **Multisig.** Treasury and program upgrade authority must be a Squads-style 2-of-3 multisig on
   mainnet, never a single hot key, with at least two signers held separately.
   There is no keeper to isolate any more: the only Worker-held key is the crank's fee payer, and
   it holds no authority, so it needs no custody ceremony beyond not being the treasury.
   Confirm with `solana program show <PROGRAM_ID>` that the upgrade authority is the multisig and
   that no single-key admin survives.
9. **Know the rollback.** Keep the previous Worker version id and the Time Travel bookmark to hand:
   `npx wrangler versions deploy <previous-version-id>` for code, and
   `npx wrangler d1 time-travel restore diggo-db --bookmark <id>` for data — a restore discards
   every write after the bookmark, so it is a last resort for a bad migration only.
10. **Mainnet switch.** Move `SOLANA_CLUSTER` and the program/treasury ids together in one
    reviewed change, re-run the dry-run deploy diff, and repeat steps 6–7.

## v2 cutover notes

- **Migrations to apply:** `0021_indexer_only.sql` (the v2 read model) and `0023_trade_fill.sql`
  (the received side of a trade: `trades.amount_out` and `trades.fill_source`). Both are additive
  and idempotent.
- **Fresh devnet, no migration.** v2 is a new program id with a wiped devnet, so no v2 account needs
  a migration path. Migration `0021_indexer_only.sql` drops the v4 decision tables (breakers,
  commit-reveal commitments, discovery opportunities, reward claims, mining reports, off-chain
  positions) and carries `usernames` and the profile rows of `players` across unchanged.
- **The Durable Object mutex is retired** by its own migration tag (`v3`,
  `deleted_classes: ["PlayerLock"]`), so a deployment that already applied `v2` still converges.
  There is no server-side mutation left to serialise.
- **The cron cadence is two minutes**, down from five, because the index is what the read API
  serves. Every step in the tick is idempotent and independently guarded, so one failing step never
  costs the pass its chain reads.

### Fresh devnet deploy, step by step

The program id is `H3Y8GgTnvwv5U1bajfzj386YSPC48vvwjFroXYyHZFj5`; its keypair lives at
`/home/jurek/.solana-diggo/program-v3.json` and is never in the repository. `Anchor.toml`,
`wrangler.jsonc` and the Worker's `DIGGO_PROGRAM_ID` must all name that id, and the client reads it
from `/api/bootstrap`, so a deploy that updates only one of them shows up as a UI with no program
at all rather than as a wrong address.

1. **Build, in WSL.** The Rust tree builds only under Linux; the release profile in
   `programs/diggo-protocol/Cargo.toml` (`lto = "fat"`, `codegen-units = 1`, `opt-level = "z"`,
   `strip = true`, with `overflow-checks` and `panic = "abort"` kept on) is what keeps the binary
   inside the deployed ProgramData account. `cargo test --workspace` first: the unit suite is the
   only gate that runs without a validator.
2. **Deploy to devnet** with that keypair (`solana program deploy --program-id <keypair> ...`), then
   verify the deployed hash against the local `.so` before anything is initialized. A partial
   deploy is indistinguishable from a good one from the client's side.
3. **Retire the v4 program** and close its buffers. Devnet holds no coins, so nothing of value is
   discarded; `migrate-accounts.ts` and `transfer-authorities.ts` were deleted with v4 because there
   is no migration and no single-key authority transfer in v2.
4. **`initialize_protocol`** with the rarity table, the fee split, the caps in lamports, the curve
   tables, the sponsor defaults and the epoch-seed delays — the same numbers `src/constants.ts` shows
   the player, which `src/constants.test.ts` pins against the contract.
5. **Hand over to the multisig** (below), then confirm with `solana program show <PROGRAM_ID>` that
   the upgrade authority is the multisig and that no other key can upgrade or change config.

Phase 3 owns the scripted form of these steps (`scripts/onchain/deploy-v2.ts`, `wipe-devnet.ts`,
`init-v2.ts`, `squads-setup.ts`, `freeze-program.ts`); today only `scripts/onchain/lib.ts` is in the
tree, and the steps above are the manual path it will automate.

### Squads: 2-of-3 with a 48-hour timelock

A Squads v4 multisig holds the program **upgrade authority** and every remaining admin config
(`update_fee_config`, `update_discovery_limits`, `set_rarity_table`, `set_curve_table`,
`schedule_pause`) from day one of v2, with a 48-hour transaction timelock. Three members, two
signatures; the sponsor vault is deliberately **not** part of it — it belongs to the owner's own
wallet, holds lamports, and has no program authority of any kind.

After an external audit and before any mainnet value, the end state is a frozen program:
`set_upgrade_authority` to none. That removes the upgrade path and with it the last operator-shaped
lever over the game, so it is a one-way door: rehearse it on devnet first.

### The crank bot

The crank is optional and permissionless. `DIGGO_CRANK_SECRET_KEY` is a fee payer with **no
authority**: the instructions it sends (`advance_mine`, `commit_epoch_seed`, `settle_discovery`,
`expire_opportunity`, `graduate_market`, `sweep_fees`, `crank_tip`) are the same ones any wallet
can send, and `/api/status` reports its recent runs. Without the key the crank is off and the
protocol still converges, because every user-signed instruction advances the coin it touches.

Fund the payer with a little SOL and let `crank_tip` reimburse it out of accrued protocol fees; a
tip is capped at `CRANK_TIP_BPS` of the protocol bucket and is never paid out of a reserve, the
curve's SOL or the locked pool.

### Running the chain-dependent end-to-end specs

The Playwright suite drives the local dev pair (vite + `wrangler dev`) and needs no validator for
the flows it asserts: rendering, the launch cost, onboarding copy, the sponsor default, the legal
documents. Two flows cannot pass without a chain and are skipped with their reason —
`upgrade_crew` (the ORE it spends lives in the player's on-chain PlayerAccount) and any assertion
about a roll's *outcome*. To exercise those, deploy the built `.so` to a local validator and point
the pair at it:

```bash
# In WSL, where the program builds:
solana-test-validator --reset --quiet &
solana program deploy --program-id /home/jurek/.solana-diggo/program-v3.json \
  target/deploy/diggo_protocol.so
```

then start the pair with the validator as the RPC (`DIGGO_RPC_URL=http://127.0.0.1:8899`) and
remove the two skips. The suite's ports are overridable (`DIGGO_CLIENT_PORT`, `DIGGO_WORKER_URL`,
`DIGGO_E2E_BASE_URL`, `DIGGO_E2E_WORKER_URL`) so a run can target a pair on other ports — which
matters on a shared machine, because Playwright reuses whatever already answers on its base URL.
