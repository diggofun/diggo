# Golden vectors: Rust generates, TypeScript asserts

Design 8.4 makes the chain authoritative. Every file here is produced by the program crate and is
never hand-edited; where TypeScript and a vector disagree, the vector wins and the TypeScript is the
bug, because the chain is what pays.

## Regenerating

```bash
# in the WS-G WSL build dir, after rsyncing programs/ from the worktree
DIGGO_WRITE_VECTORS=1 cargo test -p diggo-protocol --test vectors
```

Without the environment variable the same test **verifies** what is committed, so a stale vector
fails in Rust as well as in TypeScript. Each family is written twice: the JSON here for people and
tooling, and a generated TypeScript module under `shared/parity/` for the harness, because
`shared/**` is type-checked by the worker project, which carries no `@types/node` and therefore
has no filesystem types.

## What is here

| File | Source of truth | Consumed by |
| --- | --- | --- |
| `contract.json` | the program crate: account sizes and rent, the 48 v2 error codes in order, all 37 instruction discriminators, the 19 economic constants, and the address every PDA seed list derives to for one fixed input | `shared/parity/parity.test.ts` (sizes against `shared/program.ts`'s `ACCOUNT_SIZE`, discriminators against `instructionDiscriminator`, addresses against `shared/pdas.ts`) |
| `epoch_seed.json` | the frozen derivation `sha256(epoch_seed \|\| owner \|\| window_index as u16 LE)` | `shared/parity/parity.test.ts`, re-derived with Web Crypto |
| `tranche.json` | the starter-tranche amendment of CONTRACTS.md, as integer arithmetic | `scripts/parity/parity.test.ts`, against `scripts/sim/v2rules.ts` |

## Still owed, by the workstream that owns the implementation

These belong here for the same reason: the chain generates, the client asserts.

| File | Owner | What must match bit for bit |
| --- | --- | --- |
| `curve.json` | WS-B | `quote_buy` and `quote_sell` including rounding direction and the fee order of operations |
| `index.json` | WS-C | the cumulative index update and the position delta, both tranches |
| `rarity.json` | WS-C | tier selection from the derived roll, the amount clamp, the eligibility score |
| `discovery.json` | WS-C | eligibility and all four caps in lamports, and the budget charged at roll creation |
| `epochSeed.json` | WS-C | the expansion of the digest into occur, rarity and amount, byte for byte |

WS-A's crew, ORE and streak vectors are already emitted, at `shared/parity/player.json`, and are
consumed by `scripts/parity/parity.test.ts`.
