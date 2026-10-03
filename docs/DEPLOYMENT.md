# Deployment and mainnet readiness

## Current deployment boundary

Production is configured for Solana `mainnet-beta` with `CHAIN_MODE=meteora`. Staging remains on
devnet with Meteora. The native on-chain program is not the current production path: its design
and custody history remain useful operator context, but native launch steps must not be used as a
Meteora deployment checklist.

The approved production Meteora DBC config is
`5yxCKEmi1rc5ebKmWdHbzj2pEe7caqS8xqvQh5V8duMF`. Its fee claimer is
`6HHEkX5MxsoQwyCJZHvLnewmnsaw19vGT9Y8jhqH7GuJ`, and its mining vault / leftover receiver is
`H5TTpszeSNneNNxypM3UjaWMjVRNTvmWSCXfgXtzdELT`. Public mainnet access is still readiness-gated;
the configured addresses are not by themselves evidence that the live launch and payout flow has
been rehearsed.

Prelaunch education may explain the product journey, but it must not imply that mainnet launches,
mining payouts, or rewards are live before the gates below are complete.

## Public launch gates

Before announcing public mainnet access:

1. Independently verify that the production environment still uses the approved DBC config
   `5yxCKEmi1rc5ebKmWdHbzj2pEe7caqS8xqvQh5V8duMF`, fee claimer
   `6HHEkX5MxsoQwyCJZHvLnewmnsaw19vGT9Y8jhqH7GuJ`, and vault
   `H5TTpszeSNneNNxypM3UjaWMjVRNTvmWSCXfgXtzdELT`.
2. Configure a keyed, mainnet RPC provider as `DIGGO_RPC_URL`; retain only mainnet-compatible
   fallbacks in `DIGGO_RPC_URLS`.
3. Apply the production D1 migrations and confirm the scheduled Meteora indexer is healthy.
4. Fund and verify the configured payer and mining vault for the operations they will actually
   perform. See [METEORA_OPS.md](./METEORA_OPS.md) for the reviewed configuration, key handling,
   and funding reference.
5. Rehearse a funded mainnet launch, mining, Discoveries, and Claim all flow. This includes both
   ordinary prepared claims and any operation that needs the mining vault; the rehearsal must
   prove the correct authorizations, token accounts, and sufficient balances.
6. Complete the required security review before treating the deployment as ready. This document
   does not assert an audit, legal status, or security outcome that has not been completed.

Mining-vault rent reclaim is unavailable in Meteora mode. The UI does not offer the native
program's rent-reclaim action; do not advertise it as a live feature.

## Required production configuration

The following values must be reviewed together. Cluster-specific program IDs from the historical
native deployment must not be paired with `mainnet-beta` or used as a Meteora readiness signal.

| Setting | Requirement |
| --- | --- |
| `CHAIN_MODE` | `meteora` |
| `SOLANA_CLUSTER` | `mainnet-beta` |
| `METEORA_DBC_CONFIG` | `5yxCKEmi1rc5ebKmWdHbzj2pEe7caqS8xqvQh5V8duMF` |
| `DIGGO_RPC_URL` | Keyed mainnet RPC URL supplied as a Wrangler secret |
| `DIGGO_RPC_URLS` | Mainnet-compatible fallbacks only, if used |
| `MINING_VAULT_SECRET` | Operational mining-vault key supplied as a Wrangler secret, never a plain var; required for the validated payout/vault path, though the Worker can boot and index without it |
| `MINING_VAULT_PUBLIC_KEY` | `H5TTpszeSNneNNxypM3UjaWMjVRNTvmWSCXfgXtzdELT`; must match the on-chain `leftoverReceiver` |
| `TURNSTILE_SECRET` | Required for verified production launch flows; the server verifies the production Turnstile response |

Set secrets independently per environment:

```text
npx wrangler secret put DIGGO_RPC_URL
npx wrangler secret put MINING_VAULT_SECRET
npx wrangler secret put TURNSTILE_SECRET
```

Use the `--env staging` form for every command in the deployed environment that owns the setting.
Named environments do not inherit production variables or secrets. Do not place private keys, API
keys, webhook secrets, or vault keypair files in the repository or in Wrangler plain variables.

`TURNSTILE_SITE_KEY` is public client configuration, not a secret. The site key in the current
production Wrangler config has a test-site appearance and must be replaced with an approved
production site/host pairing before verified launches. No production secret value belongs in this
document.

The mining vault is an operational signer, not a general trading reserve. Its needed operations
and the player-authorized claim path must be checked in the funded rehearsal before it is declared
ready. More detail is in [CUSTODY.md](./CUSTODY.md) and [METEORA_OPS.md](./METEORA_OPS.md).

## Feature and operator configuration

The Worker has a working configuration without every optional integration below. Set a secret only
when the corresponding feature or operator action is enabled, and keep the matching public
configuration in the target environment.

