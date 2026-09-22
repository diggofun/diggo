# Security model

## Trust boundary

Cloudflare is an index, cache and coordination layer. It must never be authoritative for balances, rewards, burns, liquidity custody, upgrade power or creator fee ownership. The Solana programs are the source of truth.

## Implemented web controls

- Wallet authentication uses a five-minute, single-use challenge and Ed25519 message verification.
- Sessions are random, expire after one hour, and live in KV.
- Daily mine activation uses its own five-minute, single-use signed challenge (separate nonce namespace from sign-in), so a captured activation request cannot be replayed for a second day's reward. Reactivation is additionally blocked server-side for 20h after the previous activation, independent of the rate limiters below.
- Two independent rate-limit dimensions apply to activation and crew-upgrade endpoints: per-IP (`checkRateLimit`) and per-wallet (`checkWalletRateLimit`) — an attacker must defeat both, not just rotate one.
- Crew upgrades are ORE-only and applied with an optimistic-concurrency SQL guard (`UPDATE ... WHERE ore_balance >= ? AND level = ?`), so concurrent requests cannot double-spend the same ORE.
- Random memecoin Discoveries are server-authoritative: RNG uses `crypto.getRandomValues` in the Worker, never a frontend value, and a discovery is gated by account maturity, discovery eligibility (age/active-days/crew-tier), and four independent budget caps (per-account/day, per-account/week, per-token/day, global/day) before it is rolled or written.
- Per-player `risk_state` (`NORMAL`/`UNDER_REVIEW`/`HELD`/`BLOCKED`) and a `risk_events` log exist as the substrate for behavioral anti-Sybil scoring; exact thresholds are intentionally not exposed to clients.
- PostHog uses aggregate product events only. Session replay, autocapture, wallet-address identification, and wallet-signature collection are disabled.
- Launches require server-side Turnstile verification; the secret is never exposed to the browser.
- Helius delivery uses timing-safe authorization-header comparison.
- D1 input is handled with bound prepared statements.
- Queue inserts use transaction signatures for idempotency.
- Supabase Storage is private; Worker-mediated uploads accept PNG, JPEG, and WebP only and cap payloads at 2 MB.
- Static assets set CSP, anti-framing, MIME-sniffing, referrer and permission headers.
- Worker logs use request IDs and do not echo internal errors to clients.

## Required on-chain invariants

The web UI displays these claims, but they must be enforced by audited Solana programs before mainnet:

1. distributed rewards never exceed the program-controlled mining reserve;
2. mint and freeze authorities are permanently revoked after creation;
3. creator and platform cannot withdraw either reserve or protocol-controlled LP;
4. changing mines settles the old cumulative reward index first;
5. active power cannot be assigned twice;
6. real tokens or SOL can never mint or otherwise create Mining Power — power only ever enters through the keeper-gated `sync_crew_power` instruction, itself bounded by the guardian-configured `ProtocolConfig.max_crew_power` (hard-capped on-chain by `MAX_CREW_POWER_HARD_CAP`) and by the per-call `max_power_increase_bps` bound;
7. a compromised keeper key can only move Crew Power and Discovery Reserve payouts, never the launch market, the treasury, or a player's claimable mining rewards — the Mining Reserve leaves only through the user-signed `claim_rewards` instruction, which no keeper key can sign for;
8. Discovery Reserve payouts (`claim_discovery`) can only reduce `remaining_discovery_reserve`, never exceed it, and only the keeper can trigger one;
9. unsafe or thin price sources cannot value a Discovery (enforced today by a minimum market-cap filter on the discovery target — see `docs/ARCHITECTURE.md` §6);
10. fee routes match immutable or tightly governed configuration.

## Not yet mainnet-ready

The repository does not contain an AMM integration, a manipulation-resistant oracle policy, an audited keeper signer service, or the vanity-mint worker pool. The Worker computes Crew Power and Discovery eligibility/RNG but does not yet hold keeper key material or submit `sync_crew_power`/`claim_discovery` transactions — see `docs/ARCHITECTURE.md` §9 for the full list of known gaps. The website therefore labels itself as a devnet MVP.
