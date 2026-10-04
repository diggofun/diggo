# Security model

## Trust boundary

The current deployment uses `CHAIN_MODE=meteora` on `mainnet-beta`. Cloudflare remains an index,
cache and coordination layer, while the relevant Meteora programs and signed wallet transactions
determine on-chain token balances. The native Diggo program controls described in
`ARCHITECTURE.md`, `ONCHAIN.md` and this document are preserved historical/future architecture, not
the current production path.

## Implemented web controls

- Wallet authentication uses a five-minute, single-use challenge and Ed25519 message verification.
- Sessions are random, expire after one hour, and live in KV.
- Daily mine activation uses its own five-minute, single-use signed challenge (separate nonce namespace from sign-in), so a captured activation request cannot be replayed for a second day's reward. Reactivation is additionally blocked server-side for 20h after the previous activation, independent of the rate limiters below.
- Rate limiting is multi-dimensional and all dimensions must pass: the risk gate checks wallet, session, IP, device and network together, so neither IP rotation nor wallet rotation alone buys budget while a household, dorm or CGNAT egress stays playable. Window widths differ per action (60s to 300s), counters live in KV, and a rate-limit hit is recorded as an account signal rather than only refused. Reward claims, discovery claims and their confirmations are additionally rate limited per wallet on top of the per-IP budget.
- Crew upgrades are ORE-only and applied with an optimistic-concurrency SQL guard (`UPDATE ... WHERE ore_balance >= ? AND level = ?`), so concurrent requests cannot double-spend the same ORE.
- Random memecoin Discoveries are server-authoritative: whether a discovery happens, which token, which rarity, which visual event and how many units all derive from `DISCOVERY_SECRET` in the Worker, never from a frontend value, and a discovery is gated by account maturity, discovery eligibility (age/active-days/crew-tier) and independent budget caps (per-account/day, per-account/week, per-token/day, per-token/period, global/day) before it is rolled or written.
- Discovery RNG is **commit-reveal** (`shared/commitReveal.ts`, `worker/discovery.ts`): each epoch publishes a commitment to a seed derived from `DISCOVERY_SECRET`, and the seed itself only once that epoch has ended. Outcomes therefore cannot be ground out after a commitment is known, and anyone can verify a revealed seed against the commitment they read earlier through the public `GET /api/discovery/commitments`. The epoch length is bounded to `[3600, 2592000]` seconds.
- A discovery cannot be valued from a manipulable price. `worker/oracle.ts` combines the token's own observed price history, a volume-weighted average of recorded trades, Jupiter and Pyth, and `getRobustPrice` returns `null` rather than a number when the sources disagree beyond the deviation gate or are stale — an unvaluable discovery pays nothing instead of paying a wrong amount. `ORACLE_MIN_EXTERNAL_SOURCES` can require corroboration by an external source; `ORACLE_SOL_USD_OVERRIDE` pins the SOL rate and is for local work only.
- Player state changes on the reward paths are serialised per wallet by a Durable Object lease (`worker/playerLock.ts`), so two concurrent activations or claims cannot interleave their read-modify-write. The lock is defence in depth and fails open, loudly: a broken binding must not stop players from playing, and every guarded update underneath it is still conditional in SQL.
- Per-player `risk_state` (`NORMAL`/`UNDER_REVIEW`/`HELD`/`BLOCKED`) and a `risk_events` log exist as the substrate for behavioral anti-Sybil scoring; exact thresholds are intentionally not exposed to clients.
- PostHog (EU cloud) is reached only through the Worker's first-party proxy at `/ph/*` (`worker/posthogProxy.ts`), which forwards an allowlist of request headers, never cookies, caps bodies, and drops upstream `Set-Cookie`. Analytics does not load or send anything until the player chooses "Allow analytics" in the consent banner; "Essential only" or a withdrawal opts the client out and stops replay immediately. Events are a closed, typed set (`src/analytics.ts`) whose properties pass an allowlist; session replay masks all inputs; person profiles are created only on identify, which uses the signed-in wallet's public key and is reset on disconnect. Private keys, signatures, transaction payloads and emails are never sent.
- Launches require server-side Turnstile verification; the secret is never exposed to the browser.
- Helius delivery uses timing-safe authorization-header comparison, and the Telegram notification webhook fails closed unless `TELEGRAM_WEBHOOK_SECRET` is set and matches.
- Web push subscriptions are scoped to the signed-in wallet: the VAPID public key is readable before sign-in (a browser needs it to subscribe), but registering or deleting a subscription only ever touches devices belonging to that session's wallet. Payloads are encrypted per RFC 8291 and the Worker stores no private key material for a device.
- D1 input is handled with bound prepared statements.
- Queue inserts use transaction signatures for idempotency.
- Coin artwork is stored in Cloudflare KV and served through the Worker at `/media/<key>`. Uploads require a wallet session, accept PNG, JPEG, WebP and GIF based on their file signatures, reject SVG and cap payloads at 2 MB. Sessions and challenges are also stored in KV; application and profile data live in D1.
- Static assets set CSP, anti-framing, MIME-sniffing, referrer and permission headers.
- Worker logs use request IDs and do not echo internal errors to clients. Alerting and error reporting are optional and off by default: fired alerts go to the structured log and D1 counters, and to `ALERT_WEBHOOK_URL` when set; unhandled errors are reported as a plain Sentry envelope over fetch when `SENTRY_DSN` is set. Neither path can block or fail a player request.
- A settled reward is recorded only after the Worker fetches the player's own `claim_rewards` transaction and verifies it is that reward's payout (`POST /api/rewards/claim/confirm`). A signature already backing another reward is refused, and `worker/reconcile.ts` compares paid claims against chain so a mismatch halts the affected mine's mint rather than paying twice.
- Mutating admin calls require a signed, single-use **step-up** bound to the action and its exact payload, so an admin session alone can never place a restriction, flip a breaker or decide an appeal. Admin routes 401 for any wallet not listed in `ADMIN_WALLETS`, and every action is audited.
- Risk enforcement ships in **shadow** mode (`RISK_OPS.enforcement.mode`): a score-derived refusal is recorded — `risk.shadow_would_block`, and the `shadowed`/`computedState` pair on each admin account row — while the account keeps playing, so a score cannot stop a real player before an operator has reviewed what it would have done. Rate limits, circuit breakers and operator restrictions are enforced in either mode, and `enforcement.overrides` can move a single action in or out of enforcement.
- A player can appeal a hold or restriction (`POST /api/appeals`), and only a person can decide one (`POST /api/admin/appeals`, step-up required). Filing an appeal changes nothing by itself, deciding one can only lift restrictions, and the endpoint answers identically whether or not the account is under anything, so it cannot be used to probe the risk layer.

