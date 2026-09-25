# Meteora DBC operations

## Current readiness status

Production is configured for `CHAIN_MODE=meteora` on `mainnet-beta` with the approved DBC config
`5yxCKEmi1rc5ebKmWdHbzj2pEe7caqS8xqvQh5V8duMF`. Its fee claimer is
`6HHEkX5MxsoQwyCJZHvLnewmnsaw19vGT9Y8jhqH7GuJ`, and its mining vault / leftover receiver is
`H5TTpszeSNneNNxypM3UjaWMjVRNTvmWSCXfgXtzdELT`. Public mainnet launch is not ready: production
RPC, migrations, required funding, a funded end-to-end launch/mining/Discoveries/Claim all
rehearsal, and the required security review must still be complete before public access is opened.

Native-program rent reclaim is unavailable in Meteora mode. The historical native reclaim action
must not be represented as available in the current product.

This runbook covers the temporary Meteora Dynamic Bonding Curve (DBC) launch path. The native
Anchor program in `programs/diggo-protocol` is not used by these scripts. The pinned SDK is
`@meteora-ag/dynamic-bonding-curve-sdk@1.5.13`.

## Fixed configuration

- DBC program: `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`
- Migration target: DAMM v2, `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`
- Quote mint: wrapped SOL, `So11111111111111111111111111111111111111112`
- Supply: 1,000,000,000 SPL tokens with 9 decimals
- Leftover reserve: 200,000,000 tokens (20%) to the mining vault
- Diggo partner fee claimer: `6HHEkX5MxsoQwyCJZHvLnewmnsaw19vGT9Y8jhqH7GuJ`
- Diggo Worker treasury (`DIGGO_TREASURY`): `6HHEkX5MxsoQwyCJZHvLnewmnsaw19vGT9Y8jhqH7GuJ`
- Pool creation fee: 0.01 SOL; the SDK/program split applies at pool creation
- Creator trading fee: 0%
- Anti-sniper schedule: 3% to 1% over 60 minutes, with dynamic fees enabled
- Migration threshold: 2 SOL on devnet, 85 SOL on mainnet
- Partner liquidity: 90%, including 10% permanently locked; creator liquidity: 0%
- DAMM v2 migrated pool fee: 1% (100 bps)
- Approved migration fee: 1% (the pinned SDK cannot represent the researched 0.5% value)
- Approved `percentageSupplyOnMigration`: 25%

The SDK's `Customizable` migration fee accepts whole percentage points. The approved config uses 1%
with a 0% creator share. The requested 0.5% cannot be represented by SDK 1.5.13; this limitation is
part of the approved configuration and must be kept in any future SDK upgrade review.

The SDK also requires a curve split. The approved configuration uses
`percentageSupplyOnMigration: 25`.

`feeClaimer`, the leftover receiver, and the partner/creator split are fixed when `createConfig`
creates the config account. The pinned SDK and program IDL expose no instruction to change those
config destinations. `DIGGO_TREASURY` is a Worker setting for Diggo-controlled flows; it does not
change the config or redirect fees from an existing pool. Meteora's pool-creation protocol fee also
has a separate program-controlled treasury, so `DIGGO_TREASURY` cannot redirect that protocol-level
fee. Separately, the program does expose `updatePoolFees` for an authorized pool operator, so a
pool's cliff, dynamic, and compounding fee parameters are mutable even though the config's fee
destinations and partner/creator split are fixed.

## Key handling

Never put a keypair JSON file in the repository. The scripts reject paths under `scripts/` and
`create-mining-vault-keypair.ts` refuses to overwrite an existing file. The keypair is written with
owner-only permissions where the host supports them.

Generate a mining-vault keypair outside the checkout (mainnet paths shown here):

```powershell
npx tsx scripts/meteora/create-mining-vault-keypair.ts `
  --output C:\Users\Jurek\.diggo-mainnet\mining-vault.json
```

Store the secret as `MINING_VAULT_SECRET` in the actual `.dev.vars` for local Worker use, or as a
Wrangler secret in deployed environments. The example file contains only the name, never a value.
Back up the keypair offline. The mining vault is the `leftoverReceiver` in the DBC config; it does
not receive the 200M tokens until the curve has completed and `withdrawLeftover` succeeds.

## Creating a config

The payer path must be outside the repository. `create-config.ts` takes the mining-vault public
key, not the keypair file path:

```powershell
npx tsx scripts/meteora/create-config.ts `
  --cluster mainnet `
  --payer C:\Users\Jurek\.diggo-mainnet\payer.json `
  --mining-vault H5TTpszeSNneNNxypM3UjaWMjVRNTvmWSCXfgXtzdELT `
  --rpc-url $mainnetRpc
