# The `diggo` mint suffix

Solana mint addresses are Ed25519 public keys encoded in base58. A required suffix cannot be appended to an existing address; the launch system must search keypairs until a public key naturally ends in `diggo`.

Five case-sensitive base58 characters imply a large and variable search space. That work is unsuitable for a latency-bound Cloudflare Worker request. Diggo therefore uses a two-stage launch:

1. the Worker validates wallet ownership, Turnstile and metadata, then writes a `QUEUED` launch job with `vanity_suffix = 'diggo'`;
2. an isolated grinder service generates a keypair, verifies the suffix, protects the private key, and submits the token-factory initialization transaction;
3. the indexer accepts the launch only if the resulting mint ends in `diggo` and on-chain authorities/reserve allocations match policy;
4. after confirmation, the key material used to initialize the mint is destroyed according to the token-factory ceremony.

Do not send vanity private keys through Queues, D1, KV, logs or browser APIs. Use a dedicated signer boundary and document its destruction procedure before mainnet.