## Native-program invariants preserved for reference

These invariants describe the native-program design. They must not be presented as verified
properties of the current Meteora deployment:

1. distributed rewards never exceed the program-controlled mining reserve;
2. mint and freeze authorities are permanently revoked after creation;
3. creator and platform cannot withdraw either reserve or protocol-controlled LP;
4. changing mines settles the old cumulative reward index first;
5. active power cannot be assigned twice;
6. real tokens or SOL can never mint or otherwise create Mining Power — power only ever enters through the keeper-gated `sync_crew_power` instruction, itself bounded by the guardian-configured `ProtocolConfig.max_crew_power` (hard-capped on-chain by `MAX_CREW_POWER_HARD_CAP`) and by the per-call `max_power_increase_bps` bound;
7. a compromised keeper key can only move Crew Power and Discovery Reserve payouts, never the launch market, the treasury, or a player's claimable mining rewards — the Mining Reserve leaves only through the user-signed `claim_rewards` instruction, which no keeper key can sign for;
8. Discovery Reserve payouts (`claim_discovery`) can only reduce `remaining_discovery_reserve`, never exceed it, and only the keeper can trigger one;
9. unsafe or thin price sources cannot value a Discovery. Partly enforced today: the Worker's own oracle refuses to answer when its sources disagree or are stale, and a discovery that cannot be valued pays nothing — but the program does not yet re-check a price it is handed (see `docs/ARCHITECTURE.md` §13);
10. fee routes match immutable or tightly governed configuration.

## Current readiness and limitations

The repository is configured for Meteora on `mainnet-beta` with the approved production DBC config
`5yxCKEmi1rc5ebKmWdHbzj2pEe7caqS8xqvQh5V8duMF`, fee claimer
`6HHEkX5MxsoQwyCJZHvLnewmnsaw19vGT9Y8jhqH7GuJ`, and mining vault
`H5TTpszeSNneNNxypM3UjaWMjVRNTvmWSCXfgXtzdELT`. Public mainnet launch remains blocked until
production RPC/D1/funding are confirmed, a real launch through Claim all final settlement is
rehearsed, and the required security review is complete.

The native rent-reclaim action is unavailable in Meteora mode. No Meteora equivalent is exposed by
the current product. This is a product limitation, not a claim that third-party Solana tools cannot
close user-owned accounts.

The earlier native keeper, price-oracle, pool-custody and account-migration gaps remain recorded in
the architecture documents for future or historical context. They are not evidence that the
current Meteora integration has received an audit, and this document does not make a legal or
security assurance about it.
