# Diggo.fun

Diggo.fun is a Solana meme-coin launchpad wrapped in a finite-reserve mining game. This repository contains a production-shaped Cloudflare MVP: a React frontend, Worker API, D1 index, R2 media storage, KV cache and wallet sessions, per-token Durable Objects, Helius event queues, a scheduled epoch Workflow, and Turnstile protection.

The UI is functional on devnet. The actual Solana programs and vanity-key generation service are deliberately outside this web repository; the launch API creates a secure job and requires every completed mint address to end in `diggo`.

## Local development

Requirements: Node.js 24+ and a free Cloudflare account for deployment.

```bash
npm install
npm run types
npm run build
npm run db:local
npm run dev:worker
```

Open [http://127.0.0.1:8787](http://127.0.0.1:8787). For frontend hot reload, run `npm run dev` in another terminal and open port 5173; Vite proxies API calls to the Worker.

`localhost` accepts the explicit `dev-bypass` Turnstile token. This bypass is rejected on every non-local hostname.

## Verification

```bash
npm run check
npm audit
```

The check runs TypeScript, economic-invariant tests, the production frontend build, and a Wrangler deployment dry run.

## Cloudflare deployment

1. Replace `TURNSTILE_SITE_KEY` in `wrangler.jsonc` with the public key of a Diggo production widget.
2. Add secrets; never put them in Git:

   ```bash
   npx wrangler secret put TURNSTILE_SECRET
   npx wrangler secret put HELIUS_WEBHOOK_AUTH
   ```

   Store the Helius value including its scheme, for example `Bearer <long-random-value>`, and put the exact same value in Helius `authHeader`.

3. Deploy the Worker and automatically provision declared bindings:

   ```bash
   npm run build
   npx wrangler deploy
   npx wrangler d1 migrations apply diggo-db --remote
   ```

4. Configure Helius to deliver enhanced Solana events to `https://diggo.fun/webhooks/helius`.
5. Attach `diggo.fun` as a Worker custom domain, proxy DNS through Cloudflare, and enable a WAF rate-limit rule for `POST /api/tokens`, `POST /api/auth/*`, and `/webhooks/*`.

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md), [docs/SECURITY.md](docs/SECURITY.md), and [docs/VANITY_MINT.md](docs/VANITY_MINT.md) before a mainnet release.

## Defaults

- mining theme with neutral protocol terminology;
- 95% launch allocation / 5% program-controlled Unmined Reserve;
- 5-minute blocks and 7-day epochs;
- 25% reward reduction per epoch;
- upgrades route 70% to reserve, burn 20%, and route 10% to protocol;
- one active mine per player;
- Wallet Standard discovery through the current Solana Kit wallet plugin—no paid wallet service.

The original product architecture is preserved in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
