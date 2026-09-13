# Deployment checklist

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

- `TURNSTILE_SECRET`: private key for the production Turnstile widget.
- `HELIUS_WEBHOOK_AUTH`: exact authorization header configured in Helius, including `Bearer `.
- `SUPABASE_SERVICE_ROLE_KEY`: Supabase secret key used only by the Worker to upload and retrieve private artwork.

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

## Order of operations

1. `npm run check`
2. configure production Turnstile key and secrets
3. `npx wrangler deploy`
4. `npx wrangler d1 migrations apply diggo-db --remote`
5. configure Helius
6. attach the custom domain and WAF policies
7. verify `/api/config`, `/api/tokens`, media upload and one signed launch job on devnet
