/**
 * The frontend's whole on-chain surface, in one import path.
 *
 * Everything here is wallet-signed and reads the program directly. Instruction building, PDA
 * derivation, account decoding and the error catalogue come from shared/program.ts and
 * shared/pdas.ts (WS-D), which are the single client transcription of the frozen contract; this
 * package adds the three things a browser needs on top of them: RPC reads through the Worker's
 * proxy, the wallet plumbing, and the action orchestration that turns a form into one
 * transaction.
 *
 * src/solanaProgram.ts re-exports this, and that is the path the components use.
 */

// Keep the kit's address codec on the package's public surface. UI code receives wallet
// addresses as strings and must convert them at the boundary before any PDA or RPC call.
export { address } from "@solana/kit";

export {
  DEFAULT_PUBKEY,
  DEFAULT_SLIPPAGE_BPS,
  ESTIMATED_LAUNCH_TX_FEE_LAMPORTS,
  NotInitializedError,
  QuoteUnavailableError,
  activatePlayer,
  advanceMine,
  assignPower,
  availableCrankActions,
  buildSwapInstruction,
  claimCreatorFees,
  claimRewards,
  collectOre,
  commitEpochSeed,
  crankTip,
  createDiscoveryRoll,
  createPlayerAccount,
  ensurePlayerInitialized,
  executeSwap,
  expireOpportunity,
  findLaunchSubsidy,
  findPlayerSubsidy,
  graduateMarket,
  joinMine,
  launchCoin,
  launchCostLamports,
  planSwap,
  quoteSwap,
  rawAmountToDecimal,
  removePower,
  requestUnbond,
  resolveSubsidy,
  selectSponsorEvent,
  settleDiscovery,
  sponsorEventActive,
  sponsorEventRemaining,
  swapAmountRaw,
  sweepFees,
  switchMine,
  upgradeCrew,
  venueSpotPriceSol,
  withdrawBond,
  type CrankAction,
  type LaunchCoinInput,
  type LaunchCoinResult,
  type SponsorEventView,
  type SponsorSubsidy,
  type SwapPlan,
  type SwapQuote,
} from "./actions";

/**
 * The quote mirror lives in shared/curve.ts, next to the Rust math it transcribes, so the client
 * and the sim read one copy (CCR-F4). Re-exported here because this package is the frontend's
 * single on-chain import path.
 */
export {
  QuoteError,
  curveSpotPriceLamportsPerUnit,
  mulBps,
  poolSpotPriceLamportsPerUnit,
  quoteCurveBuy,
  quoteCurveSell,
  quotePoolBuy,
  quotePoolSell,
  splitFees,
  type FeeSplit,
  type TradeFeeBps,
} from "../../shared/curve";

export {
  accountExists,
  fetchAndDecode,
  fetchCoin,
  fetchCoinVenue,
  fetchCurrentSlot,
  fetchGlobalBudget,
  fetchLatestBlockhash,
  fetchPlayer,
  fetchPool,
  fetchPosition,
  fetchProtocolConfig,
  fetchSolBalance,
  fetchSponsorEvent,
  fetchSponsorEvents,
  fetchSponsorGrant,
  fetchSponsorVault,
  fetchTokenBalance,
  findOpportunity,
  playerTokenAccount,
  resolveSwapVenue,
  type CoinVenueState,
  type OpportunityHandle,
  type SwapVenue,
} from "./rpc";

export {
  SPONSOR_EVENT_RENT_LAMPORTS,
  SPONSOR_KIND_OPTIONS,
  SPONSOR_VAULT_RENT_LAMPORTS,
  closeSponsorEventInstructions,
  createSponsorEventInstructions,
  fundSponsorVaultInstructions,
  initSponsorVaultInstructions,
  loadSponsorAdminState,
  sponsorKindLabel,
  sponsorProposalMessage,
  submitSponsorInstructions,
  toImportableMessage,
  withdrawSponsorVaultInstructions,
  type SponsorAdminState,
} from "./sponsor";

export {
  RPC_ENDPOINT,
  PendingTransactionError,
  awaitConfirmation,
  describeTransactionError,
  isPendingTransactionError,
  isWalletConnectHandle,
  rpc,
  signSendConfirm,
  submit,
  walletAddress,
  type DiggoWallet,
  type SubmissionResult,
  type WalletConnectHandle,
} from "./tx";

export {
  PendingTransactionProvider,
  usePendingTransaction,
} from "./PendingTransactionProvider";
