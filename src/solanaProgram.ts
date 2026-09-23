/**
 * Frontend-side actions against the diggo_protocol Solana program. Every write here is signed
 * by the connected wallet (never a backend key) and submitted through the Worker's RPC proxy
 * (/api/rpc) so no RPC provider API key is ever embedded in the browser bundle.
 *
 * Read-only game state (ORE, Crew, streaks, discoveries) lives in the Worker/D1 — see
 * src/api.ts. This module is only for instructions the diggo_protocol program itself defines:
 * launching a coin, buying/selling on its trading venue, and mining-power/reward flows that
 * require the player's own wallet signature.
 *
 * A market has two venues and the program will not let a trade use the wrong one: before
 * graduation `buy`/`sell` trade the bonding curve, and after `graduate_market` has moved the
 * curve's whole liquidity into the program-owned constant-product pool, `pool_buy`/`pool_sell`
 * trade that pool instead (docs/ONCHAIN.md, spec 36). The venue is always read from the decoded
 * market account, never assumed, and the quotes come from the shared mirrors of the program's own
 * math in shared/program.ts so the slippage floor matches what the chain will enforce.
 */
import {
  address,
  type Address,
  createSolanaRpc,
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  signTransactionMessageWithSigners,
  signAndSendTransactionMessageWithSigners,
  isTransactionSendingSigner,
  getSignatureFromTransaction,
  getBase64EncodedWireTransaction,
  getBase58Decoder,
  pipe,
  type TransactionSigner,
  type Instruction,
} from "@solana/kit";
import { Buffer } from "buffer";
import { PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import type { Provider as WalletConnectSolanaProvider } from "@reown/appkit-adapter-solana/react";

type IInstruction = Instruction;
import {
  deriveProtocolPda,
  deriveMintPda,
  deriveMineAddresses,
  derivePoolAddresses,
  derivePlayerPda,
  derivePositionPda,
  deriveAssociatedTokenAddress,
  buildLaunchTokenInstruction,
  buildBuyInstruction,
  buildSellInstruction,
  buildPoolBuyInstruction,
  buildPoolSellInstruction,
  buildInitializePlayerInstruction,
  buildAssignPowerInstruction,
  buildClaimRewardsInstruction,
  decodeProtocolConfig,
  decodeMine,
  decodeLaunchMarket,
  decodeLiquidityPool,
  decodePlayer,
  decodeMiningPosition,
  bondingCurveSpotPriceLamports,
  quoteBuy,
  quoteSell,
  poolQuoteBuy,
  poolQuoteSell,
  poolSpotPriceLamports,
  netAfterFees,
  type LaunchTokenArgs,
  type MineAddresses,
  type PoolAddresses,
  type DecodedProtocolConfig,
  type DecodedMine,
  type DecodedLaunchMarket,
  type DecodedLiquidityPool,
  type DecodedPlayer,
  type DecodedMiningPosition,
} from "../shared/program";

const rpc = createSolanaRpc("/api/rpc");

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function fetchAndDecode<T>(pda: Address, decode: (data: Uint8Array) => T): Promise<T | null> {
  const info = await rpc.getAccountInfo(pda, { commitment: "confirmed", encoding: "base64" }).send();
  if (!info.value) return null;
  return decode(base64ToBytes(info.value.data[0]));
}

export async function fetchProtocolConfig(programAddress: Address): Promise<DecodedProtocolConfig | null> {
  const pda = await deriveProtocolPda(programAddress);
  return fetchAndDecode(pda, decodeProtocolConfig);
}

export async function fetchMineAndMarket(
  programAddress: Address,
  mint: Address,
): Promise<{ mine: DecodedMine; market: DecodedLaunchMarket } | null> {
  const addrs = await deriveMineAddresses(programAddress, mint);
  const [mine, market] = await Promise.all([
    fetchAndDecode(addrs.mine, decodeMine),
    fetchAndDecode(addrs.market, decodeLaunchMarket),
  ]);
  if (!mine || !market) return null;
  return { mine, market };
}

export async function fetchPlayer(programAddress: Address, owner: Address): Promise<DecodedPlayer | null> {
  const pda = await derivePlayerPda(programAddress, owner);
  return fetchAndDecode(pda, decodePlayer);
}

export async function fetchPosition(
  programAddress: Address,
  mine: Address,
  owner: Address,
): Promise<DecodedMiningPosition | null> {
  const pda = await derivePositionPda(programAddress, mine, owner);
  return fetchAndDecode(pda, decodeMiningPosition);
}

export { bondingCurveSpotPriceLamports, quoteBuy, quoteSell };

// --- venue: bonding curve before graduation, locked pool after ------------------------------

/**
 * Which venue a market trades on. The program decides this with the market's own `graduated`
 * flag: `buy`/`sell` reject a graduated market with MarketGraduated and `pool_buy`/`pool_sell`
 * reject a pre-graduation one with MarketNotGraduated, so getting this wrong is a guaranteed
 * failed transaction rather than a wrong price.
 */
export type SwapVenue = "curve" | "pool";

export interface MarketVenueState {
  mine: DecodedMine;
  market: DecodedLaunchMarket;
  /** The locked pool, or null while the market is still on its bonding curve. */
  pool: DecodedLiquidityPool | null;
  venue: SwapVenue;
}

/**
 * The venue, from the decoded market account alone. The pool account is deliberately not part
 * of this decision: graduation creates the flag and the pool in one instruction, so a graduated
 * market always has a pool, and treating an unreadable pool account as "still on the curve"
 * would route a trade into an instruction the program rejects.
 */
export function resolveSwapVenue(market: { graduated: boolean }): SwapVenue {
  return market.graduated ? "pool" : "curve";
}

/**
 * Reads a mine, its market and its pool in one pass. Returns null only when the mine or the
 * market account is missing — a missing pool account simply means the market has not graduated.
 */
export async function fetchMarketVenue(
  programAddress: Address,
  mint: Address,
): Promise<MarketVenueState | null> {
  const mineAddrs = await deriveMineAddresses(programAddress, mint);
  const poolAddrs = await derivePoolAddresses(programAddress, mint);
  const [mine, market, pool] = await Promise.all([
    fetchAndDecode(mineAddrs.mine, decodeMine),
    fetchAndDecode(mineAddrs.market, decodeLaunchMarket),
    fetchAndDecode(poolAddrs.pool, decodeLiquidityPool),
  ]);
  if (!mine || !market) return null;
  return { mine, market, pool, venue: resolveSwapVenue(market) };
}

/** The slippage floor the trade form applies when it has a quote: 2%. */
export const DEFAULT_SLIPPAGE_BPS = 200;

export interface SwapQuote {
  venue: SwapVenue;
  side: "buy" | "sell";
  /** What the wallet pays: lamports for a buy, raw token units for a sell. */
  inRaw: bigint;
  /** What the wallet receives: raw token units for a buy, lamports for a sell. */
  outRaw: bigint;
  /** The slippage floor to send as `min_tokens_out` / `min_sol_out`. */
  minOutRaw: bigint;
  creatorFeeRaw: bigint;
  platformFeeRaw: bigint;
  /** creatorFeeRaw + platformFeeRaw, i.e. the explicit fee taken off the top. */
  feeRaw: bigint;
  slippageBps: number;
}

function applySlippage(amount: bigint, slippageBps: number): bigint {
  const bps = BigInt(Math.min(Math.max(Math.trunc(slippageBps), 0), 10_000));
  return (amount * (10_000n - bps)) / 10_000n;
}

/**
 * Quotes a trade on whichever venue the market is actually on, using the shared mirrors of the
 * program's own math (shared/program.ts) and the program's exact fee order:
 *
 * - a buy's explicit fees come off the top of the gross SOL, so the curve or pool only sees the
 *   net input;
 * - a sell's fees are deducted from the gross curve/pool output, and the wallet receives the net.
 *
 * Returns null when there is nothing to quote — a non-positive amount, or a graduated market
 * whose pool reserves have not been read — so a caller can show "unknown" instead of a number
 * this module made up.
 */
export function quoteSwap(
  state: { market: DecodedLaunchMarket; pool: DecodedLiquidityPool | null },
  side: "buy" | "sell",
  amountRaw: bigint,
  slippageBps: number = DEFAULT_SLIPPAGE_BPS,
): SwapQuote | null {
  if (amountRaw <= 0n) return null;
  const venue = resolveSwapVenue(state.market);
  const { creatorFeeBps, platformFeeBps } = state.market;

  const feesOf = (amount: bigint) => netAfterFees(amount, creatorFeeBps, platformFeeBps);
  const build = (
    inRaw: bigint,
    outRaw: bigint,
    creatorFeeRaw: bigint,
    platformFeeRaw: bigint,
  ): SwapQuote => ({
    venue,
    side,
    inRaw,
    outRaw,
    minOutRaw: applySlippage(outRaw, slippageBps),
    creatorFeeRaw,
    platformFeeRaw,
    feeRaw: creatorFeeRaw + platformFeeRaw,
    slippageBps,
  });

  if (venue === "pool") {
    const { pool } = state;
    if (!pool) return null;
    if (side === "buy") {
      const { net, creatorFee, platformFee } = feesOf(amountRaw);
      return build(amountRaw, poolQuoteBuy(pool, net), creatorFee, platformFee);
    }
    const gross = poolQuoteSell(pool, amountRaw);
    const { net, creatorFee, platformFee } = feesOf(gross);
    return build(amountRaw, net, creatorFee, platformFee);
  }

  if (side === "buy") {
    const { net, creatorFee, platformFee } = feesOf(amountRaw);
    return build(amountRaw, quoteBuy(state.market, net), creatorFee, platformFee);
  }
  const gross = quoteSell(state.market, amountRaw);
  const { net, creatorFee, platformFee } = feesOf(gross);
  return build(amountRaw, net, creatorFee, platformFee);
}

/**
 * A form's amount in the units the program counts in: lamports for a buy, raw token units for a
 * sell. One function so the amount a quote was built on and the amount the instruction carries are
 * the same integer, never two roundings of the same decimal.
 */
export function swapAmountRaw(amount: number, side: "buy" | "sell", decimals: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0) return 0n;
  return side === "buy"
    ? BigInt(Math.round(amount * 1_000_000_000))
    : BigInt(Math.round(amount * 10 ** decimals));
}

