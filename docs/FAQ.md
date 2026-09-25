# Diggo.fun FAQ

## What is Diggo?

Diggo is a Solana memecoin launchpad combined with a mining game. Creators use the launchpad to
launch projects and tokens. Players activate a mining crew, complete random mining, review the
memecoins that accrue in Discoveries, and claim eligible rewards through their own wallet.

## How does a player use the mining game?

1. Connect a wallet and sign in.
2. Activate a 24-hour mining window.
3. Complete a random mining interaction.
4. Return to Discoveries to see accrued memecoins.
5. Use Claim all when eligible rewards are available, approve the wallet transaction, and verify
   the result.
6. Return for the next window or refer relevant people to the product.

An active crew can keep working while the browser is closed. Pausing or letting an activation
window end stops new accrual; rewards already recorded are not removed by the pause action.

## What does Claim all do?

Claim all prepares one wallet-approved batch payout for up to 12 distinct accrued coins. The
player reviews and signs the transaction. Diggo records the batch as settled only after the
transaction can be verified. If more than 12 coins are available, another Claim all transaction
is needed for the remainder.

Pre-graduation mining rewards can accrue but remain pending. They become claimable only after the
relevant Meteora pool has graduated and mining inventory is available to the configured vault. A
visible accrual is not a promise that a reward is already claimable.

## What are ORE and Mining Power?

ORE and Mining Power are internal game progression. ORE is earned by keeping a crew active and
spent on crew components. Neither ORE nor Mining Power is an SPL token, is transferable, has a
market, can be withdrawn, or can be purchased with SOL or memecoins.

## Are mined memecoins valuable?

They are real SPL tokens, but their price can rise, fall or become illiquid. Mining rewards are
subject to product rules, caps, pool graduation and successful transaction settlement. Nothing in
the documentation promises a return or a token price.

## What does Diggo do for creators?

Creators launch projects and memecoins through the Meteora Dynamic Bonding Curve path. A launch
uses the configured token, metadata, pool and fee settings, and trading continues through the
Meteora venue. The launch configuration, fee destinations, liquidity allocation and migration
settings must be independently checked before a mainnet config is signed.

## Is mainnet public launch ready?

Not yet. The repository is configured for mainnet-beta with Meteora and the approved production DBC
config is `5yxCKEmi1rc5ebKmWdHbzj2pEe7caqS8xqvQh5V8duMF`. Public launch also depends on production
RPC, migrations and funding, an end-to-end real payout rehearsal, and completion of the required
security review.

Prelaunch education and demonstrations can happen before public access is opened. They must not
be described as proof of mainnet readiness.

## Can players reclaim account rent?

The native-program rent-reclaim action is unavailable in Meteora mode. Diggo does not present a
Meteora rent-reclaim transaction as available. Wallets or third-party Solana tools may have their
own account-closing behavior, but that is separate from the current Diggo product flow.

## Where are the detailed operational facts?

- [Deployment readiness](DEPLOYMENT.md)
- [Security model and limitations](SECURITY.md)
- [Custody policy](CUSTODY.md)
- [Meteora operations](METEORA_OPS.md)
- [Architecture and current/historical scope](ARCHITECTURE.md)
