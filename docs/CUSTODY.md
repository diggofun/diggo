# Custody policy

Diggo is designed so users keep authority over their own Solana wallet. The website and Worker do
not accept wallet private keys or seed phrases and do not present a login signature as authority to
transfer a user's assets.

## Current Meteora path

The production configuration selects `CHAIN_MODE=meteora`. A creator builds and signs Meteora
launch, swap and pool transactions with the relevant wallet. A player signs the wallet-approved
Claim all payout transaction. The Worker prepares and indexes the supported flow and records a
settlement only after the transaction can be verified.

The mining vault is an operational account used by the Worker path for prepared Meteora payouts
and sweeps. Its key is a deployment secret (`MINING_VAULT_SECRET`), not a user-wallet key. Its
custody, balance and funded mainnet rehearsal must be verified before public launch.

## User assets

- Users remain responsible for their wallet, private keys, seed phrases and transaction approvals.
- ORE and Mining Power remain internal game state; they are not withdrawable assets.
- Claimed memecoins are sent according to the signed payout transaction. Their market value is not
  guaranteed.
- A launch, reward, referral or community action never requires the user to disclose a private key
  or seed phrase.

## Native-program scope

Earlier architecture documents describe a native program with program-derived reserves, keeper
instructions and player-signed claim instructions. That program is not the active production path
under `CHAIN_MODE=meteora`. Its custody properties must not be inferred for Meteora pools, fees or
the mining vault.

## Readiness requirement

Mainnet public launch is gated on a verified Meteora config, funded and rehearsed payout path,
production RPC and migrations, and completion of the required security review. The native
rent-reclaim action is unavailable in Meteora mode.