/**
 * A trade that is ready to be signed: the venue the program will accept, the exact raw amount the
 * wallet pays, and the slippage floor that came from a live quote.
 */
export interface SwapPlan {
  venue: SwapVenue;
  side: "buy" | "sell";
  /** Lamports for a buy, raw token units for a sell — the same integer the quote was priced on. */
  amountRaw: bigint;
  /** The floor to send on-chain. Always > 0, always the quoted output less the slippage. */
  minOutRaw: bigint;
  /** Quoted wallet output: raw token units for a buy, lamports for a sell. */
  expectedOutRaw: bigint;
  slippageBps: number;
}

/**
 * Thrown when a trade cannot be given a real slippage floor. A caller must treat this as "do not
 * send": `min_tokens_out` / `min_sol_out` of zero is a standing offer to be filled at any price.
 */
export class QuoteUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuoteUnavailableError";
  }
}

/**
 * The only place a trade becomes amounts to send. Every rejection here is a trade that would
 * otherwise have gone out unprotected: an unreadable venue (a market or pool read that failed, so
 * there is no price), a venue that prices the trade at nothing, or a quote so small that slippage
 * truncates the floor to zero. The floor is derived from the quote at the caller's own slippage, so
 * a sell is guarded exactly like a buy.
 */
export function planSwap(
  state: { market: DecodedLaunchMarket; pool: DecodedLiquidityPool | null },
  side: "buy" | "sell",
  amountRaw: bigint,
  slippageBps: number = DEFAULT_SLIPPAGE_BPS,
): SwapPlan {
  if (amountRaw <= 0n) throw new QuoteUnavailableError("Enter an amount to trade.");
  const quote = quoteSwap(state, side, amountRaw, slippageBps);
  if (!quote) {
    throw new QuoteUnavailableError(
      resolveSwapVenue(state.market) === "pool"
        ? "This market's locked pool could not be read, so there is no price to trade against yet. Retry in a moment."
        : "Could not price this trade against the curve, so nothing was sent. Retry in a moment.",
    );
  }
  if (quote.minOutRaw <= 0n) {
    throw new QuoteUnavailableError("This trade is too small to protect against slippage. Increase the amount.");
  }
  return {
    venue: quote.venue,
    side: quote.side,
    amountRaw: quote.inRaw,
    minOutRaw: quote.minOutRaw,
    expectedOutRaw: quote.outRaw,
    slippageBps: quote.slippageBps,
  };
}

