# Security model

## Trust boundary

Cloudflare is an index, cache and coordination layer. It must never be authoritative for balances, rewards, burns, liquidity custody, upgrade power or creator fee ownership. The Solana programs are the source of truth.

## Implemented web controls

- Wallet authentication uses a five-minute, single-use challenge and Ed25519 message verification.
- Sessions are random, expire after one hour, and live in KV.
- Launches require server-side Turnstile verification; the secret is never exposed to the browser.
- Helius delivery uses timing-safe authorization-header comparison.
- D1 input is handled with bound prepared statements.
- Queue inserts use transaction signatures for idempotency.
- R2 uploads accept images only and cap payloads at 2 MB.
- Static assets set CSP, anti-framing, MIME-sniffing, referrer and permission headers.
- Worker logs use request IDs and do not echo internal errors to clients.

## Required on-chain invariants

The web UI displays these claims, but they must be enforced by audited Solana programs before mainnet:

1. distributed rewards never exceed the program-controlled reserve;
2. mint and freeze authorities are permanently revoked after creation;
3. creator and platform cannot withdraw reserve or protocol-controlled LP;
4. changing mines settles the old cumulative reward index first;
5. active power cannot be assigned twice;
6. upgrades cannot mint supply and always follow the published 70/20/10 route;
7. unsafe or thin price sources cannot value upgrades;
8. fee routes match immutable or tightly governed configuration.

## Not yet mainnet-ready

The repository does not contain the six Solana programs, an AMM integration, a manipulation-resistant oracle policy, an audited keeper, or the vanity-mint worker pool. The website therefore labels itself as a devnet MVP.
