# Custody policy

Diggo is non-custodial. The website and Cloudflare Worker never accept, pool, sign for, or retain a user's SOL, tokens, private keys, seed phrase, or wallet authority.

## Where funds live

- User assets remain in each user's own Solana wallet.
- The only assets permitted to leave a user wallet are those explicitly sent in a user-signed on-chain transaction to a program-controlled liquidity pool or mining-reserve account.
- The liquidity pool and mining reserve must be controlled by audited Solana programs, never by a creator, Worker, platform wallet, or operator key.

## Web application scope

The Worker creates launch requests, validates signed wallet login messages, and indexes public chain events. It cannot construct custody transfers or access wallet signing authority. Wallet signatures are used only for authentication unless the wallet explicitly presents a transaction for signing.

## The keeper key

The on-chain program recognizes one additional backend authority, the protocol `keeper`, used only to push two things: a player's off-chain Crew-derived Mining Power (`sync_crew_power`) and a server-approved random discovery payout from a token's program-controlled Discovery Reserve (`claim_discovery`). The keeper key can never move launch-market funds, the treasury, or a player's claimable mining rewards, and it never touches SOL or tokens sitting in a user's own wallet. It exists because Mining Power and discoveries are gameplay outcomes computed off-chain (see `docs/ARCHITECTURE.md`), not because the Worker is trusted with custody. Keeper key material must be held outside the Worker's request path (a dedicated signer service) before mainnet.

This policy is a product requirement. Mainnet launch remains blocked until the Solana programs enforce these controls and receive an independent security audit.