/**
 * Spot price in SOL per whole token, from the venue that actually backs the price. Null when the
 * venue's reserves are not readable, so callers can fall back to the indexed price instead of
 * displaying a zero.
 */
export function venueSpotPriceSol(
  state: { market: DecodedLaunchMarket; pool: DecodedLiquidityPool | null },
  decimals: number,
): number | null {
  if (resolveSwapVenue(state.market) === "pool") {
    if (!state.pool) return null;
    return poolSpotPriceLamports(state.pool, decimals) / 1_000_000_000;
  }
  return bondingCurveSpotPriceLamports(state.market, decimals) / 1_000_000_000;
}

/**
 * The instruction for one trade, on one venue. Pure and exported so the routing itself is
 * testable without a wallet or an RPC: the venue is the only thing that decides which of the
 * four instructions is built, and a pool trade is the shared mirror's pool instruction
 * byte for byte.
 */
export function buildSwapInstruction(params: {
  programAddress: Address;
  /** The signing wallet. */
  trader: Address;
  /** The trader's own token account for the mint. */
  traderTokens: Address;
  mine: MineAddresses;
  /** Required for a pool trade; derive with derivePoolAddresses. */
  pool: PoolAddresses | null;
  venue: SwapVenue;
  side: "buy" | "sell";
  amountRaw: bigint;
  minOutRaw: bigint;
}): IInstruction {
  const { programAddress, trader, traderTokens, mine, pool, venue, side, amountRaw, minOutRaw } = params;
  if (venue === "pool") {
    if (!pool) throw new Error("pool addresses are required to trade on a graduated market");
    if (side === "buy") {
      return buildPoolBuyInstruction({
        programAddress,
        buyer: trader,
        buyerTokens: traderTokens,
        mine: mine.mine,
        market: mine.market,
        mint: mine.mint,
        pool: pool.pool,
        tokenVault: pool.poolTokenVault,
        solVault: pool.poolSolVault,
        solIn: amountRaw,
        minTokensOut: minOutRaw,
      });
    }
    return buildPoolSellInstruction({
      programAddress,
      seller: trader,
      sellerTokens: traderTokens,
      mine: mine.mine,
      market: mine.market,
      mint: mine.mint,
      pool: pool.pool,
      tokenVault: pool.poolTokenVault,
      solVault: pool.poolSolVault,
      tokensIn: amountRaw,
      minSolOut: minOutRaw,
    });
  }
  if (side === "buy") {
    return buildBuyInstruction({
      programAddress,
      buyer: trader,
      buyerTokens: traderTokens,
      solIn: amountRaw,
      minTokensOut: minOutRaw,
      ...mine,
    });
  }
  return buildSellInstruction({
    programAddress,
    seller: trader,
    sellerTokens: traderTokens,
    tokensIn: amountRaw,
    minSolOut: minOutRaw,
    ...mine,
  });
}

