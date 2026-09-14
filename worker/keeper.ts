/**
 * The keeper: the only backend authority the Solana program trusts, and only for two things —
 * pushing a player's off-chain, ORE-funded Crew Power on-chain (sync_crew_power) and paying out
 * a server-approved random Discovery from a token's own Discovery Reserve (claim_discovery). It
 * can never move the launch market, the treasury, or a player's claimable mining rewards — see
 * docs/CUSTODY.md.
 *
 * Runs inside the same Cloudflare Worker as everything else, triggered by INDEXING_QUEUE jobs
 * (see processQueueEvent in worker/index.ts) — no separate always-on process required. The
 * keeper's secret key lives only in the DIGGO_KEEPER_SECRET_KEY Cloudflare secret; it is never
 * read by, or reachable from, the browser.
 */
import {
  address,
  type Address,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  signTransactionMessageWithSigners,
  getSignatureFromTransaction,
  getBase64EncodedWireTransaction,
  pipe,
  type KeyPairSigner,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";
import {
  deriveProtocolPda,
  deriveMineAddresses,
  derivePlayerPda,
  derivePositionPda,
  deriveAssociatedTokenAddress,
  buildSyncCrewPowerInstruction,
  buildClaimDiscoveryInstruction,
} from "../shared/program";
import { getChainRpc } from "./chain";

export interface KeeperEnv {
  DIGGO_KEEPER_SECRET_KEY?: string;
  DIGGO_PROGRAM_ID: string;
  DIGGO_RPC_URL?: string;
}

async function getKeeperSigner(env: KeeperEnv): Promise<KeyPairSigner> {
  if (!env.DIGGO_KEEPER_SECRET_KEY) {
    throw new Error("DIGGO_KEEPER_SECRET_KEY is not configured — the keeper cannot sign anything");
  }
  const bytes = new Uint8Array(JSON.parse(env.DIGGO_KEEPER_SECRET_KEY));
  return createKeyPairSignerFromBytes(bytes);
}

async function accountExists(rpc: Rpc<SolanaRpcApi>, pda: Address): Promise<boolean> {
  const info = await rpc.getAccountInfo(pda, { commitment: "confirmed" }).send();
  return info.value !== null;
}

async function signSendConfirm(
  rpc: Rpc<SolanaRpcApi>,
  feePayer: KeyPairSigner,
  instructions: Parameters<typeof appendTransactionMessageInstructions>[0],
): Promise<string> {
  const { value: latestBlockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const signedTx = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(signedTx);
  const wireTransaction = getBase64EncodedWireTransaction(signedTx);
  await rpc.sendTransaction(wireTransaction, { encoding: "base64", preflightCommitment: "confirmed" }).send();

  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const status = value[0];
    if (status?.err) throw new Error(`Keeper transaction failed: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return signature;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Keeper transaction confirmation timed out");
}

/**
 * Pushes `newPower` on-chain for `owner`'s position on `mint`'s mine. Returns null (a no-op,
 * not an error) if the player hasn't called assign_power for this mine yet — sync_crew_power
 * requires an already-initialized MiningPosition account, and the game's off-chain ORE/Crew
 * loop must keep working even for players who never touch the chain directly.
 */
export async function keeperSyncCrewPower(
  env: KeeperEnv,
  owner: string,
  mint: string,
  newPower: bigint,
): Promise<string | null> {
  const rpc = getChainRpc(env);
  const programAddress = address(env.DIGGO_PROGRAM_ID);
  const ownerAddress = address(owner);
  const mintAddress = address(mint);
  const protocolPda = await deriveProtocolPda(programAddress);
  const { mine } = await deriveMineAddresses(programAddress, mintAddress);
  const positionPda = await derivePositionPda(programAddress, mine, ownerAddress);
  const playerPda = await derivePlayerPda(programAddress, ownerAddress);

  const [positionExists, playerExists] = await Promise.all([
    accountExists(rpc, positionPda),
    accountExists(rpc, playerPda),
  ]);
  if (!positionExists || !playerExists) return null;

  const keeper = await getKeeperSigner(env);
  const instruction = buildSyncCrewPowerInstruction({
    programAddress,
    keeper: keeper.address,
    protocol: protocolPda,
    owner: ownerAddress,
    player: playerPda,
    mine,
    mint: mintAddress,
    position: positionPda,
    newPower,
  });
  return signSendConfirm(rpc, keeper, [instruction]);
}

/** Pays `amountRaw` (base units) of `mint` from its Discovery Reserve to `recipient`'s own ATA. */
export async function keeperClaimDiscovery(
  env: KeeperEnv,
  recipient: string,
  mint: string,
  amountRaw: bigint,
): Promise<string> {
  const rpc = getChainRpc(env);
  const programAddress = address(env.DIGGO_PROGRAM_ID);
  const mintAddress = address(mint);
  const recipientAddress = address(recipient);
  const protocolPda = await deriveProtocolPda(programAddress);
  const { mine, discoveryVault } = await deriveMineAddresses(programAddress, mintAddress);
  const recipientTokens = await deriveAssociatedTokenAddress(recipientAddress, mintAddress);

  const keeper = await getKeeperSigner(env);
  const instruction = buildClaimDiscoveryInstruction({
    programAddress,
    keeper: keeper.address,
    protocol: protocolPda,
    mine,
    mint: mintAddress,
    discoveryVault,
    recipient: recipientAddress,
    recipientTokens,
    amount: amountRaw,
  });
  return signSendConfirm(rpc, keeper, [instruction]);
}