```

Read the keyed RPC into a process-local variable without printing it:

```powershell
$mainnetRpc = (Get-Content -Raw C:\Users\Jurek\.diggo-mainnet\helius-mainnet-rpc-url.txt).Trim()
```

For mainnet, the script first builds and simulates the transaction, itemizes rent and fees, then
refuses to submit unless `--allow-mainnet` is explicitly supplied. Review the simulation and cost
immediately before using that flag. A config keypair is generated in memory and is not written to
disk; only its public key is printed. The config has no post-creation authority in this flow.

## Historical mainnet preparation record

This section preserves the preparation state observed on 2026-09-25, before the approved config was
created. It is not the current configuration status.

- Payer: `GkCYyWzSjhSFEjKNx1ebWThtVLzQj7L84ktAHe31MBSx`
- Mining vault / leftover receiver: `H5TTpszeSNneNNxypM3UjaWMjVRNTvmWSCXfgXtzdELT`
- Fee claimer: `6HHEkX5MxsoQwyCJZHvLnewmnsaw19vGT9Y8jhqH7GuJ`
- Mainnet Helius endpoint file: `C:\Users\Jurek\.diggo-mainnet\helius-mainnet-rpc-url.txt`; `getHealth` returned `ok`
- Payer and vault balances at verification time: 0 lamports

The unsigned mainnet transaction has one DBC instruction, two required signatures, and no attached
priority fee. The exact verified cost is:

- New payer account rent exemption: 650,240 lamports
- Config account rent exemption (1,048 bytes): 5,974,080 lamports
- Transaction base fee: 10,000 lamports
- Priority fee: 0 lamports
- One-time config cost: 5,984,080 lamports (`0.005984080 SOL`)
- Exact first-funding minimum, including keeping the payer rent-exempt: 6,634,320 lamports (`0.006634320 SOL`)

Fund the payer with **0.010000000 SOL (10,000,000 lamports)**. That leaves 3,365,680 lamports of
headroom over the exact minimum for fee changes or a retry. Fund the mining vault with **0.1 SOL**.
Ordinary prepared mining claims are player-authorized, while the vault is an operational signer
for mining payouts and the one-time leftover withdrawal, including an ATA when needed. The funded
mainnet rehearsal must verify both paths, their actual authorizations, and their balance
requirements. Refill the vault before it can no longer cover those operations; do not treat it as a
SOL trading reserve.

The dedicated-payer dry-run correctly refused submission but returned `AccountNotFound` because the
new payer had no mainnet account yet. A separate no-send program simulation used a disposable,
already-funded fee payer so the DBC instruction could execute. It succeeded with no error and used
39,193 compute units; the dedicated payer and in-memory config keypair were not funded or signed.
After funding, run the same command without `--allow-mainnet` and require a successful simulation
before any signing. `--allow-mainnet` is intentionally absent from this runbook's commands.

## Fees and leftover tokens

Claim partner trading fees to the canonical platform fee wallet:

```powershell
npx tsx scripts/meteora/claim-partner-fees.ts `
  --cluster mainnet `
  --fee-claimer C:\Users\Jurek\.diggo-mainnet\platform-fee-wallet.json `
  --payer C:\Users\Jurek\.diggo-mainnet\payer.json `
  --pool <POOL_ADDRESS>
```

The keypair path must resolve to the canonical fee-claimer wallet and must remain outside the
repository. The script reads the pool's config and rejects any pool configured for another fee
claimer. The optional `--receiver` is also restricted to the canonical wallet. The transaction is
signed by the fee-claimer key and the payer, and the script prints the pool, config, receiver,
signature, and exact payer balance change.

The devnet config listed below was created before the canonical-wallet update and retains its
original immutable fee claimer. The current claim script intentionally rejects that legacy config;
do not represent a config change as a way to redirect already-accrued fees.

After graduation, the mining reserve can be withdrawn with the manual fallback:

```powershell
npx tsx scripts/meteora/withdraw-leftover.ts `
  --cluster devnet `
  --payer C:\Users\Jurek\.diggo-devnet\payer.json `
  --pool <POOL_ADDRESS>
```

