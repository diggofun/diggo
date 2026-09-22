/**
 * The keeper: the only backend authority the Solana program trusts, and only for two things —
 * pushing a player's off-chain, ORE-funded Crew Power on-chain (sync_crew_power) and paying out
 * a server-approved random Discovery from a token's own Discovery Reserve (claim_discovery). It
 * can never move the launch market, the treasury, or a player's claimable mining rewards — see
 * docs/CUSTODY.md.
 *
 * Two on-chain hardening rules shape how it calls the program: Crew Power is bounded by
 * ProtocolConfig.max_crew_power and by a per-call increase bound, so a large Crew upgrade is
 * pushed as the largest step the program accepts; and every discovery payout must carry a unique
 * discovery_id, which seeds an on-chain receipt so a retry can never pay the same discovery twice.
 *
 * Runs inside the same Cloudflare Worker as everything else, triggered by INDEXING_QUEUE jobs
 * (see processQueueEvent in worker/indexing.ts) — no separate always-on process required. The
 * keeper's secret key lives only in the DIGGO_KEEPER_SECRET_KEY Cloudflare secret; it is never
 * read by, or reachable from, the browser.
 */
import {
  address,
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
  deriveDiscoveryReceiptPda,
  buildSyncCrewPowerInstruction,
  buildClaimDiscoveryInstruction,
  decodePlayer,
  decodeProtocolConfig,
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
 *
 * The program caps Crew Power at ProtocolConfig.max_crew_power and limits how far one call may
 * raise it, so a big Crew upgrade is pushed as the largest step the program will accept and the
 * remainder converges on the next sync, instead of failing on every retry.
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

  const [positionInfo, playerInfo, protocolInfo] = await Promise.all([
    rpc.getAccountInfo(positionPda, { commitment: "confirmed" }).send(),
    rpc.getAccountInfo(playerPda, { commitment: "confirmed" }).send(),
    rpc.getAccountInfo(protocolPda, { commitment: "confirmed" }).send(),
  ]);
  if (!positionInfo.value || !playerInfo.value || !protocolInfo.value) return null;

  const protocol = decodeProtocolConfig(base64ToBytes(protocolInfo.value.data[0]));
  const currentPower = decodePlayer(base64ToBytes(playerInfo.value.data[0])).power;
  const nextPower = nextPowerStep(currentPower, newPower, protocol);
  if (nextPower === currentPower) return null;

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
    newPower: nextPower,
  });
  const signature = await signSendConfirm(rpc, keeper, [instruction]);
  if (nextPower !== newPower) {
    console.log(
      JSON.stringify({
        event: "keeper.power_step_clamped",
        wallet: owner,
        mint,
        requested: newPower.toString(),
        pushed: nextPower.toString(),
        signature,
      }),
    );
  }
  return signature;
}

/**
 * Pays `amountRaw` (base units) of `mint` from its Discovery Reserve to `recipient`'s own ATA.
 *
 * `discoveryId` is the unique id of the off-chain discovery record — the D1 discoveries row id
 * is exactly the right thing to pass. It seeds an on-chain receipt PDA, so replaying an id fails
 * instead of paying the same discovery twice, which is why it is a required argument: an omitted
 * id would seed a fresh receipt on every retry and could pay twice.
 */
export async function keeperClaimDiscovery(
  env: KeeperEnv,
  recipient: string,
  mint: string,
  amountRaw: bigint,
  discoveryId: bigint | string,
): Promise<string> {
  const rpc = getChainRpc(env);
  const programAddress = address(env.DIGGO_PROGRAM_ID);
  const mintAddress = address(mint);
  const recipientAddress = address(recipient);
  const protocolPda = await deriveProtocolPda(programAddress);
  const { mine, discoveryVault } = await deriveMineAddresses(programAddress, mintAddress);
  const recipientTokens = await deriveAssociatedTokenAddress(recipientAddress, mintAddress);
  const id = resolveDiscoveryId(discoveryId);
  const receipt = await deriveDiscoveryReceiptPda(programAddress, mine, id);

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
    discoveryId: id,
    receipt,
    amount: amountRaw,
  });
  return signSendConfirm(rpc, keeper, [instruction]);
}

// --- bounded keeper power (mirrors validate_power_update in the program) ---------------

/**
 * True when this discovery already has an on-chain receipt, which is proof that it was paid.
 *
 * This is the authority the retry path consults instead of trusting an error string: after a
 * keeper call fails, the only safe question is "did the program really record a payout for this
 * discovery?". Guessing wrong in the "it was paid" direction would strand a player's reward, so an
 * unreadable answer counts as "not paid" and the caller reverts to ELIGIBLE and retries.
 */
export async function keeperDiscoveryReceiptExists(
  env: KeeperEnv,
  mint: string,
  discoveryId: bigint | string,
): Promise<boolean> {
  try {
    const rpc = getChainRpc(env);
    const programAddress = address(env.DIGGO_PROGRAM_ID);
    const { mine } = await deriveMineAddresses(programAddress, address(mint));
    const receipt = await deriveDiscoveryReceiptPda(programAddress, mine, resolveDiscoveryId(discoveryId));
    const info = await rpc.getAccountInfo(receipt, { commitment: "confirmed" }).send();
    return info.value !== null;
  } catch (error) {
    console.error(
      JSON.stringify({ event: "keeper.receipt_check_failed", mint, error: String(error) }),
    );
    return false;
  }
}

/** Fallbacks mirror DEFAULT_MAX_CREW_POWER / DEFAULT_MAX_POWER_INCREASE_BPS / MIN_POWER_STEP. */
const FALLBACK_MAX_CREW_POWER = 50_000n;
const FALLBACK_MAX_POWER_INCREASE_BPS = 10_000;
const MIN_POWER_STEP = 1_000n;

/**
 * The largest Crew Power the program will accept for this call: clamped to the configured
 * ceiling and to the configured per-call increase bound (plus the always-allowed step).
 * Decreases pass through untouched, matching the on-chain rule.
 */
export function nextPowerStep(
  current: bigint,
  target: bigint,
  bounds: { maxCrewPower: bigint; maxPowerIncreaseBps: number } | null,
): bigint {
  const ceiling = bounds?.maxCrewPower ?? FALLBACK_MAX_CREW_POWER;
  const increaseBps = bounds?.maxPowerIncreaseBps ?? FALLBACK_MAX_POWER_INCREASE_BPS;
  const clamped = target > ceiling ? ceiling : target;
  if (clamped <= current) return clamped;
  const allowed = current + (current * BigInt(increaseBps)) / 10_000n + MIN_POWER_STEP;
  return clamped < allowed ? clamped : allowed;
}

// --- discovery ids --------------------------------------------------------------------

/**
 * Maps a discovery record id to the u64 that seeds its on-chain receipt. Strings (D1 row ids)
 * are hashed deterministically, so retrying a claim reuses the same receipt and cannot double-pay.
 *
 * A missing id is a hard error rather than a random fallback: a random id would seed a fresh
 * receipt on every retry, which is exactly the double-pay this receipt exists to prevent.
 */
export function resolveDiscoveryId(discoveryId: bigint | string): bigint {
  if (typeof discoveryId === "bigint") return discoveryId & 0xffffffffffffffffn;
  if (typeof discoveryId === "string" && discoveryId.length > 0) return fnv1a64(discoveryId);
  throw new Error("keeperClaimDiscovery requires the discovery record id that seeds its receipt");
}

function fnv1a64(value: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash;
}

function base64ToBytes(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}
