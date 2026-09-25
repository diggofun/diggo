# Diggo.fun temporary Meteora DBC bridge

Research snapshot: 2026-09-24. Official references: [DBC docs](https://docs.meteora.ag/core-products/dbc/), [SDK](https://github.com/MeteoraAg/dynamic-bonding-curve-sdk), [npm](https://www.npmjs.com/package/@meteora-ag/dynamic-bonding-curve-sdk).

This is a research and implementation reference, not a public readiness statement. Production is
configured for Meteora on `mainnet-beta` with the approved DBC config
`5yxCKEmi1rc5ebKmWdHbzj2pEe7caqS8xqvQh5V8duMF`. Its fee claimer is
`6HHEkX5MxsoQwyCJZHvLnewmnsaw19vGT9Y8jhqH7GuJ`, and its mining vault / leftover receiver is
`H5TTpszeSNneNNxypM3UjaWMjVRNTvmWSCXfgXtzdELT`. Public launch remains gated on production
RPC/migrations/funding, a funded end-to-end payout rehearsal, and the required security review.
Native-program rent reclaim is unavailable in Meteora mode.

## 1. Programs and devnet
- DBC: `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`; DAMM v2 (`cp_amm`): `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`. The same IDs are used on mainnet and devnet ([DBC addresses](https://docs.meteora.ag/developer-guides/dbc/), [DAMM v2 addresses](https://docs.meteora.ag/developer-guides/damm-v2/)).
- Yes, DBC and its DAMM v2 migration path are usable on devnet. Use low-value test mints; devnet SOL has no monetary value and the test token/mint lifecycle still has to be exercised ([SDK devnet support](https://github.com/MeteoraAg/dynamic-bonding-curve-sdk)).

## 2. Config, pool creation, and fees
- Partner creates the config once. Its `payer` pays account rent and transaction costs; each pool creation has a configurable `poolCreationFee` (allowed non-zero range: 0.001–100 SOL), plus variable rent and tx costs. `poolCreator` is recorded separately and can be the creator wallet; in the recommended flow the creator is the pool payer ([launch configurations](https://docs.meteora.ag/core-products/dbc/launch-configurations/)).
- At a recommended `poolCreationFee = 0.01 SOL`, protocol fee is 10% and partner fee is 90%: Diggo receives 0.009 SOL and Meteora 0.001 SOL, before rent/transaction costs. The fee is claimable after pool creation; it is not a Meteora-mandated 0.01 SOL price ([fees overview](https://docs.meteora.ag/core-products/dbc/fees/overview/)).
- Trading fees: protocol receives 20% of the total. An optional referral receives 20% of the protocol portion (not an extra fee). The remaining 80% is split by `creatorTradingFeePercentage`; with creator percentage 0, the partner receives all 80%. The minimum base fee is 25 bps (0.25%); total fee is capped at 99% ([fees overview](https://docs.meteora.ag/core-products/dbc/fees/overview/), [formulas](https://docs.meteora.ag/core-products/dbc/formulas/)).
- Set creator trading fee to 0% for this temporary launch so Diggo captures the partner share. Use quote-token fee collection where supported by the selected configuration.
- Dynamic fees add a volatility layer above the base fee, still capped at 99%; the SDK helper convention targets a maximum dynamic fee up to 20% of the base fee ([dynamic fees](https://docs.meteora.ag/core-products/dbc/fees/dynamic-fees/)).
- Anti-sniper scheduler: use a linear (or exponential) schedule from activation; a fixed schedule uses zero scheduler fields. Do not use deprecated `RateLimiter` in new configs ([fee scheduler](https://docs.meteora.ag/core-products/dbc/fees/fee-scheduler/), [rate limiter](https://docs.meteora.ag/core-products/dbc/fees/rate-limiter/)).

## 3. Mining reserve: use fixed-supply `leftover`
- Recommended: `totalTokenSupply = 1_000_000_000`, `leftover = 200_000_000`, `leftoverReceiver = miningVault` (a Diggo-controlled wallet), and no base-token `lockedVesting`. This excludes exactly 20% from curve accounting; it is not an uncertain post-curve remainder ([surplus and leftover](https://docs.meteora.ag/core-products/dbc/surplus-and-leftover/), [launch configurations](https://docs.meteora.ag/core-products/dbc/launch-configurations/)).
- The reserve is not claimable before graduation. Once migration reaches DAMM v2 `CreatedPool`, anyone may permissionlessly call `withdrawLeftover`; only the configured `payer` must sign. Tokens go to `leftoverReceiver`, so Diggo can be the receiver without being the pool creator ([SDK migration service](https://github.com/MeteoraAg/dynamic-bonding-curve-sdk/blob/main/packages/dynamic-bonding-curve/src/services/migration.ts)).
- `lockedVesting` is the alternative when Diggo wants scheduled vesting of base tokens after migration. Partner and creator vesting allocations are configurable, so partner-controlled vesting is possible; it is unnecessary for an immediately claimable mining vault. `partnerLiquidityPercentage` instead allocates post-migration LP/position NFTs, not standalone mining tokens ([migration and liquidity](https://docs.meteora.ag/core-products/dbc/migration-and-liquidity/)).

## 4. Graduation and post-graduation
- Graduation occurs when the DBC quote reserve reaches `migrationQuoteThreshold`; at completion trading stops and migration to DAMM v2 is eligible. New configs must select `MET_DAMM_V2`; DAMM v1 is deprecated ([migration and liquidity](https://docs.meteora.ag/core-products/dbc/migration-and-liquidity/)).
- Migration creates DAMM v2 position NFTs and distributes liquidity by partner/creator percentages. At least 10% must be locked at day one; vesting can be disabled or run up to two years ([migration and liquidity](https://docs.meteora.ag/core-products/dbc/migration-and-liquidity/)).
- A configurable migration fee is taken from the threshold and split by the configured creator percentage. Presets exist at 25/30/100/200/400/600 bps; `Customizable` allows up to 99% and up to 100% creator share. Separately, a fixed 0.2% protocol liquidity-migration fee reduces liquidity deposited into DAMM ([migration and liquidity](https://docs.meteora.ag/core-products/dbc/migration-and-liquidity/)).
- After migration, DBC trading fees stop accruing. DAMM v2 LP/trading fees belong to the partner/creator LP position holders and are claimed under the DAMM v2 configuration; partner/creator migration-fee withdrawals become available after curve completion ([migration and liquidity](https://docs.meteora.ag/core-products/dbc/migration-and-liquidity/)).
- The approved mainnet configuration uses a threshold of **85 SOL**, a **1%** migration fee, a **25%** `percentageSupplyOnMigration` curve split, and a **1%** post-migration DAMM pool fee. The pinned SDK used by the scripts cannot represent the researched 0.5% migration fee. These are Diggo configuration values, not Meteora constants; the mainnet readiness gates still apply.

## 5. SDK 1.5.13 integration shape
- Create config: build nested `BuildCurveBaseParams` (`token`, `fee`, `migration`, `liquidityDistribution`, `lockedVesting`, `activationType`), then use `buildCurveWithMarketCap` or `buildCurve`. Call `client.partner.createConfig({...params, config, feeClaimer, leftoverReceiver: miningVault, quoteMint, payer})` ([TypeScript reference](https://docs.meteora.ag/developer-guides/dbc/typescript-sdk/reference)).
- Create pool plus optional first buy: `client.creator.createPoolWithFirstBuy({createPoolParam: {baseMint, config, name, symbol, uri, payer: creator.publicKey, poolCreator: creator.publicKey}, firstBuyParam: {buyer, receiver, buyAmount, minimumAmountOut, referralTokenAccount: null}})`. The SDK builds the transaction client-side; the creator reviews and signs locally. Never send a private key to a server ([SDK creator API](https://github.com/MeteoraAg/dynamic-bonding-curve-sdk)).
- Quote/swap: `client.pool.swapQuote2(...)` (ExactIn, PartialFill, ExactOut), then `client.pool.swap2(...)` for the creator- or user-signed trade. Read config/pool with `client.state.getPoolConfig(...)` and `client.state.getVirtualPool(...)` ([TypeScript reference](https://docs.meteora.ag/developer-guides/dbc/typescript-sdk/reference)).
- Index DBC event CPI data, not transfer logs: `EvtCreateConfigV2`, `EvtInitializePool`, `EvtSwap2` (amounts, reserves, next sqrt price, fees, threshold), and `EvtCurveComplete`. After completion, reconcile the DBC account and DAMM v2 pool/position NFTs; transaction logs should include DBC and `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` ([program events](https://docs.meteora.ag/developer-guides/dbc/program/events/)).
- Claim partner DBC trading fees: `client.partner.claimPartnerTradingFeeToReceiver({feeClaimer, payer, pool, maxBaseAmount, maxQuoteAmount, receiver: diggoTreasury})`; use the exact method names from the pinned SDK release ([npm package](https://www.npmjs.com/package/@meteora-ag/dynamic-bonding-curve-sdk)).

## 6. Token and metadata recommendation
- DBC supports SPL Token and Token-2022 ([Token-2022 support](https://docs.meteora.ag/core-products/dbc/token-2022-support/)). Use plain **SPL Token, 9 decimals** for the temporary launch: broadest wallet/router compatibility and the smallest integration surface. Token-2022 adds metadata-pointer and token-metadata initialization paths.
- Let DBC create/initialize the mint where possible; the standard launch path mints supply and revokes mint authority. A vanity mint keypair is optional marketing polish, not a DBC requirement; if the creator pre-creates a mint, manage the mint authority deliberately.
- Name, symbol, and URI are supplied at pool creation; use immutable metadata URI if the launchpad controls the metadata document.

## Concrete Diggo baseline: approved mainnet configuration
- 1,000,000,000 SPL; 9 decimals; `leftover = 200,000,000` to the mining vault; `lockedVesting` base allocation 0; quote mint wrapped SOL; `MET_DAMM_V2`.
- Mainnet threshold 85 SOL and devnet threshold 2 SOL; pool creation fee 0.01 SOL; creator trading fee 0%; protocol 20%, partner 80% of the non-protocol share; anti-sniper linear 3%→1% over 60 minutes; dynamic fee enabled. The approved migration fee is 1% because the pinned SDK cannot represent the researched 0.5% value; DAMM v2 pool fee is 1%.
- Post-migration ownership: `partnerLiquidityPercentage = 90`, `partnerPermanentLockedLiquidityPercentage = 10`, creator liquidity 0, vesting disabled.
- Rent, transaction fees, curve checkpoints, mining/Discoveries/Claim all payouts, and DAMM outcomes must be simulated with the pinned SDK and funded wallets. The 0.01 SOL creation fee/split, 85 SOL threshold, fee schedule, 25% curve split, and liquidity allocation are the approved Diggo configuration values.