export async function fetchSolBalance(owner: Address): Promise<bigint> {
  const { value } = await rpc.getBalance(owner, { commitment: "confirmed" }).send();
  return value;
}

export async function fetchTokenBalance(owner: Address, mint: Address): Promise<bigint> {
  const ata = await deriveAssociatedTokenAddress(owner, mint);
  try {
    const { value } = await rpc.getTokenAccountBalance(ata, { commitment: "confirmed" }).send();
    return BigInt(value.amount);
  } catch {
    return 0n;
  }
}

/**
 * A WalletConnect-paired Solana wallet, wrapped to carry its own address alongside the Reown
 * `Provider` object (whose signing methods take @solana/web3.js Transactions, unlike the
 * @solana/kit TransactionSigner used for Wallet Standard wallets — see signSendConfirm below).
 */
export interface WalletConnectHandle {
  kind: "walletconnect";
  address: Address;
  provider: WalletConnectSolanaProvider;
}

/**
 * Every on-chain action in this module accepts either connection method. Wallet Standard
 * (desktop extensions, most mobile in-app browsers) is a plain @solana/kit TransactionSigner;
 * WalletConnect (QR-paired wallets) is the handle above. Both expose `.address`, so PDA
 * derivation call sites never need to branch — only submit() does.
 */
export type DiggoWallet = TransactionSigner | WalletConnectHandle;

/**
 * A submitted transaction. `confirmed` is false only when the network had not confirmed it before
 * the deadline — a transaction the chain rejected never reaches a caller as a result.
 */
export interface SubmissionResult {
  signature: string;
  confirmed: boolean;
}

function isWalletConnectHandle(wallet: DiggoWallet): wallet is WalletConnectHandle {
  return (wallet as WalletConnectHandle).kind === "walletconnect";
}

function toWeb3Instruction(ix: IInstruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programAddress),
    keys: (ix.accounts ?? []).map((account) => ({
      pubkey: new PublicKey(account.address),
      // @solana/kit's AccountRole is bit-flagged: bit0=writable, bit1=signer — see shared/program.ts.
      isSigner: (account.role & 2) !== 0,
      isWritable: (account.role & 1) !== 0,
    })),
    data: Buffer.from(ix.data ?? new Uint8Array()),
  });
}