| Setting | When it is needed |
| --- | --- |
| `ADMIN_WALLETS` | Comma-separated admin wallet addresses, added to the built-in admins in `worker/admin.ts` (`BUILT_IN_ADMIN_WALLETS`) |
| `INDEXER_ADMIN_SECRET` | Required only for manual indexer refresh endpoints; the scheduled indexer does not depend on it |
| `HELIUS_WEBHOOK_AUTH` | Required only when the Helius webhook delivery path is enabled and authenticated |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase integration configuration; the service-role key is a secret and is required only when that integration is used |
| `DIGGO_DEVICE_SALT` | Strongly recommended for production signal hashing; absent, the Worker has a constant-salt fallback rather than failing to boot |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | All three are needed to enable Web Push; without the complete set, the push channel is unavailable |
| `TELEGRAM_BOT_TOKEN` | Enables Telegram delivery; not needed when that channel is not enabled |
| `TELEGRAM_WEBHOOK_SECRET` | Required for the public Telegram webhook when Telegram is enabled |
| `TELEGRAM_BOT_USERNAME` | Optional Telegram metadata |
| `SENTRY_DSN` | Optional error reporting destination |
| `SENTRY_RELEASE` | Optional Sentry release label |
| `ALERT_WEBHOOK_URL` | Optional operator alert destination |
| `ALERT_DEDUPE_SECONDS` | Optional alert de-duplication window; the code supplies a default |
| `DIGGO_CRANK_SECRET_KEY` | Optional native-path fee-payer key only; it is not required for the current Meteora path |

Configure enabled integrations per environment, for example:

```text
npx wrangler secret put ADMIN_WALLETS
npx wrangler secret put INDEXER_ADMIN_SECRET
npx wrangler secret put HELIUS_WEBHOOK_AUTH
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put DIGGO_DEVICE_SALT
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put SENTRY_DSN
npx wrangler secret put ALERT_WEBHOOK_URL
```

`VAPID_SUBJECT` is normally the Web Push contact, such as a `mailto:` or HTTPS URL. It is still a
deployed configuration value and should not be replaced with a private key. `TELEGRAM_BOT_USERNAME`
and the Sentry/alert optional metadata can be set as environment-specific configuration when the
integration needs it.

## Data and scheduled work

Apply migrations with the target environment's existing script, for example:

```text
npm run db:production
```

Back up D1 and take a same-minute Time Travel bookmark before a production migration. Migrations
are sequential; do not edit or reorder an already-applied migration.

In Meteora mode the five-minute scheduled handler runs the Meteora pool indexer, mine-registration
and graduation propagation, referral settlement, and the vault sweep when its signing secret is
available. It does not run the native crank or native reconciliation path. A missing vault secret
does not stop indexing, but it can leave operations that require the vault pending.

## Local and staging development

For local UI and Worker work:

```text
npm install
npm run db:local
npm run dev:local
```

`npm run dev:local` applies local D1 migrations and starts the Worker and Vite client together.
Local development can use the devnet Meteora configuration. Demo mine seeding is for local
accounting only and must never be applied to production.

Staging is a separate devnet environment. Replace its placeholder D1 and KV resource IDs, apply
staging migrations, and supply its own RPC and vault secrets before a staging smoke test. Staging
must never receive production D1 data or be used as evidence that mainnet is ready.

## Deploying a reviewed build

The deploy scripts use the environment already declared in `wrangler.jsonc`. After the target
environment's configuration and secrets are reviewed, apply its remote D1 migrations and run its
normal deploy command:

```text
npm run db:production
npm run deploy:production
```

For staging, use the separate devnet resources and named environment:

```text
npm run db:staging
npm run deploy:staging
```

Do not use a staging command to prepare production, and do not run either deploy command until the
corresponding launch gates above are satisfied. A Wrangler dry run is a configuration/build check;
it is not evidence that the funded mainnet rehearsal or public readiness gates have passed.

## Deployment verification

After a reviewed deployment, verify:

- `/api/config` and `/api/status` return the expected cluster and Meteora mode;
- the scheduled indexer log shows successful pool discovery rather than only a local seed;
- a real pool is accepted only after its DBC account and configured address are verified;
- the launchpad launch flow reaches the expected Meteora curve state;
- activation, random mining, Discoveries, Claim all, and the return/referral loop are exercised in
  the funded rehearsal;
- errors, retry behavior, and the cron log are reviewed before public access is opened.

The canonical Meteora configuration and its known open product decisions are tracked in
[METEORA_OPS.md](./METEORA_OPS.md). Public explanations of the current game and its limitations are
in [FAQ.md](./FAQ.md). Trust-boundary and review expectations are in [SECURITY.md](./SECURITY.md).

## Historical native deployment reference

The former native program deployment, account migration, crank, and upgrade-authority procedures
are retained in [ONCHAIN.md](./ONCHAIN.md) and [ONCHAIN_V2_DESIGN.md](./ONCHAIN_V2_DESIGN.md) as
architecture history and possible future work. They are not instructions for the current
`CHAIN_MODE=meteora` mainnet launch.