This is permissionless with respect to the receiver, but the pool's configured payer must sign.
It should not be called before the DBC curve is complete.

## Devnet verification run

Run performed on 2026-09-24 against `https://api.devnet.solana.com`:

- Payer: `7rGM9as2yfxZcazQcFeTZzBqnHA1wFnU57WwZczL2WdZ`
- Mining vault: `6i6EuPmUrg8R6zehqQKFd2XoE5A3mYjZQhm9u6ocBo7d`
- DBC config: `5Dtu9MNLM1k4asZgYos2Dm7CU75zkY4QqQSMkt8GGRar`
- Config creation signature: `G1GSEoyd7G9frnF4PQ6vvLBZj5nq6Vh3LUMtpkohjV5k7jVHZzwSNav9tXNdCCbCxCEGtauzpLQHqdYSx7ivXuk`
- Config account rent: 5,974,080 lamports for 1,048 bytes
- Config creation payer cost: 5,984,080 lamports (`0.005984080 SOL`), including the 10,000-lamport signature fee
- Verified threshold: 2,000,000,000 lamports
- Verified migration fee: 1%, creator share 0%
- Verified on-chain pool creation fee field: 989,680 lamports; the submitted SDK configuration remains 0.01 SOL, and the program applies its fee split/accounting rules on-chain

The smoke test created and traded a disposable pool:

```powershell
npx tsx scripts/meteora/smoke-devnet.ts `
  --payer C:\Users\Jurek\.diggo-devnet\payer.json `
  --config 5Dtu9MNLM1k4asZgYos2Dm7CU75zkY4QqQSMkt8GGRar `
  --rpc-url https://api.devnet.solana.com `
  --buy-sol 0.02
```

Results:

- Base mint: `CQuR9Hi8N5AgebN4tUWUDWJyPwgBCXqzbr3ibCmrKBD8`
- Pool: `8zNuum1zEAbjWGWQ2KSwmAnZj3r654VvWkP7fX3N5VXT`
- Pool plus first buy: `3BCqBNCRoPNLU8d55TvoBGrAewnZ2htQ93CcfXhbxsduwGf2buG9f3tWBcR9h9aULcBKhF1e1CNSaRQq8171FKES`
- First buy input: 0.020000000 SOL
- First buy tokens: 11,488,270,613,539,735 base units
- Sold amount: 5,744,135,306,769,867 base units
- Sell signature: `3aH6K16pFKbkVrqripbLT4QQMh2yunhvg18dM7rAieesB4VexJLSfWE77W9vUJhjjMpXAheYFhwsujCzaUmubYnj`
- Sell fee: 5,000 lamports; the sell returned more wrapped SOL than the half-token input required, so the net payer balance increased by 9,456,965 lamports after fees
- Pool creation plus first buy net payer cost: 0.052080080 SOL

The smoke test therefore exercised config reuse, pool creation, first buy, token-account handling,
quote generation, and a sell back to the curve. The disposable mint and pool are not production
launch records.

## Mainnet config creation cost reference

The pinned SDK's config account is 1,048 bytes including the Anchor discriminator. Solana rent
exemption for that size is 5,974,080 lamports. With two required signatures (payer and config),
the estimated one-time cost is:

`5,974,080 + 10,000 = 5,984,080 lamports = 0.005984080 SOL`

This excludes the new payer account's own 650,240-lamport rent exemption, priority fees, and any
future protocol change to account size/rent. See **Historical mainnet preparation record** for the
first-funding calculation used during preparation.

## Purging devnet Meteora data

Before the mainnet cutover, back up D1 and test `scripts/meteora/purge-devnet-data.sql` against a
local copy. The script removes only the two known devnet pools, their mints, the devnet config scan
cursor, Meteora swaps/vault rows, game rows for those mints, and matching public token/price/trade
rows. It preserves wallet-wide players and referral records, clearing only an active devnet mine
selection.

```powershell
npm run db:local
npx wrangler d1 execute diggo-db --local --file=scripts/meteora/purge-devnet-data.sql
```

Do not run the file against production until the mainnet config and vault public keys have been
created and independently verified. Production application of the purge is a separate, explicit
operator step. The file deliberately has no `BEGIN`/`COMMIT` statements: D1 rejects explicit SQL
transactions when a file is executed with `wrangler d1 execute --file`.

## RPC endpoints and failover

The Worker uses an ordered RPC list. `DIGGO_RPC_URL` is the primary endpoint and
`DIGGO_RPC_URLS` is a comma- or whitespace-separated fallback list. Requests fail over only for
provider failures (HTTP 403/429/5xx, rate-limit responses, or transport/server errors); normal
Solana execution errors such as a missing account are returned without trying another provider.
The same transport is used for `getProgramAccounts`, `getSignaturesForAddress`,
`getTransaction`, `getAccountInfo`, blockhash/status reads, and `sendTransaction`.

Testing from this machine on 2026-09-24 with the exact DBC filter
`memcmp(offset=72, bytes=5Dtu9MNLM1k4asZgYos2Dm7CU75zkY4QqQSMkt8GGRar)`:

- `https://devnet.rpcpool.com`: worked; returned the expected smoke pool.
- `https://api.devnet.solana.com`: also worked during testing, but the reported 403 makes it
  unsuitable as the sole endpoint.