/**
 * Waits for a signature to reach confirmed. Returns false when the deadline passes, and throws when
 * the chain reports the transaction as failed: "not seen yet" and "rejected" are different
 * outcomes, and only the first one is a caller's choice.
 */
async function awaitConfirmation(signature: string, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value } = await rpc.getSignatureStatuses([signature as never]).send();
    const status = value[0];
    if (status?.err) throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  return false;
}

/**
 * Submits instructions, signed by the connected wallet, and returns once they are confirmed.
 *
 * `tolerantConfirmation` is what a claim needs and a launch must not have: the caller still gets the
 * signature when confirmation polling times out, because a transaction that landed must not be lost
 * to a slow RPC. A transaction the chain actually rejected always throws, in both modes.
 */
async function submit(
  feePayer: DiggoWallet,
  instructions: IInstruction[],
  tolerantConfirmation: boolean,
): Promise<SubmissionResult> {
  const settle = async (signature: string, timeoutMs?: number): Promise<SubmissionResult> => {
    const confirmed = await awaitConfirmation(signature, timeoutMs);
    if (!confirmed && !tolerantConfirmation) throw new Error("Timed out waiting for confirmation");
    return { signature, confirmed };
  };

  if (isWalletConnectHandle(feePayer)) {
    const { value: latestBlockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
    const tx = new Transaction();
    tx.feePayer = new PublicKey(feePayer.address);
    tx.recentBlockhash = latestBlockhash.blockhash;
    for (const ix of instructions) tx.add(toWeb3Instruction(ix));
    const signature = await feePayer.provider.signAndSendTransaction(tx);
    return settle(signature, 60_000);
  }

  const { value: latestBlockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const message = pipe(
    // Legacy messages are intentionally used here. The program does not need address lookup
    // tables, and browser wallets (notably OKX) can decode legacy account changes reliably.
    // Versioned v0 messages were shown as an "Unknown transaction" with a disabled confirm
    // button even though the instruction bytes themselves were valid.
    createTransactionMessage({ version: "legacy" }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );

  if (isTransactionSendingSigner(feePayer)) {
    const signatureBytes = await signAndSendTransactionMessageWithSigners(message);
    const signature = getBase58Decoder().decode(signatureBytes) as string;
    // Wallet Standard's send-capable signers return as soon as the RPC accepts the transaction.
    // The following API call reads the newly-created PDAs, so wait for confirmed state rather
    // than racing the indexer and leaving an already-launched coin invisible in the dashboard.
    return settle(signature, 60_000);
  }

  const signedTx = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(signedTx);
  const wireTransaction = getBase64EncodedWireTransaction(signedTx);
  await rpc.sendTransaction(wireTransaction, { encoding: "base64", preflightCommitment: "confirmed" }).send();
  return settle(signature);
}

async function signSendConfirm(
  feePayer: DiggoWallet,
  instructions: IInstruction[],
): Promise<string> {
  return (await submit(feePayer, instructions, false)).signature;
}

export interface LaunchCoinInput {
  name: string;
  symbol: string;
  decimals: number;
  totalSupplyWhole: number;
  /** SOL the bonding curve behaves as if it already holds — sets the starting price. */
  virtualSolReserveSol: number;
  /** Real SOL the market must collect before this mine graduates to active mining. */
  graduationTargetSol: number;
  blockIntervalSeconds: number;
  epochLengthSeconds: number;
  reductionBps: number;
  initialBlockRewardWhole: number;
  minimumRewardWhole: number;
  /** Optional creator buy executed atomically after launch in the same transaction. */
  initialBuySol: number;
}

export interface LaunchCoinResult {
  signature: string;
  mint: Address;
}

const LAMPORTS_PER_SOL = 1_000_000_000n;
const solToLamports = (sol: number) => BigInt(Math.round(sol * 1_000_000_000));

/**
 * Launches a coin directly on-chain — no backend queue, no vanity grinding (the mint is a
 * program-derived address and cannot be ground for a suffix; see programs/diggo-protocol).
 * The caller must separately call registerLaunchedToken() after this confirms so the Worker's
 * D1 cache picks it up for display.
 */
export async function launchCoinOnChain(
  programAddress: Address,
  creator: DiggoWallet,
  treasury: Address,
  protocolReserveBps: number,
  protocolDiscoveryReserveBps: number,
  input: LaunchCoinInput,
): Promise<LaunchCoinResult> {
  const protocolPda = await deriveProtocolPda(programAddress);
  const nonce = BigInt(Date.now());
  const mint = await deriveMintPda(programAddress, creator.address, nonce);
  const mineAddrs = await deriveMineAddresses(programAddress, mint);
  const feeVault = await deriveAssociatedTokenAddress(treasury, mint);

  const args: LaunchTokenArgs = {
    nonce,
    name: input.name,
    symbol: input.symbol,
    uri: "",
    decimals: input.decimals,
    totalSupply: BigInt(Math.round(input.totalSupplyWhole)) * 10n ** BigInt(input.decimals),
    reserveBps: protocolReserveBps,
    initialBlockReward: BigInt(Math.round(input.initialBlockRewardWhole)) * 10n ** BigInt(input.decimals),
    minimumReward: BigInt(Math.round(input.minimumRewardWhole)) * 10n ** BigInt(input.decimals),
    blockInterval: BigInt(input.blockIntervalSeconds),
    epochLength: BigInt(input.epochLengthSeconds),
    reductionBps: input.reductionBps,
    virtualSolReserve: solToLamports(input.virtualSolReserveSol),
    graduationTarget: solToLamports(input.graduationTargetSol),
    discoveryReserveBps: protocolDiscoveryReserveBps,
  };

  const instruction = buildLaunchTokenInstruction({
    programAddress,
    creator: creator.address,
    protocol: protocolPda,
    treasury,
    feeVault,
    ...mineAddrs,
    args,
  });
  const instructions: IInstruction[] = [instruction];
  if (input.initialBuySol > 0) {
    const buyerTokens = await deriveAssociatedTokenAddress(creator.address, mint);
    instructions.push(buildBuyInstruction({
      programAddress,
      buyer: creator.address,
      buyerTokens,
      solIn: solToLamports(input.initialBuySol),
      minTokensOut: 0n,
      ...mineAddrs,
    }));
  }

  const signature = await signSendConfirm(creator, instructions);
  return { signature, mint };
}

export interface BuyResult {
  signature: string;
}

export interface TradeVenueOptions {
  /**
   * The venue the caller has already resolved from the on-chain accounts — SwapPanel holds the
   * decoded market, so it passes this and pays nothing extra. Omitted means "ask the chain",
   * which costs one additional account read.
   */
  venue?: SwapVenue;
}

/**
 * The venue for a trade: the caller's answer when it has one, otherwise the market's own
 * `graduated` flag. An unreadable market falls back to the curve, which the program then rejects
 * with MarketGraduated — a failed trade the user can see, rather than a silent misroute.
 */
async function tradeVenue(
  programAddress: Address,
  mint: Address,
  requested?: SwapVenue,
): Promise<SwapVenue> {
  if (requested) return requested;
  const { market } = await deriveMineAddresses(programAddress, mint);
  const decoded = await fetchAndDecode(market, decodeLaunchMarket);
  return decoded ? resolveSwapVenue(decoded) : "curve";
}

/**
 * Buys `solIn` SOL worth of tokens on whichever venue the market is on: the bonding curve before
 * graduation, the program-owned pool after it. This is the real liquidity path in both cases.
 *
 * `minTokensOutRaw` is required and has to be positive: a floor of zero is not a trade with no
 * slippage protection, it is a standing offer to be filled at any price, and there is no caller
 * that has a legitimate reason to send one. The refusal happens before anything is signed, so a
 * trade this function rejects never reaches a wallet prompt.
 */
export async function buyOnChain(
  programAddress: Address,
  buyer: DiggoWallet,
  mint: Address,
  solIn: number,
  minTokensOutRaw: bigint,
  options: TradeVenueOptions = {},
): Promise<BuyResult> {
  if (minTokensOutRaw <= 0n) {
    throw new QuoteUnavailableError(
      "This buy has no floor on the tokens it receives, so it was not sent. Retry in a moment.",
    );
  }
  const venue = await tradeVenue(programAddress, mint, options.venue);
  const mineAddrs = await deriveMineAddresses(programAddress, mint);
  const buyerTokens = await deriveAssociatedTokenAddress(buyer.address, mint);
  const instruction = buildSwapInstruction({
    programAddress,
    trader: buyer.address,
    traderTokens: buyerTokens,
    mine: mineAddrs,
    pool: venue === "pool" ? await derivePoolAddresses(programAddress, mint) : null,
    venue,
    side: "buy",
    amountRaw: solToLamports(solIn),
    minOutRaw: minTokensOutRaw,
  });
  const signature = await signSendConfirm(buyer, [instruction]);
  return { signature };
}

/** Sells `tokensInRaw` base units of a mine's token back into its curve, or its pool, for SOL. */
export async function sellOnChain(
  programAddress: Address,
  seller: DiggoWallet,
  mint: Address,
  tokensInRaw: bigint,
  minSolOutLamports: bigint,
  options: TradeVenueOptions = {},
): Promise<BuyResult> {
  if (minSolOutLamports <= 0n) {
    throw new QuoteUnavailableError(
      "This sell has no floor on the SOL it receives, so it was not sent. Retry in a moment.",
    );
  }
  const venue = await tradeVenue(programAddress, mint, options.venue);
  const mineAddrs = await deriveMineAddresses(programAddress, mint);
  const sellerTokens = await deriveAssociatedTokenAddress(seller.address, mint);
  const instruction = buildSwapInstruction({
    programAddress,
    trader: seller.address,
    traderTokens: sellerTokens,
    mine: mineAddrs,
    pool: venue === "pool" ? await derivePoolAddresses(programAddress, mint) : null,
    venue,
    side: "sell",
    amountRaw: tokensInRaw,
    minOutRaw: minSolOutLamports,
  });
  const signature = await signSendConfirm(seller, [instruction]);
  return { signature };
}

/** The on-chain calls a swap needs. Injectable so the fresh-quote path can be tested without an RPC. */
export interface SwapExecutionDeps {
  readVenue: typeof fetchMarketVenue;
  buy: typeof buyOnChain;
  sell: typeof sellOnChain;
}

const DEFAULT_SWAP_DEPS: SwapExecutionDeps = {
  readVenue: fetchMarketVenue,
  buy: buyOnChain,
  sell: sellOnChain,
};

export interface SwapExecution {
  signature: string;
  /**
   * What to record for the indexer: tokens bought, or tokens sold, as an exact decimal string.
   * A raw base-unit figure above 2^53 does not survive a JS Number, and this value is the record of
   * what actually traded, so it is carried as a string all the way to the API.
   */
  recordedAmount: string;
  /** The floor that went on-chain and the quote it came from. */
  plan: SwapPlan;
  /** The venue read immediately before signing, so the form can adopt it as its own state. */
  state: MarketVenueState;
}

/**
 * Prices a trade against the chain again and then sends it, with the floor from that fresh quote.
 *
 * The quote a form is displaying can be seconds old, and the account it came from can have failed
 * to read at all — in both cases signing with no floor (or with a floor from a stale venue) is the
 * failure this function exists to make impossible. It reads the market immediately before building
 * the instruction, and every trade it submits carries a min-out that is non-zero and derived from
 * that read at the caller's slippage. There is no path through here that submits a zero floor: the
 * reads and quotes that fail turn into a QuoteUnavailableError the caller shows instead of a
 * transaction.
 *
 * The signed instruction derives its lamports from the same `amount` the quote was priced on
 * (buyOnChain's solToLamports), so the floor and the amount can never describe different trades.
 */
export async function executeSwap(params: {
  programAddress: Address;
  wallet: DiggoWallet;
  mint: Address;
  side: "buy" | "sell";
  /** Whole SOL to pay for a buy, whole tokens to sell for a sell. */
  amount: number;
  decimals: number;
  slippageBps?: number;
  deps?: Partial<SwapExecutionDeps>;
}): Promise<SwapExecution> {
  const deps: SwapExecutionDeps = { ...DEFAULT_SWAP_DEPS, ...params.deps };
  const amountRaw = swapAmountRaw(params.amount, params.side, params.decimals);
  if (amountRaw <= 0n) throw new QuoteUnavailableError("Enter an amount to trade.");
  const state = await deps.readVenue(params.programAddress, params.mint);
  if (!state) {
    throw new QuoteUnavailableError(
      "This market's on-chain state could not be read, so the trade was not sent. Retry in a moment.",
    );
  }
  const plan = planSwap(state, params.side, amountRaw, params.slippageBps ?? DEFAULT_SLIPPAGE_BPS);
  const result =
    plan.side === "buy"
      ? await deps.buy(params.programAddress, params.wallet, params.mint, params.amount, plan.minOutRaw, {
          venue: plan.venue,
        })
      : await deps.sell(params.programAddress, params.wallet, params.mint, plan.amountRaw, plan.minOutRaw, {
          venue: plan.venue,
        });
  return {
    signature: result.signature,
    recordedAmount: rawAmountToDecimal(
      plan.side === "buy" ? plan.expectedOutRaw : plan.amountRaw,
      params.decimals,
    ),
    plan,
    state,
  };
}

/**
 * A raw base-unit amount as an exact decimal string, without going through a float.
 *
 * `Number(raw) / 10 ** decimals` rounds anything above 2^53, which is a real token amount for a
 * nine-decimal mint: the index would record a number nobody traded.
 */
export function rawAmountToDecimal(raw: bigint, decimals: number): string {
  const places = Number.isFinite(decimals) && decimals > 0 ? Math.floor(decimals) : 0;
  const scale = 10n ** BigInt(places);
  const whole = raw / scale;
  const fraction = raw - whole * scale;
  if (fraction === 0n) return whole.toString();
  return `${whole}.${fraction.toString().padStart(places, "0").replace(/0+$/, "")}`;
}

export async function fetchAccountExists(pda: Address): Promise<boolean> {
  const info = await rpc.getAccountInfo(pda, { commitment: "confirmed" }).send();
  return info.value !== null;
}

/** Idempotent: only sends initialize_player if the Player PDA doesn't already exist. */
export async function ensurePlayerInitialized(programAddress: Address, owner: DiggoWallet): Promise<void> {
  const playerPda = await derivePlayerPda(programAddress, owner.address);
  if (await fetchAccountExists(playerPda)) return;
  const instruction = buildInitializePlayerInstruction({ programAddress, owner: owner.address, player: playerPda });
  await signSendConfirm(owner, [instruction]);
}

/** Assigns the player's on-chain Mining Power to `mint`'s mine (no tokens are spent). */
export async function assignPowerOnChain(
  programAddress: Address,
  owner: DiggoWallet,
  mint: Address,
): Promise<string> {
  await ensurePlayerInitialized(programAddress, owner);
  const playerPda = await derivePlayerPda(programAddress, owner.address);
  const { mine } = await deriveMineAddresses(programAddress, mint);
  const positionPda = await derivePositionPda(programAddress, mine, owner.address);
  const instruction = buildAssignPowerInstruction({
    programAddress,
    owner: owner.address,
    player: playerPda,
    mine,
    position: positionPda,
  });
  return signSendConfirm(owner, [instruction]);
}

/** Claims accumulated real block rewards for `mint`'s mine into the player's own token account. */
export async function claimRewardsOnChain(
  programAddress: Address,
  owner: DiggoWallet,
  mint: Address,
): Promise<string> {
  const { mine, reserveVault } = await deriveMineAddresses(programAddress, mint);
  const positionPda = await derivePositionPda(programAddress, mine, owner.address);
  const ownerTokens = await deriveAssociatedTokenAddress(owner.address, mint);
  const instruction = buildClaimRewardsInstruction({
    programAddress,
    owner: owner.address,
    mine,
    mint,
    reserveVault,
    ownerTokens,
    position: positionPda,
  });
  return signSendConfirm(owner, [instruction]);
}

/**
 * The same claim_rewards instruction, but submitted so a caller always learns the signature.
 *
 * Mining rewards leave the program's reserve only through this instruction, and the backend has to
 * be told about the transaction afterwards (POST /api/rewards/claim/confirm). Reporting a landed
 * payout must not depend on the player's RPC answering within the polling window, so this returns
 * the signature with `confirmed: false` rather than throwing when confirmation is slow — the
 * backend verifies the transaction on chain either way.
 */
export async function submitClaimRewardsOnChain(
  programAddress: Address,
  owner: DiggoWallet,
  mint: Address,
): Promise<SubmissionResult> {
  const { mine, reserveVault } = await deriveMineAddresses(programAddress, mint);
  const positionPda = await derivePositionPda(programAddress, mine, owner.address);
  const ownerTokens = await deriveAssociatedTokenAddress(owner.address, mint);
  const instruction = buildClaimRewardsInstruction({
    programAddress,
    owner: owner.address,
    mine,
    mint,
    reserveVault,
    ownerTokens,
    position: positionPda,
  });
  return submit(owner, [instruction], true);
}

export { address, deriveMineAddresses, deriveAssociatedTokenAddress, LAMPORTS_PER_SOL, rpc };
