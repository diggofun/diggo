# Diggo.fun

Diggo.fun is a Solana memecoin launchpad combined with a mining game. Creators launch projects
and tokens into the same ecosystem that players use for repeat participation.

The player journey is:

1. Connect a wallet and activate a 24-hour mining window.
2. Complete a random mining interaction with the active crew.
3. Review mined memecoins as they accrue in Discoveries.
4. Use **Claim all** to sign a wallet-approved batch payout for up to 12 distinct coins.
5. Return for the next mining window, or refer relevant players and creators to the ecosystem.

ORE and Mining Power are game progression. They are not tokens, cannot be transferred or
withdrawn, and cannot be bought with SOL or memecoins. Mined memecoins are real SPL tokens and
their value can change or fall to zero.

## Current mainnet status

The repository is configured for `CHAIN_MODE=meteora` and the production environment points at
`SOLANA_CLUSTER=mainnet-beta`. That configuration is not by itself a declaration that public
mainnet launch is ready. Prelaunch education and demonstrations may continue, but public access
should remain closed until the readiness gate below is complete and reviewed.

Current blockers are:

- replacing the production `METEORA_DBC_CONFIG=SET_AFTER_CREATE` placeholder with a verified mainnet
  config address;
- configuring a production-grade RPC, applying D1 migrations, and funding and verifying the payer
  and mining-vault accounts;
- rehearsing the real mainnet launch, mining, Discoveries and wallet-approved Claim all payout
  flow end to end;
- completing the required security review and recording its findings and unresolved items;
- accepting that the native-program rent-reclaim action is unavailable in Meteora mode.

The native Solana program is not the current production chain path. Documents that describe its
authority model, pool custody, account migration or v2 design are preserved as historical and
future architecture; see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
[docs/ONCHAIN.md](docs/ONCHAIN.md), and [docs/ONCHAIN_V2_DESIGN.md](docs/ONCHAIN_V2_DESIGN.md).

## Start here

- [Player and creator FAQ](docs/FAQ.md)
- [Current Meteora deployment status](docs/DEPLOYMENT.md)
- [Meteora operations and launch preparation](docs/METEORA_OPS.md)
- [Security boundaries and current limitations](docs/SECURITY.md)
- [Custody policy](docs/CUSTODY.md)

## Local development

Requirements: Node.js 24+ and a Cloudflare account for Worker deployment.

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

The check runs TypeScript, tests, the production frontend build, and a Wrangler deployment dry
run. Documentation changes must not be treated as evidence that the readiness blockers above have
been completed.