- `https://rpc.ankr.com/solana_devnet`: required an API key.
- `https://solana-devnet.drpc.org`: returned HTTP 400 for the filtered request.
- `https://solana-devnet.publicnode.com`: returned HTTP 404.
- `https://solana-devnet.gateway.tatum.io`: free tier accepts `getTransaction` and
  `getAccountInfo`, but requires an account for `getSignaturesForAddress` and
  `getProgramAccounts`; it is the final getAccountInfo-only fallback.

The current devnet default is `devnet.rpcpool.com`, with the official endpoint as fallback. For
mainnet, the owner should sign up for a keyed provider such as Helius and put the provider URL in
`DIGGO_RPC_URL` as a Wrangler secret; keep only provider endpoints appropriate for that cluster in
`DIGGO_RPC_URLS`. Do not put an API key in `wrangler.jsonc`.

The keyed provider is not optional for a deployed indexer. The anonymous endpoints above can be
rate-limited or blocked from Cloudflare egress, and the Worker does not treat a client-reported
pool or RPC response as authoritative without the on-chain config check.

Pool discovery does not depend on providers allowing `getProgramAccounts`. On every Meteora
launch, the client posts the derived pool address to `/api/meteora/pools/register`; the Worker
reads that account with `getAccountInfo`, requires the DBC pool discriminator and config field to
match `METEORA_DBC_CONFIG`, requires the on-chain creator to equal the authenticated wallet, and
only then inserts it. Independently, the five-minute cron scans signatures on the configured
PoolConfig account, extracts DBC `EvtInitialize` records, and verifies each candidate pool the same
way. This covers pools created outside the Diggo client as well as the smoke pool already on devnet.

The local Wrangler smoke harness cannot prove the anonymous path end to end from this machine:
`getAccountInfo` and `getSignaturesForAddress` succeed with direct HTTP requests, but the Worker
runtime received HTTP 429 for both the RpcPool/official/Tatum fallbacks. The scheduler still runs
and the API/D1 tests exercise the fallback logic, but a keyed RPC is required for a repeatable live
indexing smoke.

## Verification commands

From the repository root:

```powershell
npm run typecheck
npx tsc -p tsconfig.node.json --pretty false
npx vitest run --config C:\Users\Jurek\.diggo-devnet\vitest.config.mts `
  C:\Users\Jurek\Documents\Diggo_Fun_v2\scripts\meteora\common.test.ts
git diff --check
```

The repository's default Vitest configuration includes `src`, `shared`, and `worker` tests but
excludes `scripts`, so the external config above is intentional for the focused script tests.

## Remaining launch gates

1. Back up the mainnet keypairs offline and confirm the mining-vault custody policy.
2. Run a funded mainnet simulation immediately before any operational transaction; rent and
   priority fees can change with cluster state.
3. Complete a funded mainnet rehearsal of launch, mining, Discoveries, and Claim all, including both
   player-authorized claims and operations that require the mining vault. Pre-graduation rewards must
   remain pending, and post-graduation payouts must wait until vault inventory is available.
4. Complete the required security review before public mainnet access.
