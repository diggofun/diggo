# Custody policy

Diggo is non-custodial. The website and Cloudflare Worker never accept, pool, sign for, or retain a user's SOL, tokens, private keys, seed phrase, or wallet authority.

## Where funds live

- User assets remain in each user's own Solana wallet.
- The only assets permitted to leave a user wallet are those explicitly sent in a user-signed on-chain transaction to a program-controlled liquidity pool or mining-reserve account.
- The liquidity pool and mining reserve must be controlled by audited Solana programs, never by a creator, Worker, platform wallet, or operator key.

## Web application scope

The Worker creates launch requests, validates signed wallet login messages, and indexes public chain events. It cannot construct custody transfers or access wallet signing authority. Wallet signatures are used only for authentication unless the wallet explicitly presents a transaction for signing.

This policy is a product requirement. Mainnet launch remains blocked until the Solana programs enforce these controls and receive an independent security audit.
