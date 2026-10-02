# Diggo.fun

**Diggo.fun is a Solana memecoin launchpad with a mining game built in.** Creators launch coins;
players run a crew that mines those coins every day and claims what it digs up to their own wallet.

## The idea in one minute

Most launchpads stop at the launch: a coin goes live, trades for a while, and attention moves on.
Diggo gives every launch a second life as a **mine**. Players open a daily mining shift, their
**crew** digs memecoins out of the mines, and they come back tomorrow to do it again. Creators get
a market plus a steady reason for players to show up; players get a daily game that pays out in
real tokens.

| | For players | For creators |
| --- | --- | --- |
| **What you do** | Connect a wallet, activate a 24-hour shift, claim what your crew mined | Launch a fixed-supply SPL coin from your own wallet |
| **Where it runs** | Mining is tracked by Diggo; payouts are Solana transactions you sign | Trading runs on a Meteora Dynamic Bonding Curve from the first block |
| **What you get** | Real memecoins in your wallet, plus ORE to upgrade Miners, Drills and Carts | A coin that becomes a mine players work every day |

### The player loop

1. **Connect & activate.** Sign in with a Solana wallet and open a 24-hour mining window.
2. **Your crew digs.** Diggo assigns an eligible mine at random; the crew keeps working while the
   window is active, even with the browser closed.
3. **Collect discoveries.** Mined memecoins accrue in Discoveries. Rewards from a coin still on its
   bonding curve stay pending until its Meteora pool graduates.
4. **Claim all.** One wallet-approved transaction pays out up to 12 distinct coins.
5. **Come back.** Keep your streak, upgrade the crew with ORE, refer players and creators.

### What is real and what is game

- **Real, on Solana:** mined memecoins are SPL tokens; launches and trades settle on chain through
  Meteora; every payout is a transaction the player reviews and signs.
- **Game progression only:** ORE, Mining Power and crew levels. They are not tokens, cannot be
  transferred or withdrawn, and cannot be bought with SOL or memecoins.

Memecoin prices can change or fall to zero. Mining rewards are not guaranteed.

### How it is built

- **Client:** React + Vite (`src/`), wallet connection via Wallet Standard / Reown.
- **Backend:** a single Cloudflare Worker (`worker/`) with D1 (index and game state), queues,
  Durable Objects and workflows. Solana is the source of truth for settlement; Cloudflare storage
  is a cache and index.
- **Chain:** Meteora Dynamic Bonding Curve for launches and trading (`CHAIN_MODE=meteora`). The
  native Anchor program in `programs/` is historical / future architecture.
- **Shared logic:** economics, curve maths and contracts in `shared/`, covered by Vitest.

## Current mainnet status

The repository is configured for `CHAIN_MODE=meteora` and the production environment points at
`SOLANA_CLUSTER=mainnet-beta`. The approved production DBC config is
`5yxCKEmi1rc5ebKmWdHbzj2pEe7caqS8xqvQh5V8duMF`; its fee claimer is
`6HHEkX5MxsoQwyCJZHvLnewmnsaw19vGT9Y8jhqH7GuJ`, and the mining vault / leftover receiver is
`H5TTpszeSNneNNxypM3UjaWMjVRNTvmWSCXfgXtzdELT`. This configuration is not by itself a declaration
that public mainnet launch is ready. Prelaunch education and demonstrations may continue, but public
access should remain closed until the readiness gate below is complete and reviewed.

Current blockers are:

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
