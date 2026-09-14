/**
 * Frontend-side actions against the diggo_protocol Solana program. Every write here is signed
 * by the connected wallet (never a backend key) and submitted through the Worker's RPC proxy
 * (/api/rpc) so no RPC provider API key is ever embedded in the browser bundle.
 *
 * Read-only game state (ORE, Crew, streaks, discoveries) lives in the Worker/D1 — see
 * src/api.ts. This module is only for instructions the diggo_protocol program itself defines:
 * launching a coin, buying/selling on its bonding curve, and mining-power/reward flows that
 * require the player's own wallet signature.
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

type IInstruction = Instruction;
import {
  deriveProtocolPda,
  deriveMintPda,
  deriveMineAddresses,
  derivePlayerPda,
  derivePositionPda,
  deriveAssociatedTokenAddress,
  buildLaunchTokenInstruction,
  buildBuyInstruction,
  buildSellInstruction,
  buildInitializePlayerInstruction,
  buildAssignPowerInstruction,
  buildClaimRewardsInstruction,
  decodeProtocolConfig,
  decodeMine,
  decodeLaunchMarket,
  decodePlayer,
  decodeMiningPosition,
  bondingCurveSpotPriceLamports,
  quoteBuy,
  quoteSell,
  type LaunchTokenArgs,
  type DecodedProtocolConfig,
  type DecodedMine,
  type DecodedLaunchMarket,
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

async function pollForConfirmation(signature: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value } = await rpc.getSignatureStatuses([signature as never]).send();
    const status = value[0];
    if (status?.err) throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return;
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  throw new Error("Timed out waiting for confirmation");
}

async function signSendConfirm(
  feePayer: TransactionSigner,
  instructions: IInstruction[],
): Promise<string> {
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
    await pollForConfirmation(signature, 60_000);
    return signature;
  }

  const signedTx = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(signedTx);
  const wireTransaction = getBase64EncodedWireTransaction(signedTx);
  await rpc.sendTransaction(wireTransaction, { encoding: "base64", preflightCommitment: "confirmed" }).send();
  await pollForConfirmation(signature);
  return signature;
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
  creator: TransactionSigner,
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

/** Buys `solIn` SOL worth of tokens on a mine's bonding curve. This is the real liquidity path. */
export async function buyOnChain(
  programAddress: Address,
  buyer: TransactionSigner,
  mint: Address,
  solIn: number,
  minTokensOutRaw: bigint = 0n,
): Promise<BuyResult> {
  const mineAddrs = await deriveMineAddresses(programAddress, mint);
  const buyerTokens = await deriveAssociatedTokenAddress(buyer.address, mint);
  const instruction = buildBuyInstruction({
    programAddress,
    buyer: buyer.address,
    buyerTokens,
    solIn: solToLamports(solIn),
    minTokensOut: minTokensOutRaw,
    ...mineAddrs,
  });
  const signature = await signSendConfirm(buyer, [instruction]);
  return { signature };
}

/** Sells `tokensInRaw` base units of a mine's token back into its bonding curve for SOL. */
export async function sellOnChain(
  programAddress: Address,
  seller: TransactionSigner,
  mint: Address,
  tokensInRaw: bigint,
  minSolOutLamports: bigint = 0n,
): Promise<BuyResult> {
  const mineAddrs = await deriveMineAddresses(programAddress, mint);
  const sellerTokens = await deriveAssociatedTokenAddress(seller.address, mint);
  const instruction = buildSellInstruction({
    programAddress,
    seller: seller.address,
    sellerTokens,
    tokensIn: tokensInRaw,
    minSolOut: minSolOutLamports,
    ...mineAddrs,
  });
  const signature = await signSendConfirm(seller, [instruction]);
  return { signature };
}

export async function fetchAccountExists(pda: Address): Promise<boolean> {
  const info = await rpc.getAccountInfo(pda, { commitment: "confirmed" }).send();
  return info.value !== null;
}

/** Idempotent: only sends initialize_player if the Player PDA doesn't already exist. */
export async function ensurePlayerInitialized(programAddress: Address, owner: TransactionSigner): Promise<void> {
  const playerPda = await derivePlayerPda(programAddress, owner.address);
  if (await fetchAccountExists(playerPda)) return;
  const instruction = buildInitializePlayerInstruction({ programAddress, owner: owner.address, player: playerPda });
  await signSendConfirm(owner, [instruction]);
}

/** Assigns the player's on-chain Mining Power to `mint`'s mine (no tokens are spent). */
export async function assignPowerOnChain(
  programAddress: Address,
  owner: TransactionSigner,
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
  owner: TransactionSigner,
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

export { address, deriveMineAddresses, deriveAssociatedTokenAddress, LAMPORTS_PER_SOL, rpc };
