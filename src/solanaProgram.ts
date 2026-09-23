/**
 * The one path a component imports to talk to the chain.
 *
 * Every write reachable from here is signed by the connected wallet and submitted through the
 * Worker's RPC proxy, so no RPC provider API key is ever embedded in the browser bundle and no
 * backend key exists on any payout path. That is the whole of v2's claim on the frontend: a
 * player's balance, power, crew and discoveries are decided by instructions they send
 * themselves, and this module only builds and signs them.
 *
 * Read-only state that is not value-bearing (usernames, achievements, cosmetics, notifications,
 * leaderboards) stays in the Worker and D1 — see src/api.ts. The reads here are the ones the
 * chain is the authority for, and they are also the fallback when the indexer is behind.
 *
 * The implementation lives in src/onchain/*; instruction building, PDA derivation and account
 * decoding come from shared/program.ts and shared/pdas.ts (WS-D), which are the single client
 * transcription of the frozen contract in programs/diggo-protocol/CONTRACTS.md.
 */

export * from "./onchain";

/** Re-exported so a form can turn a typed string into an Address without a second import. */
export { address, type Address, type Instruction } from "@solana/kit";

/**
 * The program-side constants a form needs to render its own limits and defaults. They are
 * re-exported from shared/program.ts rather than restated, so a form and the chain can only
 * disagree if the frozen contract itself moved.
 *
 * There is no bond or starter-mode constant in this list. Playing costs no deposit, so there is no
 * amount, no cooldown and no efficiency factor for a form to quote. The bond *codecs* below survive
 * for one reason: a wallet that posted a bond before the change still has to be able to read its
 * own account and take the lamports back.
 */
export {
  ACCOUNT_RENT_LAMPORTS,
  ACCOUNT_SIZE,
  ACTIVATION_GRACE_SECONDS,
  ACTIVATION_SECONDS,
  CREW_COMPONENT,
  CRANK_TIP_BPS,
  DEFAULT_CREATOR_FEE_BPS,
  DEFAULT_CURVE_MINING_BPS,
  DEFAULT_CURVE_MINING_RUNWAY_DAYS,
  DEFAULT_DISCOVERY_DAILY_CAP_LAMPORTS,
  DEFAULT_DISCOVERY_EPOCH_BUDGET_BPS,
  DEFAULT_DISCOVERY_EPOCH_BUDGET_LAMPORTS,
  DEFAULT_DISCOVERY_GLOBAL_DAILY_CAP_LAMPORTS,
  DEFAULT_DISCOVERY_MAX_BPS,
  DEFAULT_DISCOVERY_WEEKLY_CAP_LAMPORTS,
  DEFAULT_PLATFORM_FEE_BPS,
  DEFAULT_SPONSOR_PER_WALLET_LIMIT_LAMPORTS,
  DISCOVERY_DAY_SECONDS,
  DISCOVERY_WEEK_SECONDS,
  LAUNCH_RENT_LAMPORTS,
  MATURITY_RAMP,
  MAX_CREW_LEVEL,
  MAX_CURVE_MINING_BPS,
  MAX_CURVE_MINING_RUNWAY_DAYS,
  MAX_NAME_LEN,
  MAX_PAUSE_SECONDS,
  MAX_RARITY_TIERS,
  MAX_SYMBOL_LEN,
  MAX_TRADING_FEE_BPS,
  MAX_URI_LEN,
  MIN_CURVE_MINING_BLOCKS,
  MIN_REACTIVATION_SECONDS,
  OPPORTUNITY_EXPIRY_SECONDS,
  SPONSOR_EVENT_KIND,
  bondSourceName,
  coinStatusName,
  describeDiggoError,
  diggoErrorName,
  isDiggoV2ErrorCode,
  opportunityStatusName,
  sponsorEventKindName,
  trancheName,
  type DecodedCoin,
  type DecodedDiscoveryOpportunity,
  type DecodedGlobalBudget,
  type DecodedLiquidityPool,
  type DecodedMiningPosition,
  type DecodedPlayerAccount,
  type DecodedProtocolConfig,
  type DecodedSponsorEvent,
  type DecodedSponsorGrant,
  type DecodedSponsorVault,
  type DiggoErrorName,
  type LaunchTokenArgs,
  type PlayerCrewLevels,
  type ProtocolConfigArgs,
  type RarityTier,
  type SponsorEventKindName,
} from "../shared/program";

export {
  deriveAssociatedTokenAddress,
  deriveCoinAddresses,
  deriveCoinPda,
  deriveCoinVaultPda,
  deriveCrankPoolPda,
  deriveCurveTablePda,
  deriveGlobalBudgetPda,
  deriveMintPda,
  deriveOpportunityPda,
  derivePlayerPda,
  derivePoolAddresses,
  derivePoolPda,
  derivePoolSolVaultPda,
  derivePoolTokenVaultPda,
  derivePositionPda,
  deriveProtocolPda,
  deriveSponsorEventPda,
  deriveSponsorGrantPda,
  deriveSponsorVaultPda,
  deriveTreasuryPda,
  findProgramAddressSync,
  type CoinAddresses,
  type PoolAddresses,
} from "../shared/pdas";
